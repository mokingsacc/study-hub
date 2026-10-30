// Notes (I30): the note.save op's planner. One op for the whole section, so a burst of ink, a moved block and a renamed
// page made together are one batch with one undo. args: {changes: [{table, id?, set?, delete?}], label?}
//   table: books | sections | pages | blocks | strokes; id: given by the page (it made the row) or made here;
//   set: the fields to write (a new row needs its parent: book_id, section_id or page_id); delete: true soft-deletes.
// Claude reaches it through the Notes connector (mcp/notes-registry.js), which builds the same changes.
import { planRows, noteEvent, newId, NoteError } from './store.js';
import { looksLikeQuestionText, REASONS } from '../map/guard.js';
import { plainText } from '../../../public/js/notes/html.js';

export const TABLE_OF = { books: 'note_books', sections: 'note_sections', pages: 'note_pages', blocks: 'note_blocks', strokes: 'note_strokes' };
export const MAX_CHANGES = 600;
const NOUN = { note_books: ['notebook', 'notebooks'], note_sections: ['section', 'sections'], note_pages: ['page', 'pages'],
  note_blocks: ['block', 'blocks'], note_strokes: ['stroke', 'strokes'] };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** {changes} from the op's args, checked for shape (the fields are checked by store.js). */
export function changesOf(args) {
  const list = args && args.changes;
  if (!Array.isArray(list) || !list.length) throw new NoteError('Nothing to save: changes is empty.');
  if (list.length > MAX_CHANGES) throw new NoteError(`At most ${MAX_CHANGES} changes at once.`);
  return list.map(c => {
    if (!isObj(c) || !TABLE_OF[c.table]) throw new NoteError('Each change names its table: books, sections, pages, blocks or strokes.');
    if (c.delete === true) {
      if (typeof c.id !== 'string') throw new NoteError('A delete names the id.');
      return { t: TABLE_OF[c.table], id: c.id, set: null };
    }
    if (!isObj(c.set)) throw new NoteError('Each change carries set: the fields to write.');
    return { t: TABLE_OF[c.table], id: typeof c.id === 'string' && c.id ? c.id : newId(), set: c.set };
  });
}

// "Added 3 strokes, moved 1 block" style wording, from what the batch does.
export function describe(writes, title = '') {
  const tally = {};
  for (const w of writes) {
    if (w.bump) continue;
    const verb = !w.before || w.before.deleted_at ? 'added' : w.after.deleted_at ? 'deleted' : 'changed';
    const k = `${verb}|${w.t}`;
    tally[k] = (tally[k] || 0) + 1;
  }
  const parts = Object.entries(tally).map(([k, n]) => { const [verb, t] = k.split('|'); return `${verb} ${n} ${NOUN[t][n === 1 ? 0 : 1]}`; });
  const s = parts.join(', ') || 'saved';
  return `Notes: ${s[0].toUpperCase()}${s.slice(1)}${title ? ` on "${title.slice(0, 60)}"` : ''}`;
}

// Claude's words (CONTRACT hard rule 1): every text it writes, as the hub's other changes are checked (guard.js).
export function claudeTexts(changes) {
  const out = [];
  for (const c of changes) {
    const s = c.set || {};
    for (const k of ['name', 'title']) if (typeof s[k] === 'string') out.push(s[k]);
    if (typeof s.html === 'string') out.push(plainText(s.html));
    if (Array.isArray(s.cells)) out.push(s.cells.map(r => (Array.isArray(r) ? r.join('\n') : '')).join('\n'));
  }
  return out;
}

export async function planSave(env, user, args, ctx) {
  if (ctx.actor === 'claude' && Array.isArray(args.changes) && claudeTexts(args.changes).some(t => looksLikeQuestionText(t))) return { refuse: REASONS.question_bank };
  let plan;
  try { plan = await planRows(env, user, changesOf(args), { now: ctx.now, actor: ctx.actor }); } catch (e) {
    if (e instanceof NoteError) return { refuse: e.message };
    throw e;
  }
  if (!plan.writes.length) return { noop: true, summary: 'Nothing to change.' };
  const page = plan.writes.find(w => w.t === 'note_pages');
  const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim().slice(0, 100) : describe(plan.writes, page ? page.after.title : '');
  const event = noteEvent(plan, label);
  // Claude's confirm question, in the future tense ("Delete 6 things on "Page"?").
  const ask = plan.counts.removed ? `Delete ${plan.counts.removed} thing${plan.counts.removed === 1 ? '' : 's'}${page ? ` on "${(page.after.title || 'Untitled page').slice(0, 60)}"` : ''}?` : undefined;
  return { rows: [], events: [event], count: plan.writes.filter(w => !w.bump).length, summary: event.summary, notes: plan,
    deletes: plan.counts.removed, ...(ask ? { ask } : {}) };
}

export const saveTier = (args, plan, ctx) => (ctx.actor === 'claude' && plan.deletes > 5 ? 'confirm' : 'free');
