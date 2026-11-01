
export const CAUSES = ['confusion', 'missing_fact', 'reasoning', 'ignored_clue', 'misread', 'guess'];
// Bumped when the cause rules change, so the overseer never mixes misses judged under different rules.
export const CAUSE_VERSION = 1;

export const CAUSE_MULT = { missing_fact: 1, confusion: 1, reasoning: 0.8, ignored_clue: 0.8, guess: 0.8, misread: 0.3 };

// The error types (Anki keys or the hub's words) as causes, for a miss nobody has judged a cause on.
const ERROR_CAUSE = { knowledge_gap: 'missing_fact', threshold: 'missing_fact', premature_closure: 'reasoning', faulty_synthesis: 'reasoning',
  misread: 'misread', test_taking: 'misread', calculation: 'misread' };
export function errorCause(v) {
  const k = String(v || '').trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
  if (!k) return null;
  if (ERROR_CAUSE[k]) return ERROR_CAUSE[k];
  for (const [pre, c] of [['knowledge', 'missing_fact'], ['threshold', 'missing_fact'], ['premature', 'reasoning'], ['faulty', 'reasoning'],
    ['misread', 'misread'], ['test', 'misread'], ['calc', 'misread']]) if (k.startsWith(pre)) return c;
  return null;
}

export const COULD_NOT_TELL = /\b(?:can(?:no|')?t|cannot|could(?:n'?t| not)|couldnt|cant|don'?t know how to|do not know how to)\s+(?:really\s+)?(?:tell|separate|distinguish|differentiate)\b|\btell\s+(?:them|the two|these|those|it)\s+apart\b|\bmix(?:ed|es|ing)?[ -]?(?:them\s+|these\s+|the two\s+|it\s+)?up\b|\b(?:got|get|was|i'?m|am)\s+confused\b|\bconfus(?:e|ed|ing)\s+(?:them|the two|these|those|it|(?:\w+\s+){1,5}with)\b|\bconfused between\b|\btorn between\b|\blean(?:ing)? between\b|\blook(?:s|ed)?\s+(?:the same|alike|identical)\b|\bsame thing\b/i;
const TOOK_FOR = /\bthought (?:it|this|that) (?:was|is|were)\b|\bmistook\b|\bmistaken for\b|\btook (?:it|this|that) (?:for|as)\b|\bthought of\b/i;
export const confusionWords = text => !!text && (COULD_NOT_TELL.test(text) || TOOK_FOR.test(text));

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether text names one of the names (whole words, case-insensitive, names of 3 or more characters). */
export function namesAny(text, names) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  for (const n of names || []) {
    const name = String(n || '').toLowerCase().trim();
    if (name.length < 3) continue;
    if (new RegExp(`(^|[^a-z0-9])${esc(name)}(?=$|[^a-z0-9])`).test(t)) return true;
  }
  return false;
}

const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t ? (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t) : null; };
const sentenceWith = (text, re) => String(text || '').split(/(?<=[.?!;])\s+/).find(s => re.test(s)) || null;
const truthy = v => v === true || v === 1 || v === '1' || v === 'true';

export function causeOf(m) {
  if (!m) return null;
  if (CAUSES.includes(m.cause)) {
    return { cause: m.cause, quote: cut(m.cause_quote, 300), inferred: m.cause_inferred == null ? true : truthy(m.cause_inferred),
      detail: cut(m.cause_detail, 120), judged: true,
      ...(truthy(m.cause_disputed) ? { disputed: true } : {}) };
  }
  const fromError = errorCause(m.error_type);
  if (fromError === 'misread') return { cause: 'misread', quote: null, inferred: true, detail: null, judged: false };
  const words = /^\s*going by my pick\b/i.test(m.my_reasoning || '') ? '' : String(m.my_reasoning || '');
  if (confusionWords(words)) {
    return { cause: 'confusion', quote: cut(sentenceWith(words, COULD_NOT_TELL) || sentenceWith(words, TOOK_FOR) || words, 300), inferred: true, detail: null, judged: false };
  }
  if (m.flaw_kind === 'lucky_guess' || m.outcome === 'right_guess') return { cause: 'guess', quote: null, inferred: true, detail: null, judged: false };
  return fromError ? { cause: fromError, quote: null, inferred: true, detail: null, judged: false } : null;
}

export function confusionShown(c, names) {
  if (!c || c.cause !== 'confusion') return false;
  // A cause the judges disputed makes no look-alike line and no penalty until a third look settles it (answer forms).
  if (c.disputed) return false;
  if (c.inferred === false) return true;
  const q = c.quote || '';
  return COULD_NOT_TELL.test(q) || namesAny(q, names);
}

/** The cause's weight on the right topic's miss. confidence: the answer's sure/lean/guess. */
export function causeMult(cause, confidence = null) {
  if (cause === 'guess') return confidence === 'guess' ? 1 : CAUSE_MULT.guess;
  return CAUSE_MULT[cause] ?? null;
}

export function causeWords(c, { lookAlike = null } = {}) {
  if (!c) return null;
  const detail = c.detail ? cut(c.detail, 90) : null;
  switch (c.cause) {
    case 'confusion': return { key: 'confusion', text: lookAlike ? `Mixed up with ${cut(lookAlike, 60)}` : 'Mixed up two look-alikes' };
    case 'missing_fact': return { key: 'missing_fact', text: detail ? `Didn't know: ${detail}` : "Didn't know a fact" };
    case 'ignored_clue': return { key: 'reasoning', text: detail ? `Reasoning: ${detail}` : 'Reasoning: passed over a clue' };
    case 'reasoning': return { key: 'reasoning', text: detail ? `Reasoning: ${detail}` : 'Reasoning went wrong' };
    case 'misread': return { key: 'misread', text: 'Misread' };
    default: return null;
  }
}

// The Opus check of a spoken card review (the hub's Cards page, the Mac add-on, the phone, Anki Voice: weights.js CHECK_SOURCES).
const CHECKED_GAP_SOURCES = ['anki_mac', 'anki_hub', 'anki_phone', 'anki_voice_check'];

export function gapShowsConfusion(gap) {
  if (!gap || !gap.mixed_with) return false;
  // A gap with a judged cause (the answer forms' shared core, 0067) is a mix-up only when that cause is a confusion.
  if (CAUSES.includes(gap.cause)) return gap.cause === 'confusion';
  if (CHECKED_GAP_SOURCES.includes(gap.source)) return true;
  const words = [gap.gap, gap.said].filter(Boolean).join(' ');
  if (!words) return false;
  return COULD_NOT_TELL.test(words) || (confusionWords(words) && namesAny(words, [gap.mixed_with]));
}

// ---------------------------------------------------------------- the judges' shared rules

// The one text both judges (and the re-judge) follow, so a cause means the same wherever it was named.
export const CAUSE_RULES = `## Cause (wrong and right_flawed only)
Name the one cause of the miss from his own words, as one of:
- confusion: he took the right answer for another condition, drug or step (or the reverse), or could not tell the two apart. Only when his words name the other one as what he thought it was, or say he could not tell them apart ("I thought it was X", "X or Y, can't tell", "mixed them up"). Having considered another option is not enough, but a considered option can still be a confusion when his words show he could not separate them.
- missing_fact: he did not know one fact, criterion, drug or next step the question turned on.
- reasoning: he had the facts (his words show them) and put them together wrongly.
- ignored_clue: his words show he passed over a clue in the case that should have decided it.
- misread: he misread or skipped a detail he would have known, or slipped (misclick, changed a right answer, ran out of time).
- guess: he had no idea and guessed among three or more.
cause_quote: his own words (at most 25, copied) that show the cause, or an empty string when he said nothing usable.
cause_inferred: false only when he named the cause himself ("I didn't know that", "I mixed them up", "I misread it"); true when you worked it out.
cause_detail: the missing fact or the ignored clue in a few plain words ("caudate atrophy in Huntington's"), or an empty string.
look_alike is only a teaching contrast: the condition the right answer is best told apart from. It carries no weight, and it may be empty.`;

// The cause fields of a structured-output schema (the judges add them to their own schemas).
export const CAUSE_SCHEMA_PROPS = {
  cause: { anyOf: [{ type: 'string', enum: CAUSES }, { type: 'null' }] },
  cause_quote: { type: 'string' },
  cause_inferred: { type: 'boolean' },
  cause_detail: { type: 'string' },
};
export const CAUSE_FIELDS = Object.keys(CAUSE_SCHEMA_PROPS);

/** A judge's cause fields made safe: {cause, cause_quote, cause_inferred, cause_detail} (nulls when absent or bad). */
export function tidyCause(x) {
  const cause = x && CAUSES.includes(x.cause) ? x.cause : null;
  if (!cause) return { cause: null, cause_quote: null, cause_inferred: null, cause_detail: null };
  const said = x.cause_inferred === false || x.cause_inferred === 0 || x.cause_inferred === '0';
  return { cause, cause_quote: cut(x.cause_quote, 300), cause_inferred: said ? 0 : 1, cause_detail: cut(x.cause_detail, 120) };
}
