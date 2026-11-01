// Phone "More" (#more): How it works first, then Exams, Library, Practice papers, Subjects and galaxies, their own
// pages, Recent changes, Settings, Why it works and Refresh.
import { h, icon } from './kit.js';
import { recentRow } from './recent.js';

export function render(root, { app }) {
  const inner = (ico, label, sub) => [h('span', { class: 'ftype' }, icon(ico)), h('span', { class: 'grow' }, h('b', null, label), sub ? h('span', { class: 'sub' }, sub) : null)];
  const row = (href, ico, label, sub) => h('a', { class: 'li', href }, inner(ico, label, sub), icon('chevron', 'chev'));
  root.append(
    h('header', { class: 'head' }, h('div', { class: 'titles' }, h('h1', { class: 't-title1' }, 'More'))),
    h('nav', { class: 'list' },
      row('#how', 'help', 'How it works', 'Every part, your plan with Claude, and what to say'),
      app.on('exams') ? row('#exams', 'exam', 'Exams', 'Past papers on screen, and practice papers your Claude writes') : null,
      app.on('library') ? row('#library', 'library', 'Library', 'Papers, mark schemes, notes and links') : null,
      app.modules.papers === true ? row('#papers', 'results', 'Practice papers', 'Claude writes and marks them, on your key') : null,
      app.on('mnemonics') ? row('#mnemonics', 'teach', 'Mnemonics', 'Memory hooks with their own test') : null,
      row('#subjects', 'grid', 'Subjects and galaxies', 'Boards, tiers, topics and your own galaxies'),
      (app.myPages || []).map(p => row(`#page/${encodeURIComponent(p.id)}`, 'sparkle', p.title, 'Your page')),
      h('button', { type: 'button', class: 'li', onclick: () => import('./pictures.js').then(m => m.photoInboxSheet(app)) }, inner('photo', 'Photo inbox', 'Photos for your Claude to put on topics'), icon('chevron', 'chev')),
      row('#chats', 'chat', 'Chat notes', 'What you and your Claude covered'),
      row('#progress', 'calendar', 'Your study days', 'Every day you studied, and your streak'),
      recentRow(app),
      row('#settings', 'settings', 'Settings', 'Your Claude, Make it mine, sharing'),
      row('#learn', 'teach', 'Why it works', 'The science behind the hub, in five minutes'),
      h('button', { type: 'button', class: 'li', onclick: () => import('./report.js').then(m => m.openReport(app)) }, inner('bug', 'Report a problem', 'Copies what went wrong, ready for Claude')),
      h('button', { type: 'button', class: 'li', onclick: () => location.reload() }, inner('refresh', 'Refresh', 'Get the newest of everything')),
    ),
  );
}
