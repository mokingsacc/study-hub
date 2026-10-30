
const NUMS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const TENS = { twenty: 20, thirty: 30, forty: 40 };

/** "12", "twelve", "twenty-one", "twenty one" -> 12 / 21; anything else -> null. */
export function numberWord(w) {
  const t = String(w || '').toLowerCase().trim().replace(/-/g, ' ');
  if (/^\d{1,2}$/.test(t)) return Number(t);
  const i = NUMS.indexOf(t);
  if (i >= 0) return i;
  const [a, b] = t.split(/\s+/);
  if (TENS[a] != null && b && NUMS.indexOf(b) > 0 && NUMS.indexOf(b) < 10) return TENS[a] + NUMS.indexOf(b);
  return TENS[t] ?? null;
}

const NUM = '(\\d{1,2}|(?:twenty|thirty|forty)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|' + NUMS.slice(1).join('|') + ')';
const NEXT_Q = /\bnext question\b[.,!?]?/gi;
const GOTO = new RegExp(`\\b(?:(?:going |go )?back to|go to|going to|move to|moving to|jump to) question (?:number )?${NUM}\\b[.,!?]?`, 'gi');
const FILL = '(?:(?:okay|ok|alright|all right|right|so|and)[,.]?\\s+)';
const STEM_AFTER = '(?=[.,:!?]?\\s*(?:$|which of the following\\b|(?:an?\\s+)?\\d{1,3}[- ](?:year|month|week|day)))';
const NUMBERED = new RegExp(`(?:^|\\b(?=(?:okay|ok|alright)\\b))${FILL}?(?:(?:question|number)\\s+(?:number\\s+)?${NUM}\\b${STEM_AFTER}|${NUM}(?=,?\\s+which of the following\\b))[.,:!?]?`, 'gi');
const REMARK = new RegExp(`^${FILL}?question\\s+(?:number\\s+)?${NUM}\\s+(?:is|was|i\\b|i'm|i'll|i'd|my)`, 'i');
const PICK_FOR = new RegExp(`\\b[A-J]\\s+[Ff]or\\s+(?:question\\s+|number\\s+)?${NUM}[.!?]?$`);
const PLAIN_NEXT = /^(?:(?:okay|ok|alright|all right|right|so)[,.]?\s+)?next(?: one)?[.!?]?$/i;
// A pick that ends a sentence ("I'll go with B.") and a new case that opens the next ("A 45-year-old man ...").
const PICK_END = /\b(?:go(?:ing)? with|go for|pick(?:ing|ed)?|choose|choosing|chose|put|say|said|answer is|it's|it is|so)\s+([A-J])[.!?]?$/i;
const STEM_START = /^(?:(?:a|an)\s+)?(?:(?:\d{1,3}|[a-z]+(?:-[a-z]+)?)[- ](?:year|month|week|day)[- ]old\b|(?:previously healthy|newborn|infant|pregnant)\b)/i;

const SENTENCE_END = /[.!?]\s+/g; // the boundary gaps.js findCues reads sentences by, so cues and lines agree

/**
 * Segments cut into sentences, each timed by its share of its segment's text (Whisper and Nova give one time for a
 * whole stretch of speech, often the end of one question and the start of the next).
 */
export function sentenceSegments(segments) {
  const out = [];
  for (const s of segments || []) {
    const text = String((s && s.text) || '');
    const start = Number(s && s.start) || 0, end = s.end ?? start;
    const len = Math.max(1, text.length), dur = Math.max(0, end - start);
    const at = i => Math.round(start + (dur * i) / len);
    const cuts = [0];
    SENTENCE_END.lastIndex = 0;
    for (let m; (m = SENTENCE_END.exec(text));) cuts.push(m.index + m[0].length);
    cuts.push(text.length);
    for (let k = 0; k < cuts.length - 1; k++) {
      const raw = text.slice(cuts[k], cuts[k + 1]);
      const a = cuts[k] + (raw.length - raw.trimStart().length), b = cuts[k] + raw.trimEnd().length;
      if (b > a) out.push({ start: at(a), end: at(b), text: text.slice(a, b) });
    }
  }
  return out;
}

// The first hard cue in text at or after `from`: {index, length, cue}.
function nextCue(text, from) {
  let best = null;
  for (const [re, make] of [[NEXT_Q, () => ({ cue: 'next' })], [GOTO, m => ({ cue: 'goto', n: numberWord(m[1]) })],
    [NUMBERED, m => ({ cue: 'goto', n: numberWord(m[1] || m[2]), how: 'number' })]]) {
    re.lastIndex = from;
    const m = re.exec(text);
    if (m && m[0] && (!best || m.index < best.index)) best = { index: m.index, length: m[0].length, ...make(m) };
  }
  return best;
}

/**
 * Cut segments [{start, end, text}] into pieces and cues, in time order, sentence by sentence. A cue inside a sentence
 * is placed by its share of the text. manual: [{t, kind: 'next'}] taps on the page's own button.
 * Cues: {cue: 'next'} ("next question"; how 'next' for a lone "Next.", 'pick' for a pick then a new case),
 * {cue: 'goto', n} ("back to question 5"; how 'number' for "number 12"), {cue: 'end', n} after a sentence that closes
 * question n ("Question eight was a lean", "B for 11").
 */
export function pieces(segments, manual = []) {
  const out = [];
  let picked = false; // the last sentence ended with a pick and no cue came after it
  for (const s of sentenceSegments(segments)) {
    const text = s.text;
    const len = Math.max(1, text.length), dur = Math.max(0, s.end - s.start);
    const at = i => Math.round(s.start + (dur * i) / len);
    if (PLAIN_NEXT.test(text.trim())) { out.push({ t: s.start, cue: 'next', how: 'next' }); picked = false; continue; }
    let last = 0, cued = false;
    for (let c; (c = nextCue(text, last));) {
      if (!cued && picked && !text.slice(0, c.index).trim()) picked = false; // a cue opens this sentence anyway
      const before = text.slice(last, c.index).trim();
      if (picked && before && STEM_START.test(before)) { out.push({ t: s.start, cue: 'next', how: 'pick' }); picked = false; }
      if (before) out.push({ t: at(last), end: at(c.index), text: before });
      const { index, length, ...cue } = c;
      out.push({ t: at(index), ...cue });
      last = index + length;
      cued = true;
      picked = false;
    }
    const rest = text.slice(last).trim();
    if (!rest) continue;
    if (picked && !cued && STEM_START.test(rest)) out.push({ t: s.start, cue: 'next', how: 'pick' });
    out.push({ t: at(last), end: s.end, text: rest });
    const remark = !cued && (REMARK.exec(rest) || PICK_FOR.exec(rest));
    if (remark) out.push({ t: s.end, cue: 'end', n: numberWord(remark[1]) });
    picked = !remark && PICK_END.test(rest) && /[A-J]/.test(PICK_END.exec(rest)[1]);
  }
  for (const m of manual) out.push({ t: m.t, cue: 'next', manual: true });
  // In time order; at the same time a tap comes first and the rest keep the order they were said in (a sentence's
  // "end of question" mark after its words, even in a segment with no length).
  return out.sort((a, b) => a.t - b.t || (b.manual ? 1 : 0) - (a.manual ? 1 : 0));
}

function walk(ps, onText, onMove) {
  let cur = 1, ended = false;
  for (const p of ps) {
    if (!p.cue) { onText(p, cur); ended = false; continue; }
    let to = null;
    if (p.cue === 'end') to = p.n === cur || p.n === cur + 1 ? p.n + 1 : null;
    else if (p.cue === 'next') to = ended ? null : cur + 1;
    else to = p.n;
    ended = p.cue === 'end' && to != null;
    if (!to || to < 1 || to > 200 || to === cur) continue;
    onMove(p, cur, to);
    cur = to;
  }
  return cur;
}

/**
 * Questions from the pieces: [{n, text, secs, visits}] for n = 1..count. Time on a question is the time
 * between the cues that open and close each visit; the last visit runs to `endMs` (the end of recording).
 * A trailing "next question" after the last one adds no empty question.
 */
export function splitQuestions(segments, { manual = [], endMs = null } = {}) {
  const ps = pieces(segments, manual);
  const qs = new Map();
  const get = n => { if (!qs.has(n)) qs.set(n, { n, parts: [], ms: 0, visits: 0 }); return qs.get(n); };
  let since = 0, max = 1;
  get(1).visits = 1;
  const cur = walk(ps, (p, n) => get(n).parts.push(p.text), (p, from, to) => {
    get(from).ms += Math.max(0, p.t - since); since = p.t;
    max = Math.max(max, to);
    get(to).visits++;
  });
  const last = ps.length ? ps[ps.length - 1] : null;
  get(cur).ms += Math.max(0, (endMs != null ? endMs : last ? (last.end ?? last.t) : 0) - since);
  // "next question" said after the last question opens an empty one: drop empties at the end.
  while (max > 1 && !get(max).parts.length) max--;
  const out = [];
  for (let n = 1; n <= max; n++) {
    const q = get(n);
    out.push({ n, text: q.parts.join(' ').replace(/\s+/g, ' ').trim(), secs: Math.round(q.ms / 1000), visits: q.visits });
  }
  return out;
}

/** The question count heard so far (for the live display). */
export function currentQuestion(segments, manual = []) {
  return walk(pieces(segments, manual), () => {}, () => {});
}

const SNAP_MS = 600; // a start given as "12:05" (whole seconds, rounded) snaps to a sentence that starts within this

/** Cut sentence segments at ms: {segs, at}, at the time the cut really falls (a sentence start or a word start). */
export function cutAt(segs, ms) {
  let near = null;
  for (const s of segs) if (Math.abs(s.start - ms) <= SNAP_MS && (!near || Math.abs(s.start - ms) < Math.abs(near.start - ms))) near = s;
  if (near) return { segs, at: near.start };
  const i = segs.findIndex(s => s.start < ms && ms < s.end);
  if (i < 0) return { segs, at: ms };
  const s = segs[i], text = s.text, len = Math.max(1, text.length), dur = Math.max(1, s.end - s.start);
  const k = ((ms - s.start) * len) / dur;
  let j = -1;
  for (let x = 1; x < text.length; x++) if (/\s/.test(text[x - 1]) && !/\s/.test(text[x]) && (j < 0 || Math.abs(x - k) < Math.abs(j - k))) j = x;
  if (j < 0) return { segs, at: s.start };
  const t = Math.round(s.start + (dur * j) / len);
  return { segs: [...segs.slice(0, i), { start: s.start, end: t, text: text.slice(0, j).trim() }, { start: t, end: s.end, text: text.slice(j).trim() }, ...segs.slice(i + 1)], at: t };
}

export function splitByStarts(segments, starts) {
  let segs = sentenceSegments(segments);
  const eff = [];
  for (const q of (starts || []).filter(x => x && Number.isFinite(x.start_ms)).sort((a, b) => a.start_ms - b.start_ms)) {
    const r = cutAt(segs, q.start_ms);
    segs = r.segs;
    eff.push({ q: q.q, at: r.at });
  }
  eff.sort((a, b) => a.at - b.at);
  const groups = new Map(eff.map(e => [e.q, []])), before = [];
  for (const s of segs) {
    let owner = null;
    for (const e of eff) if (e.at <= s.start) owner = e; else break;
    (owner ? groups.get(owner.q) : before).push(s);
  }
  return { before, groups, at: new Map(eff.map(e => [e.q, e.at])) };
}

const quoteWords = s => (String(s || '').toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g) || []);
const sameWord = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 4) === b.slice(0, 4)); // a spelling fix
export const QUOTE_WINDOW_MS = 90_000;

export function quoteStart(segments, quote, nearMs = null) {
  const q = quoteWords(quote).slice(0, 6);
  if (q.length < 2) return null;
  const need = q.length <= 3 ? q.length : Math.max(3, Math.ceil(q.length * 0.6));
  const words = [];
  for (const s of sentenceSegments(segments)) {
    const len = Math.max(1, s.text.length), dur = Math.max(0, s.end - s.start);
    for (const m of s.text.matchAll(/[A-Za-z0-9’']+/g)) {
      const w = m[0].toLowerCase().replace(/[’']/g, '');
      if (w) words.push({ w, ms: Math.round(s.start + (dur * m.index) / len) });
    }
  }
  let best = null;
  for (let p = 0; p < words.length; p++) {
    if (!sameWord(words[p].w, q[0]) && !(words[p + 1] && sameWord(words[p + 1].w, q[1]))) continue;
    let score = 0;
    for (let i = 0; i < q.length; i++) if (words[p + i] && sameWord(words[p + i].w, q[i])) score++;
    if (score < need) continue;
    const ms = sameWord(words[p].w, q[0]) ? words[p].ms : words[p + 1].ms;
    const dist = nearMs == null ? 0 : Math.abs(ms - nearMs);
    if (nearMs != null && dist > QUOTE_WINDOW_MS) continue;
    if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { ms, score, dist };
  }
  return best ? best.ms : null;
}

const cueWords = p => (p.manual ? 'next question, tapped' : p.cue === 'end' ? `end of question ${p.n}`
  : p.cue === 'next' ? (p.how === 'pick' ? 'a pick, then a new case' : p.how === 'next' ? 'said: next' : 'said: next question')
    : p.how === 'number' ? `said: question ${p.n}` : `said: back to question ${p.n}`);
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
export const QUIET_MARK_S = 15;

/** The recording as timed lines, with spoken cues and long pauses marked, for Claude to split. */
export function timeline(segments, manual = []) {
  const out = [];
  let prevEnd = null;
  for (const p of pieces(segments, manual)) {
    if (p.cue) { out.push(`[${mmss(p.t / 1000)}] (${cueWords(p)})`); continue; }
    if (prevEnd != null && p.t - prevEnd >= QUIET_MARK_S * 1000) out.push(`(${Math.round((p.t - prevEnd) / 1000)} s quiet)`);
    out.push(`[${mmss(p.t / 1000)}] ${p.text}`);
    prevEnd = p.end ?? p.t;
  }
  return out;
}

export function claudeText(segments, { manual = [], results = {}, count = 0, date = '', mode = 'timed', minutes = null, blockId = '' } = {}) {
  const ns = Array.from({ length: count || 0 }, (_, i) => i + 1);
  const marked = ns.filter(n => results[n] && results[n].right != null);
  const anyMarks = ns.some(n => results[n] && (results[n].right != null || results[n].picked || results[n].answer || results[n].id));
  const right = marked.filter(n => results[n].right).length;
  const cues = pieces(segments, manual).filter(p => p.cue).length;
  const out = ["This is my own thinking out loud from a UWorld block, not a request for your reasoning. Please don't show your reasoning; just do the steps below.", `UWorld block${date ? `, ${date}` : ''} (${mode}${minutes ? `, ${minutes} min recorded` : ''})${count ? `: ${count} question${count === 1 ? '' : 's'}` : ''}${marked.length ? `, ${right} of ${marked.length} right (${Math.round((100 * right) / marked.length)}%)` : ''}.`];
  out.push(`Below is what I said, transcribed by Whisper (expect misheard medical words), with times from the start. Do not copy or quote any question text from UWorld. ${anyMarks ? 'My results are below.' : 'If my UWorld results are on screen, use them only to see which questions I got right or wrong and the correct letters; otherwise work from what I said.'}`);
  out.push(`1. Split the transcript into ${count ? `Q1 to Q${count}` : 'questions (Q1, Q2 and so on)'}, in order. A new question usually starts with a new patient (new age, sex, complaint or topic), often after a long pause, and ends when I name my pick.${cues ? ' Where the transcript marks a cue in brackets ("said: next question", "said: question 12", "end of question 11"), that is a sure boundary.' : ''} Use my picked letters to line them up. Some questions may have no speech. If my UWorld results are on screen, use each question's topic name there to settle unclear boundaries and my picks (only to match, never copy it out). Show me the split in a short list (question, start time, first few words) and wait for my OK or corrections.`);
  out.push('2. Then, for each question, check whether my answer and what I said hold up, and log as a mistake (log only, no card, the same as "log this"): every wrong answer, and every right answer where I was guessing or what I said was wrong (say which: lucky guess, right answer for a wrong fact, ruled an option out wrongly, misread). Use the question ID if I gave one. Finish with a short summary: how many wrong, how many right for a flawed reason, the main error types and the systems that came up most. I will say "make flashcards" at the end of the day.');
  if (blockId) out.push(`3. If you have my Practice Hub connector, once I OK the split also call save_uworld_questions with block "${blockId}" and one entry per question: its start time in the transcript, what my UWorld results screen shows (question ID, right or wrong, my letter, the correct letter, subject, system, topic label, time spent, % of others right) and your check (verdict, error type, one-line note in your own words). Labels and numbers only, never question text. If you don't have the connector, skip this step.`);
  if (anyMarks) {
    out.push('', 'My results:');
    for (const n of ns) {
      const r = results[n] || {};
      const res = r.right === true ? 'right' : r.right === false ? 'wrong' : 'not marked';
      const letters = [r.picked ? `picked ${r.picked}` : '', r.answer ? `answer ${r.answer}` : ''].filter(Boolean).join(', ');
      out.push(`Q${n}${r.id ? ` (ID ${r.id})` : ''}: ${res}${letters ? `, ${letters}` : ''}`);
    }
  }
  out.push('', 'Transcript:');
  const lines = timeline(segments, manual);
  out.push(...(lines.length ? lines : ['(nothing was heard)']));
  return out.join('\n');
}
