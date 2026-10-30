// Today: greeting, countdown, subject rings, the weakest five, cards due, results, Teach me and the library, from
// one GET /api/p/today.
import { load } from './api.js';
import { h, icon, ring, dot, bandText, btn, linkBtn, loading, errorState, state, teachHref, fmtDay, scoreText, plural } from './ui.js';


const short = b => (b === 'Pearson Edexcel' ? 'Edexcel' : b || '');

function greeting(name) {
  const hr = new Date().getHours();
  const part = hr < 5 ? 'Hello' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

export function render(root, { app }) {
  root.append(loading(4));
  load('/api/p/today', data => paint(root, data, app), e => root.replaceChildren(errorState(e, () => app.route())));
}

function paint(root, t, app) {
  app.setModules(t.modules);
  const mods = t.modules || {};
  const d = new Date();
  const boardOf = Object.fromEntries((t.subjects || []).map(s => [s.id, s.board_name]));
  const top = (t.weakest || [])[0];

  const countdown = mods.countdown === false ? null
    : t.days_to_exam != null
      ? h('div', { class: 'count-chip' }, icon('calendar'), h('b', null, String(t.days_to_exam)), t.days_to_exam === 1 ? 'day to exams' : 'days to exams')
      : h('button', { type: 'button', class: 'count-chip', onclick: () => import('./kit.js').then(k => k.examDateSheet(app)) }, icon('calendar'), 'Add your exam date');

  const head = h('header', { class: 'head hello' },
    h('div', { class: 'titles' },
      h('div', { class: 't-micro date' }, d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '')),
      h('h1', { class: 't-title1' }, greeting(t.name))),
    countdown);

  const tiles = [];

  if (!app.welcomed()) {
    tiles.push(h('div', { class: 'tile rise', 'data-tile': 'setup' },
      h('div', { class: 'tile-label' }, icon('sparkle'), 'Finish setting up'),
      h('p', { class: 'muted', style: 'margin-top:6px' }, 'Pick an exam board for each subject, add topics and connect your Claude.'),
      h('div', { class: 'row-acts' }, linkBtn('Continue setup', '#welcome', 'primary', 'chevron'), btn('Not now', () => { app.markWelcomed(); app.route(); }, 'gray'))));
  }

  // How your Study Hub works, until How it works has been opened (learn.js).
  const learn = h('div', { class: 'tile rise', hidden: true, 'data-tile': 'learn' });
  tiles.push(learn);
  try { if (localStorage.getItem(`sh-how:${app.me && app.me.user}`) !== '1') import('./learn.js').then(m => m.todayTile(learn, app)); } catch { /* private mode */ }

  // Their own galaxies (galaxies.js fills it after the first paint).
  const gx = h('section', { class: 'tile s7 rise', hidden: true, 'data-tile': 'galaxies' });
  tiles.push(gx);
  if ((t.galaxies || []).length) import('./galaxies.js').then(m => m.todayTile(gx, t.galaxies));

  // Today's choice of two topics (choice.js, after the first paint).
  const choice = h('section', { class: 'tile choice rise', hidden: true, 'data-tile': 'choice' });
  tiles.push(choice);

  // Subjects: a ring per subject.
  const subs = t.subjects || [];
  tiles.push(h('section', { class: 'tile s7 rise', 'aria-label': 'Subjects', 'data-tile': 'subjects' },
    h('div', { class: 'tile-label' }, icon('grid'), 'Subjects', h('a', { class: 'aside', href: '#subjects' }, 'All')),
    subs.length
      ? h('div', { class: 'rings' }, subs.map(s => h('a', { class: 'ringcell', href: `#subject/${encodeURIComponent(s.id)}` },
        ring(s.ring, { size: 72, stroke: 8, label: `${s.name}: ${Math.round(s.ring * 100)}% strong` }),
        h('b', null, s.name), h('span', null, s.weak_n ? `${short(s.board_name)} · ${s.weak_n} weak` : short(s.board_name)))))
      : state('grid', 'No subjects yet', 'Add the subjects you are studying.', linkBtn('Add a subject', '#subjects', 'tinted', 'plus'), true),
    subs.length ? h('p', { class: 'foot', style: 'margin-top:12px' }, 'Each ring: the share of a subject’s topics you have seen and are not weak in.') : null));

  // Cards due.
  if (mods.cards !== false) {
    const n = t.cards_due || 0;
    tiles.push(h('section', { class: 'tile s5 rise', 'aria-label': 'Cards', 'data-tile': 'cards' },
      h('div', { class: 'tile-label' }, icon('cards'), 'Cards'),
      h('div', { class: 'fig' }, h('span', { class: 't-display num' }, String(n)), h('span', { class: 'unit' }, n === 1 ? 'card due' : 'cards due')),
      h('div', { class: 'row-acts' }, n
        ? linkBtn('Start', '#cards/review', 'primary', 'play')
        : linkBtn('Add a card', '#cards', 'tinted', 'plus'),
      n ? null : h('span', { class: 'foot', style: 'align-self:center' }, 'All done for now.'))));
  }

  // Weakest five.
  const weak = t.weakest || [];
  tiles.push(h('section', { class: 'tile s7 rise', 'aria-label': 'Weakest topics', 'data-tile': 'weakest' },
    h('div', { class: 'tile-label' }, icon('flag'), 'Weakest five'),
    weak.length
      ? h('div', { class: 'weak-list' }, weak.map(w => h('button', { type: 'button', class: 'weak-row', 'aria-label': `${w.name}, ${w.subject_name}: ${bandText(w)}`,
        onclick: () => import('./subjects.js').then(m => m.openTopic(w.id, { app, subjectName: w.subject_name, board: boardOf[w.subject_id] })) },
        dot(w.t1000, true), h('span', { class: 'grow' }, h('span', { class: 'nm' }, w.name), h('span', { class: 'sub' }, w.subject_name)),
        h('span', { class: 'bw' }, bandText(w)))))
      : state('flag', 'Nothing weak yet', 'Log some results or review cards, and your weakest topics show up here.', null, true)));

  // Log results.
  if (mods.results !== false) {
    const last = (t.last_results || [])[0];
    const name = last && (subs.find(s => s.id === last.subject_id) || {}).name;
    tiles.push(h('section', { class: 'tile s5 rise', 'aria-label': 'Results', 'data-tile': 'results' },
      h('div', { class: 'tile-label' }, icon('results'), 'Results'),
      last
        ? h('div', { style: 'margin-top:12px' }, h('div', { class: 'score' }, scoreText(last) || '—'),
          h('div', { class: 'foot', style: 'margin-top:4px' }, [last.label || name, fmtDay(last.day)].filter(Boolean).join(' · ')))
        : h('p', { class: 'foot', style: 'margin-top:8px' }, 'Snap a screenshot of your score in Seneca or Save My Exams, or type a past paper’s marks.'),
      h('div', { class: 'row-acts', style: 'margin-top:auto;padding-top:14px' }, linkBtn('Log results', '#results', 'primary', 'plus'))));
  }

  // Teach me in Claude, and the library.
  if (top) {
    tiles.push(h('a', { class: 'tile s6 teach rise', 'data-tile': 'teach', href: teachHref(top.name, boardOf[top.subject_id], top.subject_name), target: '_blank', rel: 'noopener noreferrer' },
      h('span', { class: 't-ico' }, icon('teach')),
      h('span', { class: 'grow' }, h('b', { class: 't-head' }, 'Teach me in Claude'), h('span', { class: 'sub foot', style: 'display:block' }, `${top.name} · ${top.subject_name}`)),
      icon('out', 'chev')));
  }
  if (mods.library !== false) {
    tiles.push(h('a', { class: `tile ${top ? 's6' : 's12'} teach rise`, 'data-tile': 'library', href: '#library' },
      h('span', { class: 'ftype' }, icon('library')),
      h('span', { class: 'grow' }, h('b', { class: 't-head' }, 'Library'), h('span', { class: 'sub foot', style: 'display:block' }, 'Past papers, mark schemes and notes')),
      icon('chevron', 'chev')));
  }

  // Paste from Claude and their study days (progress.js).
  const paste = h('div', { class: 'tile s6 teach rise', hidden: true, 'data-tile': 'paste' }), days = h('section', { class: 'tile s12 rise', hidden: true, 'data-tile': 'days' });
  tiles.push(paste, days);
  import('./progress.js').then(m => m.todayTiles(days, paste, app)).catch(() => {});
  root.replaceChildren(head, h('div', { class: 'bento' }, tiles));
  if (app.custom) import('./custom.js').then(m => m.arrangeToday(root)).catch(() => {});
  import('./choice.js').then(m => m.mount(choice, t)).catch(() => {});
}
