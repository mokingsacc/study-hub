import { londonDay } from '../util.js';
import { applyChange } from './change.js';
import { noteJob, stampFailed } from '../job-log.js';
import { fnv1a } from './teach-priority.js';
import { AUDIT_SPECS, auditAndReask, checkItem, dropFake, reaskText, recordAudit, auditCounts } from '../ai-audit.js';
// The grade's core fields (answer-core.js), checked like the points.
const CORE_KEYS = ['cause', 'cause_quote', 'cause_inferred', 'cause_detail', 'step', 'confidence', 'confidence_words', 'confidence_inferred', 'heard'];
import { VIVA, RUBRIC_SYSTEM, RUBRIC_SCHEMA, GRADE_SYSTEM, GRADE_SCHEMA, RUBRIC_FORMAT, rubricMessage, gradeMessage, cleanRubric, scoreGrade, surpriseOf, readRubric, rubricCurrent, examPoints,
  isGroupKey, readVivaGroup, CLUSTER_RUBRIC_RULES, CLUSTER_RUBRIC_SCHEMA, PAIR_RUBRIC_RULES } from './viva.js';
import { questionSafe, stemSafe } from './guard.js';

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const cut = (s, n) => { if (s == null) return null; const t = String(s).replace(/\s+/g, ' ').trim(); return !t ? null : t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t; };

const SOURCES_CARDS = `SELECT c.card_id, c.question, c.answer FROM card_topics ct JOIN card_cache c ON c.user_id = ct.user_id AND c.card_id = ct.card_id
  WHERE ct.user_id = ? AND ct.topic_id = ? AND ct.removed_at IS NULL AND c.deleted_at IS NULL ORDER BY ct.strong DESC, c.card_id DESC LIMIT 8`;

const SOURCES_EXAMS = `SELECT m.label, m.result, m.rule, a.gap AS analysis_gap FROM misses_live m LEFT JOIN analyses a ON a.block_id = m.block_id AND a.q_index = m.q_index
  WHERE m.user_id = ? AND m.topic_id = ? ORDER BY m.at DESC LIMIT 12`;

export function examLines(rows) {
  const out = [], seen = new Set();
  const form = l => /^(NBME|UWSA|Free 120|CMS)/i.test(String(l || ''));
  for (const m of [...(rows || [])].sort((a, b) => Number(form(b.label)) - Number(form(a.label)))) {
    for (const t of [m.analysis_gap, m.rule]) {
      const text = typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '';
      if (!text || !questionSafe(text) || !stemSafe(text) || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      out.push({ label: String(m.label || '').split(/\s+/).slice(0, 2).join(' ') || 'exam', text, outcome: m.result === 'flawed' ? 'shaky' : 'missed' });
    }
  }
  return out.slice(0, 8);
}

export async function rubricSources(env, user, topicId, { io = {} } = {}) {
  if (isGroupKey(topicId)) return clusterSources(env, user, topicId, { io });
  const objectives = await (io.objectives || (async () => (await import('./uworld-objectives.js')).topicObjectives(env, user, topicId)))().catch(() => []);
  const cards = await env.DB.prepare(SOURCES_CARDS).bind(user, topicId).all().then(r => r.results || [], () => []);
  const exams = await env.DB.prepare(SOURCES_EXAMS).bind(user, topicId).all().then(r => examLines(r.results || []), () => []);
  const meh = await (io.mehlman || (async () => (await import('./mehlman.js')).mehlmanFor(env, user, topicId, { timeoutMs: 8000 })))().catch(() => null);
  const mehlman = meh && Array.isArray(meh.passages) ? meh.passages.filter(p => p && p.text).slice(0, 4) : [];
  // The foundation concepts under a clinical topic (concepts.js), for the understand heading.
  const found = await (io.concepts || (async () => (await import('./concepts.js')).foundationsFor(env, user, topicId)))().catch(() => null);
  const concepts = found && found.kind === 'clinical' ? (found.concepts || []).map(c => c.name).filter(Boolean).slice(0, 4) : [];
  const complete = !!(meh && meh.status && !['unreachable', 'pending', 'off'].includes(meh.status));
  const hash = `${RUBRIC_FORMAT}s${fnv1a(JSON.stringify([objectives.map(o => o.objective || o.qid), cards.map(c => c.card_id), mehlman.map(p => p.text), exams.map(e => e.text), concepts]))}`;
  return { objectives: objectives.slice(0, 8), exams, cards, mehlman, concepts, complete, hash };
}

export async function clusterSources(env, user, key, { io = {} } = {}) {
  const c = await readVivaGroup(env, user, key);
  if (!c) return { objectives: [], exams: [], cards: [], mehlman: [], concepts: [], complete: false, hash: `${RUBRIC_FORMAT}c0` };
  const ids = [...new Set([c.root.id, ...c.members.map(m => m.id)])].filter(Boolean).slice(0, 5);
  const per = await Promise.all(ids.map(id => rubricSources(env, user, id, { io }).catch(() => null)));
  const take = (k, n, each) => per.flatMap(x => (x && Array.isArray(x[k]) ? x[k].slice(0, each) : [])).slice(0, n);
  const concepts = [...new Set([...(c.root.kind === 'concept' && c.root.name ? [c.root.name] : []), ...take('concepts', 8, 4)])].slice(0, 4);
  const out = { objectives: take('objectives', 8, 3), exams: take('exams', 8, 3), cards: take('cards', 8, 2), mehlman: take('mehlman', 6, 2), concepts };
  out.complete = per.some(x => x && x.complete);
  out.hash = `${RUBRIC_FORMAT}${c.kind === 'pair' ? 'p' : 'c'}${fnv1a(JSON.stringify([c.members.map(m => m.id), per.map(x => (x ? x.hash : null))]))}`;
  return out;
}

async function callExaminer(env, { system, schema, content, maxTokens = 16000, use = null }) {
  const [{ callJson }, { reserveSpend, spendCap }] = await Promise.all([import('../claude.js'), import('../db.js')]);
  const release = await reserveSpend(env, VIVA.reserve_usd, await spendCap(env));
  let usd = 0;
  try {
    const r = await callJson(env, { role: 'examiner', use, system, schema, effort: 'high', maxTokens, messages: [{ role: 'user', content }] });
    usd = r.usd || 0;
    return { data: r.data, usd };
  } catch (e) { usd = Number(e && e.usd) || 0; throw e; } finally { await release(0); }   // claude.js adds the real cost itself
}

const capped = e => Number(e && e.status) === 429;
// Waiting for its Message Batch (claude.js): no try used, the minute job asks the same again.
const pending = e => !!(e && e.pending === true && e.batch === true);

async function topicOf(env, user, topicId) {
  // A cluster's or a pair's rubric and viva: the group as the "topic", its members and pairs for the rubric message.
  if (isGroupKey(topicId)) {
    const c = await readVivaGroup(env, user, topicId);
    return c ? { id: topicId, name: c.name, kind: c.kind === 'pair' ? 'pair' : 'cluster', category: null, cluster: c } : null;
  }
  return env.DB.prepare(`SELECT t.id, t.name, t.kind, c.name AS category FROM topics t LEFT JOIN categories c ON c.user_id = t.user_id AND c.id = t.category_id
    WHERE t.user_id = ? AND t.id = ?`).bind(user, topicId).first();
}

/**
 * Build (or rebuild) one topic's rubric: one call. Returns the rubric row's points, or throws. A failure is kept on
 * the row (attempts, error) and posted to Recent activity.
 */
export async function buildRubric(env, user, topicId, { now = Date.now(), call = callExaminer, io = {}, use = null } = {}) {
  const topic = await topicOf(env, user, topicId);
  if (!topic) throw new Error('That topic is not on the map.');
  const src = await rubricSources(env, user, topicId, { io });
  const cur = await readRubric(env, user, topicId);
  try {
    const cl = topic.cluster || null;
    const pair = !!(cl && cl.kind === 'pair');
    const r = await call(env, { role: 'examiner', use, system: cl ? [RUBRIC_SYSTEM, pair ? PAIR_RUBRIC_RULES : CLUSTER_RUBRIC_RULES] : RUBRIC_SYSTEM, schema: cl ? CLUSTER_RUBRIC_SCHEMA : RUBRIC_SCHEMA, content: rubricMessage(topic, src) });
    const points = cleanRubric(r.data, examPoints(src).map(x => x.id), cl ? cl.members : null, { both: pair });
    if (points.length < VIVA.points_min) throw new Error(`the rubric had ${points.length} usable points`);
    const version = (Number(cur && cur.version) || 0) + 1;
    await env.DB.prepare(`INSERT INTO viva_rubrics (user_id, topic_id, version, status, topic_kind, sources_hash, points_json, attempts, error, usd, requested_at, built_at, created_at, updated_at)
        VALUES (?1, ?2, ?3, 'ready', ?4, ?5, ?6, 0, NULL, ?7, ?8, ?8, ?8, ?8)
      ON CONFLICT (user_id, topic_id) DO UPDATE SET version = excluded.version, status = 'ready', topic_kind = excluded.topic_kind, sources_hash = excluded.sources_hash,
        points_json = excluded.points_json, attempts = 0, error = NULL, usd = viva_rubrics.usd + excluded.usd, built_at = excluded.built_at, updated_at = excluded.updated_at`)
      .bind(user, topicId, version, topic.kind || null, src.hash, JSON.stringify(points), Number(r.usd) || 0, now).run();
    await noteJob(env, { job: 'viva', user, key: `rubric:${topicId}:${version}`, ref: 'rubric', state: 'ok', at: now,
      counts: { kind: 'rubric', points: points.length, high: points.filter(p => p.yield === 'high').length, tested: points.filter(p => p.tested).length, version, rebuilt: version > 1 },
      detail: topic.name });
    return { points, version };
  } catch (e) {
    if (pending(e)) {
      await noteJob(env, { job: 'viva', user, key: `rubric:${topicId}:held`, ref: 'rubric', state: 'held', at: now, counts: { kind: 'rubric', batch: 1 }, detail: topic.name });
      throw e;
    }
    if (capped(e)) {
      await noteJob(env, { job: 'viva', user, key: `held:${londonDay(now)}`, ref: 'rubric', state: 'held', at: now, counts: { kind: 'rubric' } });
      throw e;
    }
    await env.DB.prepare(`INSERT INTO viva_rubrics (user_id, topic_id, status, attempts, error, requested_at, created_at, updated_at) VALUES (?1, ?2, 'pending', 1, ?3, ?4, ?4, ?4)
      ON CONFLICT (user_id, topic_id) DO UPDATE SET attempts = viva_rubrics.attempts + 1, error = ?3, updated_at = ?4,
        status = CASE WHEN viva_rubrics.status = 'ready' THEN 'ready' WHEN viva_rubrics.attempts + 1 >= ${VIVA.max_tries} THEN 'failed' ELSE 'pending' END`)
      .bind(user, topicId, cut(e && e.message, 200), now).run().catch(() => {});
    await noteJob(env, { job: 'viva', user, key: `rubric:${topicId}:failed`, ref: 'rubric', state: 'failed', at: now, counts: { kind: 'rubric' }, detail: `${topic.name}: ${(e && e.message) || e}` });
    throw e;
  }
}

/** Whether a ready rubric should be rebuilt: its sources changed (all of them answered) and it is over a day old. */
export const staleRubric = (rubric, src, now = Date.now()) => !!(rubric && rubric.status === 'ready' && src && src.complete && rubric.sources_hash && rubric.sources_hash !== src.hash
  && now - (Number(rubric.built_at) || 0) > VIVA.rebuild_after_ms);
// A rubric to mark against now: ready, with points, and (for a lesson viva, whose reply names the six headings) written
// for the six headings (rubricCurrent); an older one is rebuilt first.
const usable = (rubric, v) => !!(rubric && rubric.status === 'ready' && rubric.points.length && (!v || v.kind !== 'lesson' || rubricCurrent(rubric)));

/**
 * Grade one viva whose rubric is ready: one call, then the grade is stored, its evidence written through applyChange
 * (op viva.grade: undoable, the scores recomputed in the same batch), wrong beliefs opened as misconceptions and gaps
 * on other topics logged as stated gaps there. Returns the counts.
 */
export async function gradeViva(env, user, v, rubric, { now = Date.now(), call = callExaminer } = {}) {
  const topic = (await topicOf(env, user, v.topic_id)) || { id: v.topic_id, name: v.topic_name };
  const use = v.kind === 'audit' && v.surface !== 'panel' ? null : 'now';   // the panel's viva is waited on
  const content = gradeMessage(topic, rubric.points, v.transcript);
  const { nearNames, withNames, nameOthers } = await import('./name-map.js');
  // A cluster's or pair's viva names its members (the group's own name is on no map).
  const own = topic.cluster ? topic.cluster.members.map(m => m.name).filter(Boolean) : [topic.name];
  const system = withNames(GRADE_SYSTEM, await nearNames(env, user, own).catch(() => []));
  const r = await call(env, { role: 'examiner', use, system, schema: GRADE_SCHEMA, content });
  const graded = await auditGrade(rubric.points, r.data, v.transcript, async rows => {
    const again = await call(env, { role: 'examiner', use, system, schema: GRADE_SCHEMA, content: `${content}\n\n${reaskText(rows)}` });
    r.usd = (Number(r.usd) || 0) + (Number(again.usd) || 0);
    return again.data;
  });
  const check = await recordAudit(env, { job: 'viva', key: v.id, ref: v.kind, user, rows: graded.rows, reasked: graded.reasked, at: now });
  r.data = graded.data;
  const res = scoreGrade(rubric.points, r.data);
  if (res.others.length) res.others = await nameOthers(env, user, res.others, { own });
  // The closing viva of a lesson keeps no map prediction (it is no test of the map): no surprise.
  const sp = v.phase === 'after' ? { surprise: null, word: null } : surpriseOf(res.coverage, v.pred_p);
  await env.DB.prepare(`UPDATE viva_results SET rubric_version = ?3, coverage = ?4, grade = ?5, said_n = ?6, wrong_n = ?7, missing_n = ?8, result_json = ?9,
      surprise = ?10, surprise_word = ?11, usd = usd + ?12, updated_at = ?13 WHERE user_id = ?1 AND id = ?2`)
    .bind(user, v.id, rubric.version, res.coverage, res.grade, res.said_n, res.wrong_n, res.missing_n, JSON.stringify(res), sp.surprise, sp.word, Number(r.usd) || 0, now).run();
  await env.DB.prepare('UPDATE viva_results SET heard = ?3, form_version = ?4 WHERE user_id = ?1 AND id = ?2').bind(user, v.id, (res.core && res.core.heard) || null, res.form_version).run()
    .catch(stampFailed(env, 'viva_results', user));
  // The evidence (and the scores) in one undoable batch.
  const ch = await applyChange(env, user, { actor: 'code', surface: 'cron', op: 'viva.grade', args: { id: v.id }, via: 'cron:viva' });
  if (!ch.ok) throw new Error(`the grade could not be written: ${ch.reason || 'refused'}`);
  await env.DB.prepare(`UPDATE viva_results SET status = 'graded', graded_at = ?3, batch_id = ?4, error = NULL, updated_at = ?3 WHERE user_id = ?1 AND id = ?2`)
    .bind(user, v.id, now, ch.batch_id || null).run();
  let miscs = 0, gaps = 0;
  const { misconceptionSave } = await import('./teach-memory.js');
  for (const m of res.misconceptions) {
    const on = topic.cluster ? { name: topic.cluster.root.name || topic.name, id: topic.cluster.root.id } : topic;
    const out = await misconceptionSave(env, user, { topic: `${on.name} (map: ${on.id})`, belief: m.belief, ref: `viva ${londonDay(now)}`, source: v.kind === 'lesson' ? 'lesson' : 'chat',
      ...(m.concept ? { concept: m.concept, concept_discipline: m.concept_discipline, concept_quote: m.quote || null } : {}) },
      { actor: 'code', surface: 'cron', via: 'cron:viva' }).catch(e => { console.error('viva misconception failed', e && e.message); return null; });
    if (out && out.id) miscs++;
  }
  if (res.others.length) {
    const { addGap } = await import('../gaps.js');
    for (const [i, o] of res.others.entries()) {
      const id = await addGap(env, { source: 'viva', origin: 'stated', gap: o.gap, said: o.quote, topic: o.topic, step: o.step, ref: `viva:${v.id}` },
        { id: `viva:${v.id}:${i + 1}`, at: Number(v.said_at) || now, user }).catch(e => { console.error('viva gap failed', e && e.message); return null; });
      if (id) gaps++;
    }
  }
  await noteJob(env, { job: 'viva', user, key: `viva:${v.id}`, ref: v.kind, state: 'ok', at: now, detail: topic.name,
    counts: { kind: 'graded', said: res.said_n, wrong: res.wrong_n, missing: res.missing_n, of: res.of, misconceptions: miscs, gaps, surprise: sp.word || 'none',
      audit: v.kind === 'audit' && v.surface !== 'panel', panel: v.surface === 'panel', ...(v.phase ? { phase: v.phase } : {}),
      ...(res.plan && res.plan.length ? { plan: res.plan.length } : {}), ...auditCounts(check) } });
  return { id: v.id, said: res.said_n, wrong: res.wrong_n, missing: res.missing_n, misconceptions: miscs, gaps, surprise: sp.word, evidence: ch.evidence ?? null };
}

/**
 * Grade one viva now (the topic panel's microphone, under the upload's waitUntil, so the result shows within a minute
 * rather than after two cron turns): claims the row as the minute job does (so the two never both grade it), builds the
 * rubric first when there is none ready, then grades, both through the examiner role at high effort (callExaminer). A
 * failure leaves the row pending for the minute job to try again (or failed after VIVA.max_tries), posted to Recent
 * activity. Returns what happened.
 */
export async function gradeNow(env, user, id, { now = Date.now(), call = callExaminer, io = {} } = {}) {
  try {
    const v = await env.DB.prepare(`SELECT * FROM viva_results WHERE user_id = ? AND id = ?`).bind(user, id).first();
    if (!v || v.status !== 'pending') return { skipped: v ? v.status : 'missing' };
    const claim = await env.DB.prepare(`UPDATE viva_results SET attempts = attempts + 1, updated_at = ?3 WHERE user_id = ?1 AND id = ?2 AND updated_at = ?4 AND status = 'pending'`)
      .bind(user, id, now, v.updated_at).run();
    if (!(claim.meta && claim.meta.changes)) return { busy: id };
    try {
      let rubric = await readRubric(env, user, v.topic_id);
      if (!usable(rubric, v)) {
        await buildRubric(env, user, v.topic_id, { now, call, io, use: 'now' });
        rubric = await readRubric(env, user, v.topic_id);
      }
      return { graded: await gradeViva(env, user, v, rubric, { now, call }) };
    } catch (e) {
      if (capped(e)) {
        await env.DB.prepare('UPDATE viva_results SET attempts = max(0, attempts - 1) WHERE user_id = ?1 AND id = ?2').bind(user, id).run();
        await noteJob(env, { job: 'viva', user, key: `held:${londonDay(now)}`, ref: 'viva', state: 'held', at: now, counts: { kind: 'graded' } });
        return { held: id };
      }
      const last = Number(v.attempts) + 1 >= VIVA.max_tries;
      await env.DB.prepare(`UPDATE viva_results SET error = ?3, status = ?4, updated_at = ?5 WHERE user_id = ?1 AND id = ?2`)
        .bind(user, id, cut(e && e.message, 200), last ? 'failed' : 'pending', now).run();
      await noteJob(env, { job: 'viva', user, key: `viva:${id}`, ref: v.kind, state: 'failed', at: now, counts: { kind: 'graded', tries: Number(v.attempts) + 1, final: last },
        detail: `${v.topic_name || 'a topic'}: ${(e && e.message) || e}` });
      return { failed: id, error: (e && e.message) || String(e) };
    }
  } catch (e) {
    if (noTable(e)) return { skipped: 'no viva tables yet' };
    throw e;
  }
}

export async function auditGrade(points, data, transcript, reask) {
  const items = d => [
    ...points.map(p => ({ kind: 'point', ...((d && Array.isArray(d.points) ? d.points : []).find(x => x && x.id === p.id) || {}), id: p.id })),
    ...(d && Array.isArray(d.misconceptions) ? d.misconceptions : []).map((m, i) => ({ kind: 'belief', ...m, id: `belief ${i + 1}` })),
    ...(d && Array.isArray(d.other_topics) ? d.other_topics : []).map((o, i) => ({ kind: 'other', ...o, id: `other ${i + 1}` })),
    { kind: 'core', id: 'core', flagged: (d && Array.isArray(d.points) ? d.points : []).some(p => p && p.status === 'wrong'),
      ...Object.fromEntries(CORE_KEYS.map(k => [k, d ? d[k] : undefined])) },
  ];
  const check = x => checkItem(x, { id: x.id, ...AUDIT_SPECS.viva(x), source: String(transcript || '') });
  let fresh = null;
  const a = await auditAndReask(items(data), { idOf: x => x.id, check, reask: async rows => {
    fresh = await reask(rows);
    return items(fresh).filter(x => x.kind === 'point' || x.kind === 'core');
  } });
  const strip = ({ kind, ...x }) => x;
  const pts = a.items.filter(x => x.kind === 'point' && x.status).map(({ kind, id, status, quote }) => ({ id, status, quote: quote ?? null }));
  const rest = kind => a.items.filter(x => x.kind === kind).map(x => { const { id, ...y } = strip(x); return y; });
  const coreItem = a.items.find(x => x.kind === 'core') || {};
  return { data: { ...(data || {}), ...Object.fromEntries(CORE_KEYS.filter(k => coreItem[k] !== undefined).map(k => [k, coreItem[k]])), points: pts, misconceptions: rest('belief'), other_topics: rest('other') },
    rows: a.rows, reasked: a.reasked };
}

/**
 * The minute job (cron.js): expire unanswered audit picks, then ONE call: the oldest viva waiting (its rubric built
 * first when it has none, or its sources changed; the grade then waits for the next minute), else a requested rubric
 * built ahead. call and io are for the tests. Returns what it did.
 */
export async function vivaJob(env, user, { at = Date.now(), call = callExaminer, io = {} } = {}) {
  const now = Number(at) || Date.now();
  if (!env || !env.DB) return { skipped: 'no database' };
  try {
    await env.DB.prepare(`UPDATE viva_results SET status = 'expired', updated_at = ?2 WHERE user_id = ?1 AND status = 'awaiting' AND created_at < ?3`)
      .bind(user, now, now - VIVA.awaiting_ms).run();
    const v = await env.DB.prepare(`SELECT * FROM viva_results WHERE user_id = ?1 AND status = 'pending' AND (attempts = 0 OR updated_at < ?2)
      ORDER BY kind = 'audit', said_at LIMIT 1`).bind(user, now - VIVA.lease_ms).first();   // a viva he waits on before an audit pick that may wait for its batch
    if (v) {
      const claim = await env.DB.prepare(`UPDATE viva_results SET attempts = attempts + 1, updated_at = ?3 WHERE user_id = ?1 AND id = ?2 AND updated_at = ?4 AND status = 'pending'`)
        .bind(user, v.id, now, v.updated_at).run();
      if (!(claim.meta && claim.meta.changes)) return { busy: v.id };
      try {
        let rubric = await readRubric(env, user, v.topic_id);
        const fresh = usable(rubric, v);
        const src = fresh && now - (Number(rubric.built_at) || 0) > VIVA.rebuild_after_ms ? await rubricSources(env, user, v.topic_id, { io }) : null;
        if (!fresh || staleRubric(rubric, src, now)) {
          await buildRubric(env, user, v.topic_id, { now, call, io, use: v.kind === 'audit' && v.surface !== 'panel' ? null : 'now' });
          // The grade is the next minute's call; this attempt does not count against it.
          await env.DB.prepare('UPDATE viva_results SET attempts = attempts - 1, updated_at = ?3 WHERE user_id = ?1 AND id = ?2').bind(user, v.id, now - VIVA.lease_ms - 1).run();
          return { rubric: v.topic_id, viva: v.id };
        }
        return { graded: await gradeViva(env, user, v, rubric, { now, call }) };
      } catch (e) {
        if (pending(e)) {
          await env.DB.prepare('UPDATE viva_results SET attempts = max(0, attempts - 1), updated_at = ?3 WHERE user_id = ?1 AND id = ?2').bind(user, v.id, now - VIVA.lease_ms + 60_000).run();
          await noteJob(env, { job: 'viva', user, key: `viva:${v.id}:held`, ref: v.kind, state: 'held', at: now, counts: { kind: 'graded', batch: 1 }, detail: v.topic_name || null });
          return { waiting: v.id };
        }
        if (capped(e)) {
          await env.DB.prepare('UPDATE viva_results SET attempts = max(0, attempts - 1) WHERE user_id = ?1 AND id = ?2').bind(user, v.id).run();
          await noteJob(env, { job: 'viva', user, key: `held:${londonDay(now)}`, ref: 'viva', state: 'held', at: now, counts: { kind: 'graded' } });
          return { held: v.id };
        }
        const last = Number(v.attempts) + 1 >= VIVA.max_tries;
        await env.DB.prepare(`UPDATE viva_results SET error = ?3, status = ?4, updated_at = ?5 WHERE user_id = ?1 AND id = ?2`)
          .bind(user, v.id, cut(e && e.message, 200), last ? 'failed' : 'pending', now).run();
        await noteJob(env, { job: 'viva', user, key: `viva:${v.id}`, ref: v.kind, state: 'failed', at: now, counts: { kind: 'graded', tries: Number(v.attempts) + 1, final: last },
          detail: `${v.topic_name || 'a topic'}: ${(e && e.message) || e}` });
        return { failed: v.id, error: (e && e.message) || String(e) };
      }
    }
    // Nothing to grade: a rubric teach_next asked for, built ahead so the lesson's grade waits for one call only.
    // A ready rubric written before the six headings, asked for again by a lesson since it was built, is rebuilt ahead too
    // (it stays readable meanwhile), at most VIVA.max_tries times.
    const r = await env.DB.prepare(`SELECT topic_id, status, updated_at, requested_at FROM viva_rubrics WHERE user_id = ?1 AND (attempts = 0 OR updated_at < ?2)
        AND (status = 'pending' OR (status = 'ready' AND coalesce(sources_hash, '') NOT LIKE '${RUBRIC_FORMAT}%' AND coalesce(requested_at, 0) > coalesce(built_at, 0)
          AND attempts < ${VIVA.max_tries}))
      ORDER BY status = 'ready', requested_at LIMIT 1`).bind(user, now - VIVA.lease_ms).first();
    if (!r) return { idle: true };
    const claim = await env.DB.prepare('UPDATE viva_rubrics SET updated_at = ?3 WHERE user_id = ?1 AND topic_id = ?2 AND updated_at = ?4 AND status = ?5')
      .bind(user, r.topic_id, now, r.updated_at, r.status).run();
    if (!(claim.meta && claim.meta.changes)) return { busy: r.topic_id };
    const use = now - (Number(r.requested_at) || 0) < 30 * 60_000 ? 'now' : null;
    try { await buildRubric(env, user, r.topic_id, { now, call, io, use }); return { rubric: r.topic_id }; } catch (e) {
      if (pending(e)) {
        // Built ahead by batch: back in line a minute later, no try used.
        await env.DB.prepare('UPDATE viva_rubrics SET updated_at = ?3 WHERE user_id = ?1 AND topic_id = ?2').bind(user, r.topic_id, now - VIVA.lease_ms + 60_000).run();
        return { waiting: r.topic_id };
      }
      return capped(e) ? { held: r.topic_id } : { failed: r.topic_id, error: (e && e.message) || String(e) };
    }
  } catch (e) {
    if (noTable(e)) return { skipped: 'no viva tables yet' };
    throw e;
  }
}
