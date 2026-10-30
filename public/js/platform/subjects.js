// Subjects (#subjects) and one subject (#subject/<id>): sections of topic chips coloured by weakness (with band
// words), Suggest topics (preview with ticks, then Add), add/remove a subject, board and tier, edit or retire a
// topic. Every change shows a toast with Undo (POST /api/p/undo {batch_id}).
import { get, post, patch, del, load, cached } from './api.js';
import { h, icon, ring, dot, topicChip, bandText, legend, btn, linkBtn, sheet, confirmSheet, toast, field, input, select, seg, askClaude,
  pageHead, loading, errorState, state, busy, teachHref, fmtDay, plural } from './kit.js';
import { resultCells } from './topic.js';

const undoer = (batchId, after) => async () => {
  await post('/api/p/undo', { batch_id: batchId });
  toast('Undone');
  if (after) after();
};
const catalogue = () => get('/api/p/catalogue');

export function render(root, ctx) {
  if (ctx.name === 'subject' && ctx.param) return renderOne(root, ctx);
  return renderList(root, ctx);
}

// ------------------------------------------------------------------ list
function renderList(root, { app }) {
  const addBtn = btn('Add subject', () => addSubjectSheet(app), 'tinted', 'plus');
  root.append(pageHead('Subjects', { actions: [addBtn] }), loading(3));
  load('/api/p/subjects', ({ subjects }) => {
    const grid = subjects.length
      ? h('div', { class: 'bento' }, subjects.map(s => h('a', { class: 'tile s6 rise', href: `#subject/${encodeURIComponent(s.id)}`, style: 'flex-direction:row;align-items:center;gap:16px' },
        ring(s.ring, { size: 64, stroke: 7, label: `${s.name}: ${Math.round(s.ring * 100)}% strong` }),
        h('span', { class: 'grow' },
          h('b', { class: 't-title3', style: 'display:block' }, s.name),
          h('span', { class: 'foot', style: 'display:block;margin-top:2px' }, [s.board_name, s.tier ? cap(s.tier) : null].filter(Boolean).join(' · ')),
          h('span', { class: 'foot', style: 'display:block' }, s.topics_n ? `${plural(s.topics_n, 'topic')} · ${s.seen_n} seen · ${s.weak_n} weak` : 'No topics yet')),
        icon('chevron', 'chev'))))
      : state('grid', 'No subjects yet', 'Add the subjects you are studying, then let AI suggest topics for each.', btn('Add a subject', () => addSubjectSheet(app), 'primary', 'plus'));
    const mine = h('div');
    root.replaceChildren(pageHead('Subjects', { actions: [addBtn], how: 'subjects' }), grid, mine);
    import('./galaxies.js').then(m => mine.replaceChildren(m.subjectsSection(app))).catch(() => {});
  }, e => root.replaceChildren(pageHead('Subjects'), errorState(e, () => app.route())));
}
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

export async function addSubjectSheet(app, onAdded) {
  const s = sheet({ title: 'Add a subject', body: loading(1) });
  let cat, mine;
  try { [cat, mine] = await Promise.all([catalogue(), get('/api/p/subjects')]); } catch (e) { s.setBody(errorState(e)); return; }
  const have = new Set(mine.subjects.map(x => x.subject));
  const free = cat.subjects.filter(x => !have.has(x.id));
  let chosen = null, board = 'other', tier = null;
  const boardBox = h('div', { class: 'form' });
  const nameIn = input({ placeholder: 'e.g. Further Maths', maxLength: 60, autocapitalize: 'words' });
  const custom = { id: 'custom', name: 'Something else', boards: cat.boards.map(b => b.id) };
  const drawBoard = () => {
    if (!chosen) { boardBox.replaceChildren(); return; }
    const boards = cat.boards.filter(b => chosen.boards.includes(b.id));
    board = boards.some(b => b.id === board) ? board : (boards[0] || {}).id || 'other';
    boardBox.replaceChildren(
      chosen.id === 'custom' ? field('Subject name', nameIn) : null,
      field('Exam board', select(boards.map(b => ({ value: b.id, label: b.name })), board, v => { board = v; })),
      chosen.tiers ? field('Tier', seg(chosen.tiers.map(t => ({ value: t, label: cap(t) })), tier = tier || 'higher', v => { tier = v; })) : null);
  };
  const chips = h('div', { class: 'chips' }, [...free, custom].map(c => {
    const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', onclick: () => {
      chosen = c; tier = c.tiers ? 'higher' : null;
      for (const x of chips.children) x.setAttribute('aria-pressed', String(x === b));
      drawBoard();
    } }, c.name);
    return b;
  }));
  const add = btn('Add', null, 'primary');
  add.addEventListener('click', () => busy(add, async () => {
    if (!chosen) { toast('Pick a subject first.'); return; }
    const body = chosen.id === 'custom' ? { subject: 'custom', name: nameIn.value.trim(), board } : { subject: chosen.id, board, ...(tier ? { tier } : {}) };
    if (body.subject === 'custom' && !body.name) { toast('Type the subject name.'); return; }
    try {
      const r = await post('/api/p/subjects', body);
      s.close();
      toast(`Added ${r.subject.name}`, { undo: undoer(r.batch_id, () => app.route()) });
      if (onAdded) onAdded(r.subject); else app.route();
    } catch (e) { toast(e.message); }
  }));
  s.setBody(
    h('p', { class: 'small muted' }, `${cat.track_label}: tap a subject, then pick your exam board.`),
    chips, boardBox);
  s.setActions(btn('Cancel', () => s.close(), 'gray'), add);
}

// ------------------------------------------------------------------ one subject
function renderOne(root, { app, param }) {
  const path = `/api/p/subjects/${encodeURIComponent(param)}`;
  const back = { href: '#subjects', label: 'Subjects' };
  root.append(pageHead(' ', { back }), loading(2));
  load(path, data => paintOne(root, data, app, path, back), e => root.replaceChildren(pageHead('Subject', { back }),
    errorState(e, () => app.route())));
}

function paintOne(root, data, app, path, back) {
  const s = data.subject;
  const refresh = () => get(path).then(d => paintOne(root, d, app, path, back)).catch(e => toast(e.message));
  const suggest = app.on('ai_topics') ? btn('Suggest topics', () => suggestSheet(s, null, refresh), 'primary', 'sparkle') : null;
  const typeIn = btn('Add topics', () => import('./galaxies.js').then(m => m.newTopicsSheet({ subject: s, onDone: refresh })), suggest ? 'tinted' : 'primary', 'plus');
  const more = btn('Board and tier', () => boardSheet(s, refresh), 'gray', 'pencil');
  const onMap = s.topics_n ? linkBtn('Map', `#map/${encodeURIComponent(s.id)}`, 'gray', 'map') : null;
  const head = pageHead(s.name, { back, kicker: [s.board_name, s.tier ? cap(s.tier) : null, s.spec_code].filter(Boolean).join(' · '), how: 'subjects', actions: [suggest, typeIn, onMap, more].filter(Boolean), how: 'subjects' });

  const summary = h('section', { class: 'tile', style: 'flex-direction:row;align-items:center;gap:18px;flex-wrap:wrap' },
    ring(s.ring, { size: 84, stroke: 9, label: `${Math.round(s.ring * 100)}% strong` }),
    h('div', { class: 'grow' },
      h('div', { class: 't-title3' }, s.topics_n ? `${s.seen_n} of ${s.topics_n} topics seen` : 'No topics yet'),
      h('div', { class: 'foot', style: 'margin-top:4px' }, s.topics_n ? `${s.weak_n} weak or very weak` : 'Tap Suggest topics to get a revision checklist, then untick what you do not need.'),
      data.unplaced ? h('div', { class: 'foot', style: 'margin-top:4px' }, `${plural(data.unplaced, 'result')} could not be matched to a topic yet.`) : null),
    legend());

  const secs = h('div', { class: 'card', style: 'margin-top:var(--gap)' }, data.sections.map(sec => {
    const chips = h('div', { class: 'chips' }, sec.topics.map(t => topicChip(t, () => openTopic(t.id, { app, subjectName: s.name, board: s.board_name, sections: data.sections, onChange: refresh }))));
    return h('div', { class: 'sec cv' },
      h('h3', null, sec.name, h('span', { class: 'aside' }, sec.topics.length ? String(sec.topics.length) : '')),
      sec.topics.length ? chips : h('div', { class: 'row' }, h('span', { class: 'foot' }, 'No topics yet.'),
        app.on('ai_topics') ? btn('Suggest for this section', () => suggestSheet(s, sec.name, refresh), 'plain', 'sparkle', { cls: 'btn-sm' }) : null));
  }));

  const remove = btn(`Remove ${s.name}`, async () => {
    const ok = await confirmSheet({ title: `Remove ${s.name}?`, sub: 'Its topics and history are kept, hidden. You can undo this straight away.', ok: 'Remove', danger: true });
    if (!ok) return;
    app.go('#subjects');
    try {
      const r = await del(`/api/p/subjects/${encodeURIComponent(s.id)}`);
      toast(`Removed ${s.name}`, { undo: undoer(r.batch_id, () => app.route()) });
      app.route();
    } catch (e) { toast(e.message); }
  }, 'danger', 'trash');

  root.replaceChildren(head, summary, secs, h('div', { style: 'margin-top:28px;display:flex;justify-content:center' }, remove));
}

function boardSheet(s, done) {
  let board = s.board, tier = s.tier;
  const spec = input({ value: s.spec_code || '', placeholder: 'Optional, e.g. 7402', maxLength: 20, autocapitalize: 'characters' });
  const year = select([{ value: '', label: 'Not set' }, ...[2026, 2027, 2028, 2029].map(y => ({ value: y, label: String(y) }))], s.exam_year || '');
  const box = h('div', { class: 'form' }, loading(1));
  const sh = sheet({ title: 'Board and tier', sub: s.name, body: box });
  catalogue().then(cat => {
    const c = cat.subjects.find(x => x.id === s.subject);
    const boards = cat.boards.filter(b => !c || c.boards.includes(b.id));
    box.replaceChildren(
      field('Exam board', select(boards.map(b => ({ value: b.id, label: b.name })), board, v => { board = v; })),
      c && c.tiers ? field('Tier', seg(c.tiers.map(t => ({ value: t, label: cap(t) })), tier || 'higher', v => { tier = v; })) : null,
      field('Spec code', spec, 'optional'), field('Exam year', year));
    const save = btn('Save', null, 'primary');
    save.addEventListener('click', () => busy(save, async () => {
      try {
        const body = { board, spec_code: spec.value.trim() || null, exam_year: year.value ? Number(year.value) : null };
        if (c && c.tiers) body.tier = tier || 'higher';
        const r = await patch(`/api/p/subjects/${encodeURIComponent(s.id)}`, body);
        sh.close();
        toast('Saved', { undo: undoer(r.batch_id, done) });
        done();
      } catch (e) { toast(e.message); }
    }));
    sh.setActions(btn('Cancel', () => sh.close(), 'gray'), save);
  }).catch(e => box.replaceChildren(errorState(e)));
}

// Suggest topics: a preview with ticks (nothing stored), then Add writes only the ticked ones.
export function suggestSheet(s, section, done) {
  const askWords = `Suggest revision topics for my ${s.board_name && s.board_name !== 'Other' ? s.board_name + ' ' : ''}${s.name}${section ? ` section ${section}` : ''}. Show me the list first, then add the ones I pick to my Study Hub.`;
  const sh = sheet({ title: section ? `Topics for ${section}` : `Suggest topics for ${s.name}`, sub: 'AI writes revision headings in its own words. Untick any you do not need. Or ask your Claude, which knows your course.', wide: true,
    actions: [askClaude(askWords, 'Ask my Claude instead', { cls: 'btn btn-plain' })],
    body: h('div', { class: 'state inline' }, h('div', { class: 'boot', style: 'min-height:60px' }, h('i')), h('p', null, 'Thinking of topics. This takes a few seconds.')) });
  post(`/api/p/subjects/${encodeURIComponent(s.id)}/suggest`, section ? { section } : {}).then(r => {
    if (sh.closed) return;
    const picks = [];
    const total = () => picks.filter(p => p.on).length;
    const addBtn = btn('Add', null, 'primary');
    const label = () => { addBtn.textContent = total() ? `Add ${plural(total(), 'topic')}` : 'Add'; addBtn.disabled = !total(); };
    const body = r.sections.filter(x => x.topics.length).map(sec => h('div', { class: 'list cv', style: 'margin-bottom:12px' },
      h('div', { class: 'li t-micro', style: 'min-height:40px' }, sec.name),
      sec.topics.map(t => {
        const p = { section: sec.name, name: t.name, on: true };
        picks.push(p);
        const row = h('button', { type: 'button', class: 'li', role: 'checkbox', 'aria-checked': 'true', onclick: () => {
          p.on = !p.on; row.setAttribute('aria-checked', String(p.on)); label();
        } }, h('span', { class: 'tick' }, icon('check')), h('span', { class: 'grow' }, t.name));
        return row;
      })));
    if (!picks.length) { sh.setBody(state('sparkle', 'No new topics', 'Everything suggested is already on your list.', null, true)); return; }
    sh.setBody(h('p', { class: 'foot' }, `Suggested by ${r.provider === 'workers_ai' ? 'the built-in AI' : 'your AI'}${r.usd ? ` · cost ${r.usd < 0.01 ? 'under 1p' : '$' + r.usd.toFixed(3)}` : ''}`), body);
    addBtn.addEventListener('click', () => busy(addBtn, async () => {
      const bySec = new Map();
      for (const p of picks) if (p.on) { if (!bySec.has(p.section)) bySec.set(p.section, []); bySec.get(p.section).push({ name: p.name }); }
      try {
        const res = await post(`/api/p/subjects/${encodeURIComponent(s.id)}/topics`, { sections: [...bySec].map(([name, topics]) => ({ name, topics })) });
        sh.close();
        toast(`Added ${plural(res.added, 'topic')}${res.skipped ? ` (${res.skipped} already there)` : ''}`, { undo: undoer(res.batch_id, done) });
        if (done) done(res);
      } catch (e) { toast(e.message); }
    }));
    label();
    sh.setActions(askClaude(askWords, 'Ask my Claude', { cls: 'btn btn-plain' }), btn('Cancel', () => sh.close(), 'gray'), addBtn);
  }).catch(e => { if (!sh.closed) sh.setBody(errorState(e, () => { sh.close(); suggestSheet(s, section, done); })); });
  return sh;
}

// One topic: band, recent evidence, cards and gap notes; rename, move, retire, teach, draft cards.
export function openTopic(id, { app, subjectName, board, sections, onChange } = {}) {
  const sh = sheet({ title: 'Topic', body: loading(1) });
  get(`/api/p/topics/${encodeURIComponent(id)}`).then(d => {
    const t = d.topic;
    sh.el.querySelector('h2').textContent = t.name;
    const name = input({ value: t.name, maxLength: 80 });
    const secSel = sections ? select(sections.map(x => ({ value: x.name, label: x.name })), t.section) : null;
    const save = btn('Save changes', null, 'tinted');
    save.addEventListener('click', () => busy(save, async () => {
      const body = {};
      if (name.value.trim() && name.value.trim() !== t.name) body.name = name.value.trim();
      if (secSel && secSel.value !== t.section) body.section = secSel.value;
      if (!Object.keys(body).length) { sh.close(); return; }
      try {
        const r = await patch(`/api/p/topics/${encodeURIComponent(t.id)}`, body);
        sh.close();
        toast('Topic saved', { undo: undoer(r.batch_id, onChange) });
        if (onChange) onChange();
      } catch (e) { toast(e.message); }
    }));
    const retire = btn('Retire topic', async () => {
      sh.close();
      try {
        const r = await patch(`/api/p/topics/${encodeURIComponent(t.id)}`, { retired: true });
        toast(`Retired ${t.name}`, { undo: undoer(r.batch_id, onChange || (() => app && app.route())) });
        if (onChange) onChange(); else if (app) app.route();
      } catch (e) { toast(e.message); }
    }, 'danger', 'trash', { cls: 'btn-sm' });
    const recent = d.recent && d.recent.length
      ? h('ul', { class: 'list' }, d.recent.slice(0, 6).map(r => h('li', null, ...resultCells(r))))
      : h('p', { class: 'foot' }, 'Nothing logged on this topic yet.');
    // Its pictures, as in the map's topic sheet (pictures.js).
    const pics = h('div');
    import('./pictures.js').then(m => { if (pics.isConnected) pics.replaceWith(m.picturesPart(t, app)); }).catch(() => {});
    sh.setBody(
      h('div', { class: 'row' }, dot(t.t1000, true), h('b', null, bandText(t)), h('span', { class: 'foot' }, [subjectName, t.section].filter(Boolean).join(' · '))),
      h('div', { class: 'row' },
        h('a', { class: 'btn btn-primary', href: teachHref(t.name, board, subjectName), target: '_blank', rel: 'noopener noreferrer' }, icon('teach'), 'Teach me in Claude'),
        app && app.on('cards') ? btn(d.cards_n ? `Cards (${d.cards_n})` : 'Make cards', () => { sh.close(); import('./cards.js').then(m => m.draftSheet({ topic_id: t.id, subject_id: t.subject_id, about: t.name })); }, 'tinted', 'cards') : null),
      h('div', { class: 't-micro' }, 'Recent'), recent, pics,
      d.gaps && d.gaps.length ? h('div', null, h('div', { class: 't-micro', style: 'margin-bottom:8px' }, 'Gap notes'), h('ul', { class: 'list' }, d.gaps.map(g => h('li', null, h('span', { class: 'grow' }, g.gap), h('span', { class: 'foot' }, fmtDay(g.at)))))) : null,
      h('div', { class: 't-micro' }, 'Edit'),
      field('Name', name), secSel ? field('Section', secSel) : null,
      h('div', { class: 'spread' }, retire, save));
  }).catch(e => sh.setBody(errorState(e)));
  return sh;
}
