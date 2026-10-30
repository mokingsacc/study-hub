
export const CONF_MEANINGS = {
  1: 'Sure: only one option fits.',
  2: 'Lean: down to two, picked the better one.',
  3: 'Guess: three or more still possible, or no idea.',
};

export const CONFIDENCE_RULE = 'confidence, read from his own words only, as how many answers were still open in his mind when he committed: '
  + 'sure = only one answer fits and he is positive ("this is X", "definitely"); lean = down to two and he picked the better one '
  + '("between B and D, I\'ll go with B"; a hedge on one answer with no rival named, "I think it\'s X", is lean too, since he is not positive); '
  + 'guess = three or more still possible, or no idea ("could be any of these", "no idea", "I forgot"). null when his words do not show it or he said nothing. '
  + 'He says "lean between X and Y" to name his two answers: that is lean, and the one that was not right is the look-alike (mixed_with, look_alike).';

const LEAN_BETWEEN = /\blean(?:ing|t)?\s+between\s+(.+?)\s+(?:and|or|versus|vs\.?)\s+(.+?)(?=[,;?!]|\.(?:\s|$)|\s+(?:because|but|so|since|i'?ll|i will|i'?d|i think|i'?m|and i|which)\b|$)/gi;
const NOT_A_NAME = /^(?:(?:option|answer|choice|letter)\s+)?[a-h]$|^(?:these|those|them|the two|both|the first|the second|the last|it|this|that)(?:\s+(?:one|ones|two))?$/i;
const name = s => String(s || '').trim().replace(/^(?:the|a|an)\s+/i, '').replace(/[.,;:!?]+$/, '');
/** Every "lean between X and Y" in this text: [[x, y]], names only (one to six words each). */
export function leanPairs(text) {
  const out = [];
  for (const m of String(text || '').matchAll(LEAN_BETWEEN)) {
    const [a, b] = [name(m[1]), name(m[2])];
    const ok = x => x && !NOT_A_NAME.test(x) && x.split(/\s+/).length <= 6 && /[a-z]{2}/i.test(x);
    if (ok(a) && ok(b) && a.toLowerCase() !== b.toLowerCase()) out.push([a, b]);
  }
  return out;
}

const NOT_A_CALL = /\b(?:make|making|makes|be)\s+(?:(?:really|very|totally|quite|that|too|so|100%|a hundred percent)\s+)?$/i;
const NEGATED = /\b(?:not|never|no)\s+(?:(?:really|very|totally|quite|that|too|so|100%|a hundred percent)\s+)?$/i;
const WORDS = /\b(sure|lean|leaning|leant|guess|guessing|guessed)\b/gi;
const LEAN_HEDGE = /\bI\s+(?:think|believe)\b|\bprobably\b/i;
const GUESS_HEDGE = /\bno\s+(?:idea|clue)\b|\bcould\s+be\s+any(?:thing|\s+of)\b/i;
const FILLER_GUESS = /^\s+(?![.,;!?]|$)\S/;

export function spokenConfDetail(text) {
  const s = String(text || '');
  let found = null, hedge = null;
  for (const m of s.matchAll(WORDS)) {
    const w = m[1].toLowerCase();
    const before = s.slice(Math.max(0, m.index - 30), m.index);
    if (w === 'sure') {
      if (NOT_A_CALL.test(before)) continue;
      found = NEGATED.test(before) ? '2' : '1';
      continue;
    }
    if (w === 'guess' && /\bI\s+$/i.test(before) && FILLER_GUESS.test(s.slice(m.index + m[0].length))) { hedge = hedge === '3' ? '3' : '2'; continue; }
    found = w.startsWith('lean') ? '2' : '3';
  }
  if (found) return { conf: found, said: 'word' };
  if (GUESS_HEDGE.test(s)) hedge = '3';
  else if (LEAN_HEDGE.test(s) && !hedge) hedge = '2';
  return hedge ? { conf: hedge, said: 'hedge' } : { conf: null, said: null };
}

export function spokenConf(text) {
  return spokenConfDetail(text).conf;
}

function transcriptText(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (t.text) return t.text;
  let segs = t.segments;
  if (!segs && t.segments_json) { try { segs = JSON.parse(t.segments_json); } catch { segs = []; } }
  return (Array.isArray(segs) ? segs : []).map(x => (x && x.text) || '').join(' ');
}

export function confFor(tapped, transcript) {
  const tap = tapped == null || tapped === '' ? null : String(tapped);
  if (['1', '2', '3'].includes(tap)) return { conf: tap, from: 'tap' };
  const said = spokenConfDetail(transcriptText(transcript));
  return said.conf ? { conf: said.conf, from: 'voice', ...(said.said === 'hedge' ? { hedge: true } : {}) } : { conf: null, from: null };
}
