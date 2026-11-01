// Your study days (#progress, and the Today tile): a year of days as a grid of squares, darker the longer they spent
// in the Study Hub that day (like Anki's, cleaner), and the numbers under it: daily average, days studied, longest and
// current streak. GET /api/p/activity; the page sends a beat a minute while it is open (main.js).
import { h, icon, pageHead, loading, errorState, plural, linkBtn, askClaude } from './kit.js';
import { get } from './api.js';

const DAY_MS = 86_400_000;
const isoOf = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
/** The shade (0 to 4) for a day's minutes and actions. Pure. */
export const levelOf = x => (!x ? 0 : x.minutes >= 60 || x.actions >= 80 ? 4 : x.minutes >= 30 || x.actions >= 40 ? 3 : x.minutes >= 10 || x.actions >= 10 ? 2 : 1);

/** The grid: `weeks` columns ending this week, Monday on top. data: the reply. */
export function grid(data, weeks = 53) {
  const by = new Map(data.days.map(x => [x.day, x]));
  const t = new Date(`${data.today}T12:00:00Z`);
  const dow = (t.getUTCDay() + 6) % 7;   // Monday 0
  const start = new Date(t.getTime() - (dow + 7 * (weeks - 1)) * DAY_MS);
  const svgNS = 'http://www.w3.org/2000/svg', cell = 12, gap = 3;
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${weeks * (cell + gap)} ${7 * (cell + gap)}`);
  svg.setAttribute('class', 'pg-grid');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${plural(data.stats.total_days, 'day')} studied in the last year`);
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 7; d++) {
    const day = new Date(start.getTime() + (w * 7 + d) * DAY_MS);
    if (day > t) continue;
    const iso = isoOf(day), x = by.get(iso);
    const r = document.createElementNS(svgNS, 'rect');
    r.setAttribute('x', w * (cell + gap)); r.setAttribute('y', d * (cell + gap)); r.setAttribute('width', cell); r.setAttribute('height', cell); r.setAttribute('rx', 3);
    r.setAttribute('class', `pg-l${levelOf(x)}${iso === data.today ? ' pg-today' : ''}`);
    const tip = document.createElementNS(svgNS, 'title');
    tip.textContent = `${day.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}: ${x ? `${x.minutes} min${x.actions ? `, ${plural(x.actions, 'thing')} done` : ''}` : 'no study'}`;
    r.append(tip);
    svg.append(r);
  }
  return svg;
}

const statsRow = s => h('div', { class: 'pg-stats' },
  h('div', null, h('b', { class: 'num' }, `${s.daily_minutes} min`), h('span', null, 'Daily average')),
  h('div', null, h('b', { class: 'num' }, `${s.days_pct}%`), h('span', null, 'Days studied')),
  h('div', null, h('b', { class: 'num' }, plural(s.longest, 'day')), h('span', null, 'Longest streak')),
  h('div', null, h('b', { class: 'num' }, plural(s.current, 'day')), h('span', null, 'Current streak')));

/** Today's tiles (today.js gives them empty): Paste from Claude, and the last 20 weeks with the streak. */
function nowTile(app) {
  const box = h('section', { class: 'tile s12 nw', hidden: true });
  get('/api/p/next').then(({ steps }) => {
    if (!steps.length) return;
    box.replaceChildren(h('div', { class: 'tile-label' }, icon('bolt'), 'What to do now'),
      h('div', { class: 'list' }, steps.map(st => {
        const kids = [h('span', { class: 'grow' }, h('b', null, st.title), h('span', { class: 'sub' }, `${st.why} About ${st.minutes} min.`))];
        return st.href ? h('a', { class: 'li', href: st.href }, ...kids, icon('chevron', 'chev'))
          : h('div', { class: 'li' }, ...kids, askClaude(st.prompt, 'Ask my Claude', { app }));
      })));
    box.hidden = false;
  }).catch(() => {});
  return box;
}

export function todayTiles(el, paste, app) {
  if (el.parentNode && !el.parentNode.querySelector('.nw')) el.parentNode.insertBefore(nowTile(app), el.parentNode.firstChild);
  paste.replaceChildren(h('button', { type: 'button', class: 'tile-btn', onclick: () => import('./chats.js').then(m => m.pasteSheet(app)) },
    h('span', { class: 't-ico' }, icon('chat')), h('span', { class: 'grow' }, h('b', { class: 't-head' }, 'Paste from Claude'), h('span', { class: 'sub foot', style: 'display:block' }, 'A chat or its summary, for next time'))));
  paste.hidden = false;
  get('/api/p/activity?days=140').then(d => {
    el.replaceChildren(h('div', { class: 'spread' }, h('div', { class: 'tile-label' }, 'Your study days'), h('a', { href: '#progress', class: 'foot' }, 'The year')),
      h('a', { href: '#progress', class: 'pg-wrap', 'aria-label': 'Your study days' }, grid(d, 20)),
      h('p', { class: 'foot' }, d.stats.current ? `${plural(d.stats.current, 'day')} in a row. ` : 'Study today to start a streak. ', `Average ${d.stats.daily_minutes} min a day.`));
    el.hidden = false;
  }).catch(() => {});
}

export function render(root) {
  root.append(pageHead('Your study days'), loading(1));
  get('/api/p/activity?days=371').then(d => {
    root.replaceChildren(pageHead('Your study days', { kicker: 'A square a day: darker means longer in your Study Hub' }),
      h('section', { class: 'tile pg-year' }, h('div', { class: 'pg-wrap' }, grid(d, 53)),
        h('div', { class: 'pg-key', 'aria-hidden': 'true' }, 'Less', [0, 1, 2, 3, 4].map(l => h('i', { class: `pg-l${l}` })), 'More')),
      statsRow(d.stats),
      h('p', { class: 'foot' }, 'A day counts when the Study Hub was open and in front of you, or when you or your Claude did something on it (cards, tests, papers, lessons, notes).'),
      h('div', { class: 'row' }, linkBtn('Back to Today', '#today', 'tinted')));
  }).catch(e => root.replaceChildren(pageHead('Your study days'), errorState(e)));
}
