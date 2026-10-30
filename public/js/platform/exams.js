// Exams (#exams): past papers from their own library, sat on screen. Their Claude does the fiddly parts: it adds
// photos (through a one-time upload link) or a PDF from a link to the library, and turns a paper into an exam
// (exam_make). Practice papers: their Claude writes original ones (paper_make), on their own plan, no API key.
// This screen lists both, the papers still waiting to be made into exams, and how to ask.
import { get } from './api.js';
import { h, icon, btn, linkBtn, toast, pageHead, loading, errorState, state, plural, fmtDay, askClaude, sheet, field, select } from './kit.js';
import { addPdfs, addPhotos, watchJobs, jobsNow } from './library.js';

const ASK = [
  ['Add an exam from a photo', 'Add these photos of my exam paper to my Study Hub.', 'Then send the photos in the same chat. Claude gives you a link: tap it and choose the photos.'],
  ['Find an exam online', 'Find the AQA A-level Biology Paper 1 June 2023 question paper and mark scheme and add them to my Study Hub.', 'Change the board, subject, paper and year to the one you want.'],
  ['Make it an exam I can sit', 'Make my exam paper into an exam I can sit on my Study Hub, with the mark scheme.', 'Claude reads the paper and sets up every question with its marks and page.'],
  ['Mark my exam', 'Mark my latest exam on my Study Hub with me.', 'Claude goes through each answer with you and saves the marks.'],
  ['Look at my thinking', 'Analyse my thinking from my Study Hub recordings.', 'After you have pressed Record while answering.'],
];

export function render(root, { app }) {
  root.append(pageHead('Exams'), loading(2));
  let alive = true;
  const load = () => Promise.all([get('/api/p/exams'), get('/api/p/subjects').catch(() => ({ subjects: [] }))]).then(([x, s]) => { if (alive) paint(x, s); })
    .catch(e => { if (alive) root.replaceChildren(pageHead('Exams'), errorState(e, () => app.route())); });
  const jobsBox = h('div', { class: 'stack', 'aria-live': 'polite' });
  const drawJobs = () => {
    const jobs = jobsNow();
    jobsBox.replaceChildren(...jobs.map(j => h('div', { class: 'li' }, h('span', { class: 'ftype' }, icon('note')), h('span', { class: 'grow' }, h('b', null, j.title), h('span', { class: 'sub' }, j.word)))));
  };
  watchJobs(done => { if (!alive) return; drawJobs(); if (done && !jobsNow().length) load(); });
  app.onReturn = () => { if (alive) load(); };

  function paint(x, s) {
    const names = Object.fromEntries((s.subjects || []).map(v => [v.id, v.name]));
    const exams = x.papers.filter(p => p.from_document), practice = x.papers.filter(p => !p.from_document);
    const status = p => (p.status === 'marked' ? h('span', { class: 'score' }, `${p.total ?? 0}/${p.out_of}`)
      : h('span', { class: `status ${p.status === 'marking' ? 'warn' : 'info'}` }, p.status === 'marking' ? 'Marking' : 'To sit'));
    const row = p => h('a', { class: 'li cv', href: `#papers/${encodeURIComponent(p.id)}` },
      h('span', { class: 'ftype' }, icon(p.from_document ? 'exam' : 'sparkle')),
      h('span', { class: 'grow' }, h('b', null, p.title), h('span', { class: 'sub' }, [names[p.subject_id], `${p.out_of} marks`, p.minutes ? `${p.minutes} min` : null, p.made_by === 'claude' ? 'by your Claude' : null,
        p.recordings ? plural(p.recordings, 'recording') : null, fmtDay(p.created_at)].filter(Boolean).join(' · '))),
      status(p), icon('chevron', 'chev'));
    const waiting = x.waiting.length ? h('section', null, h('div', { class: 'section-title' }, 'Waiting to be made into exams'),
      h('div', { class: 'list' }, x.waiting.map(d => h('div', { class: 'li' }, h('span', { class: 'ftype' }, icon('library')),
        h('span', { class: 'grow' }, h('b', null, d.title), h('span', { class: 'sub' }, d.status === 'ready' ? `${d.pages ? plural(d.pages, 'page') : 'Ready'} · in your library` : 'Still being read…')),
        askClaude(`Make "${d.title}" from my Study Hub library into an exam I can sit, with the mark scheme if I have it.`, 'Ask Claude', { app }))))) : null;

    const pick = (accept, multiple, fn) => { const i = h('input', { type: 'file', accept, multiple, hidden: true }); i.addEventListener('change', () => { const f = [...i.files]; i.value = ''; if (f.length) fn(f); }); return i; };
    const photosIn = pick('image/*', true, f => addPhotos(f, null, 'exam-paper'));
    const pdfIn = pick('application/pdf,.pdf', true, f => addPdfs(f, null, 'exam-paper'));
    const addHere = () => sheet({ title: 'Add an exam paper', sub: 'It goes into your library as an exam paper. Then ask your Claude to make it into an exam.',
      body: h('div', { class: 'form' },
        btn('Take or choose photos', () => photosIn.click(), 'primary', 'photo'),
        btn('Choose a PDF', () => pdfIn.click(), 'tinted', 'library'),
        h('p', { class: 'foot' }, 'Photos: one per page, in order, flat and in good light.')) });

    const asks = h('section', null, h('div', { class: 'section-title' }, 'Ask your Claude'),
      h('div', { class: 'list' }, ASK.map(([title, words, hint]) => askClaude(words, [h('span', { class: 'ftype' }, icon('sparkle')),
        h('span', { class: 'grow' }, h('b', null, title), h('span', { class: 'sub' }, `“${words}” ${hint}`)), icon('out', 'chev')], { app, cls: 'li', ico: null }))));

    root.replaceChildren(
      pageHead('Exams', { kicker: 'Past papers and practice papers', how: 'exams' }),
      h('p', { class: 'foot', style: 'margin:-8px 0 14px' }, 'Sit real past papers here, with the paper beside your answers and a clock. Or have your Claude write you a practice paper on your weak topics. Your Claude marks them with you.'),
      h('div', { class: 'row', style: 'margin-bottom:var(--gap)' }, btn('New practice paper', () => practiceSheet(s.subjects || [], app), 'primary', 'sparkle'), btn('Add an exam paper', addHere, 'tinted', 'plus'), photosIn, pdfIn),
      jobsBox,
      h('div', { class: 'section-title' }, 'Past papers'),
      exams.length ? h('div', { class: 'list' }, exams.map(row))
        : state('note', 'No past papers yet', 'Ask your Claude to add one (below), then to make it into an exam.', null, true),
      waiting,
      h('div', { class: 'section-title' }, 'Practice papers'),
      practice.length ? h('div', { class: 'list' }, practice.map(row))
        : state('sparkle', 'No practice papers yet', 'Tap New practice paper: your Claude writes one on the topics you pick, with a mark scheme.', null, true),
      asks);
    drawJobs();
  }
  load();
  return () => { alive = false; watchJobs(() => {}); };
}

// New practice paper: pick a subject, up to 5 topics (or their weakest) and a length; their Claude writes it (paper_make).
export function practiceSheet(subjects, app) {
  if (!subjects.length) { toast('Add a subject first.'); return; }
  let sid = subjects[0].id, n = 6;
  const picked = new Set();
  const chips = h('div', { class: 'chips' });
  const lens = h('div', { class: 'seg', role: 'group', 'aria-label': 'Questions' });
  const ask = h('div');
  const draw = () => {
    const sub = subjects.find(x => x.id === sid) || subjects[0];
    const board = sub.board_name && sub.board_name !== 'Other' ? `${sub.board_name} ` : '';
    const on = picked.size ? `on ${[...picked].join(', ')}` : 'on my weakest topics';
    const words = `Write me a ${n}-question practice paper for my ${board}${sub.name} ${on}, with a mark scheme, and add it to my Study Hub.`;
    ask.replaceChildren(askClaude(words, 'Ask my Claude to write it', { app, cls: 'btn btn-primary' }),
      h('p', { class: 'foot', style: 'margin-top:8px' }, `“${words}”`));
    lens.replaceChildren(...[3, 6, 9, 12].map(k => h('button', { type: 'button', 'aria-pressed': String(k === n), onclick: () => { n = k; draw(); } }, String(k))));
  };
  const loadTopics = () => {
    picked.clear(); chips.replaceChildren(); draw();
    get(`/api/p/subjects/${encodeURIComponent(sid)}`).then(d => {
      const topics = (d.sections || []).flatMap(x => x.topics).slice(0, 60);
      chips.replaceChildren(...topics.map(t => {
        const c = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', onclick: () => {
          if (picked.has(t.name)) picked.delete(t.name); else if (picked.size >= 5) { toast('Up to 5 topics.'); return; } else picked.add(t.name);
          c.setAttribute('aria-pressed', String(picked.has(t.name))); draw();
        } }, h('span', { class: 'nm' }, t.name));
        return c;
      }));
    }).catch(() => {});
  };
  sheet({ title: 'New practice paper', sub: 'Your Claude writes original questions for your course, with a mark scheme, and adds them under Exams. No API key needed.',
    body: h('div', { class: 'form' },
      field('Subject', select(subjects.map(x => ({ value: x.id, label: x.name })), sid, v => { sid = v; loadTopics(); })),
      h('div', { class: 'field' }, h('span', null, 'Topics', h('span', { class: 'hint' }, ' · up to 5, or none for your weakest')), chips),
      h('div', { class: 'field' }, h('span', null, 'Questions'), lens),
      ask,
      app.modules.papers === true ? h('p', { class: 'foot' }, 'Have your own Claude key? ', h('a', { href: '#papers' }, 'Write it in the app instead.')) : null) });
  loadTopics();
}
