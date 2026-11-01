// The trend arrow (weakness model v2): how a topic's memory has moved over your last 21 days of answers, from the stored
// trend (1 improving, 0 steady, -1 slipping; none: under 2 days of answers or no question yet, said "Too early to tell").
// Shared by the map's hover card and the topic panel, so both say it the same way. A small inline SVG in currentColor,
// always beside its word. Callers show it for seen topics only, and pass thin: true when the evidence is thin
// (shared/evidence.js): then there is no trend word at all, only "Too early to tell" (wave 2 C.4).
export const TREND_WORDS = Object.freeze({ 1: 'Improving', 0: 'Steady', '-1': 'Slipping' });
export const TREND_NONE = 'Too early to tell';
const CLASS = Object.freeze({ 1: 'is-up', 0: 'is-flat', '-1': 'is-down' });
// 12 px arrows: up-right, right, down-right.
const PATH = Object.freeze({
  1: 'M3 9 L9 3 M4.5 3 H9 V7.5',
  0: 'M2 6 H10 M7 3 L10 6 L7 9',
  '-1': 'M3 3 L9 9 M9 4.5 V9 H4.5',
});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** -1, 0 or 1 from a stored trend (a number, a numeric string or the model's Int8 with 2 for none); else null. */
export function trendOf(v) {
  const n = Number(v);
  return v != null && v !== '' && (n === 1 || n === 0 || n === -1) ? n : null;
}

/** The trend's word, or "Too early to tell" when there is none (or the evidence is thin). */
export const trendWord = (v, { thin = false } = {}) => { const t = thin ? null : trendOf(v); return t == null ? TREND_NONE : TREND_WORDS[t]; };

// A London day as YYYY-MM-DD from epoch ms.
const londonISO = ms => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
  catch { return new Date(ms).toISOString().slice(0, 10); }
};
/** 'today', 'yesterday' or '22 Oct' for an answer at epoch ms, now given (London days). */
export function answerDay(ms, now = Date.now()) {
  if (!Number.isFinite(Number(ms))) return '';
  const d = londonISO(Number(ms)), today = londonISO(now);
  if (d === today) return 'today';
  if (d === londonISO(now - 86_400_000)) return 'yesterday';
  const [, m, day] = d.split('-').map(Number);
  return `${day} ${MONTHS[m - 1]}`;
}

export function basisWords(basis, now = Date.now()) {
  const b = basis && typeof basis === 'object' ? basis : null;
  if (!b || !Array.isArray(b.answers) || !b.answers.length) return '';
  const at = Array.isArray(b.answer_at) ? b.answer_at : [];
  const n = b.answers.length, from = Math.max(0, n - 3);
  const out = [];
  for (let i = from; i < n; i++) out.push(`${b.answers[i]}${at[i] != null ? ` ${answerDay(at[i], now)}` : ''}`);
  return out.join(', ');
}

/**
 * The trend in one sentence that names its basis: "Slipping: right 22 Oct, wrong today"; "Too early to tell" when
 * there is no trend or the evidence is thin (no trend word while thin, never a strong word on one answer).
 */
export function trendSentence(v, basis, { thin = false, now = Date.now() } = {}) {
  const t = thin ? null : trendOf(v);
  if (t == null) return TREND_NONE;
  const why = basisWords(basis, now);
  return why ? `${TREND_WORDS[t]}: ${why}` : TREND_WORDS[t];
}

/**
 * The arrow and its word as HTML ("Too early to tell", no arrow, for no trend or thin evidence). cls: the wrapper's class
 * (default 'trend'); basis: the stored basis, so the tooltip names the answers it rests on.
 */
export function trendHtml(v, { cls = 'trend', word = true, thin = false, basis = null, now = Date.now() } = {}) {
  const t = thin ? null : trendOf(v);
  if (t == null) return `<span class="${cls} is-none" title="Too few answers yet to call a trend">${word ? `<span>${TREND_NONE}</span>` : `<span class="sr-only">${TREND_NONE}</span>`}</span>`;
  const w = TREND_WORDS[t];
  const why = basisWords(basis, now);
  return `<span class="${cls} ${CLASS[t]}" title="${esc(why ? `${w} over your last answers: ${why}` : `${w} over your last answers`)}"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">`
    + `<path d="${PATH[t]}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    + `${word ? `<span>${w}</span>` : `<span class="sr-only">${w}</span>`}</span>`;
}
