import { buildLeakIndex, leaks } from '../checks.js';

export class Refusal extends Error {
  constructor(reason, field = null) {
    super(reason);
    this.reason = reason;
    this.field = field;
  }
}

export const REASONS = {
  cards: 'Cards live in Anki: use add_card or edit_card on the Anki connector.',
  code_decides: 'Code decides right and wrong.',
  no_delete: 'Misses, evidence and gaps come from the logs, so they are never deleted. Re-file them with map_resolve instead.',
  internal: 'That setting is kept by the hub itself.',
  held: "That sitting isn't finished, so its results stay hidden until it ends.",
  slip: 'No lesson, card or link for a misread or a test-taking slip.',
  amboss: 'AMBOSS stays a link: the hub never stores AMBOSS text.',
  question_bank: 'That reads like question-bank text (a stem, options or an explanation). Use your own words.',
  user: 'That row belongs to someone else.',
};

// Argument keys Claude may never send (walked recursively). An op may allow named keys it marks in code,
// for example lesson.save's probe results, which code turns into the outcome.
export const BLOCKED_KEYS = ['result', 'verdict', 'outcome', 'correct', 'answer', 'answer_key', 'score', 'weakness', 'certainty', 't', 'held'];

// Columns only code computes. A planner may write one only when its op lists it in codeMarks ('table.col').
export const CODE_DECIDES = ['result', 'verdict', 'outcome', 'score', 'certainty', 'certainty_level', 't', 'held', 'weakness', 'weakness_raw', 'mastery', 'band'];

// Written by any planner on any table it may write: ids, ownership and bookkeeping.
const SYSTEM_COLS = ['id', 'user_id', 'created_at', 'updated_at', 'created_by', 'source', 'source_ref'];

// Tables no change may touch, with the reason.
export const REFUSED_TABLES = {
  card_cache: REASONS.cards,
  topic_scores: REASONS.code_decides,
  category_priors: REASONS.code_decides,
  map_events: 'The change log is written by the hub itself.',
  sync_state: REASONS.internal,
  topic_dirty: REASONS.internal,
  source_fetches: REASONS.internal,
  onenote_parts: REASONS.internal,
};
export const NO_DELETE_TABLES = ['misses', 'evidence', 'gaps'];
export const NO_USER_ID_TABLES = ['settings', 'users', 'outbox'];

// Settings the hub keeps for itself (exact keys or prefixes ending in ':').
export const INTERNAL_SETTINGS = ['onenote_page:', 'mcp_seen', 'changes_seen', 'sync_state', 'plan_version', 'plan_seeded', 'catchup_done:'];
export const isInternalSetting = key => INTERNAL_SETTINGS.some(k => (k.endsWith(':') ? String(key).startsWith(k) : key === k));

// Error types that never earn a lesson, card or link (teach's NO_LESSON_ERRORS; keys as in misses.error_type).
export const NO_LESSON_ERRORS = ['misread', 'test_taking'];
// Ops that make a lesson, card or link from misses, so the slip rule applies to their refs (an entry can
// also ask for it with noSlips: true).
export const SLIP_GUARDED_OPS = ['lesson.request', 'lesson.start', 'lesson.save', 'link.add'];

const W = (actions, cols, ops = null) => ({ actions, cols, ops });
// What a change may write, per table: actions (i insert, u update, d soft_delete), columns, and the ops
// allowed to write it (null: any registered op). An op adds columns for itself with `writes`.
export const WRITABLE = {
  topics: W('iu', ['name', 'short_name', 'kind', 'status', 'merged_into', 'suspect_dupe_of', 'category_id', 'category2_id', 'unit_id', 'parent_id',
    'amboss_url', 'amboss_src', 'amboss_checked_at', 'confirmed_at', 'confirmed_by', 'exam_profile', 'oncology', 'disciplines']),
  topic_aliases: W('iud', ['alias_key', 'topic_id', 'alias', 'kind', 'status']),
  categories: W('iu', ['name', 'short_name', 'sort', 'exam_profile', 'cms_subject', 'onenote_section', 'checklist_system', 'status']),
  category_aliases: W('iu', ['vocab', 'alias', 'alias_key', 'category_id', 'confidence']),
  units: W('iu', ['num', 'kind', 'name', 'heading', 'lane', 'mehlman_rank', 'checklist_system', 'checklist_order', 'category_id', 'onenote_section',
    'onenote_page_id', 'onenote_object_id', 'onenote_link', 'coverage_json', 'notes_gap', 'locked_json', 'exam_profile']),
  unit_topics: W('iud', ['unit_id', 'topic_id', 'role']),
  links: W('iud', ['type', 'from_id', 'to_id', 'directed', 'how', 'a_vs_b', 'b_vs_a', 'note', 'picture', 'status', 'removed_at', 'removed_by', 'removed_reason']),
  link_support: W('i', ['link_id', 'obs_key', 'src', 'role', 'w', 'cw', 'truth_id', 'text', 'miss_id', 'card_id', 'note_id', 'gap_id', 'lesson_id', 'sitting_id', 'at']),
  topic_notes: W('iud', ['topic_id', 'unit_id', 'kind', 'step', 'title', 'body', 'answer', 'hot', 'ord', 'status', 'locked', 'content_sha', 'lesson_id', 'card_id', 'gap_id']),
  // label_norm: the words that placed a row, set when a queue item moves a row code placed from other words (B4-3).
  misses: W('u', ['topic_id', 'category_id', 'queue_id', 'match_status', 'match_method', 'label_norm', 'reviewed_at', 'reviewed_by']),
  gaps: W('u', ['topic_id', 'map_state', 'mapped_at', 'mixed_with']),
  topic_queue: W('u', ['status', 'resolved_topic_id', 'resolved_by', 'result_json', 'run_id', 'attempts']),
  checklist_progress: W('iu', ['unit_id', 'step', 'mastered', 'rating', 'mastered_at']),
  card_topics: W('iu', ['card_id', 'topic_id', 'match', 'strong', 'removed_at', 'removed_by']),
  resources: W('iu', ['kind', 'title', 'subject', 'exam', 'pages', 'file_name', 'r2_key', 'url', 'bytes', 'text_status', 'exam_profile']),
  resource_links: W('iu', ['topic_id', 'kind', 'resource_id', 'page', 'page_to', 'label', 'section', 'snippet', 'query', 'rank', 'status', 'fetched_at']),
  topic_positions: W('iu', ['kind', 'ref_id', 'x', 'y', 'placed_by', 'pinned', 'layout_version']),
  lessons: W('iu', ['topic_id', 'topic_name', 'pair_topic_id', 'link_id', 'kind', 'status', 'abandon_reason', 'served_by', 'requested_by', 'request_from',
    'surface_hint', 'requested_at', 'started_at', 'ended_at', 'minutes', 'surface', 'day', 'goal', 'five_step', 'why_chosen', 'priority', 'priority_json',
    'probe_json', 'steps_json', 'items_json', 'gap_ids_json', 'final_result', 'final_conf', 'weak_spot', 'card_note_id',
    'card_id', 'card_action', 'miss_ids_json', 'media_shown_json', 'memory_used_json', 'memory_written_json', 'mo_feedback', 'method_version',
    'content_type', 'tactics_suggested_json', 'misc_ids_json', 'final_explain_json', 'teach_back_json', 'mo_rating', 'mo_rating_why', 'what_clicked',
    'claude_view_json', 'questions_asked', 'tactics_json', 'facts_json', 'blend', 'blend_json', 'tactic_delta_json', 'stick_json',
    // A lesson on an error cluster (0071, clusters.js): the cluster it teaches.
    'cluster_id'],
  ['lesson.request', 'lesson.start', 'lesson.save', 'lesson.close']),
  teach_memory: W('iu', ['scope', 'scope_ref', 'tactic', 'note', 'status', 'uses', 'wins', 'losses', 'evidence_json', 'retired_reason'],
    ['teach_memory.save', 'lesson.save']),
  evidence: W('i', ['obs_key', 'slot', 'topic_id', 'queue_id', 'label_norm', 'category_id', 'kind', 'at', 'day', 'miss_id', 'sitting_id', 'card_id', 'note_id',
    'gap_id', 'lesson_id', 'confidence', 'error_type', 'flaw_kind', 'time_s', 'others_pct', 'amount', 'rating', 'detail_json', 'gen']),
  outbox: W('i', ['kind', 'idem_key', 'payload_json', 'status', 'attempts'], ['lesson.save']),
  users: W('u', ['prefs_json'], ['pref.set']),
  settings: W('iu', ['key', 'value'], ['setting.set']),
};

// Free-text caps, by 'table.col' (or 'col' for any table). Over the cap is refused, never cut.
export const FIELD_CAPS = {
  name: 120, alias: 120, short_name: 60, how: 300, a_vs_b: 300, b_vs_a: 300, note: 300, summary: 160, mo_said: 300,
  'teach_memory.note': 300, 'lessons.summary_md': 1200, 'lessons.teach_back_text': 600, 'topic_notes.body': 4000, 'topic_notes.answer': 600, 'topic_notes.title': 200,
  goal: 200, weak_spot: 200, mo_rating_why: 200, what_clicked: 200, belief: 200, mo_feedback: 200, reason: 200, removed_reason: 200, label: 200, snippet: 600,
  amboss_url: 300, text: 600,
  // A UK entry's fact tables (uk/store.js checks each cell; this is the whole entry's limit).
  'uk_entries.sections_json': 30000,
};
export const DEFAULT_TEXT_CAP = 2000;
export const JSON_TEXT_CAP = 8000;
export function capFor(table, col) {
  return FIELD_CAPS[`${table}.${col}`] ?? FIELD_CAPS[col] ?? (/_json$/.test(col) ? JSON_TEXT_CAP : DEFAULT_TEXT_CAP);
}

// Question-bank shapes: three or more lettered option lines, or an item's stock phrases. Claude's own new
// cases are fine (an age-and-sex opener is not refused).
const OPTION_LINE = /^\s*\(?[A-H][.)]\s+\S/gm;
const QB_PHRASES = [/which of the following/i, /educational objective/i];
export function looksLikeQuestionBank(text) {
  const s = String(text || '');
  if ((s.match(OPTION_LINE) || []).length >= 3) return true;
  return QB_PHRASES.some(re => re.test(s));
}

// A stem read aloud: an age opener, then the verb a question bank's case starts with ("A 34-year-old woman comes
// to the emergency department"). Used on text from recordings and logs, never on Claude's own new cases.
const VIGNETTE = /\b\d{1,3}[\s-]?(?:year|yr|month|week|day)s?[\s-]?old\b[^.?!]{0,120}?\b(?:comes?|came|presents?|presented|is brought|was brought|is admitted|was admitted|is evaluated|is seen|visits|is referred|was referred)\b/i;
export const looksLikeVignette = text => VIGNETTE.test(String(text || ''));
/** Question-bank shapes or a stem read aloud. */
// Lettered options run into one line ("A. Glaucoma B. Retinitis pigmentosa C. ..."), as a log field holds them once
// its line breaks are folded.
const INLINE_OPTIONS = /(?:^|\s)\(?A[.)]\s+\S.{0,200}?\s\(?B[.)]\s+\S.{0,200}?\s\(?C[.)]\s+\S/;
export const looksLikeStem = text => looksLikeQuestionBank(text) || INLINE_OPTIONS.test(String(text || '')) || looksLikeVignette(text);
/** Question-bank shapes only (options, stock phrases): for text whose own cases are fine, such as a rule. */
export const looksLikeQuestionText = text => looksLikeQuestionBank(text) || INLINE_OPTIONS.test(String(text || ''));
/** The text, or null when it looks like question text (a field is dropped, never the row). */
export const stemSafe = text => (text && looksLikeStem(text) ? null : text);
export const questionSafe = text => (text && looksLikeQuestionText(text) ? null : text);
export const GAP_LEFT_OUT = '(left out: it read like question text)';

const AGE = /\b\d{1,3}[\s-]?(?:year|yr|month|week|day)s?[\s-]?old\b/i;
// A lab or vital-sign value read aloud ("sodium 128 mEq/L", "pulse is 112/min", "88/54 mm Hg", "38.9°C").
const MEASURE = /\b\d+(?:[.,]\d+)?\s*(?:mEq|mmol|mOsm|mg|µg|mcg|ug|ng|pg|g\/dL|mL|IU|U\/L|mm\s?Hg|cm\s?H2O|\/min|\/mm3|\/µL|beats|breaths|°\s?[CF]?|degrees)|\b\d{2,3}\/\d{2,3}\b/i;
// A question's lead-in ("What is the most appropriate next step in management?").
const STEM_LEAD = /\b(?:most (?:likely|appropriate|common|accurate|effective|sensitive|specific)|next (?:best )?step|best (?:initial|next)|which of the following|following (?:is|are|would|will))\b/i;
// A case sentence's opening ("The patient is ...", "Her temperature is ...", "Laboratory studies show ...").
const CASE_OPENER = /^\s*(?:the patient|this patient|patient|he|she|his|her|they|their|physical examination|on examination|examination|laboratory|labs?|vital signs|temperature|pulse|blood pressure|respirations|history|past medical|medications|an?\s+(?:\d|man|woman|boy|girl|infant|newborn|neonate|child|toddler|patient|previously))\b/i;
// A stem's stock continuation after the age ("comes to the emergency department because of ...", "a 3-day history").
const STEM_STOCK = /\b(?:comes?|came|presents?|presented|is brought|was brought|is admitted|was admitted|is referred|was referred) to (?:the|an?|his|her)\b|\bbecause of\b|\b\d+[\s-](?:hour|day|week|month|year)s?[\s-]history\b|\bfor (?:the (?:past|last) )?\d+ (?:hours?|days?|weeks?|months?|years?)\b/i;
const CASE_START = /\b(?:an?|the patient is an?)\s+\d{1,3}[\s-]?(?:year|yr|month|week|day)s?[\s-]?old\b/i;
const CLAUSE_WORD = /\b(?:why|how|what|when|which|whether|if|that|where|who|whom|whose|about|between)\b/i;
// A finding read out from the case (LS3-3): "An ECG shows ...", "Urinalysis reveals ...", "Two weeks ago, she ...",
// "Family history is notable for ...", "Serum creatinine has risen from 0.9 to 2.1", "On arrival she is ...".
const FINDING = /\b(?:shows?|showed|reveals?|revealed|demonstrates?|demonstrated|(?:is|are|was|were) (?:notable|significant|remarkable) for)\b/i;
const AGO = /\b(?:\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|several|a few)\s+(?:hours?|days?|weeks?|months?|years?)\s+(?:ago|earlier|before|prior)\b/i;
const RANGE = /\bfrom\s+\d+(?:[.,]\d+)?\s*(?:\S+\s+)?to\s+\d+(?:[.,]\d+)?\b/i;
const FINDING_OPENER = /^\s*(?:(?:family|social|surgical|obstetric|medical|sexual|travel|drug)\s+history|on (?:arrival|admission|presentation)|at (?:presentation|admission)|(?:\w+\s+){0,2}examination\b|(?:an?\s+)?(?:ecg|ekg|electrocardiogra\w*|chest\s+x-?rays?|x-?rays?|radiographs?|ct|mri|ultrasound\w*|echocardiogra\w*|urinalysis|serum|biops\w*|cultures?|imaging)\b)/i;
const cueSentences = text => String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

const QUOTED = /["“”]/;
const CASE_PEOPLE = /\b(?:he|she|him|his|her|hers|they|their|patients?|mother|father|parents?|wife|husband|son|daughter|boy|girl|man|woman|infant|child|baby|newborn|neonate|toddler|adolescent)\b/i;
const THIS_PATIENT = /\b(?:this|the)\s+(?:patient|child|infant|boy|girl|man|woman|newborn|neonate|baby|toddler|adolescent)(?:'s|’s)?\b/i;
const OWN_QUESTION = /\?\s*$|^\s*(?:why|how|what|when|which|whether|where|who|is it|isn'?t it|is that|does it|do you|did i|should i|can i|could it|would it|was it)\b/i;
const FIRST_PERSON_WORD = /(?:^|[^\w'’])(?:i'm|i’m|i've|i’ve|i'd|i’d|i'll|i’ll|my|myself)\b/i;
const FIRST_PERSON_I = /(?:^|[^\w'’])I\s+(?:(?:just|still|always|never|really|also|only|totally|completely|honestly|kind of|sort of)\s+)?(?:am|was|wasn'?t|have|haven'?t|had|hadn'?t|do|don'?t|did|didn'?t|can|can'?t|cannot|could|couldn'?t|would|wouldn'?t|should|shouldn'?t|will|won'?t|think|thought|know|knew|get|got|forget|forgot|mix|mixed|confuse|confused|remember|remembered|guess|guessed|pick|picked|chose|choose|went|go|said|say|need|needed|want|wanted|keep|kept|feel|felt|see|saw|wonder|assume|assumed|believe|believed|miss|missed|mean|meant|like|hate|recall|understand|understood|struggle|learn|learned|learnt|read|put|look|looked|rule|ruled|answer|answered|misread|skipped|change|changed|doubt|doubted|figure|figured|mistook)\b/;
const A_VERB = /\b(?:is|are|was|were|be|been|being|am|isn'?t|aren'?t|wasn'?t|weren'?t|has|have|had|hasn'?t|haven'?t|hadn'?t|does|do|did|doesn'?t|don'?t|didn'?t|will|would|can|could|may|might|shall|should|must|won'?t|can'?t|cannot|(?:it|that|there|here|what|who|he|she|this)(?:'|’)s|shows?|showed|shown|reveals?|revealed|becomes?|became|develops?|developed|reports?|reported|denies|denied|complains?|complained|appears?|appeared|presents?|presented|undergoes|underwent|undergone|receives?|received|takes?|took|taken|notes?|noted|describes?|described|says|said|states?|stated|returns?|returned|begins?|began|begun|starts?|started|remains?|remained|continues?|continued|increases?|increased|decreases?|decreased|improves?|improved|worsens?|worsened|occurs?|occurred|follows?|followed|measures?|measured|persists?|persisted|spreads?|smokes?|smoked|drinks?|drank|lives?|lived|works?|worked|uses?|used|feels?|felt|looks?|looked|seems?|seemed|gets?|got|goes|went|comes?|came|brought|admitted|treated|given|diagnosed|consists?|contains?|includes?|included|resolves?|resolved|radiates?|radiated|lasts?|lasted|weighs?|weighed|sleeps?|slept|eats?|ate|walks?|walked|vomits?|vomited|coughs?|coughed|cries|cried|lost|gained|passed|found|heard|seen|palpated|auscultated|elicited|obtained|performed|ordered|administered|discharged|prescribed|scheduled|referred|evaluated|examined|asked|told|explained|exposed|born|delivered|immunized|vaccinated)\b/i;
const SHORT_PHRASE_WORDS = 8;
export function cueReadsAsHis(text) {
  const s = String(text || '').trim();
  if (!s || QUOTED.test(s)) return false;
  if (OWN_QUESTION.test(s)) return !THIS_PATIENT.test(s);
  if (CASE_PEOPLE.test(s)) return false;
  if (FIRST_PERSON_WORD.test(s) || FIRST_PERSON_I.test(s)) return true;
  return s.split(/\s+/).length <= SHORT_PHRASE_WORDS && !A_VERB.test(s);
}

export function cueFollowOk(text) {
  const s = String(text || '');
  return !!s.trim() && !looksLikeStem(s) && !AGE.test(s) && !MEASURE.test(s) && !STEM_LEAD.test(s) && !CASE_OPENER.test(s)
    && !FINDING.test(s) && !AGO.test(s) && !RANGE.test(s) && !FINDING_OPENER.test(s) && cueReadsAsHis(s);
}

export function cueOwnLooksLikeStem(text) {
  const s = String(text || '');
  if (looksLikeQuestionText(s)) return true;
  if (!looksLikeVignette(s)) return false;
  if (STEM_STOCK.test(s)) return true;
  const at = s.search(CASE_START);
  return at >= 0 && !CLAUSE_WORD.test(s.slice(0, at));
}

export function cueLooksLikeStem(text) {
  const [own, ...rest] = cueSentences(text);
  if (!own) return false;
  return cueOwnLooksLikeStem(own) || rest.some(s => !cueFollowOk(s));
}

export function gapSafe(g) {
  if (!g) return g;
  const check = g.source === 'spoken_cue' ? cueLooksLikeStem : looksLikeQuestionText;
  const out = { ...g };
  if (out.gap && check(out.gap)) out.gap = GAP_LEFT_OUT;
  if (out.said && check(out.said)) out.said = null;
  return out;
}

// The first blocked key anywhere in args, as a dotted path, or null.
export function blockedKey(args, allow = []) {
  const walk = (v, path) => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) { const p = walk(v[i], `${path}[${i}]`); if (p) return p; }
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const here = path ? `${path}.${k}` : k;
        if (BLOCKED_KEYS.includes(k) && !allow.includes(k)) return here;
        const p = walk(x, here);
        if (p) return p;
      }
    }
    return null;
  };
  return walk(args, '');
}

// The whitelist for one table and op: {actions, cols:Set} or null when the op may not write it at all.
export function writableFor(table, op, writes = {}) {
  const base = WRITABLE[table];
  const extra = writes[table];
  if (!base && !extra) return null;
  if (base && base.ops && !base.ops.includes(op) && !extra) return null;
  const cols = new Set([...SYSTEM_COLS, ...((base && (!base.ops || base.ops.includes(op))) ? base.cols : []), ...((extra && extra.cols) || [])]);
  const actions = `${(base && (!base.ops || base.ops.includes(op))) ? base.actions : ''}${(extra && extra.actions) || ''}`;
  return { actions, cols };
}

const ACTION = { insert: 'i', update: 'u', soft_delete: 'd' };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Checks one planner's row diffs and returns them with user_id filled in. Throws Refusal.
 * rows: [{table, op: insert|update|soft_delete, key, before, after}]; entry: the registry entry for op.
 */
export function checkRows(user, op, entry, rows) {
  if (!Array.isArray(rows)) throw new Refusal('The change has no rows.');
  const codeMarks = new Set(entry.codeMarks || []);
  const writes = entry.writes || {};
  return rows.map((r, i) => {
    if (!r || typeof r.table !== 'string' || !isObj(r.key)) throw new Refusal(`Row ${i + 1} of the change is malformed.`);
    const { table } = r;
    if (REFUSED_TABLES[table]) throw new Refusal(REFUSED_TABLES[table], table);
    if (r.op === 'delete' || (r.op === 'soft_delete' && NO_DELETE_TABLES.includes(table))) throw new Refusal(REASONS.no_delete, table);
    const action = ACTION[r.op];
    if (!action) throw new Refusal(`Row ${i + 1} has an unknown action ${JSON.stringify(r.op)}.`);
    const w = writableFor(table, op, writes);
    if (!w || !w.actions.includes(action)) throw new Refusal(`The change ${op} cannot ${r.op.replace('_', ' ')} ${table}.`, table);
    if (r.op !== 'insert' && !isObj(r.before)) throw new Refusal(`Row ${i + 1} needs the row as it was before.`);
    const after = isObj(r.after) ? r.after : {};
    for (const col of new Set([...Object.keys(after), ...Object.keys(r.key)])) {
      const marked = codeMarks.has(`${table}.${col}`);
      if (CODE_DECIDES.includes(col) && !marked) throw new Refusal(REASONS.code_decides, `${table}.${col}`);
      if (!w.cols.has(col) && !marked && !(col in r.key && !(col in after))) throw new Refusal(`The change ${op} cannot write ${table}.${col}.`, `${table}.${col}`);
    }
    const key = { ...r.key };
    const out = { ...r, key, after: r.after == null ? r.after : { ...after } };
    if (table === 'users') {
      if (key.id !== user) throw new Refusal(REASONS.user, 'users.id');
    } else if (!NO_USER_ID_TABLES.includes(table)) {
      for (const v of [key.user_id, after.user_id, r.before && r.before.user_id]) if (v != null && v !== user) throw new Refusal(REASONS.user, `${table}.user_id`);
      key.user_id = user;
      if (r.op === 'insert') out.after.user_id = user;
    }
    if (table === 'resource_links' && (after.kind === 'amboss' || /amboss/i.test(String(after.resource_id || '')))) throw new Refusal(REASONS.amboss, table);
    if (table === 'topic_notes' && /amboss/i.test(String(after.source || ''))) throw new Refusal(REASONS.amboss, table);
    if ('amboss_url' in after && after.amboss_url != null && !ambossUrlOk(after.amboss_url)) throw new Refusal('That is not an AMBOSS article link.', `${table}.amboss_url`);
    return out;
  });
}

// An AMBOSS link the hub may keep: https on amboss.com, no credentials, short.
export function ambossUrlOk(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && /(^|\.)amboss\.com$/.test(u.hostname) && !u.username && !u.password && String(url).length <= 300;
  } catch { return false; }
}

// Evidence operations a planner may carry: only ops that declare `evidence`. upsert rows are checked as
// evidence inserts; remove is allowed only for obs_key prefixes the op lists (a tick's own row).
export function checkEvidence(user, op, entry, evidence) {
  if (evidence == null) return evidence;
  const allowed = entry.evidence;
  if (!allowed) throw new Refusal(REASONS.no_delete, 'evidence');
  const out = { upsert: [], remove: [], repoint: [] };
  if (evidence.upsert && evidence.upsert.length) {
    out.upsert = checkRows(user, op, { ...entry, writes: { ...(entry.writes || {}), evidence: WRITABLE.evidence } },
      evidence.upsert.map(a => ({ table: 'evidence', op: 'insert', key: { obs_key: a.obs_key, slot: a.slot ?? 0 }, after: a }))).map(r => r.after);
  }
  if (evidence.remove && evidence.remove.length) {
    const prefixes = (isObj(allowed) && allowed.remove) || [];
    // A removal is an obs_key (every slot) or {obs_key, slot} (one slot), as realtime's normaliseOps accepts.
    for (const k of evidence.remove) {
      const key = typeof k === 'string' ? k : k && k.obs_key;
      if (typeof key !== 'string' || !prefixes.some(p => key.startsWith(p))) throw new Refusal(REASONS.no_delete, 'evidence');
    }
    out.remove = [...evidence.remove];
  }
  if (evidence.repoint && evidence.repoint.length) {
    if (isObj(allowed) && allowed.repoint === false) throw new Refusal(`The change ${op} cannot move evidence.`, 'evidence');
    out.repoint = evidence.repoint;
  }
  return out;
}

// Every stored string in a plan, as [field, text, cap]: row values, evidence values, event summaries, mo_said.
export function planTexts(plan, moSaid) {
  const out = [];
  for (const r of plan.rows || []) {
    for (const [col, v] of Object.entries(r.after || {})) if (typeof v === 'string') out.push([`${r.table}.${col}`, v, capFor(r.table, col)]);
  }
  for (const a of (plan.evidence && plan.evidence.upsert) || []) {
    for (const [col, v] of Object.entries(a)) if (typeof v === 'string') out.push([`evidence.${col}`, v, capFor('evidence', col)]);
  }
  for (const e of plan.events || []) if (typeof e.summary === 'string') out.push(['summary', e.summary, FIELD_CAPS.summary]);
  if (typeof moSaid === 'string') out.push(['mo_said', moSaid, FIELD_CAPS.mo_said]);
  return out;
}

// Caps and question-bank patterns over every stored string; then the leak index, when given.
export function checkTexts(texts, leakIndex = null) {
  for (const [field, text, cap] of texts) {
    if (text.length > cap) throw new Refusal(`${field} is ${text.length} characters; the limit is ${cap}. Say it shorter.`, field);
    if (looksLikeQuestionBank(text)) throw new Refusal(REASONS.question_bank, field);
    if (leakIndex && leakIndex.size) {
      const run = leaks(leakIndex, text);
      if (run) throw new Refusal(`${field} copies the question ("${run}"). Use your own words.`, field);
    }
  }
}

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const ids = list => JSON.stringify([...new Set((list || []).filter(x => x != null).map(String))].slice(0, 200));

export async function leakIndexFor(env, user, { missIds = [], topicIds = [], questions = [] } = {}) {
  const set = new Set();
  const qs = JSON.stringify((questions || []).filter(q => q && q.block_id && Number.isInteger(Number(q.q_index))).slice(0, 20)
    .map(q => ({ b: String(q.block_id), q: Number(q.q_index) })));
  if (!missIds.length && !topicIds.length && qs === '[]') return set;
  let rows;
  try {
    rows = (await env.DB.prepare(
      `SELECT json_extract(e.questions_json, '$[' || m.q_index || ']') AS q
       FROM misses m JOIN blocks b ON b.id = m.block_id JOIN sittings s ON s.id = b.sitting_id JOIN exams e ON e.id = s.exam_id
       WHERE m.user_id = ?1 AND m.block_id IS NOT NULL AND m.q_index IS NOT NULL
         AND (m.id IN (SELECT value FROM json_each(?2)) OR m.topic_id IN (SELECT value FROM json_each(?3)))
       UNION ALL
       SELECT json_extract(e.questions_json, '$[' || CAST(json_extract(j.value, '$.q') AS INTEGER) || ']') AS q
       FROM json_each(?4) j JOIN blocks b ON b.id = json_extract(j.value, '$.b') JOIN sittings s ON s.id = b.sitting_id JOIN exams e ON e.id = s.exam_id
       LIMIT 80`).bind(user, ids(missIds), ids(topicIds), qs).all()).results || [];
  } catch (e) {
    if (noTable(e)) return set;
    throw e;
  }
  for (const r of rows) {
    if (!r.q) continue;
    let q;
    try { q = JSON.parse(r.q); } catch { continue; }
    for (const run of buildLeakIndex(q)) set.add(run);
  }
  return set;
}

// The ids a plan touches that the hold and slip rules care about: miss, gap and sitting ids from its rows
// (keys and values) and from plan.refs {misses, gaps, sittings}.
export function planRefs(plan) {
  const misses = new Set(), gaps = new Set(), sittings = new Set();
  const refs = plan.refs || {};
  for (const id of refs.misses || []) misses.add(String(id));
  for (const id of refs.gaps || []) gaps.add(String(id));
  for (const id of refs.sittings || []) sittings.add(String(id));
  const scan = (table, key, v) => {
    if (!v) return;
    if (v.held === 1 || v.held === true) throw new Refusal(REASONS.held, `${table}.held`);
    if (v.sitting_id) sittings.add(String(v.sitting_id));
    if (v.miss_id) misses.add(String(v.miss_id));
    if (v.gap_id) gaps.add(String(v.gap_id));
  };
  for (const r of plan.rows || []) {
    if (r.table === 'misses' && r.key && r.key.id) misses.add(String(r.key.id));
    if (r.table === 'gaps' && r.key && r.key.id) gaps.add(String(r.key.id));
    scan(r.table, r.key, r.before);
    scan(r.table, r.key, r.after);
  }
  for (const a of (plan.evidence && plan.evidence.upsert) || []) scan('evidence', null, a);
  return { misses: [...misses], gaps: [...gaps], sittings: [...sittings] };
}

/**
 * The hold and slip rules, in one D1 batch (one query): refuses when a touched miss or gap is held or
 * belongs to an unfinished sitting (releasable: status 'done', as map-fields.js releasable()), and, for
 * SLIP_GUARDED_OPS, when every miss it is made from is a misread or test-taking slip.
 * Returns the misses' error types (for planners' own use).
 */
export async function checkRefs(env, user, op, refs, entry = {}) {
  if (!refs.misses.length && !refs.gaps.length && !refs.sittings.length) return { errorTypes: [] };
  const read = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  let misses = [], gaps = [], sittings = [];
  try {
    const [m, g, s] = await env.DB.batch([
      read(`SELECT id, held, sitting_id, error_type FROM misses WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`, user, ids(refs.misses)),
      read(`SELECT id, held, sitting_id FROM gaps WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`, user, ids(refs.gaps)),
      read(`SELECT id, status FROM sittings WHERE id IN (SELECT value FROM json_each(?))
            OR id IN (SELECT sitting_id FROM misses WHERE user_id = ? AND id IN (SELECT value FROM json_each(?)))
            OR id IN (SELECT sitting_id FROM gaps WHERE user_id = ? AND id IN (SELECT value FROM json_each(?)))`,
      ids(refs.sittings), user, ids(refs.misses), user, ids(refs.gaps)),
    ]);
    [misses, gaps, sittings] = [m.results || [], g.results || [], s.results || []];
  } catch (e) {
    if (!noTable(e)) throw e;
    // Before 0010: no misses or map gaps columns yet; sittings still answer for themselves.
    if (refs.sittings.length) sittings = (await read(`SELECT id, status FROM sittings WHERE id IN (SELECT value FROM json_each(?))`, ids(refs.sittings)).all()).results || [];
  }
  if ([...misses, ...gaps].some(r => r.held === 1)) throw new Refusal(REASONS.held);
  if (sittings.some(s => s.status !== 'done')) throw new Refusal(REASONS.held);
  const errorTypes = misses.map(m => m.error_type);
  if ((SLIP_GUARDED_OPS.includes(op) || entry.noSlips) && misses.length && errorTypes.every(t => NO_LESSON_ERRORS.includes(t))) throw new Refusal(REASONS.slip);
  return { errorTypes };
}

/**
 * Every rule for one planned change. Returns the plan with checked rows and evidence. Throws Refusal.
 * leak: {missIds, topicIds} for the leak index (defaults: the plan's refs and touched topics).
 */
export async function guardPlan(env, user, op, entry, plan, { moSaid = null } = {}) {
  const rows = checkRows(user, op, entry, plan.rows || []);
  const evidence = checkEvidence(user, op, entry, plan.evidence);
  const checked = { ...plan, rows, evidence };
  const refs = planRefs(checked);
  const texts = planTexts(checked, moSaid);
  checkTexts(texts); // caps and patterns first: cheap, and no read needed
  await checkRefs(env, user, op, refs, entry);
  const questions = (plan.refs && plan.refs.questions) || [];
  if (texts.length && (refs.misses.length || (plan.touched_topics || []).length || questions.length)) {
    checkTexts(texts, await leakIndexFor(env, user, { missIds: refs.misses, topicIds: plan.touched_topics || [], questions }));
  }
  return checked;
}

const SPOKEN_NUM = "(?:\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty)";
const HIS_REASONING = new RegExp(`\\b(?:so|think|thinking|thought|probably|maybe|perhaps|guess|guessing|sure|unsure|lean|leaning|pick|picked|picking|answer|go with|going with|rule out|ruled out|rules out|must be|has to be|could be|can'?t be|it'?s|this is|that'?s|(?:first|next|last|new|another) (?:question|block|one)|(?:question|number) ${SPOKEN_NUM})\\b`, 'i');
const LEAD_NUMBER = new RegExp(`^(.{0,30}?\\b${SPOKEN_NUM}\\b[,.]?)\\s*which of the following`, 'i');
const CASE_WORDS = 6;
const isLeadIn = s => STEM_LEAD.test(s) || /\?\s*$/.test(s);
export function stemSentence(text) {
  // "Okay, she ..." is read like "She ...": a filler says nothing of whose words follow.
  const s = String(text || '').trim().replace(/^(?:(?:okay|ok|alright|all right|right|um+|uh+|erm|hmm+)\b[\s,.]*)+/i, '');
  if (!s) return null;
  if (looksLikeQuestionText(s)) return 'lead';
  if (FIRST_PERSON_WORD.test(s) || FIRST_PERSON_I.test(s) || HIS_REASONING.test(s) || /,\s*[A-H][.!]?$/.test(s)) return cueOwnLooksLikeStem(s) ? 'case' : null;
  if (isLeadIn(s) && (STEM_LEAD.test(s) || THIS_PATIENT.test(s))) return 'lead';
  if (looksLikeStem(s) || AGE.test(s) || MEASURE.test(s) || FINDING.test(s) || AGO.test(s) || RANGE.test(s) || FINDING_OPENER.test(s) || STEM_STOCK.test(s)) return 'case';
  const words = s.split(/\s+/).length;
  if ((CASE_OPENER.test(s) || CASE_PEOPLE.test(s)) && words >= CASE_WORDS && (A_VERB.test(s) || /\b(?:died|dies|\w{3,}ed)\b/i.test(s))) return 'case';
  if (!OWN_QUESTION.test(s) && !A_VERB.test(s) && words <= 12) return 'bare';
  return null;
}

export const READ_QUESTION = '(read the question)';
export function scrubStemSentences(list) {
  const kind = list.map(x => (x.kept ? null : stemSentence(x.text)));
  const out = list.map((x, i) => {
    const k = kind[i];
    if (k === 'lead') { const m = LEAD_NUMBER.exec(x.text); return m ? `${m[1].trim()} ${READ_QUESTION}` : READ_QUESTION; }
    if (k === 'case') return READ_QUESTION;
    if (k !== 'bare') return x.text;
    let p = i - 1, n = i + 1;
    while (p >= 0 && kind[p] === 'bare') p--;
    while (n < list.length && kind[n] === 'bare') n++;
    return n < list.length && (kind[n] === 'case' || kind[n] === 'lead') && !(p >= 0 && kind[p] === 'lead') ? READ_QUESTION : x.text;
  });
  return out;
}
