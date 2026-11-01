import { londonDay } from '../util.js';
import { applyChange } from './change.js';
import { SOFT, softFields } from './events.js';
import { restoreRow } from './undo.js';
import { applyPairTest, planAdd } from './links-store.js';
import { slugId, norm } from '../../../public/js/shared/names.js';
import { namingProblem } from './vocab.js';
import { NO_LESSON_ERRORS, PHASES, phaseOf, daysLeft, phaseFor, fnv1a, rankTopicsFor, choose, whyLine, tablesPresent } from './teach-priority.js';
import { readExamDay } from '../exam-day.js';
import {
  checkNote, newNoteRows, noteMerges, similar, scoreOf, TACTIC_VOCAB, CONTENT_TYPES, JUDGEMENTS, clickedTactics, lessonDeltas, stickDeltas,
  subtractDeltas, sumDeltas, tacticRows, checkBelief, lessonMisconceptions, autoCloseRows, stickLine, PASS_SQL, FAIL_SQL,
  checkCorrection, correctionNote, CORRECTIONS_PER_SAVE,
} from './teach-memory.js';
import { METHOD_VERSION } from './teach-method.js';
import { flushOutbox } from '../outbox.js';
import { looksLikeStem } from './guard.js';
import { getPrefs, userRow, profileFor } from '../users.js';
import { lessonRetests, lessonParts } from './retests.js';
import { facetOfSteps, facetOfQuestion } from './facets.js';
import { noteJob } from '../job-log.js';
import { vivaReceive, lessonViva, lessonVivaCall, lessonVivaStates, vivaOutcome, withPairItems, VIVA } from './viva.js';
import { readCluster, memberOfText } from './clusters.js';
import { isFoundationCategory } from '../../../public/js/shared/concept.js';

export const FIVE_STEPS = ['recognise', 'distinguish', 'test', 'treat', 'trap'];
export const PROBE_RESULTS = ['right', 'wrong', 'partial', 'skipped'];
export const PROBE_FROM = ['gap', 'misconception', 'retest', 'new'];
export const CHECKS = ['right', 'wrong_then_right', 'wrong_twice'];
export const FINAL_RESULTS = ['right', 'partial', 'wrong', 'skipped'];
export const CONFIDENCES = ['sure', 'lean', 'guess'];
export const CARD_ACTIONS = ['added', 'edited_existing', 'none', 'declined'];
export const EFFECTS = ['helped', 'neutral', 'hurt'];
export const LINK_TYPES = ['versus', 'treated_by', 'adverse_effect', 'causes'];
export const TOPIC_KINDS = ['condition', 'approach', 'drug', 'organism', 'concept', 'finding', 'procedure'];
export const CLAUDE_VIEWS = ['landed', 'partial', 'not_landed'];
export { JUDGEMENTS };
export const MINUTES_CAP = 90;
export const NOTE_USE_COLS = ['uses', 'wins', 'losses', 'score', 'evidence_json', 'updated_at'];
export const STALE_IN_PROGRESS_MS = 3 * 3600_000, STALE_REQUESTED_MS = 72 * 3600_000;
export const OUTBOX_KINDS = ['anki_link_card', 'anki_retest'];
export const MISSING_MAX = 4, MISSING_LEN = 80, TACTICS_MAX = 4;
export const TEACH_BACK_TEXT_MAX = 600;
export const BLEND_WEIGHTS = { final_case: 0.30, explanation: 0.15, teach_back: 0.20, mo_rating: 0.20, speed: 0.10, questions: 0.05 };
export const VIVA_BLEND_WEIGHTS = { viva: 0.45, viva_gain: 0.25 };
const BLEND_W = { ...BLEND_WEIGHTS, ...VIVA_BLEND_WEIGHTS };
export const OUTCOME_AT = { landed: 0.70, partial: 0.45 };
export const STICK_MIN_ITEMS = 2, STICK_AFTER_MS = 2 * 86_400_000, STICK_WITHIN_MS = 60 * 86_400_000;
export const STICK_DELAY_MS = 86_400_000;
// A targeted belief closes on later questions only from answers at least this long after it was targeted: a
// refuted misconception tends to come back after a delay, so right answers minutes later prove nothing.
export const MISC_CLOSE_AFTER_MS = 2 * 86_400_000;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const uuid = () => crypto.randomUUID();
const round3 = x => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------- validation (pure)

export const CHECKPOINT_KEYS = ['lesson_id', 'status', 'probe', 'steps', 'misconceptions', 'surface', 'kind', 'viva', 'phase', 'skip_viva', 'corrections'];
export const CORRECTIONS_KEPT = 6;
// final_case, teach_back, mo_rating, mo_rating_why, what_clicked and claude_view belong to the old ending (before 1 Nov):
// still taken, so an older skill's save still works and old lessons read as they were, but no longer asked for.
const KEYS = ['lesson_id', 'status', 'kind', 'goal', 'five_step', 'probe', 'steps', 'final_case', 'teach_back', 'mo_rating', 'mo_rating_why', 'what_clicked',
  'claude_view', 'questions_asked', 'tactics_used', 'content_type', 'link_id', 'items', 'weak_spot', 'misconceptions', 'card', 'miss_ids', 'media_shown',
  'summary', 'links', 'memory', 'mo_feedback', 'new_topic', 'surface', 'viva', 'phase', 'skip_viva', 'corrections'];
// Keys from before the redesign, refused with what to do instead.
const GONE = {
  warmup: 'There are no warm-ups any more (Anki does the spacing): leave warmup out.',
  checkback: 'There are no hub check-backs any more: later Anki reviews and questions show whether it stuck. Leave checkback out.',
  misconception: 'Use misconceptions: {add: [{belief, ref?}], closed: [id]}.',
};

const fix = (msg, field) => ({ fix: msg, field });
function only(obj, keys, where) {
  if (!isObj(obj)) return fix(`${where} is an object.`, where);
  const bad = Object.keys(obj).find(k => !keys.includes(k));
  return bad ? fix(`${where} has no field ${bad}${['outcome', 'minutes', 'blend'].includes(bad) ? ': code works that out' : ''}.`, `${where}.${bad}`) : null;
}
function list(v, max, where) {
  if (v == null) return null;
  if (!Array.isArray(v)) return fix(`${where} is a list.`, where);
  if (v.length > max) return fix(`${where} holds at most ${max}.`, where);
  return null;
}
const text = (v, max, where, required = false) => (v == null ? (required ? fix(`${where} is needed.`, where) : null)
  : str(v, max) ? null : fix(`${where} is text of at most ${max} characters.`, where));
const oneOf = (v, opts, where, required = false) => (v == null ? (required ? fix(`${where} is one of ${opts.join(', ')}.`, where) : null)
  : opts.includes(v) ? null : fix(`${where} is one of ${opts.join(', ')}.`, where));
const intOk = (v, where) => (v == null || (Number.isInteger(v) && v > 0) ? null : fix(`${where} is a whole number.`, where));
const intIn = (v, lo, hi, where) => (v == null || (Number.isInteger(v) && v >= lo && v <= hi) ? null : fix(`${where} is a whole number from ${lo} to ${hi}.`, where));
function missing(v, where) {
  const c = list(v, MISSING_MAX, where);
  if (c) return c;
  for (const m of v || []) if (!str(m, MISSING_LEN)) return fix(`${where} holds short key points he left out (at most ${MISSING_LEN} characters each).`, where);
  return null;
}

/** Every rule on lesson_save's arguments; null when they are fine, else {fix, field} naming one thing to change. */
export function checkSave(a) {
  if (!isObj(a)) return fix('lesson_save takes an object.', null);
  for (const k of Object.keys(a)) {
    if (GONE[k]) return fix(GONE[k], k);
    if (!KEYS.includes(k)) return fix(['outcome', 'minutes', 'blend'].includes(k) ? `Leave out ${k}: code works it out from what you record.` : `Unknown argument ${k}.`, k);
  }
  if (a.status === 'in_progress') {
    const later = Object.keys(a).find(k => !CHECKPOINT_KEYS.includes(k));
    if (later) return fix(`A checkpoint (status in_progress) holds the probe, steps and misconceptions so far: send ${later} in the final lesson_save.`, later);
    if (isObj(a.misconceptions) && a.misconceptions.closed != null) return fix('misconceptions.closed waits for the final lesson_save: closing is earned at the end.', 'misconceptions.closed');
  }
  const checks = [
    text(a.lesson_id, 40, 'lesson_id', true), oneOf(a.status, ['done', 'abandoned', 'in_progress'], 'status'), oneOf(a.kind, ['lesson', 'pair', 'pair_test', 'patch'], 'kind'),
    text(a.goal, 200, 'goal'), list(a.five_step, 2, 'five_step'), list(a.probe, 4, 'probe'), list(a.steps, 5, 'steps'), list(a.items, 4, 'items'),
    text(a.link_id, 40, 'link_id'), text(a.weak_spot, 200, 'weak_spot'), list(a.miss_ids, 10, 'miss_ids'),
    list(a.media_shown, 6, 'media_shown'), text(a.summary, 1200, 'summary'), list(a.links, 2, 'links'),
    text(a.mo_feedback, 200, 'mo_feedback'), oneOf(a.surface, ['voice', 'chat', 'code'], 'surface'),
    intIn(a.mo_rating, 1, 10, 'mo_rating'), text(a.mo_rating_why, 200, 'mo_rating_why'), text(a.what_clicked, 200, 'what_clicked'),
    intIn(a.questions_asked, 0, 50, 'questions_asked'), list(a.tactics_used, TACTICS_MAX, 'tactics_used'), oneOf(a.content_type, CONTENT_TYPES, 'content_type'),
    text(a.viva, VIVA.transcript_max, 'viva'), oneOf(a.phase, ['before', 'after'], 'phase'),
    a.skip_viva == null || typeof a.skip_viva === 'boolean' ? null : fix('skip_viva is true or false.', 'skip_viva'),
  ];
  for (const c of checks) if (c) return c;
  for (const s of a.five_step || []) if (!FIVE_STEPS.includes(s)) return fix(`five_step entries are ${FIVE_STEPS.join(', ')}.`, 'five_step');
  for (const t of a.tactics_used || []) if (!TACTIC_VOCAB.includes(t)) return fix(`tactics_used entries are ${TACTIC_VOCAB.join(', ')}.`, 'tactics_used');
  if (a.tactics_used && new Set(a.tactics_used).size !== a.tactics_used.length) return fix('tactics_used names each tactic once.', 'tactics_used');
  for (const [i, p] of (a.probe || []).entries()) {
    const w = `probe[${i}]`;
    const c = only(p, ['summary', 'result', 'from', 'ref'], w) || text(p.summary, 120, `${w}.summary`) || oneOf(p.result, PROBE_RESULTS, `${w}.result`, true)
      || oneOf(p.from, PROBE_FROM, `${w}.from`) || text(p.ref, 60, `${w}.ref`);
    if (c) return c;
  }
  for (const [i, s] of (a.steps || []).entries()) {
    const w = `steps[${i}]`;
    const c = only(s, ['title', 'check', 'repair_angle'], w) || text(s.title, 80, `${w}.title`) || oneOf(s.check, CHECKS, `${w}.check`, true) || text(s.repair_angle, 80, `${w}.repair_angle`);
    if (c) return c;
  }
  if (a.final_case != null) {
    const f = a.final_case;
    const c = only(f, ['result', 'confidence', 'explanation_judgement'], 'final_case') || oneOf(f.result, FINAL_RESULTS, 'final_case.result', true)
      || (f.confidence === null ? null : oneOf(f.confidence, CONFIDENCES, 'final_case.confidence'));
    if (c) return c;
    if (f.explanation_judgement != null) {
      const e = only(f.explanation_judgement, ['verdict', 'missing'], 'final_case.explanation_judgement')
        || oneOf(f.explanation_judgement.verdict, JUDGEMENTS, 'final_case.explanation_judgement.verdict', true) || missing(f.explanation_judgement.missing, 'final_case.explanation_judgement.missing');
      if (e) return e;
    }
  }
  if (a.teach_back != null) {
    const c = only(a.teach_back, ['judgement', 'missing', 'text'], 'teach_back') || oneOf(a.teach_back.judgement, JUDGEMENTS, 'teach_back.judgement', true) || missing(a.teach_back.missing, 'teach_back.missing')
      || text(a.teach_back.text, TEACH_BACK_TEXT_MAX, 'teach_back.text');
    if (c) return c;
    if (a.teach_back.text != null && looksLikeStem(a.teach_back.text)) return fix("teach_back.text reads like question text: keep only Mo's own explanation, in his words.", 'teach_back.text');
  }
  if (a.claude_view != null) {
    const c = only(a.claude_view, ['verdict', 'reasons'], 'claude_view') || oneOf(a.claude_view.verdict, CLAUDE_VIEWS, 'claude_view.verdict', true) || text(a.claude_view.reasons, 300, 'claude_view.reasons');
    if (c) return c;
  }
  for (const [i, it] of (a.items || []).entries()) {
    const w = `items[${i}]`;
    const c = only(it, ['case_for', 'said'], w) || oneOf(it.case_for, ['a', 'b'], `${w}.case_for`, true) || oneOf(it.said, ['a', 'b', 'unsure'], `${w}.said`, true);
    if (c) return c;
  }
  if (a.misconceptions != null) {
    const m = a.misconceptions;
    const c = only(m, ['add', 'closed', 'worked'], 'misconceptions') || list(m.add, 2, 'misconceptions.add') || list(m.closed, 4, 'misconceptions.closed')
      || list(m.worked, 3, 'misconceptions.worked');
    if (c) return c;
    for (const [i, b] of (m.add || []).entries()) {
      const d = only(b, ['belief', 'ref', 'words'], `misconceptions.add[${i}]`);
      if (d) return d;
      const e = checkBelief(b, `misconceptions.add[${i}]`);
      if (e) return fix(e.fix, `misconceptions.add[${i}]`);
    }
    for (const id of m.closed || []) if (!str(id, 40)) return fix('misconceptions.closed holds misconception ids (mc_…) from the brief.', 'misconceptions.closed');
    for (const id of m.worked || []) if (!str(id, 40)) return fix('misconceptions.worked holds the misconception ids (mc_…) you probed or planted.', 'misconceptions.worked');
  }
  if (a.card != null) {
    const c = only(a.card, ['note_id', 'card_id', 'action'], 'card') || intOk(a.card.note_id, 'card.note_id') || intOk(a.card.card_id, 'card.card_id')
      || oneOf(a.card.action, CARD_ACTIONS, 'card.action', true);
    if (c) return c;
  }
  for (const m of a.miss_ids || []) if (!str(m, 40)) return fix('miss_ids are miss ids from the brief, such as anki:200.', 'miss_ids');
  for (const m of a.media_shown || []) if (!str(m, 60)) return fix('media_shown holds media ids.', 'media_shown');
  for (const [i, l] of (a.links || []).entries()) {
    const w = `links[${i}]`;
    const c = only(l, ['type', 'other', 'a_vs_b', 'how', 'note'], w) || oneOf(l.type, LINK_TYPES, `${w}.type`, true) || text(l.other, 120, `${w}.other`, true)
      || text(l.a_vs_b, 240, `${w}.a_vs_b`) || text(l.how, 40, `${w}.how`) || text(l.note, 200, `${w}.note`);
    if (c) return c;
  }
  if (a.corrections != null) {
    const c = list(a.corrections, CORRECTIONS_PER_SAVE, 'corrections');
    if (c) return c;
    for (const [i, x] of a.corrections.entries()) {
      const e = checkCorrection(x, `corrections[${i}]`);
      if (e) return fix(e.fix, `corrections[${i}]`);
      if (looksLikeStem(x.wrong) || looksLikeStem(x.right)) return fix(`corrections[${i}] reads like question text: say the fact in your own words.`, `corrections[${i}]`);
    }
  }
  if (a.memory != null) {
    const c = only(a.memory, ['used', 'new'], 'memory') || list(a.memory.used, 6, 'memory.used') || list(a.memory.new, 2, 'memory.new');
    if (c) return c;
    for (const [i, u] of (a.memory.used || []).entries()) {
      const d = only(u, ['id', 'effect'], `memory.used[${i}]`) || text(u.id, 40, `memory.used[${i}].id`, true) || oneOf(u.effect, EFFECTS, `memory.used[${i}].effect`, true);
      if (d) return d;
    }
    for (const [i, n] of (a.memory.new || []).entries()) {
      const d = only(n, ['scope', 'scope_ref', 'tactic', 'note', 'from_mo'], `memory.new[${i}]`);
      if (d) return d;
      const e = checkNote(n);
      if (e) return fix(`memory.new[${i}]: ${e.fix}`, `memory.new[${i}]`);
      if (n.from_mo != null && typeof n.from_mo !== 'boolean') return fix(`memory.new[${i}].from_mo is true or false.`, `memory.new[${i}].from_mo`);
    }
  }
  if (a.new_topic != null) {
    const c = only(a.new_topic, ['name', 'kind', 'category_id', 'unit_id'], 'new_topic') || text(a.new_topic.name, 80, 'new_topic.name', true)
      || oneOf(a.new_topic.kind, TOPIC_KINDS, 'new_topic.kind', true) || text(a.new_topic.category_id, 60, 'new_topic.category_id', true) || text(a.new_topic.unit_id, 60, 'new_topic.unit_id');
    if (c) return c;
  }
  return null;
}

// ---------------------------------------------------------------- code decides (pure)

export const minutesOf = (startedAt, now) => (startedAt ? Math.min(MINUTES_CAP, Math.round(Math.max(0, now - startedAt) / 6000) / 10) : null);

export const IDLE_GAP_MS = 15 * 60_000;
export function activeMinutes(startedAt, endAt, points = []) {
  if (!startedAt) return null;
  const end = Math.max(startedAt, endAt);
  const at = [startedAt, ...points.filter(t => t > startedAt && t < end).sort((a, b) => a - b), end];
  let ms = 0;
  for (let i = 1; i < at.length; i++) ms += Math.min(IDLE_GAP_MS, at[i] - at[i - 1]);
  return Math.min(MINUTES_CAP, Math.round(ms / 6000) / 10);
}

/** The plain facts of a lesson, by code: checks right first time, repairs, checks failed twice, the probe, minutes. */
export function factsOf(a, minutes) {
  const steps = a.steps || [], probe = (a.probe || []).filter(p => p.result !== 'skipped');
  return {
    checks: steps.length, first_time: steps.filter(s => s.check === 'right').length, repairs: steps.filter(s => s.check === 'wrong_then_right').length,
    wrong_twice: steps.filter(s => s.check === 'wrong_twice').length, probe_n: probe.length, probe_right: probe.filter(p => p.result === 'right').length,
    minutes: minutes ?? null,
  };
}

const FINAL_VALUE = { right: { sure: 1, lean: 0.9, guess: 0.75, null: 0.9 }, partial: 0.5, wrong: 0, skipped: 0 };
const JUDGED = { complete: 1, partial: 0.5, wrong: 0 };

export function blendOf(a, facts, { capMinutes = 10, viva = null } = {}) {
  const f = a.final_case || null;
  const fr = f ? f.result : null;
  const parts = {};
  // The viva-first lesson: with a closing viva marked and no final case, the two vivas decide (vivaOutcome), and the
  // final case's part and gate drop out.
  const vAfter = viva && viva.after != null && Number.isFinite(Number(viva.after)) ? Number(viva.after) : null;
  const vBefore = viva && viva.before != null && Number.isFinite(Number(viva.before)) ? Number(viva.before) : null;
  const byViva = vAfter != null && !fr;
  if (vAfter != null) {
    parts.viva = round3(vAfter);
    if (vBefore != null) parts.viva_gain = round3(Math.max(0, Math.min(1, (vAfter - vBefore) / Math.max(0.2, 1 - vBefore))));
  }
  if (!byViva) parts.final_case = fr === 'right' ? FINAL_VALUE.right[f.confidence ?? 'null'] ?? 0.9 : fr ? FINAL_VALUE[fr] : 0;
  const ej = f && f.explanation_judgement && f.explanation_judgement.verdict;
  if (ej && ej !== 'none') parts.explanation = JUDGED[ej];
  const tb = a.teach_back && a.teach_back.judgement;
  if (tb && tb !== 'none') parts.teach_back = JUDGED[tb];
  if (Number.isInteger(a.mo_rating)) parts.mo_rating = round3((a.mo_rating - 1) / 9);
  const firstTime = facts.checks ? facts.first_time / facts.checks : null;
  const pace = facts.minutes == null || !capMinutes ? null : facts.minutes <= capMinutes ? 1 : Math.max(0, 1 - (facts.minutes - capMinutes) / capMinutes);
  if (firstTime != null || pace != null) parts.speed = round3(firstTime != null && pace != null ? 0.6 * firstTime + 0.4 * pace : firstTime ?? pace);
  if (Number.isInteger(a.questions_asked)) parts.questions = round3(1 / (1 + a.questions_asked / 3));
  const used = Object.keys(parts);
  const total = used.reduce((s, k) => s + BLEND_W[k], 0);
  const weights = Object.fromEntries(used.map(k => [k, round3(BLEND_W[k] / total)]));
  const blend = round3(used.reduce((s, k) => s + parts[k] * BLEND_W[k], 0) / total);
  let outcome = blend >= OUTCOME_AT.landed ? 'landed' : blend >= OUTCOME_AT.partial ? 'partial' : 'not_landed';
  const gates = [];
  if (byViva) return { blend, outcome: vivaOutcome(vBefore, vAfter), parts, weights, gates, by: 'viva' };
  if (fr !== 'right' && fr !== 'partial') { if (outcome !== 'not_landed') gates.push('final case not right'); outcome = 'not_landed'; }
  const capPartial = why => { if (outcome === 'landed') { outcome = 'partial'; gates.push(why); } };
  if (fr === 'partial') capPartial('final case partly right');
  if (facts.wrong_twice > 0) capPartial('a check failed twice');
  if (tb === 'wrong') capPartial('teach-back judged wrong');
  if (fr === 'right' && ej === 'wrong') capPartial('right answer, wrong reason');
  if (fr === 'right' && f.confidence === 'guess') capPartial('final case guessed');
  const judged = [ej, tb].filter(v => v && v !== 'none');
  if (judged.length && !judged.includes('complete')) capPartial('no explanation judged complete');
  if (Number.isInteger(a.mo_rating) && a.mo_rating <= 4) capPartial(`Mo rated it ${a.mo_rating}`);
  return { blend, outcome, parts, weights, gates };
}
const REWARD_PARTS = ['final_case', 'explanation', 'teach_back', 'mo_rating', 'items', 'viva', 'viva_gain'];
export function tacticReward(b) {
  if (!b || b.blend == null) return null;
  const used = Object.keys(b.parts || {}).filter(k => REWARD_PARTS.includes(k));
  if (!used.length) return b.blend;
  const w = k => BLEND_W[k] ?? 1;
  return round3(used.reduce((s, k) => s + b.parts[k] * w(k), 0) / used.reduce((s, k) => s + w(k), 0));
}
/** The outcome alone (pure), as blendOf gives it. */
export const outcomeOf = (a, { minutes = null, capMinutes = 10 } = {}) => blendOf(a, factsOf(a, minutes), { capMinutes }).outcome;

// Pair-lesson items (not order-checked): right when said equals case_for; unsure is wrong.
export const markFree = items => (items || []).map(it => ({ case_for: it.case_for, said: it.said, right: it.said === it.case_for }));

// Event before/after from its row, as events.js eventRow would, so events stay right whatever order rows go in.
function pin(e, r) {
  if (!r || e.before !== undefined) return e;
  const before = r.before == null ? null : { ...r.key, ...r.before };
  const emptySoft = r.op === 'soft_delete' && !(isObj(r.after) && Object.keys(r.after).length);
  const after = r.op === 'delete' || (emptySoft && !SOFT[r.table]) ? null : { ...r.key, ...(emptySoft ? softFields(r.table) : r.after || {}) };
  return { ...e, before, after };
}
// Rows and events from another planner (links-store) whose events pair with its rows by index.
function pinned(part) {
  return { rows: part.rows || [], events: (part.events || []).map((e, i) => pin(e, (part.rows || [])[i])) };
}

export function withStored(a, lesson) {
  if (!lesson || lesson.status !== 'done') return a;
  const v = { ...a };
  if (v.final_case === undefined && lesson.final_result) {
    const ej = parse(lesson.final_explain_json, null);
    v.final_case = { result: lesson.final_result, confidence: lesson.final_conf || null, ...(ej ? { explanation_judgement: ej } : {}) };
  }
  const json = { teach_back: 'teach_back_json', claude_view: 'claude_view_json', tactics_used: 'tactics_json', probe: 'probe_json', steps: 'steps_json' };
  for (const [k, col] of Object.entries(json)) if (v[k] === undefined && lesson[col]) { const x = parse(lesson[col], null); if (x != null) v[k] = x; }
  for (const k of ['mo_rating', 'mo_rating_why', 'what_clicked', 'questions_asked', 'content_type']) if (v[k] === undefined && lesson[k] != null) v[k] = lesson[k];
  return v;
}

// A list that starts with the stored list's first entry (by its title or summary) is the lesson's list from the start:
// its entries replace the stored ones in order, and stored ones past its end stay. Any other list is the entries after
// the stored ones (the newest step alone). Either way of sending keeps every check once.
const itemKey = x => (isObj(x) && (x.title || x.summary) ? norm(x.title || x.summary) : JSON.stringify(x));
export function mergeList(stored, given, max) {
  const s = Array.isArray(stored) ? stored : [];
  if (!Array.isArray(given) || !given.length) return s.slice(0, max);
  if (!s.length || itemKey(given[0]) === itemKey(s[0])) return [...given, ...s.slice(given.length)].slice(0, max);
  return [...s, ...given].slice(0, max);
}
const checkpointOf = lesson => (lesson && parse(lesson.checkpoint_json, null)) || {};
// The lessons a checkpoint wrote to: running, or closed by the 3-hour job (the old job closed them with nothing kept).
const checkpointed = lesson => !!lesson && (lesson.status === 'in_progress' || (lesson.status === 'abandoned' && lesson.abandon_reason === 'timeout'));

/**
 * A save on a lesson its checkpoints wrote to merges what they hold (pure): the probe and steps (mergeList), the
 * misconceptions found (add, at most 2, each belief once) and worked (at most 3). This call's fields come first.
 */
export function withCheckpoint(a, lesson) {
  if (!checkpointed(lesson)) return a;
  const v = { ...a, probe: mergeList(parse(lesson.probe_json, []), a.probe, 4), steps: mergeList(parse(lesson.steps_json, []), a.steps, 5) };
  const kept = checkpointOf(lesson).misconceptions || {}, m = isObj(a.misconceptions) ? a.misconceptions : {};
  const add = [];
  for (const b of [...(kept.add || []), ...(m.add || [])]) if (isObj(b) && !add.some(x => norm(x.belief) === norm(b.belief))) add.push(b);
  const worked = [...new Set([...(kept.worked || []), ...(m.worked || [])])];
  if (add.length || worked.length || a.misconceptions !== undefined) {
    v.misconceptions = { ...m, ...(add.length ? { add: add.slice(0, 2) } : {}), ...(worked.length ? { worked: worked.slice(0, 3) } : {}) };
  }
  const corr = mergeCorrections(checkpointOf(lesson).corrections, a.corrections);
  if (corr.length) v.corrections = corr;
  return v;
}

// The corrections a checkpoint kept and this call's, each correct line once (pure).
export function mergeCorrections(kept, given) {
  const out = [];
  for (const c of [...(Array.isArray(kept) ? kept : []), ...(Array.isArray(given) ? given : [])]) {
    if (isObj(c) && typeof c.right === 'string' && !out.some(x => norm(x.right) === norm(c.right))) out.push({ wrong: c.wrong, right: c.right, ...(c.source ? { source: c.source } : {}) });
  }
  return out.slice(0, CORRECTIONS_KEPT);
}

/** What a lesson's checkpoints kept, in words ('probe and 2 checks'), or null when they kept nothing (pure). */
export function keptLine(probe, steps, beliefs = 0) {
  const p = (probe || []).filter(x => x && x.result !== 'skipped').length, n = (steps || []).length;
  const bits = [p ? (p === 1 ? 'probe' : `${p} probe answers`) : null, n ? `${n} check${n === 1 ? '' : 's'}` : null,
    beliefs ? `${beliefs} wrong belief${beliefs === 1 ? '' : 's'}` : null].filter(Boolean);
  return bits.length ? bits.length === 1 ? bits[0] : `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}` : null;
}

// ---------------------------------------------------------------- reads

async function readLesson(env, user, id) {
  try {
    return await env.DB.prepare(`SELECT * FROM lessons WHERE user_id = ? AND id = ?`).bind(user, id).first();
  } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
}

// Everything else the plan needs, in one batch: the topics, misses, outbox keys, live notes, the summary note,
// card links, the category, the pair's taught time, the misconceptions it may touch, the tactic scores, earlier
// lessons with later evidence (the stick check), and targeted misconceptions with later answers (the auto-close).
async function readFor(env, user, lesson, a, now) {
  const q = (sql, ...x) => env.DB.prepare(sql).bind(...x);
  const missIds = JSON.stringify([...new Set([...(a.miss_ids || []), ...parse(lesson.miss_ids_json, [])])].slice(0, 20));
  const newTopicId = a.new_topic ? slugId(user, a.new_topic.name) : null;
  const topicIds = JSON.stringify([lesson.topic_id, lesson.pair_topic_id, newTopicId].filter(Boolean));
  const miscIds = JSON.stringify([...new Set([...parse(lesson.misc_ids_json, []), ...((a.misconceptions && a.misconceptions.closed) || [])])].slice(0, 20));
  // topic_notes (ONE) and card_topics (PAN) may land after teach: what is missing is left out, never fatal.
  const has = await tablesPresent(env, user, ['topic_notes', 'card_topics', 'misconceptions', 'tactic_scores']);
  const none = () => q(`SELECT NULL AS id WHERE 0 AND ? = ?`, user, lesson.id);
  const res = await env.DB.batch([
    q(`SELECT t.id, t.name, t.category_id, t.status, s.t, s.band FROM topics t LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
       WHERE t.user_id = ? AND t.id IN (SELECT value FROM json_each(?))`, user, topicIds),
    q(`SELECT id, label, error_type, anki_mistake_id, held, topic_id, sitting_id, reviewed_at, reviewed_by FROM misses WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`, user, missIds),
    q(`SELECT idem_key FROM outbox WHERE idem_key LIKE ?`, `lesson:${lesson.id}:%`),
    q(`SELECT id, scope, scope_ref, tactic, note, status, uses, wins, losses, score, evidence_json, created_at, updated_at FROM teach_memory
       WHERE user_id = ? AND status IN ('active','pinned') LIMIT 500`, user),
    has.has('topic_notes') ? q(`SELECT id, body, title, status, card_id FROM topic_notes WHERE user_id = ? AND id = ?`, user, `ls_${lesson.id}`) : none(),
    has.has('card_topics') ? q(`SELECT card_id, topic_id, match, strong, removed_at FROM card_topics WHERE user_id = ? AND card_id = ?`, user, (a.card && a.card.card_id) || -1) : none(),
    q(`SELECT id FROM categories WHERE user_id = ? AND id = ?`, user, (a.new_topic && a.new_topic.category_id) || ''),
    // The newest finished lesson on either side of a pair today (links-store's taught_at: same-day right answers count less).
    q(`SELECT max(ended_at) AS at FROM lessons WHERE user_id = ?1 AND status = 'done' AND day = ?2 AND id != ?3
       AND (topic_id IN (SELECT value FROM json_each(?4)) OR pair_topic_id IN (SELECT value FROM json_each(?4)))`,
    user, londonDay(now), lesson.id, JSON.stringify([lesson.topic_id, lesson.pair_topic_id].filter(Boolean))),
    has.has('misconceptions') ? q(`SELECT * FROM misconceptions WHERE user_id = ?1 AND (topic_id IN (SELECT value FROM json_each(?2)) OR id IN (SELECT value FROM json_each(?3)))
       ORDER BY last_seen DESC LIMIT 100`, user, topicIds, miscIds) : none(),
    has.has('tactic_scores') ? q(`SELECT content_type, tactic, wins, losses, uses, clicked_n, last_used_at, updated_at FROM tactic_scores WHERE user_id = ? LIMIT 100`, user) : none(),
    // "Did it stick" (LRN3-5): each later observation counts once (the lesson card's own lapse is FAIL_SQL's card
    // lapse, never twice), the lesson's own card reviewed past its learning steps without a lapse counts half a pass,
    // and the minimum is in distinct observations, so one lapse alone never decides it. Every row of the lesson's own
    // card (its state, its lapses, its review checks) is one observation (LRN4-4: a young card and then one lapse is
    // still only the card).
    q(`SELECT l.id, l.topic_id, l.topic_name, l.content_type, l.tactics_json, l.stick_json, l.ended_at, l.updated_at,
         coalesce(sum(${PASS_SQL} + CASE WHEN e.kind = 'card_young' AND e.card_id = l.card_id THEN 0.5 ELSE 0 END), 0) AS pass,
         coalesce(sum(${FAIL_SQL}), 0) AS fail,
         count(DISTINCT CASE WHEN ${PASS_SQL} > 0 OR ${FAIL_SQL} > 0 OR (e.kind = 'card_young' AND e.card_id = l.card_id)
           THEN (CASE WHEN l.card_id IS NOT NULL AND e.card_id = l.card_id THEN 'lessoncard' ELSE e.obs_key END) END) AS n
       FROM lessons l JOIN evidence e ON e.user_id = l.user_id AND e.topic_id = l.topic_id AND e.slot = 0 AND e.held = 0 AND e.source <> 'lesson' AND e.at >= l.ended_at + ${STICK_DELAY_MS}
       WHERE l.user_id = ?1 AND l.status = 'done' AND l.id <> ?2 AND l.stick_json IS NULL AND l.ended_at <= ?3 AND l.ended_at >= ?4
         AND l.content_type IS NOT NULL AND l.tactics_json IS NOT NULL AND l.tactics_json NOT IN ('[]','')
       GROUP BY l.id ORDER BY l.ended_at LIMIT 20`, user, lesson.id, now - STICK_AFTER_MS, now - STICK_WITHIN_MS),
    has.has('misconceptions') ? q(`SELECT m.*,
         (SELECT count(*) FROM evidence e WHERE e.user_id = m.user_id AND e.topic_id = m.topic_id AND e.slot = 0 AND e.held = 0
           AND e.at >= max(m.targeted_at, coalesce(m.last_seen, 0)) + ?2 AND e.kind = 'question' AND e.result = 'right') AS right_n,
         (SELECT count(*) FROM evidence e WHERE e.user_id = m.user_id AND e.topic_id = m.topic_id AND e.slot = 0 AND e.held = 0
           AND e.at > max(m.targeted_at, coalesce(m.last_seen, 0))
           AND ((e.kind = 'question' AND e.result IN ('wrong','flawed','omitted')) OR (e.kind = 'retest' AND coalesce(e.outcome, e.result) IN ('missed_again','missed','wrong'))
             OR e.kind = 'gap_stated' OR (e.kind IN ('lesson_probe','lesson_check','lesson_final') AND e.result = 'wrong'))) AS wrong_n
       FROM misconceptions m WHERE m.user_id = ?1 AND m.status = 'targeted' AND m.topic_id IS NOT NULL AND m.targeted_at IS NOT NULL ORDER BY m.targeted_at LIMIT 30`, user, MISC_CLOSE_AFTER_MS) : none(),
    q(`SELECT at FROM map_events WHERE user_id = ?1 AND actor = 'claude' AND at > ?2 AND at < ?3
       UNION ALL SELECT at FROM gaps WHERE user_id = ?1 AND at > ?2 AND at < ?3 ORDER BY 1 LIMIT 300`,
    user, lesson.started_at || now, lesson.status === 'done' && lesson.ended_at ? lesson.ended_at : now),
  ]);
  const [topics, misses, outbox, notes, note, cardTopics, cats, taught, miscs, tactics, stuck, targeted, active] = res.map(r => r.results || []);
  return { topics: new Map(topics.map(t => [t.id, t])), misses, outbox: new Set(outbox.map(o => o.idem_key)), notes, memory: new Map(notes.map(m => [m.id, m])),
    note: note[0] || null, cardTopics, categoryOk: cats.length > 0, newTopicId, has, taughtAt: (taught[0] && taught[0].at) || null,
    misconceptions: miscs, tactics: new Map(tactics.map(r => [`${r.content_type}|${r.tactic}`, r])), stuck, targeted, activeAt: active.map(r => Number(r.at)).filter(Number.isFinite) };
}

// ---------------------------------------------------------------- the planner

const evBase = (lesson, topicId, now, day) => ({ at: now, day, source: 'lesson', source_ref: `lesson:${lesson.id}`, lesson_id: lesson.id, topic_id: topicId, created_by: 'claude' });

/**
 * Planner for op lesson.save. Returns {rows, events, evidence, touched_topics, refs, count: 1, summary, reply} or
 * {refuse, field}. A lesson is free (decision 4) however many rows it writes, so count is 1.
 */
async function refQuestions(env, user, refs) {
  const { hubQuestionsOfRef } = await import('./resolve.js');
  const out = [];
  for (const r of [...new Set((refs || []).filter(x => typeof x === 'string' && x.trim()))].slice(0, 4)) {
    try { out.push(...await hubQuestionsOfRef(env, user, r)); } catch (e) { if (!noTable(e)) throw e; }
  }
  return out.slice(0, 20);
}

function planCheckpoint(lesson, args, now) {
  if (lesson.status !== 'in_progress') {
    return { noop: true, summary: lesson.status === 'done' ? 'That lesson is already saved.' : 'That lesson was closed; carry on and end it with lesson_save as usual.' };
  }
  const A = withCheckpoint(args, lesson);
  const cp = checkpointOf(lesson);
  const mc = A.misconceptions ? Object.fromEntries(['add', 'worked'].filter(k => A.misconceptions[k]).map(k => [k, A.misconceptions[k]])) : cp.misconceptions || null;
  const viva = !!(typeof args.viva === 'string' || args.phase || cp.viva);
  const corrections = mergeCorrections(cp.corrections, args.corrections);
  // Without migration 0042's column the probe and steps are still kept; the misconceptions wait for the final save.
  const after = { probe_json: JSON.stringify(A.probe), steps_json: JSON.stringify(A.steps),
    ...('checkpoint_json' in lesson ? { checkpoint_json: JSON.stringify({ at: now, n: (Number(cp.n) || 0) + 1, ...(mc ? { misconceptions: mc } : {}), ...(viva ? { viva: 1 } : {}),
      ...(corrections.length ? { corrections } : {}) }) } : {}), updated_at: now };
  const row = { table: 'lessons', op: 'update', key: { id: lesson.id }, before: Object.fromEntries(Object.keys(after).map(k => [k, lesson[k] ?? null])), after };
  const summary = `Lesson on ${lesson.topic_name || 'a topic'}: progress saved`.slice(0, 160);
  return { rows: [row], events: [pin({ kind: 'lesson.saved', target_type: 'lesson', target_id: lesson.id, topic_id: lesson.topic_id || null, undoable: false, summary }, row)],
    count: 1, summary, reply: { checkpoint: { probe: A.probe.length, steps: A.steps.length, misconceptions: ((mc && mc.add) || []).length, ...(viva ? { viva: true } : {}),
      ...(corrections.length ? { corrections: corrections.length } : {}) } } };
}

export async function planLessonSave(env, user, args, ctx) {
  const bad = checkSave(args);
  if (bad) return { refuse: bad.fix, field: bad.field };
  const now = ctx.now || Date.now();
  const lesson = await readLesson(env, user, args.lesson_id);
  if (!lesson) return { refuse: 'No lesson has that id: use the lesson_id teach_next gave.', field: 'lesson_id' };
  if (args.kind && args.kind !== lesson.kind) return { refuse: `This lesson is a ${lesson.kind}, not a ${args.kind}.`, field: 'kind' };
  if (lesson.status === 'requested') return { refuse: 'That lesson was only requested; start it with teach_next first.', field: 'lesson_id' };
  if (args.status === 'in_progress') return planCheckpoint(lesson, args, now);
  // The 3-hour close (op lesson.close): a running lesson its checkpoints wrote to, closed as stopped where it stopped.
  const closing = !!ctx.closing;
  if (closing && lesson.status !== 'in_progress') return { noop: true, summary: 'That lesson is no longer running.' };
  const lastAt = closing ? Math.min(now, Math.max(Number(lesson.started_at) || 0, Number(checkpointOf(lesson).at) || Number(lesson.updated_at) || 0)) || now : now;
  const today = londonDay(lastAt);
  const A = withCheckpoint(withStored(args, lesson), lesson);   // what was recorded and checkpointed, this call's fields first

  const data = await readFor(env, user, lesson, args, now);
  const usedIds = new Set([...parse(lesson.memory_used_json, []).map(u => u && u.id), ...((args.memory && args.memory.used) || []).map(u => u.id)]);
  const memoryMissing = lesson.status === 'done' || args.status === 'abandoned' || closing ? []
    : parse(lesson.memory_brought_json, []).filter(id => data.memory.has(id) && !usedIds.has(id));
  const voice = (args.surface || lesson.surface || ctx.surface) === 'voice';
  if (memoryMissing.length && !voice) {
    return { refuse: `memory.used needs each pinned note the brief brought in: add ${memoryMissing.map(id => `{id: "${id}", effect}`).join(', ')}`
      + ' (effect helped, neutral or hurt; neutral when you did not lean on it), then call lesson_save again.', field: 'memory.used' };
  }
  const rows = [], events = [], evidence = [], links = [];
  const add = (row, event) => { rows.push(row); if (event) events.push(pin(event, row)); };

  // The topic: the lesson's, or one made now from new_topic ("teach me X" not on the map).
  let topicId = lesson.topic_id;
  let topicName = (data.topics.get(topicId) || {}).name || lesson.topic_name;
  if (!topicId && args.new_topic) {
    const id = data.newTopicId;
    const existing = data.topics.get(id);
    if (existing && existing.status !== 'retired' && existing.status !== 'merged') topicId = id;
    else if (existing) return { refuse: `${existing.name} is ${existing.status} on the map; ask Mo which topic this was.`, field: 'new_topic.name' };
    else {
      if (!data.categoryOk) return { refuse: 'new_topic.category_id is not a category on the map (map_rules lists them).', field: 'new_topic.category_id' };
      const nt = args.new_topic;
      const naming = namingProblem(nt.name, nt.kind);
      if (naming) return { refuse: naming, field: 'new_topic.name' };
      add({ table: 'topics', op: 'insert', key: { id }, after: { name: nt.name.trim(), kind: nt.kind, status: 'confirmed', category_id: nt.category_id,
        unit_id: nt.unit_id || null, source: 'lesson', source_ref: `lesson:${lesson.id}`, created_by: 'claude', created_at: now, updated_at: now,
        confirmed_at: now, confirmed_by: 'claude' } },
      { kind: 'topic.added', target_type: 'topic', target_id: id, topic_id: id, summary: `New topic from a lesson: ${nt.name.trim()}`.slice(0, 160) });
      const key = norm(nt.name);
      if (key) add({ table: 'topic_aliases', op: 'insert', key: { alias_key: key, topic_id: id }, after: { alias: nt.name.trim(), kind: 'name', status: 'active',
        source: 'lesson', source_ref: `lesson:${lesson.id}`, created_by: 'claude', created_at: now } },
      { kind: 'alias.added', target_type: 'alias', target_id: key, topic_id: id, summary: `Name for ${nt.name.trim()}`.slice(0, 160) });
      topicId = id;
    }
    topicName = args.new_topic.name.trim();
  }

  const kind = lesson.kind;
  const finalGiven = !!(A.final_case && A.final_case.result && A.final_case.result !== 'skipped');
  const vivas = kind === 'lesson' || kind === 'pair' ? await lessonVivaStates(env, user, lesson.id) : { before: null, after: null };
  const closingIn = !!(vivas.after && ['pending', 'graded'].includes(vivas.after.status));
  const closingPending = !!(vivas.after && vivas.after.status === 'pending');
  const vivaScores = { before: vivas.before && vivas.before.status === 'graded' ? vivas.before.coverage : null,
    after: vivas.after && vivas.after.status === 'graded' ? vivas.after.coverage : null };
  const stopped = !closing && (args.status || 'done') === 'done' && kind !== 'pair_test' && !finalGiven && !closingIn;
  // The 3-hour close of a lesson whose closing viva was marked (the final save never came): it ended, so it is done.
  const closedByViva = closing && !!(vivas.after && vivas.after.status === 'graded');
  const status = closedByViva ? 'done' : stopped || closing ? 'abandoned' : args.status || 'done';
  const done = status === 'done';
  const kept = done || stopped || closing;
  const misses = data.misses;
  const missIds = (args.miss_ids && args.miss_ids.length ? args.miss_ids : parse(lesson.miss_ids_json, [])).filter(id => misses.some(m => m.id === id));
  const base = evBase(lesson, topicId, lastAt, today);
  const already = lesson.status === 'done';
  const endedAt = already && lesson.ended_at ? lesson.ended_at : lastAt;
  const minutes = activeMinutes(lesson.started_at, endedAt, data.activeAt);
  const urow = kind === 'pair_test' || closing ? null : await userRow(env, user).catch(() => null);
  const minutesPref = kind === 'pair_test' || closing ? 0 : Number(((await getPrefs(env, user, urow || undefined).catch(() => ({}))).teach || {}).lesson_minutes);
  const own = urow ? phaseOf(await profileFor(env, user, urow), lesson.day || today) : null;
  const capMinutes = kind === 'pair_test' ? 3 : minutesPref > 0 ? minutesPref
    : own && own.laneless ? own.phase.lesson_minutes : phaseFor(daysLeft(lesson.day || today, await readExamDay(env).catch(() => null))).lesson_minutes;
  const facts = factsOf(A, minutes);

  // The outcome by code, from both views (pair tests from the marked items, through links-store).
  let outcome = null, marks = null, pairPart = null, link = null, blend = null;
  if (done) {
    if (kind === 'pair_test') {
      const linkId = lesson.link_id || args.link_id;
      if (!linkId) return { refuse: 'This pair test has no link; call teach_next with mode pair_test again.', field: 'link_id' };
      if (!(args.items && args.items.length === 4)) return { refuse: 'A pair test records exactly 4 items, in the order teach_next gave.', field: 'items' };
      pairPart = await applyPairTest(env, user, { lesson_id: lesson.id, link_id: linkId, kind: 'pair_test', items: args.items, at: now, taught_at: data.taughtAt }, { ...ctx, now });
      if (pairPart.error) return { refuse: pairPart.error, field: 'items' };
      ({ outcome, marks, link } = pairPart);
      blend = { blend: round3((pairPart.right_n ?? 0) / 4), outcome, parts: { items: round3((pairPart.right_n ?? 0) / 4) }, weights: { items: 1 }, gates: [] };
    } else if (closingPending && !finalGiven) {
      blend = null; outcome = null;   // the mark comes in a minute: op viva.grade writes the outcome then
      // A pair lesson's minimal pairs are kept (items_json), so that outcome still counts them (viva.js withPairItems).
      if (kind === 'pair') marks = args.items && args.items.length ? markFree(args.items) : null;
    } else {
      blend = blendOf(A, facts, { capMinutes, viva: vivaScores });
      outcome = blend.outcome;
      if (kind === 'pair') {
        marks = args.items && args.items.length ? markFree(args.items) : null;
        // A viva-first pair lesson: the vivas decide, then its minimal pairs (under two in three right caps it at partial).
        if (blend.by === 'viva' && marks) {
          const capped = withPairItems(outcome, marks);
          if (capped !== outcome) { blend.gates.push(capped === 'not_landed' ? 'no minimal pair right' : 'minimal pairs under two in three right'); outcome = blend.outcome = capped; }
        }
        const linkId = lesson.link_id || args.link_id;
        if (linkId) {
          pairPart = await applyPairTest(env, user, { lesson_id: lesson.id, link_id: linkId, kind: 'pair', outcome, at: now }, { ...ctx, now });
          if (pairPart.error) pairPart = null;
          else link = pairPart.link;
        }
      }
    }
  }
  if (pairPart) { const p = pinned(pairPart); rows.push(...p.rows); events.push(...p.events); }

  // Raw evidence (status done, or stopped before the final case; a placed topic): probe, checks, final, pair items.
  // Weakness sets the masses.
  // The part each row is about (wave 3, facets.js): its own words (a step check's title, a probe's summary) when they say,
  // else the lesson's five_step when those name one part; no facet otherwise.
  const lessonFacet = facetOfSteps(A.five_step || parse(lesson.five_step, []));
  // A cluster lesson (0071, clusters.js): each step check counts on the member it names (else the root), and its vivas on
  // every member (viva.js clusterVivaEvidence), so the lesson is saved against the whole group.
  const cluster = lesson.cluster_id ? await readCluster(env, user, lesson.cluster_id).catch(() => null) : null;
  const stepTopic = title => (cluster && topicId ? memberOfText(cluster.members, title, topicId) : topicId);
  const withFacet = (d, words) => { const f = facetOfQuestion(words) || lessonFacet; return JSON.stringify(f ? { ...d, facet: f } : d); };
  const counted = [];   // what this lesson counted against the topic (the reply and Recent activity say it)
  if (kept && topicId) {
    (A.probe || []).forEach((p, i) => {
      if (p.result === 'skipped') return;
      const gap = p.from === 'gap' && p.ref ? String(p.ref).replace(/^gap:/, '') : null;
      evidence.push({ ...base, obs_key: `lesson:${lesson.id}:probe:${i + 1}`, slot: 0, kind: 'lesson_probe', result: p.result, gap_id: gap,
        detail_json: withFacet({ label: `lesson probe ${i + 1}`, from: p.from || null }, p.summary) });
      if (p.from === 'new' && p.result === 'wrong') counted.push('probe');
    });
    (A.steps || []).forEach((s, i) => {
      evidence.push({ ...base, topic_id: stepTopic(s.title), obs_key: `lesson:${lesson.id}:check:${i + 1}`, slot: 0, kind: 'lesson_check',
        result: s.check === 'right' ? 'right' : s.check === 'wrong_then_right' ? 'partial' : 'wrong', detail_json: withFacet({ label: `lesson check ${i + 1}` }, s.title) });
      if (s.check === 'wrong_twice') counted.push('check');
    });
    if (args.final_case && args.final_case.result !== 'skipped' && kind !== 'pair_test') {
      // A right answer explained wrong counts as partial on the map, never as a pass.
      const why = args.final_case.explanation_judgement && args.final_case.explanation_judgement.verdict;
      evidence.push({ ...base, obs_key: `lesson:${lesson.id}:final`, slot: 0, kind: 'lesson_final',
        result: args.final_case.result === 'right' && why === 'wrong' ? 'partial' : args.final_case.result,
        confidence: args.final_case.confidence || null, detail_json: withFacet({ label: 'lesson final case' }, null) });
    }
    // The teach-back (wave 3): judged wrong counts as a miss after the teaching (partial: half); complete earns nothing.
    const tb = A.teach_back && A.teach_back.judgement;
    if (tb && tb !== 'none' && kind !== 'pair_test') {
      evidence.push({ ...base, obs_key: `lesson:${lesson.id}:teachback`, slot: 0, kind: 'lesson_teachback',
        result: tb === 'complete' ? 'right' : tb, detail_json: withFacet({ label: 'lesson teach-back' }, (A.teach_back.missing || []).join('; ')) });
      if (tb === 'wrong' || tb === 'partial') counted.push(tb === 'wrong' ? 'teachback' : 'teachback_partial');
    }
    if (marks && link) {
      // A pair test's four cases are its evidence (pair_item). A pair lesson's practice pairs are checks inside the
      // teaching, kept for the record like its step checks, with no mass (LRN4-5): one wrong practice pair never
      // leaves the partner weaker than no lesson at all.
      const itemKind = kind === 'pair_test' ? 'pair_item' : 'lesson_check';
      marks.forEach((m, i) => {
        const caseTopic = m.case_for === 'a' ? link.from_id : link.to_id, other = m.case_for === 'a' ? link.to_id : link.from_id;
        const result = m.right ? 'right' : m.said === 'unsure' ? 'unsure' : 'wrong';
        for (const [slot, t] of [[0, caseTopic], [1, other]]) {
          evidence.push({ ...base, topic_id: t, obs_key: `lesson:${lesson.id}:pair:${i + 1}`, slot, kind: itemKind, result,
            detail_json: JSON.stringify({ label: `pair case ${i + 1}`, link_id: link.id, said: m.said }) });
        }
      });
    }
  }

  const outbox = [];
  let retestReply = null;
  if (done && topicId && kind !== 'pair_test') {
    const rt = await lessonRetests(env, user, { topicId, lessonId: lesson.id, today: londonDay(endedAt) });
    const part = lessonParts({ lesson, topicId, topicName, final: args.final_case ? args.final_case.result : null, outcome, rt, now, today: londonDay(endedAt) });
    part.rows.forEach((row, i) => add(row, part.events[i]));
    for (const o of part.outbox) {
      const idem = `lesson:${lesson.id}:retest:${o.miss_id}`;
      if (!data.outbox.has(idem)) outbox.push({ kind: 'anki_retest', idem, payload: { user, miss_id: o.miss_id, result: o.result, day: londonDay(endedAt) } });
    }
    const closed = part.rows.filter(r => r.table === 'retests' && r.op === 'update').length;
    const booked = part.rows.filter(r => r.table === 'retests' && r.op === 'insert').map(r => r.after.due);
    // What Claude reads says "card from a miss", never "re-test" (1 Nov 2026).
    if (closed || booked.length) retestReply = { closed, ...(booked.length ? { booked } : {}),
      line: `The final case checked ${closed === 1 ? '1 earlier miss' : `${closed} earlier misses`} on this topic again.` };
  }

  // The card: card_topics (Claude's match, strong) and the outbox link to each non-slip miss.
  const card = args.card || null;
  // The card the lessons row records: this call's, else what an earlier save of this lesson recorded (a re-save
  // that leaves card out keeps it, so L9's 7-day rest after a card is not lost; RH2-6).
  const cardCols = args.card !== undefined
    ? { card_note_id: (card && card.note_id) || null, card_id: (card && card.card_id) || null, card_action: card ? card.action : null }
    : { card_note_id: lesson.card_note_id ?? null, card_id: lesson.card_id ?? null, card_action: lesson.card_action ?? null };
  // Never onto a root-cause topic (a lesson on a foundation concept): the card's own words place it (card-roots.js).
  const cardTopic = data.topics.get(topicId) || (args.new_topic && data.newTopicId === topicId ? { category_id: args.new_topic.category_id } : null);
  if (card && card.card_id && topicId && data.has.has('card_topics') && ['added', 'edited_existing'].includes(card.action) && !isFoundationCategory(cardTopic && cardTopic.category_id)) {
    const ct = data.cardTopics.find(c => c.topic_id === topicId);
    if (!ct) rows.push({ table: 'card_topics', op: 'insert', key: { card_id: card.card_id, topic_id: topicId }, after: { match: 'claude', strong: 1, created_by: 'claude', created_at: now } });
    else if (ct.removed_at != null || !ct.strong) rows.push({ table: 'card_topics', op: 'update', key: { card_id: card.card_id, topic_id: topicId },
      before: { strong: ct.strong, removed_at: ct.removed_at ?? null }, after: { strong: 1, removed_at: null } });
  }
  if (card && card.note_id && ['added', 'edited_existing'].includes(card.action)) {
    for (const id of missIds) {
      const m = misses.find(x => x.id === id);
      if (!m || NO_LESSON_ERRORS.includes(m.error_type)) continue;
      const idem = `lesson:${lesson.id}:link:${id}`;
      if (!data.outbox.has(idem)) outbox.push({ kind: 'anki_link_card', idem, payload: { user, miss_id: id, anki_note_ids: [card.note_id], remediation: 'card' } });
    }
  }
  for (const o of outbox) rows.push({ table: 'outbox', op: 'insert', key: { id: uuid() }, after: { kind: o.kind, idem_key: o.idem, payload_json: JSON.stringify(o.payload), status: 'pending', attempts: 0, created_at: now } });

  const reviewedNow = [];
  if (kept && topicId) {
    for (const id of missIds) {
      const m = misses.find(x => x.id === id);
      if (!m || m.held || m.reviewed_at != null || (m.topic_id && ![topicId, lesson.pair_topic_id].includes(m.topic_id))) continue;
      add({ table: 'misses', op: 'update', key: { id }, before: { reviewed_at: null, reviewed_by: m.reviewed_by ?? null }, after: { reviewed_at: now, reviewed_by: 'lesson' } },
        { kind: 'miss.reviewed', target_type: 'miss', target_id: id, topic_id: m.topic_id || topicId, summary: `${m.label || id} reviewed in a lesson`.slice(0, 160) });
      reviewedNow.push(id);
    }
  }

  // Links Claude named (at most 2), through links-store's own link.add planner; one that cannot be placed is skipped.
  const linksSkipped = [];
  if (done && topicId) {
    for (const l of args.links || []) {
      const r = await planAdd(env, user, { type: l.type, from: topicId, to: l.other, ...(l.how ? { how: l.how } : {}), ...((l.a_vs_b || l.note) ? { fact: l.a_vs_b || l.note } : {}) },
        { ...ctx, now, request_id: `lesson:${lesson.id}:link:${links.length + 1}` });
      if (r.refuse || r.noop) { linksSkipped.push({ other: l.other, why: r.refuse || r.summary }); continue; }
      const p = pinned(r);
      rows.push(...p.rows);
      events.push(...p.events);
      links.push(r.reply);
    }
  }

  const M = A.misconceptions || {};
  const miscPart = data.has.has('misconceptions') ? lessonMisconceptions({ existing: data.misconceptions, served: parse(lesson.misc_ids_json, []),
    add: M.add || [], closed: done ? M.closed || [] : [],
    worked: Array.isArray(M.worked) ? M.worked : done ? null : [],
    lesson, args: A, topicId, topicName, now, done: kept }) : { rows: [], events: [], added: [], closed: [], kept: [] };
  rows.push(...miscPart.rows);
  events.push(...miscPart.events);
  // A misconception newly found in this lesson counts against its part (wave 3), unless it is the belief behind the
  // miss that brought the lesson on (its ref is that miss), which the miss already counts.
  if (kept && topicId) {
    const triggers = new Set(missIds.flatMap(id => { const m = misses.find(x => x.id === id); return m ? [m.label, m.id].filter(Boolean).map(v => String(v).toLowerCase()) : []; }));
    for (const r of miscPart.rows) {
      if (r.table !== 'misconceptions' || r.op !== 'insert' || !r.after) continue;
      if (r.after.ref && triggers.has(String(r.after.ref).toLowerCase())) continue;
      evidence.push({ ...base, obs_key: `lesson:${lesson.id}:misc:${r.key.id}`, slot: 0, kind: 'lesson_misconception', result: 'wrong',
        detail_json: withFacet({ label: 'misconception found in a lesson' }, r.after.belief) });
      counted.push('misconception');
    }
  }
  const touchedMisc = new Set(miscPart.rows.map(r => r.key.id));
  const autoClose = closing ? { rows: [], events: [], closed: [] } : autoCloseRows(data.targeted.filter(m => !touchedMisc.has(m.id)), { now });
  rows.push(...autoClose.rows);
  events.push(...autoClose.events);

  // Tactics: this lesson's deltas (only the difference on a re-save), plus earlier lessons' later evidence, once.
  // The content type: this call's, else the one teach_next stored at the start (the skill never sends it; LRN2-1).
  const contentType = A.content_type || lesson.content_type || null;
  const used = A.tactics_used || [];
  const clicked = clickedTactics(A.what_clicked);
  const mine = done && blend ? lessonDeltas({ contentType, used, clicked, blend: tacticReward(blend) }) : [];
  const net = subtractDeltas(mine, parse(lesson.tactic_delta_json, []));
  const stuck = [];
  for (const s of closing ? [] : data.stuck) {
    const items = (Number(s.pass) || 0) + (Number(s.fail) || 0);
    if ((Number(s.n) || 0) < STICK_MIN_ITEMS || !(items > 0)) continue;
    const stick = round3((Number(s.pass) || 0) / items);
    const delta = stickDeltas({ contentType: s.content_type, used: parse(s.tactics_json, []), stick });
    const info = { at: now, pass: round3(Number(s.pass) || 0), fail: round3(Number(s.fail) || 0), n: Number(s.n) || 0, stick, delta, by: `lesson:${lesson.id}` };
    add({ table: 'lessons', op: 'update', key: { id: s.id }, before: { stick_json: null, updated_at: s.updated_at }, after: { stick_json: JSON.stringify(info), updated_at: now } },
      { kind: 'lesson.saved', target_type: 'lesson', target_id: s.id, topic_id: s.topic_id || null, summary: `Did it stick: ${s.topic_name || 'a lesson'}, ${stickLine(info)}`.slice(0, 160) });
    stuck.push({ lesson_id: s.id, topic: s.topic_name || null, line: stickLine(info), delta });
  }
  const deltas = sumDeltas([net, ...stuck.map(s => s.delta)]);
  if (data.has.has('tactic_scores') && deltas.length) {
    const t = tacticRows(data.tactics, deltas, { now, sourceRef: `lesson:${lesson.id}` });
    rows.push(...t.rows);
    events.push(...t.events);
  }

  // Teaching notes, as one update per note: uses and Claude's mark (each note counted once per lesson), at most
  // two new ones (a note that repeats a live one is not added again), then duplicates merged (the tidy).
  const noteAfter = new Map();   // id -> {cur, after}
  const change = (cur, patch) => { const x = noteAfter.get(cur.id) || { cur, after: {} }; Object.assign(x.after, patch); noteAfter.set(cur.id, x); return x; };
  const val = (x, k) => (k in x.after ? x.after[k] : x.cur[k]);
  const usedBefore = new Set(parse(lesson.memory_used_json, []).map(u => u.id));
  const usedNow = (args.memory && args.memory.used) || [];
  for (const u of usedNow) {
    const m = data.memory.get(u.id);
    if (!m || usedBefore.has(u.id)) continue;
    const x = change(m, {});
    const wins = val(x, 'wins') + (u.effect === 'helped' ? 0.2 : 0), losses = val(x, 'losses') + (u.effect === 'hurt' ? 0.2 : 0);
    change(m, { uses: val(x, 'uses') + 1, wins: round3(wins), losses: round3(losses), score: scoreOf(wins, losses),
      evidence_json: JSON.stringify([...parse(val(x, 'evidence_json'), []), { at: now, lesson_id: lesson.id, effect: u.effect }].slice(-20)) });
  }
  const live = data.notes.slice();
  const freshNotes = [], notesSkipped = [];
  for (const n of (args.memory && args.memory.new) || []) {
    const ref = n.scope === 'global' ? null : n.scope_ref;
    const twin = live.find(x => x.scope === n.scope && (x.scope_ref ?? null) === (ref ?? null) && similar(x.note, n.note));
    if (twin) { notesSkipped.push({ note: n.note, same_as: twin.id }); continue; }
    freshNotes.push(n);
  }
  const newNotes = newNoteRows(freshNotes, { now, lessonId: lesson.id });
  for (const r of newNotes) add(r, { kind: 'teach_memory.saved', target_type: 'teach_memory', target_id: r.key.id, summary: `Saved a teaching note (${r.after.tactic.replace(/_/g, ' ')})` });
  const merges = closing ? [] : noteMerges(live.map(n => (noteAfter.has(n.id) ? { ...n, ...noteAfter.get(n.id).after } : n)));
  for (const { keep, drop } of merges) {
    const k = change(data.memory.get(keep.id), {});
    let wins = val(k, 'wins'), losses = val(k, 'losses'), uses = val(k, 'uses');
    for (const d of drop) {
      const x = change(data.memory.get(d.id), {});
      wins += val(x, 'wins'); losses += val(x, 'losses'); uses += val(x, 'uses');
      change(data.memory.get(d.id), { status: 'retired', retired_reason: `Merged into ${keep.id} (the same note).` });
    }
    change(data.memory.get(keep.id), { uses, wins: round3(wins), losses: round3(losses), score: scoreOf(wins, losses),
      evidence_json: JSON.stringify([...parse(val(k, 'evidence_json'), []), { at: now, lesson_id: lesson.id, merged: drop.map(d => d.id) }].slice(-20)) });
  }
  for (const { cur, after } of noteAfter.values()) {
    if (!Object.keys(after).length) continue;
    const a2 = { ...after, updated_at: now };
    const before = Object.fromEntries(Object.keys(a2).map(k => [k, cur[k] ?? null]));
    const useOnly = Object.keys(a2).every(k => NOTE_USE_COLS.includes(k));
    add({ table: 'teach_memory', op: 'update', key: { id: cur.id }, before, after: a2 },
      { kind: 'teach_memory.saved', target_type: useOnly ? 'note_use' : 'teach_memory', target_id: cur.id, summary: a2.status === 'retired' ? 'Merged a repeated teaching note' : 'Teaching note used' });
  }

  // Corrections (1 Nov 2026): each line Claude took back becomes a correction note on the topic (teach-memory.js), so later
  // briefs on it and its look-alikes say "Do not repeat"; the lesson's card, if any, goes with it for the nightly fact check.
  const corrSaved = [];
  for (const c of A.corrections || []) {
    const note = correctionNote(c);
    const scope = topicId ? 'topic' : 'global', ref = topicId || null;
    if (live.some(x => x.scope === scope && (x.scope_ref ?? null) === ref && similar(x.note, note))) continue;
    const id = 'tm_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const card = cardCols.card_id || cardCols.card_note_id ? { card_id: cardCols.card_id || null, note_id: cardCols.card_note_id || null } : {};
    add({ table: 'teach_memory', op: 'insert', key: { id }, after: { scope, scope_ref: ref, tactic: 'other', note, status: 'active', uses: 0, wins: 0, losses: 0,
      evidence_json: JSON.stringify([{ at: now, lesson_id: lesson.id, by: 'claude', ...card }]), source: 'correction', source_ref: `lesson:${lesson.id}`, created_by: 'claude', created_at: now, updated_at: now } },
    { kind: 'teach_memory.saved', target_type: 'teach_memory', target_id: id, topic_id: topicId || null, summary: `Logged a correction: ${String(c.right).trim().slice(0, 120)}` });
    corrSaved.push({ id, right: c.right, ...(card.card_id || card.note_id ? { card_queued: true } : {}) });
  }

  // The lesson_summary note.
  if (args.summary && topicId && data.has.has('topic_notes')) {
    const body = args.summary.trim();
    const title = `Lesson ${today}${args.goal ? `: ${args.goal.trim()}` : ''}`.slice(0, 200);
    const after = { topic_id: topicId, kind: 'lesson_summary', title, body, status: 'active', source: 'lesson', source_ref: `lesson:${lesson.id}`,
      content_sha: fnv1a(body), created_by: 'claude', lesson_id: lesson.id, card_id: cardCols.card_id, updated_at: now };
    const id = `ls_${lesson.id}`;
    if (!data.note) add({ table: 'topic_notes', op: 'insert', key: { id }, after: { ...after, created_at: now } },
      { kind: 'note.added', target_type: 'note', target_id: id, topic_id: topicId, summary: `Lesson notes on ${topicName || 'a topic'}`.slice(0, 160) });
    else add({ table: 'topic_notes', op: 'update', key: { id }, before: { title: data.note.title, body: data.note.body, status: data.note.status, card_id: data.note.card_id ?? null },
      after: { title, body, status: 'active', card_id: after.card_id, content_sha: after.content_sha, updated_at: now } },
    { kind: 'note.updated', target_type: 'note', target_id: id, topic_id: topicId, summary: `Lesson notes on ${topicName || 'a topic'}`.slice(0, 160) });
  }

  // The lessons row itself: both views as recorded, code's facts and blend.
  const f = A.final_case || null;
  const trim = v => (typeof v === 'string' ? v.trim() : null);
  const after = {
    status, ended_at: endedAt, minutes, topic_id: topicId || null, topic_name: topicName || lesson.topic_name,
    goal: args.goal ? args.goal.trim() : lesson.goal, five_step: args.five_step ? JSON.stringify(args.five_step) : lesson.five_step,
    probe_json: JSON.stringify(A.probe || []), steps_json: JSON.stringify(A.steps || []), items_json: marks ? JSON.stringify(marks) : lesson.items_json,
    final_result: f ? f.result : null, final_conf: f ? f.confidence || null : null,
    final_explain_json: f && f.explanation_judgement ? JSON.stringify({ verdict: f.explanation_judgement.verdict, missing: f.explanation_judgement.missing || [] }) : null,
    teach_back_json: A.teach_back ? JSON.stringify({ judgement: A.teach_back.judgement, missing: A.teach_back.missing || [] }) : null,
    ...(args.teach_back && typeof args.teach_back.text === 'string' ? { teach_back_text: args.teach_back.text.trim() }
      : 'teach_back_text' in lesson ? { teach_back_text: lesson.teach_back_text ?? null } : {}),
    mo_rating: A.mo_rating ?? null, mo_rating_why: trim(A.mo_rating_why), what_clicked: trim(A.what_clicked),
    claude_view_json: A.claude_view ? JSON.stringify({ verdict: A.claude_view.verdict, reasons: trim(A.claude_view.reasons) }) : null,
    questions_asked: A.questions_asked ?? null, tactics_json: JSON.stringify(used.filter(t => TACTIC_VOCAB.includes(t))),
    content_type: CONTENT_TYPES.includes(contentType) ? contentType : null,
    facts_json: JSON.stringify(facts), blend: done && blend ? blend.blend : null, blend_json: done && blend ? JSON.stringify(blend) : null,
    outcome: done ? outcome : null, tactic_delta_json: JSON.stringify(mine),
    weak_spot: args.weak_spot || null,
    ...cardCols,
    miss_ids_json: JSON.stringify(missIds), media_shown_json: JSON.stringify(args.media_shown || []),
    memory_used_json: JSON.stringify([...parse(lesson.memory_used_json, []).filter(u => !usedNow.some(n => n.id === u.id)), ...usedNow]),
    memory_written_json: JSON.stringify([...parse(lesson.memory_written_json, []), ...newNotes.map(r => r.key.id)]), mo_feedback: args.mo_feedback || null,
    abandon_reason: status === 'abandoned' ? (closing ? 'timeout' : stopped ? 'stopped_early' : 'claude') : null, link_id: lesson.link_id || args.link_id || null, updated_at: now,
  };
  const before = Object.fromEntries(Object.keys(after).map(k => [k, lesson[k] ?? null]));
  const mins = after.minutes != null ? ` (${Math.round(after.minutes)} min)` : '';
  const rated = after.mo_rating != null ? `, Mo ${after.mo_rating}/10` : '';
  const keptWords = keptLine(A.probe, A.steps, miscPart.added.length);
  const summary = done ? `Lesson: ${topicName || 'a topic'}, ${outcome ? outcome.replace('_', ' ') : 'closing viva being marked'}${rated}${mins}`
    : closing ? `Lesson on ${topicName || 'a topic'} stopped (no save for 3 h): ${keptWords || 'nothing'} kept`
      : `Lesson on ${topicName || 'a topic'} stopped${stopped ? (kind === 'lesson' || kind === 'pair' ? ' before the closing viva' : ' before the final case') : ''}`;
  rows.unshift({ table: 'lessons', op: 'update', key: { id: lesson.id }, before, after });
  events.unshift(pin({ kind: 'lesson.saved', target_type: 'lesson', target_id: lesson.id, topic_id: topicId || null, summary: summary.slice(0, 160) }, rows[0]));

  const touched = [...new Set([topicId, lesson.pair_topic_id, link && link.from_id, link && link.to_id, ...evidence.map(e => e.topic_id)].filter(Boolean))];
  const t = data.topics.get(topicId) || {};
  // A belief saved against a hub question is checked against that question too, placed or not (LS3-2).
  const questions = await refQuestions(env, user, ((args.misconceptions && args.misconceptions.add) || []).map(b => b && b.ref));
  return {
    rows, events, evidence: evidence.length ? { upsert: evidence } : undefined, touched_topics: touched,
    refs: { misses: missIds, questions }, count: 1, summary,
    reply: {
      saved: true, outcome: after.outcome, minutes: after.minutes, kind, blend: after.blend, ...(stopped ? { stopped_early: true } : {}),
      views: { mo: { rating: after.mo_rating, why: after.mo_rating_why, clicked: after.what_clicked }, claude: parse(after.claude_view_json, null) },
      facts, ...(done && blend && blend.gates.length ? { gates: blend.gates } : {}),
      topic: topicId ? { id: topicId, name: topicName, t1000_before: t.t != null ? Math.round(t.t * 1000) : null, band_before: t.band || null } : null,
      ...(marks ? { items: marks.map(m => (m.right ? 'right' : m.said === 'unsure' ? 'unsure' : 'wrong')) } : {}),
      misconceptions: { added: miscPart.added, closed: miscPart.closed, kept: miscPart.kept, closed_by_questions: autoClose.closed },
      tactics: { content_type: after.content_type, used: parse(after.tactics_json, []), clicked },
      tidy: { notes_merged: merges.reduce((n, m) => n + m.drop.length, 0), ...(notesSkipped.length ? { notes_skipped: notesSkipped } : {}),
        stuck: stuck.map(s => ({ lesson_id: s.lesson_id, topic: s.topic, line: s.line })) },
      ...(links.length ? { links } : {}), ...(linksSkipped.length ? { links_skipped: linksSkipped } : {}),
      ...(outbox.some(o => o.kind === 'anki_link_card') ? { card_link: 'queued' } : {}),
      ...(retestReply ? { miss_cards: retestReply } : {}),
      ...(reviewedNow.length ? { misses_reviewed: reviewedNow } : {}),
      ...(memoryMissing.length ? { memory_missing: { ids: memoryMissing, next_step: 'Call lesson_save again with memory.used for these pinned notes (effect helped, neutral or hurt).' } } : {}),
      ...(!topicId && done ? { note: 'No topic on the map, so no evidence was written; pass new_topic to place it.' } : {}),
      ...(counted.length ? { lesson_evidence: { counted: countedWords(counted), facet: lessonFacet, n: counted.length } } : {}),
      ...(checkpointOf(lesson).viva ? { viva_kept: true } : {}),
      ...(corrSaved.length ? { corrections: { saved: corrSaved.length, ids: corrSaved.map(c => c.id),
        ...(corrSaved.some(c => c.card_queued) ? { card: 'The lesson card goes on tonight\'s fact check list (map_rules fact_check).' } : {}) } } : {}),
      ...(cluster ? { cluster: { id: cluster.id, name: cluster.name, members: cluster.members.length,
        counted_on: [...new Set(evidence.map(e => e.topic_id))].map(id => (cluster.members.find(m => m.id === id) || {}).name || id) } } : {}),
    },
  };
}

// ---------------------------------------------------------------- lesson_save (MCP)

const waitUntilOf = ctx => (ctx && typeof ctx.waitUntil === 'function' ? ctx.waitUntil.bind(ctx)
  : ctx && ctx.executionCtx && typeof ctx.executionCtx.waitUntil === 'function' ? ctx.executionCtx.waitUntil.bind(ctx.executionCtx) : null);

const REPLY_KEYS = ['kind', 'stopped_early', 'blend', 'views', 'facts', 'gates', 'items', 'misconceptions', 'tactics', 'tidy', 'links', 'links_skipped', 'card_link', 'miss_cards', 'misses_reviewed', 'memory_missing', 'note',
  'lesson_evidence', 'cluster', 'corrections'];

// What a lesson counted against its topic, in words (pure): "a step check missed twice, a wrong teach-back".
const COUNTED_WORDS = { check: ['a step check missed twice', 'step checks missed twice'], probe: ['a probe missed on a new strand', 'probes missed on new strands'],
  teachback: ['a wrong teach-back'], teachback_partial: ['a partly right teach-back'], misconception: ['a new misconception', 'new misconceptions'] };
export function countedWords(list) {
  const n = {};
  for (const k of list || []) n[k] = (n[k] || 0) + 1;
  return Object.entries(n).map(([k, c]) => (c === 1 ? COUNTED_WORDS[k][0] : `${c} ${COUNTED_WORDS[k][1] || COUNTED_WORDS[k][0]}`)).join(', ');
}

export async function lessonSave(env, user, args = {}, ctx = {}) {
  const surface = (isObj(args) && args.surface) || ctx.surface || 'chat';
  let viva = null;
  if (isObj(args) && (args.phase != null || args.skip_viva != null)) {
    const bad = checkSave(args);
    if (bad) return { refused: true, reason: bad.fix, field: bad.field };
    const wu = waitUntilOf(ctx);
    const grade = typeof ctx.gradeViva === 'function' ? (u, id) => { const p = Promise.resolve(ctx.gradeViva(u, id)); if (wu) wu(p.catch(() => null)); return p; } : null;
    const v = await lessonVivaCall(env, user, { lessonId: args.lesson_id, phase: args.phase || 'before', text: args.viva, skip: args.skip_viva === true, surface,
      grade, ...(ctx.vivaWait || {}) });
    if (v.refused) return v;
    // The call is also a checkpoint (it marks the lesson as holding a viva, so the 3-hour close keeps it and a marked
    // closing viva closes it as done), unless it is the final save itself.
    const { skip_viva, viva: words, ...rest } = args;
    viva = v;
    args = { ...rest, ...(rest.status ? {} : { status: 'in_progress' }) };
  } else if (isObj(args) && args.viva != null) {
    const bad = checkSave(args);
    if (bad) return { refused: true, reason: bad.fix, field: bad.field };
    const v = await vivaReceive(env, user, { id: args.lesson_id, text: args.viva, surface });
    if (v.refused) return v;
    viva = v.viva;
    if (v.audit) return { saved: true, viva };
    if (!args.status) args = { ...args, status: 'in_progress' };
  }
  const r = await applyChange(env, user, { actor: ctx.actor || 'claude', surface, op: 'lesson.save', args, mo_said: ctx.mo_said,
    request_id: ctx.request_id, via: ctx.via || 'mcp:lesson_save' });
  if (!r.ok) return r;
  // A checkpoint answers at once: no outbox flush, no score read, no next pick.
  if (isObj(args) && args.status === 'in_progress') {
    // The viva's grade, once the minute job has it: what to teach first comes back on a later checkpoint.
    const v = viva || (r.checkpoint && r.checkpoint.viva ? await lessonViva(env, user, args.lesson_id).catch(() => null) : null);
    return r.nothing ? { saved: false, note: r.summary, ...(v ? { viva: v } : {}) } : { saved: true, seq: r.seq, checkpoint: r.checkpoint, ...(v ? { viva: v } : {}) };
  }
  const wu = waitUntilOf(ctx);
  const flush = flushOutbox(env, { kinds: OUTBOX_KINDS, limit: 12 }).catch(e => console.error('lesson outbox flush failed', e && e.message));
  if (wu) wu(flush);
  const out = { saved: true, seq: r.seq, batch_id: r.batch_id, outcome: r.outcome ?? null, minutes: r.minutes ?? null };
  for (const k of REPLY_KEYS) if (r[k] !== undefined) out[k] = r[k];
  try {
    const topicId = r.topic && r.topic.id;
    const data = await rankTopicsFor(env, user, { ids: topicId ? [topicId] : [] });
    if (r.topic) {
      const row = data.ok && data.byId.get(topicId);
      out.topic = { ...r.topic, t1000_after: row && row.t != null ? Math.round(row.t * 1000) : null, band_after: (row && row.band) || null };
    }
    if (data.ok) {
      const pick = choose(data, { skip: new Set(topicId ? [topicId] : []) });
      if (pick.topic_id && pick.row) out.next = { topic: { id: pick.topic_id, name: pick.row.name }, why: whyLine(pick.row, pick.served_by) };
      else if (pick.rest) out.next = { rest: true };
    }
  } catch (e) {
    console.error('lesson_save next pick failed', e && e.message);
    if (r.topic) out.topic = r.topic;
  }
  // Recent activity (wave 3): what the lesson's own failures did to the topic's colour, one line a lesson.
  if (r.lesson_evidence && out.topic && out.topic.id) {
    const le = r.lesson_evidence, tp = out.topic;
    await noteJob(env, { job: 'facets', user, ref: 'lesson', key: `lesson:${args.lesson_id}`, state: 'ok',
      counts: { n: le.n, facet: le.facet || 'both', before: tp.t1000_before ?? -1, after: tp.t1000_after ?? -1, band: tp.band_after || 'unseen' },
      detail: `${tp.name || 'a topic'}: ${le.counted}` });
  }
  const v = viva || (r.viva_kept ? await lessonViva(env, user, args.lesson_id).catch(() => null) : null);
  if (v) out.viva = v;
  out.undo = { batch_id: r.batch_id, say: "Say 'undo that' to reverse it." };
  return out;
}

// ---------------------------------------------------------------- undo

/**
 * realtime's undo for lesson.saved: the lessons row goes back to how it was (unless it changed since). The
 * evidence, note, memory, misconception, tactic and link rows of the same batch carry their own events and are
 * put back by realtime (tactic scores by taking the difference back out, so later lessons' additions stay).
 */
export async function undoLesson(env, user, event, ctx = {}) {
  const before = parse(event.before_json, null), after = parse(event.after_json, null);
  const id = (after && after.id) || (before && before.id) || event.target_id;
  const current = await env.DB.prepare(`SELECT * FROM lessons WHERE user_id = ? AND id = ?`).bind(user, id).first();
  const now = ctx.now || Date.now();
  const r = restoreRow('lessons', { id }, before, after, current, now);
  if (r.conflict) return { conflict: r.conflict };
  // An undone save is not a lesson running now: back to in_progress, the map would show "teaching now" and the
  // stated-gap tier would skip the topic for 3 h. It is closed as abandoned ('undone'); undoing the undo saves it again.
  if (r.row && r.row.op === 'update' && r.row.after && r.row.after.status === 'in_progress') {
    const set = { status: 'abandoned', abandon_reason: 'undone', ended_at: now };
    for (const c of Object.keys(set)) if (!(c in r.row.before)) r.row.before[c] = current ? current[c] ?? null : null;
    r.row.after = { ...r.row.after, ...set };
  }
  return { rows: r.row ? [r.row] : [], recompute: event.topic_id ? [event.topic_id] : [] };
}

// ---------------------------------------------------------------- stale lessons (minute 29)

// A running lesson is stale 3 h after its last checkpoint, or after its start when it has none.
const STALE_AT = { cp: "coalesce(json_extract(checkpoint_json, '$.at'), started_at, 0)", old: 'coalesce(started_at, 0)' };
// What a checkpoint wrote: a probe or steps, or (0042) the checkpoint itself.
const KEPT_SQL = { cp: "(coalesce(probe_json, '[]') NOT IN ('[]', '') OR coalesce(steps_json, '[]') NOT IN ('[]', '') OR checkpoint_json IS NOT NULL)",
  old: "(coalesce(probe_json, '[]') NOT IN ('[]', '') OR coalesce(steps_json, '[]') NOT IN ('[]', ''))" };
const noColumn = e => /no such column/i.test(String(e && e.message));
// The stale lessons query, with migration 0042's column, else without it (a database not yet migrated).
async function staleRows(env, user, sql, ...binds) {
  try {
    return (await env.DB.prepare(sql('cp')).bind(user, ...binds).all()).results || [];
  } catch (e) {
    if (!noColumn(e)) throw e;
    return (await env.DB.prepare(sql('old')).bind(user, ...binds).all()).results || [];
  }
}

/** The 3-hour close (op lesson.close, code only): lesson_save's planner on a running lesson its checkpoints wrote to. */
export const planLessonClose = (env, user, args, ctx) => planLessonSave(env, user, { lesson_id: isObj(args) ? args.lesson_id : null }, { ...ctx, closing: true });

/**
 * Planner for op lesson.expire (code only): in_progress over 3 h -> abandoned 'timeout'; requested over 72 h -> 'expired'.
 * args.failed: [{id, why}], lessons whose checkpoints lesson.close could not keep, said so in their line.
 */
export async function planLessonExpire(env, user, args, ctx) {
  const now = ctx.now || Date.now();
  const failed = new Map(((isObj(args) && Array.isArray(args.failed)) ? args.failed : []).filter(isObj).map(f => [f.id, f.why]));
  let rows;
  try {
    // A lesson its checkpoints wrote to is lesson.close's, unless that close failed: it is never closed here with nothing kept.
    rows = await staleRows(env, user, v => `SELECT id, status, topic_name, topic_id, started_at, requested_at, updated_at FROM lessons WHERE user_id = ?1
      AND ((status = 'in_progress' AND ${STALE_AT[v]} < ?2 AND (NOT ${KEPT_SQL[v]} OR id IN (SELECT value FROM json_each(?4))))
        OR (status = 'requested' AND coalesce(requested_at, 0) < ?3)) LIMIT 50`,
    now - STALE_IN_PROGRESS_MS, now - STALE_REQUESTED_MS, JSON.stringify([...failed.keys()]));
  } catch (e) {
    if (noTable(e)) return { noop: true, summary: 'No lessons yet.' };
    throw e;
  }
  if (!rows.length) return { noop: true, summary: 'No stale lessons.' };
  const out = { rows: [], events: [], count: rows.length, summary: `${rows.length} stale lesson${rows.length === 1 ? '' : 's'} closed` };
  for (const l of rows) {
    const reason = l.status === 'in_progress' ? 'timeout' : 'expired';
    const row = { table: 'lessons', op: 'update', key: { id: l.id }, before: { status: l.status, abandon_reason: null, ended_at: null, updated_at: l.updated_at },
      after: { status: 'abandoned', abandon_reason: reason, ended_at: now, updated_at: now } };
    out.rows.push(row);
    const name = l.topic_name || 'a topic';
    const line = failed.has(l.id) ? `Lesson on ${name} closed (no save after 3 h); its saved progress could not be kept: ${String(failed.get(l.id) || 'an error').slice(0, 80)}`
      : reason === 'timeout' ? `Lesson on ${name} closed (no save after 3 h)` : `Teach me tap on ${name} closed (not started in 3 days)`;
    out.events.push(pin({ kind: 'lesson.saved', target_type: 'lesson', target_id: l.id, topic_id: l.topic_id || null, undoable: false, summary: line.slice(0, 160) }, row));
  }
  return out;
}

/**
 * The minute-29 job (ingest's dispatcher calls it). A stale lesson its checkpoints wrote to is closed first, one batch
 * each (op lesson.close: stopped, its probe and checks kept as evidence); the rest, and any whose close failed (its
 * line says so in Recent activity), in one lesson.expire batch.
 */
export async function staleLessons(env, user, { now = Date.now() } = {}) {
  let kept = [];
  try {
    kept = await staleRows(env, user, v => `SELECT id FROM lessons WHERE user_id = ?1 AND status = 'in_progress' AND ${STALE_AT[v]} < ?2 AND ${KEPT_SQL[v]}
      ORDER BY started_at LIMIT 10`, now - STALE_IN_PROGRESS_MS);
  } catch (e) {
    if (!noTable(e)) throw e;
  }
  const failed = [];
  let closedKept = 0, seq = null;
  for (const l of kept) {
    try {
      const r = await applyChange(env, user, { actor: 'code', surface: 'cron', op: 'lesson.close', args: { lesson_id: l.id }, via: 'cron:stale_lessons' });
      if (r.ok && !r.nothing) { closedKept++; seq = r.seq ?? seq; } else if (!r.ok) failed.push({ id: l.id, why: r.reason || 'refused' });
    } catch (e) {
      console.error('lesson close failed', l.id, e && e.message);
      failed.push({ id: l.id, why: 'an error in the hub' });
    }
  }
  const r = await applyChange(env, user, { actor: 'code', surface: 'cron', op: 'lesson.expire', args: failed.length ? { failed } : {}, via: 'cron:stale_lessons' });
  if (!closedKept && !r.ok) return r;
  if (!closedKept && r.nothing) return { closed: 0 };
  return { closed: true, seq: r.ok && !r.nothing ? r.seq : seq, ...(closedKept ? { kept: closedKept } : {}), ...(failed.length ? { failed } : {}) };
}

export { PHASES, METHOD_VERSION };
