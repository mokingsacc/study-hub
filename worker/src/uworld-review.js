import { HttpError, json, now, londonDay } from './util.js';
import { all, first, run, reserveSpend, spendCap, getSetting, BLOCK_JUDGES } from './db.js';
import { callJson, cachedTurn, isPending } from './claude.js';
import { AUDIT_SPECS, auditAndReask, checkItem, reaskText, recordAudit, auditCounts } from './ai-audit.js';
import { timeline, quoteStart, splitByStarts } from '../../public/js/uworld/split.js';
import { ERROR_TYPES, normError, buildLeakIndex, leaks } from './checks.js';
import { mergeQuestions, startMs } from './uworld.js';
import { paceWord, PACE } from './map/weights.js';
import { objectivesFor } from './library/objectives.js';
import { ankiCall, AnkiError, SERVER_ERROR } from './anki.js';
import { mehlmanFor, bestPassage, bestPictures } from './map/mehlman.js';
import { briefReads } from './map/teach-brief.js';
import { misconceptionSave } from './map/teach-memory.js';
import { pullForUworld } from './map/sync.js';
import { MO } from './users.js';
import { correctLines, fixesNote } from './asr-fix.js';
import { noteJob, detailOf } from './job-log.js';
import { CONFIDENCE_RULE } from '../../public/js/conf-words.js';
import { FLAW_KINDS } from './prompts.js';
import { uworldOutcome, uworldQuestionAt } from './map/ingest/map-fields.js';
import { CAUSE_RULES, tidyCause } from '../../public/js/shared/cause.js';
import { CONCEPT_RULES } from '../../public/js/shared/concept.js';
import { CORE_RULES, CORE_SCHEMA_PROPS, CORE_FIELDS, tidyCore, consideredNotConfused, FORM_VERSIONS } from './answer-core.js';
import { nearNames, withNames, nameOthers } from './map/name-map.js';
import { gapStatement, hasMapCols, hasSignalCols, hasFormCols, mapGaps } from './gaps.js';
import { noteConcepts } from './map/concepts.js';
import { enqueuePattern } from './map/patterns.js';
import { pagesFor, dropPages, sweepPages, unleak } from './uworld-pages.js';
import { historyFor, historyLines } from './uworld-history.js';
import { focusScript } from './uworld-capture.js';

/** Blocks saved on or after this day are judged (the backfill starts here; older ones never are). */
export const JUDGE_FROM = '2026-10-27';
export const REVIEW_DAILY_USD = Infinity;
const RESERVE_USD = 3;
export const MAX_ATTEMPTS = 3, PACK_TRIES = 3;
/** A block is judged once nothing has changed on it for SETTLE_MS (a second screenshot, the recorder's last save), and
 * once every question has its result, or WAIT_ALL_MS after the last change when some rows were never read. */
export const SETTLE_MS = 90_000, WAIT_ALL_MS = 10 * 60_000;
const STALE_MS = 15 * 60_000, CAPPED_WAIT_MS = 60 * 60_000;
export const MARKS_WAIT_MS = 24 * 3600_000;
/** A judged question whose stretch of the transcript gains more words than this (audio recovered) is judged again. */
export const REJUDGE_WORDS = 20;
export const SEEN_CHUNK = 5;
const spentKey = (day = londonDay()) => `uwreview_usd:${day}`;

// ---------------------------------------------------------------- the judge call
export const REVIEW_SYSTEM = `You review one timed UWorld block that Mo (a learner preparing for USMLE Step 2 CK) recorded himself thinking aloud through. You get his words (transcribed by Whisper, so expect misheard medical words) with times from the start of the recording, and one row per question from UWorld's results screen: its number, ID, whether he got it right (decided by UWorld, never by you), the subject, system and topic labels, his time, other users' % correct, and, when his notes have it, the educational objective UWorld says the question tested. You never see the question itself.

For every question:
1. Find his words for it. Questions come in order; a new one usually starts with a new patient (new age, sex, complaint) often after a pause, and ends when he names a letter. A cue in brackets ("said: next question", "said: question 12", "end of question 11", "a pick, then a new case") is a sure boundary. Use the topic labels and objectives to line them up. Give start as the time of his first words on it ("12:05") and start_quote as those first 3 to 5 words exactly as the transcript has them (a line can hold the end of one question and the start of the next, and the quote is where it is cut), or null for both if he said nothing.
2. Judge his reasoning from his words only:
   - sound: a right answer with the deciding clue and a sure, correct reason.
   - right_flawed: right, but hedged between two answers and never settled, guessed, changed his mind, used a wrong or missing reason, or was very slow from doubt. A right answer he called a lean or a guess is always right_flawed, never sound. Be fair: brief thinking that lands on the right clue is sound. Give flaw_kind for right_flawed only: lucky_guess (guessed, or a 50-50 he never settled), right_wrong_reason (the reason he gave is wrong or missing), shaky_elimination (ruled an option out for a wrong reason), misread_detail (misread a detail of the case and got lucky).
   - wrong: UWorld marked it wrong or omitted.
   - no_speech: right, and he said nothing (or nothing usable) on it.
3. error_type for wrong and right_flawed only, from the fixed list. Ask first: "Would knowing one more fact have saved him?" If yes, it is knowledge gap (did not know the fact or what a clue means, or narrowed to two look-alikes and guessed); most misses that look like a bias are a missing fact underneath. premature closure only when his words show he knew the deciding fact and still ignored a striking clue in the stem, stopping at the first answer that fitted. Never assume he knew something because it is basic or common: only his own words count as proof that he knew it. faulty synthesis: had the facts and said them, combined them wrongly. misread: missed or misread a detail he would have known. test-taking: changed a right answer, ran out of time, misclicked, answered a different question. threshold or number, calculation. When it is borderline, choose knowledge gap.
   step, for wrong and right_flawed only: the one step that broke. recognise: did not know what it is from the findings. distinguish: narrowed to it and a look-alike and could not tell them apart. test: knew what it is but chose the wrong workup or next test. treat: knew what it is but chose the wrong management. trap: fell for a classic exception, threshold, contraindication or the wrong question asked.
   For every question he spoke on: ${CONFIDENCE_RULE} (not_said where that says null, and for a question he said nothing on).
4. why: one plain line on what happened, in your words ("hedged between B and D and never settled", "thought steroids first, missed that it is infective"). quote: a few of his own words that show it (under 15 words), or null.
5. said_pick: the letter he said he chose, if he said one; else null. first_pick: the first letter he said he would choose, only when he later changed to another; else null.
6. teach, for wrong and right_flawed only (null for the others), short plain sentences, US guidelines, no arrows or symbols:
   - rule: one "If X, then Y" sentence: the take-away the objective tests.
   - decision_point: the clue that should have decided it, as a finding ("a fever with a new murmur after dental work").
   - look_alike: a teaching contrast only: the condition, drug or step the right answer is best told apart from (often the one he went for), named as AMBOSS would, or an empty string. It is never a claim that he mixed them up: that is cause confusion (step 8).
   - separator: the finding that tells the right answer from the look-alike, and what you do differently.
   - condition: the one condition or approach that would have got it right, named as an AMBOSS US article names it, singular, no "vs".
   - misconception: a wrong belief his words show he holds (for example "thinks a high protein ascites means cirrhosis"), in one line, or null. Only a real false belief, not a missing fact.
   - trap: a recurring reasoning trap behind the miss, as a short lower-case label that would fit other topics too ("ruled out because afebrile", "anchored on age", "dismissed a normal vital sign"), or null. Only a real trap, not the topic.
   - lesson: true when the gap is a concept worth a short lesson (he confused a whole pair or a mechanism), false for a single fact.
   - say: what Claude should tell Mo first when he opens this question, two or three spoken sentences: what it tested, where his thinking went (a few of his words), and the clue and look-alike. Plain words, no lists, arrows or symbols, as if said aloud beside the open question.
7. certain: true when you are sure of your call for a wrong or right_flawed question; false when it rests on little of his speech, or its error type or step could fairly be another. ask: when certain is false, one short question for Mo, under 12 words, that settles it ("Misread the cycles, or didn't know von Willebrand?"); null otherwise. A sure call is logged for him; an unsure one waits for his answer.
8. cause, cause_quote, cause_inferred, cause_detail, for wrong and right_flawed only (null, empty, true and empty for the others), by the cause rules below.
9. concept, concept_discipline, concept_quote, for wrong and right_flawed by the concept rules below (empty whenever the miss is not conceptual); for sound, only a principle his words show he understands (the core rules); empty strings for the others.
10. The core fields for every question (confidence words, heard, other conditions he talks about mid-block, "it's not Graves because..."), by the core rules below.
Write in your own words. Never copy text from UWorld (you have none), and quote only Mo's own words.

${CAUSE_RULES}

${CONCEPT_RULES}

${CORE_RULES}`;

export const HISTORY_RULES = `

His history. Under "His history" you get his earlier misses on some of these topics, the wrong beliefs still open on them, and his active reasoning habits. Use them only to name things the way his map does:
- A miss on the same point as an earlier one is a repeat: start why with "Again" and say where ("again, as on NBME 10").
- trap: when one of his active habits fits, use its exact words.
- misconception: an open wrong belief that shows again is written in the same words.
History never decides right or wrong, the verdict or the error type: his words and UWorld do.`;

export const SEEN_RULES = `

UWorld's own review pages. For the questions marked "Its page", you also get the text of UWorld's review page: the question, the answer choices (with the share of users who picked each), his answer, the correct answer and the explanation. So for those you do see the question. Read it beside his words:
- The page shows what the question actually turned on, so judge his reasoning against it: sound only when the reason he gave is the deciding clue the explanation gives. Right with a different, missing or wrong reason is right_flawed (right_wrong_reason); right after ruling out an option for a reason the explanation contradicts is right_flawed (shaky_elimination).
- said_pick: the letter the page shows he chose, when his words and the page disagree.
- look_alike: a teaching contrast: for a wrong answer usually the condition or step behind the option he picked (never the letter); for a shaky one, the option he hedged towards. Picking it is not a confusion by itself: cause is confusion only when his words show he took one for the other or could not tell them apart.
- decision_point: the finding in the case that decides it, as the explanation shows; separator: what tells the right answer from his pick, and what you do differently.
- trap: how the question was built to catch him (the pull of the option he fell for), as a short label that would fit other topics.
- fell_for: one line on what pulled him to his pick and what he missed ("took the rash for a drug reaction and missed the recent travel"), for wrong and right_flawed; null otherwise or without a page.
- say: name the option he fell for by what it is and why it tempted, then the deciding clue.
Everything stays in your own words: never copy or closely paraphrase a sentence of the question, the choices or the explanation, and quote only Mo's own words.`;

const nul = schema => ({ anyOf: [schema, { type: 'null' }] });
const VERDICTS = ['sound', 'right_flawed', 'wrong', 'no_speech'];
export const FIVE_STEPS = ['recognise', 'distinguish', 'test', 'treat', 'trap'];
export const CONFIDENCES = ['sure', 'lean', 'guess'];
export const FLAWS = FLAW_KINDS.filter(k => k !== 'none');
export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    questions: { type: 'array', items: { type: 'object', properties: {
      q: { type: 'integer' }, start: nul({ type: 'string' }), start_quote: nul({ type: 'string' }), verdict: { type: 'string', enum: VERDICTS },
      flaw_kind: nul({ type: 'string', enum: FLAWS }), error_type: nul({ type: 'string', enum: ERROR_TYPES }), why: { type: 'string' }, quote: nul({ type: 'string' }),
      said_pick: nul({ type: 'string' }), first_pick: nul({ type: 'string' }),
      certain: { type: 'boolean' }, ask: nul({ type: 'string' }),
      ...CORE_SCHEMA_PROPS,
      teach: nul({ type: 'object', properties: {
        rule: { type: 'string' }, decision_point: { type: 'string' }, look_alike: { type: 'string' }, separator: { type: 'string' },
        condition: { type: 'string' }, misconception: nul({ type: 'string' }), trap: nul({ type: 'string' }), fell_for: nul({ type: 'string' }), lesson: { type: 'boolean' }, say: { type: 'string' },
      }, required: ['rule', 'decision_point', 'look_alike', 'separator', 'condition', 'misconception', 'trap', 'fell_for', 'lesson', 'say'], additionalProperties: false }),
    }, required: ['q', 'start', 'start_quote', 'verdict', 'flaw_kind', 'error_type', 'why', 'quote', 'said_pick', 'first_pick', 'certain', 'ask',
      ...CORE_FIELDS, 'teach'], additionalProperties: false } },
  },
  required: ['questions'],
  additionalProperties: false,
};

const mss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const cut = (v, n) => { const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; return s ? (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s) : null; };
const parse = (t, d) => { try { return t ? JSON.parse(t) : d; } catch { return d; } };
const resulted = qs => qs.filter(q => q && Number.isInteger(q.q) && ['right', 'wrong', 'omitted'].includes(q.result));

export function reviewMessage(block, questions, segments, manual, objectives, pages = new Map(), others = [], history = []) {
  const head = `UWorld block, ${block.day} (${block.mode}${block.minutes ? `, ${block.minutes} min recorded` : ''}), ${questions.length} question${questions.length === 1 ? '' : 's'} to judge${
    others.length ? `: ${questions.map(q => `Q${q.q}`).join(', ')} only` : ''}.`;
  // The rest of the block, one short line each, so a call judging part of it can still tell where each question starts.
  const context = others.length ? ['', 'The other questions in the block (not yours to judge; for finding where each starts):',
    ...others.map(q => `Q${q.q}: ${[q.uworld_id && `UW ${q.uworld_id}`, q.result, [q.system, q.topic].filter(Boolean).join(' / ') || null,
      q.start_ms != null && `his words start near ${mss(Math.round(q.start_ms / 1000))}`].filter(Boolean).join(' · ')}`)] : [];
  const rows = questions.map(q => {
    const bits = [q.uworld_id && `UW ${q.uworld_id}`, q.result, q.picked && `picked ${q.picked}`, q.answer && `answer ${q.answer}`,
      [q.subject, q.system, q.topic].filter(Boolean).join(' / ') || null,
      q.time_s ? `his time ${mss(q.time_s)}${q.others_time_s ? ` (others ${mss(q.others_time_s)})` : ''}` : null,
      q.others_pct != null && `${q.others_pct}% of others right`,
      q.start_ms != null && `his words start near ${mss(Math.round(q.start_ms / 1000))}`].filter(Boolean);
    const obj = q.uworld_id && objectives[q.uworld_id] ? `\n  Tested: ${objectives[q.uworld_id].text}` : '';
    const page = pages.get(q.q);
    return `Q${q.q}: ${bits.join(' · ')}${obj}${page ? `\n  Its page (UWorld's text, to read, never to copy):\n  <<<\n${page.text}\n  >>>` : ''}`;
  });
  const words = timeline(segments, manual);
  return [head, '', 'Questions:', ...rows, ...context, ...history, '', 'His words:', ...(words.length ? words : ['(nothing was heard in this block)'])].join('\n');
}

export function partTurn(block, part, segments, manual, objectives, pages, others, history, note = '') {
  const words = timeline(segments, manual);
  const stable = [`UWorld block, ${block.day} (${block.mode}${block.minutes ? `, ${block.minutes} min recorded` : ''}). His words for the whole block come first; the questions this call judges follow.`,
    '', 'His words:', ...(words.length ? words : ['(nothing was heard in this block)'])].join('\n') + note;
  const full = reviewMessage(block, part, [], [], objectives, pages, others, history);
  const volatile = full.slice(0, full.lastIndexOf('\nHis words:')).trimEnd();
  return cachedTurn(stable, volatile);
}

export function tidyReview(data, questions) {
  const got = new Map((data && Array.isArray(data.questions) ? data.questions : []).filter(x => x && Number.isInteger(x.q)).map(x => [x.q, x]));
  return questions.map(q => {
    let x = got.get(q.q) || {};
    const wrong = q.result === 'wrong' || q.result === 'omitted';
    let verdict = wrong ? 'wrong' : VERDICTS.includes(x.verdict) ? x.verdict : 'no_speech';
    if (!wrong && verdict === 'wrong') verdict = 'right_flawed';
    const unsure = x.confidence === 'lean' || x.confidence === 'guess';
    if (verdict === 'sound' && unsure) verdict = 'right_flawed';
    const review = verdict === 'wrong' || verdict === 'right_flawed';
    const chk = review ? consideredNotConfused(x, { words: [x.quote, x.confidence_words].filter(Boolean).join(' '), mixed: [x.teach && x.teach.look_alike] }) : { item: x, changed: false };
    x = chk.item;
    const t = review && x.teach && typeof x.teach === 'object' ? x.teach : null;
    const teach = t ? { rule: cut(t.rule, 300), decision_point: cut(t.decision_point, 240), look_alike: cut(t.look_alike, 80), separator: cut(t.separator, 300),
      condition: cut(t.condition, 80), misconception: cut(t.misconception, 200), trap: trapOf(t.trap), fell_for: cut(t.fell_for, 240), lesson: t.lesson === true, say: cut(t.say, 600),
      certain: x.certain === true, ask: x.certain === true ? null : cut(x.ask, 120) } : null;
    const letter = v => (typeof v === 'string' && /^[A-Za-z]$/.test(v.trim()) ? v.trim().toUpperCase() : null);
    const pick = letter(x.said_pick), first = letter(x.first_pick);
    const core = tidyCore(x, { flagged: review, sound: verdict === 'sound', own: [t && t.condition, q.topic] });
    return { q: q.q, uworld_id: q.uworld_id || null, verdict, start_ms: startMs(x.start), start_quote: cut(x.start_quote, 80),
      error_type: review ? normError(x.error_type) || (unsure ? 'knowledge gap' : null) : null,   // borderline: knowledge gap
      flaw_kind: verdict === 'right_flawed' ? (FLAWS.includes(x.flaw_kind) ? x.flaw_kind : unsure ? 'lucky_guess' : null) : null,
      why: cut(x.why, 200), quote: cut(x.quote, 140), said_pick: pick, first_pick: first && pick && first !== pick ? first : null, teach,
      step: review && FIVE_STEPS.includes(x.step) ? x.step : null, confidence: verdict !== 'no_speech' && CONFIDENCES.includes(x.confidence) ? x.confidence : null,
      ...(review ? tidyCause(x) : tidyCause(null)), ...(chk.changed ? { cause_considered: chk.why } : {}),
      confidence_words: verdict !== 'no_speech' ? core.confidence_words : null, confidence_inferred: verdict !== 'no_speech' ? core.confidence_inferred : null,
      heard: verdict === 'no_speech' && !core.heard ? 'not_said' : core.heard, other_conditions: core.other_conditions, form_version: FORM_VERSIONS.uworld_judge,
      ...conceptOf(core) };
  });
}

// The concept fields only when the judge named one (most answers have none).
const conceptOf = k => (k && k.concept ? { concept: k.concept, concept_discipline: k.concept_discipline, concept_quote: k.concept_quote, concept_polarity: k.concept_polarity } : {});

// A reasoning trap as the Anki log keeps it (patterns): one short lower-case label, under 60 characters.
const trapOf = v => { const s = cut(v, 59); return s ? s.toLowerCase().replace(/[.,;:]+$/, '') : null; };

export const pileOfVerdict = v => (v === 'wrong' ? 'wrong' : v === 'right_flawed' ? 'shaky' : v === 'sound' ? 'sound' : 'silent');
export const ON_LIST = ['wrong', 'shaky'];
const pileOf = (q, v) => (q.result === 'wrong' || q.result === 'omitted' ? 'wrong' : pileOfVerdict(q.verdict || v.verdict));

// ---------------------------------------------------------------- the job
export function withMarks(block) {
  const by = new Map(parse(block && block.questions_json, []).filter(q => q && Number.isInteger(q.q)).map(q => [q.q, { ...q }]));
  const marks = parse(block && block.results_json, {});
  for (const [k, m] of Object.entries(marks && typeof marks === 'object' ? marks : {})) {
    const n = Number(k);
    if (!Number.isInteger(n) || n < 1 || n > 60 || !m || typeof m !== 'object') continue;
    const q = by.get(n) || { q: n };
    if (q.result == null && typeof m.right === 'boolean') q.result = m.right ? 'right' : 'wrong';
    const L = v => (typeof v === 'string' && /^[A-Z]$/.test(v) ? v : null);
    if (!q.picked && L(m.picked)) q.picked = m.picked;
    if (!q.answer && L(m.answer)) q.answer = m.answer;
    if (!q.uworld_id && typeof m.id === 'string' && /^[\w-]{1,12}$/.test(m.id)) q.uworld_id = m.id;
    by.set(n, q);
  }
  return [...by.values()].sort((x, y) => x.q - y.q);
}

/** Is the block ready to judge now? {ready, why}. */
export function readiness(block, t = now()) {
  if (!block || block.day < JUDGE_FROM) return { ready: false, why: 'before' };
  const qs = resulted(withMarks(block));
  if (!qs.length) return { ready: false, why: 'no_results' };
  const quiet = t - (block.updated_at || 0);
  // Marks only: the results screenshot usually follows the block, so the judge waits a day for it.
  if (!resulted(parse(block.questions_json, [])).length) return quiet < MARKS_WAIT_MS ? { ready: false, why: 'no_results' } : { ready: true, why: null, marks: true };
  if (Number(block.pages_n) > 0) return { ready: true, why: null };
  if (quiet < SETTLE_MS) return { ready: false, why: 'settling' };
  if (block.count && qs.length < block.count && quiet < WAIT_ALL_MS) return { ready: false, why: 'waiting_rows' };
  return { ready: true, why: null };
}

const wordCount = segs => segs.reduce((n, s) => n + (String(s.text || '').trim() ? String(s.text).trim().split(/\s+/).length : 0), 0);
export function windowWords(segments, questions) {
  const { groups } = splitByStarts(segments, questions.filter(q => q && q.start_ms != null));
  return new Map(questions.map(q => [q.q, groups.has(q.q) ? wordCount(groups.get(q.q)) : 0]));
}

export function regrown(segments, questions, rows) {
  const nowWords = windowWords(segments, questions);
  const order = [...questions].sort((a, b) => a.q - b.q);
  const redo = new Set();
  for (const r of rows) {
    if (r.words == null || (nowWords.get(r.q) || 0) - r.words <= REJUDGE_WORDS) continue;
    redo.add(r.q);
    for (const x of order.filter(x => x.q > r.q)) { if (x.start_ms != null) break; redo.add(x.q); }
  }
  return [...redo].filter(q => rows.some(r => r.q === q));
}

// The judged rows' word counts, with a baseline filled in for rows judged before counts were kept (never re-judged
// for words they already had). Returns the questions to judge again.
async function regrownFor(env, block) {
  const rows = await all(env, 'SELECT q, words FROM uworld_reviews WHERE block_id = ?', block.id);
  if (!rows.length) return [];
  const segs = parse(block.segments_json, []), qs = withMarks(block);
  const missing = rows.filter(r => r.words == null);
  if (missing.length) {
    const w = windowWords(segs, qs);
    await env.DB.batch(missing.map(r => env.DB.prepare('UPDATE uworld_reviews SET words = ? WHERE block_id = ? AND q = ? AND words IS NULL').bind(w.get(r.q) || 0, block.id, r.q)));
    for (const r of missing) r.words = w.get(r.q) || 0;
  }
  return regrown(segs, qs, rows);
}

/** Claim a block for judging in one statement: true when this run owns it (never two at once, never one twice). */
async function claim(env, blockId, t) {
  const r = await run(env, `INSERT INTO uworld_judging (block_id, status, attempts, started_at, updated_at) VALUES (?1, 'running', 0, ?2, ?2)
    ON CONFLICT (user_id, block_id) DO UPDATE SET status = 'running', started_at = ?2, updated_at = ?2,
      attempts = uworld_judging.attempts + (uworld_judging.status = 'running')
    WHERE (uworld_judging.status IN ('pending', 'failed', 'capped', 'done') AND uworld_judging.next_at <= ?2 AND uworld_judging.attempts < ?3)
       OR (uworld_judging.status = 'running' AND uworld_judging.updated_at < ?4 AND uworld_judging.attempts + 1 < ?3)`, blockId, t, MAX_ATTEMPTS, t - STALE_MS);
  return !!(r.meta && r.meta.changes);
}

export function refineStarts(verdicts, segments) {
  return verdicts.map(({ start_quote, ...v }) => {
    const ms = start_quote ? quoteStart(segments, start_quote, v.start_ms) : null;
    return ms != null ? { ...v, start_ms: ms } : v;
  });
}

/**
 * Judge one block's questions not judged yet, and those whose words grew since (one Claude call), save the verdicts on
 * the block (the map moves) and the review rows, then build the packs. Returns {judged, review, usd} or {skipped}.
 * Throws only for the caller's log.
 */
export async function judgeBlock(env, blockId, ctx = null, t = now()) {
  const block = await first(env, 'SELECT * FROM uworld_blocks WHERE id = ?', blockId);
  if (!block) return { skipped: 'no block' };
  const job = await first(env, 'SELECT judged_json, verdicts_json, seen_json FROM uworld_judging WHERE block_id = ?', blockId)
    .catch(e => { if (!/no such column/i.test(String(e && e.message))) throw e; return first(env, 'SELECT judged_json, verdicts_json FROM uworld_judging WHERE block_id = ?', blockId); });
  const judgedBefore = new Set(parse(job && job.judged_json, []));
  // Claude's answer kept from a run that failed after the call: saved again without paying for a second call.
  const kept = parse(job && job.verdicts_json, null);
  const pages = await pagesFor(env, blockId, t);
  const seenBefore = new Set(parse(job && job.seen_json, []));
  const wordsRedo = new Set(judgedBefore.size ? await regrownFor(env, block) : []);
  const pagesRedo = new Set([...pages.keys()].filter(q => judgedBefore.has(q) && !seenBefore.has(q)));
  const redo = new Set([...wordsRedo, ...pagesRedo]);
  const todo = resulted(withMarks(block)).filter(q => !judgedBefore.has(q.q) || redo.has(q.q)).sort((a, b) => a.q - b.q);
  if (!todo.length) {
    await run(env, `UPDATE uworld_judging SET status = 'done', updated_at = ? WHERE block_id = ?`, t, blockId);
    return { skipped: 'nothing new' };
  }
  const segments = parse(block.segments_json, []);
  const reuse = Array.isArray(kept) && todo.every(q => kept.some(v => v.q === q.q));
  if (!reuse && (Number(await getSetting(env, spentKey())) || 0) >= REVIEW_DAILY_USD) {
    await run(env, `UPDATE uworld_judging SET status = 'capped', error = ?, next_at = ?, updated_at = ? WHERE block_id = ?`,
      `The UWorld review's daily limit ($${REVIEW_DAILY_USD}) is reached.`, t + CAPPED_WAIT_MS, t, blockId);
    await noteJudge(env, block, 'held', { limit: REVIEW_DAILY_USD });
    return { skipped: 'daily limit' };
  }
  let data, usd = 0, spelled = null, audited = null;
  if (reuse) data = { questions: [] };
  else try {
    const objectives = await objectivesFor(env, MO, todo.map(q => q.uworld_id).filter(Boolean)).catch(() => ({}));
    const seen = todo.some(q => pages.has(q.q));
    if (!todo.every(q => pages.has(q.q))) {
      spelled = await correctLines(env, segments.map(s => ({ ...s, text: String(s.text || '') })));
      if (spelled.usd > 0) await addSpent(env, spelled.usd);
    }
    const words = spelled ? spelled.lines.map(({ fixes, ...s }) => s) : segments;
    const manual = parse(block.manual_json, []);
    const note = spelled ? fixesNote(spelled.fixes) : '';
    // A paged block in parts of SEEN_CHUNK, side by side; a blind one in one call, as before.
    const parts = [];
    if (seen) for (let i = 0; i < todo.length; i += SEEN_CHUNK) parts.push(todo.slice(i, i + SEEN_CHUNK));
    else parts.push(todo);
    const whole = resulted(withMarks(block));
    const history = await historyFor(env, todo, { before: block.created_at || t }).catch(e => { console.error('uworld history', e && e.message); return null; });
    const hasHistory = !!(history && (history.byQ.size || history.habits.length));
    const release = await reserveSpend(env, RESERVE_USD, await spendCap(env));
    try {
      const names = await nearNames(env, MO, whole.flatMap(q => [q.topic, q.condition])).catch(() => []);
      const system = withNames([REVIEW_SYSTEM, ...(seen ? [SEEN_RULES.trimStart()] : []), ...(hasHistory ? [HISTORY_RULES.trimStart()] : [])].join('\n\n'), names);
      const others = part => (parts.length > 1 ? whole.filter(q => !part.some(x => x.q === q.q)) : []);
      const turn = part => (parts.length > 1
        ? partTurn(block, part, words, manual, objectives, pages, others(part), hasHistory ? historyLines(history, part) : [], note)
        : reviewMessage(block, part, words, manual, objectives, pages, [], hasHistory ? historyLines(history, part) : []) + note);
      const ask = (part, extra = null) => callJson(env, { role: 'reviewer', system, schema: REVIEW_SCHEMA, effort: 'high', maxTokens: seen ? 32000 : 48000,
        messages: [{ role: 'user', content: extra ? [...(Array.isArray(turn(part)) ? turn(part) : [{ type: 'text', text: turn(part) }]), { type: 'text', text: extra }] : turn(part) }] });
      const settled = await Promise.allSettled(parts.map(part => ask(part)));
      usd = settled.reduce((n, r) => n + (Number(r.status === 'fulfilled' ? r.value.usd : r.reason && r.reason.usd) || 0), 0);   // a call Claude answered still cost money
      const bad = settled.find(r => r.status === 'rejected' && !isPending(r.reason)) || settled.find(r => r.status === 'rejected');
      if (bad) throw bad.reason;
      data = { questions: settled.flatMap(r => (r.value.data && Array.isArray(r.value.data.questions) ? r.value.data.questions : [])) };
      const source = [segments.map(x => x.text).join(' '), words.map(x => x.text).join(' ')];
      const check = v => checkItem(v, { id: v.q, ...AUDIT_SPECS.uworld_judge(v), source });
      audited = await auditAndReask(tidyReview(data, todo), { idOf: v => v.q, check, reask: async rows => {
        const ids = new Set(rows.map(r => Number(r.id)));
        const again = await Promise.all(parts.filter(part => part.some(q => ids.has(q.q))).map(async part => {
          const failing = rows.filter(r => part.some(q => q.q === Number(r.id)));
          const r = await ask(part, reaskText(failing, id => `Q${id}`));
          usd += Number(r.usd) || 0;
          // Only the questions the answer gave: one it left out keeps its first answer.
          const gave = new Set((r.data && Array.isArray(r.data.questions) ? r.data.questions : []).map(x => x && x.q));
          return tidyReview(r.data, part.filter(q => ids.has(q.q) && gave.has(q.q)));
        }));
        return again.flat();
      } });
    } finally {
      await release(0); // the call added its real cost to the usage table
      if (usd > 0) await addSpent(env, usd);
    }
  } catch (e) {
    // Waiting for its Message Batch (claude.js): no try used; the minute cron runs it again and the answer is there.
    if (isPending(e)) {
      await run(env, `UPDATE uworld_judging SET status = 'pending', error = ?, next_at = ?, usd = usd + ?, updated_at = ? WHERE block_id = ?`,
        e.message, t + 60_000, usd, t, blockId);
      await noteJudge(env, block, 'held', { batch: 1 });
      return { waiting: 'batch', usd };
    }
    const capped = e instanceof HttpError && e.status === 429;
    await run(env, `UPDATE uworld_judging SET status = ?, attempts = attempts + ?, error = ?, next_at = ?, usd = usd + ?, updated_at = ? WHERE block_id = ?`,
      capped ? 'capped' : 'failed', capped ? 0 : 1, String(e && e.message || e).slice(0, 300), t + (capped ? CAPPED_WAIT_MS : 5 * 60_000), usd, t, blockId);
    await noteJudge(env, block, capped ? 'held' : 'failed', { tries: await triesOf(env, blockId) }, e);
    throw e;
  }
  const check = !reuse && audited ? await recordAudit(env, { job: 'uworld_judge', key: blockId, ref: block.day, rows: audited.rows, reasked: audited.reasked, at: t }) : null;
  const prepared = reuse ? { verdicts: kept.filter(v => todo.some(q => q.q === v.q)), leaked: 0 }
    : await prepareVerdicts(env, block, todo, audited ? audited.items : tidyReview(data, todo), { pages });
  const { verdicts, leaked } = prepared;
  if (!reuse) await run(env, 'UPDATE uworld_judging SET verdicts_json = ?, usd = usd + ?, updated_at = ? WHERE block_id = ?', JSON.stringify(verdicts), usd, t, blockId);
  try {
    await saveVerdicts(env, block, todo, verdicts, ctx, redo);
  } catch (e) {
    await run(env, `UPDATE uworld_judging SET status = 'failed', attempts = attempts + 1, error = ?, next_at = ?, updated_at = ? WHERE block_id = ?`,
      `Saving the verdicts failed: ${String(e && e.message || e).slice(0, 250)}`, t + 5 * 60_000, t, blockId);
    await noteJudge(env, block, 'failed', { tries: await triesOf(env, blockId) }, `Saving the verdicts failed: ${detailOf(e)}`);
    throw e;
  }
  const packs = await finishJudged(env, block, verdicts, { judgedBefore, seenBefore, pages, ctx, t });
  const fallback = (await judgeMode(env)) === 'chat' && todo.some(q => !judgedBefore.has(q.q)) ? { fallback: 1 } : {};
  await noteJudge(env, block, wordsRedo.size && !verdicts.some(v => v.seen) ? 'again' : 'ok', { ...judgeCounts(verdicts, redo, spelled, reuse), seen: verdicts.filter(v => v.seen).length, leaked, ...auditCounts(check), ...fallback });
  return { judged: verdicts.length, rejudged: verdicts.filter(v => redo.has(v.q)).map(v => v.q), review: verdicts.filter(v => ON_LIST.includes(pileOfVerdict(v.verdict))).map(v => v.q), usd, packs };
}

export async function prepareVerdicts(env, block, todo, items, { pages = new Map(), seen = false } = {}) {
  let leaked = 0;
  const verdicts = refineStarts(items, parse(block.segments_json, [])).map(v => {
    const page = pages.get(v.q);
    if (!page) return seen ? { ...v, seen: true, ...(v.teach ? { teach: { ...v.teach, seen: true } } : {}) } : v;
    const u = unleak(v, page.text);
    leaked += u.dropped;
    return { ...u.verdict, seen: true, ...(u.verdict.teach ? { teach: { ...u.verdict.teach, seen: true } } : {}) };
  });
  for (const v of verdicts) if (v.other_conditions && v.other_conditions.length) {
    const q = todo.find(x => x.q === v.q) || {};
    v.other_conditions = await nameOthers(env, MO, v.other_conditions, { own: [v.teach && v.teach.condition, q.topic] });
  }
  return { verdicts, leaked };
}

/**
 * After the verdicts are saved (both judges): the block's judged list, the questions judged with their page, the pages
 * dropped, the block's misses queued for the pattern review, and the packs built (background: a request that can leave
 * them to the minute job does). Returns the packs built, or null when they were left to the minute job.
 */
export async function finishJudged(env, block, verdicts, { judgedBefore = new Set(), seenBefore = new Set(), pages = new Map(), ctx = null, t = now(), background = false } = {}) {
  const blockId = block.id;
  const judged = [...new Set([...judgedBefore, ...verdicts.map(v => v.q)])].sort((a, b) => a - b);
  await run(env, `UPDATE uworld_judging SET status = 'packing', judged_json = ?, verdicts_json = NULL, error = NULL, attempts = 0, updated_at = ? WHERE block_id = ?`,
    JSON.stringify(judged), t, blockId);
  const seenNow = [...new Set([...seenBefore, ...verdicts.filter(v => v.seen).map(v => v.q)])].sort((a, b) => a - b);
  if (pages.size || verdicts.some(v => v.seen)) await run(env, 'UPDATE uworld_judging SET seen_json = ? WHERE block_id = ?', JSON.stringify(seenNow), blockId).catch(e => console.error('seen_json', e && e.message));
  if (pages.size) await dropPages(env, blockId);
  if (verdicts.some(v => ON_LIST.includes(pileOfVerdict(v.verdict)))) await enqueuePattern(env, MO, 'uworld', blockId, { now: t });
  // The chat's submit answers at once: its packs (Anki lookups, the clear misses logged) are left to the minute job, which
  // builds a 'packing' block's packs first thing, so two runs never build the same pack side by side.
  if (background && ctx && typeof ctx.waitUntil === 'function') return null;
  return buildPacks(env, blockId, ctx, t);
}

export { BLOCK_JUDGES };
/** With the chat judging, the hub judges what is still unjudged this long after the block's recording ended. */
export const CHAT_WAIT_MS = 2 * 3600_000;
export async function judgeMode(env) {
  const v = await getSetting(env, 'block_judge').catch(() => null);
  return BLOCK_JUDGES.includes(v) ? v : 'chat';
}
/** When the chat's two hours are up for a block: its recording ended when the recorder first saved it. */
export const chatDeadline = block => (Number(block && (block.created_at || block.updated_at)) || 0) + CHAT_WAIT_MS;

export function judgeCounts(verdicts, redo, spelled, reuse) {
  const n = f => verdicts.filter(f).length;
  return { questions: verdicts.length, rejudged: n(v => redo.has(v.q)), review: n(v => ON_LIST.includes(pileOfVerdict(v.verdict))), steps: n(v => v.step),
    sure: n(v => v.confidence === 'sure'), lean: n(v => v.confidence === 'lean'), guess: n(v => v.confidence === 'guess'), pairs: n(v => v.teach && v.teach.look_alike),
    fixes: spelled ? spelled.fixes.length : 0, spell: reuse || !spelled ? 'none' : spelled.skipped || 'done',
    unclear: n(v => v.heard === 'unclear'), others: verdicts.reduce((t, v) => t + (Array.isArray(v.other_conditions) ? v.other_conditions.length : 0), 0) };
}
export const noteJudge = (env, block, state, counts, err = null) => noteJob(env, { job: 'uworld_judge', key: `${block.id}:${state}`, ref: block.id,
  state: state === 'again' ? 'ok' : state, counts: { ...counts, day: block.day || null, count: Number(block.count) || 0, again: state === 'again', max: MAX_ATTEMPTS }, detail: detailOf(err) });
const triesOf = (env, blockId) => first(env, 'SELECT attempts FROM uworld_judging WHERE block_id = ?', blockId).then(r => Number(r && r.attempts) || 0, () => 0);

async function addSpent(env, usd) {
  await run(env, `INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(settings.value AS REAL) + ?2 AS TEXT)`, spentKey(), String(usd));
}

// The verdicts onto the block (only what is still empty: a check Claude in Chrome saved stays), the review rows, and
// any wrong belief as a misconception. mergeQuestions puts the answers on the map in the same step. A question judged
// again (redo: its words grew) takes the judge's new fields where the block still holds what the judge wrote before,
// and its review row is rewritten (its pack built again; reviewed and logged kept).
export async function saveVerdicts(env, block, todo, verdicts, ctx, redo = new Set()) {
  const saved = new Map(todo.map(q => [q.q, q]));
  const stored = new Map(parse(block.questions_json, []).map(q => [q.q, q]));
  const before = redo.size ? new Map((await all(env, 'SELECT q, verdict, error_type, why FROM uworld_reviews WHERE block_id = ?', block.id)).map(r => [r.q, r])) : new Map();
  const entries = verdicts.map(v => {
    const q = saved.get(v.q) || {}, st = stored.get(v.q) || {};
    const again = redo.has(v.q), was = before.get(v.q) || {};
    // Empty, or (judged again) still the judge's own last word, so a check Claude in Chrome saved is never replaced.
    const open = (cur, prev) => cur == null || cur === '' || (again && prev != null && cur === prev);
    const mine = k => !q[k] || again; // fields only the judge writes
    const e = { q: v.q };
    for (const k of ['result', 'answer', 'uworld_id']) if (st[k] == null && q[k] != null) e[k] = q[k];
    if (open(q.verdict, was.verdict === 'no_speech' ? null : was.verdict)) e.verdict = v.verdict === 'no_speech' ? null : v.verdict;
    if (open(q.error_type, was.error_type) && v.error_type) e.error_type = v.error_type;
    if (open(q.note, was.why ? cut(was.why, 299) : null) && v.why) e.note = cut(v.why, 299);
    if (q.start_ms == null && v.start_ms != null) e.start_ms = v.start_ms;
    if (!st.picked && (q.picked || v.said_pick)) e.picked = q.picked || v.said_pick;
    if (mine('step') && v.step) e.step = v.step;
    if (mine('confidence') && v.confidence) e.confidence = v.confidence;
    if (mine('flaw_kind') && v.flaw_kind) e.flaw_kind = v.flaw_kind;
    if (mine('first_pick') && v.first_pick) e.first_pick = v.first_pick;
    if (mine('heard') && v.heard) e.heard = v.heard;
    if (v.form_version) e.form_version = v.form_version;
    if (v.teach && mine('rule') && v.teach.rule) e.rule = v.teach.rule;
    if (v.teach && mine('look_alike') && v.teach.look_alike) e.look_alike = cut(`${v.teach.look_alike}${v.teach.separator ? `: ${v.teach.separator}` : ''}`, 299);
    if (v.teach && mine('condition') && v.teach.condition) e.condition = v.teach.condition;
    if (v.cause && mine('cause')) Object.assign(e, { cause: v.cause, cause_quote: v.cause_quote, cause_inferred: v.cause_inferred, cause_detail: v.cause_detail });
    return e;
  }).filter(e => Object.keys(e).some(k => k !== 'q' && e[k] != null));
  const all2 = entries.length ? await mergeQuestions(env, block.id, entries, ctx) : [...stored.values()];
  // The foundation concept under each miss (concepts.js): a pending tag the hourly run places on its concept topic.
  // A sound answer whose words showed the concept understood is a right tag (polarity right): a light Good there.
  await noteConcepts(env, MO, verdicts.filter(v => v.concept).map(v => {
    const q = saved.get(v.q) || {};
    return { id: `uwb:${block.id}:${v.q}`, source: 'uworld_judge', uworld_block_id: block.id, uworld_q: v.q, concept: v.concept, concept_discipline: v.concept_discipline,
      concept_quote: v.concept_quote, cause: v.cause, confidence: v.confidence, clinical_name: (v.teach && v.teach.condition) || q.condition || q.topic || null,
      ref: q.uworld_id ? `UW ${q.uworld_id}` : null, polarity: v.concept_polarity || 'miss', heard: v.heard, at: uworldAt(block, v) };
  }));
  await saveOtherConditions(env, block, saved, verdicts).catch(e => console.error('uworld other conditions', e && e.message));
  // Each question's word count as judged, so audio recovered later can be told from what was there (regrown).
  const counts = windowWords(parse(block.segments_json, []), withMarks({ ...block, questions_json: JSON.stringify(all2) }));
  const after = new Map(all2.map(q => [q.q, q]));
  const t = now();
  await env.DB.batch(verdicts.map(v => env.DB.prepare(`INSERT INTO uworld_reviews (block_id, q, uworld_id, pile, verdict, error_type, why, quote, teach_json, words, created_at, updated_at, heard, form_version)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?13, ?14) ON CONFLICT (user_id, block_id, q) DO UPDATE SET uworld_id = COALESCE(excluded.uworld_id, uworld_reviews.uworld_id),
      pile = excluded.pile, verdict = excluded.verdict, error_type = excluded.error_type, why = excluded.why, quote = excluded.quote, teach_json = excluded.teach_json,
      words = excluded.words, heard = excluded.heard, form_version = excluded.form_version, pack_json = NULL, pack_tries = 0, updated_at = excluded.updated_at WHERE ?12 = 1`)
    .bind(block.id, v.q, v.uworld_id || (after.get(v.q) || {}).uworld_id || null, pileOf(after.get(v.q) || saved.get(v.q) || {}, v), v.verdict, v.error_type, v.why, v.quote,
      v.teach ? JSON.stringify(v.teach) : null, counts.get(v.q) || 0, t, redo.has(v.q) ? 1 : 0, v.heard || null, v.form_version || null)));
  for (const v of verdicts.filter(x => x.teach && x.teach.misconception)) {
    const q = saved.get(v.q) || {};
    await misconceptionSave(env, MO, { topic: v.teach.condition || q.topic, belief: v.teach.misconception, ref: q.uworld_id ? `UW ${q.uworld_id}` : `UW ${block.day} Q${v.q}` },
      { actor: 'code', surface: 'code', via: 'cron:uworld_review' })
      .then(r => { if (r && (r.refused || r.problems)) console.error('uworld misconception refused', v.q, r.reason || JSON.stringify(r.problems)); })
      .catch(e => console.error('uworld misconception failed', e && e.message));
  }
}

const uworldAt = (block, v) => uworldQuestionAt(block, { q: v.q, start_ms: v.start_ms });
const otherLo = (blockId, q) => `uwq:${blockId}:${q}:`;

async function saveOtherConditions(env, block, saved, verdicts) {
  const [map, signals, forms] = await Promise.all([hasMapCols(env), hasSignalCols(env), hasFormCols(env)]);
  if (!map) return { gaps: 0, beliefs: 0 };
  // One read for the block's earlier ones: those of a question judged now that it no longer names go, observations too.
  const lo = `uwq:${block.id}:`, judged = new Set(verdicts.map(v => v.q));
  const before = (await all(env, 'SELECT id FROM gaps WHERE id >= ? AND id < ?', lo, `uwq:${block.id};`)).map(r => r.id)
    .filter(id => judged.has(Number(id.slice(lo.length).split(':')[0])));
  const rows = [], stmts = [];
  for (const v of verdicts.filter(x => Array.isArray(x.other_conditions) && x.other_conditions.length)) {
    const q = saved.get(v.q) || {};
    const at = uworldAt(block, v);
    const ref = `UW block ${block.day} Q${v.q} @${mss(Math.round((v.start_ms || 0) / 1000))}`.slice(0, 80);
    v.other_conditions.forEach((o, i) => {
      if (o.kind !== 'gap') return;
      const g = gapStatement(env, { source: 'spoken_cue', gap: `Unsure about ${o.topic}, shown while answering a question on ${(v.teach && v.teach.condition) || q.topic || 'another topic'}.`.slice(0, 200),
        said: o.quote, topic: o.topic, ref, verdict: 'shaky', ...(forms ? { heard: v.heard || null, form_version: FORM_VERSIONS.uworld_judge } : {}) },
        { id: `${otherLo(block.id, v.q)}${i + 1}`, at, map, signals, forms });
      stmts.push(g.statement);
      rows.push(g.row);
    });
  }
  const stale = before.filter(id => !rows.some(r => r.id === id));
  if (stale.length) stmts.unshift(env.DB.prepare('DELETE FROM gaps WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(stale)));
  if (stmts.length) await env.DB.batch(stmts);
  if (stale.length) {
    const ev = await all(env, 'SELECT DISTINCT obs_key, topic_id FROM evidence WHERE user_id = ? AND gap_id IN (SELECT value FROM json_each(?))', MO, JSON.stringify(stale));
    if (ev.length) await (await import('./map/ingest/hub.js')).commit(env, MO, { via: 'hook:uworld review', evidence: { remove: ev.map(r => r.obs_key) }, recompute: ev.map(r => r.topic_id).filter(Boolean) });
  }
  if (rows.length) await mapGaps(env, rows);
  let beliefs = 0;
  for (const v of verdicts.filter(x => Array.isArray(x.other_conditions))) {
    const q = saved.get(v.q) || {};
    for (const o of v.other_conditions.filter(x => x.kind === 'belief' && x.quote)) {
      const r = await misconceptionSave(env, MO, { topic: o.topic, belief: o.quote, ref: q.uworld_id ? `UW ${q.uworld_id}` : `UW ${block.day} Q${v.q}`, words: 'mo', source: 'voice' },
        { actor: 'code', surface: 'code', via: 'cron:uworld_review' }).catch(e => ({ refused: true, reason: e && e.message }));
      if (r && r.id) beliefs++;
    }
  }
  return { gaps: rows.length, beliefs };
}

/** The minute job: judge the next ready block (one a minute), and finish any packs left over. */
export async function sweepReviews(env, ctx = null, t = now()) {
  if (!env || !env.DB) return;
  await sweepPages(env, t);   // a page the judge never read goes after a day
  const rows = await all(env, `SELECT b.id, b.day, b.count, b.created_at, b.updated_at, b.questions_json, b.results_json, b.segments_json, j.status, j.judged_json, j.next_at, j.attempts, j.updated_at AS job_at,
      (SELECT count(*) FROM uworld_pages p WHERE p.block_id = b.id) AS pages_n
    FROM uworld_blocks b LEFT JOIN uworld_judging j ON j.block_id = b.id
    WHERE b.day >= ?1 AND (EXISTS (SELECT 1 FROM json_each(b.questions_json) WHERE json_extract(value, '$.result') IN ('right', 'wrong', 'omitted'))
        OR (b.updated_at <= ?4 AND EXISTS (SELECT 1 FROM json_each(b.results_json) WHERE json_extract(value, '$.right') IN (0, 1))))
      AND (j.block_id IS NULL OR j.status IN ('pending', 'packing', 'running')
      OR (j.status IN ('failed', 'capped') AND j.attempts < ?2 AND j.next_at <= ?3) OR (j.status = 'done' AND j.updated_at < b.updated_at))
    ORDER BY b.day DESC, b.created_at DESC LIMIT 10`, JUDGE_FROM, MAX_ATTEMPTS, t, t - MARKS_WAIT_MS);
  // A block that used its three tries gets three more the next day (a passing outage), never sooner.
  await run(env, `UPDATE uworld_judging SET attempts = 0, next_at = 0 WHERE status = 'failed' AND attempts >= ? AND updated_at < ?`, MAX_ATTEMPTS, t - 86_400_000);
  const mode = rows.length ? await judgeMode(env) : 'chat';
  for (const r of rows) {
    if (r.status === 'packing') { await buildPacks(env, r.id, ctx, t); continue; }
    if (r.status === 'running' && t - (r.job_at || 0) < STALE_MS) continue;
    if ((r.status === 'failed' || r.status === 'capped') && (r.next_at > t || r.attempts >= MAX_ATTEMPTS)) continue;
    if (r.status === 'running' && r.attempts + 1 >= MAX_ATTEMPTS) {
      await run(env, `UPDATE uworld_judging SET status = 'failed', attempts = ?, error = 'Stopped part way three times.', updated_at = ? WHERE block_id = ? AND status = 'running'`, MAX_ATTEMPTS, t, r.id);
      continue;
    }
    if (!readiness(r, t).ready) continue;
    if (mode === 'chat' && t < chatDeadline(r)) continue;
    const judged = new Set(parse(r.judged_json, []));
    if (r.status === 'done' && !resulted(withMarks(r)).some(q => !judged.has(q.q)) && !(await regrownFor(env, r)).length && !(await unseenPages(env, r.id, t)).length) {
      await run(env, 'UPDATE uworld_judging SET updated_at = ? WHERE block_id = ?', t, r.id);
      continue;
    }
    if (!(await claim(env, r.id, t))) continue;
    try {
      // A block waiting for its batch costs nothing more: the next block gets its turn this minute.
      if ((await judgeBlock(env, r.id, ctx, t)).waiting) continue;
    } catch (e) {
      console.error('uworld review failed', r.id, e && e.message);
      if (e instanceof HttpError && e.status === 429) break;
    }
    break; // one Claude call per minute is plenty, and keeps each run small
  }
}

// The block's questions with a review page the judge has not read yet.
async function unseenPages(env, blockId, t) {
  const pages = await pagesFor(env, blockId, t);
  if (!pages.size) return [];
  const j = await first(env, 'SELECT seen_json FROM uworld_judging WHERE block_id = ?', blockId).catch(() => null);
  const seen = new Set(parse(j && j.seen_json, []));
  return [...pages.keys()].filter(q => !seen.has(q));
}

// ---------------------------------------------------------------- packs
const words = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w.length > 3));
const overlap = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n; };
const pace = paceWord; // 'slow' over 120 s, 'over pace' over 90 s (weights.js PACE, the one definition)

async function topicOf(env, blockId, q) {
  const r = await first(env, `SELECT e.topic_id, t.name FROM evidence e LEFT JOIN topics t ON t.user_id = e.user_id AND t.id = e.topic_id
    WHERE e.user_id = ? AND e.source_ref = ? AND e.slot = 0 AND e.topic_id IS NOT NULL LIMIT 1`, MO, `uworld:${blockId}:q${q}`).catch(() => null);
  return r ? { id: r.topic_id, name: r.name } : null;
}

export async function anking(env, qid, teach, timeoutMs = 15_000) {
  if (!qid) return { status: 'no id', cards: [] };
  try {
    const r = await ankiCall(env, 'anking_cards', { uw_qid: String(qid) }, { timeoutMs });
    const key = words([teach && teach.rule, teach && teach.decision_point, teach && teach.condition].join(' '));
    const cards = (Array.isArray(r && r.cards) ? r.cards : []).map((c, i) => ({ c, i, s: overlap(words(c.fact), key) }))
      .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 3).map(({ c }) => ({ card_id: c.card_id, fact: cut(c.fact, 260), pictures: Array.isArray(c.pictures) ? c.pictures.length : 0 }));
    return { status: 'ok', found: Number(r && r.found) || cards.length, cards };
  } catch (e) {
    return { status: e instanceof AnkiError ? 'unreachable' : 'failed', cards: [] };
  }
}

const historyOf = (reads, label) => {
  if (!reads) return null;
  const tp = reads.topic || {};
  // Earlier misses on the topic, this question's own miss left out.
  const misses = (reads.misses || []).filter(m => m.label !== label).slice(0, 3)
    .map(m => ({ label: m.label, day: m.day, result: m.result, error_type: m.error_type || null, rule: cut(m.rule, 160) }));
  const last = (reads.past || [])[0];
  return {
    band: tp.band || null, seen: tp.seen ?? null,
    misses, gaps: (reads.gaps || []).slice(0, 3).map(g => ({ day: g.day, gap: cut(g.gap, 160), origin: g.origin })),
    misconceptions: (reads.misconceptions || []).slice(0, 3).map(m => ({ belief: cut(m.belief, 160), seen: m.seen_n || 1, status: m.status })),
    last_lesson: last ? { day: last.day, kind: last.kind || 'lesson', outcome: last.outcome || null, weak_spot: cut(last.weak_spot, 160) } : null,
  };
};

/** One question's pack, from its review row, the block's saved question and the lookups. */
export function packFor({ block, q, row, teach, objective, topic, mehlman, anki, reads }) {
  const cards = (reads && reads.cards || []).slice(0, 2).map(c => ({ card_id: c.card_id, front: cut(c.question, 140), schedule: c.schedule || null, lapses: c.lapses ?? null }));
  const passage = mehlman && mehlman.passages && mehlman.passages[0];
  const lesson = !!(teach && teach.lesson);
  return {
    q: q.q, uworld_id: q.uworld_id || null, block: block.id, day: block.day,
    // Two or three sentences the judge wrote to open the debrief with, so the reply can start at once.
    say: teach && teach.say || null,
    glance: { topic: q.topic || null, system: q.system || null, subject: q.subject || null, result: q.result, picked: q.picked || null, answer: q.answer || null,
      time_s: q.time_s ?? null, others_time_s: q.others_time_s ?? null, pace: pace(q.time_s), others_pct: q.others_pct ?? null },
    why_listed: { pile: row.pile, verdict: row.verdict, error_type: row.error_type || q.error_type || null, why: row.why || null, his_words: row.quote || null },
    tested: { objective: objective || null, rule: teach && teach.rule || null },
    decision_point: teach ? { clue: teach.decision_point, look_alike: teach.look_alike, separator: teach.separator, ...(teach.fell_for ? { fell_for: teach.fell_for } : {}) } : null,
    condition: teach && teach.condition || topic && topic.name || q.topic || null,
    trap: teach && teach.trap || null,
    map_topic: topic ? { id: topic.id, name: topic.name } : null,
    sources: {
      mehlman: passage ? { cite: `${passage.title}${passage.page ? `, p. ${passage.page}${passage.page_to && passage.page_to !== passage.page ? `-${passage.page_to}` : ''}` : ''}`, text: passage.text,
        match: mehlman.match || null } : null,
      mehlman_status: mehlman ? mehlman.status : 'not searched',
      anking: anki.cards, anking_status: anki.status,
      own_cards: cards, has_own_card: cards.length > 0,
      pictures: (mehlman && mehlman.pictures || []).map(p => ({ library: p.library, caption: p.caption })),
      card_picture: ((anki.cards || []).find(c => c.pictures > 0) || {}).card_id || null,
    },
    history: historyOf(reads, q.uworld_id ? `UW ${q.uworld_id}` : null),
    next: lesson ? 'Log it, and offer a short lesson (teach me) on it.' : 'Log it.',
  };
}

export function packSearch(teach, q, topic) {
  const name = (teach && teach.condition) || (topic && topic.name) || q.topic || '';
  return { name, aliases: [topic && topic.name, q.topic].filter(n => n && n !== name), newest_rule: (teach && teach.rule) || null,
    top_look_alike: (teach && teach.look_alike) || null };
}
export function pickMehlman(found, teach, q, topic) {
  const want = { names: teach && teach.condition ? [teach.condition] : [topic && topic.name, q.topic], look_alike: teach && teach.look_alike,
    rule: teach && teach.rule, clue: teach && teach.decision_point, separator: teach && teach.separator };
  const best = bestPassage(found.passages, want);
  return { ...found, passages: best ? [best] : [], pictures: bestPictures(found.pictures, want), ...(best ? {} : { status: found.status === 'unreachable' ? 'unreachable' : 'no match' }) };
}

export const AUTO_MIN_WORDS = 8;
export function autoLogClear(row, teach) {
  return ON_LIST.includes(row.pile) && !!teach && teach.seen === true && teach.certain === true
    && (row.error_type || 'knowledge gap') === 'knowledge gap' && (Number(row.words) || 0) >= AUTO_MIN_WORDS;
}
export function sayQuestion(row, teach) {
  if (teach && teach.ask) return teach.ask;
  if ((Number(row.words) || 0) < AUTO_MIN_WORDS) return 'You said little here: did you know it?';
  if (row.error_type && row.error_type !== 'knowledge gap') return `${row.error_type[0].toUpperCase()}${row.error_type.slice(1)}, or a missing fact?`;
  return 'Is the judge right that this was a knowledge gap?';
}
async function noteAutoLog(env, block) {
  const rows = await all(env, `SELECT pile, error_type, words, teach_json, log_json, logged_at FROM uworld_reviews WHERE block_id = ? AND pile IN ('wrong', 'shaky')`, block.id);
  const auto = rows.filter(r => parse(r.log_json, {}).auto === true).length;
  const waiting = rows.filter(r => !r.logged_at && (parse(r.teach_json, {}) || {}).seen === true).length;
  await noteJob(env, { job: 'uworld_log', key: block.id, ref: block.id, counts: { day: block.day || null, logged: auto, waiting } });
}

/** Build the packs still missing for a block (wrong and shaky only); the job is done when none is left to try. */
export async function buildPacks(env, blockId, ctx = null, t = now()) {
  const block = await first(env, 'SELECT id, day, mode, questions_json FROM uworld_blocks WHERE id = ?', blockId);
  if (!block) return 0;
  const rows = await all(env, `SELECT * FROM uworld_reviews WHERE block_id = ? AND pile IN ('wrong', 'shaky') AND pack_json IS NULL AND pack_tries < ? ORDER BY q`, blockId, PACK_TRIES);
  const qs = new Map(parse(block.questions_json, []).map(q => [q.q, q]));
  const objs = rows.length ? await objectivesFor(env, MO, rows.map(r => r.uworld_id).filter(Boolean)).catch(() => ({})) : {};
  const today = londonDay(t);
  let built = 0;
  const one = async row => {
    try {
      const q = qs.get(row.q) || { q: row.q };
      const teach = parse(row.teach_json, null);
      const topic = await topicOf(env, blockId, row.q);
      const [found, anki, reads] = await Promise.all([
        mehlmanFor(env, MO, packSearch(teach, q, topic), { timeoutMs: 8000, ctx, keep: 8 }).catch(() => null),
        anking(env, row.uworld_id, teach),
        topic ? briefReads(env, MO, { topicId: topic.id, now: t, today }).catch(() => null) : null,
      ]);
      const mehlman = found && pickMehlman(found, teach, q, topic);
      const pack = packFor({ block, q, row, teach, objective: row.uworld_id && objs[row.uworld_id] ? objs[row.uworld_id].text : null, topic, mehlman, anki, reads });
      // A lookup that could not reach the Anki server is tried again next minute (up to PACK_TRIES); the last try keeps what it has.
      const partial = anki.status === 'unreachable' || (mehlman && mehlman.status === 'unreachable');
      const keep = !partial || row.pack_tries + 1 >= PACK_TRIES;
      await run(env, `UPDATE uworld_reviews SET pack_json = ?, pack_tries = pack_tries + 1, topic_id = ?, updated_at = ? WHERE block_id = ? AND q = ?`,
        keep ? JSON.stringify(pack) : null, topic ? topic.id : null, t, blockId, row.q);
      if (keep) built++;
      if (keep && !row.logged_at && autoLogClear(row, teach)) {
        await logNow(env, block, row, pack, { auto: true }, ctx).then(() => { logged++; }, e => console.error('uworld auto-log failed', blockId, row.q, e && e.message));
      }
    } catch (e) {
      console.error('uworld pack failed', blockId, row.q, e && e.message);
      await run(env, 'UPDATE uworld_reviews SET pack_tries = pack_tries + 1, updated_at = ? WHERE block_id = ? AND q = ?', t, blockId, row.q);
    }
  };
  let logged = 0;
  for (let i = 0; i < rows.length; i += 4) await Promise.all(rows.slice(i, i + 4).map(one));
  if (logged) await noteAutoLog(env, block);
  const left = await first(env, `SELECT count(*) AS n FROM uworld_reviews WHERE block_id = ? AND pile IN ('wrong', 'shaky') AND pack_json IS NULL AND pack_tries < ?`, blockId, PACK_TRIES);
  // done_at keeps the first time it was judged: packs built again (0046, 0047) are not a new judging on Recent activity.
  if (!left || !left.n) await run(env, `UPDATE uworld_judging SET status = 'done', done_at = COALESCE(done_at, ?), updated_at = ? WHERE block_id = ? AND status = 'packing'`, t, t, blockId);
  return built;
}

// ---------------------------------------------------------------- the review state (connector and recorder page)
async function findBlock(env, { block, uworld_id }) {
  const cols = 'id, day, mode, count, questions_json, results_json, updated_at';
  if (block) return first(env, `SELECT ${cols} FROM uworld_blocks WHERE id = ?`, String(block));
  if (uworld_id) {
    const r = await first(env, `SELECT b.${cols.split(', ').join(', b.')} FROM uworld_reviews r JOIN uworld_blocks b ON b.id = r.block_id WHERE r.user_id = 'mo' AND r.uworld_id = ? ORDER BY b.day DESC, b.created_at DESC LIMIT 1`, String(uworld_id));
    if (r) return r;
    const recent = await all(env, `SELECT ${cols} FROM uworld_blocks WHERE day >= date('now', '-21 days') AND questions_json LIKE ? ORDER BY day DESC, created_at DESC LIMIT 5`, `%"${String(uworld_id)}"%`);
    const hit = recent.find(b => parse(b.questions_json, []).some(q => q.uworld_id === String(uworld_id)));
    if (hit) return hit;
  }
  return first(env, `SELECT ${cols} FROM uworld_blocks ORDER BY day DESC, created_at DESC LIMIT 1`);
}

const JUDGING_WORDS = { pending: 'waiting to be judged', running: 'being judged now', packing: 'judged, packs being built', done: 'judged',
  failed: 'judging failed, the hub tries again', capped: "waiting: today's spend limit is reached",
  gave_up: 'judging failed three times; the hub tries again tomorrow (Claude Code can look at why)',
  chat: 'waiting for Claude in the chat to judge it (say "send the block"); the hub judges what is left 2 hours after the block' };

/** The block's review state: status, the list (wrong first, then shaky, by number), what is done, what is left. */
export async function reviewState(env, block) {
  const [job, rows] = await Promise.all([
    first(env, 'SELECT status, error, judged_json, attempts FROM uworld_judging WHERE block_id = ?', block.id),
    all(env, 'SELECT q, uworld_id, pile, why, reviewed_at, logged_at, pack_json IS NOT NULL AS packed FROM uworld_reviews WHERE block_id = ? ORDER BY q', block.id),
  ]);
  const qs = new Map(parse(block.questions_json, []).map(q => [q.q, q]));
  const ready = readiness(block);
  const chat = !job && ready.why !== 'before' && (await judgeMode(env)) === 'chat';
  const status = job ? (job.status === 'failed' && job.attempts >= MAX_ATTEMPTS ? 'gave_up' : job.status) : chat ? 'chat' : ready.why === 'no_results' ? 'no_results' : ready.why === 'before' ? 'not_judged' : 'pending';
  const item = r => ({ q: r.q, uworld_id: r.uworld_id || null, pile: r.pile, topic: (qs.get(r.q) || {}).topic || null, why: r.why || null,
    reviewed: !!r.reviewed_at, logged: !!r.logged_at });
  const list = [...rows.filter(r => r.pile === 'wrong'), ...rows.filter(r => r.pile === 'shaky')].map(item);
  return {
    block: block.id, day: block.day, questions: qs.size, status, status_words: JUDGING_WORDS[status] || null,
    list, done: list.filter(x => x.reviewed).map(x => x.q), left: list.filter(x => !x.reviewed).map(x => x.q),
    sound: rows.filter(r => r.pile === 'sound').map(r => r.q), silent: rows.filter(r => r.pile === 'silent').map(r => r.q),
  };
}

const LEARN_ERRORS = new Set(['knowledge gap', 'faulty synthesis', 'threshold or number']);
export function reviewPlan(rows, questions) {
  const qs = new Map((questions || []).map(q => [q.q, q]));
  const learn = [], glance = [], skip = [], needsSay = [], autoLogged = [];
  for (const r of [...rows].sort((a, b) => a.q - b.q)) {
    const q = qs.get(r.q) || {};
    const teach = parse(r.teach_json, null) || {};
    const pack = parse(r.pack_json, null) || {};
    const repeat = ((pack.history && pack.history.misses) || []).length > 0;
    const item = { q: r.q, uworld_id: r.uworld_id || q.uworld_id || null, pile: r.pile, topic: q.topic || null };
    if (r.pile === 'wrong' || r.pile === 'shaky') {
      const log = parse(r.log_json, {}) || {};
      if (log.auto === true) autoLogged.push({ q: r.q, error_type: r.error_type || null, why: cut(r.why, 120) });
      else if (!r.logged_at && teach.seen === true && !autoLogClear(r, teach)) needsSay.push({ q: r.q, ask: sayQuestion(r, teach) });
      if (LEARN_ERRORS.has(r.error_type || 'knowledge gap')) {
        learn.push({ ...item, why: cut(r.why, 160), repeat, lesson: teach.lesson === true, rank: (repeat ? 0 : 4) + (teach.lesson === true ? 0 : 2) + (r.pile === 'wrong' ? 0 : 1) });
      } else glance.push({ ...item, why: `${r.error_type}: ${cut(r.why, 120) || 'a slip'}` });
    } else if (Number.isInteger(q.time_s) && q.time_s > PACE.slow_s) glance.push({ ...item, why: `right but slow (${mss(q.time_s)})` });
    else skip.push(r.q);
  }
  learn.sort((a, b) => a.rank - b.rank || a.q - b.q);
  const clean = learn.map(({ rank, ...x }) => x);
  const catOf = new Map(rows.map(r => [r.q, r.category || (qs.get(r.q) || {}).system || 'Other']));
  const tier = new Map([...clean.map(x => [x.q, x.pile === 'shaky' ? 'shaky' : 'wrong']), ...needsSay.map(x => [x.q, 'your say']), ...glance.map(x => [x.q, 'quick look'])]);
  const groups = [];
  for (const x of [...clean, ...needsSay, ...glance]) {
    const name = catOf.get(x.q) || 'Other';
    let g = groups.find(y => y.name === name);
    if (!g) { g = { name, qs: [] }; groups.push(g); }
    if (!g.qs.some(y => y.q === x.q)) g.qs.push({ q: x.q, tier: tier.get(x.q) });
  }
  return { learn: clean, glance, skip, needs_say: needsSay, auto_logged: autoLogged, groups, order: groups.flatMap(g => g.qs.map(x => x.q)) };
}
export function planLine(plan) {
  const qn = list => list.map(x => `Q${x.q}`).join(', ');
  if (plan.groups && plan.groups.length) {
    return [...plan.groups.map(g => `${g.name}: ${qn(g.qs)}`), plan.skip.length && `Skip: ${plan.skip.map(q => `Q${q}`).join(', ')}`].filter(Boolean).join(' · ');
  }
  return [plan.learn.length && `Learn first: ${qn(plan.learn)}`, plan.glance.length && `Quick look: ${qn(plan.glance)}`, plan.skip.length && `Skip: ${plan.skip.map(q => `Q${q}`).join(', ')}`,
    plan.needs_say && plan.needs_say.length && `Your say: ${plan.needs_say.map(x => `Q${x.q}`).join(', ')}`].filter(Boolean).join(' · ') || null;
}

export const CHECK_BLOCKS = 3, CHECK_RATE_OK = 0.1;
export async function autoCheck(env, blockId) {
  const rows = await all(env, `SELECT block_id, log_json FROM uworld_reviews WHERE log_json LIKE '%"auto":true%'`).catch(() => []);
  const blocks = [...new Set(rows.map(r => r.block_id))];
  const logged = rows.length, corrected = rows.filter(r => (parse(r.log_json, {}) || {}).corrected === true).length;
  const rate = logged ? Math.round((corrected / logged) * 100) / 100 : null;
  // Shown on the first three blocks, and on any later one while the judge is wrong more than one time in ten.
  const order = blocks.sort();
  const show = order.slice(0, CHECK_BLOCKS).includes(blockId) || (rate != null && rate > CHECK_RATE_OK);
  return { show, blocks: blocks.length, logged, corrected, rate };
}

/** "Review: wrong Q1, Q5 · shaky Q7, Q13" (the recorder page and the list view). */
export function reviewLine(state) {
  const by = p => state.list.filter(x => x.pile === p).map(x => `Q${x.q}`);
  const w = by('wrong'), s = by('shaky');
  if (!w.length && !s.length) return state.status === 'done' ? 'Nothing to review: every answer was sound.' : null;
  return `Review: ${[w.length && `wrong ${w.join(', ')}`, s.length && `shaky ${s.join(', ')}`].filter(Boolean).join(' · ')}`;
}

export function logArgs(pack, block, over = {}) {
  const errorKey = SERVER_ERROR[normError(over.error_type) || normError(pack.why_listed.error_type) || 'knowledge gap'];
  const index = buildLeakIndex({ obj: pack.tested.objective || '' });
  const safe = v => (v && !leaks(index, v) ? cut(v, 399) : null);
  const d = pack.decision_point || {};
  const said = typeof over.said === 'string' && over.said.trim() ? over.said.trim() : null;
  const judged = parse(block.questions_json, []).find(q => q && q.q === pack.q) || {};
  const timeS = [pack.glance.time_s, judged.time_s].find(v => Number.isInteger(v) && v > 0);
  const args = {
    error_type: errorKey, uw_qid: pack.uworld_id || undefined, block_mode: block.mode === 'tutor' ? 'tutor' : 'timed',
    topic: pack.glance.topic || undefined, system: pack.glance.system || undefined, condition: pack.condition || undefined,
    time_s: timeS, time_source: timeS ? 'uworld' : undefined,
    my_reasoning: safe(said || [pack.why_listed.why, d.fell_for && `What pulled him: ${d.fell_for}.`, pack.why_listed.his_words && `He said: "${pack.why_listed.his_words}"`].filter(Boolean).join(' ')),
    reasoning_source: said || pack.why_listed.his_words ? 'mo' : 'inferred',
    rule: safe(pack.tested.rule), look_alikes: safe(d.look_alike && d.separator ? `${d.look_alike}: ${d.separator}` : d.separator),
    look_alike_names: d.look_alike ? [cut(d.look_alike, 80)] : undefined,
    learning_point: safe(d.clue ? `The deciding clue: ${d.clue}` : null),
    correct_reasoning: cut(`[${pack.uworld_id ? `UW ${pack.uworld_id}` : `UW ${block.day} Q${pack.q}`}] ${safe(d.separator) || ''}`, 399),
    outcome: uworldOutcome({ ...judged, result: pack.glance.result || judged.result, picked: pack.glance.picked || judged.picked, answer: pack.glance.answer || judged.answer }),
    hub_topic_id: pack.map_topic ? pack.map_topic.id : undefined,
    patterns: pack.trap ? [pack.trap] : undefined,
  };
  const conf = confidenceOf(over.confidence) || confidenceOf(judged.confidence);
  if (conf) args.confidence = conf;
  if (over.again === true) args.again = true;
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v != null && v !== ''));
}

export function confidenceOf(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/^(?:i was |i'm |i am )/, '');
  if (/^(sure|certain|positive|confident|lts)$/.test(s)) return 3;
  if (/^(lean|leaning|leant|lean between.*|down to two|ltl)$/.test(s)) return 2;
  if (/^(guess|guessed|guessing|no idea|ltg)$/.test(s)) return 1;
  return null;
}

export const LOG_STATUSES = Object.freeze(['logged', 'queued', 'already', 'updated', 'not_logged']);
const CONF_SAY = { 3: 'sure', 2: 'down to two', 1: 'a guess' };
const andList = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
export function logChanges({ confidence, error_type, said } = {}) {
  return [confidence && CONF_SAY[confidence] && `now marked as ${CONF_SAY[confidence]}`, error_type && `the error type is now ${error_type}`,
    said && 'your reasoning added'].filter(Boolean);
}
/** One log reply (pure): the status flags always present, and say. rest: the entry's fields; stale flags in it are replaced. */
export function logReply(status, rest = {}, changes = []) {
  const { logged: _l, status: _s, already: _a, updated: _u, say: _y, deduped: _d, ...keep } = rest || {};
  const say = status === 'logged' ? 'Logged' : status === 'queued' ? 'Logged; it reaches the Anki log within 15 minutes'
    : status === 'already' ? 'Already logged' : status === 'updated' ? `Updated the log: ${andList(changes) || 'your words added'}` : 'Not logged yet';
  return { logged: status === 'not_logged' ? false : status === 'queued' ? 'queued' : true, status, already: status === 'already', updated: status === 'updated', say, ...keep };
}

async function updateLog(env, block, row, over, ctx) {
  const was = parse(row.log_json, {}) || {};
  const said = typeof over.said === 'string' && over.said.trim() ? cut(over.said.trim(), 399) : null;
  const errNew = normError(over.error_type), confNew = confidenceOf(over.confidence);
  const errKey = errNew && errNew !== (was.error_type || row.error_type || 'knowledge gap') ? errNew : null;
  const conf = confNew && confNew !== was.confidence ? confNew : null;
  if (!said && !errKey && !conf) return logReply('already', was);
  const id = Number(was.mistake_id);
  if (!Number.isInteger(id) || id <= 0) return logReply('already', { ...was, note: 'Logged already; it is still on its way to Anki, so his words could not be added yet.' });
  const fields = { id, ...(said ? { my_reasoning: said, reasoning_source: 'mo' } : {}), ...(errKey ? { error_type: SERVER_ERROR[errKey] } : {}), ...(conf ? { confidence: conf } : {}) };
  let r;
  try { r = await ankiCall(env, 'update_mistake', fields, { timeoutMs: 20_000 }); } catch (e) {
    return logReply('already', { ...was, note: `Logged already; the change did not reach Anki (${cut(e && e.message, 80) || 'no answer'}). Try again in a minute.` });
  }
  const corrected = !!(was.auto && errKey && errKey !== (row.error_type || 'knowledge gap'));
  const { status: _s, already: _a, say: _y, ...base } = was;
  const next = { ...base, updated: true, ...(errKey ? { error_type: errKey } : {}), ...(conf ? { confidence: conf } : {}), ...(corrected || was.corrected ? { corrected: true } : {}) };
  await run(env, 'UPDATE uworld_reviews SET log_json = ?, error_type = COALESCE(?, error_type), updated_at = ? WHERE block_id = ? AND q = ?', JSON.stringify(next), errKey || null, now(), block.id, row.q);
  if (row.uworld_id && ctx) pullForUworld(env, ctx, MO, [row.uworld_id]);   // the map's miss follows the Anki log
  return logReply('updated', { mistake_id: id, ...(corrected ? { corrected: true } : {}), summary: cut(r && r.summary, 200) || null }, logChanges({ confidence: conf, error_type: errKey, said }));
}

async function logNow(env, block, row, pack, over, ctx) {
  const args = logArgs(pack, block, over);
  const label = pack.uworld_id ? `UW ${pack.uworld_id}` : `UW ${block.day} Q${pack.q}`;
  // What the entry holds, kept in log_json so a later "log this" can tell a change from the same again.
  const kept = { error_type: normError(over.error_type) || normError(pack.why_listed && pack.why_listed.error_type) || 'knowledge gap', ...(args.confidence ? { confidence: args.confidence } : {}) };
  let out;
  try {
    const r = await ankiCall(env, 'debrief_question', args, { timeoutMs: 25_000 });
    // The Anki server's same-day repeat check (duplicate: the question was on its log today already, from Step 1 say)
    // made no new entry: already logged. Its summary offers "log it again", which this path never does, so it is not passed on.
    out = r.duplicate || r.deduped ? logReply('already', { mistake_id: r.mistake_id ?? null, error_type: kept.error_type, summary: 'This question was on the Anki log already today.' })
      : logReply('logged', { mistake_id: r.mistake_id ?? null, ...kept, summary: cut(r.summary, 300) });
  } catch (e) {
    // Not answered in time, or the Anki server is away: the outbox sends it (and checks it did not land already).
    const key = `uwreview:${block.id}:${row.q}${over.again ? `:${now()}` : ''}`;
    await run(env, `INSERT INTO outbox (id, kind, idem_key, payload_json, status, attempts, result_json, created_at) VALUES (?, 'debrief', ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT (idem_key) DO NOTHING`, crypto.randomUUID(), key, JSON.stringify({ label, args }), JSON.stringify({ ambiguous: !!(e && e.ambiguous) }), now());
    out = logReply('queued', { ...kept, note: 'The Anki server did not answer in time; the hub sends it within 15 minutes.' });
  }
  if (over.auto) out.auto = true;
  await run(env, 'UPDATE uworld_reviews SET logged_at = ?, log_json = ?, reviewed_at = CASE WHEN ? THEN reviewed_at ELSE COALESCE(reviewed_at, ?) END, updated_at = ? WHERE block_id = ? AND q = ?',
    now(), JSON.stringify(out), over.auto ? 1 : 0, now(), now(), block.id, row.q);
  // The Anki copy joins the hub's own miss by its id, so a review days after the block never makes a second miss.
  if (out.logged === true && Number.isInteger(Number(out.mistake_id)) && out.mistake_id != null) {
    await run(env, `UPDATE misses SET anki_mistake_id = ? WHERE user_id = ? AND uworld_block_id = ? AND uworld_q = ? AND deleted_at IS NULL AND anki_mistake_id IS NULL`,
      Number(out.mistake_id), MO, block.id, row.q).catch(e => console.error('uworld miss link failed', e && e.message));
  }
  if (pack.uworld_id && ctx) pullForUworld(env, ctx, MO, [pack.uworld_id]);
  if (out.already && !over.auto) return updateLog(env, block, { ...row, log_json: JSON.stringify(out) }, over, ctx);
  return out;
}

export async function uworldReview(env, args = {}, ctx = {}) {
  const block = await findBlock(env, args);
  if (!block) return { block: null, note: 'No UWorld block saved yet.' };
  const state = await reviewState(env, block);
  const qs = parse(block.questions_json, []);
  let qn = Number.isInteger(args.q) ? args.q : null;
  if (args.uworld_id) {
    const hit = qs.find(q => q.uworld_id === String(args.uworld_id));
    if (!hit) return { found: false, uworld_id: String(args.uworld_id), state, note: `UW ${args.uworld_id} is not on block ${block.day}'s results. If Mo did it in another block, its results screenshot is not on the hub yet.` };
    qn = hit.q;
  }
  if (qn == null) {
    // The list with every pack, in block order (wrong and shaky together), so the chat needs the hub again only to log.
    const rows = state.list.length ? await all(env, `SELECT q, pack_json FROM uworld_reviews WHERE block_id = ? AND pile IN ('wrong', 'shaky') ORDER BY q`, block.id) : [];
    const packs = rows.map(r => slimPack(parse(r.pack_json, null))).filter(Boolean);
    const all3 = state.status === 'done' || state.status === 'packing'
      ? await all(env, `SELECT r.q, r.uworld_id, r.pile, r.error_type, r.why, r.words, r.teach_json, r.pack_json, r.log_json, r.logged_at, c.name AS category
          FROM uworld_reviews r LEFT JOIN topics t ON t.user_id = r.user_id AND t.id = r.topic_id LEFT JOIN categories c ON c.user_id = t.user_id AND c.id = t.category_id
          WHERE r.block_id = ?`, block.id) : [];
    const plan = all3.length ? reviewPlan(all3, qs) : null;
    const check = plan && plan.auto_logged.length ? await autoCheck(env, block.id) : null;
    const keep = plan ? plan.order : [];
    const steps = plan ? 'For "which ones should I review?" answer from plan.groups, group by group in their order: the group\'s name, then each question with its tier (wrong, shaky, your say, quick look) and a few words on why; every question on it, shaky ones too; then skip as numbers. Then, in the same turn, run focus_script once with javascript_tool on the UWorld tab: it shows only these questions, in this order, in the Question Status list, and Next (the button, N or the right arrow) follows it. If you recommend a different order, put your order in the list at its end.' : null;
    const talk = await talkOf(env, block.id);
    return { state, line: reviewLine(state), ...(talk ? { review_words: talkList(talk) } : {}), ...(plan ? { plan, plan_line: planLine(plan), plan_steps: steps } : {}), ...(check ? { check } : {}),
      ...(keep.length ? { focus_script: focusScript(keep) } : {}), ...(packs.length ? { packs } : {}),
      note: state.status === 'no_results' ? 'No results yet: Mo uploads the results screenshot on the recorder.'
        : packs.length ? 'Keep these for the block: answer each question from the pack whose uworld_id matches the page; call again only to log, or with uworld_id for a question not here.' : undefined };
  }
  const row = await first(env, 'SELECT * FROM uworld_reviews WHERE block_id = ? AND q = ?', block.id, qn);
  const q = qs.find(x => x.q === qn) || { q: qn };
  const out = { found: true, q: qn, uworld_id: q.uworld_id || null };
  if (!row) {
    out.pile = 'not judged yet';
    out.note = `${state.status_words || 'Not judged yet'}. Answer from the page and his words as usual.`;
    out.glance = { topic: q.topic || null, result: q.result || null, time_s: q.time_s ?? null, others_pct: q.others_pct ?? null };
    // Nothing is logged from here before the judge has run: say so, so Claude logs it the usual way (Step 1).
    // "log this" goes to the hub only (1 Nov 2026): before the judge, a gap with the question's ref, never the Anki log.
    if (args.log === true) out.log = logReply('not_logged', { note: `Not logged: the hub has not judged this block yet. Log it with log_gap {ref: "UW ${q.uworld_id || ''}", gap, topic, error_type, confidence}, as in Step 1.` });
  } else {
    out.pile = row.pile;
    if (ON_LIST.includes(row.pile)) {
      out.pack = parse(row.pack_json, null);
      if (!out.pack) out.note = 'Judged; the pack is still being built. Use why and the page.';
      out.why = row.why;
    } else out.note = `${row.pile === 'sound' ? 'Sound' : 'Right, nothing said'}: not on the review list.${row.why ? ` ${row.why}` : ''}`;
    if (args.peek !== true) {
      const t = now();
      await env.DB.batch([
        env.DB.prepare('UPDATE uworld_reviews SET reviewed_at = ?, updated_at = ? WHERE block_id = ? AND q = ? AND reviewed_at IS NULL').bind(t, t, block.id, qn),
        env.DB.prepare(`UPDATE misses SET reviewed_at = ?1, reviewed_by = 'claude' WHERE user_id = ?2 AND deleted_at IS NULL AND reviewed_at IS NULL
          AND ((uworld_block_id = ?3 AND uworld_q = ?4) OR (?5 IS NOT NULL AND uw_qid = ?5 AND day = ?6))`).bind(t, MO, block.id, qn, q.uworld_id || null, block.day),
      ]);
    }
    if (args.log === true && args.peek !== true) {
      const pack = out.pack || packFor({ block, q, row, teach: parse(row.teach_json, null), objective: null, topic: null, mehlman: null, anki: { status: 'skipped', cards: [] }, reads: null });
      out.log = row.logged_at && args.again !== true ? await updateLog(env, block, row, args, ctx) : await logNow(env, block, row, pack, args, ctx);
    }
  }
  const talk = await talkOf(env, block.id);
  const said = talk && talk.by_q.get(qn);
  if (said) out.review_words = { ...said, transcript: talk.transcript(qn) ? cut(talk.transcript(qn), 1500) : null };
  else if (talk && talk.status !== 'done') out.review_words = { status: talk.line };
  const after = { ...state, list: state.list.map(x => (x.q === qn && row && args.peek !== true ? { ...x, reviewed: true, logged: x.logged || !!(out.log && out.log.logged) } : x)) };
  after.done = after.list.filter(x => x.reviewed).map(x => x.q);
  after.left = after.list.filter(x => !x.reviewed).map(x => x.q);
  const skipping = after.list.filter(x => !x.reviewed && x.q < qn);
  out.state = { status: after.status, left: after.left, done: after.done, list: after.list.map(x => ({ q: x.q, pile: x.pile, topic: x.topic, why: x.why, reviewed: x.reviewed })) };
  // At most three named (with why), then how many more, so the skip line stays one short line.
  if (skipping.length) out.skipping = [...skipping.slice(0, 3).map(x => `Q${x.q}: ${x.pile}${x.why ? `, ${x.why}` : ''}`),
    ...(skipping.length > 3 ? [`and ${skipping.length - 3} more (${skipping.slice(3).map(x => `Q${x.q}`).join(', ')})`] : [])];
  if (after.status === 'done' && !after.left.length && after.list.length) out.list_done = true;
  return out;
}

const talkOf = (env, blockId) => import('./uworld-review-talk.js').then(m => m.reviewTalkFor(env, blockId)).catch(e => { console.error('review words', e && e.message); return null; });
const talkList = talk => ({ status: talk.status, line: talk.line, questions: [...talk.by_q.entries()].map(([q, x]) => ({ q, said: cut(x.said, 200), cause: x.cause, at: x.at })),
  ...(talk.gaps.length ? { other_gaps: talk.gaps.slice(0, 8).map(g => `${g.topic}${g.mixed_with ? ` (mixed up with ${g.mixed_with})` : ''}`) } : {}) });

export async function reviewRoute(request, env, ctx, { id }) {
  const block = await first(env, 'SELECT id, day, mode, count, questions_json, results_json, updated_at FROM uworld_blocks WHERE id = ?', String(id));
  if (!block) throw new HttpError(404, 'This block is not saved on the hub yet.');
  const state = await reviewState(env, block);
  return json({ status: state.status, status_words: state.status_words, line: reviewLine(state), wrong: state.list.filter(x => x.pile === 'wrong').map(x => x.q),
    shaky: state.list.filter(x => x.pile === 'shaky').map(x => x.q), done: state.done });
}


/** A pack cut down to what the answer needs (about 1,500 characters), so a whole block's list fits in one reply. */
export function slimPack(p) {
  if (!p) return null;
  const m = p.sources && p.sources.mehlman;
  return {
    q: p.q, uworld_id: p.uworld_id, say: p.say || null,
    glance: { topic: p.glance.topic, result: p.glance.result, picked: p.glance.picked, answer: p.glance.answer, time_s: p.glance.time_s, pace: p.glance.pace, others_pct: p.glance.others_pct },
    why: p.why_listed.why, his_words: p.why_listed.his_words, error_type: p.why_listed.error_type, pile: p.why_listed.pile,
    rule: p.tested.rule, decision_point: p.decision_point,
    mehlman: m ? { cite: m.cite, text: cut(m.text, 240) } : null,
    anking: (p.sources.anking || []).slice(0, 2).map(c => cut(c.fact, 160)),
    has_own_card: !!p.sources.has_own_card, trap: p.trap || null,
    pictures: (p.sources.pictures || []).map(x => x.library), card_picture: p.sources.card_picture || null,
    earlier_misses: ((p.history && p.history.misses) || []).map(x => `${x.label} (${x.day})`),
    next: p.next,
  };
}
