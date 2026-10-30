// Chat notes (#chats): what they and their Claude covered, saved by their Claude as it goes or pasted in here
// (Paste from Claude, also on Today and in each topic). The hub keeps the words as written; their Claude reads them
// before the next lesson on those topics.
import { h, icon, btn, sheet, toast, busy, field, input, textarea, select, pageHead, loading, errorState, state, fmtDay, askClaude, confirmSheet } from './kit.js';
import { get, post, del } from './api.js';

const enc = encodeURIComponent;

/** Paste a chat (or Claude's summary of one). topic: {id, name} to file it under, or null to choose. */
export function pasteSheet(app, { topic = null, onDone = () => {} } = {}) {
  const text = textarea({ rows: 8, placeholder: 'In the Claude app, say "Summarise this chat for my Study Hub", copy its answer and paste it here. A whole chat works too.', 'aria-label': 'The chat or its summary' });
  const title = input({ maxLength: 100, placeholder: 'e.g. Osmosis with Claude' });
  const topicSel = select([{ value: '', label: topic ? topic.name : 'No topic' }], topic ? '' : '');
  if (!topic) get('/api/p/topics').then(r => topicSel.replaceChildren(...[{ id: '', name: 'No topic' }, ...(r.topics || [])].map(t => h('option', { value: t.id }, t.name)))).catch(() => {});
  const fromClip = navigator.clipboard && navigator.clipboard.readText
    ? btn('Paste what I copied', async () => { try { text.value = await navigator.clipboard.readText(); } catch { toast('Tap in the box and paste instead.'); } }, 'tinted', 'paste', { cls: 'btn-sm' }) : null;
  const save = btn('Save', null, 'primary');
  const s = sheet({ title: 'Paste from Claude', sub: 'Your Claude reads it before your next lesson on that topic. Nothing else is done with it.', wide: true,
    body: h('div', { class: 'form' }, fromClip, field('The chat or its summary', text), field('Title', title, 'optional'), field('Topic', topicSel, 'optional'),
      h('p', { class: 'foot' }, 'When the Study Hub is switched on in your chat, your Claude saves its own notes as you go, so you only need this for other chats.')),
    actions: [btn('Cancel', () => s.close(), 'gray'), save] });
  save.addEventListener('click', () => busy(save, async () => {
    try {
      const r = await post('/api/p/chats', { text: text.value, title: title.value || null, topic_id: topic ? topic.id : topicSel.value || null });
      s.close();
      toast('Saved for your Claude', { undo: async () => { await post('/api/p/undo', { batch_id: r.batch_id }); toast('Undone'); onDone(); } });
      onDone();
    } catch (e) { toast(e.message); }
  }));
  return s;
}

function openNote(id, reload) {
  const s = sheet({ title: 'Chat note', wide: true, body: loading(1) });
  get(`/api/p/chats/${enc(id)}`).then(({ note }) => {
    s.el.querySelector('h2').textContent = note.title || 'Chat note';
    s.setBody(h('p', { class: 'foot' }, `${note.source === 'paste' ? 'Pasted by you' : `Saved by your Claude${note.saves > 1 ? `, ${note.saves} times` : ''}`} · ${fmtDay(note.updated_at)}`),
      note.topics.length ? h('div', { class: 'chips' }, note.topics.map(t => h('span', { class: 'chip' }, t.name))) : null,
      h('div', { class: 'ch-body' }, note.body));
    s.setActions(btn('Remove', async () => {
      if (!(await confirmSheet({ title: 'Remove this note?', sub: 'Your Claude will not see it again. You can undo.', ok: 'Remove', danger: true }))) return;
      try { const r = await del(`/api/p/chats/${enc(id)}`); s.close(); toast('Removed', { undo: async () => { await post('/api/p/undo', { batch_id: r.batch_id }); reload(); } }); reload(); } catch (e) { toast(e.message); }
    }, 'gray', 'trash'), btn('Done', () => s.close(), 'primary'));
  }).catch(e => s.setBody(errorState(e)));
}

export function render(root, { app }) {
  const paste = btn('Paste from Claude', () => pasteSheet(app, { onDone: load }), 'primary', 'paste');
  root.append(pageHead('Chat notes', { kicker: 'What you and your Claude covered', actions: [paste] }), loading(2));
  let alive = true;
  function load() {
    get('/api/p/chats').then(({ notes }) => {
      if (!alive) return;
      const list = notes.length
        ? h('div', { class: 'list' }, notes.map(n => h('button', { type: 'button', class: 'li', onclick: () => openNote(n.id, load) },
          h('span', { class: 'ftype' }, icon(n.source === 'paste' ? 'paste' : 'chat')),
          h('span', { class: 'grow' }, h('b', null, n.title || 'A chat'), h('span', { class: 'sub' }, [fmtDay(n.updated_at), n.topics.map(t => t.name).slice(0, 3).join(', ')].filter(Boolean).join(' · '))),
          icon('chevron', 'chev'))))
        : state('chat', 'No chat notes yet', 'With the Study Hub switched on in a chat, your Claude saves a short note as you go. Or paste one in.',
          askClaude('Teach me my weakest topic, and save notes to my Study Hub as we go', 'Start a chat', { app }));
      root.replaceChildren(pageHead('Chat notes', { kicker: 'What you and your Claude covered', actions: [paste] }), list);
    }).catch(e => { if (alive) root.replaceChildren(pageHead('Chat notes'), errorState(e, load)); });
  }
  app.onReturn = load;
  load();
  return () => { alive = false; };
}
