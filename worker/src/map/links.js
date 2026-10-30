import { LINK_TYPES, TYPE_NAMES, MIXED_UP, FLAGS } from '../../../public/js/shared/link-rank.js';
import { VERSUS } from '../checks.js';

export { LINK_TYPES, TYPE_NAMES, MIXED_UP, FLAGS };
export const DAY_MS = 86_400_000;
export const STATUSES = ['held', 'proposed', 'active', 'removed'];
// Readers only ever see these (a held link is invisible everywhere).
export const VISIBLE = ['active', 'proposed'];
export const EDITABLE = ['status', 'a_vs_b', 'b_vs_a', 'how', 'note', 'picture'];
// Columns code computes from the support rows (they are written only with the support that moves them).
export const CODE_COLS = ['strength', 'support_n', 'confusion', 'confusion_at', 'confused_n', 'last_confused_at', 'last_truth_id', 'last_tested_at'];
export const CAPS = { fact: 240, note: 200, text: 300, evidence: 200, reason: 200, head: 80 };

// Support sources (link_support.src is open text checked here, so a new spoken source needs no migration).
export const SOURCES = ['anki_log', 'hub_analysis', 'uworld', 'anking_hy', 'card', 'gap', 'anki_review', 'lesson', 'retest',
  'onenote', 'mehlman', 'seed', 'extractor', 'claude', 'mo', 'derived'];
export const CODE_SOURCES = ['anki_log', 'hub_analysis', 'uworld', 'anking_hy', 'card', 'gap', 'anki_review', 'lesson', 'retest', 'derived'];
export const ROLES = ['picked', 'considered', 'title', 'classic', 'mixed', 'named', 'test_right', 'test_wrong', 'lesson', 'retest_got', 'retest_missed', 'added'];

// Strength weight w of one support row, by source (and role for the Anki log's classic look-alikes).
export const W = {
  mo: 1.0, anking_hy: 0.7, card: 0.6, claude: 0.6, seed: 0.6, lesson: 0.6,
  anki_log: 0.5, uworld: 0.5, onenote: 0.5, mehlman: 0.5, gap: 0.5, anki_review: 0.5, retest: 0.5,
  anki_log_classic: 0.4, hub_analysis: 0.4, extractor: 0.4, derived: 0.4,
};
export function weightOf(src, role = null) {
  if (src === 'anki_log' && role === 'classic') return W.anki_log_classic;
  return W[src] ?? 0.4;
}

// Signed confusion weights cw (plan §8). On one miss only the largest counts; a flawed right answer counts
// half; misreads and test-taking slips add support but no confusion.
export const CW = {
  picked_sure: 1.5, picked: 1.0, gap_stated: 1.0, title: 0.8, considered: 0.6, mixed_review: 0.6,
  test_wrong: 0.5, test_wrong_max: 1.0, retest_missed: 0.8, card_lapse: 0.2,
  test_right_same_day: -0.15, test_right_later: -0.3,
  // A pair lesson is same-day proof, so it counts like a same-day right pair test: only delayed proof clears a pair.
  lesson_landed: -0.15, lesson_partial: -0.05, lesson_not_landed: 0.3, retest_got: -0.4,
};
export const SLIP_ERRORS = ['misread', 'test_taking'];

const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const lc = s => String(s || '').toLowerCase();

/** cw of a miss's look-alike, by role. miss: {confidence, result, error_type}. */
export function cwForMiss(role, miss = {}) {
  let cw = role === 'picked' ? (miss.confidence === 'sure' ? CW.picked_sure : CW.picked)
    : role === 'title' ? CW.title : role === 'considered' ? CW.considered : role === 'mixed' ? CW.mixed_review : 0;
  if (SLIP_ERRORS.includes(miss.error_type)) return 0;
  if (miss.result === 'flawed') cw /= 2;
  return cw;
}

// ------------------------------------------------------------------ strength and confusion

const released = rows => (rows || []).filter(r => r && !(r.held === 1 || r.held === true));

export function strengthOf(rows) {
  const rel = released(rows);
  if (rel.some(r => r.src === 'mo' && r.w >= 1)) return 1;
  let keep = 1;
  for (const r of rel) if (r.w > 0) keep *= 1 - Math.min(0.99, r.w);
  return round(Math.min(0.99, 1 - keep));
}

// Time order; at the same time, stored rows (by id) before rows not yet written, which keep their given order.
const NEW = Number.MAX_SAFE_INTEGER;
const byTime = (a, b) => (a.at - b.at) || ((a.id ?? NEW) - (b.id ?? NEW));

/** Confusion at now, replaying released rows in time order with half-life hlDays. */
export function confusionFrom(rows, now, hlDays) {
  if (!(hlDays > 0)) throw new Error('confusionFrom needs the half-life in days');
  const hl = hlDays * DAY_MS;
  let c = 0, t = null;
  for (const r of released(rows).filter(x => x.cw).sort(byTime)) {
    if (t != null && r.at > t) c *= 0.5 ** ((r.at - t) / hl);
    c = Math.max(0, c + r.cw);
    t = t == null ? r.at : Math.max(t, r.at);
  }
  if (t != null && now > t) c *= 0.5 ** ((now - t) / hl);
  return round(c);
}

/** confusion stored at confusionAt, decayed to now (what the hourly refresh writes). */
export const decayed = (c, confusionAt, now, hlDays) => (c > 0 && confusionAt != null && now > confusionAt ? round(c * 0.5 ** ((now - confusionAt) / (hlDays * DAY_MS))) : c);

export const isMixedUp = c => c >= MIXED_UP;

/** Every code-computed column of a link from all its support rows (held ones included, and ignored). */
export function aggregate(rows, now, hlDays, type = 'versus') {
  const rel = released(rows);
  const mix = rel.filter(r => r.cw > 0).sort(byTime);
  const tested = rel.filter(r => ['test_right', 'test_wrong', 'lesson'].includes(r.role));
  const last = mix[mix.length - 1];
  return {
    strength: strengthOf(rows),
    support_n: rel.filter(r => r.w > 0 || r.cw).length,
    confusion: type === 'versus' ? confusionFrom(rows, now, hlDays) : 0,
    confusion_at: now,
    confused_n: mix.length,
    last_confused_at: last ? last.at : null,
    last_truth_id: last ? last.truth_id ?? null : null,
    last_tested_at: tested.length ? Math.max(...tested.map(r => r.at)) : null,
  };
}

const listedOnce = rel => rel.every(r => r.role === 'classic' && !(r.cw > 0)) && new Set(rel.map(r => r.obs_key)).size < 2;

export function nextStatus(current, rows) {
  if (current === 'removed') return 'removed';
  const live = r => r.w > 0 || r.cw;
  const rel = released(rows).filter(live);
  if (!rel.length) return (rows || []).some(live) ? (current && current !== 'held' ? current : 'held') : current || 'held';
  if ((!current || current === 'held') && listedOnce(rel)) return 'held';
  if (current === 'proposed' && !rel.some(r => ['claude', 'mo', 'seed'].includes(r.src))) return 'proposed';
  if (current === 'proposed' || current === 'held' || !current) return rel.every(r => r.src === 'extractor') ? 'proposed' : 'active';
  return current;
}

// Strength bands for the drawing (an event is sent only when one changes).
const band = s => (s >= 0.9 ? 3 : s >= 0.7 ? 2 : s >= 0.4 ? 1 : 0);

/** Whether a change to a link shows on the map (status, mixed-up, confusion100 by 10+, strength band, picture, facts). */
export function drawnChanged(before, after) {
  if (!before) return VISIBLE.includes(after.status);
  if (before.status !== after.status) return true;
  if (isMixedUp(before.confusion || 0) !== isMixedUp(after.confusion || 0)) return true;
  if (Math.abs(Math.round((before.confusion || 0) * 100) - Math.round((after.confusion || 0) * 100)) >= 10) return true;
  if (band(before.strength || 0) !== band(after.strength || 0)) return true;
  return ['picture', 'a_vs_b', 'b_vs_a', 'how', 'note'].some(k => (before[k] ?? null) !== (after[k] ?? null));
}

// ------------------------------------------------------------------ identity and direction

/** 'l_' + the first 12 hex of sha256(user|type|from|to), made once at creation and kept through merges. */
export async function linkId(user, type, from, to) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${user}|${type}|${from}|${to}`)));
  return 'l_' + [...h.slice(0, 6)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * {type, from, to, a_vs_b?, b_vs_a?, kinds?: {[topic_id]: kind}} -> {type, from_id, to_id, directed, swapped,
 * a_vs_b, b_vs_a} or {error}. versus is sorted (from_id < to_id, facts swapped with it); treated_by points at
 * the drug and adverse_effect starts from it (swapped when reversed); causes keeps the order given.
 */
export function normaliseLink({ type, from, to, a_vs_b = null, b_vs_a = null, kinds = {} }) {
  const spec = LINK_TYPES[type];
  if (!spec) return { error: `Unknown link type ${type}. Use one of ${TYPE_NAMES.join(', ')}.` };
  if (!from || !to) return { error: 'A link needs two topics.' };
  if (from === to) return { error: 'A topic cannot be linked to itself.' };
  let swapped = false;
  const isDrug = id => kinds[id] === 'drug';
  // A treatment is a drug or a procedure (detorsion, cesarean delivery, needle decompression).
  const isTreatment = id => (LINK_TYPES.treated_by.to_kinds || ['drug']).includes(kinds[id]);
  const isTx = id => kinds[id] === 'drug' || kinds[id] === 'procedure';
  if (type === 'versus' && kinds[from] && kinds[to] && isTx(from) !== isTx(to)) {
    return { error: 'A look-alike pair is two diagnoses (or two drugs, or two procedures); link a treatment with treated_by instead.' };
  }
  if (type === 'versus') swapped = from > to;
  else if (type === 'treated_by') {
    if (!isTreatment(to) && isTreatment(from)) swapped = true;
    else if (!isTreatment(to)) return { error: 'Add the drug or procedure as a topic first (a treated_by link points at the treatment).' };
  } else if (type === 'adverse_effect') {
    if (!isDrug(from) && isDrug(to)) swapped = true;
    else if (!isDrug(from)) return { error: 'Add the drug as a topic first (a side effect starts from a drug).' };
  }
  const [f, t] = swapped ? [to, from] : [from, to];
  return { type, from_id: f, to_id: t, directed: spec.directed ? 1 : 0, swapped,
    a_vs_b: swapped ? b_vs_a : a_vs_b, b_vs_a: swapped ? a_vs_b : b_vs_a };
}

/** The checked 'how' for a type (null when the type has none or how is empty), or {error}. */
export function checkHow(type, how) {
  if (how == null || how === '') return null;
  const hows = (LINK_TYPES[type] || {}).hows;
  if (!hows) return { error: `A ${type} link has no "how".` };
  return hows.includes(how) ? how : { error: `how is one of ${hows.join(', ')}.` };
}

// ------------------------------------------------------------------ the Versus line

/**
 * 'Versus <other>: <finding>, so <what you do differently>.' from Claude's fact (written from this topic's
 * side). A fact that already starts with 'Versus …:' keeps its own wording. Returns {line} or {error}.
 */
export function versusLine(otherName, fact) {
  let f = String(fact || '').trim().replace(/\s+/g, ' ');
  if (!f) return { error: 'The fact is empty.' };
  const m = /^versus\s+[^:]{1,}:\s*(.+)$/i.exec(f);
  if (m) f = m[1];
  f = f.replace(/[.\s]+$/, '');
  const line = `Versus ${String(otherName).trim()}: ${f}.`;
  if (!/, so /.test(f) || !VERSUS.test(line)) {
    return { error: 'Write the fact as "<finding that tells them apart>, so <what you do differently>", e.g. "dry eye and a normal fundus, so give vitamin A".' };
  }
  if (line.length > CAPS.fact) return { error: `The Versus line is ${line.length} characters; the limit is ${CAPS.fact}. Say it shorter.` };
  return { line };
}

// ------------------------------------------------------------------ look-alike detection (names, roles)

// Where a look_alikes segment stops naming and starts explaining: ':', a sentence end, ', ', '(' or a verb.
const HEAD_CUT = /\s*(?::|(?<!\bvs)\.\s| also | is | are | was | were | gives | give | has | have | means | needs | need | would | could | can | causes | shows | follows | blocks | compresses | looks | enlarges | belongs | lowers | changes | adds | only | counts | does | do | not | rules? | pressing | without | because |, |\()/i;
// Not a name (RH2-2): a pronoun, conjunction or adverb at the start ("it", "she", "that", "even then CT"), a
// dangling word at the end ("... when it", "... compresses the chiasm and"), or a bracket left open.
const NOT_A_NAME_START = /^(?:it|its|this|that|these|those|she|he|her|his|him|they|them|their|there|here|then|also|even|with|one|so|but|and|or|if|when|which|who|what|why|how|both|each|either|neither|any|some|no|mixed it)\b/i;
const NOT_A_NAME_END = /\b(?:and|or|when|is|are|it|but|if|of|to|for|in|on|the|a|an|that|which|than|only|by|as|at)$/i;

/**
 * The look-alike's name at the head of a look_alikes segment: up to 8 words, cut at ':', a sentence end, ', ',
 * '(' or the first verb (' also ', ' is ', ' gives ', ' means ', ' needs ' ...), with a leading article dropped
 * ("A septate uterus" -> "septate uterus"). Null when what is left is not a name (a pronoun, a fragment).
 */
export function lookAlikeHead(text) {
  const s = String(text || '').trim().replace(/^[-*•\d.)\s]+/, '').replace(/^(?:versus|vs\.?)\s+/i, '');
  const cut = s.split(HEAD_CUT)[0].trim().replace(/[.;]+$/, '').replace(/^(?:a|an|the)\s+/i, '');
  const words = cut.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8) return null;
  const head = words.join(' ');
  if (NOT_A_NAME_START.test(head) || NOT_A_NAME_END.test(head) || /[()[\]]/.test(head)) return null;
  return head.length >= 2 && head.length <= CAPS.head ? head : null;
}

const VS = /\s+(?:vs\.?|versus)\s+/i;
// Words that qualify a shared noun on the left of 'A versus B' ('Anterior versus posterior shoulder dislocation').
const SIDE_WORDS = /^(?:anterior|posterior|internal|external|acute|chronic|primary|secondary|tertiary|upper|lower|left|right|superficial|deep|sigmoid|cecal|central|peripheral|unilateral|bilateral|systolic|diastolic|early|late|partial|complete|benign|malignant|open|closed|direct|indirect|inferior|superior|proximal|distal|medial|lateral|congenital|acquired|transient|persistent|mild|severe|total|focal|generalized|simple|complex|absence|obstructive|restrictive|central|nephritic|nephrotic|type)$/i;

export function vsHalves(title) {
  let s = String(title || '').split(/\s+[—–]\s+|\s+-\s+/)[0].trim();
  const parts = s.split(':');
  if (parts.length > 1) s = VS.test(parts[parts.length - 1]) ? parts[parts.length - 1].trim() : parts[0].trim();
  const sides = s.split(VS);
  if (sides.length !== 2) return null;
  const [a, b] = sides.map(x => x.trim().replace(/[.?!]+$/, ''));
  if (!a || !b || /,|\band\b|\bor\b/i.test(a) || /,|\band\b|\bor\b/i.test(b)) return null;
  if (a.split(/\s+/).length > 8 || b.split(/\s+/).length > 8) return null;
  return [a, b];
}

/**
 * Names to try for each half of a two-way title, most likely first. 'Acute versus chronic pancreatitis' shares
 * its noun: ['Acute pancreatitis', 'Acute'] and ['chronic pancreatitis'].
 */
export function titleNames(title) {
  const h = vsHalves(title);
  if (!h) return null;
  const [a, b] = h;
  const aw = a.split(/\s+/), bw = b.split(/\s+/);
  const sideA = [a];
  // A one- or two-word adjective on the left takes the right side's noun: 'Internal versus external hemorrhoids'.
  if (aw.length <= 2 && bw.length >= 2) sideA.unshift(`${a} ${bw.slice(1).join(' ')}`);
  return [sideA, [b]];
}

/**
 * Every look-alike name a miss carries: [{text, from: 'head'|'named'|'title'}], de-duplicated, in order.
 * Sources: the head of each look_alikes segment (the log's field, or the analysis's look_alike), the server's
 * look_alike_names, and both halves of an 'A vs B' topic_raw. The true topic is dropped later, by id.
 */
export function lookAlikeNames(miss) {
  const out = [];
  const seen = new Set();
  const add = (text, from, vs = false) => {
    const t = String(text || '').trim();
    const k = lc(t);
    if (!t || seen.has(k)) return;
    seen.add(k);
    out.push(vs ? { text: t, from, vs: true } : { text: t, from });
  };
  for (const seg of String(miss.look_alikes || '').split(/;|\n|\s\|\s/)) {
    const head = lookAlikeHead(seg);
    if (!head) continue;
    if (!VS.test(head)) { add(head, 'head'); continue; }
    // "Iron deficiency versus sideroblastic anaemia: ..." names two: each half is tried (the true topic drops out by
    // id); a one-word left side takes the right side's noun ("Anterior versus posterior shoulder dislocation").
    const halves = head.split(VS);
    const aw = halves[0].trim().split(/\s+/), bw = (halves[1] || '').trim().split(/\s+/);
    if (halves.length === 2 && aw.length === 1 && bw.length >= 2 && SIDE_WORDS.test(aw[0])) halves[0] = `${aw[0]} ${bw.slice(1).join(' ')}`;
    for (const h of halves) { const n = lookAlikeHead(h); if (n) add(n, 'head', true); }
  }
  let named = [];
  try { named = JSON.parse(miss.look_alike_names_json || '[]'); } catch { named = []; }
  for (const n of Array.isArray(named) ? named.slice(0, 3) : []) if (typeof n === 'string' && n.length <= CAPS.head) add(n, 'named');
  const h = vsHalves(miss.topic_raw);
  if (h) for (const x of h) add(x, 'title');
  return out;
}

const PICK = /\b(?:picked|pick|chose|choose|went with|go with|going with|switched to|switch to|called it|thought|put)\b/i;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function roleOf(reasoning, names) {
  const text = lc(reasoning);
  if (!text) return null;
  let found = false;
  for (const n of names || []) {
    const name = lc(n).trim();
    if (name.length < 3) continue;
    const re = new RegExp(`(^|[^a-z0-9])${esc(name)}(?=$|[^a-z0-9])`, 'g');
    let m;
    while ((m = re.exec(text))) {
      found = true;
      const at = m.index + m[1].length;
      const win = text.slice(Math.max(0, at - 60), Math.min(text.length, at + name.length + 60));
      if (PICK.test(win)) return 'picked';
    }
  }
  return found ? 'considered' : null;
}

/** The role of look-alike B on a miss: picked > title > considered > classic (largest cw wins). */
export function lookAlikeRole(miss, from, aliases) {
  const r = roleOf(miss.my_reasoning, aliases);
  if (r === 'picked') return 'picked';
  if (from === 'title') return 'title';
  return r || 'classic';
}

// ------------------------------------------------------------------ gaps (v1.5)

/** Two names from a gap's own words ('SIADH vs cerebral salt wasting', 'the difference between X and Y'), or null. */
export function gapPair(text) {
  // A bracketed aside ("Campylobacter (poultry, fever) from E. coli") is detail, not a name.
  const flat = String(text || '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const t = /\b[Tt]ell\s+(?:apart\s+)?(.+?)\s+(?:apart\s+)?(?:from|and)\s+(.+?)(?:\s+apart)?(?:[,;?!]|\.(?=\s*$|\s+[A-Z][a-z])|\s+by\b|\s+even\b|$)/.exec(flat);   // no i: the full stop's capital must be one
  if (t) {
    const two = [t[1], t[2]].map(x => x.trim().replace(/^(?:the|a|an)\s+/i, ''));
    if (two.every(x => x && x.split(/\s+/).length <= 8 && !/,|\bor\b/i.test(x))) return two;
  }
  const s = flat.replace(/^(?:i\s+(?:don'?t|do not|can'?t|cannot)\s+(?:get|tell|remember|separate)\s+)/i, '');
  const m = /difference between\s+(.+?)\s+and\s+(.+?)(?:[.?!]|$)/i.exec(s);
  if (m) return [m[1].trim(), m[2].trim()].map(x => x.replace(/^(?:the|a|an)\s+/i, ''));
  return vsHalves(s);
}

// ------------------------------------------------------------------ pair tests (teach's pair_test)

const fnv = s => { let h = 0x811c9dc5; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h; };

// The 14 orders of four cases with at least one of each side (not AAAA or BBBB): no fixed pattern and no 2 + 2
// balance, so the first answers never give the rest away.
export const PAIR_ORDERS = Array.from({ length: 16 }, (_, n) => [3, 2, 1, 0].map(b => ((n >> b) & 1 ? 'b' : 'a'))).filter(o => o.includes('a') && o.includes('b'));
/** One of PAIR_ORDERS, from a hash of the lesson id, so the order is fixed for that lesson and never predictable. */
export const pairOrder = lessonId => [...PAIR_ORDERS[fnv(lessonId) % PAIR_ORDERS.length]];
export const orderName = order => order.map(x => x.toUpperCase()).join('');

/**
 * Marks a pair test by code: items [{case_for: 'a'|'b', said: 'a'|'b'|'unsure'}] must follow order exactly.
 * Returns {marks: [{case_for, said, right}], right_n, outcome} or {error}.
 */
export function markPairItems(items, order) {
  if (!Array.isArray(items) || items.length !== order.length) return { error: `A pair test has ${order.length} cases, in the order ${orderName(order)}.` };
  const marks = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    if (it.case_for !== order[i]) return { error: `Case ${i + 1} should be for ${order[i].toUpperCase()}: the order is ${orderName(order)}.` };
    if (!['a', 'b', 'unsure'].includes(it.said)) return { error: `Case ${i + 1}: said is a, b or unsure.` };
    marks.push({ case_for: it.case_for, said: it.said, right: it.said === it.case_for });
  }
  const right_n = marks.filter(m => m.right).length;
  return { marks, right_n, outcome: right_n === marks.length ? 'landed' : right_n === marks.length - 1 ? 'partial' : 'not_landed' };
}

/**
 * Support rows for one pair test on a link ('a' is from_id, 'b' to_id). A wrong case adds +0.5 (at most +1.0
 * a test); a right one takes off 0.15 on the day of the last mix-up or lesson, and 0.3 on a later day, so only
 * delayed proof clears a pair. delayed: whether today is after that day (links-store works it out).
 */
export function pairTestSupport({ lessonId, marks, link, at, delayed }) {
  let wrongCw = 0;
  return marks.map((m, i) => {
    const caseTopic = m.case_for === 'a' ? link.from_id : link.to_id;
    let cw;
    if (m.right) cw = delayed ? CW.test_right_later : CW.test_right_same_day;
    else { cw = Math.max(0, Math.min(CW.test_wrong, CW.test_wrong_max - wrongCw)); wrongCw += cw; }
    return { obs_key: `lesson:${lessonId}:pair:${i + 1}`, src: 'lesson', role: m.right ? 'test_right' : 'test_wrong', w: W.lesson, cw,
      truth_id: m.right ? null : caseTopic, lesson_id: lessonId, at };
  });
}

/** The support row a pair lesson's outcome adds (landed −0.15, partial −0.05, not_landed +0.3). */
export function pairLessonSupport({ lessonId, outcome, at }) {
  const cw = { landed: CW.lesson_landed, partial: CW.lesson_partial, not_landed: CW.lesson_not_landed }[outcome];
  if (cw == null) return null;
  return { obs_key: `lesson:${lessonId}:pair_lesson`, src: 'lesson', role: 'lesson', w: W.lesson, cw, lesson_id: lessonId, at };
}

/** A concept re-test on a miss that carries the pair: got_it −0.4, missed_again +0.8 (v1.5). */
export function retestSupport({ missId, mistakeId, due, result, at, truthId }) {
  const got = result === 'got_it';
  if (!got && result !== 'missed_again') return null;
  return { obs_key: `retest:${mistakeId}:${due}`, src: 'retest', role: got ? 'retest_got' : 'retest_missed', w: W.retest,
    cw: got ? CW.retest_got : CW.retest_missed, truth_id: got ? null : truthId ?? null, miss_id: missId, at };
}

// ------------------------------------------------------------------ payload

/** look's payload flags for one link row: 1 directed, 2 proposed, 4 has a picture. */
export function linkFlags(link) {
  return (link.directed ? FLAGS.directed : 0) | (link.status === 'proposed' ? FLAGS.proposed : 0) | (link.picture ? FLAGS.picture : 0);
}

// confusion100 in the payload: min(c, 2.55) × 100, so it fits a byte.
export const confusion100 = c => Math.round(Math.min(Math.max(c || 0, 0), 2.55) * 100);

// ------------------------------------------------------------------ map_rules (MCP's rules.js reads this)

/** The links part of map_rules, generated from LINK_TYPES, W and CW so it never drifts from the code. */
export function linkRules() {
  const types = Object.entries(LINK_TYPES).map(([t, s]) => `${t} (${s.directed ? 'directed' : 'undirected'}${s.hows ? `; how: ${s.hows.join(', ')}` : ''})`);
  return [
    `Link types: ${types.join('; ')}. Same mechanism, shared buzzwords and next-step chains are not links.`,
    'A versus pair is "mixed up" while its confusion is 0.5 or more; code computes strength and confusion, nobody sets them.',
    `Strength = 1 − Π(1 − w): Mo ${W.mo}, AnKing HY title ${W.anking_hy}, Claude ${W.claude}, Anki log ${W.anki_log} (classic ${W.anki_log_classic}), hub analysis ${W.hub_analysis}.`,
    `Confusion adds per mix-up: picked and sure +${CW.picked_sure}, picked +${CW.picked}, stated gap +${CW.gap_stated}, "A vs B" title +${CW.title}, considered +${CW.considered}; a flawed right answer counts half; misreads and test-taking slips add none. It halves every 21 days.`,
    `Pair test (4 cases, order drawn by code): wrong +${CW.test_wrong} each (at most +${CW.test_wrong_max}); right ${CW.test_right_same_day} on the day of the mix-up or lesson, ${CW.test_right_later} on a later day, so only delayed proof clears a pair. Pair lesson landed ${CW.lesson_landed}, partial ${CW.lesson_partial}, not landed +${CW.lesson_not_landed}.`,
    'map_add_link resolves names at 0.9 or more only, never creates a topic, and for versus takes the fact as "<finding>, so <what you do differently>". A link Mo removed stays removed unless he asks (restore: true). Removing over 5 links asks Mo.',
  ].join('\n');
}
