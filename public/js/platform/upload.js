// The upload screen (#up/<token>): opened from a link their own Claude made (library_upload_link), so it works in the
// Claude app's browser with no sign-in. It adds photos or PDFs to their library as one kind of document and does
// nothing else; the link ends after an hour or 30 files.
import { get, setUploadToken } from './api.js';
import { h, icon, btn, field, input, state, loading } from './kit.js';
import { addPdfs, addPhotos, watchJobs, jobsNow } from './library.js';

const COLLECTION = { exam_paper: 'exam-paper', mark_scheme: 'mark-scheme', notes: 'notes', other: null };

export function render(root, { param }) {
  setUploadToken(param);
  root.append(loading(1));
  let alive = true, added = 0;
  get(`/api/p/up/${encodeURIComponent(param)}`).then(info => {
    if (!alive) return;
    const collection = COLLECTION[info.kind] ?? null;
    const name = input({ type: 'text', maxLength: 120, value: info.title || '', placeholder: info.kind === 'exam_paper' ? 'e.g. AQA Biology Paper 1 June 2023' : 'A name' });
    const pick = (accept, fn) => { const i = h('input', { type: 'file', accept, multiple: true, hidden: true }); i.addEventListener('change', () => { const f = [...i.files]; i.value = ''; if (f.length) fn(f); }); return i; };
    const photosIn = pick('image/*', f => addPhotos(f, name.value.trim() || null, collection));
    const pdfIn = pick('application/pdf,.pdf', f => addPdfs(f, name.value.trim() || null, collection));
    const jobs = h('div', { class: 'stack', 'aria-live': 'polite' });
    const done = h('div', { class: 'tile', hidden: true },
      h('b', null, 'Added to your Study Hub.'),
      h('p', { class: 'foot' }, info.kind === 'exam_paper' ? 'Go back to Claude and say: "Done, make it into an exam I can sit."' : 'Go back to Claude and say "done".'));
    watchJobs(finished => {
      if (!alive) return;
      const list = jobsNow();
      jobs.replaceChildren(...list.map(j => h('div', { class: 'li' }, h('span', { class: 'ftype' }, icon('note')),
        h('span', { class: 'grow' }, h('b', null, j.title), h('span', { class: 'sub' }, j.word)), h('progress', { max: 1, value: j.f || 0, style: 'width:80px' }))));
      if (finished === true) { added++; if (!list.length) done.hidden = false; }
    });
    root.replaceChildren(h('div', { class: 'upload-screen' },
      h('header', { class: 'head' }, h('div', { class: 'titles' }, h('h1', { class: 't-title1' }, `Add ${info.kind_word}`))),
      h('p', null, `${info.name ? `Hi ${info.name}. ` : ''}This goes straight into your Study Hub library. The link works for ${info.minutes_left} more minutes.`),
      h('div', { class: 'form' },
        field('Name', name),
        btn(info.kind === 'exam_paper' || info.kind === 'mark_scheme' ? 'Take or choose photos of the pages' : 'Take or choose photos', () => photosIn.click(), 'primary', 'photo', { cls: 'btn-lg' }),
        btn('Choose a PDF instead', () => pdfIn.click(), 'tinted', 'library'),
        h('p', { class: 'foot' }, 'Photos: choose all the pages at once, in order (they become one document). Flat, in good light, the whole page in view.'),
        photosIn, pdfIn),
      jobs, done));
  }).catch(e => {
    if (!alive) return;
    root.replaceChildren(state('warn', 'This link has run out', e.status === 404 ? 'Upload links work for an hour. Ask your Claude for a new one.' : e.message, null, true));
  });
  return () => { alive = false; watchJobs(() => {}); setUploadToken(null); };
}
