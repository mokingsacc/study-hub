
export const EVIDENCE = Object.freeze({
  thin: 2,             // n_eff under this: thin
  solid: 5,            // n_eff at least this (and a real answer in recent_days): solid
  recent_days: 60,
  fade_days: 14,       // fsrs.js FIT.fade_days: n halves every 14 days since the last review (a test pins them equal)
  pale_chroma: 0.4,    // a thin star keeps this share of its colour's chroma
  z: 1.28,             // the "N% next time" range: p ± z·sqrt(p(1-p)/(n_eff + k)), an 80% range
  k: 3,                // fsrs.js FIT.k0: the prior's weight in answers
});
export const DAY_MS = 86_400_000;
export const LEVELS = Object.freeze(['thin', 'some', 'solid']);
export const EVIDENCE_WORDS = Object.freeze({ thin: 'evidence: thin', some: 'evidence: some', solid: 'evidence: solid' });

const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** n_eff now: the stored question-side weight faded from its review clock (exact, like the model's own fade). */
export function nEff(realN, at, now = Date.now(), fadeDays = EVIDENCE.fade_days) {
  const n = num(realN);
  if (n == null || n <= 0) return 0;
  const t = num(at);
  const age = t == null ? 0 : Math.max(0, (Number(now) - t) / DAY_MS);
  return n * Math.pow(2, -age / fadeDays);
}

export function evidenceLevel(n_eff, lastQuestionAt = null, now = Date.now()) {
  const n = num(n_eff) || 0;
  if (n < EVIDENCE.thin) return 'thin';
  const last = num(lastQuestionAt);
  if (n >= EVIDENCE.solid && last != null && Number(now) - last <= EVIDENCE.recent_days * DAY_MS) return 'solid';
  return 'some';
}

/**
 * The level of a stored topic_scores row (or the panel's score): fsrs_real_n at fsrs_at when the row has it; a row from
 * before 0055 counts its questions and re-tests, faded from the last one, until its next recompute fills the column.
 */
export function levelOfScore(s, now = Date.now()) {
  if (!s || !Number(s.seen)) return 'thin';
  const real = num(s.fsrs_real_n);
  const n = real != null ? nEff(real, s.fsrs_at ?? s.last_question_at, now)
    : nEff((Number(s.questions_n) || 0) + (Number(s.retests_n) || 0), s.last_question_at, now);
  return evidenceLevel(n, s.last_question_at, now);
}
/** n_eff of a stored row, the same way. */
export function nEffOfScore(s, now = Date.now()) {
  if (!s) return 0;
  const real = num(s.fsrs_real_n);
  return real != null ? nEff(real, s.fsrs_at ?? s.last_question_at, now) : nEff((Number(s.questions_n) || 0) + (Number(s.retests_n) || 0), s.last_question_at, now);
}

/** The "N% next time" range as whole percents {lo, hi}: p ± z·sqrt(p(1-p)/(n_eff + k)), kept in 1..99. */
export function nextRange(p, n_eff) {
  const q = Math.min(1, Math.max(0, Number(p) || 0));
  const se = Math.sqrt((q * (1 - q)) / ((Number(n_eff) || 0) + EVIDENCE.k));
  const pct = x => Math.max(1, Math.min(99, Math.round(100 * x)));
  return { lo: pct(q - EVIDENCE.z * se), hi: pct(q + EVIDENCE.z * se) };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andList = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * What the colour rests on, in one line: "Based on 1 question and 3 cards, so the colour is still a guess" (thin),
 * "Based on 4 questions and 2 cards" (some, solid). counts: topic.js countsOf ({questions, miss_cards, cards, gaps, lessons}; miss_cards was retests before 1 Nov 2026).
 */
export function basisLine(counts = {}, level = 'thin') {
  const c = counts || {};
  const qs = (Number(c.questions) || 0) + (Number(c.miss_cards ?? c.retests) || 0);
  const parts = [];
  if (qs) parts.push(plural(qs, 'question'));
  if (Number(c.cards)) parts.push(plural(Number(c.cards), 'card'));
  if (Number(c.lessons)) parts.push(plural(Number(c.lessons), 'lesson'));
  if (Number(c.gaps)) parts.push(plural(Number(c.gaps), 'gap'));
  const head = parts.length ? `Based on ${andList(parts)}` : 'Based on almost nothing yet';
  if (level === 'thin') return `${head}${qs ? '' : ' and no questions'}, so the colour is still a guess`;
  return head;
}

// ------------------------------------------------------------------ provenance (who said what)

const BOILERPLATE = [/^missed this card in a voice review\.?$/i, /^\(?(none|no words|nothing said|n\/a)\)?\.?$/i];
export const isBoilerplate = s => { const t = String(s ?? '').trim(); return !t || BOILERPLATE.some(re => re.test(t)); };

export const REPORTED_CONF = Object.freeze(['reported', 'mo']);
const CONF_WORD = { sure: 'sure', lean: 'lean', guess: 'guessed' };
export function confidenceWords(confidence, source) {
  const w = CONF_WORD[confidence];
  if (!w) return '';
  return REPORTED_CONF.includes(source) ? w : `${w} · inferred`;
}

export const QUOTE_RULE = 'What Mo said or how sure he was: quote him with the time or ref; no words: "I inferred"; never "you said" from a summary.';
