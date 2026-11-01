import { all } from './db.js';
import { londonDay } from './util.js';
import { MO } from './users.js';

export const OPTION_JUDGED = ['right', 'wrong', 'unsure', 'none'];
export const OPTION_STEPS = ['recognise', 'distinguish', 'test', 'treat', 'trap'];
export const OPTIONS_MAX = 40;
export const OPTION_KIND = 'review_option';

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const OPTION_RULES = `7. options: every answer choice he talks about, except the question's right answer (that one is the question's own): q; letter, the choice's letter when he says it, else an empty string; topic, the condition, drug, test or step the choice names, as an AMBOSS US article names it; said, his own words on it (copied, at most 40 words); fact, what he says he knows about it, his words shortened to one line (empty when he says nothing he knows); need, what he says he would need to see for this choice to be the right answer (the finding that would point to it over the right answer), his words shortened (empty when he does not say); fact_judged and need_judged: right when it is sound Step 2 CK knowledge and fits the question (its answer, labels and objective), wrong when it is false, unsure when you cannot tell (unsure counts for nothing, so use it whenever in doubt), none when he said nothing of that kind; belief: when either is wrong, the wrong belief in plain words, one line, else an empty string; step, what his words on it are about: recognise (what it is, its features), distinguish (what tells it from the right answer), test (how it is diagnosed), treat (how it is managed), trap (a wrong move it tempts). Talking about a choice, or saying what would make it right, is never a mix-up: only his own confusion words make one (a gap with mixed_with, or the cause confusion).`;

export const OPTION_SCHEMA = { type: 'array', items: { type: 'object', additionalProperties: false,
  required: ['q', 'letter', 'topic', 'said', 'fact', 'fact_judged', 'need', 'need_judged', 'belief', 'step'],
  properties: { q: { type: 'integer' }, letter: { type: 'string' }, topic: { type: 'string' }, said: { type: 'string' }, fact: { type: 'string' },
    fact_judged: { type: 'string', enum: OPTION_JUDGED }, need: { type: 'string' }, need_judged: { type: 'string', enum: OPTION_JUDGED },
    belief: { type: 'string' }, step: { type: 'string', enum: OPTION_STEPS } } } };

export function tidyOptions(list, qs, safe) {
  const out = [], seen = new Set();
  const judged = (v, has) => (!has ? 'none' : ['right', 'wrong', 'unsure'].includes(v) ? v : 'unsure');
  for (const o of Array.isArray(list) ? list : []) {
    const q = o && qs.get(o.q);
    const topic = q && safe(o.topic, 80);
    if (!topic) continue;
    const l = String(o.letter || '').trim().toUpperCase();
    const letter = /^[A-J]$/.test(l) ? l : null;
    if (letter && q.answer && letter === String(q.answer).trim().toUpperCase()) continue;
    if ([q.condition, q.topic].filter(Boolean).map(norm).includes(norm(topic))) continue;
    const key = `${o.q}|${norm(topic)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fact = safe(o.fact, 200), need = safe(o.need, 160);
    const fj = judged(o.fact_judged, !!fact), nj = judged(o.need_judged, !!need);
    out.push({ q: o.q, letter, topic, said: safe(o.said, 300), fact, fact_judged: fj, need, need_judged: nj,
      belief: fj === 'wrong' || nj === 'wrong' ? safe(o.belief, 200) : null, step: OPTION_STEPS.includes(o.step) ? o.step : null });
    if (out.length >= OPTIONS_MAX) break;
  }
  return out;
}

export const optionBeliefs = options => options.filter(o => o.belief).map(o => ({ q: o.q, topic: o.topic, belief: o.belief, quote: o.said, option: true }));

export function versusFor(versusLine, optionName, questionName, need) {
  const f = String(need || '').trim().replace(/[.\s]+$/, '');
  if (!f || !optionName || !questionName) return null;
  const v = versusLine(questionName, /, so /.test(f) ? f : `${f}, so think ${optionName}`);
  return v.error ? null : v.line;
}

export function optionPlan(blockId, options, { places, qTopic, names, atOf, versusLine }) {
  const rows = [], versus = [], factTopics = new Set(), distinguished = new Set();
  let known = 0, unplaced = 0;
  const row = (key, topic, q, at, detail) => ({ obs_key: key, slot: 0, topic_id: topic, kind: OPTION_KIND, at, day: londonDay(at), source: 'uworld',
    source_ref: `uwrev:${blockId}:q${q}`, result: 'right', detail_json: JSON.stringify({ label: 'UWorld review', ...detail, q }), created_by: 'code' });
  for (const o of options) {
    if (o.fact_judged === 'right') known++;
    const counts = o.fact_judged === 'right' || o.need_judged === 'right';
    if (!counts) continue;
    const topic = places.get(o.topic) || null, qt = qTopic.get(o.q) || null;
    if (!topic || topic === qt) { unplaced++; continue; }
    const at = atOf(o.q);
    // One fact row a topic a review: several choices on one topic never add up to more than a small signal.
    if (o.fact_judged === 'right' && !factTopics.has(topic)) {
      factTopics.add(topic);
      rows.push(row(`uwrev:${blockId}:O:${topic}`, topic, o.q, at, { part: 'fact', step: o.step }));
    }
    if (o.need_judged !== 'right' || !qt) continue;
    const line = versusFor(versusLine, names.get(topic), names.get(qt), o.need);
    if (line) versus.push({ q: o.q, from: topic, to: qt, a_vs_b: line, quote: o.said });
    if (!distinguished.has(o.q)) {
      distinguished.add(o.q);
      rows.push(row(`uwrev:${blockId}:D${o.q}`, qt, o.q, at, { part: 'distinguish', step: 'distinguish', vs: topic }));
    }
  }
  return { rows, versus, known, unplaced };
}

/** The question's topic on the map per question: its answer row's topic (slot 0), as the block's ingest placed it. */
export async function questionTopics(env, blockId) {
  const rows = await all(env, `SELECT source_ref, topic_id FROM evidence WHERE user_id = ? AND kind = 'question' AND slot = 0 AND topic_id IS NOT NULL
    AND source_ref >= ? AND source_ref < ?`, MO, `uworld:${blockId}:q`, `uworld:${blockId}:r`).catch(() => []);
  return new Map(rows.map(r => [Number(/:q(\d+)$/.exec(r.source_ref)?.[1]), r.topic_id]).filter(([q]) => Number.isInteger(q)));
}

/** The review's choice rows written: the new ones upserted, the earlier analysis's others removed, one batch. */
export async function saveOptionRows(env, blockId, rows) {
  const before = await all(env, `SELECT obs_key FROM evidence WHERE user_id = ? AND kind = ? AND obs_key >= ? AND obs_key < ?`,
    MO, OPTION_KIND, `uwrev:${blockId}:`, `uwrev:${blockId};`).catch(() => []);
  const keep = new Set(rows.map(r => r.obs_key));
  const remove = before.filter(r => !keep.has(r.obs_key)).map(r => ({ obs_key: r.obs_key, slot: 0 }));
  if (!rows.length && !remove.length) return { written: 0, removed: 0 };
  const { commit } = await import('./map/ingest/hub.js');
  await commit(env, MO, { via: 'hook:uworld review', evidence: { upsert: rows, remove } });
  return { written: rows.length, removed: remove.length };
}
