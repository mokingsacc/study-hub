// Pictures on a topic (WP3b), in the topic sheet: photos they add (made smaller on the device first) and pages of
// their own library PDFs, drawn by pdf.js and cropped when a box was kept. Tap one to see it large, with its caption,
// Remove (Undo in the toast) and, for a page, Open in Library. Their Claude can pin pages too (topic_picture).
import { h, icon, btn, sheet, toast, busy, field, input, select } from './kit.js';
import { get, post, put, patch, del } from './api.js';

const enc = encodeURIComponent;
const MAX_SIDE = 2000;

// A photo, at most 2000 px on its longest side, as a JPEG (a phone photo is often 4 to 12 MB).
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
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

function lightbox(p, onChange) {
  const s = sheet({ title: p.caption || (p.kind === 'photo' ? 'Your photo' : `${p.doc_title || 'Your notes'}, page ${p.page}`), wide: true,
    body: h('div', { class: 'pic-big' }, art(p, 900)),
    actions: [
      p.kind === 'page' ? h('a', { class: 'btn btn-gray', href: '#library', onclick: () => s.close() }, icon('library'), 'Library') : null,
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
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const addPhoto = btn('Add a photo', () => file.click(), 'tinted', 'photo', { cls: 'btn-sm' });
  file.addEventListener('change', () => busy(addPhoto, async () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    try { await put(`/api/p/pictures?topic=${enc(t.id)}`, await shrink(f), { raw: true }); toast('Photo added'); load(); } catch (e) { toast(e.message || 'That photo could not be added.'); }
  }));
  const libOn = !app || !app.on || app.on('library');
  const load = () => get(`/api/p/topics/${enc(t.id)}/pictures`).then(r => {
    count.textContent = r.pictures.length ? `${r.pictures.length} of ${r.max}` : '';
    addPhoto.disabled = r.pictures.length >= r.max;
    grid.replaceChildren(...(r.pictures.length ? r.pictures.map(p => h('button', { type: 'button', class: 'pic-tile', 'aria-label': p.caption || (p.kind === 'photo' ? 'Photo' : `Page ${p.page}`), onclick: () => lightbox(p, load) },
      art(p, 220), p.caption ? h('span', { class: 'pic-cap' }, p.caption) : null))
      : [h('p', { class: 'foot' }, 'Diagrams help. Add a photo of one, or a page from your notes.')]));
  }).catch(() => grid.replaceChildren(h('p', { class: 'foot' }, 'Pictures could not load.')));
  load();
  return h('section', { class: 'tp-pics' },
    h('div', { class: 'spread' }, h('div', { class: 't-micro' }, 'Pictures'), count),
    grid,
    h('div', { class: 'row-acts' }, addPhoto, file, libOn ? btn('From my library', () => fromLibrarySheet(t, load), 'gray', 'library', { cls: 'btn-sm' }) : null));
}
