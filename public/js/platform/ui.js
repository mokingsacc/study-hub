// Small DOM kit for Study Hub: element builder (text only through textContent), icons and rings drawn with
// createElementNS, Ember dots and topic chips (colours from public/js/map/scale.js, always with the band word),
// the empty / loading / error states. Sheets, toasts and form controls live in kit.js.
import { colourAt, bandOf, bandWord } from '../map/scale.js';

// On this page, append and replaceChildren skip null and false (as h() does), so optional pieces can be written inline.
for (const m of ['replaceChildren', 'append']) {
  const orig = Element.prototype[m];
  if (!orig.__sh) { Element.prototype[m] = Object.assign(function (...kids) { return orig.apply(this, kids.filter(k => k != null && k !== false)); }, { __sh: true }); }
}

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'open']);

// h('button', {class: 'btn', onclick: fn, 'aria-label': 'Close'}, 'Text', child, [more]). Strings become text nodes.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else if (v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

// ---- icons (24 px grid, 1.8 stroke)
const NS = 'http://www.w3.org/2000/svg';
const I = {
  grid: 'r:4 4 7 7 1.6|r:13 4 7 7 1.6|r:4 13 7 7 1.6|r:13 13 7 7 1.6',
  cards: 'p:M8.5 4.5h9a2 2 0 0 1 2 2v10|r:4.5 7.5 11.5 13 2',
  results: 'p:M5 20v-7M10 20V5.5M15 20v-9.5M20 20V8',
  library: 'p:M4.5 4.5h3.6v15H4.5zM10.2 4.5h3.6v15h-3.6z|p:m15.7 5.6 3.4-.9 3 13.9-3.4.9z',
  settings: 'p:M4 7.5h9M18 7.5h2M4 16.5h3M11 16.5h9|c:15.5 7.5 2.3|c:8.5 16.5 2.3',
  plus: 'p:M12 5v14M5 12h14',
  chevron: 'p:m9.5 6 6 6-6 6',
  out: 'p:M7.5 16.5 16.5 7.5M9.5 7.5h7v7',
  sparkle: 'p:M11 3.5 12.8 8.7 18 10.5l-5.2 1.8L11 17.5l-1.8-5.2L4 10.5l5.2-1.8Z|p:M18.5 15.5 19.2 17.3 21 18l-1.8.7-.7 1.8-.7-1.8L16 18l1.8-.7Z',
  warn: 'p:M12 4.2 2.8 19.8h18.4Z|p:M12 10v4.6|f:12 17.2 .9',
  refresh: 'p:M19.5 12a7.5 7.5 0 1 1-2.2-5.3|p:M19.6 3.8v4.3h-4.3',
  teach: 'p:M9.2 18h5.6M10.2 21h3.6|p:M12 3a6 6 0 0 0-3.7 10.7c.7.6 1.1 1.3 1.1 2.1v.4h5.2v-.4c0-.8.4-1.5 1.1-2.1A6 6 0 0 0 12 3Z',
  calendar: 'r:3.8 5 16.4 15 2|p:M3.8 9.6h16.4M8 3v3.6M16 3v3.6',
  play: 'p:M7.5 5.2v13.6a.6.6 0 0 0 .9.5l10.8-6.8a.6.6 0 0 0 0-1L8.4 4.7a.6.6 0 0 0-.9.5Z',
  flag: 'p:M5.5 21V4.5M5.5 5h11l-2.2 4 2.2 4h-11',
};
// More icons arrive with kit.js (the screens after the first).
export const addIcons = more => Object.assign(I, more);
export function icon(name, cls) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'navicon' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  for (const part of (I[name] || '').split('|')) {
    if (!part) continue;
    const kind = part[0], v = part.slice(2), n = v.split(' ').map(Number);
    let el;
    if (kind === 'p') { el = document.createElementNS(NS, 'path'); el.setAttribute('d', v); }
    else if (kind === 'c' || kind === 'f') {
      el = document.createElementNS(NS, 'circle');
      el.setAttribute('cx', n[0]); el.setAttribute('cy', n[1]); el.setAttribute('r', n[2]);
      if (kind === 'f') { el.setAttribute('fill', 'currentColor'); el.setAttribute('stroke', 'none'); }
    } else if (kind === 'r') {
      el = document.createElementNS(NS, 'rect');
      ['x', 'y', 'width', 'height', 'rx'].forEach((a, i) => el.setAttribute(a, n[i]));
    }
    if (el) svg.append(el);
  }
  return svg;
}

// ---- theme and Ember
const mq = matchMedia('(prefers-color-scheme: dark)');
export const theme = () => document.documentElement.dataset.theme || (mq.matches ? 'dark' : 'light');
export const onThemeChange = fn => mq.addEventListener('change', fn);

// The band word for a chip or topic: the reply's band, else from t1000; null means not seen yet.
export const bandText = t => (t && t.band) || bandWord(bandOf(t ? t.t1000 : null));

export function dot(t1000, lg) {
  const seen = t1000 != null && Number.isFinite(Number(t1000));
  const d = h('i', { class: `dot${seen ? '' : ' unseen'}${lg ? ' lg' : ''}`, 'aria-hidden': 'true' });
  if (seen) d.style.setProperty('--c', colourAt(Number(t1000), theme()));
  return d;
}


// ---- rings (inline SVG, filling on first paint)
export function ring(frac, { size = 72, stroke = 8, label = '', center, color = 'var(--accent)', track = 'var(--ring-track)' } = {}) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  const c = size / 2, r = c - stroke / 2, len = 2 * Math.PI * r;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`); svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const circ = cls => {
    const el = document.createElementNS(NS, 'circle');
    el.setAttribute('cx', c); el.setAttribute('cy', c); el.setAttribute('r', r.toFixed(2));
    el.setAttribute('fill', 'none'); el.setAttribute('stroke-width', stroke); el.setAttribute('class', cls);
    return el;
  };
  const t = circ('trk'); t.style.stroke = track; svg.append(t);
  if (f > 0) {
    const a = circ('arc');
    a.style.stroke = color;
    a.setAttribute('stroke-linecap', 'round');
    a.setAttribute('transform', `rotate(-90 ${c} ${c})`);
    a.setAttribute('stroke-dasharray', len.toFixed(2));
    a.style.strokeDashoffset = len.toFixed(2);
    requestAnimationFrame(() => requestAnimationFrame(() => { a.style.strokeDashoffset = (len * (1 - f)).toFixed(2); }));
    svg.append(a);
  }
  const box = h('div', { class: 'ring', role: 'img', 'aria-label': label || `${Math.round(f * 100)}%` });
  box.style.width = box.style.height = size + 'px';
  box.append(svg);
  if (center !== '') box.append(h('div', { class: 'mid', 'aria-hidden': 'true' }, center ?? `${Math.round(f * 100)}%`));
  return box;
}

// ---- controls
export function btn(label, onclick, kind = 'primary', ico, extra = {}) {
  return h('button', { type: 'button', class: `btn btn-${kind}${extra.cls ? ' ' + extra.cls : ''}`, onclick, ...extra.attrs }, ico ? icon(ico) : null, label);
}
export function linkBtn(label, href, kind = 'tinted', ico, external) {
  return h('a', { class: `btn btn-${kind}`, href, target: external ? '_blank' : null, rel: external ? 'noopener noreferrer' : null }, ico ? icon(ico) : null, label);
}
// ---- page pieces and states
export const loading = (n = 3) => h('div', { class: 'bento', 'aria-busy': 'true', 'aria-label': 'Loading' },
  Array.from({ length: n }, (_, i) => h('div', { class: `skel tile ${i ? 's6' : ''}` })));
export function state(ico, title, text, action, inline) {
  return h('div', { class: `state${inline ? ' inline' : ''}` }, icon(ico), h('b', null, title), text ? h('p', null, text) : null, action || null);
}
export function errorState(err, retry) {
  const offline = err && err.status === 0;
  const off = err && err.status === 404 && /switched off/i.test(err.message || '');
  return state(offline ? 'refresh' : off ? 'settings' : 'warn', offline ? 'You seem to be offline' : off ? 'This part is switched off' : 'That did not load',
    (err && err.message) || 'Something went wrong.',
    off ? linkBtn('Open Settings', '#settings') : retry ? btn('Try again', retry, 'tinted', 'refresh') : null);
}

// ---- formats (British)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function fmtDay(day) {
  if (!day) return '';
  const d = typeof day === 'number' ? new Date(day) : new Date(String(day).length === 10 ? day + 'T12:00:00' : day);
  if (Number.isNaN(d.getTime())) return String(day);
  const t = new Date(); t.setHours(12, 0, 0, 0);
  const diff = Math.round((t - new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12)) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return DAYS[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== t.getFullYear() ? ' ' + d.getFullYear() : ''}`;
}
export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
export function teachHref(topic, board, subject) {
  const q = `Teach me ${topic}${subject ? ` for ${board && board !== 'Other' ? board + ' ' : ''}${subject}` : ''}`;
  return 'https://claude.ai/new?q=' + encodeURIComponent(q);
}
export function scoreText(r) {
  if (r.out_of) return `${r.marks ?? 0}/${r.out_of}`;
  if (r.total_n) return `${r.right_n ?? 0}/${r.total_n}`;
  return '';
}
