// How it works (#how, and #help/<part> as an alias): the one page that explains the Study Hub (docs/platform/v2-plan.md
// 2.4). Title and chips, a tree of boxes (you, your Claude, the hub and its parts), the per-track guide "Make the most
// of it with your Claude" (guide.js), the hub part by part in sheets, what to say where, why it works, what is left
// out. The words are in how-data.js; the live numbers come from one GET /api/p/guide, painted after the words.
import { h, icon, sheet, seg, input, askClaude, linkBtn, addIcons } from './kit.js';
import { get } from './api.js';
import { UPDATED, TITLE, SUB, INTRO, NODES, SECTIONS, PLACES, LEFT_OUT, LEFT_OUT_WHY, targetOf, filterPhrases, phraseText, phraseCount } from './how-data.js';
import { guideFor } from './guide.js';

export { targetOf, filterPhrases, phraseText };

addIcons({ mic: 'r:9 3.5 6 11 3|p:M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3' });

const NS = 'http://www.w3.org/2000/svg';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* private mode */ } return null; };

/** The line under a tree box from the guide data, or null to keep the written one. */
export function liveSub(key, d) {
  if (!d) return null;
  const c = d.counts || {};
  if (key === 'claude') return d.claude && d.claude.last_used_at ? 'connected through the Study Hub connector' : 'Not connected yet: tap to connect';
  if (key === 'map') return `${plural(c.topics || 0, 'topic')} in ${plural((d.subjects || []).filter(s => s.topics_n).length + (c.galaxies || 0), 'galaxy', 'galaxies')}`;
  if (key === 'cards') return `${c.cards_due || 0} due today`;
  if (key === 'exams') return `${c.papers_to_sit || 0} to sit`;
  if (key === 'library') return plural(c.docs || 0, 'document');
  return null;
}

// A short vertical line between tree boxes (SVG, nothing animates).
function stem() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'hw-stem'); svg.setAttribute('viewBox', '0 0 2 22'); svg.setAttribute('aria-hidden', 'true');
  const l = document.createElementNS(NS, 'line');
  for (const [k, v] of [['x1', 1], ['y1', 0], ['x2', 1], ['y2', 22]]) l.setAttribute(k, v);
  svg.append(l);
  return svg;
}

const sq = (ico, tint) => h('span', { class: 'hw-sq', 'data-tint': tint || 'blue' }, icon(ico));

// The tree: boxes are buttons with aria-expanded; one open at a time. The top three open in place, the four parts
// open into one card under their grid.
function tree(app, live) {
  const boxes = [];
  const close = () => { for (const b of boxes) { b.btn.setAttribute('aria-expanded', 'false'); b.panel.hidden = true; } };
  const make = n => {
    const sub = h('span', { class: 'hw-line' }, n.line || '');
    if (n.live) live.push(d => { const s = liveSub(n.live, d); if (s) sub.textContent = s; });
    const b = h('button', { type: 'button', class: 'hw-box', 'aria-expanded': 'false', 'aria-controls': `hw-p-${n.id}` },
      sq(n.icon, n.id === 'claude' ? 'purple' : n.id === 'hub' ? 'teal' : 'blue'), h('span', { class: 'grow' }, h('b', null, n.title), sub));
    const p = h('div', { class: 'hw-open', id: `hw-p-${n.id}`, hidden: true }, h('p', null, n.text), extra(n, app));
    b.addEventListener('click', () => { const was = b.getAttribute('aria-expanded') === 'true'; close(); if (!was) { b.setAttribute('aria-expanded', 'true'); p.hidden = false; } });
    boxes.push({ btn: b, panel: p });
    return { b, p };
  };
  const top = NODES.filter(n => !n.section).flatMap((n, i) => { const { b, p } = make(n); return [i ? stem() : null, b, p]; });
  const parts = NODES.filter(n => n.section).map(n => make(n));
  return h('div', { class: 'hw-tree' }, top, stem(),
    h('div', { class: 'hw-grid' }, parts.map(x => x.b)), parts.map(x => x.p));
}

// What a tree box offers once open.
function extra(n, app) {
  if (n.id === 'claude') {
    const connected = !!(app.claude && app.claude.last_used_at);
    return h('div', { class: 'row' }, connected ? linkBtn('What your Claude can do', '#how/claude', 'tinted', 'chat') : linkBtn('Connect your Claude', '#settings', 'primary', 'link'));
  }
  if (n.section) return h('div', { class: 'row' }, linkBtn(`More on ${n.title.replace(/^The /, 'the ')}`, `#how/${n.section}`, 'tinted', 'info'));
  return null;
}

// One part of the hub in a sheet. The address follows it, so Back and a shared link land on it. Only one is open, and
// it closes when they leave the page (render's cleanup).
let openSheet = null;
function openSection(sec, app) {
  if (openSheet) openSheet.close();
  history.replaceState(null, '', `#how/${sec.id}`);
  const off = sec.module && app.modules[sec.module] === false;
  const s = sheet({ title: sec.name, wide: true,
    body: h('div', { class: 'hw-items' },
      off ? h('a', { class: 'status info', href: '#settings' }, 'Switched off · Settings') : null,
      sec.items.map(([ico, t, line]) => h('div', { class: 'hw-item' }, sq(ico, sec.tint), h('span', null, h('b', null, `${t}: `), line)))),
    onClose: () => { if (location.hash === `#how/${sec.id}`) history.replaceState(null, '', '#how'); } });
  s.el.classList.add('hw-sheet');
  openSheet = s;
  return s;
}

// "Make the most of it with your Claude": set up once, a simple week, the track's moves and a tab per subject.
function plan(app, d) {
  const gd = guideFor({ track: d ? d.track : (app.me && app.me.profile) || 'gcse', subjects: d ? d.subjects : [], label: d ? d.track_label : null });
  const set = d && d.setup;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const step = (done, title, info, act) => h('li', { class: done ? 'done' : null },
    h('span', { class: 'hw-tick', 'aria-label': done ? 'Done' : 'To do' }, done ? icon('check') : null),
    h('span', { class: 'grow' }, h('b', null, title), info ? h('span', { class: 'sub' }, info) : null), done ? null : act || null);
  const setup = set ? h('ol', { class: 'hw-setup' },
    step(set.claude, 'Connect your Claude', set.claude ? null : 'Settings, Your Claude, Make a new link.', linkBtn('Open', '#settings', 'tinted')),
    step(false, 'Switch Study Hub on in your chat', 'In a Claude chat, tap + then Connectors.'),
    step(!set.boards_missing.length, 'Pick an exam board for every subject', set.boards_missing.length ? `Still to pick: ${set.boards_missing.join(', ')}.` : null, linkBtn('Subjects', '#subjects', 'tinted')),
    step(set.exam_date, 'Add your first exam date', set.exam_date ? null : 'So Today can count down.', linkBtn('Settings', '#settings', 'tinted')),
    step(!set.no_topics.length, 'Give every subject its topics', set.no_topics.length ? `No topics yet: ${set.no_topics.join(', ')}.` : null,
      set.no_topics.length ? askClaude(`Suggest topics for my ${set.no_topics[0]} and add the ones I pick to my Study Hub`, 'Ask my Claude', { app }) : null),
    step(standalone, 'Add the Study Hub to your Home Screen', standalone ? null : 'Safari, Share, Add to Home Screen.')) : null;

  const panel = h('div', { class: 'hw-subject' });
  const draw = id => {
    const s = gd.subjects.find(x => x.id === id);
    if (!s) return panel.replaceChildren();
    panel.replaceChildren(
      h('h4', null, `What ${s.name} rewards`), h('ul', null, s.rewards.map(r => h('li', null, r))),
      h('h4', null, 'Try saying'), h('div', { class: 'hw-tries' }, s.say.map(w => askClaude(w, h('span', null, `“${w}”`), { app, cls: 'hw-try', ico: 'sparkle' }))),
      h('h4', null, 'Watch out for'), h('ul', null, s.watch.map(r => h('li', null, r))),
      s.practicals ? h('details', { class: 'hw-fold' }, h('summary', null, `Required practicals (AQA), ${s.practicals.length}`), h('ol', null, s.practicals.map(p => h('li', null, p)))) : null,
      s.practicals_note ? h('p', { class: 'foot' }, s.practicals_note) : null,
      s.note ? h('p', { class: 'foot' }, s.note, ' ', h('a', { href: '#subjects' }, 'Subjects')) : null);
  };
  const first = gd.subjects[0];
  if (first) draw(first.id);
  return [
    h('h2', { class: 'hw-h2', id: 'hw-plan' }, 'Make the most of it with your Claude'),
    h('p', { class: 'hw-sub' }, 'You do not need an API key. Your Claude does the thinking on your own plan; the hub keeps score.'),
    setup ? [h('h3', { class: 'hw-h3' }, 'Set up once'), setup] : null,
    h('h3', { class: 'hw-h3' }, `What works at ${gd.label}`),
    h('ol', { class: 'hw-moves' }, gd.moves.map(m => h('li', null, m))),
    h('h3', { class: 'hw-h3' }, 'A simple week'),
    h('div', { class: 'hw-week' }, gd.week.map(([when, long, items]) => h('section', { class: 'hw-card' },
      h('div', { class: 'spread' }, h('b', null, when), long ? h('span', { class: 'foot' }, long) : null), h('ul', null, items.map(t => h('li', null, t)))))),
    gd.subjects.length ? [h('h3', { class: 'hw-h3' }, 'Subject by subject'),
      gd.subjects.length > 1 ? h('div', { class: 'hw-tabs' }, seg(gd.subjects.map(s => ({ value: s.id, label: s.name })), first.id, draw)) : null, panel] : null,
  ];
}

// What to say: a place picker (remembered on this device), a filter over every place, and the phrases.
function sayPart(app) {
  const list = h('div', { class: 'hw-phs' });
  let place = store('sh-how-place') || PLACES[0].id;
  if (!PLACES.some(p => p.id === place)) place = PLACES[0].id;
  const row = (item, pl) => {
    const does = h('p', { class: 'hw-does', hidden: true }, item.does, item.when ? ` ${item.when}` : '');
    const plus = h('button', { type: 'button', class: 'hw-plus', 'aria-expanded': 'false', 'aria-label': `What “${item.say}” does` }, icon('plus'));
    plus.addEventListener('click', () => { const on = does.hidden; does.hidden = !on; plus.setAttribute('aria-expanded', String(on)); });
    return h('div', { class: 'hw-ph' }, h('div', { class: 'spread' }, h('q', null, item.say), plus), does,
      h('div', { class: 'hw-ph-foot' }, pl ? h('span', { class: 'foot' }, pl.tag) : null, askClaude(item.say, 'Open in Claude', { app, cls: 'btn btn-plain btn-sm', ico: 'out' })));
  };
  const box = input({ type: 'search', placeholder: 'Find something to say', 'aria-label': 'Find something to say', autocomplete: 'off' });
  const where = h('p', { class: 'foot' });
  const draw = () => {
    const q = box.value.trim();
    if (q) {
      const hits = filterPhrases(q);
      where.textContent = hits.length ? `${plural(hits.length, 'match', 'matches')} in every place.` : 'Nothing matches. Try fewer words, or just ask your Claude in your own words.';
      list.replaceChildren(...hits.map(x => row(x.item, x.place)));
      picker.hidden = true;
    } else {
      const pl = PLACES.find(p => p.id === place);
      where.textContent = pl.where;
      list.replaceChildren(...pl.items.map(i => row(i)));
      picker.hidden = false;
    }
  };
  const picker = h('div', { class: 'hw-places' }, seg(PLACES.map(p => ({ value: p.id, label: p.tag, aria: p.name })), place, v => { place = v; store('sh-how-place', v); draw(); }));
  box.addEventListener('input', draw);
  draw();
  return [h('h2', { class: 'hw-h2', id: 'hw-say' }, 'What to say'),
    h('p', { class: 'hw-sub' }, 'Your Claude understands normal words; these are ideas to start with. Open in Claude starts a chat with the words ready.'),
    picker, box, where, list];
}

/** The Today tile until How it works has been opened (learn.js shows it; this keeps the flag in one place). */
export const howSeen = app => store(`sh-how:${app.me && app.me.user}`) === '1';

export function render(root, { app, param }) {
  store(`sh-how:${app.me && app.me.user}`, '1');
  const live = [];
  const daysChip = h('span', { class: 'hw-chip', hidden: true });
  live.push(d => { if (d.days_to_exam != null && d.days_to_exam >= 0) { daysChip.textContent = `${plural(d.days_to_exam, 'day')} to your exams`; daysChip.hidden = false; } });
  const planBox = h('div', { class: 'hw-plan' }, plan(app, null));
  live.push(d => planBox.replaceChildren(...plan(app, d).flat(3)));

  const tiles = h('div', { class: 'hw-tiles' }, SECTIONS.map(sec => h('button', { type: 'button', class: 'hw-tile', onclick: () => openSection(sec, app) },
    sq(sec.icon, sec.tint), h('b', null, sec.name), h('span', { class: 'foot' }, sec.module && app.modules[sec.module] === false ? 'Switched off' : plural(sec.items.length, 'thing')))));

  root.append(h('div', { class: 'hw' },
    h('header', { class: 'hw-head' }, h('h1', null, TITLE), h('p', { class: 'hw-sub' }, SUB),
      h('div', { class: 'hw-chips' }, daysChip,
        h('a', { class: 'hw-chip', href: '#how/plan' }, icon('target'), 'Your plan with Claude'),
        h('a', { class: 'hw-chip', href: '#how/say' }, icon('chat'), `${phraseCount()} things you can say`)),
      h('p', { class: 'hw-intro' }, INTRO)),
    tree(app, live),
    planBox,
    h('h2', { class: 'hw-h2', id: 'hw-parts' }, 'The hub, part by part'), tiles,
    sayPart(app),
    h('a', { class: 'hw-card hw-why', href: '#learn' }, sq('teach', 'pink'), h('span', { class: 'grow' }, h('b', null, 'Why this works'), h('span', { class: 'sub' }, 'The science in five minutes, and a three-question check.')), icon('chevron', 'chev')),
    h('h3', { class: 'hw-h3' }, 'Left out on purpose'),
    h('div', { class: 'hw-left' }, LEFT_OUT.map(t => h('s', null, t))),
    h('p', { class: 'foot' }, LEFT_OUT_WHY),
    h('p', { class: 'foot hw-foot' }, `Most changes can be undone, and the (i) on each page opens its part of this page. Updated ${UPDATED}.`)));

  // Where the address points: a section opens its sheet; plan and say scroll there.
  const target = targetOf(param);
  const sec = SECTIONS.find(s => s.id === target);
  if (sec) openSection(sec, app);
  const jump = () => { const el = target === 'plan' ? document.getElementById('hw-plan') : target === 'say' ? document.getElementById('hw-say') : null; if (el) el.scrollIntoView({ block: 'start' }); };
  requestAnimationFrame(jump);

  get('/api/p/guide').then(d => { for (const f of live) try { f(d); } catch { /* the words still stand */ } if (target === 'plan') requestAnimationFrame(jump); }).catch(() => {});
  return () => { if (openSheet && !openSheet.closed) { const s = openSheet; openSheet = null; s.close(); } };
}
