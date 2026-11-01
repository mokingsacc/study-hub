// Pictures on a topic (WP3b), in the topic sheet: photos they add (made smaller on the device first) and pages of
// their own library PDFs, drawn by pdf.js and cropped when a box was kept. Tap one to see it large, with its caption,
// Remove (Undo in the toast) and, for a page, Open in Library. Their Claude can pin pages too (topic_picture).
import { h, icon, btn, sheet, toast, busy, field, input, select, askClaude } from './kit.js';
import { get, post, put, patch, del } from './api.js';

const enc = encodeURIComponent;
const MAX_SIDE = 2000;

// A photo, at most 2000 px on its longest side, as a JPEG (a phone photo is often 4 to 12 MB).
async function shrink(file, side = MAX_SIDE) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
  const c = h('canvas', { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('That photo could not be read.'))), 'image/jpeg', 0.85));
}

function art(p, width) {
  if (p.kind === 'photo') return h('img', { class: 'pic-img', src: p.url, alt: p.caption || 'Your photo', loading: 'lazy', decoding: 'async' });
  const box = h('div', { class: 'pic-img pic-wait' }, icon('file'));
  import('./pdfpane.js').then(m => m.drawPage(p, width)).then(c => { c.classList.add('pic-img'); box.replaceWith(c); }).catch(() => box.replaceChildren(h('span', { class: 'foot' }, `Page ${p.page} could not be drawn`)));
  return box;
}

function coverLayer(p) {
  let covers = (p.covers || []).slice(), mode = covers.length ? 'test' : 'view', shown = new Set();
  const layer = h('div', { class: 'pic-covers' });
  const draw = () => layer.replaceChildren(...covers.map((c, i) => {
    const b = h('button', { type: 'button', class: `pic-cover${shown.has(i) || mode === 'view' ? ' open' : ''}${mode === 'edit' ? ' edit' : ''}`, 'aria-label': mode === 'edit' ? 'Remove this box' : `Show label ${i + 1}` });
    Object.assign(b.style, { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` });
    b.onclick = e => { e.stopPropagation(); if (mode === 'edit') { covers.splice(i, 1); save(); } else if (mode === 'test') { shown.add(i); draw(); } };
    return b;
  }));
  const save = () => { draw(); patch(`/api/p/pictures/${enc(p.id)}`, { covers }).then(r => { p.covers = r.picture.covers; }).catch(e => toast(e.message)); };
  let start = null;
  const at = e => { const r = layer.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
  layer.addEventListener('pointerdown', e => { if (mode !== 'edit' || e.target !== layer) return; start = at(e); layer.setPointerCapture(e.pointerId); });
  layer.addEventListener('pointerup', e => {
    if (!start) return;
    const end = at(e), box = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
    start = null;
    if (box.w > 0.01 && box.h > 0.01 && covers.length < 30) { covers.push(box); save(); }
  });
  const setMode = m => { mode = m; shown = new Set(); layer.classList.toggle('editing', m === 'edit'); draw(); bar.replaceChildren(...buttons()); };
  const buttons = () => [
    btn(mode === 'edit' ? 'Done' : 'Edit boxes', () => setMode(mode === 'edit' ? (covers.length ? 'test' : 'view') : 'edit'), 'gray', 'pencil', { cls: 'btn-sm' }),
    covers.length && mode !== 'edit' ? btn(mode === 'test' ? 'Hide all again' : 'Test me', () => setMode('test'), 'tinted', 'eye', { cls: 'btn-sm' }) : null,
    covers.length && mode === 'test' ? btn('Show all', () => setMode('view'), 'gray', null, { cls: 'btn-sm' }) : null,
    h('span', { class: 'foot' }, mode === 'edit' ? 'Drag over each label to cover it. Tap a box to remove it.' : covers.length ? (mode === 'test' ? 'Say each label, then tap to check.' : '') : 'Cover the labels, then test yourself.'),
  ].filter(Boolean);
  const bar = h('div', { class: 'row pic-bar' }, ...buttons());
  draw();
  return { layer, bar };
}

function lightbox(p, onChange, list = [p]) {
  const cv = coverLayer(p);
  const i = Math.max(0, list.findIndex(x => x.id === p.id));
  const go = d => { const q = list[(i + d + list.length) % list.length]; if (!q || q.id === p.id) return; s.close(); lightbox(q, onChange, list); };
  const onKey = e => { if (!s.el.isConnected) { document.removeEventListener('keydown', onKey); return; } if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); };
  if (list.length > 1) document.addEventListener('keydown', onKey);
  // Tap the picture to zoom in (and pan, on a phone or iPad); tap again to fit.
  const big = h('div', { class: 'pic-big' }, h('div', { class: 'pic-frame' }, art(p, 1400), cv.layer));
  big.addEventListener('click', e => { if (e.target.closest('.pic-cover') || cv.layer.classList.contains('editing')) return; big.classList.toggle('zoomed'); });
  const s = sheet({ title: p.caption || (p.kind === 'photo' ? 'Your photo' : `${p.doc_title || 'Your notes'}, page ${p.page}`), wide: true,
    body: h('div', null, cv.bar, big),
    actions: [
      p.kind === 'page' ? h('a', { class: 'btn btn-gray', href: '#library', onclick: () => s.close() }, icon('library'), 'Library') : null,
      list.length > 1 && i > 0 ? btn('Show first', async () => { try { await patch(`/api/p/pictures/${enc(p.id)}`, { first: true }); s.close(); onChange(); toast('Shown first'); } catch (e) { toast(e.message); } }, 'gray', null) : null,
      btn('Caption', () => captionSheet(p, () => { s.close(); onChange(); }), 'gray', 'pencil'),
      btn('Remove', async () => {
        try {
          const r = await del(`/api/p/pictures/${enc(p.id)}`);
          s.close(); onChange();
          toast('Picture removed', { undo: async () => { await post('/api/p/undo', { batch_id: r.batch_id }); onChange(); } });
        } catch (e) { toast(e.message); }
      }, 'gray', 'trash')].filter(Boolean) });
  s.el.classList.add('pic-sheet');
}

function captionSheet(p, done) {
  const i = input({ value: p.caption || '', maxLength: 120, placeholder: 'e.g. The cardiac cycle, labelled' });
  const save = btn('Save', null, 'primary');
  const s = sheet({ title: 'Caption', body: field('Caption', i), actions: [btn('Cancel', () => s.close(), 'gray'), save] });
  save.addEventListener('click', () => busy(save, async () => { try { await patch(`/api/p/pictures/${enc(p.id)}`, { caption: i.value }); s.close(); done(); } catch (e) { toast(e.message); } }));
}

// A page of one of their PDFs: pick the document and the page (Claude can crop to just the diagram).
function fromLibrarySheet(t, done) {
  const body = h('div', { class: 'form' }, h('p', { class: 'foot' }, 'Loading your library…'));
  const add = btn('Add page', null, 'primary');
  const s = sheet({ title: 'A page from your library', sub: 'Pick the document and the page with the diagram. Your Claude can do this too, and crop to just the diagram.', body,
    actions: [btn('Cancel', () => s.close(), 'gray'), add] });
  get('/api/p/library').then(r => {
    const list = (r.docs || []).filter(d => d.page_count && !['refused', 'failed'].includes(d.status));
    if (!list.length) { body.replaceChildren(h('p', { class: 'foot' }, 'No PDFs in your library yet. Add your notes in Library first.')); add.disabled = true; return; }
    const doc = select(list.map(d => ({ value: d.id, label: d.title })), list[0].id);
    const page = input({ type: 'number', min: 1, value: 1, inputMode: 'numeric', 'aria-label': 'Page' });
    body.replaceChildren(field('Document', doc), field('Page', page));
    add.addEventListener('click', () => busy(add, async () => {
      try { await post('/api/p/pictures', { topic: t.id, doc_id: doc.value, page: Number(page.value) }); s.close(); done(); toast('Page added'); } catch (e) { toast(e.message); }
    }));
  }).catch(e => body.replaceChildren(h('p', { class: 'foot' }, e.message)));
}

/** The Pictures part of a topic sheet. t: {id, name}. */
export function picturesPart(t, app) {
  const grid = h('div', { class: 'pic-grid' });
  const count = h('span', { class: 'foot' });
  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const addPhoto = btn('Add a photo', () => file.click(), 'tinted', 'photo', { cls: 'btn-sm' });
  const addFiles = files => busy(addPhoto, async () => {
    let n = 0;
    for (const f of files) {
      try { await put(`/api/p/pictures?topic=${enc(t.id)}`, await shrink(f), { raw: true }); n++; } catch (e) { toast(e.message || 'That photo could not be added.'); break; }
    }
    if (n) { toast(n === 1 ? 'Photo added' : `${n} photos added`); load(); }
  });
  file.addEventListener('change', () => { const fs = [...(file.files || [])]; file.value = ''; if (fs.length) addFiles(fs); });
  const onPaste = e => {
    if (!part.isConnected) { document.removeEventListener('paste', onPaste); return; }
    if (/INPUT|TEXTAREA/.test((document.activeElement || {}).tagName || '') || document.querySelector('.pic-sheet')) return;
    const fs = [...((e.clipboardData && e.clipboardData.files) || [])].filter(f => /^image\//.test(f.type));
    if (fs.length) { e.preventDefault(); addFiles(fs); }
  };
  document.addEventListener('paste', onPaste);
  const libOn = !app || !app.on || app.on('library');
  const load = () => get(`/api/p/topics/${enc(t.id)}/pictures`).then(r => {
    count.textContent = r.pictures.length ? `${r.pictures.length} of ${r.max}` : '';
    addPhoto.disabled = r.pictures.length >= r.max;
    grid.replaceChildren(...(r.pictures.length ? r.pictures.map(p => h('button', { type: 'button', class: 'pic-tile', 'aria-label': p.caption || (p.kind === 'photo' ? 'Photo' : `Page ${p.page}`), onclick: () => lightbox(p, load, r.pictures) },
      art(p, 220), p.caption ? h('span', { class: 'pic-cap' }, p.caption) : null))
      : [h('p', { class: 'foot' }, 'Diagrams help. Add a photo of one, or a page from your notes.')]));
  }).catch(() => grid.replaceChildren(h('p', { class: 'foot' }, 'Pictures could not load.')));
  load();
  const part = h('section', { class: 'tp-pics' },
    h('div', { class: 'spread' }, h('div', { class: 't-micro' }, 'Pictures'), count),
    grid,
    h('div', { class: 'row-acts' }, addPhoto, file, libOn ? btn('From my library', () => fromLibrarySheet(t, load), 'gray', 'library', { cls: 'btn-sm' }) : null),
    h('p', { class: 'foot' }, 'Tip: paste a photo anywhere here to add it.'));
  return part;
}

export function photoInboxSheet(app) {
  const grid = h('div', { class: 'pic-grid' });
  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const add = btn('Add photos', () => file.click(), 'tinted', 'photo');
  const load = () => get('/api/p/photo-inbox').then(r => grid.replaceChildren(...(r.photos.length ? r.photos.map(ph => h('div', { class: 'pic-tile' },
    h('img', { class: 'pic-img', src: ph.thumb, alt: 'A photo waiting to be filed', loading: 'lazy' }),
    h('button', { type: 'button', class: 'linkish foot', onclick: async () => { try { const x = await del(`/api/p/photo-inbox/${enc(ph.id)}`); load(); toast('Taken out', { undo: async () => { await post('/api/p/undo', { batch_id: x.batch_id }); load(); } }); } catch (e) { toast(e.message); } } }, 'Take out')))
    : [h('p', { class: 'foot' }, 'Nothing waiting. Add photos of notes, diagrams or worksheets.')]))).catch(e => grid.replaceChildren(h('p', { class: 'foot' }, e.message)));
  const send = files => busy(add, async () => {
    let n = 0;
    for (const f of files) {
      try {
        const fd = new FormData();
        fd.append('file', await shrink(f), 'photo.jpg');
        fd.append('thumb', await shrink(f, 800), 'thumb.jpg');
        fd.append('source', 'file');
        await post('/api/p/photo-inbox', fd);
        n++;
      } catch (e) { toast(e.message || 'That photo could not be added.'); break; }
    }
    if (n) { toast(n === 1 ? 'Photo added' : `${n} photos added`); load(); }
  });
  file.addEventListener('change', () => { const fs = [...(file.files || [])]; file.value = ''; if (fs.length) send(fs); });
  const onPaste = e => { if (!s.el.isConnected) { document.removeEventListener('paste', onPaste); return; } const fs = [...((e.clipboardData && e.clipboardData.files) || [])].filter(f => /^image\//.test(f.type)); if (fs.length) { e.preventDefault(); send(fs); } };
  document.addEventListener('paste', onPaste);
  const s = sheet({ title: 'Photo inbox', sub: 'Photos with no topic yet. Add them here, then ask your Claude to file them: it looks at each one and puts it on the right topic.', wide: true,
    body: h('div', { class: 'form' }, h('div', { class: 'row' }, add, file), grid),
    actions: [btn('Close', () => s.close(), 'gray'), askClaude('File the photos in my Study Hub photo inbox', 'File them with my Claude', { app })] });
  load();
  return s;
}
