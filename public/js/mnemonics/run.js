
export function ratingOf(missed, total, easy = false) {
  if (missed <= 0) return easy ? 'easy' : 'good';
  if (total <= 1 || missed >= 2) return 'again';
  return 'hard';
}

/** A step for one queue entry: {id, dir, m, total, marks: [null|true|false], open: index revealed so far (-1 none)}. */
export function stepFor(m, dir) {
  const total = dir === 'rev' ? 1 : Math.max(1, (m.items || []).length);
  return { id: m.id, dir, m, total, marks: Array(total).fill(null), open: -1 };
}

/** The item to reveal or mark next (its index), or -1 when every item is marked. */
export const current = s => s.marks.findIndex(x => x === null);

/** Reveal the current item (Space, or a tap on its row). */
export function reveal(s) {
  const i = current(s);
  if (i < 0 || s.open >= i) return s;
  return { ...s, open: i };
}

export function mark(s, got) {
  const i = current(s);
  if (i < 0) return s;
  const marks = s.marks.slice();
  marks[i] = !!got;
  return { ...s, marks, open: Math.max(s.open, i) };
}

/** Take back the last mark (a slip of the finger), leaving that item revealed. */
export function unmark(s) {
  const last = s.marks.map(x => x !== null).lastIndexOf(true);
  if (last < 0) return s;
  const marks = s.marks.slice();
  marks[last] = null;
  return { ...s, marks };
}

export const done = s => current(s) < 0;
export const missedOf = s => s.marks.flatMap((x, i) => (x === false ? [i] : []));
export const rating = (s, easy = false) => ratingOf(missedOf(s).length, s.total, easy);

/** The steps of a test, from the server's queue and the mnemonics it named (unknown ids skipped). */
export function stepsOf(queue, mnemonics) {
  const by = new Map((mnemonics || []).map(m => [m.id, m]));
  return (queue || []).filter(q => by.has(q.id)).map(q => stepFor(by.get(q.id), q.dir));
}

/** "in 3 days", "in 10 min", "tomorrow": when a review's due time is, said plainly. */
export function whenText(due, now = Date.now()) {
  const ms = due - now;
  if (ms <= 60_000) return 'now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min} min`;
  const h = Math.round(ms / 3600_000);
  if (h < 20) return `in ${h} h`;
  const d = Math.round(ms / 86400_000);
  if (d <= 1) return 'tomorrow';
  if (d < 60) return `in ${d} days`;
  return `in ${Math.round(d / 30)} months`;
}
