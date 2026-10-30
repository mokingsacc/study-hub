// Recent changes (WP6): what changed on their hub this week and who did it (you, your Claude, the hub, Anki), with
// Undo where a change can still be undone. Opened from More, Make it mine and the Galaxies sheet.
import { h, icon, sheet, btn, toast } from './kit.js';
import { get, post } from './api.js';

const when = at => {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const d = new Date(at), today = new Date();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
};
const whoClass = w => (w === 'Your Claude' ? 'claude' : w === 'You' ? 'you' : 'hub');

/** The sheet. onUndo runs after an undo, so the screen behind can refresh. */
export function recentSheet(app, onUndo) {
  const s = sheet({ title: 'Recent changes', sub: 'This week, newest first. Undo takes a change back.', wide: true, body: h('p', { class: 'foot' }, 'Loading…') });
  const draw = () => get('/api/p/recent?days=7').then(d => {
    if (!d.items.length) return s.setBody(h('p', { class: 'foot' }, 'Nothing has changed this week.'));
    // The same look change made several times in a row (tiles moved one step at a time) reads as one row.
    const items = [];
    for (const it of d.items) {
      const last = items[items.length - 1];
      if (last && !it.undoable && !last.undoable && last.who === it.who && last.what === it.what) last.times = (last.times || 1) + 1;
      else items.push({ ...it });
    }
    s.setBody(h('div', { class: 'list rc-list' }, items.map(it => h('div', { class: 'li rc-row' },
      h('span', { class: `rc-who ${whoClass(it.who)}` }, it.who),
      h('span', { class: 'grow' }, h('b', null, it.what), h('span', { class: 'sub' }, when(it.at), it.times ? ` · ${it.times} times` : '')),
      it.undone ? h('span', { class: 'rc-tag' }, 'Undone')
        : it.undoable ? btn('Undo', async e => {
          const b = e.currentTarget;
          b.disabled = true;
          try { await post('/api/p/undo', { batch_id: it.batch_id }); toast('Undone.'); if (onUndo) onUndo(); draw(); } catch (err) { toast(err.message || 'Could not undo that.'); b.disabled = false; }
        }, 'gray', 'undo', { cls: 'btn-sm' }) : null))));
  }).catch(e => s.setBody(h('p', { class: 'foot' }, e.message || 'Recent changes could not load.')));
  draw();
  return s;
}

/** A list row that opens the sheet (More, Make it mine). */
export const recentRow = (app, onUndo) => h('button', { type: 'button', class: 'li', onclick: () => recentSheet(app, onUndo) },
  h('span', { class: 'ftype' }, icon('undo')), h('span', { class: 'grow' }, h('b', null, 'Recent changes'), h('span', { class: 'sub' }, 'What you and your Claude changed, with Undo')), icon('chevron', 'chev'));
