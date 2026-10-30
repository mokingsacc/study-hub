// Results (#results) and logging one bank (#results/<bank>): bank tiles with their steps; paste or pick screenshots
// (downscaled here to 1,600 px JPEG before sending), an editable preview of the rows the AI read, or typed marks; Save.
import { get, post, del, load, qs } from './api.js';
import { h, icon, btn, linkBtn, sheet, confirmSheet, toast, field, input, select, seg, pageHead, loading, errorState, state, busy, plural, fmtDay, todayIso, scoreText, askClaude } from './kit.js';

export function render(root, ctx) {
  if (ctx.param) return renderLog(root, ctx);
  return renderHome(root, ctx);
}

const HOW_ICON = { screenshot: 'photo', typed: 'type' };

function renderHome(root, { app }) {
  root.append(pageHead('Results'), loading(3));
  Promise.all([get('/api/p/banks'), get('/api/p/results' + qs({ limit: 30 })), get('/api/p/subjects').catch(() => ({ subjects: [] }))]).then(([b, r, s]) => {
    const names = Object.fromEntries(s.subjects.map(x => [x.id, x.name]));
    const banks = h('div', { class: 'banks' }, b.banks.map(bk => h('a', { class: 'bank', href: `#results/${encodeURIComponent(bk.id)}` },
      h('b', null, bk.name), h('span', { class: 'how', 'aria-label': bk.how.join(' or ') }, bk.how.map(x => icon(HOW_ICON[x] || 'type'))))));
    const recent = r.results.length
      ? h('div', { class: 'list' }, r.results.map(x => h('button', { type: 'button', class: 'li cv', onclick: () => resultSheet(x, names, () => app.route()) },
        h('span', { class: 'grow' }, h('b', null, x.label || x.bank_name), h('span', { class: 'sub' }, [x.label ? x.bank_name : null, names[x.subject_id], fmtDay(x.day)].filter(Boolean).join(' · '))),
        h('span', { class: 'score' }, scoreText(x) || '—'))))
      : state('results', 'No results yet', 'Pick where your questions came from above. A screenshot of the score screen is enough.', null, true);
    root.replaceChildren(pageHead('Results', { how: 'results' }),
      h('p', { class: 'muted', style: 'margin:-12px 0 16px' }, 'Where did you do your questions?'),
      banks,
      app.on('connector') ? h('div', { class: 'tile', style: 'margin-top:var(--gap);flex-direction:row;gap:12px;align-items:flex-start' },
        h('span', { class: 'ftype' }, icon('sparkle')),
        h('div', { class: 'grow' }, h('b', null, 'Do it in Claude instead'),
          h('p', { class: 'foot', style: 'margin-top:2px' }, 'In the Claude app, share your screenshot and say "log my Seneca results for Biology". Claude saves it here through your connector.'),
          h('div', { style: 'margin-top:8px' }, askClaude("I'm sending a screenshot of my results: log them in my Study Hub.", 'Open my Claude', { app })))) : null,
      h('div', { class: 'section-title' }, 'Recent'), recent);
  }).catch(e => root.replaceChildren(pageHead('Results'), errorState(e, () => app.route())));
}

function resultSheet(x, names, done) {
  const remove = btn('Delete', null, 'danger', 'trash');
  const sh = sheet({ title: x.label || x.bank_name, sub: [x.bank_name, names[x.subject_id], fmtDay(x.day)].filter(Boolean).join(' · '),
    body: h('div', { class: 'row' }, h('span', { class: 't-display num' }, scoreText(x) || '—'),
      x.total_n ? h('span', { class: 'muted' }, `${x.right_n} right of ${x.total_n}`) : x.out_of ? h('span', { class: 'muted' }, `${Math.round(100 * (x.marks || 0) / x.out_of)}%`) : null),
    actions: [remove, btn('Close', () => sh.close(), 'gray')] });
  remove.addEventListener('click', async () => {
    sh.close();
    if (!(await confirmSheet({ title: 'Delete this result?', sub: 'It comes off your topic colours too.', ok: 'Delete', danger: true }))) return;
    try { await del(`/api/p/results/${encodeURIComponent(x.id)}`); toast('Result deleted'); done(); } catch (e) { toast(e.message); }
  });
}

// ------------------------------------------------------------------ screenshots: downscale in the browser
const MAX_SIDE = 1600, MAX_SHOTS = 4;
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture could not be opened.')); };
    img.src = url;
  });
}
export async function downscale(file) {
  const { img, url } = await loadImage(file);
  try {
    const w = img.naturalWidth, hgt = img.naturalHeight, k = Math.min(1, MAX_SIDE / Math.max(w, hgt));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(hgt * k));
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } finally { URL.revokeObjectURL(url); }
}

// ------------------------------------------------------------------ log one bank
function renderLog(root, { app, param }) {
  const back = { href: '#results', label: 'Results' };
  root.append(pageHead(' ', { back }), loading(2));
  let cleanup = () => {};
  Promise.all([get('/api/p/banks'), get('/api/p/subjects')]).then(([b, s]) => {
    const bank = b.banks.find(x => x.id === param);
    if (!bank) { root.replaceChildren(pageHead('Results', { back }), state('warn', 'That source is not on your list', null, linkBtn('Back to Results', '#results'))); return; }
    cleanup = paintLog(root, app, bank, s.subjects, back);
  }).catch(e => root.replaceChildren(pageHead('Results', { back }), errorState(e, () => app.route())));
  return () => cleanup();
}

function paintLog(root, app, bank, subjects, back) {
  const canShot = bank.how.includes('screenshot'), canType = bank.how.includes('typed');
  let subject = subjects.length === 1 ? subjects[0].id : '', topics = [];
  const shots = [];
  let rows = [];
  let how = canShot ? 'screenshot' : 'typed';

  const dl = h('datalist', { id: 'topic-list' });
  const loadTopics = id => {
    topics = [];
    dl.replaceChildren();
    if (!id) return;
    get(`/api/p/subjects/${encodeURIComponent(id)}`).then(d => {
      topics = d.sections.flatMap(sec => sec.topics.map(t => ({ name: t.name, section: sec.name })));
      dl.replaceChildren(...topics.map(t => h('option', { value: t.name })));
    }).catch(() => {});
  };
  const subjSel = select([{ value: '', label: 'Choose a subject' }, ...subjects.map(x => ({ value: x.id, label: x.name }))], subject, v => { subject = v; loadTopics(v); });
  if (subject) loadTopics(subject);
  const day = input({ type: 'date', value: todayIso(), max: todayIso() });
  const label = input({ placeholder: bank.id === 'past_paper' ? 'e.g. Paper 1 June 2024' : 'e.g. Cells quiz', maxLength: 80 });

  // The steps open by default the first time this source is used on this device.
  let seen = false;
  try { seen = localStorage.getItem(`sh-steps:${bank.id}`) === '1'; localStorage.setItem(`sh-steps:${bank.id}`, '1'); } catch { /* private mode */ }
  const steps = h('details', { class: 'card', style: 'padding:14px 18px', open: !seen },
    h('summary', { class: 't-head', style: 'cursor:pointer;min-height:28px' }, 'How to'),
    h('ol', { class: 'steplist', style: 'margin-top:12px' }, bank.steps.map(x => h('li', null, x))),
    bank.hint ? h('p', { class: 'foot', style: 'margin-top:12px' }, bank.hint) : null);

  // Screenshot picking and pasting.
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const thumbs = h('div', { class: 'shots' });
  const readBtn = btn('Read my screenshots', null, 'primary', 'sparkle', { cls: 'btn-lg' });
  readBtn.hidden = true;
  const addFiles = async files => {
    for (const f of [...files].filter(x => /^image\//.test(x.type))) {
      if (shots.length >= MAX_SHOTS) { toast(`Up to ${MAX_SHOTS} screenshots at a time.`); break; }
      try {
        const data = await downscale(f);
        shots.push(data);
        const img = h('img', { src: data, alt: `Screenshot ${shots.length}` });
        const x = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove screenshot', style: 'position:absolute;top:-10px;right:-10px;width:28px;height:28px', onclick: () => {
          shots.splice(shots.indexOf(data), 1); cell.remove(); readBtn.hidden = !shots.length;
        } }, icon('close'));
        const cell = h('div', { style: 'position:relative' }, img, x);
        thumbs.append(cell);
      } catch (e) { toast(e.message); }
    }
    readBtn.hidden = !shots.length;
  };
  fileIn.addEventListener('change', () => { addFiles(fileIn.files); fileIn.value = ''; });
  const onPaste = e => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length && how === 'screenshot') { e.preventDefault(); addFiles(files); }
  };
  document.addEventListener('paste', onPaste);
  const pick = h('button', { type: 'button', class: 'pick', onclick: () => fileIn.click() }, icon('photo'), h('b', null, 'Pick screenshots'), h('span', { class: 'foot' }, 'Up to 4. You can also paste one here.'));
  readBtn.addEventListener('click', () => busy(readBtn, async () => {
    if (!subject) { toast('Choose the subject first.'); subjSel.focus(); return; }
    readBtn.textContent = 'Reading…';
    try {
      const r = await post('/api/p/results/read', { bank: bank.id, subject_id: subject, images: shots });
      rows = r.rows.map(x => ({ ...x }));
      if (!rows.length) toast(r.message || 'No rows found. Type them instead.');
      else if (r.message) toast(r.message);
      drawRows();
    } catch (e) { toast(e.message); } finally { readBtn.textContent = 'Read my screenshots'; }
  }));
  const shotBox = h('div', { class: 'form' }, pick, fileIn, thumbs, readBtn);

  // Rows editor.
  const rowsBox = h('div', { class: 'rows' });
  const saveBtn = btn('Save', null, 'primary', 'check', { cls: 'btn-lg' });
  const rowsWrap = h('div', { hidden: true },
    h('div', { class: 'section-title' }, 'Check the rows', h('span', { class: 'aside foot' })),
    h('p', { class: 'foot', style: 'margin:-6px 0 12px' }, 'Fix anything that looks wrong. Pick a topic from your list so it lands on your map.'),
    rowsBox,
    h('div', { class: 'row', style: 'margin-top:12px' }, btn('Add a row', () => { rows.push(blank()); drawRows(); }, 'tinted', 'plus')),
    h('div', { class: 'row', style: 'margin-top:20px;justify-content:flex-end' }, saveBtn));
  const blank = () => ({ q: String(rows.length + 1), result: null, marks: null, out_of: null, topic: '', section: null, others_pct: null });
  const num = (v, props) => input({ type: 'text', inputMode: 'numeric', pattern: '[0-9]*', class: 'input sm', value: v == null ? '' : String(v), ...props });
  function drawRows() {
    rowsWrap.hidden = !rows.length;
    rowsWrap.querySelector('.aside').textContent = plural(rows.length, 'row');
    rowsBox.replaceChildren(...rows.map((r, i) => {
      const q = input({ class: 'input sm', value: r.q ?? '', placeholder: 'Q', maxLength: 12, 'aria-label': 'Question', oninput: e => { r.q = e.target.value; } });
      const res = seg([{ value: 'right', label: '✓', aria: 'Right' }, { value: 'partial', label: '½', aria: 'Partly right' }, { value: 'wrong', label: '✗', aria: 'Wrong' }], r.result, v => { r.result = v; }, 'sm');
      const marks = num(r.marks, { 'aria-label': 'Marks', placeholder: '–', oninput: e => { r.marks = e.target.value === '' ? null : Number(e.target.value); } });
      const out = num(r.out_of, { 'aria-label': 'Out of', placeholder: '–', oninput: e => { r.out_of = e.target.value === '' ? null : Number(e.target.value); } });
      const topic = input({ class: 'input sm topic', value: r.topic ?? '', placeholder: 'Topic', list: 'topic-list', maxLength: 80, 'aria-label': 'Topic',
        oninput: e => { r.topic = e.target.value; const t = topics.find(x => x.name === r.topic); r.section = t ? t.section : r.section; } });
      const rm = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove row ${i + 1}`, onclick: () => { rows.splice(i, 1); drawRows(); } }, icon('close'));
      return h('div', { class: 'rrow' }, q, res, h('div', { class: 'marks' }, marks, h('span', { class: 'foot' }, '/'), out), rm, topic);
    }));
  }
  saveBtn.addEventListener('click', () => busy(saveBtn, async () => {
    if (!subject) { toast('Choose the subject first.'); subjSel.focus(); return; }
    const clean = rows.filter(r => r.q || r.topic || r.marks != null || r.result).map(r => ({
      q: r.q ? String(r.q).trim() : null, result: r.result || null,
      marks: Number.isFinite(r.marks) ? r.marks : null, out_of: Number.isFinite(r.out_of) ? r.out_of : null,
      topic: r.topic ? String(r.topic).trim() : null, section: r.section || null, others_pct: r.others_pct ?? null }));
    if (!clean.length) { toast('Add at least one row.'); return; }
    try {
      const res = await post('/api/p/results', { bank: bank.id, subject_id: subject, day: day.value || todayIso(), ...(label.value.trim() ? { label: label.value.trim() } : {}), how, rows: clean });
      toast(`Saved ${plural(res.saved, 'row')}${res.unplaced ? `. ${res.unplaced} without a topic` : ''}`, { undo: async () => { await post('/api/p/undo', { batch_id: res.batch_id }); toast('Undone'); app.route(); } });
      app.go('#results');
    } catch (e) { toast(e.message); }
  }));

  const modeBox = h('div');
  const drawMode = () => {
    modeBox.replaceChildren(how === 'screenshot' ? shotBox : h('div'));
    if (how === 'typed' && !rows.length) { for (let i = 0; i < 3; i++) rows.push(blank()); drawRows(); }
  };
  const modeSeg = canShot && canType ? seg([{ value: 'screenshot', label: 'Screenshot' }, { value: 'typed', label: 'Type marks' }], how, v => { how = v; drawMode(); }) : null;
  drawMode();

  root.replaceChildren(pageHead(bank.name, { back, kicker: 'Log results' }),
    h('div', { class: 'stack' },
      steps,
      h('div', { class: 'card form', style: 'padding:var(--pad)' },
        field('Subject', subjSel),
        h('div', { class: 'row', style: 'align-items:flex-end' }, h('div', { class: 'grow' }, field('Day', day)), h('div', { class: 'grow' }, field('Label', label, 'optional'))),
        modeSeg ? h('div', null, modeSeg) : null),
      modeBox, rowsWrap, dl,
      app.on('connector') ? h('p', { class: 'foot' }, `Tip: in the Claude app you can ${canShot ? 'share the screenshot and ' : ''}say "log my ${bank.name.toLowerCase()} results". It lands here.`) : null));
  return () => document.removeEventListener('paste', onPaste);
}
