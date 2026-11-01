import { HttpError, json, readJson, now, londonDay } from './util.js';
import { all, first, run, reserveSpend, spendCap } from './db.js';
import { callJson, isPending } from './claude.js';
import { AUDIT_SPECS, checkItem, dropFake, reaskText, recordAudit, auditCounts } from './ai-audit.js';
import { timeline, splitByStarts } from '../../public/js/uworld/split.js';
import { buildLeakIndex, leaks } from './checks.js';
import { cleanSegments, mergeQuestions, startMs } from './uworld.js';
import { withMarks, MAX_ATTEMPTS as JUDGE_ATTEMPTS, judgeMode, CHAT_WAIT_MS } from './uworld-review.js';
import { objectivesFor } from './library/objectives.js';
import { gapStatement, hasMapCols, hasSignalCols, mapGaps, scrubStems } from './gaps.js';
import { misconceptionSave } from './map/teach-memory.js';
import { looksLikeQuestionText } from './map/guard.js';
import { noteJob, detailOf, stampFailed } from './job-log.js';
import { MO } from './users.js';
import { CAUSE_RULES, tidyCause } from '../../public/js/shared/cause.js';
import { CONCEPT_RULES, tidyConcept } from '../../public/js/shared/concept.js';
import { coreRules, coreSchema, tidyCore, heardOf, consideredNotConfused, FORM_VERSIONS, HEARD } from './answer-core.js';
import { nearNames, withNames, namesToMap } from './map/name-map.js';
import { hasFormCols } from './gaps.js';
import { noteConcepts } from './map/concepts.js';
import { OPTION_RULES, OPTION_SCHEMA, tidyOptions, optionBeliefs, optionPlan, questionTopics, saveOptionRows } from './uworld-review-options.js';

export const TALK_STATUSES = ['pending', 'waiting', 'running', 'done', 'failed', 'capped', 'chat'];
export const TALK_ATTEMPTS = 3;
const RESERVE_USD = 2, STALE_MS = 15 * 60_000, CAPPED_WAIT_MS = 60 * 60_000, RETRY_MS = 5 * 60_000;
/** The review waits for the block judge (so the miss and its block-time cause exist first), at most this long. */
export const WAIT_JUDGE_MS = 2 * 3600_000;
export const MAX = { gaps: 20, links: 12, misconceptions: 10, said: 300 };
export const TALK_RULES = FORM_VERSIONS.review_talk;
const LINK_TYPES = ['treated_by', 'causes', 'adverse_effect'];
// A link is made only between names that place this surely (links-ingest ACCEPT: exact aliases, never the typo fuzz).
const LINK_ACCEPT = 0.9;

const parse = (t, d) => { try { return t ? JSON.parse(t) : d; } catch { return d; } };
const cut = (v, n) => { const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; return s ? (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s) : null; };
const mss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const resulted = qs => qs.filter(q => q && Number.isInteger(q.q) && ['right', 'wrong', 'omitted'].includes(q.result));
const isMiss = q => q && (q.result === 'wrong' || q.result === 'omitted' || q.verdict === 'right_flawed');
const wordCount = segs => segs.reduce((n, s) => n + (String(s.text || '').trim() ? String(s.text).trim().split(/\s+/).length : 0), 0);

// ---------------------------------------------------------------- the call
export const TALK_SYSTEM = `Mo (a learner preparing for USMLE Step 2 CK) recorded himself thinking aloud through a timed UWorld block, then, with the answers and explanations in front of him, recorded his REVIEW of it: going through the questions and their answer choices, saying what he knows about each choice and what he would need to see for it to be right, why options were wrong, what confused him, links between conditions, things he did not know, what he would do differently. You get his review words (transcribed by Whisper, so expect misheard medical words) with times from the start of the review recording, and one row per question of the block: its number, UWorld ID, result, his pick and the answer, the labels, UWorld's educational objective when known, and what an earlier judge made of his words DURING the block (the cause it named and his words then). You never see the questions.

1. Line up his review with the questions. He usually names them ("question 5", "number twelve", "the next one", "this one with the rash"); otherwise go by content against the labels and objectives. Questions he does not talk about are left out.
2. For each question he talks about give: q; start, the time of his first review words on it ("3:05"); said, a few of his own review words on it (copied, at most 40 words) that carry what he took from it.
3. For a question he got wrong, or got right but shakily, name the cause of the miss as his REVIEW words show it, by the cause rules below. His review words are usually clearer than his words during the block: set clearer true when they name the cause more plainly than the block-time words given; false when they add nothing. Give mixed_with (the condition, drug or step he says he took it for, named as AMBOSS names it) only for cause confusion; otherwise an empty string. For a question he got right and was sure on, cause is null. When his review words show the miss rests on misunderstanding an underlying principle, also give concept, concept_discipline and concept_quote by the concept rules below; otherwise empty strings.
4. gaps: things he says he did not know, or mixes up, about OTHER topics than the question's own (the question's own gap is its cause, never a gap). topic: the topic by the naming rule below (as an AMBOSS US article names it), singular, no "vs". gap: one plain line in your words. said: his words (at most 25, copied). mixed_with: the other topic, only when his words say he mixed the two up or cannot tell them apart; else an empty string. q: the question he was on, or null.
5. misconceptions: a wrong belief he admits he held ("I thought ACE inhibitors were fine in pregnancy"), one line each, in plain words; quote: his words. Only a real false belief, not a missing fact. topic as AMBOSS names it; q or null.
6. links: a link he makes between two conditions or a condition and a treatment ("X is treated with Y", "Y causes X", "drug Y can cause X"), as type treated_by (from the condition to the drug or procedure), causes (from the cause to what it causes) or adverse_effect (from the drug to the effect); quote: his words. Only links he states, never ones you add; a look-alike is never a link here (that is a gap with mixed_with).
7. For each question he talks about, also the core fields by the core rules below: step (for a miss), his confidence and its words as his review shows it, and heard; its other conditions are the gaps and misconceptions above, never on the question. heard (top level): how clearly the whole review recording came through.
${OPTION_RULES}
Write in your own words. Never copy text from UWorld (you have none) or the objective, and quote only Mo's own words. Leave a list empty when he says nothing for it.

${CAUSE_RULES}

${CONCEPT_RULES}

${coreRules({ skip: ['other_conditions'] })}`;

const nul = schema => ({ anyOf: [schema, { type: 'null' }] });
// The answer forms' shared core on each question (answer-core.js); its other conditions are the gaps and misconceptions lists.
const TALK_CORE = coreSchema({ skip: ['other_conditions'] });
export const TALK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['questions', 'gaps', 'misconceptions', 'links', 'options', 'heard'],
  properties: {
    questions: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['q', 'start', 'said', ...TALK_CORE.fields, 'clearer', 'mixed_with'],
      properties: { q: { type: 'integer' }, start: nul({ type: 'string' }), said: { type: 'string' }, ...TALK_CORE.props, clearer: { type: 'boolean' }, mixed_with: { type: 'string' } } } },
    gaps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['q', 'start', 'topic', 'gap', 'said', 'mixed_with'],
      properties: { q: nul({ type: 'integer' }), start: nul({ type: 'string' }), topic: { type: 'string' }, gap: { type: 'string' }, said: { type: 'string' }, mixed_with: { type: 'string' } } } },
    misconceptions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['q', 'topic', 'belief', 'quote'],
      properties: { q: nul({ type: 'integer' }), topic: { type: 'string' }, belief: { type: 'string' }, quote: { type: 'string' } } } },
    links: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['q', 'from', 'to', 'type', 'quote'],
      properties: { q: nul({ type: 'integer' }), from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string', enum: LINK_TYPES }, quote: { type: 'string' } } } },
    options: OPTION_SCHEMA,
    heard: { type: 'string', enum: [...HEARD] },
  },
};

export function talkMessage(block, questions, judged, objectives, segments, minutes) {
  const rows = questions.map(q => {
    const j = judged.get(q.q) || {};
    const teach = parse(j.teach_json, null) || {};
    const bits = [q.uworld_id && `UW ${q.uworld_id}`, q.result, q.picked && `picked ${q.picked}`, q.answer && `answer ${q.answer}`,
      [q.subject, q.system, q.topic].filter(Boolean).join(' / ') || null, (q.condition || teach.condition) && `condition: ${q.condition || teach.condition}`];
    const then = [q.verdict && `judged ${q.verdict}${q.error_type ? `, ${q.error_type}` : ''}`,
      q.cause && `cause ${q.cause}${Number(q.cause_inferred) === 0 ? ' (he said so)' : ' (inferred)'}${q.cause_detail ? `: ${q.cause_detail}` : ''}`,
      (q.cause_quote || j.quote) && `his words then: "${q.cause_quote || j.quote}"`].filter(Boolean);
    const obj = q.uworld_id && objectives[q.uworld_id] ? `\n  Tested: ${objectives[q.uworld_id].text}` : '';
    return `Q${q.q}: ${bits.filter(Boolean).join(' · ')}${then.length ? `\n  During the block: ${then.join(' · ')}` : ''}${obj}`;
  });
  const words = timeline(segments, []);
  return [`UWorld block of ${block.day} (${block.mode}), ${questions.length} question${questions.length === 1 ? '' : 's'}. His review recording${minutes ? `, ${minutes} min` : ''}, made after the block with the answers in front of him.`,
    '', 'Questions:', ...rows, '', 'His review words:', ...(words.length ? words : ['(nothing was heard)'])].join('\n');
}

export function tidyTalk(data, questions, leakIndex = new Set()) {
  const qs = new Map(questions.map(q => [q.q, q]));
  const safe = (v, n) => { const s = cut(v, n); return s && !looksLikeQuestionText(s) && !leaks(leakIndex, s) ? s : null; };
  const qOf = v => (Number.isInteger(v) && qs.has(v) ? v : null);
  const seen = new Set();
  const out = { questions: [], gaps: [], misconceptions: [], links: [], options: [], heard: heardOf(data && data.heard), form_version: FORM_VERSIONS.review_talk };
  const pickedTopic = q => { const r = qs.get(q); const o = r && r.picked ? (Array.isArray(data && data.options) ? data.options : []).find(o => o && o.q === q && String(o.letter || '').toUpperCase() === String(r.picked).toUpperCase()) : null; return o ? o.topic : null; };
  for (let x of Array.isArray(data && data.questions) ? data.questions : []) {
    if (!x || !qs.has(x.q) || seen.has(x.q)) continue;
    seen.add(x.q);
    const chk = isMiss(qs.get(x.q)) ? consideredNotConfused(x, { words: x.said || '', mixed: [x.mixed_with], picked: pickedTopic(x.q) }) : { item: x, changed: false };
    x = chk.item;
    const c = isMiss(qs.get(x.q)) ? tidyCause(x) : tidyCause(null);
    if (c.cause_quote && (looksLikeQuestionText(c.cause_quote) || leaks(leakIndex, c.cause_quote))) c.cause_quote = null;
    if (c.cause_detail && leaks(leakIndex, c.cause_detail)) c.cause_detail = null;
    const k = isMiss(qs.get(x.q)) ? tidyConcept(x, c.cause) : tidyConcept(null);
    if (k.concept && leaks(leakIndex, k.concept)) Object.assign(k, tidyConcept(null));
    if (k.concept_quote && (looksLikeQuestionText(k.concept_quote) || leaks(leakIndex, k.concept_quote))) k.concept_quote = null;
    const core = tidyCore(x, { flagged: isMiss(qs.get(x.q)), safe: v => safe(v, 200) });
    out.questions.push({ q: x.q, start_ms: startMs(x.start), said: safe(x.said, MAX.said), ...c, ...(k.concept ? k : {}), clearer: x.clearer === true,
      mixed_with: c.cause === 'confusion' ? safe(x.mixed_with, 80) : null, ...(chk.changed ? { cause_considered: chk.why } : {}),
      step: core.step, confidence: core.confidence, confidence_words: core.confidence_words, confidence_inferred: core.confidence_inferred, heard: core.heard || out.heard });
  }
  out.questions.sort((a, b) => a.q - b.q);
  const own = q => { const r = qs.get(q); return r ? [r.condition, r.topic].filter(Boolean).map(norm) : []; };
  for (const g of Array.isArray(data && data.gaps) ? data.gaps : []) {
    const topic = safe(g && g.topic, 80), gap = safe(g && g.gap, 200);
    if (!topic || !gap) continue;
    const q = qOf(g.q);
    if (q != null && own(q).includes(norm(topic))) continue;
    const mixed = safe(g.mixed_with, 80);
    out.gaps.push({ q, start_ms: startMs(g.start), topic, gap, said: safe(g.said, 200), mixed_with: mixed && norm(mixed) !== norm(topic) ? mixed : null });
    if (out.gaps.length >= MAX.gaps) break;
  }
  for (const m of Array.isArray(data && data.misconceptions) ? data.misconceptions : []) {
    const belief = safe(m && m.belief, 200);
    if (!belief) continue;
    out.misconceptions.push({ q: qOf(m.q), topic: safe(m.topic, 80), belief, quote: safe(m.quote, 200) });
    if (out.misconceptions.length >= MAX.misconceptions) break;
  }
  for (const l of Array.isArray(data && data.links) ? data.links : []) {
    const from = safe(l && l.from, 80), to = safe(l && l.to, 80);
    if (!from || !to || norm(from) === norm(to) || !LINK_TYPES.includes(l.type)) continue;
    out.links.push({ q: qOf(l.q), from, to, type: l.type, quote: safe(l.quote, 200) });
    if (out.links.length >= MAX.links) break;
  }
  out.options = tidyOptions(data && data.options, qs, safe);
  out.misconceptions.push(...optionBeliefs(out.options));
  return out;
}

export async function nameTalk(env, out, questions) {
  const qs = new Map((questions || []).map(q => [q.q, q]));
  const items = [
    ...out.gaps.map(g => ({ name: g.topic, quote: g.said })), ...out.gaps.map(g => ({ name: g.mixed_with, quote: g.said })),
    ...out.misconceptions.map(m => ({ name: m.topic, quote: m.quote })), ...out.questions.map(x => ({ name: x.mixed_with, quote: x.said })),
  ];
  if (!items.some(i => i.name)) return out;
  const named = await namesToMap(env, MO, items);
  let i = 0;
  const next = v => { const n = named[i++]; return v && n && n.name ? n.name : v; };
  const gapTopics = out.gaps.map(g => next(g.topic)), gapMixed = out.gaps.map(g => next(g.mixed_with));
  const own = q => { const r = qs.get(q); return r ? [r.condition, r.topic].filter(Boolean).map(norm) : []; };
  const gaps = out.gaps.map((g, k) => ({ ...g, topic: gapTopics[k], mixed_with: gapMixed[k] && norm(gapMixed[k]) !== norm(gapTopics[k]) ? gapMixed[k] : null }))
    .filter(g => !(g.q != null && own(g.q).includes(norm(g.topic))));
  const misconceptions = out.misconceptions.map(m => ({ ...m, topic: next(m.topic) }));
  const qsOut = out.questions.map(x => ({ ...x, mixed_with: next(x.mixed_with) }));
  return { ...out, gaps, misconceptions, questions: qsOut };
}

export function overrides(blockQ, rv) {
  if (!rv || !rv.cause) return false;
  if (!blockQ || !blockQ.cause) return true;
  const blockSaid = Number(blockQ.cause_inferred) === 0, reviewSaid = Number(rv.cause_inferred) === 0;
  if (rv.cause === blockQ.cause && (rv.cause_quote || '') === (blockQ.cause_quote || '') && (rv.cause_detail || '') === (blockQ.cause_detail || '')) return false;
  if (!blockSaid) return reviewSaid || rv.clearer === true;
  return reviewSaid && rv.clearer === true;
}

// ---------------------------------------------------------------- applying it to the map
const gapLo = blockId => `uwrev:${blockId}:`, gapHi = blockId => `uwrev:${blockId};`;   // ';' sorts right after ':'
// Where a review gap was said: "UW review 2026-10-31 Q5 @3:05" (ends in a time, so map-fields parseRef reads no
// question or sitting into it: a gap on another topic must not join the question's own answer).
const gapRef = (day, q, ms) => `UW review ${day}${q != null ? ` Q${q}` : ''}${ms != null ? ` @${mss(ms)}` : ''}`.slice(0, 80);

const atOfMs = (talk, ms, t) => { const t0 = Number(talk.t0); return Number.isSafeInteger(t0) && t0 > 0 && t0 <= t && ms != null ? Math.min(t, t0 + ms) : t; };

async function saveTalkGaps(env, block, talk, gaps, t, heard = null) {
  const [map, signals, forms] = await Promise.all([hasMapCols(env), hasSignalCols(env), hasFormCols(env)]);
  const lo = gapLo(block.id), hi = gapHi(block.id);
  const before = map ? (await all(env, 'SELECT id FROM gaps WHERE id >= ? AND id < ?', lo, hi)).map(r => r.id) : [];
  const atOf = ms => atOfMs(talk, ms, t);
  const made = gaps.map((g, i) => gapStatement(env, { source: 'spoken_cue', gap: g.mixed_with ? `Mixed up ${g.topic} and ${g.mixed_with}: ${g.gap}`.slice(0, 200) : g.gap,
    said: g.said, topic: g.topic, ref: gapRef(block.day, g.q, g.start_ms), card_id: null, note_id: null, error_type: null, verdict: 'shaky',
    mixed_with: g.mixed_with || null, confidence: null, ...(forms ? { heard, form_version: FORM_VERSIONS.review_talk } : {}) }, { id: `${lo}${i}`, at: atOf(g.start_ms), map, signals, forms }));
  await env.DB.batch([env.DB.prepare('DELETE FROM gaps WHERE id >= ? AND id < ?').bind(lo, hi), ...made.map(m => m.statement)]);
  const stale = before.filter(id => !made.some(m => m.row.id === id));
  if (map && stale.length) await forgetGaps(env, stale);
  if (map && made.length) await mapGaps(env, made.map(m => m.row));
  return made.map(m => m.row.id);
}
// Gaps a re-sent review no longer has: their observations go too (as gaps.js does for a re-saved recording's cues).
async function forgetGaps(env, ids) {
  const { commit } = await import('./map/ingest/hub.js');
  const rows = await all(env, `SELECT DISTINCT obs_key, topic_id FROM evidence WHERE user_id = ? AND gap_id IN (SELECT value FROM json_each(?))`, MO, JSON.stringify(ids));
  if (!rows.length) return null;
  return commit(env, MO, { via: 'hook:uworld review', evidence: { remove: rows.map(r => r.obs_key) }, recompute: rows.map(r => r.topic_id).filter(Boolean) });
}

// A name's topic only when it places this surely (links-ingest ACCEPT), each name looked up once per analysis.
function placer(env, block) {
  const memo = new Map();
  return name => {
    if (!memo.has(name)) memo.set(name, import('./map/resolve.js').then(({ resolveTopic }) => resolveTopic(env, MO, { texts: [name], source: 'uworld', source_ref: `uworld:${block.id}` }))
      .then(r => (r && r.topic_id && (r.confidence ?? 0) >= LINK_ACCEPT ? r.topic_id : null), () => null));
    return memo.get(name);
  };
}

async function saveTalkOptions(env, block, talk, out, place, t) {
  const counting = out.options.filter(o => o.fact_judged === 'right' || o.need_judged === 'right');
  const places = new Map();
  for (const o of counting) if (!places.has(o.topic)) places.set(o.topic, await place(o.topic));
  const qTopic = counting.length ? await questionTopics(env, block.id) : new Map();
  const ids = [...new Set([...places.values(), ...qTopic.values()].filter(Boolean))];
  const names = new Map(ids.length ? (await all(env, 'SELECT id, name FROM topics WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))', MO, JSON.stringify(ids))).map(r => [r.id, r.name]) : []);
  const startOf = new Map(out.questions.map(x => [x.q, x.start_ms]));
  const { versusLine } = await import('./map/links.js');
  const plan = optionPlan(block.id, out.options, { places, qTopic, names, atOf: q => atOfMs(talk, startOf.get(q), t), versusLine });
  await saveOptionRows(env, block.id, plan.rows);   // also with none: an earlier analysis's rows go
  return plan;
}

async function saveTalkLinks(env, block, links, versus, t, place) {
  const [{ planLinks }, { W }, { writeBatch }] = await Promise.all([import('./map/links-store.js'), import('./map/links.js'), import('./map/events.js')]);
  const base = { by: 'code', source: 'extractor', source_ref: `uwrev:${block.id}`, status: 'proposed', label: 'UWorld review' };
  const support = (key, text) => ({ obs_key: key, src: 'extractor', role: 'named', w: W.extractor, cw: 0, text: text || null, at: t });
  const proposals = [];
  let unplaced = 0;
  for (const [i, l] of links.entries()) {
    const [a, b] = [await place(l.from), await place(l.to)];
    if (!a || !b || a === b) { unplaced++; continue; }
    proposals.push({ ...base, type: l.type, from: a, to: b, support: support(`uwrev:${block.id}:L${i}`, l.quote) });
  }
  for (const v of versus) proposals.push({ ...base, type: 'versus', from: v.from, to: v.to, a_vs_b: v.a_vs_b, support: support(`uwrev:${block.id}:V${v.q}:${v.from}`, v.quote) });
  const keys = new Set(proposals.map(p => p.support.obs_key));
  const old = await all(env, 'SELECT link_id, obs_key, src, role FROM link_support WHERE user_id = ? AND obs_key >= ? AND obs_key < ? AND (w > 0 OR cw != 0)',
    MO, gapLo(block.id), gapHi(block.id)).catch(() => []);
  const stale = old.filter(s => !keys.has(s.obs_key)).map(s => ({ link_id: s.link_id, by: 'code', support: { obs_key: s.obs_key, src: s.src, role: s.role, w: 0, cw: 0, force: true } }));
  if (!proposals.length && !stale.length) return { made: 0, versus: 0, unplaced };
  const plan = await planLinks(env, MO, [...proposals, ...stale], { now: t, retire: 'rejudge', undoable: true });
  if (plan.rows.length) await writeBatch(env, MO, { actor: 'code', surface: 'code', via: 'cron:uworld_review_talk', rows: plan.rows, events: plan.events, undoable: true });
  const failed = p => plan.problems.some(x => x.from === p.from && x.to === p.to);
  const placed = proposals.filter(p => !failed(p));
  return { made: placed.filter(p => p.type !== 'versus').length, versus: placed.filter(p => p.type === 'versus').length,
    unplaced: unplaced + proposals.filter(p => p.type !== 'versus' && failed(p)).length };
}

// Every ref a belief from this block's review can carry (applyTalk's refs, below).
const beliefRefs = (block, stored) => [`UW review ${block.day}`, ...[...stored.values()].flatMap(q => [q.uworld_id && `UW ${q.uworld_id}`, `UW ${block.day} Q${q.q}`]).filter(Boolean)];

/**
 * Beliefs an earlier analysis of this review logged on its own (seen nowhere else since, still open) that this analysis
 * no longer finds: taken back, undoable. An analysis from before the ids were kept is matched by its words, logged from
 * a voice review with one of this block's refs. Returns how many.
 */
async function forgetBeliefs(env, block, stored, prev, kept) {
  const old = (prev && Array.isArray(prev.misconceptions) ? prev.misconceptions : []).filter(m => m && m.saved);
  if (!old.length) return 0;
  const ids = old.filter(m => m.id && m.created).map(m => m.id), legacy = old.filter(m => !m.id).map(m => m.belief);
  const rows = await all(env, `SELECT * FROM misconceptions WHERE user_id = ?1 AND status = 'open' AND coalesce(seen_n, 1) <= 1 AND (id IN (SELECT value FROM json_each(?2))
      OR (source = 'voice' AND belief IN (SELECT value FROM json_each(?3)) AND ref IN (SELECT value FROM json_each(?4))))`,
    MO, JSON.stringify(ids), JSON.stringify(legacy), JSON.stringify(beliefRefs(block, stored)));
  const gone = rows.filter(r => !kept.has(r.id));
  if (!gone.length) return 0;
  const [{ writeBatch }, { miscKind }] = await Promise.all([import('./map/events.js'), import('./map/teach-memory.js')]);
  await writeBatch(env, MO, { actor: 'code', surface: 'code', via: 'cron:uworld_review_talk', undoable: true,
    rows: gone.map(r => ({ table: 'misconceptions', op: 'delete', key: { id: r.id }, before: r })),
    events: gone.map(r => ({ kind: miscKind(), target_type: 'misconception', target_id: r.id, topic_id: r.topic_id || null,
      summary: `Misconception taken back, review analysed again: ${r.topic_name || r.topic_id || 'no topic'}`.slice(0, 160), before: r, after: null })) });
  return gone.length;
}

/** Everything the review gave, onto the block, the gaps, the answer choices, the misconceptions and the links. Returns the counts. */
export async function applyTalk(env, block, talk, out, ctx = null, t = now()) {
  const stored = new Map(parse(block.questions_json, []).map(q => [q.q, q]));
  const prev = parse(talk.analysis_json, null);
  const entries = [];
  for (const x of out.questions) {
    const q = stored.get(x.q);
    if (!isMiss(q) || !overrides(q, x)) { x.applied = x.cause ? 'kept' : null; continue; }
    x.before = q.cause ? { cause: q.cause, cause_inferred: q.cause_inferred ?? null } : null;
    x.applied = 'cause';
    entries.push({ q: x.q, cause: x.cause, cause_quote: x.cause_quote, cause_inferred: x.cause_inferred, cause_detail: x.cause_detail,
      ...(x.step ? { step: x.step } : {}),
      ...(x.cause === 'confusion' && x.mixed_with ? { look_alike: x.mixed_with } : {}) });
  }
  if (entries.length) await mergeQuestions(env, block.id, entries, ctx);
  await noteConcepts(env, MO, out.questions.filter(x => x.concept && isMiss(stored.get(x.q))).map(x => {
    const q = stored.get(x.q) || {};
    return { id: `uwb:${block.id}:${x.q}`, source: 'review_talk', uworld_block_id: block.id, uworld_q: x.q, concept: x.concept, concept_discipline: x.concept_discipline,
      concept_quote: x.concept_quote, cause: x.cause || q.cause || null, confidence: q.confidence || null, clinical_name: q.condition || q.topic || null,
      ref: q.uworld_id ? `UW ${q.uworld_id}` : null };
  }));
  // 2. Gaps on other topics, said aloud in the review.
  const gapIds = await saveTalkGaps(env, block, talk, out.gaps, t, out.heard);
  out.gaps.forEach((g, i) => { g.id = gapIds[i] || null; });
  const place = placer(env, block);
  const opt = await saveTalkOptions(env, block, talk, out, place, t);
  let misc = 0;
  for (const m of out.misconceptions) {
    const q = m.q != null ? stored.get(m.q) || {} : {};
    const ref = m.q != null ? (q.uworld_id ? `UW ${q.uworld_id}` : `UW ${block.day} Q${m.q}`) : `UW review ${block.day}`;
    const r = await misconceptionSave(env, MO, { topic: m.topic || q.condition || q.topic || undefined, belief: m.belief, ref, words: m.quote ? 'mo' : 'claude', source: 'voice' },
      { actor: 'code', surface: 'code', via: 'cron:uworld_review_talk' }).catch(e => ({ refused: true, reason: e && e.message }));
    m.saved = !!(r && r.id);
    if (m.saved) { misc++; m.id = r.id; m.created = r.merged === false; }
    else console.error('uworld review misconception refused', block.id, r && (r.reason || r.refuse || JSON.stringify(r.problems || '')));
  }
  const takenBack = await forgetBeliefs(env, block, stored, prev, new Set(out.misconceptions.filter(m => m.saved).map(m => m.id)))
    .catch(e => { console.error('uworld review beliefs', e && e.message); return 0; });
  const links = await saveTalkLinks(env, block, out.links, opt.versus, t, place)
    .catch(e => { console.error('uworld review links', e && e.message); return { made: 0, versus: 0, unplaced: out.links.length, failed: true }; });
  return { questions: out.questions.length, causes: entries.length, gaps: out.gaps.length, mixups: out.gaps.filter(g => g.mixed_with).length + out.questions.filter(x => x.cause === 'confusion').length,
    links: links.made, unplaced: links.unplaced + opt.unplaced, misconceptions: misc, known: opt.known, versus: links.versus,
    ...(takenBack ? { taken_back: takenBack } : {}), ...(prev ? { again: 1 } : {}) };
}

// ---------------------------------------------------------------- the job
const noteTalk = (env, block, state, counts, err = null) => noteJob(env, { job: 'uworld_review_talk', key: `${block.id}:${state}`, ref: block.id, state,
  counts: { ...counts, day: block.day || null, max: TALK_ATTEMPTS }, detail: detailOf(err) });

async function claim(env, blockId, t) {
  const r = await run(env, `UPDATE uworld_review_talks SET status = 'running', started_at = ?1, updated_at = ?1
    WHERE user_id = ?4 AND block_id = ?2 AND (status IN ('pending', 'waiting') AND next_at <= ?1
      OR (status IN ('failed', 'capped') AND next_at <= ?1 AND attempts < ?3) OR (status = 'running' AND updated_at < ?1 - ${STALE_MS}))`, t, blockId, TALK_ATTEMPTS, MO);
  return !!(r.meta && r.meta.changes);
}

async function judgeBusy(env, blockId) {
  const j = await first(env, 'SELECT status, attempts FROM uworld_judging WHERE block_id = ?', blockId).catch(() => null);
  if (!j) return true;
  if (j.status === 'done' || j.status === 'packing') return false;
  return !(j.status === 'failed' && j.attempts >= JUDGE_ATTEMPTS);
}

/** Analyse one block's review (one Claude call) and apply it. Returns {done, counts} or {skipped}. Throws for the log. */
export async function analyseTalk(env, blockId, ctx = null, t = now()) {
  const block = await first(env, 'SELECT * FROM uworld_blocks WHERE id = ?', blockId);
  const talk = await first(env, 'SELECT * FROM uworld_review_talks WHERE user_id = ? AND block_id = ?', MO, blockId);
  if (!block || !talk) return { skipped: 'no review' };
  if (!(await claim(env, blockId, t))) return { skipped: 'not claimed' };
  const prevA = parse(talk.analysis_json, null);
  let fallback = false;
  if ((await judgeMode(env)) === 'chat') {
    // Analysed by the API before and queued again without new words (the old catch-up after a rules bump): in chat mode
    // it stays as it was and is never sent to the API again (backend audit, 1 Nov 2026: no paying twice).
    if (prevA && !prevA.chat && talk.done_at && (Number(talk.sent_at) || 0) <= Number(talk.done_at)) {
      await run(env, `UPDATE uworld_review_talks SET status = 'done', error = NULL, updated_at = ? WHERE user_id = ? AND block_id = ?`, t, MO, blockId);
      return { skipped: 'analysed before; kept as it was' };
    }
    if (chatCovered(prevA, withMarks(block))) {
      await run(env, `UPDATE uworld_review_talks SET status = 'chat', error = NULL, updated_at = ? WHERE user_id = ? AND block_id = ?`, t, MO, blockId);
      await noteTalk(env, block, 'ok', { chat_skip: 1 });
      return { skipped: 'reviewed in the chat' };
    }
    const sent = talk.sent_at || t;
    if (t - sent < CHAT_WAIT_MS) {
      await run(env, `UPDATE uworld_review_talks SET status = 'waiting', next_at = ?, updated_at = ? WHERE user_id = ? AND block_id = ?`, Math.min(t + 5 * 60_000, sent + CHAT_WAIT_MS), t, MO, blockId);
      return { skipped: 'waiting for the chat review' };
    }
    fallback = true;
  }
  if ((t - (talk.sent_at || t)) < WAIT_JUDGE_MS && await judgeBusy(env, blockId)) {
    await run(env, `UPDATE uworld_review_talks SET status = 'waiting', next_at = ?, updated_at = ? WHERE user_id = ? AND block_id = ?`, t + 60_000, t, MO, blockId);
    return { skipped: 'waiting for the block judge' };
  }
  const questions = resulted(withMarks(block));
  const segments = parse(talk.segments_json, []);
  let data, usd = 0;
  const judged = new Map((await all(env, 'SELECT q, quote, teach_json FROM uworld_reviews WHERE block_id = ?', blockId).catch(() => [])).map(r => [r.q, r]));
  const objectives = await objectivesFor(env, MO, questions.map(q => q.uworld_id).filter(Boolean)).catch(() => ({}));
  const leakIndex = new Set(Object.values(objectives).flatMap(o => [...buildLeakIndex({ obj: o && o.text })]));
  const source = [segments.map(x => x.text).join(' '), parse(block.segments_json, []).map(x => x.text).join(' ')];
  let out, check = null;
  try {
    const release = await reserveSpend(env, RESERVE_USD, await spendCap(env));
    try {
      const msg = talkMessage(block, questions, judged, objectives, segments, talk.minutes);
      const system = withNames(TALK_SYSTEM, await nearNames(env, MO, questions.flatMap(q => [q.topic, q.condition, parse((judged.get(q.q) || {}).teach_json, {}).condition])).catch(() => []));
      const ask = extra => callJson(env, { role: 'reviewer', system, schema: TALK_SCHEMA, effort: 'high', maxTokens: 24000,
        messages: [{ role: 'user', content: extra ? [{ type: 'text', text: msg }, { type: 'text', text: extra }] : msg }] });
      const r = await ask();
      data = r.data; usd = Number(r.usd) || 0;
      // Every part checked (ai-audit.js); when some fail, the whole answer is asked again once and the better kept.
      out = tidyTalk(data, questions, leakIndex);
      let rows = talkRows(out, source);
      let reasked = 0;
      if (rows.some(x => !x.ok)) {
        reasked = rows.filter(x => !x.ok).length;
        const r2 = await ask(reaskText(rows));
        usd += Number(r2.usd) || 0;
        const out2 = tidyTalk(r2.data, questions, leakIndex), rows2 = talkRows(out2, source);
        if (rows2.filter(x => !x.ok).length <= rows.filter(x => !x.ok).length && out2.questions.length >= out.questions.length) { out = out2; rows = rows2; data = r2.data; }
      }
      out = dropTalkFakes(out, rows);
      check = await recordAudit(env, { job: 'uworld_review_talk', key: blockId, ref: block.day, rows, reasked, at: t });
    } catch (e) { usd += Number(e && e.usd) || 0; throw e; } finally { await release(0); }
  } catch (e) {
    if (isPending(e)) {
      // Waiting for its Message Batch: no try used, run again by the minute job.
      await run(env, `UPDATE uworld_review_talks SET status = 'pending', error = ?, next_at = ?, usd = usd + ?, updated_at = ? WHERE user_id = ? AND block_id = ?`,
        e.message, t + 60_000, usd, t, MO, blockId);
      await noteTalk(env, block, 'held', { batch: 1 });
      return { skipped: 'waiting for its batch' };
    }
    const capped = e instanceof HttpError && e.status === 429;
    await run(env, `UPDATE uworld_review_talks SET status = ?, attempts = attempts + ?, error = ?, next_at = ?, usd = usd + ?, updated_at = ? WHERE user_id = ? AND block_id = ?`,
      capped ? 'capped' : 'failed', capped ? 0 : 1, String(e && e.message || e).slice(0, 300), t + (capped ? CAPPED_WAIT_MS : RETRY_MS), usd, t, MO, blockId);
    await noteTalk(env, block, capped ? 'held' : 'failed', { tries: Number(talk.attempts || 0) + (capped ? 0 : 1) }, e);
    throw e;
  }
  out = await nameTalk(env, out, questions);
  // What the chat review saved is kept: the recording adds to it (the same merge as the chat's own saves).
  if (prevA && prevA.chat) out = { ...mergeTalk(prevA, out), chat: prevA.chat };
  out.rules = TALK_RULES;   // the catch-up queues analyses made under older rules again
  let counts;
  try {
    counts = await applyTalk(env, block, talk, out, ctx, t);
  } catch (e) {
    await run(env, `UPDATE uworld_review_talks SET status = 'failed', attempts = attempts + 1, error = ?, next_at = ?, usd = usd + ?, updated_at = ? WHERE user_id = ? AND block_id = ?`,
      `Saving the review failed: ${String(e && e.message || e).slice(0, 250)}`, t + RETRY_MS, usd, t, MO, blockId);
    await noteTalk(env, block, 'failed', { tries: Number(talk.attempts || 0) + 1 }, `Saving the review failed: ${detailOf(e)}`);
    throw e;
  }
  await run(env, `UPDATE uworld_review_talks SET status = 'done', attempts = 0, error = NULL, analysis_json = ?, counts_json = ?, usd = usd + ?, done_at = ?, updated_at = ?
    WHERE user_id = ? AND block_id = ?`, JSON.stringify(out), JSON.stringify(counts), usd, t, t, MO, blockId);
  // Which form made it (0067; quiet before the column, a failure on Recent activity).
  await run(env, 'UPDATE uworld_review_talks SET form_version = ? WHERE user_id = ? AND block_id = ?', FORM_VERSIONS.review_talk, MO, blockId).catch(stampFailed(env, 'uworld_review_talks'));
  await noteTalk(env, block, 'ok', { ...counts, ...auditCounts(check), ...(fallback ? { fallback: 1 } : {}) });
  return { done: true, counts, usd };
}

const TALK_PARTS = [['questions', 'question'], ['gaps', 'gap'], ['misconceptions', 'misconception'], ['links', 'link']];
export function talkRows(out, source) {
  return TALK_PARTS.flatMap(([k, kind]) => (out[k] || []).map((x, i) => checkItem({ ...x, kind }, { id: `${kind} ${x.q != null ? `Q${x.q}` : i + 1}`, ...AUDIT_SPECS.uworld_review_talk({ ...x, kind }), source })));
}
function dropTalkFakes(out, rows) {
  let i = 0;
  const res = { ...out };
  for (const [k] of TALK_PARTS) res[k] = (out[k] || []).map(x => dropFake(x, rows[i++]));
  return res;
}

/** The minute job: the next review that is due (one Claude call a minute at most). Never throws. */
export async function sweepTalks(env, ctx = null, t = now()) {
  if (!env || !env.DB) return;
  let rows;
  try {
    rows = await all(env, `SELECT block_id FROM uworld_review_talks WHERE user_id = ?1 AND (status IN ('pending', 'waiting') AND next_at <= ?2
      OR (status IN ('failed', 'capped') AND next_at <= ?2 AND attempts < ?3) OR (status = 'running' AND updated_at < ?2 - ${STALE_MS})) ORDER BY sent_at LIMIT 5`, MO, t, TALK_ATTEMPTS);
  } catch (e) { if (/no such table/i.test(String(e && e.message))) return; throw e; }
  for (const r of rows) {
    try {
      const out = await analyseTalk(env, r.block_id, ctx, t);
      if (out.skipped) continue;   // waiting for its block's judge: the next one may be ready
    } catch (e) { console.error('uworld review talk failed', r.block_id, e && e.message); }
    break;
  }
}

const KEYS = {
  gaps: g => `${g.q ?? ''}|${norm(g.topic)}`,
  misconceptions: m => `${m.q ?? ''}|${norm(m.topic) || norm(m.belief)}`,
  links: l => `${norm(l.from)}|${norm(l.to)}|${l.type}`,
  options: o => `${o.q}|${o.letter || norm(o.topic)}`,
};
const joinSaid = (a, b) => { if (!a) return b || null; if (!b || norm(a).includes(norm(b))) return a; const s = `${a} … ${b}`; return s.length > 300 ? s.slice(s.length - 300) : s; };

export function mergeTalk(prev, next) {
  if (!prev) return next;
  const byQ = new Map((prev.questions || []).map(x => [x.q, x]));
  for (const x of next.questions || []) {
    const old = byQ.get(x.q);
    if (!old) { byQ.set(x.q, x); continue; }
    const m = { ...old };
    for (const [k, v] of Object.entries(x)) if (v != null && v !== '' && !(k === 'clearer' && v === false)) m[k] = v;
    m.said = joinSaid(old.said, x.said);
    byQ.set(x.q, m);
  }
  const out = { ...prev, ...next, heard: next.heard || prev.heard || null, questions: [...byQ.values()].sort((a, b) => a.q - b.q) };
  for (const [k, key] of Object.entries(KEYS)) {
    const list = [...(prev[k] || [])];
    for (const y of next[k] || []) {
      const i = list.findIndex(x => key(x) === key(y));
      if (i >= 0) list[i] = { ...list[i], ...y }; else list.push(y);
    }
    out[k] = list;
  }
  return out;
}

/** Whether the chat review covers the block (pure): closed with done, or every wrong or shaky question talked about. */
export function chatCovered(analysis, questions) {
  const c = analysis && analysis.chat;
  if (!c) return false;
  if (c.done) return true;
  const on = (questions || []).filter(q => q.result === 'wrong' || q.result === 'omitted' || q.verdict === 'right_flawed').map(q => q.q);
  const said = new Set(c.questions || []);
  return on.length > 0 && on.every(q => said.has(q));
}

// ---------------------------------------------------------------- routes
const STATUS_WORDS = { pending: 'Sent: it is analysed within a minute or two', waiting: 'Sent: it is analysed once your block has been judged',
  running: 'Analysing your review…', failed: 'The analysis failed; the hub tries again by itself', capped: "Waiting: Claude's daily limit is reached",
  gave_up: 'The analysis failed three times. Send it again to retry', chat: 'Reviewed in the chat' };

/** The Recent activity words for a finished review (also the card's line): "18 questions, 6 gaps, 2 mix-ups, …". */
export function talkLine(c) {
  if (!c) return null;
  const p = (n, w, ws = `${w}s`) => `${Number(n) || 0} ${Number(n) === 1 ? w : ws}`;
  const bits = [p(c.questions, 'question'), p(c.gaps, 'gap'), p(c.mixups, 'mix-up'), p(c.links, 'link'), p(c.misconceptions, 'misconception')];
  if (Number(c.causes)) bits.push(`${p(c.causes, 'miss', 'misses')} re-read from your words`);
  if (Number(c.known)) bits.push(p(c.known, 'answer choice you knew', 'answer choices you knew'));
  if (Number(c.versus)) bits.push(p(c.versus, 'versus note'));
  return bits.join(', ');
}

async function talkState(env, block) {
  const talk = await first(env, 'SELECT status, attempts, words, counts_json, error, sent_at, done_at, updated_at FROM uworld_review_talks WHERE user_id = ? AND block_id = ?', MO, block.id).catch(() => null);
  const ready = resulted(withMarks(block)).length > 0;
  if (!talk) return { block_ready: ready, status: 'none' };
  const status = talk.status === 'failed' && talk.attempts >= TALK_ATTEMPTS ? 'gave_up' : talk.status;
  const counts = parse(talk.counts_json, null);
  return { block_ready: ready, status, status_words: status === 'done' ? `Analysed: ${talkLine(counts)}` : status === 'chat' && counts ? `Reviewed in the chat: ${talkLine(counts)}` : STATUS_WORDS[status] || null,
    counts: status === 'done' || status === 'chat' ? counts : null, words: talk.words, sent_at: talk.sent_at, done_at: talk.done_at };
}

export async function talkGetRoute(request, env, ctx, { id }) {
  const block = await first(env, 'SELECT id, day, count, questions_json, results_json FROM uworld_blocks WHERE id = ?', String(id));
  if (!block) return json({ block_ready: false, status: 'none', saved: false });
  return json(await talkState(env, block));
}

export async function talkPostRoute(request, env, ctx, { id }) {
  const b = await readJson(request, 2_000_000);
  if (b.reanalyse === true) return json(await reanalyse(env, String(id), ctx));
  if (b.phase != null && b.phase !== 'review') throw new HttpError(400, 'Only a review recording goes here.');
  const block = await first(env, 'SELECT id, day, count, questions_json, results_json FROM uworld_blocks WHERE id = ?', String(id));
  if (!block) throw new HttpError(404, 'This block is not saved on the hub yet. Wait until it says saved, then send your review.');
  if (!resulted(withMarks(block)).length) throw new HttpError(409, 'Send the block first (its question pages or results): the review is read against its questions.');
  const segments = scrubStems(cleanSegments(b.segments));
  const words = wordCount(segments);
  if (!words) throw new HttpError(400, 'Nothing was heard in your review yet.');
  const minutes = Number.isInteger(b.minutes) && b.minutes >= 0 ? Math.min(b.minutes, 600) : null;
  const t = now();
  const t0 = Number.isSafeInteger(b.t0) && b.t0 > t - 7 * 86_400_000 && b.t0 <= t + 60_000 ? b.t0 : null;
  const sig = String(words) + ':' + segments.map(s => s.text).join(' ').length;
  const cur = await first(env, 'SELECT status, words_sig FROM uworld_review_talks WHERE user_id = ? AND block_id = ?', MO, block.id);
  if (cur && cur.words_sig === sig && ['done', 'running', 'pending', 'waiting'].includes(cur.status)) return json({ saved: true, again: true, ...(await talkState(env, block)) });
  await run(env, `INSERT INTO uworld_review_talks (user_id, block_id, segments_json, words, minutes, t0, status, attempts, next_at, words_sig, sent_at, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, 0, ?7, ?8, ?8, ?8)
    ON CONFLICT (user_id, block_id) DO UPDATE SET segments_json = excluded.segments_json, words = excluded.words, minutes = excluded.minutes,
      t0 = coalesce(excluded.t0, uworld_review_talks.t0), status = 'pending', attempts = 0, next_at = 0, error = NULL, words_sig = excluded.words_sig,
      sent_at = excluded.sent_at, updated_at = excluded.updated_at`, MO, block.id, JSON.stringify(segments), words, minutes, t0, sig, t);
  // Started at once when the request can wait for it; the minute job picks it up otherwise (and retries it).
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(analyseTalk(env, block.id, ctx).catch(e => console.error('uworld review talk', e && e.message)));
  return json({ saved: true, words, ...(await talkState(env, block)) });
}

async function reanalyse(env, blockId, ctx) {
  const block = await first(env, 'SELECT id, day, count, questions_json, results_json FROM uworld_blocks WHERE id = ?', blockId);
  const talk = block && await first(env, 'SELECT status FROM uworld_review_talks WHERE user_id = ? AND block_id = ?', MO, block.id);
  if (!talk) throw new HttpError(404, 'There is no review of this block to analyse again: record it and send it first.');
  if (['pending', 'waiting', 'running'].includes(talk.status)) return { queued: false, ...(await talkState(env, block)) };
  // In chat mode a past review is never sent to the API again (backend audit, 1 Nov 2026); "use the hub judge" first.
  if ((await judgeMode(env)) === 'chat') return { queued: false, chat: true, ...(await talkState(env, block)) };
  await run(env, `UPDATE uworld_review_talks SET status = 'pending', attempts = 0, next_at = 0, error = NULL, updated_at = ? WHERE user_id = ? AND block_id = ?`, now(), MO, block.id);
  await noteJob(env, { job: 'uworld_review_talk', key: `${block.id}:again`, ref: block.id, state: 'ok', counts: { queued: 1, day: block.day || null } });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(analyseTalk(env, block.id, ctx).catch(e => console.error('uworld review talk', e && e.message)));
  return { queued: true, ...(await talkState(env, block)) };
}

export async function talkCatchupRoute(request, env) {
  let requeued = 0;
  if ((await judgeMode(env).catch(() => 'chat')) === 'chat') return json({ requeued, rules: TALK_RULES, chat: true });
  try {
    const r = await run(env, `UPDATE uworld_review_talks SET status = 'pending', attempts = 0, next_at = 0, error = NULL, updated_at = ?1
      WHERE user_id = ?2 AND status = 'done' AND coalesce(json_extract(analysis_json, '$.rules'), 1) < ?3`, now(), MO, TALK_RULES);
    requeued = Number(r.meta && r.meta.changes) || 0;
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) {
      await noteJob(env, { job: 'uworld_review_talk', key: `catchup:${londonDay()}:failed`, state: 'failed', counts: { requeued: 0 }, detail: detailOf(e) });
      throw e;
    }
  }
  await noteJob(env, { job: 'uworld_review_talk', key: `catchup:${londonDay()}`, state: 'ok', counts: { requeued }, add: true });
  return json({ requeued, rules: TALK_RULES });
}

// ---------------------------------------------------------------- for the connector
export async function reviewTalkFor(env, blockId) {
  const talk = await first(env, 'SELECT status, segments_json, analysis_json, counts_json FROM uworld_review_talks WHERE user_id = ? AND block_id = ?', MO, String(blockId)).catch(() => null);
  if (!talk) return null;
  const segs = parse(talk.segments_json, []);
  const a = parse(talk.analysis_json, null) || { questions: [] };
  const byQ = new Map((a.questions || []).map(x => [x.q, { said: x.said || null, at: x.start_ms != null ? mss(x.start_ms) : null, cause: x.cause || null,
    cause_quote: x.cause_quote || null, cause_detail: x.cause_detail || null, applied: x.applied || null,
    options: (a.options || []).filter(o => o.q === x.q).map(o => ({ topic: o.topic, letter: o.letter || null, fact: o.fact || null, fact_judged: o.fact_judged,
      need: o.need || null, need_judged: o.need_judged })) }]));
  const starts = (a.questions || []).filter(x => x.start_ms != null).map(x => ({ q: x.q, start_ms: x.start_ms }));
  const transcript = q => {
    if (q == null || !starts.some(s => s.q === q)) return q == null ? timeline(segs, []).join('\n') : null;
    return timeline(splitByStarts(segs, starts).groups.get(q) || [], []).join('\n') || null;
  };
  return { status: talk.status, line: talk.status === 'done' || talk.status === 'chat' ? talkLine(parse(talk.counts_json, null)) : STATUS_WORDS[talk.status] || null, by_q: byQ,
    gaps: (a.gaps || []).map(g => ({ q: g.q, topic: g.topic, gap: g.gap, mixed_with: g.mixed_with || null })), transcript };
}
