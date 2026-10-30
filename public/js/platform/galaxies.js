// Their own galaxies in the app (docs/platform/v2-plan.md 2.1, WP3): the galaxy page (#galaxy/<id>, #galaxy/<id>/add
// opens the picker), the Galaxies sheet (new galaxy, the one order of galaxies and subjects, lay the rest out by
// subject or section), picking topics, typing new ones, choosing a topic's galaxy from its sheet, and the Today tile.
// Every change is one POST /api/p/galaxies with a toast and Undo (POST /api/p/undo). Loaded on demand.
import { get, post, patch } from './api.js';
import { h, icon, btn, sheet, confirmSheet, toast, field, input, select, textarea, pageHead, loading, errorState, state, busy, plural,
  ring, dot, topicChip, askClaude } from './kit.js';

const enc = encodeURIComponent;

/** One change: the toast says what changed and offers Undo; then() redraws. Returns the reply, or null on refusal. */
export async function change(ops, { then = () => {}, quiet = false } = {}) {
  try {
    const r = await post('/api/p/galaxies', { ops });
    const bits = [...(r.not_found || []).length ? [`not found: ${r.not_found.slice(0, 3).join(', ')}`] : [], ...(r.ambiguous || []).length ? ['some names are in two subjects'] : []];
    if (!quiet || bits.length) toast(`${cap(r.changed)}${bits.length ? ` (${bits.join('; ')})` : ''}`, r.batch_id ? { undo: async () => { await post('/api/p/undo', { batch_id: r.batch_id }); toast('Undone'); then(); if (location.hash.startsWith('#galaxy/')) dispatchEvent(new HashChangeEvent('hashchange')); } } : undefined);
    then(r);
    return r;
  } catch (e) { toast(e.message); return null; }
}
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Pure helpers (tests/web/platform-galaxies-ui.test.mjs).
export function moveInOrder(list, i, dir) {
  const j = i + dir;
  if (i < 0 || j < 0 || i >= list.length || j >= list.length) return list.slice();
  const out = list.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
export function filterTopics(q, list) {
  const w = String(q || '').trim().toLowerCase();
  return w ? list.filter(t => `${t.name} ${t.subject_name || ''} ${t.section || ''}`.toLowerCase().includes(w)) : list;
}
/** The subject new topics go to: the one most of the galaxy's topics are in, else the first. */
export function defaultSubject(galaxySubjects, subjects) {
  const best = (galaxySubjects || []).slice().sort((a, b) => b.topics.length - a.topics.length)[0];
  return (best && subjects.find(s => s.id === best.id)) || subjects[0] || null;
}

// ------------------------------------------------------------------ the galaxy page
export function render(root, { app, param }) {
  const [id, sub] = String(param || '').split('/');
  const back = { href: '#map', label: 'Map' };
  root.append(pageHead('Galaxy', { back }), loading(2));
  let alive = true;
  const load = () => Promise.all([get(`/api/p/galaxies/${enc(id)}`), get('/api/p/subjects')]).then(([g, s]) => { if (alive) paint(g, s.subjects || []); })
    .catch(e => { if (!alive) return; root.replaceChildren(pageHead('Galaxy', { back }), e.status === 404 ? state('galaxy', 'This galaxy is gone', 'It may have been deleted. Your topics are back in their subjects.', h('a', { class: 'btn btn-tinted', href: '#subjects' }, 'Subjects'), true) : errorState(e, load)); });
  app.onReturn = () => { if (alive) load(); };
  let opened = sub !== 'add';

  function paint({ galaxy: g, subjects: bySubject }, subjects) {
    const rename = btn('Rename', () => renameSheet(g, load), 'gray', 'pencil', { cls: 'btn-sm' });
    const onMap = h('a', { class: 'btn btn-gray btn-sm', href: `#map/${enc(`mine~${g.id}`)}` }, icon('map'), 'Map');
    const weakest = bySubject.flatMap(x => x.topics).filter(t => t.t1000 != null).sort((a, b) => b.t1000 - a.t1000)[0];
    const oneSubject = bySubject.length === 1 ? bySubject[0] : null;
    const chips = bySubject.length
      ? bySubject.map(x => h('section', { class: 'card', style: 'padding:var(--pad);display:grid;gap:10px' },
        h('div', { class: 't-micro' }, x.name),
        h('div', { class: 'chips' }, x.topics.map(t => topicChip(t, () => import('./topic.js').then(m => m.openTopicSheet({ ...t, subject_id: x.id, subject_name: x.name }, { app, onClose: load })))))))
      : [state('galaxy', 'This galaxy is empty', 'Add topics you already have, or type new ones.', null, true)];
    const asks = [
      [`Teach me the weakest topic in my ${g.title} galaxy`, 'Teach me the weakest'],
      [`Test me on my ${g.title} galaxy: 6 mixed questions, one at a time`, 'Test me on it'],
      oneSubject ? [`Write me a 6-question practice paper on my ${g.title} galaxy (${oneSubject.name}), with a mark scheme, and add it to my Study Hub.`, 'A practice paper on it'] : null,
    ].filter(Boolean);
    root.replaceChildren(
      pageHead(g.title, { back, kicker: `Your galaxy · ${plural(g.n, 'topic')}`, how: 'galaxies', actions: [rename, onMap] }),
      h('section', { class: 'tile', style: 'flex-direction:row;align-items:center;gap:16px;margin-bottom:var(--gap)' },
        ring(g.ring, { size: 64, stroke: 7, label: `${Math.round(g.ring * 100)}% strong` }),
        h('div', { class: 'grow' }, h('b', null, `${g.seen_n} of ${g.n} seen · ${g.weak_n} weak`),
          h('p', { class: 'foot' }, weakest ? `Weakest: ${weakest.name}.` : 'Nothing tested here yet.'))),
      h('div', { class: 'row', style: 'margin-bottom:var(--gap)' },
        btn('Add topics', () => pickSheet(g, 'add', load), 'primary', 'plus'),
        btn('New topics', () => newTopicsSheet({ galaxy: g, subjects, near: bySubject, onDone: load }), 'tinted', 'pencil'),
        g.n ? btn('Take some out', () => pickSheet(g, 'remove', load), 'gray', 'undo') : null),
      h('div', { class: 'stack' }, chips),
      h('div', { class: 'section-title' }, 'Ask your Claude'),
      h('div', { class: 'row' }, asks.map(([w, l]) => askClaude(w, l, { app }))),
      h('div', { class: 'row', style: 'margin-top:28px' }, btn('Delete this galaxy', async () => {
        if (!(await confirmSheet({ title: `Delete ${g.title}?`, sub: 'Its topics go back to their subjects. You can undo.', ok: 'Delete', danger: true }))) return;
        const r = await change([{ op: 'delete', galaxy: g.id }]);
        if (r) app.go('#map');
      }, 'danger', 'trash')));
    if (!opened) { opened = true; history.replaceState(null, '', `#galaxy/${enc(g.id)}`); pickSheet(g, 'add', load); }
  }
  load();
  return () => { alive = false; };
}

function renameSheet(g, done) {
  const name = input({ value: g.title, maxLength: 40 });
  const go = btn('Rename', null, 'primary');
  const sh = sheet({ title: 'Rename galaxy', body: h('div', { class: 'form' }, field('Name', name)), actions: [btn('Cancel', () => sh.close(), 'gray'), go] });
  go.addEventListener('click', () => busy(go, async () => { const r = await change([{ op: 'rename', galaxy: g.id, title: name.value }], { then: done }); if (r) sh.close(); }));
}

// ------------------------------------------------------------------ pick topics (add, or take out)
export function pickSheet(g, mode, done) {
  const q = input({ type: 'search', placeholder: 'Search your topics', 'aria-label': 'Search your topics' });
  const listEl = h('div', { class: 'stack', style: 'gap:10px' }, loading(1));
  const go = btn(mode === 'add' ? 'Add' : 'Take out', null, 'primary');
  const sh = sheet({ title: mode === 'add' ? `Add topics to ${g.title}` : `Take topics out of ${g.title}`, sub: mode === 'add' ? 'A topic moves here from wherever it was. It still counts for its subject.' : 'They go back to their subject\'s galaxy.',
    wide: true, body: h('div', { class: 'form' }, q, listEl), actions: [btn('Cancel', () => sh.close(), 'gray'), go] });
  const picked = new Set();
  let all = [];
  const label = () => { go.textContent = picked.size ? `${mode === 'add' ? 'Add' : 'Take out'} ${plural(picked.size, 'topic')}` : (mode === 'add' ? 'Add' : 'Take out'); go.disabled = !picked.size; };
  const draw = () => {
    const rows = filterTopics(q.value, all);
    const bySub = new Map();
    for (const t of rows) { const k = t.subject_name || 'Other'; if (!bySub.has(k)) bySub.set(k, []); bySub.get(k).push(t); }
    listEl.replaceChildren(...(rows.length ? [...bySub].map(([name, ts]) => h('div', { class: 'list cv' },
      h('div', { class: 'li t-micro', style: 'min-height:40px' }, name),
      ts.slice(0, 300).map(t => {
        const on = picked.has(t.id);
        const row = h('button', { type: 'button', class: 'li', role: 'checkbox', 'aria-checked': String(on), onclick: () => {
          if (picked.has(t.id)) picked.delete(t.id); else picked.add(t.id);
          row.setAttribute('aria-checked', String(picked.has(t.id))); label();
        } }, h('span', { class: 'tick' + (on ? ' on' : '') }, icon('check')), dot(t.t1000), h('span', { class: 'grow' }, t.name,
          h('span', { class: 'sub' }, [t.section, t.galaxy && t.galaxy.id !== g.id ? `in ${t.galaxy.title}` : null].filter(Boolean).join(' · '))));
        return row;
      }))) : [state('search', 'No topics match', mode === 'add' ? 'Try other words, or type new topics instead.' : 'Nothing to take out.', null, true)]));
  };
  q.addEventListener('input', draw);
  get('/api/p/topics').then(r => {
    all = (r.topics || []).filter(t => (mode === 'add' ? !(t.galaxy && t.galaxy.id === g.id) : t.galaxy && t.galaxy.id === g.id));
    draw(); label();
  }).catch(e => listEl.replaceChildren(errorState(e)));
  go.addEventListener('click', () => busy(go, async () => {
    const r = await change([mode === 'add' ? { op: 'add', galaxy: g.id, topics: [...picked] } : { op: 'remove', galaxy: g.id, topics: [...picked] }], { then: done });
    if (r) sh.close();
  }));
  label();
  return sh;
}

// ------------------------------------------------------------------ type new topics (into a galaxy, or a subject)
/** galaxy: put them there too; subject: fixed (the subject page's Add topics). near: the galaxy's topics by subject. */
export function newTopicsSheet({ galaxy = null, subjects = [], subject = null, near = [], onDone = () => {} } = {}) {
  const text = textarea({ rows: 5, maxLength: 2000, placeholder: 'One topic per line, e.g.\nHess\'s law\nBond enthalpies', 'aria-label': 'New topics, one per line' });
  let sid = subject ? subject.id : (defaultSubject(near, subjects) || {}).id;
  const secBox = h('div');
  let section = 'Other';
  const drawSections = () => {
    if (!sid) { secBox.replaceChildren(); return; }
    get(`/api/p/subjects/${enc(sid)}`).then(d => {
      const names = (d.sections || []).map(x => x.name).filter(n => n !== 'Other');
      const other = input({ placeholder: 'New section name', maxLength: 60, hidden: true });
      const sel = select([{ value: 'Other', label: 'Other' }, ...names.map(n => ({ value: n, label: n })), { value: '__new', label: 'New section…' }], 'Other', v => {
        other.hidden = v !== '__new'; section = v === '__new' ? other.value : v; if (v === '__new') other.focus();
      });
      other.addEventListener('input', () => { section = other.value; });
      secBox.replaceChildren(field('Section', sel), other);
    }).catch(() => secBox.replaceChildren());
  };
  const go = btn('Add', null, 'primary');
  const names = () => text.value.split('\n').map(x => x.trim()).filter(Boolean);
  const label = () => { const n = names().length; go.textContent = n ? `Add ${plural(n, 'topic')}` : 'Add'; go.disabled = !n || n > 25; };
  text.addEventListener('input', label);
  const sh = sheet({ title: galaxy ? `New topics in ${galaxy.title}` : `Add topics to ${subject.name}`, sub: galaxy ? 'They belong to a subject too, so papers and results count them there.' : 'Type your own. Up to 25 at a time.',
    wide: true, body: h('div', { class: 'form' }, field('Topics', text, 'one per line, 25 at most'),
      subject ? null : field('Subject', select(subjects.map(s => ({ value: s.id, label: s.name })), sid, v => { sid = v; drawSections(); })), secBox),
    actions: [btn('Cancel', () => sh.close(), 'gray'), go] });
  drawSections(); label();
  go.addEventListener('click', () => busy(go, async () => {
    const list = names();
    const sec = String(section || 'Other').trim() || 'Other';
    if (galaxy) {
      const r = await change([{ op: 'new_topics', galaxy: galaxy.id, subject: sid, section: sec, names: list }], { then: onDone });
      if (r) sh.close();
      return;
    }
    try {
      const r = await post(`/api/p/subjects/${enc(sid)}/topics`, { sections: [{ name: sec, topics: list }] });
      toast(r.added ? `Added ${plural(r.added, 'topic')}` : 'Those are already in your list', r.batch_id ? { undo: async () => { await post('/api/p/undo', { batch_id: r.batch_id }); toast('Undone'); onDone(); } } : undefined);
      sh.close(); onDone();
    } catch (e) { toast(e.message); }
  }));
  return sh;
}

// ------------------------------------------------------------------ the Galaxies sheet: new, order, layout
export function galaxiesSheet(app, onChange = () => {}) {
  const body = h('div', { class: 'form' }, loading(1));
  const sh = sheet({ title: 'Galaxies', sub: 'Each subject is a galaxy. Make your own for a mock, a paper or a theme; a topic you put in one moves there on the map.', wide: true, body });
  let order = [], first = [], layout = 'subject';
  const done = btn('Save order', null, 'primary');
  const draw = () => {
    const rows = order.map((x, i) => h('div', { class: 'li gx-row' },
      h('span', { class: 'ftype' }, icon(x.kind === 'galaxy' ? 'sparkle' : 'grid')),
      h('span', { class: 'grow' }, x.kind === 'galaxy' ? h('a', { href: `#galaxy/${enc(x.id)}`, onclick: () => sh.close() }, x.title) : h('b', null, x.title),
        h('span', { class: 'sub' }, [x.kind === 'galaxy' ? 'Your galaxy' : 'Subject', plural(x.n, 'topic'), x.weak_n ? `${x.weak_n} weak` : null].filter(Boolean).join(' · '))),
      h('button', { type: 'button', class: 'btn btn-gray btn-icon', 'aria-label': `Move ${x.title} up`, disabled: i === 0, onclick: () => { order = moveInOrder(order, i, -1); draw(); } }, icon('arrowUp')),
      h('button', { type: 'button', class: 'btn btn-gray btn-icon', 'aria-label': `Move ${x.title} down`, disabled: i === order.length - 1, onclick: () => { order = moveInOrder(order, i, 1); draw(); } }, icon('arrowDown'))));
    const name = input({ placeholder: 'e.g. Energy, Paper 1, Mock in March', maxLength: 40, 'aria-label': 'New galaxy name' });
    const make = btn('Make it', null, 'primary', 'plus');
    make.addEventListener('click', () => busy(make, async () => {
      if (!name.value.trim()) { toast('Give it a name first.'); return; }
      const r = await change([{ op: 'create', title: name.value }], { then: onChange });
      if (r && r.created) { sh.close(); app.go(`#galaxy/${enc(r.created.id)}/add`); }
    }));
    const lay = h('div', { class: 'seg', role: 'group', 'aria-label': 'Lay out the rest by' }, ...[['subject', 'Subject'], ['section', 'Section']].map(([v, l]) =>
      h('button', { type: 'button', 'aria-pressed': String(layout === v), onclick: async () => {
        try { await patch('/api/p/custom', { patch: { map: { group_by: v === 'subject' ? 'subject' : null } } }); layout = v; draw(); toast(v === 'section' ? 'The rest are laid out by section' : 'The rest are laid out by subject'); onChange(); }
        catch (e) { toast(e.message); }
      } }, l)));
    const changed = order.map(x => x.id).join() !== first.map(x => x.id).join();
    done.disabled = !changed;
    body.replaceChildren(
      h('div', { class: 'field' }, h('span', null, 'New galaxy'), h('div', { class: 'row', style: 'flex-wrap:nowrap' }, name, make)),
      h('div', { class: 'field' }, h('span', null, 'Your order, first to last'), h('div', { class: 'list' }, rows)),
      h('div', { class: 'row' }, done),
      h('div', { class: 'field' }, h('span', null, 'Lay out the rest by'), lay),
      h('p', { class: 'foot' }, 'Or tell your Claude: "Make a galaxy called Energy with Enzymes, Respiration and Photosynthesis." ', h('a', { href: '#how/galaxies', onclick: () => sh.close() }, 'How galaxies work'), ' · ',
        h('button', { type: 'button', class: 'linkish', onclick: () => import('./recent.js').then(m => m.recentSheet(app, onChange)) }, 'Recent changes')));
  };
  done.addEventListener('click', () => busy(done, async () => {
    const r = await change([{ op: 'order', order: order.map(x => x.id) }], { then: onChange });
    if (r) { first = order.slice(); draw(); }
  }));
  get('/api/p/galaxies').then(r => { order = r.order || []; first = order.slice(); layout = r.layout || 'subject'; draw(); }).catch(e => body.replaceChildren(errorState(e)));
  return sh;
}

// ------------------------------------------------------------------ a topic's galaxy (from the topic sheet)
export function chooseGalaxySheet(topic, current, onDone = () => {}) {
  const body = h('div', { class: 'form' }, loading(1));
  const sh = sheet({ title: `Which galaxy for ${topic.name}?`, sub: 'It moves there on your map and still counts for its subject.', body });
  get('/api/p/galaxies').then(r => {
    const rows = (r.galaxies || []).map(g => h('button', { type: 'button', class: 'li', role: 'radio', 'aria-checked': String(!!current && current.id === g.id), onclick: async () => {
      if (current && current.id === g.id) { sh.close(); return; }
      const x = await change([{ op: 'add', galaxy: g.id, topics: [topic.id] }], { then: onDone }); if (x) sh.close();
    } }, h('span', { class: 'ftype' }, icon('sparkle')), h('span', { class: 'grow' }, g.title, h('span', { class: 'sub' }, plural(g.n, 'topic')))));
    const home = h('button', { type: 'button', class: 'li', role: 'radio', 'aria-checked': String(!current), onclick: async () => {
      if (!current) { sh.close(); return; }
      const x = await change([{ op: 'remove', topics: [topic.id] }], { then: onDone }); if (x) sh.close();
    } }, h('span', { class: 'ftype' }, icon('grid')), h('span', { class: 'grow' }, `Just ${topic.subject_name || 'its subject'}`));
    const name = input({ placeholder: 'New galaxy name', maxLength: 40, 'aria-label': 'New galaxy name' });
    const make = btn('Make it', null, 'tinted', 'plus');
    make.addEventListener('click', () => busy(make, async () => {
      if (!name.value.trim()) { toast('Give it a name first.'); return; }
      const x = await change([{ op: 'create', title: name.value, topics: [topic.id] }], { then: onDone }); if (x) sh.close();
    }));
    body.replaceChildren(h('div', { class: 'list' }, home, ...rows), h('div', { class: 'field' }, h('span', null, 'Or a new galaxy'), h('div', { class: 'row', style: 'flex-wrap:nowrap' }, name, make)));
  }).catch(e => body.replaceChildren(errorState(e)));
  return sh;
}

// ------------------------------------------------------------------ Today and Subjects
export function todayTile(el, galaxies) {
  if (!galaxies || !galaxies.length) { el.hidden = true; return; }
  el.replaceChildren(
    h('div', { class: 'tile-label' }, icon('sparkle'), 'Your galaxies', h('a', { class: 'aside', href: '#subjects' }, 'All')),
    h('div', { class: 'rings' }, galaxies.slice(0, 6).map(g => h('a', { class: 'ringcell', href: `#galaxy/${enc(g.id)}` },
      ring(g.ring, { size: 72, stroke: 8, label: `${g.title}: ${Math.round(g.ring * 100)}% strong` }),
      h('b', null, g.title), h('span', null, g.weak_n ? `${plural(g.n, 'topic')} · ${g.weak_n} weak` : plural(g.n, 'topic'))))));
  el.hidden = false;
}

export function subjectsSection(app) {
  const box = h('section', null, h('div', { class: 'section-title' }, 'Your galaxies'), loading(1));
  get('/api/p/galaxies').then(r => {
    const tiles = (r.galaxies || []).map(g => h('a', { class: 'li', href: `#galaxy/${enc(g.id)}` }, h('span', { class: 'ftype' }, icon('sparkle')),
      h('span', { class: 'grow' }, h('b', null, g.title), h('span', { class: 'sub' }, [plural(g.n, 'topic'), g.weak_n ? `${g.weak_n} weak` : null].filter(Boolean).join(' · '))), icon('chevron', 'chev')));
    box.replaceChildren(h('div', { class: 'section-title' }, 'Your galaxies'),
      tiles.length ? h('div', { class: 'list' }, tiles) : h('p', { class: 'foot' }, 'Group topics your way, for a mock, a paper or a theme. They show as galaxies on your map.'),
      h('div', { class: 'row', style: 'margin-top:10px' }, btn('New galaxy or order', () => galaxiesSheet(app, () => app.route()), 'tinted', 'sparkle')));
  }).catch(() => box.remove());
  return box;
}
