import { normError, leaks } from '../../checks.js';
import { hubQuestionLabel, londonDay } from '../../util.js';
import { SERVER_ERROR } from '../../anki.js';
import { stemSafe, questionSafe } from '../guard.js';
import { norm, userKey } from '../../../../public/js/shared/names.js';
import { PACE } from '../weights.js';
import { normSystem } from '../../uworld-systems.js';
import { CAUSES, CAUSE_VERSION, tidyCause } from '../../../../public/js/shared/cause.js';

export const ERROR_KEYS = Object.values(SERVER_ERROR);
const ERROR_WORDS = Object.fromEntries(Object.entries(SERVER_ERROR).map(([w, k]) => [k, w]));

export function errorKey(e) {
  if (e == null || e === '') return null;
  const s = String(e).trim().toLowerCase();
  if (ERROR_KEYS.includes(s)) return s;
  return SERVER_ERROR[normError(s)] ?? null;
}
/** The hub's words for an Anki error key ('knowledge gap'), for display. */
export const errorWords = key => ERROR_WORDS[key] ?? null;

// Confidence: the two scales run opposite ways. Anki stores 3 sure, 2 lean, 1 guess; the hub's tap is
// '1' Sure, '2' Lean, '3' Guess.
const ANKI_CONF = { 3: 'sure', 2: 'lean', 1: 'guess', high: 'sure', mid: 'lean', medium: 'lean', low: 'guess', sure: 'sure', lean: 'lean', guess: 'guess' };
const HUB_CONF = { 1: 'sure', 2: 'lean', 3: 'guess' };
export const confFromAnki = c => (c == null ? null : ANKI_CONF[String(c).toLowerCase()] ?? null);
export const confFromHub = c => (c == null ? null : HUB_CONF[String(c)] ?? null);

// The server's outcomes (study_log.OUTCOMES) and the hub's flagged verdict, as a miss result.
const WRONG_OUTCOMES = ['wrong', 'wrong_changed_from_right'];
const FLAWED_OUTCOMES = ['right_guess', 'right_changed_from_wrong', 'right_flawed'];
export function resultFromOutcome(o) {
  if (WRONG_OUTCOMES.includes(o)) return 'wrong';
  if (FLAWED_OUTCOMES.includes(o)) return 'flawed';
  return null;
}
// A re-test result as weakness reads it.
export function retestOutcome(r) {
  const s = String(r ?? '').toLowerCase();
  if (['got_it', 'right', 'pass', 'passed', 'correct', 'yes'].includes(s)) return 'got_it';
  if (['missed_again', 'missed', 'wrong', 'fail', 'failed', 'no'].includes(s)) return 'missed_again';
  return null;
}

export const FLAW_KINDS = ['lucky_guess', 'right_wrong_reason', 'shaky_elimination', 'misread_detail'];
export const QBANKS = ['uworld', 'nbme', 'uwsa', 'free120', 'cms', 'amboss', 'other'];
// Exam pace (weights.js PACE, the one definition): over 90 s is over pace, over two minutes is slow, and slow is weak
// even when right.
export const SLOW_S = PACE.slow_s;

/** The one release rule (plan §6.5): a sitting's results reach the map only once it is done. */
export const releasable = sitting => !!sitting && sitting.status === 'done';

export { gapOrigin, CHECK_SOURCES } from '../weights.js';

// Evidence sources ingestion writes (open text in the table; this list is what code checks). A new spoken
// source (ankimobile, anki_iphone) is one more entry here and in gaps.js SOURCES.
export const EVIDENCE_SOURCES = ['hub', 'uworld', 'anki', 'chat', 'anki_voice', 'anki_mac', 'anki_hub', 'anki_phone', 'anki_voice_check', 'spoken_cue'];

export { userKey };
export const normLabel = s => norm(s);
/** The raw key back from an id userKey made. */
export const rawKey = (user, id) => (user !== 'mo' && String(id).startsWith(`${user}.`) ? String(id).slice(user.length + 1) : String(id));

export const uwKey = (qid, day) => `uw:${qid}:${day}`;
export const uwbKey = (blockId, q) => `uwb:${blockId}:${q}`;
export const hubKey = (blockId, qIndex) => `hub:${blockId}:${qIndex}`;
export const ankiKey = id => `anki:${id}`;
export const gapKey = id => `gap:${id}`;
export const cardDayKey = (cardId, day) => `card:${cardId}:${day}`;
export const retestKey = (id, due) => `retest:${id}:${due}`;
export const labelQueueKey = norm => `label:${norm}`;

export const uwLabel = qid => `UW ${qid}`;
export const hubLabel = (sittingName, num, qIndex, blockIdx) => hubQuestionLabel(sittingName, num, qIndex, blockIdx);
export const ankiLabel = id => `Anki #${id}`;

/** qbank for a hub sitting's exam_type. */
export function qbankOfSitting(s) {
  const t = s && s.exam_type;
  return ['nbme', 'uwsa', 'free120'].includes(t) ? t : 'other';
}
/** qbank for an Anki record's source. */
export function qbankOfAnki(rec) {
  const s = String((rec && (rec.qbank || rec.source)) || '').toLowerCase();
  if (QBANKS.includes(s)) return s;
  if (s === 'uw' || s.includes('uworld')) return 'uworld';
  if (s === 'hub' || s.includes('nbme')) return 'nbme';
  return rec && (rec.uworld_id || rec.uw_qid) ? 'uworld' : 'other';
}

// Days and times: a London day in, a time in the middle of that day out (rows sort within the day).
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = d => typeof d === 'string' && DAY.test(d);
export const dayNoon = d => Date.parse(`${d}T12:00:00Z`);
export const dayDiff = (a, b) => Math.round(Math.abs(dayNoon(a) - dayNoon(b)) / 86_400_000);

export const SAME_QUESTION_DAYS = 14;
export function sameQuestion(row, incoming) {
  if (!row || !incoming || row.deleted_at != null || !row.uw_qid || String(row.uw_qid) !== String(incoming.uw_qid || '')) return false;
  if (!isDay(row.day) || !isDay(incoming.day) || dayDiff(row.day, incoming.day) > SAME_QUESTION_DAYS) return false;
  return !(row.uworld_block_id && incoming.uworld_block_id && row.uworld_block_id !== incoming.uworld_block_id);
}

const BOILERPLATE = [/^missed this card in a voice review\.?$/i, /^missed (?:this|the) card\.?$/i, /^did not hold this card\.?$/i,
  /^(?:no|none|n\/a|nothing said|\(none\)|\(no words\))\.?$/i, /^he (?:did not|didn't) (?:say|answer)\b/i];
export const isBoilerplate = s => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return !t || BOILERPLATE.some(re => re.test(t)); };

export const SAID_WINDOW = { after_shown_ms: 2_000, after_answer_ms: 60_000, session_ms: 3_000, share: 0.6 };
const saidTokens = s => String(s || '').toLowerCase().replace(/\(read the (?:card|question)\)/g, ' ').match(/[a-z0-9']{3,}/g) || [];
/**
 * The speech of one card inside its window: parts [{t (ms from the session start), text}] -> the words said in it.
 * card: {shown_at, revealed_at, answered_at} (epoch ms); startedAt: the session's start (epoch ms). Pure.
 */
export function windowText(parts, card, startedAt) {
  const shown = Number(card && card.shown_at), end = Number((card && (card.answered_at || card.revealed_at)) || shown);
  if (!Number.isFinite(shown) || !Number.isFinite(Number(startedAt))) return '';
  const lo = Math.max(shown + SAID_WINDOW.after_shown_ms, Number(startedAt) + SAID_WINDOW.session_ms), hi = end + SAID_WINDOW.after_answer_ms;
  return (parts || []).filter(p => p && Number.isFinite(Number(p.t)) && Number(startedAt) + Number(p.t) >= lo && Number(startedAt) + Number(p.t) <= hi)
    .map(p => String(p.text || '')).join(' ');
}
export function saidInWindow(said, text) {
  if (isBoilerplate(said)) return false;
  const want = saidTokens(said), have = new Set(saidTokens(text));
  if (!want.length || !have.size) return false;
  return want.filter(w => have.has(w)).length / want.length >= SAID_WINDOW.share;
}

export function eventAt(real, fallback, { lo = -Infinity, hi = Infinity } = {}) {
  const t = real == null || real === '' ? NaN : Number(real);
  return Number.isFinite(t) && t >= lo && t <= hi ? Math.round(t) : fallback;
}

export function uworldQuestionAt(block, q) {
  const noon = dayNoon(block.day) + q.q * 1000;
  const id = /^\d{12,14}$/.test(String(block.id)) ? Number(block.id) : null;
  const start = id != null && londonDay(id) === block.day ? id : null;
  if (start == null) return noon;
  const off = Number.isFinite(Number(q.start_ms)) && q.start_ms != null && Number(q.start_ms) >= 0 ? Number(q.start_ms) : null;
  return eventAt(off == null ? start + q.q * 1000 : start + off, noon, { lo: start, hi: start + 12 * 3600_000 });
}

// ---------------------------------------------------------------- change gating
/** FNV-1a (32 bit) of a string, as 8 hex characters. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
// The fields whose change rewrites a mirrored row (the server's records have no updated_at yet).
const HASH_FIELDS = ['topic', 'condition', 'system', 'rule', 'error_type', 'outcome', 'confidence', 'time_s', 'slow', 'day', 'uworld_id', 'uw_qid',
  'hub_topic_id', 'my_reasoning', 'look_alikes', 'learning_point', 'updated_at'];
/** The src_hash of an Anki record: its fields, re-tests and note ids (long texts by length only). */
export function fingerprint(rec) {
  const parts = HASH_FIELDS.map(k => (rec[k] == null ? '' : String(rec[k])));
  parts.push(JSON.stringify(rec.retests || []), JSON.stringify(rec.anki_note_ids || []), JSON.stringify(rec.look_alike_names || []));
  return fnv1a(parts.join('\u0001'));
}
/** The src_hash of any row built here: the row's own values, in column order. */
export const rowHash = (row, cols) => fnv1a(cols.map(c => (row[c] == null ? '' : typeof row[c] === 'object' ? JSON.stringify(row[c]) : String(row[c]))).join('\u0001'));

export const MISS_INGEST_COLS = ['source', 'source_ref', 'label', 'qbank', 'day', 'at', 'uw_qid', 'sitting_id', 'block_id', 'q_index', 'uworld_block_id',
  'uworld_q', 'anki_mistake_id', 'result', 'outcome', 'flaw_kind', 'confidence', 'confidence_source', 'error_type', 'time_s', 'slow', 'others_pct',
  'time_source', 'topic_raw', 'condition_raw', 'system_raw', 'label_norm', 'topic_id', 'category_id', 'queue_id', 'match_status', 'match_method',
  'rule', 'my_reasoning', 'reasoning_source', 'right_reasoning', 'look_alikes', 'look_alike_names_json', 'learning_point', 'retests_json',
  'next_retest_day', 'anki_note_ids_json', 'held', 'src_hash', 'deleted_at', 'updated_at', 'step', ...['cause', 'cause_quote', 'cause_inferred', 'cause_detail', 'cause_version'], 'cause_disputed'];
export const MISS_CAUSE_COLS = ['cause', 'cause_quote', 'cause_inferred', 'cause_detail', 'cause_version'];
/** A judge's cause fields as miss columns, or {} when it named none (so a stored cause is never wiped). */
export function causeCols(x, safe = v => v) {
  const c = tidyCause(x);
  if (!c.cause) return {};
  return { cause: c.cause, cause_quote: safe(c.cause_quote), cause_inferred: c.cause_inferred, cause_detail: safe(c.cause_detail), cause_version: CAUSE_VERSION };
}
export const MISS_TOPIC_COLS = ['topic_id', 'category_id', 'queue_id', 'match_status', 'match_method'];

export const MO_FIX_COLS = { cause: MISS_CAUSE_COLS, confidence: ['confidence', 'confidence_source'], his_words: ['his_words', 'his_words_at', 'his_words_src'] };
export function moFixed(row) {
  let o = null;
  try { o = row && row.mo_corrected_json ? JSON.parse(row.mo_corrected_json) : null; } catch { o = null; }
  return o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).filter(k => MO_FIX_COLS[k]) : [];
}
export function keepMoFixes(row, existing) {
  for (const g of moFixed(existing)) for (const c of MO_FIX_COLS[g]) row[c] = existing[c] ?? null;
  if (existing && existing.mo_corrected_json) row.mo_corrected_json = existing.mo_corrected_json;
  return row;
}
export const STICKY_METHODS = ['claude', 'mo'];
export const CODE_PLACED = ['alias', 'label'];
export const wordsChanged = (row, text) => {
  if (!(row && row.topic_id && CODE_PLACED.includes(row.match_method))) return false;
  const k = normLabel(text);
  return !!k && k !== (row.label_norm || normLabel(row.condition_raw || row.topic_raw));
};
export const NEVER_STORED = ['correct_reasoning', 'why_wrong_options'];
const ALL_MISS_COLS = ['id', 'user_id', ...MISS_INGEST_COLS, 'created_by', 'created_at'];

export function missUpsert(row) {
  const cols = ALL_MISS_COLS.filter(c => row[c] !== undefined);
  const upd = cols.filter(c => MISS_INGEST_COLS.includes(c)).map(c => (MISS_TOPIC_COLS.includes(c)
    ? `${c} = CASE WHEN misses.match_method IN ('claude','mo') THEN misses.${c} ELSE excluded.${c} END`
    : `${c} = excluded.${c}`));
  const sql = `INSERT INTO misses (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
    ON CONFLICT(id) DO UPDATE SET ${upd.join(', ')} WHERE misses.user_id = excluded.user_id`;
  return [sql, cols.map(c => row[c])];
}

const line = (v, max = 2000) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null);
const systemLine = (v, max) => { const s = normSystem(line(v, max)); return s ? s.slice(0, max) : null; };
const intOrNull = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);
const ids = v => (Array.isArray(v) ? v.map(Number).filter(n => Number.isSafeInteger(n) && n > 0) : []);

/** look_alikes text -> up to three names ("Duct ectasia: told apart by..." -> ["Duct ectasia"]). */
export function lookAlikeNames(rec) {
  if (Array.isArray(rec.look_alike_names)) return rec.look_alike_names.map(s => line(s, 80)).filter(Boolean).slice(0, 3);
  return [];
}

/** The earliest re-test due date still without a result. */
export function nextRetestDay(retests) {
  const due = (Array.isArray(retests) ? retests : []).filter(r => r && isDay(r.due) && r.result == null).map(r => r.due).sort();
  return due[0] || null;
}
const cleanRetests = list => (Array.isArray(list) ? list : []).filter(r => r && isDay(r.due))
  .map(r => ({ due: r.due, result: r.result == null ? null : retestOutcome(r.result) || String(r.result).slice(0, 20),
    ...(r.result != null && r.done_at != null && r.done_at !== '' ? { done_at: typeof r.done_at === 'number' ? r.done_at : String(r.done_at).slice(0, 40) } : {}) }));

/**
 * An Anki Voice mistake record -> the miss fields it owns (no id, key or topic yet). A whitelist: the two
 * long fields never get through, whatever the server sends.
 */
export function missFromAnki(rec, now = Date.now()) {
  // The live server sends the record's London day as `date` (read 24 Oct); `day` is kept for older fixtures.
  const day = isDay(rec.date) ? rec.date : isDay(rec.day) ? rec.day : null;
  const qid = rec.uworld_id ?? rec.uw_qid;
  const retests = cleanRetests(rec.retests);
  return {
    source: 'anki', source_ref: ankiKey(rec.id), qbank: qbankOfAnki(rec), day, at: Number.isSafeInteger(rec.at) ? rec.at : day ? dayNoon(day) : now,
    uw_qid: qid != null && /^[\w-]{1,12}$/.test(String(qid)) ? String(qid) : null, anki_mistake_id: Number(rec.id),
    result: resultFromOutcome(rec.outcome) || 'wrong', outcome: line(rec.outcome, 40),
    confidence: confFromAnki(rec.confidence), confidence_source: rec.confidence != null ? line(rec.confidence_source, 20) || 'reported' : null,
    error_type: errorKey(rec.error_type), time_s: intOrNull(rec.time_s), slow: rec.slow === true || rec.slow === 1 || Number(rec.time_s) > SLOW_S ? 1 : 0,
    time_source: rec.time_s != null ? 'anki' : null,
    topic_raw: line(rec.topic, 200), condition_raw: line(rec.condition, 200), system_raw: systemLine(rec.system, 120),
    rule: questionSafe(line(rec.rule)), my_reasoning: stemSafe(line(rec.my_reasoning)), reasoning_source: line(rec.reasoning_source, 20),
    look_alikes: questionSafe(line(rec.look_alikes)), look_alike_names_json: JSON.stringify(lookAlikeNames(rec)), learning_point: questionSafe(line(rec.learning_point)),
    retests_json: JSON.stringify(retests), next_retest_day: nextRetestDay(retests), anki_note_ids_json: JSON.stringify(ids(rec.anki_note_ids)),
    ...causeCols(rec, v => questionSafe(v)),
  };
}
export const ANKI_COPY_COLS = ['anki_mistake_id', 'retests_json', 'anki_note_ids_json'];
export const ANKI_WINS = ['rule', 'my_reasoning', 'reasoning_source', 'look_alikes', 'look_alike_names_json', 'learning_point', 'confidence',
  'confidence_source', 'error_type', 'outcome', 'condition_raw', 'topic_raw', 'system_raw', ...ANKI_COPY_COLS];

const CONF_PAIR = ['confidence', 'confidence_source'];
/** true: the incoming confidence pair wins; false: the stored pair stays; null: no confidence comes in (the usual rules). */
export function confidenceWinner(existing, incoming, from) {
  if (!incoming || incoming.confidence == null || incoming.confidence === '') return null;
  if (!existing || existing.confidence == null || existing.confidence === '') return true;
  if (existing.confidence_source === 'mo' || moFixed(existing).includes('confidence')) return incoming.confidence_source === 'mo';
  if (from === 'anki') return incoming.confidence_source === 'reported' || existing.confidence_source === 'assumed' || existing.confidence_source == null;
  // The hub's own reading over an Anki row: only where the stored value was assumed.
  if (existing.anki_mistake_id != null) return existing.confidence_source === 'assumed' && incoming.confidence_source != null && incoming.confidence_source !== 'assumed';
  return true;
}

export function mergeMiss(existing, incoming, from) {
  if (!existing) return { ...incoming };
  const out = { ...existing };
  const ankiOwned = existing.anki_mistake_id != null;
  const confWin = confidenceWinner(existing, incoming, from);
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    if (CONF_PAIR.includes(k) && confWin != null) { if (confWin) out[k] = v; continue; }
    const empty = v === null || v === '' || v === '[]';
    if (empty && existing[k] != null && existing[k] !== '' && existing[k] !== '[]') continue;
    if (from === 'anki') {
      if (ANKI_WINS.includes(k) || existing[k] == null || existing[k] === '[]') out[k] = v;
    } else if (!(ankiOwned && ANKI_WINS.includes(k) && existing[k] != null && existing[k] !== '[]')) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * A hub analysis -> {miss, answer}: the miss fields when it is wrong or flawed (else null), and the answer
 * facts every analysed question gives (evidence). ctx: {sitting, block, num, conf, secs, index} where index is
 * the question's leak index; any text field that shares a 6-word run with the question is dropped.
 * Returns null when there is nothing to place (a no_reasoning_heard right with no topic).
 */
export function fromAnalysis(a, ctx) {
  if (!a || a.status !== 'done') return null;
  const override = a.mo_override === 'sound';
  const verdict = a.verdict === 'right_flawed' && override ? 'sound' : a.verdict;
  if (!['wrong', 'right_flawed', 'sound', 'no_reasoning_heard'].includes(verdict)) return null;
  const safe = v => { const s = line(v); return s && !(ctx.index && leaks(ctx.index, s)) ? s : null; };
  const topic = safe(a.topic);
  if (!topic && verdict === 'no_reasoning_heard') return null;
  const result = verdict === 'wrong' ? 'wrong' : verdict === 'right_flawed' ? 'flawed' : 'right';
  const errorType = result === 'right' ? null : errorKey(a.error_confirmed || a.error_type);
  const flaw = FLAW_KINDS.includes(a.flaw_kind) && result === 'flawed' ? a.flaw_kind : null;
  const confidence = confFromHub(ctx.conf);
  const timeS = Number.isFinite(ctx.secs) && ctx.secs > 0 ? Math.round(ctx.secs) : null;
  const label = hubLabel(ctx.sitting.name, ctx.num, a.q_index, ctx.block.idx);
  const answer = { result, verdict, confidence, error_type: errorType, flaw_kind: flaw, time_s: timeS, others_pct: null, label, topic, system: systemLine(safe(a.system), 2000),
    ...heardOf(a.heard) };
  if (result === 'right') return { miss: null, answer };
  const miss = {
    source: 'hub', source_ref: `block:${ctx.block.id}:q${a.q_index}`, label, qbank: qbankOfSitting(ctx.sitting),
    day: ctx.day, at: ctx.at, sitting_id: ctx.sitting.id, block_id: ctx.block.id, q_index: a.q_index,
    result, outcome: null, flaw_kind: flaw, confidence, confidence_source: confidence ? (ctx.confFrom === 'voice' ? 'voice' : 'reported') : null, error_type: errorType,
    time_s: timeS, slow: timeS > SLOW_S ? 1 : 0, time_source: timeS ? 'hub' : null,
    topic_raw: topic, system_raw: answer.system, rule: safe(a.rule), my_reasoning: safe(a.paraphrase), reasoning_source: a.paraphrase ? 'hub' : null,
    right_reasoning: safe(a.gap), look_alikes: safe(a.look_alike), ...causeCols(a, safe),
    // The two judges named different causes and the third look could not settle it (0067): no look-alike counts yet.
    // A check made with the shared core always says (0 once settled), an older one leaves the column as it is.
    ...(a.cause_check === 'disputed' && a.cause ? { cause_disputed: 1 } : a.form_version != null ? { cause_disputed: 0 } : {}),
  };
  if (['recognise', 'distinguish', 'test', 'treat', 'trap'].includes(a.step)) miss.step = a.step;
  return { miss, answer };
}

export function uworldResultOf(q) {
  const verdict = (q && q.verdict) || null;
  let result = q && q.result === 'right' ? 'right' : q && q.result === 'wrong' ? 'wrong' : q && q.result === 'omitted' ? 'omitted' : null;
  if (verdict === 'wrong') result = 'wrong';
  if (verdict === 'right_flawed' && result !== 'wrong') result = 'flawed';
  if (!result && verdict === 'sound') result = 'right';
  return result;
}

export function blockComplete(count, questions) {
  const n = Number(count);
  if (count == null || !Number.isInteger(n) || n < 1) return 0;
  const got = new Set((questions || []).filter(q => q && Number.isInteger(q.q) && q.q >= 1 && q.q <= n && uworldResultOf(q)).map(q => q.q));
  return got.size >= n ? 1 : 0;
}

export function fromUworld(q, block) {
  const verdict = q.verdict || null;
  const result = uworldResultOf(q);
  if (!result) return null;
  const qid = q.uworld_id || null;
  const label = qid ? uwLabel(qid) : `UW ${block.day} Q${q.q}`;
  const errorType = result === 'right' ? null : errorKey(q.error_type);
  const timeS = Number.isInteger(q.time_s) && q.time_s > 0 ? q.time_s : null;
  const confidence = ['sure', 'lean', 'guess'].includes(q.confidence) ? q.confidence : null;
  // How a right answer was flawed, as the judge named it (a lucky guess is not a wrong reason), and a changed answer.
  const flaw = result === 'flawed' && FLAW_KINDS.includes(q.flaw_kind) ? q.flaw_kind : null;
  const outcome = result === 'wrong' || result === 'flawed' ? uworldOutcome({ ...q, result: result === 'flawed' ? 'right' : q.result === 'omitted' ? 'omitted' : 'wrong' }) : null;
  const answer = { result, verdict, confidence, error_type: errorType, flaw_kind: flaw, time_s: timeS, others_pct: Number.isInteger(q.others_pct) ? q.others_pct : null,
    label, topic: line(q.topic, 80), system: systemLine(q.system, 80), from_block: 1, ...(/_changed_/.test(outcome || '') ? { outcome } : {}),
    ...(block.mode === 'tutor' ? { tutor: 1 } : {}), ...heardOf(q.heard) };
  if (result !== 'wrong' && result !== 'flawed') return { miss: null, answer };
  const miss = {
    source: 'uworld', source_ref: `uworld:${block.id}:q${q.q}`, label, qbank: 'uworld', day: block.day, at: uworldQuestionAt(block, q),
    uw_qid: qid, uworld_block_id: block.id, uworld_q: q.q, result, error_type: errorType, flaw_kind: flaw, time_s: timeS, slow: timeS > SLOW_S ? 1 : 0,
    others_pct: answer.others_pct, time_source: timeS ? 'uworld' : null, topic_raw: answer.topic, system_raw: answer.system,
    my_reasoning: stemSafe(line(q.note, 300)), reasoning_source: q.note ? 'claude' : null,
    confidence, confidence_source: confidence ? 'voice' : null,
    condition_raw: line(q.condition, 200),
    ...(answer.outcome ? { outcome: answer.outcome } : {}),
  };
  if (['recognise', 'distinguish', 'test', 'treat', 'trap'].includes(q.step)) miss.step = q.step;
  const rule = stemSafe(line(q.rule, 300)), look = stemSafe(line(q.look_alike, 300));
  if (rule) miss.rule = rule;
  if (look) miss.look_alikes = look;
  Object.assign(miss, causeCols(q, v => stemSafe(v)));
  return { miss, answer };
}

export function uworldOutcome(q = {}) {
  const L = v => (typeof v === 'string' && /^[A-Z]$/.test(v) ? v : null);
  const first = L(q.first_pick), final = L(q.picked), key = L(q.answer);
  const changed = !!(first && final && first !== final);
  if (q.result === 'wrong' || q.result === 'omitted' || (q.result == null && q.verdict === 'wrong')) return changed && key && first === key ? 'wrong_changed_from_right' : 'wrong';
  if (changed) return 'right_changed_from_wrong';
  if (q.flaw_kind === 'lucky_guess' || (!q.flaw_kind && q.confidence === 'guess')) return 'right_guess';
  return 'right_flawed';
}

// ---------------------------------------------------------------- evidence
const EV_FACTS = ['result', 'outcome', 'verdict', 'confidence', 'error_type', 'flaw_kind', 'time_s', 'others_pct', 'amount', 'rating'];
export const EVIDENCE_COLS = ['user_id', 'obs_key', 'slot', 'topic_id', 'queue_id', 'label_norm', 'category_id', 'kind', 'at', 'day', 'source', 'source_ref',
  'miss_id', 'sitting_id', 'card_id', 'note_id', 'gap_id', 'lesson_id', 'held', ...EV_FACTS, 'detail_json', 'created_by', 'created_at', 'updated_at'];

const heardOf = v => (v === 'partial' || v === 'unclear' ? { heard: v } : {});

export function questionEvidence({ obs_key, answer, at, day, source, source_ref = null, miss_id = null, sitting_id = null, held = 0 }) {
  const detail = { label: answer.label };
  if (answer.heard) detail.heard = answer.heard;
  if (answer.from_block) detail.from_block = 1;
  // A tutor-mode block shows the answer after each question (fsrs.js re-exposure).
  if (answer.tutor) detail.tutor = 1;
  return {
    obs_key, slot: 0, kind: 'question', at, day, source, source_ref, miss_id, sitting_id, held: held ? 1 : 0,
    result: answer.result, outcome: answer.outcome ?? null, verdict: answer.verdict ?? null, confidence: answer.confidence ?? null,
    error_type: answer.error_type ?? null, flaw_kind: answer.flaw_kind ?? null, time_s: answer.time_s ?? null, others_pct: answer.others_pct ?? null,
    detail_json: JSON.stringify(detail),
  };
}

/**
 * The miss's judged cause on its own answer's evidence (detail_json.cause), so the right topic's miss counts by cause
 * (weights.js causeMultOf: a reasoning slip 0.8, a misread 0.3). Only a judged cause is written: one read from the
 * error type weighs the same as the error type already does. Returns the row (changed in place).
 */
export function withCause(ev, miss) {
  if (!ev || !miss) return ev;
  const d = (() => { try { return JSON.parse(ev.detail_json || '{}') || {}; } catch { return {}; } })();
  const cause = CAUSES.includes(miss.cause) ? miss.cause : null;
  if ((d.cause ?? null) === cause) return ev;
  if (cause) d.cause = cause; else delete d.cause;
  ev.detail_json = JSON.stringify(d);
  return ev;
}

/** True when a new evidence row changes nothing an existing one says (so the write is skipped). */
export function sameEvidence(a, b) {
  if (!a || !b) return false;
  for (const k of ['topic_id', 'queue_id', 'category_id', 'kind', 'held', 'day', ...EV_FACTS, 'detail_json', 'gap_id', 'card_id']) {
    if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  }
  return true;
}

// A gaps row's source as people read it (gaps.js SOURCE_LABEL keeps the same words). A gap's evidence row
// is weakness's gapEvidence (weights.js), merged into its card's day with cards.js mergeCardDay.
export const GAP_SOURCE_LABEL = { chat: 'said to Claude', anki_voice: 'Anki Voice', spoken_cue: 'said aloud while recording', anki_mac: 'Anki review on the Mac',
  anki_hub: 'Anki review on the hub', anki_phone: 'Anki review on the phone', anki_voice_check: 'Anki Voice review, checked',
  viva: 'said in a viva' };

// ---------------------------------------------------------------- refs
export function parseRef(ref) {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  let m;
  if ((m = /^block:([\w-]+):q(\d+)$/.exec(s))) return { kind: 'block', block_id: m[1], q_index: Number(m[2]) };
  if ((m = /^uworld:([\w-]+)@(?:(\d+):)?(\d+):(\d{2})$/.exec(s))) return { kind: 'uworld', block_id: m[1], ms: ((Number(m[2] || 0) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000 };
  if ((m = /^anki:([\w-]+)$/.exec(s))) return { kind: 'anki', session: m[1] };
  if ((m = /^(?:uworld|uw)\s*#?\s*(?:id\s*)?(\d{3,7})$/i.exec(s))) return { kind: 'uw', qid: m[1] };
  if ((m = /^(.{2,60}?)[,\s]+(?:(?:B|block)\s?(\d{1,2})[,\s]+)?(?:Q\s?|question\s+)(\d{1,3})$/i.exec(s))) return { kind: 'sitting', name: m[1].trim(), num: Number(m[3]), ...(m[2] ? { block: Number(m[2]) } : {}) };
  return null;
}
