import { causeMultOf, detailOf, vivaPhaseWeight } from './weights.js';
import { FIT } from './fsrs.js';
import { bandOf, bandWord } from '../../../public/js/map/scale.js';
import { noteJob } from '../job-log.js';
import { londonDay, londonDayStart } from '../util.js';
import { EVIDENCE as SHARED_EVIDENCE } from '../../../public/js/shared/evidence.js';
import { stateSelect, liveScore } from './live.js';

export const FACETS = ['diagnose', 'manage'];
export const FACET_WORDS = { diagnose: 'Diagnose', manage: 'Manage' };
export const STEP_FACET = Object.freeze({ recognise: 'diagnose', distinguish: 'diagnose', test: 'diagnose', treat: 'manage', trap: 'manage' });
// The step a lesson aims at when a facet is the weaker one and nothing on the topic names a step.
export const FACET_STEP = Object.freeze({ diagnose: 'recognise', manage: 'treat' });
// Shrinkage, in answers' worth at no deviation (spec: K = 10 for the system, 4 for the topic).
export const K_SYSTEM = 10, K_TOPIC = 4;
// The pale colour's evidence constant, one for the whole hub (public/js/shared/evidence.js: thin under 2, solid from 5
// with a real answer in 60 days), so a topic's parts and the topic itself always use the same words for the same evidence.
export const EVIDENCE = Object.freeze({ some: SHARED_EVIDENCE.thin, solid: SHARED_EVIDENCE.solid, recent_days: SHARED_EVIDENCE.recent_days });
// Older facet answers count less in the estimate (half their weight after this many days); the strength uses FSRS's fade.
export const ESTIMATE_HALF_LIFE_DAYS = 60;
// A system's profile line needs this much facet evidence on each side, and a gap of this much to name the weaker part.
export const PROFILE = { min_w: 6, gap: 0.05 };
// Weights of each kind of facet answer (a normal question is 1; lessons as in fsrs.js REVIEW_W).
export const FACET_W = { question: 1, retest: 1, card_part: 0.5, gap: 0.3, gap_shaky: 0.2, lesson: 0.3, lesson_final_miss: 0.8, teachback_partial: 0.15, viva: 0.5, review_option: 0.3,
  self_rating: 0.2 };
// A self-rating's grade as a facet answer: Guess (again) 0, Lean (hard) half, Sure (good) 1.
const SELF_Y = { again: 0, hard: 0.5, good: 1, easy: 1 };
export const FACETS_VERSION = 1;
export const SOURCE = 'map.facets';   // sync_state: {at, systems, global, counts}

const DAY_MS = 86400000;
const lower = v => (v == null ? null : String(v).trim().toLowerCase() || null);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const P_CLIP = [0.02, 0.98];
export const logit = p => { const q = clamp(Number(p), P_CLIP[0], P_CLIP[1]); return Math.log(q / (1 - q)); };
export const sigmoid = x => 1 / (1 + Math.exp(-x));
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const noTable = e => /no such table|no such column/i.test(String(e && e.message));

// ------------------------------------------------------------------ tags

/** The facet of a five-step tag, or null. */
export const facetOfStep = s => STEP_FACET[lower(s)] || null;

// Words that name what a question asks. A diagnostic step ("next diagnostic step", "best initial test") is Diagnose
// even though it says "next step"; a bare "next step" is Manage.
const DIAG_FIRST = /\bdiagnos|\b(test|tests|investigation|imaging|work-?up|interpret)\b/;
const MANAGE = /\b(treat|treatment|treated|therapy|therapeutic|manag\w*|first[- ]line|second[- ]line|drug of choice|next (best )?step|what (do|would|should) you do|initial step|prevent\w*|prophyla\w*|definitive|surgery|operate|dose|antibiotics?|medications?|drug)\b/;
const DIAG = /\b(what is it|what's it|what is this|which condition|most likely|cause[sd]?|organism|bug|where is the lesion|lesion|mechanism|why|finding|sign|means?|meaning|what does)\b/;

/** 'diagnose' | 'manage' | null for one question's words (or a step check's title, or a belief). */
export function facetOfQuestion(text) {
  const s = lower(text);
  if (!s) return null;
  if (DIAG_FIRST.test(s)) return 'diagnose';
  if (MANAGE.test(s)) return 'manage';
  if (DIAG.test(s)) return 'diagnose';
  return null;
}

/** A card front's questions in order: its sentences that end in "?" (the whole front when none does). */
export function questionsOf(front) {
  const s = String(front || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const parts = s.split(/\n+|(?<=[.?!])\s+/).map(x => x.trim()).filter(Boolean);
  const qs = parts.filter(x => x.endsWith('?'));
  return qs.length ? qs : (s.trim() ? [s.trim()] : []);
}

/**
 * The facet of each part of a card review (pure): part i is the card's i-th question. With more questions than parts
 * (a case sentence that ends in "?"), the last ones are the questions; with fewer, nothing is matched.
 */
export function cardPartFacets(front, nParts) {
  const qs = questionsOf(front);
  if (!(nParts > 0) || qs.length < nParts) return new Array(Math.max(0, nParts | 0)).fill(null);
  return qs.slice(-nParts).map(facetOfQuestion);
}

/** One facet for a lesson from its five_step tags (null when they span both facets or say nothing). */
export function facetOfSteps(steps) {
  const fs = new Set((Array.isArray(steps) ? steps : []).map(facetOfStep).filter(Boolean));
  return fs.size === 1 ? [...fs][0] : null;
}

/** thin | some | solid from the faded evidence weight and the last real answer. */
export function strengthOf(nEff, lastRealAt, now = Date.now()) {
  const n = Number(nEff) || 0;
  if (n < EVIDENCE.some) return 'thin';
  if (n >= EVIDENCE.solid && lastRealAt != null && now - Number(lastRealAt) <= EVIDENCE.recent_days * DAY_MS) return 'solid';
  return 'some';
}

// ------------------------------------------------------------------ evidence rows -> facet answers

const PART_Y = { correct: 1, right: 1, nudged: 0.5, partial: 0.5, wrong: 0 };
function resultY(row) {
  const r = lower(row.result) || lower(row.outcome);
  if (r === 'right' || r === 'got_it' || r === 'correct') return 1;
  if (r === 'flawed' || r === 'partial') return 0.5;
  if (r === 'wrong' || r === 'omitted' || r === 'missed' || r === 'missed_again' || r === 'unsure') return 0;
  return null;
}

/**
 * The facet answers in one evidence row (pure): [{facet, y, w, at, real}], y in 0..1 (a nudged part or a flawed right
 * is half). ctx: {miss_step, gap_step, card_question} from the joins. Rows that say nothing, or no facet, give [].
 */
export function facetObs(row, ctx = {}) {
  if (!row || Number(row.held) === 1) return [];
  const at = Number(row.at);
  if (!Number.isFinite(at)) return [];
  const d = detailOf(row);
  const one = (facet, y, w, real = false) => (facet && y != null && w > 0 ? [{ facet, y, w, at, real }] : []);
  const tagged = facetOfStep(ctx.miss_step) || facetOfStep(d.step) || (FACETS.includes(d.facet) ? d.facet : null);
  switch (row.kind) {
    case 'question': {
      if (Number(row.slot) !== 0) return [];   // a look-alike's row is the other side of a miss
      const y = resultY(row);
      if (y == null) return [];
      return one(tagged, y, FACET_W.question * (y < 1 ? causeMultOf(row) : 1), true);
    }
    case 'retest': return one(tagged, resultY(row), FACET_W.retest, true);
    case 'card_review': {
      const parts = Array.isArray(d.parts) ? d.parts : [];
      if (!parts.length) return [];
      const facets = cardPartFacets(ctx.card_question, parts.length);
      const out = [];
      parts.forEach((p, i) => { const y = PART_Y[lower(p)]; if (facets[i] && y != null) out.push({ facet: facets[i], y, w: FACET_W.card_part, at, real: false }); });
      return out;
    }
    case 'gap_stated': case 'card_check': {
      if (ctx.card_parts) return [];
      const f = facetOfStep(ctx.gap_step) || facetOfStep(d.step);
      return lower(row.verdict) === 'shaky' ? one(f, 0.5, FACET_W.gap_shaky) : one(f, 0, FACET_W.gap);
    }
    // The viva (wave 4): a cold "tell me what you know", graded per facet before any teaching; its own weight, never a
    // question's (the honesty overseer can refit it).
    case 'recall_audit': return one(tagged, resultY(row), FACET_W.viva * vivaPhaseWeight(row));   // a lesson's closing viva half
    case 'review_option': return resultY(row) === 1 ? one(tagged, 1, FACET_W.review_option) : [];
    case 'self_rating': {
      const share = row.amount == null || !Number.isFinite(Number(row.amount)) ? 1 : clamp(Number(row.amount), 0, 1);
      return one(facetOfStep(d.step), SELF_Y[lower(row.rating)] ?? null, FACET_W.self_rating * share);
    }
    // Lessons (wave 3 item 4): rights after teaching say little (short-term performance), failures say a lot.
    case 'lesson_check': return resultY(row) === 0 ? one(tagged, 0, FACET_W.lesson) : [];
    case 'lesson_probe': {
      const y = resultY(row);
      if (y === 1) return one(tagged, 1, FACET_W.lesson);
      return d.from === 'new' && y === 0 ? one(tagged, 0, FACET_W.lesson) : [];
    }
    case 'lesson_final': {
      const y = resultY(row);
      return y == null ? [] : one(tagged, y, y === 0 ? FACET_W.lesson_final_miss : FACET_W.lesson);
    }
    case 'lesson_teachback': {
      const y = resultY(row);
      return y === 0 ? one(tagged, 0, FACET_W.lesson) : y === 0.5 ? one(tagged, 0, FACET_W.teachback_partial) : [];
    }
    case 'lesson_misconception': return one(tagged, 0, FACET_W.lesson);
    default: return [];
  }
}

// ------------------------------------------------------------------ the maths

const ageW = (at, now) => Math.pow(2, -Math.max(0, now - at) / DAY_MS / ESTIMATE_HALF_LIFE_DAYS);

// Residual sums of answers against a level p: {R, I, w}.
function sums(obs, pOf, now) {
  const s = { R: 0, I: 0, w: 0 };
  for (const o of obs) {
    const p = clamp(pOf(o), P_CLIP[0], P_CLIP[1]);
    const w = o.w * ageW(o.at, now);
    s.R += w * (o.y - p); s.I += w * p * (1 - p); s.w += w;
  }
  return s;
}

// Two facets' shrunk offsets, centred so their information-weighted mean is 0 (they split the level, never move it).
function centred(byFacet, K) {
  const raw = {}, info = {};
  for (const f of FACETS) {
    const s = byFacet[f] || { R: 0, I: 0, w: 0 };
    raw[f] = s.R / (s.I + K / 4);
    info[f] = s.I + K / 4;
  }
  const c = FACETS.reduce((a, f) => a + info[f] * raw[f], 0) / FACETS.reduce((a, f) => a + info[f], 0);
  return Object.fromEntries(FACETS.map(f => [f, raw[f] - c]));
}

/**
 * Each system's facet offsets (pure). obs: [{system, facet, y, w, at, p}] where p is the answer's topic level.
 * Returns Map(system -> {diagnose, manage, n: {facet: weight}, p: weighted mean topic level}).
 */
export function systemDeltas(obs, { now = Date.now(), K = K_SYSTEM } = {}) {
  const by = new Map();
  for (const o of obs || []) {
    if (!o || !FACETS.includes(o.facet) || !Number.isFinite(o.p)) continue;
    const k = o.system || '';
    if (!by.has(k)) by.set(k, { diagnose: [], manage: [] });
    by.get(k)[o.facet].push(o);
  }
  const out = new Map();
  for (const [k, g] of by) {
    const s = Object.fromEntries(FACETS.map(f => [f, sums(g[f], o => o.p, now)]));
    const all = [...g.diagnose, ...g.manage];
    const wsum = all.reduce((a, o) => a + o.w * ageW(o.at, now), 0);
    out.set(k, { ...centred(s, K), n: Object.fromEntries(FACETS.map(f => [f, r4(s[f].w)])),
      p: wsum > 0 ? all.reduce((a, o) => a + o.w * ageW(o.at, now) * o.p, 0) / wsum : null });
  }
  return out;
}

/**
 * One topic's two facets (pure). p: the topic's level; sys: its system's offsets ({diagnose, manage} or null); obs: the
 * topic's facet answers. Returns {diagnose: {...}, manage: {...}} with p, lo, hi (the range p +/- 1.28 sd with n_eff+3
 * answers), n (answers tagged), n_eff (faded weight), strength, band, d_system, d_topic, last_at.
 */
export function topicFacets(p, sys, obs, { now = Date.now(), K = K_TOPIC, fadeDays = FIT.fade_days } = {}) {
  const lp = logit(p);
  const ds = f => (sys && Number.isFinite(sys[f]) ? sys[f] : 0);
  const by = Object.fromEntries(FACETS.map(f => [f, (obs || []).filter(o => o.facet === f)]));
  const s = Object.fromEntries(FACETS.map(f => [f, sums(by[f], () => sigmoid(lp + ds(f)), now)]));
  const d = centred(s, K);
  const out = {};
  for (const f of FACETS) {
    const pf = sigmoid(lp + ds(f) + d[f]);
    const fade = o => (fadeDays ? Math.pow(2, -Math.max(0, now - o.at) / DAY_MS / fadeDays) : 1);
    const nEff = by[f].reduce((a, o) => a + o.w * fade(o), 0);
    const real = by[f].filter(o => o.real).map(o => o.at);
    const lastReal = real.length ? Math.max(...real) : null;
    const half = 1.28 * Math.sqrt(pf * (1 - pf) / (nEff + 3));
    const t1000 = Math.round(1000 * clamp((0.85 - pf) / 0.55, 0, 1));
    out[f] = { facet: f, p: r4(pf), lo: r4(clamp(pf - half, 0, 1)), hi: r4(clamp(pf + half, 0, 1)), n: by[f].length, n_eff: r4(nEff),
      strength: strengthOf(nEff, lastReal, now), t1000, band: bandOf(t1000), d_system: r4(ds(f)), d_topic: r4(d[f]),
      last_at: by[f].length ? Math.max(...by[f].map(o => o.at)) : null };
  }
  return out;
}

/**
 * Every topic's facets from the loaded answers (pure). obs: [{topic_id, system, facet, y, w, at, real}]; levels:
 * Map(topic_id -> {p, system}). Returns {topics: Map(topic_id -> topicFacets), systems: Map, global}.
 */
export function computeFacets(obs, levels, { now = Date.now() } = {}) {
  const withP = [];
  for (const o of obs || []) {
    const lv = levels.get(o.topic_id);
    if (!lv || !Number.isFinite(lv.p)) continue;
    withP.push({ ...o, p: lv.p, system: lv.system || '' });
  }
  const systems = systemDeltas(withP, { now });
  const global = systemDeltas(withP.map(o => ({ ...o, system: '*' })), { now }).get('*') || null;
  const byTopic = new Map();
  for (const o of withP) { if (!byTopic.has(o.topic_id)) byTopic.set(o.topic_id, []); byTopic.get(o.topic_id).push(o); }
  const topics = new Map();
  for (const [id, list] of byTopic) {
    const lv = levels.get(id);
    topics.set(id, topicFacets(lv.p, systems.get(lv.system || '') || null, list, { now }));
  }
  return { topics, systems, global, n: withP.length };
}

/**
 * The honesty check's facet forecast for one answer (pure): the facet's p for its topic just before the answer.
 * target: {topic_id, obs_key, at, facet}; p: the topic's forecast p then; system: its system; obs: facet answers
 * [{topic_id, system, obs_key, facet, y, w, at, p}] (p: each one's topic level now). Only answers before `at` count;
 * the system's offset leaves out the target's own topic (its level now includes this answer), and the topic's own
 * answers are measured against the forecast p, so nothing after the answer leaks in. Null without a facet.
 */
export function facetForecast(target, p, system, obs) {
  if (!target || !FACETS.includes(target.facet) || !Number.isFinite(Number(p))) return null;
  const at = Number(target.at);
  const before = (obs || []).filter(o => o.at < at && o.obs_key !== target.obs_key);
  const sysObs = before.filter(o => (o.system || '') === (system || '') && o.topic_id !== target.topic_id);
  const sys = systemDeltas(sysObs, { now: at }).get(system || '') || null;
  const mine = before.filter(o => o.topic_id === target.topic_id);
  const f = topicFacets(Number(p), sys, mine, { now: at });
  return f[target.facet].p;
}

/** A system's two facets as numbers ({diagnose, manage} in 0..1, weights) from its offsets, or null when too thin. */
export function systemProfile(sys) {
  if (!sys || !Number.isFinite(sys.p)) return null;
  const pd = sigmoid(logit(sys.p) + sys.diagnose), pm = sigmoid(logit(sys.p) + sys.manage);
  const ok = FACETS.every(f => (Number(sys.n && sys.n[f]) || 0) >= PROFILE.min_w);
  return { diagnose: r4(pd), manage: r4(pm), n: sys.n, enough: ok, weaker: !ok || Math.abs(pd - pm) < PROFILE.gap ? null : pd < pm ? 'diagnose' : 'manage' };
}

const pct = x => `${Math.round(100 * x)}%`;
/** "Cardiology: diagnose 64%, manage 48% - management is where you lose points" (null when too thin). */
export function profileLine(name, prof) {
  if (!prof || !prof.enough) return null;
  const tail = prof.weaker === 'manage' ? ' - management is where you lose points' : prof.weaker === 'diagnose' ? ' - diagnosis is where you lose points' : ' - about even';
  return `${name}: diagnose ${pct(prof.diagnose)}, manage ${pct(prof.manage)}${tail}`;
}

/** The facet to aim a lesson at: the weaker one when both are at least "some" evidence and they differ, else null. */
export function weakerFacet(f) {
  if (!f || !f.diagnose || !f.manage) return null;
  const ok = x => x.strength === 'some' || x.strength === 'solid';
  if (!ok(f.diagnose) && !ok(f.manage)) return null;
  // One side thin: the other must be clearly below the topic's level to say anything.
  const [a, b] = [f.diagnose, f.manage];
  if (Math.abs(a.p - b.p) < PROFILE.gap) return null;
  const weaker = a.p < b.p ? a : b;
  return ok(weaker) ? weaker.facet : null;
}

/** The panel's and Claude's shape of a topic's stored facet rows: {diagnose, manage, shown} (shown: not both thin). */
export function shapeFacets(rows) {
  const by = Object.fromEntries((rows || []).filter(r => FACETS.includes(r.facet)).map(r => [r.facet, {
    facet: r.facet, word: FACET_WORDS[r.facet], p: Number(r.p), lo: Number(r.lo), hi: Number(r.hi), n: Number(r.n) || 0, n_eff: Number(r.n_eff) || 0,
    strength: r.strength, band: bandOf(r.t1000), band_words: bandWord(bandOf(r.t1000)), t1000: r.t1000 == null ? null : Number(r.t1000),
  }]));
  if (!by.diagnose || !by.manage) return null;
  const shown = by.diagnose.strength !== 'thin' || by.manage.strength !== 'thin';
  return { diagnose: by.diagnose, manage: by.manage, shown, weaker: weakerFacet(by) };
}


// The kinds of facet answer, in the words of the basis line ("Based on 2 card parts").
export const PART_SOURCES = Object.freeze([['question', 'question'], ['card_part', 'card part'], ['gap', 'gap'], ['lesson', 'lesson check'], ['viva', 'viva answer'],
  ['self', 'self-rating']]);
const PART_SOURCE_OF = { question: 'question', retest: 'question', card_review: 'card_part', gap_stated: 'gap', card_check: 'gap', recall_audit: 'viva', self_rating: 'self' };
/** Which basis word a row's facet answers count under ('question', 'card_part', 'gap', 'lesson', 'viva'). */
export const partSourceOf = kind => PART_SOURCE_OF[kind] || (String(kind || '').startsWith('lesson_') ? 'lesson' : null);
const OTHER = { diagnose: 'manage', manage: 'diagnose' };
const TESTED = { diagnose: 'spotting it', manage: 'what to do' };
const SOURCE_PLURAL = { question: 'questions', card_part: 'cards', gap: 'gaps', lesson: 'lessons', viva: 'viva answers', self: 'self-ratings' };
const andList = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** An empty tally of one part's answers. */
export const emptyPartCount = () => ({ n: 0, right: 0, shaky: 0, wrong: 0, rows: 0, last_at: null, by: Object.fromEntries(PART_SOURCES.map(([k]) => [k, 0])) });

/** What a part rests on: "2 card parts", "3 questions and 1 gap" (null with nothing). */
export function partRests(count) {
  const by = (count && count.by) || {};
  const parts = PART_SOURCES.filter(([k]) => Number(by[k]) > 0).map(([k, w]) => `${by[k]} ${w}${Number(by[k]) === 1 ? '' : 's'}`);
  return parts.length ? andList(parts) : null;
}

/** "Based on 2 card parts, so this part is still a guess" (thin) or "Based on 3 questions and 1 gap". */
export function partBasis(count, strength = 'thin') {
  const rests = partRests(count);
  return rests ? `Based on ${rests}${strength === 'thin' ? ', so this part is still a guess' : ''}` : null;
}

/** "No Manage answers yet: your cards have only tested spotting it" (what the other part rests on), or the plain case. */
export function noPartWords(facet, otherCount) {
  const by = (otherCount && otherCount.by) || {};
  const src = PART_SOURCES.filter(([k]) => Number(by[k]) > 0).map(([k]) => SOURCE_PLURAL[k]);
  const head = `No ${FACET_WORDS[facet]} answers yet`;
  return src.length ? `${head}: your ${andList(src)} have only tested ${TESTED[OTHER[facet]]}` : `${head}: nothing on this topic is tied to a part yet`;
}

/**
 * Both parts for the panel's switch (pure): the stored facet rows (topic_facets, may be missing) and the tallies from the
 * timeline (evidence-timeline.js partCounts). Each part: {facet, word, scored, p, lo, hi, n, strength, band, band_words,
 * t1000, count, rests_on, basis, none, none_words}. none: no answer on this part at all (said plainly, never a made-up band).
 */
export function partsView(storedRows, counts = null) {
  const by = Object.fromEntries((storedRows || []).filter(r => r && FACETS.includes(r.facet)).map(r => [r.facet, r]));
  const out = {};
  for (const f of FACETS) {
    const r = by[f];
    const count = (counts && counts[f]) || { ...emptyPartCount(), n: r ? Number(r.n) || 0 : 0 };
    const t1000 = r && r.t1000 != null && Number.isFinite(Number(r.t1000)) ? Number(r.t1000) : null;
    const strength = r && r.strength ? r.strength : 'thin';
    const none = !(Number(count.n) > 0);
    out[f] = { facet: f, word: FACET_WORDS[f], scored: !!r && !none, p: r ? Number(r.p) : null, lo: r ? Number(r.lo) : null, hi: r ? Number(r.hi) : null,
      n: Number(count.n) || 0, strength, band: t1000 == null ? null : bandOf(t1000), band_words: t1000 == null ? null : bandWord(bandOf(t1000)), t1000,
      count, rests_on: none ? null : partRests(count), basis: none ? null : partBasis(count, strength), none, none_words: none ? noPartWords(f, counts && counts[OTHER[f]]) : null };
  }
  return out;
}

/** Claude's line for a topic's facets ("Diagnose 66% (58-74, some evidence), Manage 47% (...)"), or null. */
export function facetsText(f) {
  if (!f || !f.shown) return null;
  const one = x => `${x.word} ${pct(x.p)} (${Math.round(100 * x.lo)}-${Math.round(100 * x.hi)}%, ${x.strength} evidence, ${x.n} answer${x.n === 1 ? '' : 's'})`;
  return `Parts: ${one(f.diagnose)}; ${one(f.manage)}${f.weaker ? `. Weaker part: ${f.weaker}` : ''}.`;
}

// ------------------------------------------------------------------ reads

// The evidence kinds facetObs reads. One list for the hourly score and the panel's row tags (evidence-timeline.js), so a
// row tagged Diagnose on the panel is always one the Diagnose score counted (the viva's rows were left out before).
export const FACET_KINDS = Object.freeze(['question', 'retest', 'card_review', 'gap_stated', 'card_check', 'lesson_check', 'lesson_probe',
  'lesson_final', 'lesson_teachback', 'lesson_misconception', 'recall_audit', 'review_option', 'self_rating']);

// Every live evidence row that can carry a facet, with the joins that tag it: the miss's step, the gap's step and the
// card's front (card reviews with parts), and the topic's system and level.
export const OBS_SQL = `SELECT e.obs_key, e.slot, e.topic_id, e.kind, e.at, e.day, e.result, e.outcome, e.verdict, e.confidence, e.error_type,
    e.held, e.card_id, e.amount, e.rating, e.detail_json, m.step AS miss_step, g.step AS gap_step, c.question AS card_question
  FROM evidence e
  LEFT JOIN misses m ON m.user_id = e.user_id AND m.id = e.miss_id
  LEFT JOIN gaps g ON g.id = e.gap_id
  LEFT JOIN card_cache c ON c.user_id = e.user_id AND c.card_id = e.card_id AND e.kind = 'card_review'
  WHERE e.user_id = ?1 AND e.held = 0 AND e.topic_id IS NOT NULL
    AND e.kind IN (${FACET_KINDS.map(k => `'${k}'`).join(', ')})
    AND (m.step IS NOT NULL OR g.step IS NOT NULL OR json_extract(e.detail_json, '$.parts') IS NOT NULL
      OR json_extract(e.detail_json, '$.facet') IS NOT NULL OR json_extract(e.detail_json, '$.step') IS NOT NULL)`;
// The level is the topic's own "N% next time" as of now (live.js: the stored row faded on read), so a topic left alone
// for weeks splits its faded level, not the one it had when its last answer landed.
export const LEVELS_SQL = `SELECT s.topic_id, s.weakness_raw, coalesce(t.category_id, s.category_id) AS system, ${stateSelect('s')} FROM topic_scores s
  LEFT JOIN topics t ON t.user_id = s.user_id AND t.id = s.topic_id WHERE s.user_id = ?1 AND s.seen = 1 AND s.weakness_raw IS NOT NULL`;

/**
 * Each row's facet answers (pure): Map(row -> [{facet, y, w, at, real}]), rows outside FACET_KINDS giving none. rows carry
 * OBS_SQL's joins (miss_step, gap_step, card_question). The hourly score (obsFromRows) and the panel's Diagnose / Manage
 * tags (evidence-timeline.js) both read this, so a row's tag and the part scores can never disagree.
 */
export function rowFacetObs(rows) {
  const list = (rows || []).filter(Boolean);
  // A card day whose review carries parts: its gap rows describe those parts, so they are not counted again.
  const partsDays = new Set(list.filter(r => r.kind === 'card_review' && Array.isArray(detailOf(r).parts) && detailOf(r).parts.length)
    .map(r => `${r.card_id}|${r.day}`));
  const out = new Map();
  for (const r of list) {
    if (!FACET_KINDS.includes(r.kind)) { out.set(r, []); continue; }
    const ctx = { miss_step: r.miss_step, gap_step: r.gap_step, card_question: r.card_question,
      card_parts: r.kind === 'card_check' && r.card_id != null && partsDays.has(`${r.card_id}|${r.day}`) };
    out.set(r, facetObs(r, ctx));
  }
  return out;
}

/** A row's part tag from its facet answers: 'diagnose' | 'manage' | 'both' | null (not tied to a part). */
export function facetTag(obs) {
  const fs = new Set((obs || []).map(o => o.facet).filter(f => FACETS.includes(f)));
  return fs.size === 2 ? 'both' : fs.size === 1 ? [...fs][0] : null;
}

/** The facet answers from OBS_SQL's rows (pure): [{topic_id, obs_key, facet, y, w, at, real}]. */
export function obsFromRows(rows) {
  const out = [];
  for (const [r, list] of rowFacetObs(rows)) for (const o of list) out.push({ ...o, topic_id: r.topic_id, obs_key: r.obs_key });
  return out;
}

/** A level row's p as of now: 1 - its live weakness_raw (live.js), or the stored one for a row read without its state. */
export function levelP(r, now = Date.now()) {
  const l = liveScore(r, now);
  return 1 - Number(l ? l.weakness_raw : r.weakness_raw);
}
/** The topics' levels (pure): Map(topic_id -> {p, system}). */
export const levelsFromRows = (rows, now = Date.now()) => new Map((rows || []).map(r => [r.topic_id, { p: levelP(r, now), system: r.system || '' }]));

/** All facet answers and levels, two reads in one batch: {obs, levels}. */
export async function loadFacetData(env, user, { now = Date.now() } = {}) {
  const [a, b] = await env.DB.batch([env.DB.prepare(OBS_SQL).bind(user), env.DB.prepare(LEVELS_SQL).bind(user)]);
  return { obs: obsFromRows(a.results || []), levels: levelsFromRows(b.results || [], now) };
}

/**
 * Stored part rows faded with the topic's level as of now (pure; on read, like the topic's own colour): each row that
 * kept its offsets (d_system, d_topic) gets p = sigmoid(logit(p_topic) + d_system + d_topic) again, with its range,
 * t1000 and band. p: the topic's level now (1 - live weakness_raw); null leaves the rows as stored.
 */
export function liveFacetRows(rows, p) {
  if (p == null || !Number.isFinite(Number(p))) return rows || [];
  const lp = logit(Number(p));
  return (rows || []).map(r => {
    if (!r || r.d_system == null || r.d_topic == null || !Number.isFinite(Number(r.d_system)) || !Number.isFinite(Number(r.d_topic))) return r;
    const pf = sigmoid(lp + Number(r.d_system) + Number(r.d_topic));
    const half = 1.28 * Math.sqrt(pf * (1 - pf) / ((Number(r.n_eff) || 0) + 3));
    const t1000 = Math.round(1000 * clamp((0.85 - pf) / 0.55, 0, 1));
    return { ...r, p: r4(pf), lo: r4(clamp(pf - half, 0, 1)), hi: r4(clamp(pf + half, 0, 1)), t1000, band: bandOf(t1000) };
  });
}
/** The part-row columns a reader selects so liveFacetRows can fade them. */
export const FACET_READ_COLS = 'facet, p, lo, hi, n, n_eff, strength, t1000, d_system, d_topic';

// ------------------------------------------------------------------ the job

const BASE_COLS = ['user_id', 'topic_id', 'facet', 'p', 'lo', 'hi', 'n', 'n_eff', 'strength', 't1000', 'd_system', 'd_topic', 'last_at', 'computed_at'];
// event_at (0068): set when a row is written straight away for a touched topic; the hourly run never touches it.
const upsertSql = (withEvent = false) => {
  const cols = withEvent ? [...BASE_COLS, 'event_at'] : BASE_COLS;
  return `INSERT INTO topic_facets (${cols.join(', ')}) SELECT ${cols.map(c => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?1) WHERE true
  ON CONFLICT (user_id, topic_id, facet) DO UPDATE SET ${cols.slice(3).map(c => `${c} = excluded.${c}`).join(', ')}`;
};
const CHUNK = 200;
const noEventAt = e => /no such column/i.test(String(e && e.message)) && /event_at/.test(String(e && e.message));
const facetRow = (user, id, k, v, now, eventAt = null) => ({ user_id: user, topic_id: id, facet: k, p: v.p, lo: v.lo, hi: v.hi, n: v.n, n_eff: v.n_eff, strength: v.strength,
  t1000: v.t1000, d_system: v.d_system, d_topic: v.d_topic, last_at: v.last_at, computed_at: now, ...(eventAt != null ? { event_at: eventAt } : {}) });
// Statements in chunks of 50 a batch; a database before 0068 (no event_at) writes the same rows without it.
async function runFacetStatements(env, build) {
  const go = async withEvent => { const st = build(withEvent); for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50)); return st.length; };
  try { return await go(true); } catch (e) { if (!noEventAt(e)) throw e; return go(false); }
}

// A stored row moves when its p moves by half a point or its strength changes (so an hourly run writes little).
const moved = (a, b) => !a || a.strength !== b.strength || Math.abs(Number(a.p) - b.p) >= 0.005 || Number(a.n) !== b.n;

/**
 * The hourly recompute: every topic's two facets from all facet answers, written where they moved; the systems'
 * profile kept in sync_state; one Recent activity line a day (the last run's counts), failures too.
 * Returns {topics, written, removed, answers, enough} or {skipped}.
 */
export async function facetsJob(env, user, { now = Date.now() } = {}) {
  try {
    const { obs, levels } = await loadFacetData(env, user, { now });
    const res = computeFacets(obs, levels, { now });
    const stored = (await env.DB.prepare('SELECT topic_id, facet, p, n, strength FROM topic_facets WHERE user_id = ?1').bind(user).all()).results || [];
    const old = new Map(stored.map(r => [`${r.topic_id}|${r.facet}`, r]));
    const rows = [];
    let enough = 0;
    for (const [id, f] of res.topics) {
      if (FACETS.some(k => f[k].strength !== 'thin')) enough++;
      for (const k of FACETS) {
        const v = f[k];
        if (!moved(old.get(`${id}|${k}`), v)) continue;
        rows.push(facetRow(user, id, k, v, now));
      }
    }
    const gone = [...new Set(stored.map(r => r.topic_id))].filter(id => !res.topics.has(id));
    const systems = {};
    for (const [k, s] of res.systems) { const prof = systemProfile(s); if (prof) systems[k] = { ...prof, d: r4(s.diagnose), m: r4(s.manage), p: r4(s.p) }; }
    const global = systemProfile(res.global);
    const counts = { topics: res.topics.size, enough, written: rows.length / FACETS.length | 0, removed: gone.length, answers: res.n };
    await runFacetStatements(env, () => {
      const stmts = [];
      const up = upsertSql(false);
      for (let i = 0; i < rows.length; i += CHUNK) stmts.push(env.DB.prepare(up).bind(JSON.stringify(rows.slice(i, i + CHUNK))));
      if (gone.length) stmts.push(env.DB.prepare('DELETE FROM topic_facets WHERE user_id = ?1 AND topic_id IN (SELECT value FROM json_each(?2))').bind(user, JSON.stringify(gone)));
      stmts.push(env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at, fails, lock_until) VALUES (?1, ?2, ?3, ?4, 0, 0)
        ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at`)
        .bind(user, SOURCE, JSON.stringify({ at: now, version: FACETS_VERSION, systems, global, counts }), now));
      return stmts;
    });
    const weakest = global && global.weaker ? global.weaker : null;
    // Updated straight away today (1 Nov 2026): folded into this one daily line, never a line per answer.
    const instant = await instantCounts(env, user, now).catch(() => ({}));
    await noteJob(env, { job: 'facets', user, ref: 'recompute', key: `recompute:${londonDay(now)}`, at: now, state: 'ok',
      counts: { ...counts, weaker: weakest || 'even', ...instant } });
    return counts;
  } catch (e) {
    if (noTable(e)) return { skipped: 'no topic_facets table yet' };
    await noteJob(env, { job: 'facets', user, ref: 'recompute', key: `recompute:${londonDay(now)}`, at: now, state: 'failed', detail: e });
    throw e;
  }
}

// ------------------------------------------------------------------ straight away (1 Nov 2026)

// At most this many topics a call; more (a rebuild, a bulk import) are left to the hourly run.
export const INSTANT_MAX = 60;
const instantIds = list => [...new Set((list || []).filter(x => x != null && x !== '').map(String))].slice(0, INSTANT_MAX);

/**
 * The four reads recomputeTopicFacets needs, as statements a caller can put at the end of its own write batch (they then
 * see that batch's evidence and scores, and cost no query of their own): the topics' facet answers, their levels, their
 * stored parts and the systems' offsets. Pass the batch's last four results back as `reads`.
 */
export function facetReadStatements(DB, user, topicIds) {
  const list = JSON.stringify(instantIds(topicIds));
  return [
    DB.prepare(`${OBS_SQL} AND e.topic_id IN (SELECT value FROM json_each(?2))`).bind(user, list),
    DB.prepare(`${LEVELS_SQL} AND s.topic_id IN (SELECT value FROM json_each(?2))`).bind(user, list),
    DB.prepare('SELECT topic_id, facet, p, n, strength FROM topic_facets WHERE user_id = ?1 AND topic_id IN (SELECT value FROM json_each(?2))').bind(user, list),
    DB.prepare('SELECT cursor FROM sync_state WHERE user_id = ?1 AND source = ?2').bind(user, SOURCE),
  ];
}
// Whether this database has topic_facets (0058), as one statement for a caller's read batch: rows [{n}].
export const FACETS_READY_SQL = "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'topic_facets'";

export async function recomputeTopicFacets(env, user, topicIds, { now = Date.now(), reads = null } = {}) {
  const ids = instantIds(topicIds);
  if (!ids.length || !env || !env.DB) return { topics: 0, written: 0, removed: 0 };
  let res = reads;
  if (!res) {
    try {
      res = await env.DB.batch(facetReadStatements(env.DB, user, ids));
    } catch (e) {
      if (noTable(e)) return { skipped: 'no topic_facets table yet' };
      throw e;
    }
  }
  const obs = obsFromRows(res[0].results || []);
  const levels = levelsFromRows(res[1].results || [], now);
  const old = new Map((res[2].results || []).map(r => [`${r.topic_id}|${r.facet}`, r]));
  let profile = null;
  try { profile = (res[3].results || [])[0] ? JSON.parse(res[3].results[0].cursor) : null; } catch { profile = null; }
  const sysOf = system => { const x = profile && profile.systems && profile.systems[system || '']; return x ? { diagnose: Number(x.d) || 0, manage: Number(x.m) || 0 } : null; };
  const byTopic = new Map();
  for (const o of obs) { if (!byTopic.has(o.topic_id)) byTopic.set(o.topic_id, []); byTopic.get(o.topic_id).push(o); }
  const rows = [], kept = new Set();
  for (const id of ids) {
    const lv = levels.get(id), mine = byTopic.get(id);
    if (!lv || !Number.isFinite(lv.p) || !mine || !mine.length) continue;
    kept.add(id);
    const f = topicFacets(lv.p, sysOf(lv.system), mine, { now });
    for (const k of FACETS) if (moved(old.get(`${id}|${k}`), f[k])) rows.push(facetRow(user, id, k, f[k], now, now));
  }
  const gone = [...new Set([...old.values()].map(r => r.topic_id))].filter(id => !kept.has(id));
  if (!rows.length && !gone.length) return { topics: kept.size, written: 0, removed: 0 };
  await runFacetStatements(env, withEvent => {
    const out = [];
    if (rows.length) out.push(env.DB.prepare(upsertSql(withEvent)).bind(JSON.stringify(withEvent ? rows : rows.map(({ event_at, ...r }) => r))));
    if (gone.length) out.push(env.DB.prepare('DELETE FROM topic_facets WHERE user_id = ?1 AND topic_id IN (SELECT value FROM json_each(?2))').bind(user, JSON.stringify(gone)));
    return out;
  });
  return { topics: kept.size, written: rows.length / FACETS.length | 0, removed: gone.length };
}

/**
 * What changed straight away today, for the hourly line (one read batch, no write): topics whose colour was worked out
 * again as their evidence landed (scores computed today), topics whose parts were (event_at today), and Anki Voice's
 * reviews sent straight to the hub today (the server says so on its card_reviews; ingest/anki-reviews.js keeps it).
 */
export async function instantCounts(env, user, now = Date.now()) {
  const day = londonDay(now), dayStart = londonDayStart(now);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [a, b, c] = await env.DB.batch([
    q('SELECT count(*) AS n FROM topic_scores WHERE user_id = ?1 AND seen = 1 AND computed_at >= ?2', user, dayStart),
    q('SELECT count(DISTINCT topic_id) AS n FROM topic_facets WHERE user_id = ?1 AND event_at >= ?2', user, dayStart),
    q("SELECT cursor FROM sync_state WHERE user_id = ?1 AND source = 'anki.reviews'", user),
  ]);
  let pushed = null;
  try { const cur = JSON.parse(((c.results || [])[0] || {}).cursor || '{}'); if (cur.pushed_day === day) pushed = Number(cur.pushed) || 0; } catch { pushed = null; }
  return { instant_colours: Number(((a.results || [])[0] || {}).n) || 0, instant_parts: Number(((b.results || [])[0] || {}).n) || 0,
    ...(pushed != null ? { instant_reviews: pushed } : {}) };
}

/** The stored profile (sync_state) or null: {at, systems: {id: profile}, global, counts}. */
export async function storedProfile(env, user) {
  try {
    const row = await env.DB.prepare('SELECT cursor FROM sync_state WHERE user_id = ?1 AND source = ?2').bind(user, SOURCE).first();
    return row && row.cursor ? JSON.parse(row.cursor) : null;
  } catch { return null; }
}

/**
 * The profile lines for map_overview and teach_next (pure): the overall split first, then up to `max` systems with a
 * clear weaker part, largest gap first. names: Map(system id -> name).
 */
export function profileLines(stored, names = new Map(), { max = 3 } = {}) {
  if (!stored) return [];
  const out = [];
  const g = stored.global ? profileLine('Overall', stored.global) : null;
  if (g) out.push(g);
  const list = Object.entries(stored.systems || {}).filter(([, p]) => p.enough && p.weaker)
    .sort((a, b) => Math.abs(b[1].diagnose - b[1].manage) - Math.abs(a[1].diagnose - a[1].manage)).slice(0, max);
  for (const [id, p] of list) { const l = profileLine(names.get(id) || id, p); if (l) out.push(l); }
  return out;
}

/** A topic's stored facet rows (both facets, with their offsets for liveFacetRows), or [] (before 0058). */
export async function topicFacetRows(env, user, topicId) {
  try {
    return (await env.DB.prepare(`SELECT ${FACET_READ_COLS} FROM topic_facets WHERE user_id = ?1 AND topic_id = ?2`).bind(user, topicId).all()).results || [];
  } catch (e) { if (noTable(e)) return []; throw e; }
}
