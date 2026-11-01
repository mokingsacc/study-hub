import { get, patch, post, cached } from './api.js';
import { h, icon, state, btn, linkBtn, dot, bandText, askClaude } from './kit.js';
import { SKY, SKY_SWATCHES, SKY_VAR_NAMES, skyChoice, skyVars } from '../map/colour.js';

const ACCENTS = {
  blue: ['#0071e3', '#2997ff'], indigo: ['#4b4fd6', '#7d7aff'], purple: ['#8944ab', '#bf5af2'], pink: ['#c22f78', '#ff5c9a'],
  teal: ['#0e7c86', '#40c8e0'], green: ['#248a3d', '#30d158'], graphite: ['#3a3a3c', '#aeaeb2'],
};
const BACKGROUNDS = {
  warm: ['#faf6f0', '#15110c'], cool: ['#f1f5fb', '#0a0e15'], paper: ['#fbfaf7', '#121212'], mint: ['#f0f8f3', '#08130d'], lavender: ['#f6f3fb', '#110d18'],
};
const FONTS = {
  rounded: 'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
  serif: 'ui-serif, "New York", "Iowan Old Style", Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const ZOOM = { small: 0.92, normal: 1, large: 1.1, larger: 1.2 };
const CORNERS = { round: 1, soft: 0.6, square: 0.25 };
const ICONS = { star: 'sparkle', flag: 'flag', book: 'library', flask: 'grid', brain: 'teach', calc: 'results', pen: 'teach', clock: 'calendar', heart: 'sparkle', bolt: 'play' };

let current = { spec: 1 };
const root = document.documentElement;
const hex = (c, a) => { const n = parseInt(c.slice(1), 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; };

/** The CSS custom properties (and data-theme) for a theme, for the current light or dark. Pure. */
export function themeVars(t = {}, dark) {
  const v = {};
  const a = ACCENTS[t.accent];
  if (a) {
    const c = dark ? a[1] : a[0];
    Object.assign(v, { '--accent': c, '--accent-hover': c, '--accent-text': c, '--accent-soft': hex(c, dark ? 0.18 : 0.1), '--focus': hex(c, 0.6), '--ring-track': hex(c, dark ? 0.2 : 0.12) });
  }
  const b = BACKGROUNDS[t.background];
  if (b) Object.assign(v, { '--bg': dark ? b[1] : b[0], '--surface-2': dark ? b[1] : b[0] });
  if (FONTS[t.font]) Object.assign(v, { '--font': FONTS[t.font], '--font-display': FONTS[t.font] });
  const r = CORNERS[t.corners];
  if (r && r !== 1) for (const [k, px] of [['--r-xs', 6], ['--r-sm', 10], ['--r-md', 14], ['--r-lg', 20], ['--r-xl', 28]]) v[k] = `${Math.round(px * r)}px`;
  if (t.density === 'compact') Object.assign(v, { '--gap': '10px', '--pad': '14px' });
  return v;
}

const isDark = mode => mode === 'dark' || (mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);

/** Applies a spec's theme to the page now (and caches it for the next first paint). */
export function applyTheme(t = {}) {
  const mode = t.mode || 'auto';
  if (mode === 'auto') delete root.dataset.theme; else root.dataset.theme = mode;
  const vars = themeVars(t, isDark(mode));
  for (const k of [...root.style]) if (k.startsWith('--')) root.style.removeProperty(k);
  for (const [k, val] of Object.entries(vars)) root.style.setProperty(k, val);
  document.body.style.zoom = ZOOM[t.text_size] && ZOOM[t.text_size] !== 1 ? String(ZOOM[t.text_size]) : '';
  try { localStorage.setItem('sh-theme', JSON.stringify({ mode, vars, zoom: document.body.style.zoom })); } catch { /* private mode */ }
}

export const skyOf = (c = current) => { const t = (c && c.theme) || {}; return skyChoice({ sky_swatch: t.sky, sky_hue: t.sky_hue, sky_brightness: t.sky_brightness }); };
/** Sets a sky's --map-* properties on the map element for 'night' or 'light' (the other theme's are cleared). */
export function paintSky(el, choice, theme) {
  for (const n of [...SKY_VAR_NAMES.night, ...SKY_VAR_NAMES.light]) el.style.removeProperty(n);
  for (const [n, v] of Object.entries(skyVars(choice, theme))) el.style.setProperty(n, v);
}

function applyNav(c, app) {
  const hidden = new Set(((c.nav && c.nav.hidden) || []).map(x => (x === 'help' ? 'how' : x)));
  for (const a of document.querySelectorAll('[data-nav]')) {
    const id = a.dataset.nav;
    if (hidden.has(id)) a.dataset.mine = 'hidden'; else delete a.dataset.mine;
  }
  // Their own pages, in the side bar (iPad) and under More (phone).
  for (const old of document.querySelectorAll('[data-mypage]')) old.remove();
  const side = document.querySelector('.side nav') || document.querySelector('.side');
  const settings = side && side.querySelector('[data-nav="settings"]');
  for (const p of c.pages || []) {
    const a = h('a', { href: `#page/${encodeURIComponent(p.id)}`, 'data-nav': `page:${p.id}`, 'data-mypage': '1' }, icon(ICONS[p.icon] || 'sparkle', 'navicon'), p.title);
    if (settings) settings.before(a);
  }
  if (app) app.myPages = c.pages || [];
}

/** Today: their order, hidden tiles and greeting. tiles: elements carrying data-tile. */
export function arrangeTiles(tiles, c = current) {
  const t = c.today || {};
  const hidden = new Set(t.hidden || []);
  const order = t.order || [];
  const rank = el => { const i = order.indexOf(el.dataset.tile); return i < 0 ? order.length + tiles.indexOf(el) : i; };
  return tiles.filter(el => !hidden.has(el.dataset.tile)).sort((a, b) => rank(a) - rank(b));
}
export const greetingFor = (fallback, c = current) => (c.today && c.today.greeting) || fallback;

export function applyAll(c, app) {
  current = c && typeof c === 'object' ? c : { spec: 1 };
  applyTheme(current.theme || {});
  applyNav(current, app);
  if (app) app.custom = current;
  window.dispatchEvent(new CustomEvent('sh-custom'));   // the map repaints its sky
}

/** Called once after sign-in: fetch, apply, and re-apply when light or dark changes. */
let beating = 0;
export async function boot(app) {
  import('./report.js').then(m => m.listen(app)).catch(() => {});
  // The daily tracker (progress.js): a beat a minute while the page is open and in front of them.
  if (!beating) beating = setInterval(() => { if (app.me && !document.hidden) post('/api/p/activity', { seconds: 60 }).catch(() => {}); }, 6e4);
  try {
    applyAll((await get('/api/p/custom')).custom, app);
    // Today painted before these arrived: arrange it now.
    if (/^#?(today)?$/.test(location.hash) || location.hash === '#today') { const s = document.querySelector('#main .screen'); if (s) arrangeToday(s); }
  } catch { /* the hub works without it */ }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(current.theme || {}));
}

// ------------------------------------------------------------------ their own pages (#page/<id>)

function blockEl(b, app) {
  switch (b.type) {
    case 'heading': return h('h2', { class: 't-title3 mypage-h' }, b.text);
    case 'text': return h('div', { class: 'tile mypage-text' }, b.text.split(/\n{2,}/).map(p => h('p', null, p)));
    case 'checklist': {
      const box = h('section', { class: 'tile' }, b.title ? h('div', { class: 'tile-label' }, icon('cards'), b.title) : null);
      const list = h('div', { class: 'list' });
      b.items.forEach((it, i) => {
        const cb = h('input', { type: 'checkbox', checked: it.done || undefined, 'aria-label': it.text });
        cb.addEventListener('change', () => {
          // Ticks are theirs: saved into the same page block, undoable like any change.
          const pages = (current.pages || []).map(p => ({ ...p, blocks: p.blocks.map(x => (x === b ? { ...x, items: x.items.map((y, j) => (j === i ? { ...y, done: cb.checked } : y)) } : x)) }));
          patch('/api/p/custom', { patch: { pages } }).then(r => { current = r.custom; if (app) app.custom = current; }).catch(() => { cb.checked = !cb.checked; });
        });
        list.append(h('label', { class: 'li check-li' }, cb, h('span', { class: 'grow' }, it.text)));
      });
      box.append(list);
      return box;
    }
    case 'links': return h('section', { class: 'tile' }, b.title ? h('div', { class: 'tile-label' }, icon('out'), b.title) : null,
      h('div', { class: 'list' }, b.items.map(l => h('a', { class: 'li', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, h('span', { class: 'grow' }, l.label), icon('out', 'chev')))));
    case 'countdown': {
      const days = Math.ceil((Date.parse(b.date + 'T00:00:00') - Date.now()) / 86_400_000);
      return h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, icon('calendar'), b.label),
        h('div', { class: 'fig' }, h('span', { class: 't-display num' }, String(Math.max(0, days))), h('span', { class: 'unit' }, days === 1 ? 'day' : 'days')));
    }
    case 'topics': {
      const box = h('section', { class: 'tile' }, h('div', { class: 'tile-label' }, icon('flag'), b.title || 'Topics'), h('p', { class: 'foot' }, 'Loading…'));
      // A galaxy of theirs (by id or title), else a subject, else Today's weakest.
      const galaxy = b.galaxy ? (/^g_/.test(b.galaxy) ? Promise.resolve(b.galaxy) : get('/api/p/galaxies').then(r => { const g = (r.galaxies || []).find(x => x.title.toLowerCase() === b.galaxy.toLowerCase()); if (!g) throw new Error('gone'); return g.id; })) : null;
      const load = galaxy ? galaxy.then(id => get(`/api/p/galaxies/${encodeURIComponent(id)}`)) : get(b.subject_id ? `/api/p/subjects/${encodeURIComponent(b.subject_id)}` : '/api/p/today');
      load.then(d => {
        let list = galaxy ? (d.subjects || []).flatMap(s => s.topics) : b.subject_id ? (d.sections || []).flatMap(s => s.topics) : (d.weakest || []);
        if (b.show === 'not_seen') list = list.filter(x => !x.seen);
        if (b.show === 'weakest') list = list.filter(x => x.seen).sort((x, y) => (y.t1000 || 0) - (x.t1000 || 0)).slice(0, 8);
        box.replaceChildren(box.firstChild, list.length
          ? h('div', { class: 'weak-list' }, list.slice(0, 30).map(x => h('div', { class: 'weak-row' }, dot(x.t1000, true), h('span', { class: 'grow' }, h('span', { class: 'nm' }, x.name)), h('span', { class: 'bw' }, bandText(x)))))
          : h('p', { class: 'foot' }, 'Nothing here yet.'));
      }).catch(() => box.replaceChildren(box.firstChild, h('p', { class: 'foot' }, 'Could not load these topics.')));
      return box;
    }
    default: return null;
  }
}

export function renderPage(root, { param, app }) {
  const page = (current.pages || []).find(p => p.id === param);
  if (!page) {
    root.append(state('sparkle', 'This page is not here', 'Ask your Claude to make it again, or open Settings > Make it mine.', linkBtn('Settings', '#settings', 'tinted', 'settings')));
    return;
  }
  root.append(h('header', { class: 'head' }, h('div', { class: 'titles' }, h('div', { class: 't-micro' }, 'Your page'), h('h1', { class: 't-title1' }, page.title))),
    h('div', { class: 'stack mypage' }, page.blocks.map(b => blockEl(b, app))));
}

// ------------------------------------------------------------------ Settings: "Make it mine"

const LABELS = { accent: 'Colour', background: 'Background', mode: 'Light or dark', text_size: 'Text size', corners: 'Corners', density: 'Spacing', font: 'Font', sky: 'Map sky' };
// What a theme setting is when nothing is chosen (the hub's own look).
const DEFAULTS = { accent: 'blue', background: 'default', mode: 'auto', text_size: 'normal', corners: 'round', density: 'comfy', font: 'system', sky: SKY.swatch };
const SKY_NAMES = Object.fromEntries(SKY_SWATCHES.map(s => [s.id, s.label]));
const word = s => SKY_NAMES[s] || s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
// Today's tiles as they read on Today.
const TILE_NAMES = { setup: 'Getting started', learn: 'How it works', choice: 'Pick one to learn', subjects: 'Subject rings', galaxies: 'Your galaxies',
  cards: 'Cards due', weakest: 'Weakest five', results: 'Results', teach: 'Teach me', library: 'Library', paste: 'Paste from Claude', days: 'Your study days' };
const tileWord = id => TILE_NAMES[id] || word(id);
export const pct = b => `${Math.round(b * 100)}%`;
/** A range input that previews on input and saves on change. */
export function range(label, min, max, step, value, text, onInput, onSave) {
  const out = h('span', { class: 'mine-val' }, text(value));
  const r = h('input', { type: 'range', class: 'mine-range', min, max, step, value, 'aria-label': label, 'aria-valuetext': text(value) });
  r.addEventListener('input', () => { const v = Number(r.value); out.textContent = text(v); r.setAttribute('aria-valuetext', text(v)); if (onInput) onInput(v); });
  r.addEventListener('change', () => onSave(Number(r.value)));
  return h('label', { class: 'mine-row' }, h('span', null, label, ' ', out), r);
}

export function settingsPanel(app, onChange) {
  const box = h('section', { class: 'tile mine' });
  const draw = (data) => {
    const c = data.custom || { spec: 1 }, t = c.theme || {}, opts = data.options.theme;
    const rows = Object.entries(opts).map(([k, list]) => {
      const def = DEFAULTS[k] || list[0];
      const sel = h('select', { class: 'input', 'aria-label': LABELS[k] }, list.map(v => h('option', { value: v, selected: (t[k] || def) === v || undefined }, word(v))));
      sel.addEventListener('change', () => change({ theme: { [k]: sel.value === def ? null : sel.value } }));
      return h('label', { class: 'mine-row' }, h('span', null, LABELS[k]), sel);
    });
    const sk = skyOf(c), o = data.options.sky || { hue: { min: 0, max: 359 }, brightness: { min: SKY.min, max: SKY.max, step: 0.05 } };
    if (sk.swatch === 'custom') rows.push(range('Sky hue', o.hue.min, o.hue.max, 1, sk.h, v => `${v}°`, null, v => change({ theme: { sky: 'custom', sky_hue: v } })));
    rows.push(range('Sky brightness', o.brightness.min, o.brightness.max, o.brightness.step || 0.05, sk.brightness, pct, null,
      v => change({ theme: { sky_brightness: v === SKY.brightness ? null : v } })));
    // Today's tiles in their order, each with show or hide and Up and Down.
    const hidden = new Set((c.today && c.today.hidden) || []);
    const order = [...new Set([...((c.today && c.today.order) || []), ...data.options.tiles])].filter(id => data.options.tiles.includes(id));
    const move = (i, d) => { const next = order.slice(); [next[i], next[i + d]] = [next[i + d], next[i]]; change({ today: { order: next } }); };
    const tileRows = h('div', { class: 'list mine-tiles' }, order.map((id, i) => {
      const on = !hidden.has(id);
      const show = h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on), 'aria-label': `Show ${tileWord(id)} on Today` }, on ? 'Shown' : 'Hidden');
      show.addEventListener('click', () => { const next = new Set(hidden); if (on) next.add(id); else next.delete(id); change({ today: { hidden: [...next] } }); });
      return h('div', { class: 'li' }, h('span', { class: 'grow' }, tileWord(id)), show,
        h('button', { type: 'button', class: 'btn btn-gray btn-sm', 'aria-label': `Move ${tileWord(id)} up`, disabled: !i, onclick: () => move(i, -1) }, icon('arrowUp')),
        h('button', { type: 'button', class: 'btn btn-gray btn-sm', 'aria-label': `Move ${tileWord(id)} down`, disabled: i === order.length - 1, onclick: () => move(i, 1) }, icon('arrowDown')));
    }));
    // Tabs they can hide (How it works and Settings always stay).
    const navHidden = new Set(((c.nav && c.nav.hidden) || []).map(x => (x === 'help' ? 'how' : x)));
    const tabToggles = h('div', { class: 'chips' }, data.options.tabs.filter(id => id !== 'how').map(id => {
      const on = !navHidden.has(id);
      const b = h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on) }, word(id));
      b.addEventListener('click', () => { const next = new Set(navHidden); if (on) next.add(id); else next.delete(id); change({ nav: { hidden: [...next] } }); });
      return b;
    }));
    const asks = ['Make a galaxy called Mock 1 with my weakest Biology topics', 'Add a page with a checklist of my required practicals', 'Make my hub purple with bigger text'];
    box.replaceChildren(
      h('div', { class: 'tile-label' }, icon('sparkle'), 'Make it mine'),
      h('p', { class: 'foot' }, 'Only your hub changes. Or just tell your Claude, for example: “make my hub purple with bigger text”, “put cards first on Today”, “add a page with a checklist of my chemistry required practicals”, “teach me with more diagrams”.'),
      h('div', { class: 'mine-grid' }, rows),
      h('div', { class: 't-micro', style: 'margin-top:12px' }, 'On Today, in this order'), tileRows,
      h('div', { class: 't-micro', style: 'margin-top:12px' }, 'Tabs'), tabToggles,
      h('div', { class: 't-micro', style: 'margin-top:12px' }, 'Or ask your Claude'),
      h('div', { class: 'hw-tries' }, asks.map(w => askClaude(w, h('span', null, `“${w}”`), { app, cls: 'hw-try', ico: 'sparkle' }))),
      (c.pages || []).length ? h('p', { class: 'foot' }, `Your pages: ${c.pages.map(p => p.title).join(', ')}`) : null,
      c.teach && c.teach.notes ? h('p', { class: 'foot' }, `How you like to be taught: ${c.teach.notes}`) : null,
      h('div', { class: 'row-acts' },
        btn('Undo', () => post('/api/p/custom/undo').then(done, fail), 'gray', 'refresh', { attrs: { disabled: !data.undo_left || undefined } }),
        btn('Start again', () => post('/api/p/custom/reset').then(done, fail), 'gray'),
        h('a', { class: 'btn btn-gray', href: '/api/p/custom/export', download: 'my-study-hub.json' }, 'Export'),
        btn('Recent changes', () => import('./recent.js').then(m => m.recentSheet(app, () => app.route())), 'gray', 'undo')));
  };
  const done = r => { applyAll(r.custom, app); refresh(); if (onChange) onChange(r.changed); };
  const fail = e => { if (onChange) onChange((e && e.message) || 'That did not work.', true); };
  const change = p => patch('/api/p/custom', { patch: p }).then(done, fail);
  const refresh = () => get('/api/p/custom').then(draw).catch(() => box.replaceChildren(h('p', { class: 'foot' }, 'Make it mine could not load.')));
  const have = cached('/api/p/custom');
  if (have) draw(have); else box.append(h('p', { class: 'foot' }, 'Loading…'));
  refresh();
  return box;
}

/** Today, after its first paint: their tile order, hidden tiles and greeting (moves the existing nodes). */
export function arrangeToday(screen, c = current) {
  const bento = screen.querySelector('.bento');
  if (!bento) return;
  const tiles = [...bento.children];
  const keep = arrangeTiles(tiles.filter(el => el.dataset.tile), c);
  for (const el of tiles) if (el.dataset.tile && !keep.includes(el)) el.remove();
  for (const el of keep) bento.append(el);
  const g = c.today && c.today.greeting;
  const h1 = screen.querySelector('.hello h1');
  if (g && h1) h1.textContent = g;
}
