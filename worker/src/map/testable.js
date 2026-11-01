import { STEP_FACET, facetOfQuestion, cardPartFacets } from './facets.js';
import { topicObjectives } from './uworld-objectives.js';

export const POINTS = { per_part: 14, text: 220, cards: 12, misses: 30, objectives: 12 };
export const STATUS_ORDER = ['missed', 'shaky', 'untested', 'held'];
const STEPS = Object.keys(STEP_FACET);
const PART_RESULT = { correct: 'held', right: 'held', nudged: 'shaky', partial: 'shaky', wrong: 'missed' };
const RATING_RESULT = { again: 'missed', '1': 'missed', hard: 'shaky', '2': 'shaky', good: 'held', '3': 'held', easy: 'held', '4': 'held' };
const VIVA_RESULT = { said: 'held', wrong: 'missed', missing: 'missed' };
const STOP = new Set('a an the of in on to for and or is are be with by as at it its if then than that this what which when from into vs versus over under first'.split(' '));

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const clean = s => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();

export function answerSentences(answer) {
  const s = String(answer ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  return s.split(/\n+|(?<=[.!?])\s+(?=[A-Z*"“(])/).map(clean).filter(x => x && !/^versus\b/i.test(x));
}

/** The part of a line: its step's, else what its words ask, else null. */
export function partOf(step, text) {
  return STEP_FACET[String(step || '').toLowerCase()] || facetOfQuestion(text) || null;
}

const tokens = s => new Set(clean(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w.length > 1 && !STOP.has(w)));
/** Whether two points say the same thing: most of the shorter one's words are in the longer (token overlap). */
export function samePoint(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  const small = Math.min(x.size, y.size), union = x.size + y.size - both;
  return both / union >= 0.6 || (small >= 3 && both / small >= 0.85);
}

/**
 * The points from the gathered rows (pure). src: {objectives: [{qid, day, outcome, objective}], misses: [{label, day, at,
 * result, rule, step, analysis_gap, card_held (its card from the miss right the first time)}], cards: [{card_id, question, answer, review}], rubric: [{text, step}],
 * viva: {points: [{text, status}], at}}; safe(text) -> text | null (the leak guard). Returns {diagnose: [...], manage:
 * [...], n} with each point {text, part, step, status, sources: [{kind, label}]}.
 */
export function testablePoints(src = {}, { safe = t => t } = {}) {
  const raw = [];
  const add = (text, step, part, status, source, at = null) => {
    const t = safe(clean(text).slice(0, POINTS.text));
    if (!t) return;
    const p = part || partOf(step, t) || 'diagnose';
    raw.push({ text: t, part: p, step: STEPS.includes(step) ? step : null, status, sources: [source], at: Number(at) || null });
  };
  for (const o of src.objectives || []) if (o && o.objective) add(o.objective, null, null, o.outcome || 'missed', { kind: 'uw', label: `UW ${o.qid}` }, o.day ? Date.parse(`${o.day}T12:00:00Z`) : null);
  for (const m of src.misses || []) {
    const st = m.card_held ? 'held' : m.result === 'flawed' ? 'shaky' : 'missed';
    const kind = /^UW\b/.test(m.label || '') ? 'uw' : /^(NBME|UWSA|Free 120|CMS)/i.test(m.label || '') ? 'nbme' : 'miss';
    if (m.analysis_gap) add(m.analysis_gap, m.step, null, st, { kind, label: m.label }, m.at);
    if (m.rule) add(m.rule, m.step, null, st, { kind, label: m.label }, m.at);
  }
  for (const c of src.cards || []) {
    const sents = answerSentences(c.answer).slice(0, 2);
    if (!sents.length) continue;
    const qf = cardPartFacets(c.question, sents.length);
    const rv = c.review || null;
    const parts = rv && Array.isArray(parse(rv.detail_json, {}).parts) ? parse(rv.detail_json, {}).parts : null;
    sents.forEach((sent, i) => {
      const part = qf[i] || (i === 0 ? 'diagnose' : 'manage');
      const st = parts && parts[i] ? PART_RESULT[String(parts[i]).toLowerCase()] || null : rv ? RATING_RESULT[String(rv.rating ?? rv.amount ?? '').toLowerCase()] || null : null;
      add(sent, null, part, st || 'untested', { kind: 'card', label: 'card' }, rv && rv.at);
    });
  }
  const said = new Map(((src.viva && src.viva.points) || []).map(p => [clean(p.text).toLowerCase(), VIVA_RESULT[p.status] || null]));
  for (const p of src.rubric || []) {
    if (!p || !p.text) continue;
    add(p.text, p.step, null, said.get(clean(p.text).toLowerCase()) || 'untested', { kind: 'viva', label: 'viva' }, said.has(clean(p.text).toLowerCase()) ? src.viva.at : null);
  }
  // Merge near-duplicates within a part: the first wording stays (objectives, then the judge's lines, cards, the rubric),
  // the sources join, and the status is the newest dated one (else the worse).
  const out = { diagnose: [], manage: [] };
  for (const p of raw) {
    const list = out[p.part];
    const hit = list.find(q => samePoint(q.text, p.text));
    if (!hit) { list.push({ ...p }); continue; }
    for (const s of p.sources) if (!hit.sources.some(x => x.kind === s.kind && x.label === s.label)) hit.sources.push(s);
    const newer = p.at != null && (hit.at == null || p.at > hit.at);
    if (newer && p.status !== 'untested') { hit.status = p.status; hit.at = p.at; }
    else if (hit.at == null && p.at == null && STATUS_ORDER.indexOf(p.status) < STATUS_ORDER.indexOf(hit.status)) hit.status = p.status;
    else if (hit.status === 'untested' && p.status !== 'untested') { hit.status = p.status; hit.at = p.at; }
    if (!hit.step && p.step) hit.step = p.step;
  }
  for (const k of Object.keys(out)) {
    out[k] = out[k].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)).slice(0, POINTS.per_part)
      .map(({ at, ...p }) => p);
  }
  return { ...out, n: out.diagnose.length + out.manage.length };
}

// ---------------------------------------------------------------- reads

export function testableStatements(env, user, topicId, { rubric = true, cards = true } = {}) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const none = col => q(`SELECT NULL AS ${col} WHERE 0 AND ? = ?`, user, topicId);
  return [
    q(`SELECT m.id, m.label, m.day, m.at, m.result, m.rule, m.step, m.block_id, m.retests_json, a.gap AS analysis_gap
       FROM misses_live m LEFT JOIN analyses a ON a.block_id = m.block_id AND a.q_index = m.q_index
       WHERE m.user_id = ? AND m.topic_id = ? ORDER BY m.at DESC LIMIT ${POINTS.misses}`, user, topicId),
    !cards ? none('card_id') : q(`SELECT c.card_id, c.question, c.answer FROM card_topics ct JOIN card_cache c ON c.user_id = ct.user_id AND c.card_id = ct.card_id
       WHERE ct.user_id = ? AND ct.topic_id = ? AND ct.removed_at IS NULL AND c.deleted_at IS NULL AND c.answer IS NOT NULL
       ORDER BY ct.strong DESC, c.card_id DESC LIMIT ${POINTS.cards}`, user, topicId),
    q(`SELECT card_id, rating, amount, detail_json, at FROM evidence_live WHERE user_id = ? AND topic_id = ? AND kind = 'card_review'
       ORDER BY at DESC LIMIT 80`, user, topicId),
    rubric ? q(`SELECT points_json, status FROM viva_rubrics WHERE user_id = ? AND topic_id = ?`, user, topicId) : none('points_json'),
    rubric ? q(`SELECT result_json, said_at FROM viva_results WHERE user_id = ? AND topic_id = ? AND status = 'graded' ORDER BY graded_at DESC LIMIT 1`, user, topicId)
      : none('result_json'),
  ];
}

/** The gathered rows (from testableStatements' results and the objectives) as testablePoints' src (pure). */
export function testableSource([misses, cards, reviews, rubric, viva], objectives = []) {
  const latest = new Map();
  for (const r of reviews || []) if (!latest.has(Number(r.card_id))) latest.set(Number(r.card_id), r);
  const cardHeld = m => { const list = parse(m.retests_json, []) || []; const last = list.filter(r => r && r.result != null).pop(); return !!last && /^(got_it|right|pass)/.test(String(last.result)); };
  const rb = (rubric || [])[0];
  const vv = (viva || [])[0];
  const res = vv ? parse(vv.result_json, {}) || {} : null;
  return {
    objectives: (objectives || []).slice(0, POINTS.objectives),
    misses: (misses || []).map(m => ({ ...m, card_held: cardHeld(m) })),
    cards: (cards || []).map(c => ({ ...c, review: latest.get(Number(c.card_id)) || null })),
    rubric: rb && rb.status === 'ready' ? parse(rb.points_json, []) : [],
    viva: res ? { points: res.points || [], at: Number(vv.said_at) || null } : null,
  };
}

export const objectivesOf = (env, user, topicId) => topicObjectives(env, user, topicId, { limit: POINTS.objectives }).catch(() => []);
