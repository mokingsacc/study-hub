
export const ERROR_TYPES = ['knowledge gap', 'misread', 'premature closure', 'faulty synthesis', 'test-taking', 'threshold or number', 'calculation'];
export const NO_CARD_ERRORS = ['misread', 'test-taking'];
export const HUB_CARDS = false;
const RUN = 6;

export function normError(e) {
  if (!e) return null;
  const s = String(e).toLowerCase().replace(/_/g, ' ').replace(/test taking/, 'test-taking').trim();
  if (s === 'threshold' || s === 'number' || s === 'threshold number') return 'threshold or number';
  if (s === 'knowledge') return 'knowledge gap';
  return ERROR_TYPES.includes(s) ? s : null;
}

const words = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

// Every 6-word run of the stem (+ lead), each option, the explanation, each choice's explanation and the
// educational objective, kept apart so runs never straddle two sources.
export function buildLeakIndex(question) {
  const set = new Set();
  const oexpl = question.oexpl && typeof question.oexpl === 'object' ? Object.values(question.oexpl) : [];
  const texts = [question.stem, question.lead, question.expl, ...((question.opts || []).map(o => o && o.t)), ...oexpl, question.obj];
  for (const t of texts) {
    const w = words(t);
    for (let i = 0; i + RUN <= w.length; i++) set.add(w.slice(i, i + RUN).join(' '));
  }
  return set;
}

export function leaks(index, text) {
  const w = words(text);
  for (let i = 0; i + RUN <= w.length; i++) {
    const run = w.slice(i, i + RUN).join(' ');
    if (index.has(run)) return run;
  }
  return null;
}

// Fields of a card, flattened for checks.
export function cardTexts(card) {
  if (!card) return [];
  return [['stem', card.stem], ...(card.questions || []).map((q, i) => [`question ${i + 1}`, q]), ['answer', card.answer], ['vs', card.vs], ['why', card.why], ['notes', card.notes]];
}

const ARROWS = /(→|->|<-|←|↑|↓|⇒|=>|⟶|↔|>>|<<|[<>≥≤])/;
export const VERSUS = /^Versus [^:]{2,}: .+, so .+\.$/;

export const wordCount = s => String(s || '').trim().split(/\s+/).filter(Boolean).length;

export function checkCard(card, errorType) {
  const f = [];
  if (!card) return f;
  if (NO_CARD_ERRORS.includes(errorType)) {
    f.push(`No card for a ${errorType} error: set card to null.`);
    return f;
  }
  const stem = String(card.stem || '').trim();
  if (!stem) f.push('The card front needs a new short case (stem).');
  else if (wordCount(stem) >= 30) f.push(`The card case has ${wordCount(stem)} words; it must be under 30.`);
  const qs = Array.isArray(card.questions) ? card.questions : [];
  if (qs.length < 1 || qs.length > 2) f.push('The card needs one or two questions.');
  qs.forEach((q, i) => { if (!/\?\s*$/.test(String(q))) f.push(`Question ${i + 1} must end with a question mark.`); });
  const answer = String(card.answer || '').trim();
  if (!answer) f.push('The card needs an answer.');
  else {
    const sentences = (answer.match(/[.!](\s|$)/g) || []).length;
    if (sentences < qs.length) f.push('The answer needs one full sentence per question, in order.');
  }
  const vs = String(card.vs || '').trim();
  if (!VERSUS.test(vs)) f.push('The Versus line must read exactly "Versus <look-alike>: <finding that tells them apart>, so <what you do differently>."');
  const why = String(card.why || '').trim();
  if (!why) f.push('The notes must start with "Why: " and one easy sentence (put that sentence in why).');
  for (const [name, text] of cardTexts(card)) {
    if (text && ARROWS.test(String(text))) f.push(`The card ${name} uses an arrow or symbol; write it in plain words.`);
  }
  return f;
}

// Strip a leading "Why:" the model may repeat inside why.
export function tidyCard(card) {
  if (!card) return card;
  const out = { ...card };
  out.why = String(out.why || '').trim().replace(/^why:\s*/i, '');
  out.questions = (Array.isArray(out.questions) ? out.questions : [out.questions]).filter(Boolean).map(q => String(q).trim());
  for (const k of ['stem', 'answer', 'vs', 'notes']) out[k] = String(out[k] || '').trim();
  return out;
}

export const OUTGOING_FIELDS = ['paraphrase', 'gap', 'rule', 'look_alike', 'topic'];

// Leak failures for a whole result: [{field, run}].
export function leakFailures(index, result) {
  const out = [];
  for (const k of OUTGOING_FIELDS) {
    const hit = leaks(index, result[k]);
    if (hit) out.push({ field: k, run: hit });
  }
  for (const [name, text] of cardTexts(result.card)) {
    const hit = leaks(index, text);
    if (hit) out.push({ field: 'card', part: name, run: hit });
  }
  return out;
}

// Every string anywhere in a payload (for the last check before anything is queued).
export function payloadLeak(index, value) {
  if (typeof value === 'string') return leaks(index, value);
  if (Array.isArray(value)) { for (const v of value) { const h = payloadLeak(index, v); if (h) return h; } return null; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) { const h = payloadLeak(index, v); if (h) return h; } }
  return null;
}
