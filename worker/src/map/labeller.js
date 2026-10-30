import { callJson, MODELS } from '../claude.js';
import { reserveSpend, spendCap } from '../db.js';
import { buildLeakIndex, leaks } from '../checks.js';
import { HttpError, json, readJson, londonDay, now as nowMs } from '../util.js';
import { looksLikeStem } from './guard.js';
import { MO } from '../users.js';

export const BATCH = 20, FORM_USD = 3, DAY_USD = 6, RESERVE_USD = 0.6, LABEL_MAX = 80, EXPL_MAX = 1500;
export const ROLE = 'labeller';
const SOURCE = 'labeller';
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const clean = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

const EXAMS_SQL = `SELECT e.id, e.name, e.question_count,
    (SELECT count(*) FROM exam_topics t WHERE t.user_id = ?1 AND t.exam_id = e.id AND t.status != 'failed') AS labelled,
    (SELECT count(*) FROM exam_topics t WHERE t.user_id = ?1 AND t.exam_id = e.id AND t.status = 'labelled') AS placed,
    (SELECT cursor FROM sync_state c WHERE c.user_id = ?1 AND c.source = ?2) AS cursor
  FROM exams e WHERE lower(e.name) LIKE '%nbme%' OR e.id IN (SELECT exam_id FROM sittings WHERE exam_type = 'nbme' AND exam_id IS NOT NULL)
  ORDER BY e.created_at, e.id`;

const parseCursor = c => { try { const o = JSON.parse(c || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };

/** The job's state: per exam its questions, how many are labelled, and the spend so far; today's spend. */
export async function labellerState(env, user = MO, { now = nowMs() } = {}) {
  let rows;
  try { rows = (await env.DB.prepare(EXAMS_SQL).bind(user, SOURCE).all()).results || []; } catch (e) { if (noTable(e)) return { ready: false, exams: [] }; throw e; }
  const cur = parseCursor(rows[0] && rows[0].cursor);
  const day = londonDay(now);
  return {
    ready: true, day_usd: cur.day === day ? Number(cur.day_usd) || 0 : 0, day_cap: DAY_USD, form_cap: FORM_USD,
    exams: rows.map(r => ({ id: r.id, name: r.name, questions: Number(r.question_count) || 0, labelled: Number(r.labelled) || 0, placed: Number(r.placed) || 0,
      usd: Math.round((Number((cur.forms || {})[r.id]) || 0) * 1000) / 1000 })),
  };
}

// The system prompt: what to return, the map's own topic names (so a label is one of them when one fits), the systems.
function systemPrompt(topicNames, systems) {
  return [
    'You label USMLE Step 2 CK practice questions with the one topic each question tests, for a student\'s weakness map.',
    'For each question return its q number, the topic and the system.',
    `topic: the single condition, drug, bug or skill the question is about, named as an AMBOSS US article names it (for example "Prolactinoma", "Intrapartum group B streptococcal prophylaxis"). Use one of the map's topic names below when one fits exactly; otherwise a short new name. At most ${LABEL_MAX} characters.`,
    'Never copy words from the question, its options or its explanation beyond the topic\'s own name: no ages, findings, numbers, lab values or sentences.',
    `system: one of: ${systems.join('; ')}.`,
    '',
    'The map\'s topic names:',
    topicNames.join('\n'),
  ].join('\n');
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['labels'],
  properties: { labels: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['q', 'topic', 'system'],
    properties: { q: { type: 'integer' }, topic: { type: 'string' }, system: { type: 'string' } } } } },
};

function questionText(q, i) {
  const opts = Array.isArray(q.opts) ? q.opts.map(o => `${o.l}. ${clean(o.t)}`).join('\n') : '';
  const expl = clean(q.expl).slice(0, EXPL_MAX);
  return [`Question q=${i}`, clean(q.stem), clean(q.lead), opts, q.answer ? `Answer: ${q.answer}` : '', expl ? `Explanation: ${expl}` : '']
    .filter(Boolean).join('\n');
}

/**
 * The checked label for one question: {topic_raw, system_raw, status}. Words that share a 6-word run with the
 * question, read like a stem, or run over LABEL_MAX are refused (the row keeps no words).
 */
export function checkLabel(question, label) {
  const topic = clean(label && label.topic), system = clean(label && label.system);
  if (!topic || topic.length > LABEL_MAX || system.length > LABEL_MAX) return { topic_raw: null, system_raw: null, status: 'refused' };
  const index = buildLeakIndex(question || {});
  for (const t of [topic, system]) if (t && (leaks(index, t) || looksLikeStem(t))) return { topic_raw: null, system_raw: null, status: 'refused' };
  return { topic_raw: topic, system_raw: system || null, status: 'labelled' };
}

/**
 * One labelling call. opts: {exam_id?: only this exam, now?, call?: a stand-in for callJson in the tests,
 * resolve?: a stand-in for resolveTopic, apply?: false to leave the answers for later}. Returns {skipped} or
 * {exam_id, labelled, refused, usd, applied}.
 */
export async function labelStep(env, user = MO, { exam_id = null, now = nowMs(), call = null, resolve = null, apply = true } = {}) {
  if (user !== MO) return { skipped: 'the hub exams are Mo\'s' };
  if (!call && !env.ANTHROPIC_API_KEY) return { skipped: 'no API key' };
  if (!Object.prototype.hasOwnProperty.call(MODELS, ROLE)) return { skipped: 'no labeller role' };
  const state = await labellerState(env, user, { now });
  if (!state.ready) return { skipped: 'not ready' };
  const day = londonDay(now);
  if (state.day_usd >= DAY_USD) return { skipped: 'daily labeller limit' };
  const exam = state.exams.find(x => (!exam_id || x.id === exam_id) && x.labelled < x.questions && x.usd < FORM_USD);
  if (!exam) return { skipped: 'nothing to label' };
  // The next BATCH unlabelled questions, read out of the exam's JSON by D1. A question Claude left out of its answer
  // ('failed') is asked once more; left out again, it is stored 'refused' (no words) so it is never asked a third time.
  const qs = (await env.DB.prepare(`SELECT CAST(j.key AS INTEGER) AS i, j.value AS q,
        (SELECT status FROM exam_topics WHERE user_id = ?1 AND exam_id = ?2 AND q_index = CAST(j.key AS INTEGER)) AS prev
      FROM exams e, json_each(e.questions_json) j
      WHERE e.id = ?2 AND CAST(j.key AS INTEGER) NOT IN (SELECT q_index FROM exam_topics WHERE user_id = ?1 AND exam_id = ?2 AND status != 'failed')
      ORDER BY CAST(j.key AS INTEGER) LIMIT ?3`).bind(user, exam.id, BATCH).all()).results || [];
  const retried = new Set(qs.filter(r => r.prev === 'failed').map(r => Number(r.i)));
  if (!qs.length) return { skipped: 'nothing to label' };
  const questions = new Map(qs.map(r => { let q = {}; try { q = JSON.parse(r.q) || {}; } catch { q = {}; } return [Number(r.i), q]; }));
  const [topics, cats] = await env.DB.batch([
    env.DB.prepare("SELECT name FROM topics WHERE user_id = ? AND status IN ('proposed', 'confirmed') ORDER BY name LIMIT 3000").bind(user),
    env.DB.prepare("SELECT name FROM categories WHERE user_id = ? AND status = 'active' ORDER BY sort, id").bind(user),
  ]);
  const system = systemPrompt((topics.results || []).map(r => r.name), (cats.results || []).map(r => r.name));
  const content = [...questions].map(([i, q]) => questionText(q, i)).join('\n\n---\n\n');
  let data, usd = 0;
  if (call) ({ data, usd = 0 } = await call({ role: ROLE, system, schema: SCHEMA, content }));
  else {
    let release;
    try { release = await reserveSpend(env, RESERVE_USD, await spendCap(env)); } catch (e) {
      if (e instanceof HttpError && e.status === 429) return { skipped: 'spend cap' };
      throw e;
    }
    try {
      ({ data, usd } = await callJson(env, { role: 'labeller', system, schema: SCHEMA, effort: 'high', maxTokens: 16000,
        messages: [{ role: 'user', content: `${questions.size} questions from ${exam.name}:\n\n${content}` }] }));
    } catch (e) {
      await release(0);
      const spent = Number(e && e.usd) || 0;
      if (spent) await env.DB.batch([spendStatement(env, user, state, exam.id, spent, day, now)]);
      throw e;
    }
    await release(0);   // the call added its real cost
  }
  const got = new Map(((data && data.labels) || []).filter(l => l && Number.isInteger(l.q)).map(l => [l.q, l]));
  const rows = [];
  for (const [i, q] of questions) {
    const l = got.get(i);
    rows.push({ q_index: i, ...(l ? checkLabel(q, l) : { topic_raw: null, system_raw: null, status: retried.has(i) ? 'refused' : 'failed' }) });
  }
  // Each label placed by taxonomy as code; a label that cannot be placed yet waits for ingestion's queue.
  const place = resolve || (async (texts, sys) => (await import('./resolve.js')).resolveTopic(env, user, { texts, system: sys, source: 'labeller' }));
  for (const r of rows) {
    if (r.status !== 'labelled') continue;
    try {
      const p = await place([r.topic_raw], r.system_raw);
      r.topic_id = p && p.topic_id && (p.confidence == null || p.confidence >= 0.85) ? p.topic_id : null;
    } catch (e) { if (!noTable(e)) console.error('labeller: resolve failed', e && e.message); r.topic_id = null; }
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO exam_topics (user_id, exam_id, q_index, topic_raw, system_raw, topic_id, status, model, labelled_at)
        SELECT ?1, ?2, json_extract(value, '$.q_index'), json_extract(value, '$.topic_raw'), json_extract(value, '$.system_raw'),
          json_extract(value, '$.topic_id'), json_extract(value, '$.status'), ?3, ?4 FROM json_each(?5) WHERE true
        ON CONFLICT (user_id, exam_id, q_index) DO UPDATE SET topic_raw = excluded.topic_raw, system_raw = excluded.system_raw,
          topic_id = excluded.topic_id, status = excluded.status, model = excluded.model, labelled_at = excluded.labelled_at`)
      .bind(user, exam.id, MODELS[ROLE], now, JSON.stringify(rows.map(r => ({ ...r, topic_id: r.topic_id ?? null })))),
    spendStatement(env, user, state, exam.id, usd, day, now),
  ]);
  let applied = null;
  if (apply) {
    try { applied = await (await import('./ingest/labels.js')).applyLabels(env, user, exam.id, rows.filter(r => r.status === 'labelled').map(r => r.q_index)); } catch (e) {
      if (!noTable(e)) console.error('labeller: applying labels failed', e && e.message);
    }
  }
  return { exam_id: exam.id, labelled: rows.filter(r => r.status === 'labelled').length, refused: rows.filter(r => r.status === 'refused').length,
    failed: rows.filter(r => r.status === 'failed').length, usd: Math.round(usd * 1e4) / 1e4, applied };
}

// The job's spend in sync_state (bookkeeping): per form and today's, in one row.
function spendStatement(env, user, state, examId, usd, day, now) {
  const forms = Object.fromEntries(state.exams.map(x => [x.id, x.usd]));
  forms[examId] = (Number(forms[examId]) || 0) + (Number(usd) || 0);
  const cursor = JSON.stringify({ forms, day, day_usd: (state.day_usd || 0) + (Number(usd) || 0) });
  return env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at`).bind(user, SOURCE, cursor, now);
}

/**
 * The labels into the map again, for answers that came after their labels: a hub sitting of a form sat after it was
 * labelled, a key added to a form saved without one (Library, Add answers), or a labelling call whose apply failed.
 * Idempotent: an answer already placed, or written since its label, is left alone (ingest/labels.js sweep).
 * Reads only; no API call. Returns {exams, analyses, answers}.
 */
export async function sweepLabels(env, user = MO) {
  if (user !== MO) return { exams: 0, analyses: 0, answers: 0 };
  const state = await labellerState(env, user);
  const out = { exams: 0, analyses: 0, answers: 0 };
  if (!state.ready) return out;
  const { applyLabels } = await import('./ingest/labels.js');
  for (const x of state.exams.filter(e => e.placed > 0)) {
    const qi = ((await env.DB.prepare("SELECT q_index FROM exam_topics WHERE user_id = ? AND exam_id = ? AND status = 'labelled' ORDER BY q_index")
      .bind(user, x.id).all()).results || []).map(r => Number(r.q_index));
    const r = await applyLabels(env, user, x.id, qi, { sweep: true });
    out.exams++;
    out.analyses += r.analyses || 0;
    out.answers += r.answers || 0;
  }
  return out;
}

export async function labellerJob(env, user) {
  if (user !== MO) return null;
  try {
    const r = await labelStep(env, user);
    if (!r || !r.skipped) return r;
    return { ...r, swept: await sweepLabels(env, user) };
  } catch (e) {
    if (noTable(e)) return { skipped: 'not ready' };
    return { error: String((e && e.message) || e).slice(0, 200) };
  }
}

// GET /api/map/labeller
export async function statusRoute(request, env, ctx, params, url, user) {
  return json(await labellerState(env, user));
}

export async function runRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 2_000).catch(() => ({}));
  const examId = body && typeof body.exam_id === 'string' ? body.exam_id.slice(0, 80) : null;
  return json(await labelStep(env, user, { exam_id: examId }));
}
