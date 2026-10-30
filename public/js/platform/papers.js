// Practice papers (#papers, #papers/<id>): module `papers`, on the person's own Claude key.
//   list     make a paper (subject, topics, length; a live timer while it is written) and see your papers
//   answer   text boxes that save as you go, a photo of handwritten working (read into the box, never kept),
//            a confidence tap on every answered question
//   mark     the mark scheme appears; tick the points you earned, or tap "Mark this for me" (your Claude key)
//   results  marks, the mark scheme, how sure you were against how it went, the three-question exam wrapper,
//            card drafts from lost marks (shown before anything is saved)
// Exams (exams.js on the server) use the same screens: a past paper from their library made into an exam by their
// Claude shows the PDF itself beside the answers, a timer from the paper's time allowed, and whole-mark marking where
// there is no mark scheme. On every paper a Record button keeps their spoken thinking (as words) for their Claude.
// Vanilla JS, text only through textContent (h()), 44 pt targets.
import { get, post, put, del } from './api.js';
import { h, icon, btn, linkBtn, toast, field, select, pageHead, loading, errorState, state, busy, confirmSheet, plural, fmtDay, askClaude as ask } from './kit.js';
import { recordButton } from './record.js';

const CONF = [['sure', 'Sure'], ['think_so', 'Think so'], ['guess', 'Guess']];
const CONF_WORD = Object.fromEntries(CONF);
const REASONS = [['knowledge_gap', "Didn't know it"], ['misread', 'Misread the question'], ['calculation', 'Calculation or unit slip'],
  ['test_taking', 'Exam technique'], ['faulty_synthesis', "Knew it, couldn't apply it"]];
const REASON_WORD = Object.fromEntries(REASONS);
const WRAPPER = [['went_well', 'What went well?'], ['marks_lost', 'Where did the marks go?'], ['next_time', 'What will you change next time?']];
const NO_CARD = ['misread', 'test_taking'];
const MAX_PHOTOS = 3, MAX_SIDE = 1400;

export function render(root, ctx) {
  return ctx.param ? renderOne(root, ctx) : renderList(root, ctx);
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const tapStyle = 'min-height:var(--tap);';

// ------------------------------------------------------------------ list and make a paper

function renderList(root, { app }) {
  root.append(pageHead('Practice papers'), loading(2));
  let timer = 0;
  appRef = app;
  Promise.all([get('/api/p/papers'), get('/api/p/subjects'), get('/api/p/ai').catch(() => ({ keys: [] }))]).then(([p, s, ai]) => {
    const hasKey = (ai.keys || []).some(k => k.provider === 'anthropic' && !['invalid', 'no_credit'].includes(k.status));
    const names = Object.fromEntries(s.subjects.map(x => [x.id, x.name]));
    let subject = s.subjects[0] ? s.subjects[0].id : '', n = 6, weakest = false;
    const picked = new Set();
    const topicBox = h('div', { class: 'chips' });
    const loadTopics = id => {
      picked.clear(); topicBox.replaceChildren();
      if (!id) return;
      get(`/api/p/subjects/${encodeURIComponent(id)}`).then(d => {
        if (subject !== id) return;
        const topics = d.sections.flatMap(sec => sec.topics).slice(0, 60);
        topicBox.replaceChildren(...topics.map(t => {
          const c = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', style: tapStyle, onclick: () => {
            if (picked.has(t.id)) picked.delete(t.id);
            else if (picked.size >= 5) { toast('Up to 5 topics.'); return; } else picked.add(t.id);
            c.setAttribute('aria-pressed', String(picked.has(t.id)));
          } }, h('span', { class: 'nm' }, t.name));
          return c;
        }));
      }).catch(() => {});
    };
    loadTopics(subject);
    const weakChip = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', style: tapStyle, onclick: () => {
      weakest = !weakest; weakChip.setAttribute('aria-pressed', String(weakest));
    } }, icon('flag'), h('span', { class: 'nm' }, 'My weakest topics'));

    const lengths = h('div', { class: 'seg', role: 'group' });
    const drawLen = () => lengths.replaceChildren(...[3, 6, 9, 12].map(x => h('button', { type: 'button', 'aria-pressed': String(x === n), style: tapStyle, onclick: () => { n = x; drawLen(); } }, String(x))));
    drawLen();

    const make = btn('Write my paper', null, 'primary', 'sparkle', { cls: 'btn-lg' });
    const note = h('p', { class: 'foot', 'aria-live': 'polite' }, 'Claude writes original questions for your board on your own Claude key, then checks its own sums. It usually takes under a minute.');
    make.addEventListener('click', () => busy(make, async () => {
      if (!subject) { toast('Add a subject first.'); return; }
      const t0 = Date.now();
      const stage = s => (s < 6 ? 'Choosing questions for your board' : s < 40 ? 'Writing the questions and the mark scheme' : 'Checking the sums');
      const tick = () => { const sec = Math.round((Date.now() - t0) / 1000); note.textContent = `${stage(sec)}… ${sec}s. Keep this page open.`; };
      make.textContent = 'Writing your paper…'; tick(); timer = setInterval(tick, 1000);
      try {
        const body = { subject_id: subject, questions: n };
        if (picked.size) body.topic_ids = [...picked]; else if (weakest) body.weakest = true;
        const r = await post('/api/p/papers', body);
        const bad = r.check && r.check.doubtful && r.check.doubtful.length;
        if (bad) toast(`${plural(bad, 'question')} flagged: check with your teacher.`);
        app.go(`#papers/${encodeURIComponent(r.paper.id)}`);
      } catch (e) {
        toast(e.message);
        note.textContent = e.message;
      } finally { clearInterval(timer); make.textContent = 'Write my paper'; }
    }));
    const maker = h('section', { class: 'card form', style: 'padding:var(--pad)' },
      h('div', { class: 't-head' }, 'New paper'),
      field('Subject', select(s.subjects.map(x => ({ value: x.id, label: x.name })), subject, v => { subject = v; loadTopics(v); })),
      h('div', { class: 'field' }, h('span', null, 'Topics', h('span', { class: 'hint' }, ' · optional, up to 5')), h('div', { class: 'chips' }, weakChip), topicBox),
      h('div', { class: 'field' }, h('span', null, 'Questions'), lengths),
      make, note);
    const status = x => (x.status === 'marked' ? h('span', { class: 'score' }, `${x.total ?? 0}/${x.out_of}`)
      : h('span', { class: `status ${x.status === 'marking' ? 'warn' : 'info'}` }, x.status === 'marking' ? 'Marking' : 'To do'));
    const list = p.papers.length
      ? h('div', { class: 'list' }, p.papers.map(x => h('a', { class: 'li cv', href: `#papers/${encodeURIComponent(x.id)}` },
        h('span', { class: 'ftype' }, icon('note')),
        h('span', { class: 'grow' }, h('b', null, x.title || 'Practice paper'), h('span', { class: 'sub' }, [names[x.subject_id], plural(x.questions, 'question'), fmtDay(x.created_at)].filter(Boolean).join(' · '))),
        status(x), icon('chevron', 'chev'))))
      : state('note', 'No papers yet', 'Make your first one above.', null, true);
    const noKey = h('section', { class: 'card form', style: 'padding:var(--pad)' },
      h('div', { class: 't-head' }, 'New paper'),
      h('p', { class: 'foot' }, 'Your own Claude key writes papers here. No key? Your Claude can write one for you, on your plan.'),
      btn('Ask my Claude to write one', () => import('./exams.js').then(m => m.practiceSheet(s.subjects, app)), 'primary', 'sparkle'));
    root.replaceChildren(pageHead('Practice papers', { kicker: hasKey ? 'On your Claude key' : 'Written by your Claude', how: 'exams' }), hasKey ? maker : noKey, h('div', { class: 'section-title' }, 'Your papers'), list);
  }).catch(e => root.replaceChildren(pageHead('Practice papers'), errorState(e, () => app.route())));
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------ one paper

function renderOne(root, { app, param }) {
  const back = app.on('exams') ? { href: '#exams', label: 'Exams' } : { href: '#papers', label: 'Papers' };
  const S = { app, root, back, timers: new Set(), flushers: new Set(), closers: new Set(), ownKey: false };
  root.append(pageHead(' ', { back }), loading(2));
  appRef = app;
  // Back from the Claude app (it may have saved answers or marks): show the paper again if its stage moved on.
  app.onReturn = () => { for (const f of S.flushers) f(); get(`/api/p/papers/${encodeURIComponent(param)}`).then(({ paper }) => { if (!S.paper || paper.status !== S.paper.status || JSON.stringify(paper.marking || {}) !== JSON.stringify(S.paper.marking || {})) show(S, paper); }).catch(() => {}); };
  get(`/api/p/papers/${encodeURIComponent(param)}`).then(({ paper, own_key }) => { S.ownKey = !!own_key; show(S, paper); })
    .catch(e => root.replaceChildren(pageHead('Paper', { back }), errorState(e, () => app.route())));
  return () => { for (const f of S.flushers) f(); for (const t of S.timers) clearTimeout(t); closeAll(S); };
}
const closeAll = S => { for (const c of S.closers) try { c(); } catch { /* gone */ } S.closers.clear(); };

// ------------------------------------------------------------------ exam pieces: the PDF, the timer, recordings
const isExam = paper => !!(paper.source && paper.source.doc_id);
const labelOf = q => q.label || String(q.n);

async function examPdf(S, paper) {
  const { pdfPane } = await import('./pdfpane.js');
  const pane = pdfPane(paper.source.doc_id);
  S.closers.add(() => pane.close());
  return pane;
}

// The time allowed, counted down from when they press Start (kept on this device, so a reload keeps the time).
function examTimer(S, paper) {
  const key = `sh-exam-start:${paper.id}`;
  const read = () => { try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; } };
  const out = h('span', { class: 'num exam-clock', 'aria-live': 'off' });
  const startBtn = btn('Start the clock', null, 'tinted', 'play', { cls: 'btn-sm' });
  const box = h('div', { class: 'exam-timer' }, startBtn, out);
  const total = (paper.minutes || 0) * 60;
  let t = 0;
  const paint = () => {
    const at = read();
    startBtn.hidden = !!at;
    out.hidden = !at;
    if (!at) return;
    const used = Math.floor((Date.now() - at) / 1000);
    if (!total) { out.textContent = `${Math.floor(used / 60)} min`; return; }
    const left = total - used;
    out.textContent = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : 'Time is up';
    out.classList.toggle('late', left <= 0);
  };
  startBtn.addEventListener('click', () => { try { localStorage.setItem(key, String(Date.now())); } catch { /* private mode */ } paint(); });
  paint();
  t = setInterval(paint, 1000);
  S.closers.add(() => clearInterval(t));
  return box;
}

function thinkingFor(paper, n) {
  const list = (paper.thinking || []).filter(t => (t.n ?? null) === n);
  const note = (paper.thinking_notes || {})[n == null ? 'all' : String(n)];
  if (!list.length && !note) return null;
  return h('details', { class: 'thinking' },
    h('summary', null, list.length ? `Your thinking (${plural(list.length, 'recording')})` : 'Claude on your thinking'),
    note ? h('p', { class: 'thinking-note' }, h('b', null, 'Claude: '), note.text) : null,
    list.map(t => h('p', { class: 'foot' }, `${fmtDay(t.at)} · ${Math.max(1, Math.round(t.secs / 60))} min: “${t.text}”`)));
}

let appRef = null;   // for the Ask my Claude links (they offer to connect first when their Claude never has)
const askClaude = (words, label = 'Ask my Claude') => ask(words, label, { app: appRef });

// Calls fn a moment after the last change; flush() runs it at once (on leaving the page or before a big step).
function debounced(S, fn, ms = 600) {
  let t = 0, dirty = false;
  const run = () => { clearTimeout(t); S.timers.delete(t); if (!dirty) return Promise.resolve(); dirty = false; return fn().catch(e => { dirty = true; toast(e.message); }); };
  const flusher = () => run();
  S.flushers.add(flusher);
  const call = () => { dirty = true; clearTimeout(t); t = setTimeout(run, ms); S.timers.add(t); };
  call.flush = flusher;
  return call;
}

function show(S, paper) {
  S.paper = paper;
  S.flushers.clear();
  closeAll(S);
  window.scrollTo(0, 0);
  if (paper.status === 'marked') paintResults(S, paper);
  else if (paper.status === 'marking') paintMarking(S, paper);
  else paintAnswer(S, paper);
}

const confBadge = c => (c ? h('span', { class: 'status info' }, CONF_WORD[c]) : null);
const doubtful = q => (q.doubtful ? h('p', { class: 'foot', style: 'color:var(--warn)' }, icon('warn'), ' ', q.note) : null);
const qHead = (q, right) => h('div', { class: 'spread' }, h('b', { class: 't-head' }, `Question ${labelOf(q)}`), h('span', { class: 'row', style: 'gap:8px' }, q.topic ? h('span', { class: 'foot' }, q.topic) : null, right || h('span', { class: 'foot' }, plural(q.marks, 'mark'))));

async function removePaper(S) {
  if (!(await confirmSheet({ title: 'Delete this paper?', sub: 'Marks already saved to your map stay there.', ok: 'Delete', danger: true }))) return;
  try { await del(`/api/p/papers/${encodeURIComponent(S.paper.id)}`); toast('Paper deleted'); S.app.go('#papers'); } catch (e) { toast(e.message); }
}
const deleteBtn = S => btn('Delete paper', () => removePaper(S), 'danger', 'trash');

// ------------------------------------------------------------------ answer screen

async function downscale(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('That picture could not be opened.')); i.src = url; });
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } finally { URL.revokeObjectURL(url); }
}

function confRow(value, onpick) {
  const box = h('div', { class: 'seg', role: 'group', 'aria-label': 'How sure are you?', style: 'width:100%' });
  const draw = v => box.replaceChildren(...CONF.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(v === id), style: tapStyle, onclick: () => { draw(id); onpick(id); } }, label)));
  draw(value);
  return box;
}

function paintAnswer(S, paper) {
  const { app, root, back } = S;
  const exam = isExam(paper);
  const state_ = Object.fromEntries(paper.questions.map(q => [q.n, { answer: q.answer || '', confidence: q.confidence || null }]));
  const dirty = new Set();
  const save = debounced(S, async () => {
    const list = [...dirty].map(n => ({ n, answer: state_[n].answer, confidence: state_[n].confidence }));
    dirty.clear();
    if (list.length) await put(`/api/p/papers/${encodeURIComponent(paper.id)}/answers`, { answers: list });
  });
  const touched = n => { dirty.add(n); save(); progress(); };
  const progressEl = h('p', { class: 'foot', 'aria-live': 'polite' });
  const progress = () => {
    const answered = paper.questions.filter(q => state_[q.n].answer.trim()).length;
    const sure = paper.questions.filter(q => state_[q.n].answer.trim() && state_[q.n].confidence).length;
    progressEl.textContent = `${answered} of ${paper.questions.length} answered · confidence tapped on ${sure} of ${answered}`;
  };
  // The question they are on (the last answer box they touched): what Record is about.
  let current = null;
  const nowOn = h('span', { class: 'foot' });
  const setCurrent = q => { current = q; nowOn.textContent = q ? `On question ${labelOf(q)}` : ''; };
  let pane = null;
  const cards = paper.questions.map(q => {
    const box = h('textarea', { class: 'input', rows: exam ? 3 : 4, maxLength: 4000, placeholder: exam ? 'Your answer' : 'Your answer. Show your working.', 'aria-label': `Answer to question ${labelOf(q)}`, value: state_[q.n].answer });
    box.addEventListener('input', () => { state_[q.n].answer = box.value; touched(q.n); });
    box.addEventListener('focus', () => setCurrent(q));
    let photoRow = null;
    if (S.ownKey) {
      const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
      const photoBtn = btn('Photo of my working', () => fileIn.click(), 'tinted', 'photo', { cls: 'btn-sm' });
      const photoNote = h('span', { class: 'foot', 'aria-live': 'polite' }, 'Pencil or paper: it is read into the box, then thrown away.');
      fileIn.addEventListener('change', () => busy(photoBtn, async () => {
        const files = [...fileIn.files].filter(f => /^image\//.test(f.type)).slice(0, MAX_PHOTOS);
        fileIn.value = '';
        if (!files.length) return;
        photoNote.textContent = 'Reading your working…';
        try {
          const images = [];
          for (const f of files) images.push(await downscale(f));
          const r = await post(`/api/p/papers/${encodeURIComponent(paper.id)}/working`, { n: q.n, images });
          if (r.text) {
            box.value = (box.value.trim() ? box.value.trim() + '\n' : '') + r.text;
            state_[q.n].answer = box.value; touched(q.n);
            photoNote.textContent = 'Added to your answer. Check it reads right.';
          } else photoNote.textContent = r.message || 'Nothing could be read. Try a clearer photo.';
        } catch (e) { photoNote.textContent = e.message; toast(e.message); }
      }));
      photoRow = h('div', { class: 'row' }, photoBtn, fileIn, photoNote);
    } else {
      photoRow = h('div', { class: 'row' }, askClaude(`I'm sending a photo of my working for question ${labelOf(q)} of "${paper.title || 'my paper'}" in my Study Hub. Read it exactly as written, mistakes included, and save it as my answer.`, 'Send a photo to my Claude'),
        h('span', { class: 'foot' }, 'Working on paper? Send your Claude a photo; it saves it here as your answer.'));
    }
    const pageBtn = exam && q.page ? h('button', { type: 'button', class: 'btn btn-plain btn-sm', onclick: () => { setCurrent(q); if (pane) pane.goTo(q.page); } }, `Page ${q.page}`) : null;
    return h('section', { class: 'card', style: 'padding:var(--pad);display:grid;gap:12px', dataset: { q: String(q.n) } },
      qHead(q, h('span', { class: 'row', style: 'gap:6px' }, pageBtn, h('span', { class: 'foot' }, plural(q.marks, 'mark')))), doubtful(q),
      exam ? (q.text && q.text !== `Question ${labelOf(q)}` ? h('p', { class: 'foot' }, q.text) : null) : h('p', { style: 'white-space:pre-wrap' }, q.text),
      box,
      photoRow,
      h('div', null, h('div', { class: 't-micro', style: 'margin-bottom:6px' }, 'How sure are you?'),
        confRow(state_[q.n].confidence, c => { state_[q.n].confidence = c; touched(q.n); })),
      thinkingFor(paper, q.n));
  });
  progress();
  const go = btn('I am done: mark it', null, 'primary', 'check', { cls: 'btn-lg' });
  go.addEventListener('click', () => busy(go, async () => {
    const answered = paper.questions.filter(q => state_[q.n].answer.trim());
    if (!answered.length) { toast('Write at least one answer first.'); return; }
    const missing = answered.find(q => !state_[q.n].confidence);
    if (missing) { toast(`Tap how sure you were on question ${labelOf(missing)} first.`); cards[missing.n - 1].scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    go.textContent = 'Opening the marking…';
    try {
      const answers = paper.questions.map(q => ({ n: q.n, answer: state_[q.n].answer.trim(), confidence: state_[q.n].confidence }));
      dirty.clear();
      const r = await post(`/api/p/papers/${encodeURIComponent(paper.id)}/start-marking`, { answers });
      show(S, r.paper);
    } catch (e) { toast(e.message); go.textContent = 'I am done: mark it'; }
  }));
  const rec = recordButton({ paperId: paper.id, question: () => (current ? { n: current.n, label: labelOf(current) } : null),
    onSaved: r => { paper.thinking = [...(paper.thinking || []), r]; } });
  S.closers.add(() => rec.stop());
  const bar = h('div', { class: 'exam-bar' }, exam ? examTimer(S, paper) : null, rec, nowOn);
  const how = exam
    ? 'The paper is on the left (above on a phone). Write each answer in its box; it saves as you go. Tap how sure you were, then press Mark it at the end. Press Record any time to say your thinking out loud.'
    : 'Answer first, tap how sure you were, then open the mark scheme. Your answers save as you go. Press Record to say your thinking out loud.';
  const answers = h('div', { class: exam ? 'exam-answers' : 'stack' }, cards, progressEl,
    h('div', { class: 'row', style: 'margin-top:12px;justify-content:space-between' }, deleteBtn(S), go));
  const kicker = `${plural(paper.questions.length, 'question')} · ${paper.out_of} marks${paper.minutes ? ` · ${paper.minutes} min` : ''}`;
  const body = exam ? h('div', { class: 'exam-split' }, h('div', { class: 'exam-pdf-slot' }), answers) : answers;
  root.replaceChildren(pageHead(paper.title || 'Practice paper', { back, kicker }),
    h('p', { class: 'foot', style: 'margin:-8px 0 12px' }, how), bar, body);
  if (exam) examPdf(S, paper).then(p => { pane = p; const slot = body.querySelector('.exam-pdf-slot'); if (slot) slot.replaceWith(p.el); else p.close(); }).catch(() => {});
}

// ------------------------------------------------------------------ marking screen

function paintMarking(S, paper) {
  const { app, root, back } = S;
  const marks = {};   // n -> {ticks: Set(1-based), reason, note, touched, comment}
  for (const q of paper.questions) {
    const m = (paper.marking || {})[q.n];
    marks[q.n] = { ticks: new Set(m && m.points ? m.points : []), awardedOnly: m && !m.points ? m.awarded : null, reason: m ? m.reason : null, note: m ? m.note || '' : '', touched: !!m, comment: m ? m.comment : null };
  }
  const dirty = new Set();
  const schemeFor = n => ((paper.scheme || []).find(x => x.n === n) || {}).points || [];
  const save = debounced(S, async () => {
    // With mark-scheme points they tick points; without (a past paper with no scheme yet) they give whole marks.
    const list = [...dirty].map(n => ({ n, ...(schemeFor(n).length ? { points: [...marks[n].ticks].sort((a, b) => a - b) } : { awarded: marks[n].awardedOnly ?? 0 }),
      ...(marks[n].reason ? { reason: marks[n].reason } : {}), ...(marks[n].note ? { note: marks[n].note } : {}) }));
    dirty.clear();
    if (list.length) await put(`/api/p/papers/${encodeURIComponent(paper.id)}/marks`, { marks: list });
  }, 500);
  const awardedOf = q => (marks[q.n].awardedOnly != null && !marks[q.n].ticks.size ? marks[q.n].awardedOnly : Math.min(q.marks, marks[q.n].ticks.size));
  const totalEl = h('span', { class: 'score' });
  const sumUp = () => { totalEl.textContent = `${paper.questions.reduce((s, q) => s + awardedOf(q), 0)}/${paper.out_of}`; };

  const cards = paper.questions.map(q => {
    const m = marks[q.n];
    const pts = ((paper.scheme || []).find(x => x.n === q.n) || {}).points || [];
    const scoreEl = h('span', { class: 'status info' });
    const reasonBox = h('div', { class: 'stack', style: 'gap:8px' });
    const comment = h('p', { class: 'foot', 'aria-live': 'polite' }, m.comment ? `Claude: ${m.comment}` : '');
    const redraw = () => {
      const a = awardedOf(q);
      scoreEl.className = `status ${!m.touched ? 'info' : a >= q.marks ? 'ok' : a ? 'warn' : 'bad'}`;
      scoreEl.textContent = m.touched ? `${a}/${q.marks}` : `Not marked · ${q.marks}`;
      reasonBox.hidden = !m.touched || a >= q.marks;
      reasonBox.replaceChildren(
        h('div', { class: 't-micro' }, 'Why did marks go?'),
        h('div', { class: 'chips' }, REASONS.map(([id, label]) => h('button', { type: 'button', class: 'chip', style: tapStyle, 'aria-pressed': String(m.reason === id),
          onclick: () => { m.reason = m.reason === id ? null : id; dirty.add(q.n); save(); redraw(); } }, h('span', { class: 'nm' }, label)))),
        h('input', { class: 'input', type: 'text', maxLength: 200, value: m.note, placeholder: "What didn't you get? In your words (optional)", 'aria-label': `Note for question ${q.n}`,
          oninput: e => { m.note = e.target.value; dirty.add(q.n); save(); } }));
      sumUp();
    };
    const ticks = pts.map((text, i) => {
      const cb = h('input', { type: 'checkbox', checked: m.ticks.has(i + 1), style: 'width:26px;height:26px;flex:none;accent-color:var(--accent)', 'aria-label': `Mark scheme point ${i + 1}` });
      cb.addEventListener('change', () => {
        if (cb.checked) m.ticks.add(i + 1); else m.ticks.delete(i + 1);
        m.awardedOnly = null; m.touched = true; dirty.add(q.n); save(); redraw();
      });
      return { cb, row: h('label', { style: 'display:flex;gap:12px;align-items:flex-start;min-height:var(--tap);padding:8px 0;cursor:pointer' }, cb, h('span', null, text)) };
    });
    // No mark scheme for this question: whole marks, 0 to the question's marks.
    const steps = h('div', { class: 'seg', role: 'group', 'aria-label': `Marks for question ${labelOf(q)}`, style: 'flex-wrap:wrap' });
    const drawSteps = () => steps.replaceChildren(...Array.from({ length: q.marks + 1 }, (_, k) => h('button', { type: 'button', style: tapStyle,
      'aria-pressed': String(m.touched && awardedOf(q) === k), onclick: () => { m.ticks.clear(); m.awardedOnly = k; m.touched = true; dirty.add(q.n); save(); redraw(); drawSteps(); } }, String(k))));
    if (!pts.length) drawSteps();
    const ai = btn('Mark this for me', null, 'tinted', 'sparkle', { cls: 'btn-sm' });
    const hasAnswer = !!(q.answer && q.answer.trim());
    ai.hidden = !hasAnswer || !S.ownKey || !pts.length;
    ai.addEventListener('click', () => busy(ai, async () => {
      ai.textContent = 'Marking…';
      try {
        await save.flush();
        const r = await post(`/api/p/papers/${encodeURIComponent(paper.id)}/ai-mark`, { n: q.n });
        m.ticks = new Set(r.marking.points || []); m.awardedOnly = null; m.touched = true;
        if (r.marking.reason) m.reason = r.marking.reason;
        m.comment = r.marking.comment;
        ticks.forEach((t, i) => { t.cb.checked = m.ticks.has(i + 1); });
        comment.textContent = m.comment ? `Claude: ${m.comment} You can change the ticks.` : 'Claude ticked what it found. You can change the ticks.';
        redraw();
      } catch (e) { toast(e.message); } finally { ai.textContent = 'Mark this for me'; }
    }));
    const card = h('section', { class: 'card', style: 'padding:var(--pad);display:grid;gap:12px', dataset: { q: String(q.n) } },
      qHead(q, scoreEl),
      h('p', { style: 'white-space:pre-wrap' }, q.text),
      h('div', null, h('div', { class: 'spread' }, h('span', { class: 't-micro' }, 'Your answer'), confBadge(q.confidence)),
        hasAnswer ? h('p', { style: 'white-space:pre-wrap;margin-top:6px;color:var(--ink-2)' }, q.answer) : h('p', { class: 'foot', style: 'margin-top:6px' }, 'You left this one blank.')),
      pts.length ? h('div', null, h('div', { class: 't-micro', style: 'margin-bottom:2px' }, 'Mark scheme: tick what you earned'), h('div', null, ticks.map(t => t.row)))
        : h('div', null, h('div', { class: 't-micro', style: 'margin-bottom:6px' }, 'How many marks did you get? Check the mark scheme, or ask your Claude.'), steps),
      pts.length ? h('div', { class: 'row' }, ai, h('button', { type: 'button', class: 'btn btn-plain btn-sm', onclick: () => { ticks.forEach(t => { t.cb.checked = false; }); m.ticks.clear(); m.awardedOnly = null; m.touched = true; dirty.add(q.n); save(); redraw(); } }, 'No marks')) : null,
      comment, reasonBox, thinkingFor(paper, q.n));
    redraw();
    return card;
  });

  const allAI = btn('Mark all for me', null, 'tinted', 'sparkle');
  allAI.hidden = !S.ownKey || !(paper.scheme || []).length || !paper.questions.some(q => q.answer && q.answer.trim());
  allAI.addEventListener('click', () => busy(allAI, async () => {
    const todo = paper.questions.filter(q => q.answer && q.answer.trim() && !marks[q.n].touched);
    if (!todo.length) { toast('Everything you answered is already marked.'); return; }
    await save.flush();
    for (let i = 0; i < todo.length; i++) {
      allAI.textContent = `Marking ${i + 1} of ${todo.length}…`;
      try { await post(`/api/p/papers/${encodeURIComponent(paper.id)}/ai-mark`, { n: todo[i].n }); } catch (e) { toast(e.message); break; }
    }
    allAI.textContent = 'Mark all for me';
    const fresh = await get(`/api/p/papers/${encodeURIComponent(paper.id)}`);
    show(S, fresh.paper);
  }));

  const finish = btn('Finish and save to my map', null, 'primary', 'check', { cls: 'btn-lg' });
  finish.addEventListener('click', () => busy(finish, async () => {
    const open = paper.questions.filter(q => q.answer && q.answer.trim() && !marks[q.n].touched);
    if (open.length) {
      const yes = await confirmSheet({ title: 'Give them no marks?', sub: `You have not marked question ${open.map(labelOf).join(', ')} yet.`, ok: 'No marks for those' });
      if (!yes) { const el = root.querySelector(`[data-q="${open[0].n}"]`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      for (const q of open) { marks[q.n].touched = true; dirty.add(q.n); }
      save();
    }
    finish.textContent = 'Saving…';
    try {
      await save.flush();
      const r = await post(`/api/p/papers/${encodeURIComponent(paper.id)}/finish`, {});
      show(S, r.paper);
      toast(`Marked: ${r.total}/${r.out_of}`, r.result ? { undo: async () => { await post('/api/p/undo', { batch_id: r.result.batch_id }); toast('Taken off your map'); } } : undefined);
    } catch (e) { toast(e.message); finish.textContent = 'Finish and save to my map'; }
  }));
  sumUp();
  const exam = isExam(paper);
  const viaClaude = h('section', { class: 'tile ask-claude' },
    h('b', null, 'Let your Claude mark it'),
    h('p', { class: 'foot' }, 'Open your Claude and say: "Mark my exam ' + (paper.title || '') + ' on my Study Hub." It reads your answers and the mark scheme, goes through each question with you, and saves the marks here. Or mark it yourself below.'),
    askClaude(`Mark my exam "${paper.title || 'paper'}" on my Study Hub. Go through each question with me.`, 'Open my Claude'));
  const list = h('div', { class: exam ? 'exam-answers' : 'stack' }, cards,
    h('div', { class: 'row', style: 'margin-top:20px;justify-content:space-between' }, deleteBtn(S), finish));
  const body = exam ? h('div', { class: 'exam-split' }, h('div', { class: 'exam-pdf-slot' }), list) : list;
  root.replaceChildren(pageHead(paper.title || 'Practice paper', { back, kicker: (paper.scheme || []).length ? 'Marking · tick the points you earned' : 'Marking' }),
    viaClaude,
    h('div', { class: 'row', style: 'margin:6px 0 14px;justify-content:space-between' }, h('span', { class: 'foot' }, 'Your marks so far'), totalEl, allAI),
    body);
  if (exam) examPdf(S, paper).then(p => { const slot = body.querySelector('.exam-pdf-slot'); if (slot) slot.replaceWith(p.el); else p.close(); }).catch(() => {});
}

// ------------------------------------------------------------------ results

function confLine(summary) {
  const parts = CONF.filter(([id]) => summary && summary[id] && summary[id].n).map(([id, label]) => `${label}: ${summary[id].full} of ${summary[id].n} full marks`);
  return parts.length ? parts.join(' · ') : null;
}

function paintResults(S, paper) {
  const { app, root, back } = S;
  const total = paper.total ?? paper.results.reduce((s, r) => s + r.awarded, 0);
  const lines = [];
  if (paper.on_map) lines.push('Saved to your map.');
  if (paper.gaps_saved) lines.push(`${plural(paper.gaps_saved, 'gap note')} added.`);
  const undo = paper.on_map && paper.batch_id ? btn('Undo', null, 'plain', 'undo', { cls: 'btn-sm' }) : null;
  if (undo) undo.addEventListener('click', () => busy(undo, async () => {
    try { await post('/api/p/undo', { batch_id: paper.batch_id }); toast('Taken off your map'); undo.hidden = true; } catch (e) { toast(e.message); }
  }));

  const qs = paper.questions.map(q => {
    const r = paper.results.find(x => x.n === q.n) || { awarded: 0, out_of: q.marks, result: 'omitted' };
    const pts = ((paper.scheme || []).find(x => x.n === q.n) || {}).points || [];
    const ticked = new Set(r.ticked || []);
    const lost = r.out_of - r.awarded;
    const cls = r.awarded >= r.out_of ? 'ok' : r.awarded ? 'warn' : 'bad';
    let flag = null;
    if (r.confidence === 'sure' && lost > 0) flag = 'You were sure and still lost marks. This is the one to look at hardest.';
    else if (r.confidence === 'guess' && lost === 0) flag = 'A guess that came off. Check you could do it again.';
    return h('section', { class: 'card', style: 'padding:var(--pad);display:grid;gap:12px' },
      qHead(q, h('span', { class: `status ${cls}` }, `${r.awarded}/${r.out_of}`)),
      h('p', { style: 'white-space:pre-wrap' }, q.text),
      h('div', null, h('div', { class: 'spread' }, h('span', { class: 't-micro' }, 'Your answer'), confBadge(r.confidence)),
        q.answer ? h('p', { style: 'white-space:pre-wrap;margin-top:6px;color:var(--ink-2)' }, q.answer) : h('p', { class: 'foot', style: 'margin-top:6px' }, 'Left blank.')),
      flag ? h('p', { class: 'foot', style: 'color:var(--warn)' }, flag) : null,
      pts.length ? h('div', null, h('div', { class: 't-micro', style: 'margin-bottom:6px' }, 'Mark scheme'),
        h('ul', { class: 'rules' }, pts.map((p, i) => h('li', { class: r.ticked ? (ticked.has(i + 1) ? 'met' : '') : '' }, icon(r.ticked && !ticked.has(i + 1) ? 'close' : 'check'), p)))) : null,
      lost > 0 && r.reason ? h('p', { class: 'foot' }, `Why marks went: ${REASON_WORD[r.reason] || r.reason}.${r.note ? ` ${r.note}` : ''}`) : null,
      r.comment ? h('p', { class: 'foot' }, `Claude: ${r.comment}`) : null,
      thinkingFor(paper, q.n));
  });

  // Exam wrapper: three questions, saved with the paper.
  const w = paper.wrapper || {};
  const boxes = WRAPPER.map(([k, label]) => ({ k, el: h('textarea', { class: 'input', rows: 3, maxLength: 600, value: w[k] || '', 'aria-label': label }), label }));
  const saveW = btn(paper.wrapper ? 'Update my wrapper' : 'Save my wrapper', null, 'primary', 'check');
  saveW.addEventListener('click', () => busy(saveW, async () => {
    const body = {}; for (const b of boxes) body[b.k] = b.el.value.trim();
    if (!Object.values(body).some(Boolean)) { toast('Write at least one answer.'); return; }
    try { const r = await put(`/api/p/papers/${encodeURIComponent(paper.id)}/wrapper`, body); S.paper = r.paper; toast('Wrapper saved'); saveW.textContent = 'Update my wrapper'; } catch (e) { toast(e.message); }
  }));
  const wrapper = h('section', { class: 'card form', style: 'padding:var(--pad)' },
    h('div', { class: 't-head' }, 'Exam wrapper'),
    h('p', { class: 'foot' }, 'Three quick questions while it is fresh.'),
    boxes.map(b => field(b.label, b.el)), h('div', { class: 'row' }, saveW));

  // Cards from lost marks: drafts first, nothing saved until they are accepted.
  const cardsBox = h('div', { class: 'stack' });
  const canCards = app.on('cards') && S.ownKey && paper.results.some(r => r.awarded < r.out_of && !NO_CARD.includes(r.reason));
  const draftsUi = list => {
    if (!list.length) { cardsBox.replaceChildren(h('p', { class: 'foot' }, 'Nothing to make cards from this time.')); return; }
    const rows = list.map(d => ({ d: { ...d }, on: true }));
    const savedBtn = btn(`Save ${rows.length} cards`, null, 'primary', 'check');
    const refresh = () => { const n = rows.filter(r => r.on).length; savedBtn.textContent = n ? `Save ${plural(n, 'card')}` : 'Choose a card'; };
    cardsBox.replaceChildren(
      h('p', { class: 'foot' }, 'Check each card, change the words if you like, and untick any you do not want. Nothing is saved yet.'),
      ...rows.map(r => {
        const cb = h('input', { type: 'checkbox', checked: true, style: 'width:26px;height:26px;flex:none;accent-color:var(--accent)', 'aria-label': 'Keep this card', onchange: e => { r.on = e.target.checked; refresh(); } });
        const front = h('input', { class: 'input', type: 'text', maxLength: 300, value: r.d.front, 'aria-label': 'Front of card', oninput: e => { r.d.front = e.target.value; } });
        const bk = h('textarea', { class: 'input', rows: 2, maxLength: 300, value: r.d.back, 'aria-label': 'Back of card', oninput: e => { r.d.back = e.target.value; } });
        return h('div', { class: 'card', style: 'padding:14px;display:flex;gap:12px;align-items:flex-start' }, cb, h('div', { class: 'grow', style: 'display:grid;gap:8px' }, front, bk,
          r.d.topic ? h('span', { class: 'foot' }, `Topic: ${r.d.topic}`) : null));
      }),
      h('div', { class: 'row' }, savedBtn));
    refresh();
    savedBtn.addEventListener('click', () => busy(savedBtn, async () => {
      const keep = rows.filter(r => r.on && r.d.front.trim() && r.d.back.trim()).map(r => ({ n: r.d.n, front: r.d.front.trim(), back: r.d.back.trim() }));
      if (!keep.length) { toast('Choose at least one card.'); return; }
      try {
        const r = await post(`/api/p/papers/${encodeURIComponent(paper.id)}/cards`, { cards: keep });
        cardsBox.replaceChildren(h('p', null, r.added ? `${plural(r.added, 'card')} saved to your deck.` : 'Those cards were already in your deck.'), linkBtn('Open my cards', '#cards', 'tinted', 'cards'));
        toast(r.added ? `${plural(r.added, 'card')} saved` : 'Already in your deck');
      } catch (e) { toast(e.message); }
    }));
  };
  const draftBtn = btn('Make cards from my lost marks', null, 'tinted', 'sparkle');
  draftBtn.addEventListener('click', () => busy(draftBtn, async () => {
    draftBtn.textContent = 'Writing card drafts…';
    try { const r = await post(`/api/p/papers/${encodeURIComponent(paper.id)}/drafts`, {}); draftBtn.hidden = true; draftsUi(r.drafts); }
    catch (e) { toast(e.message); } finally { draftBtn.textContent = 'Make cards from my lost marks'; }
  }));
  const lostAny = paper.results.some(r => r.awarded < r.out_of && !NO_CARD.includes(r.reason));
  const claudeCards = !S.ownKey && app.on('cards') && lostAny ? h('section', { class: 'card form', style: 'padding:var(--pad)' },
    h('div', { class: 't-head' }, 'Cards from lost marks'),
    h('p', { class: 'foot' }, 'Your Claude makes flashcards on exactly what you missed, in its own words. None for misreads or exam technique.'),
    askClaude(`Make flashcards from the marks I lost on "${paper.title || 'my paper'}" in my Study Hub (none for misreads or exam technique).`, 'Make cards with my Claude')) : null;
  const cardsSection = canCards ? h('section', { class: 'card form', style: 'padding:var(--pad)' },
    h('div', { class: 't-head' }, 'Cards from lost marks'),
    h('p', { class: 'foot' }, 'Claude drafts a few flashcards from what you missed. Marks lost to a misread or exam technique do not get cards.'),
    draftBtn, cardsBox) : null;
  if (canCards && paper.drafts && paper.drafts.length) { draftBtn.hidden = true; draftsUi(paper.drafts); }

  const conf = confLine(paper.confidence_summary);
  root.replaceChildren(pageHead(paper.title || 'Practice paper', { back, kicker: `Marked · ${pct(total, paper.out_of)}%` }),
    h('section', { class: 'tile', style: 'margin-bottom:var(--gap)' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { class: 't-display num' }, `${total}/${paper.out_of}`), undo),
      lines.length ? h('p', { class: 'foot', style: 'margin-top:6px' }, lines.join(' ')) : null,
      conf ? h('p', { class: 'foot', style: 'margin-top:6px' }, `How sure you were: ${conf}.`) : null),
    (paper.thinking || []).length ? h('section', { class: 'tile ask-claude', style: 'margin-bottom:var(--gap)' },
      h('b', null, `You recorded your thinking ${plural(paper.thinking.length, 'time')}`),
      h('p', { class: 'foot' }, 'Your Claude can look at how you reasoned and what to change next time.'),
      askClaude(`Analyse my thinking on "${paper.title || 'my paper'}" from my Study Hub.`, 'Analyse my thinking')) : null,
    h('div', { class: 'stack' }, wrapper, cardsSection, claudeCards, qs),
    h('div', { class: 'row', style: 'margin-top:20px;justify-content:space-between' }, deleteBtn(S), linkBtn('New paper', '#papers', 'tinted', 'plus')));
}
