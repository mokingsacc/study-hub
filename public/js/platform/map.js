import { getTagged, get, put, patch } from './api.js';
import { h, icon, btn, linkBtn, theme, dot, addIcons, plural } from './kit.js';
import { decode as decodeMo, bounds, loudOf, loadCached, saveCached, counts, radiusOf } from '../map/data.js';
import { STOPS_DARK, STOPS_LIGHT, EDGES_LIGHT } from '../map/scale.js';
import { palette, readTokens, bucketOf, SKY, SKY_SWATCHES, skyChoice, skySample, skyNeutral } from '../map/colour.js';
import { skyOf, paintSky, applyAll, pct } from './custom.js';
import { readTokens as readLinkTokens, buildCurves } from '../map/links-draw.js';
import { createTweens } from '../map/tween.js';
import { createPicker } from '../map/pick.js';
import { buildHalos, skyParts, buildHaze, releaseHaze } from '../map/halos.js';
import { capFor, priority } from '../map/labels.js';
import { createLayers, drawScene, drawOver, dotScaleFor } from '../map/render.js';
import { createSky } from '../map/sky.js';
import { setFamilies } from '../map/donut.js';
import { createFamilies } from '../map/families.js';
import { createHover, isTap } from '../map/hover.js';
import { selectLinks, densityLimit } from '../shared/link-rank.js';
import { createCamera } from './map-camera.js';

addIcons({
  minus: 'p:M5 12h14',
  fit: 'p:M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5|f:12 12 2.2',
  list: 'p:M9 6.5h11M9 12h11M9 17.5h11|f:4.5 6.5 1.2|f:4.5 12 1.2|f:4.5 17.5 1.2',
  moon: 'p:M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
});

const PATH = '/api/p/map';
const MAX_COORD = 100_000;   // worker/src/map/positions.js: a saved coordinate's bound
const TWEEN_MS = 600, APPEAR_MS = 400, SYSTEM_MS = 750;
const okXY = v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
const whenIdle = fn => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 900));
let layoutMod = null;
const layoutJs = () => (layoutMod = layoutMod || import('../map/layout.js'));

export const SCHOOL_YIELD = 45;
export function decode(payload) {
  const m = decodeMo(payload);
  // Their own galaxies (platform/map.js regroup): each category's kind ('subject', 'section', 'galaxy') and what it
  // stands for, and the home subject of a topic drawn in one of their galaxies.
  const groups = Array.isArray(payload && payload.groups) ? payload.groups : [];
  for (const c of m.cats) { const g = groups.find(x => x.id === c.id); c.kind = g ? g.kind : 'subject'; c.ref = g ? g.ref : c.id; c.parent = g && g.parent; }
  m.home = (payload && payload.home) || {};
  const fams = Array.isArray(payload && payload.families) ? payload.families : m.cats.map(c => ({ id: c.id, name: c.name, members: [c.id] }));
  setFamilies(fams);
  m.families = fams.map(f => ({ id: f.id, name: f.name, cats: f.members.map(id => m.cats.findIndex(c => c.id === id)).filter(i => i >= 0) })).filter(f => f.cats.length);
  if (m.n && m.yield100.every(y => y === 0)) for (let i = 0; i < m.n; i++) { m.yield100[i] = SCHOOL_YIELD; m.r[i] = radiusOf(SCHOOL_YIELD); }
  return m;
}

const labelTier = (y100, t) => (y100 >= 70 && t >= 600 ? 1 : y100 >= 85 ? 2 : 3);
// A family's colour on its chip: the weakness of its galaxies, weighted by their topics.
const familyT = (m, f) => { let s = 0, n = 0; for (const c of f.cats) { const x = m.cats[c]; if (x && x.t1000 != null && x.n) { s += x.t1000 * x.n; n += x.n; } } return n ? s / n : null; };

let live = null, teardown = 0;

export function render(root, { app, param }) {
  clearTimeout(teardown);
  if (live && live.alive) live.reattach(root, param);
  else live = mount(root, app, param);
  app.onReturn = () => { if (live && live.alive) live.reload(); };
  return () => {
    // Another #map address keeps the map (render() runs again first); any other page tears it down.
    teardown = setTimeout(() => { if (live && !/^#map(\/|$)/.test(location.hash)) { live.destroy(); live = null; } }, 0);
  };
}

function mount(host, app, firstParam) {
  document.body.classList.add('pmap-on');
  const abort = new AbortController();
  const on = (el, type, fn, opts) => el.addEventListener(type, fn, { ...(opts || {}), signal: abort.signal });
  const scene = h('canvas', { class: 'pm-canvas pm-scene', tabindex: '0', role: 'application', 'aria-roledescription': 'topic map',
    'aria-label': 'Your map. Each subject is a galaxy and each topic a star, coloured by how weak it is. Tap a star to open its topic. The same topics are listed under Subjects.' });
  const namesC = h('canvas', { class: 'pm-canvas pm-names', 'aria-hidden': 'true' });
  const overC = h('canvas', { class: 'pm-canvas pm-over', 'aria-hidden': 'true' });
  const countsEl = h('p', { class: 'pm-sub' });
  const chips = h('div', { class: 'pm-chips', role: 'group', 'aria-label': 'Galaxies' });
  const listLink = linkBtn('List', '#subjects', 'glass', 'list');
  // Their own galaxies: make one, reorder, lay the rest out by subject or section (galaxies.js).
  const galaxiesBtn = btn('Galaxies', () => import('./galaxies.js').then(m => m.galaxiesSheet(app, () => load())), 'glass', 'sparkle');
  const top = h('div', { class: 'pm-top' }, h('div', { class: 'pm-head' }, h('div', { class: 'pm-titles' }, h('h1', null, 'Map'), countsEl), h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, galaxiesBtn, listLink)), chips);
  const zoomBtn = (label, ico, fn) => h('button', { type: 'button', class: 'pm-btn', 'aria-label': label, title: label, onclick: fn }, icon(ico));
  const skyBtn = zoomBtn('Sky colour', 'moon', () => skyOpen(skyPop.hidden));
  const skyPop = h('div', { class: 'pm-skypop', id: 'pm-skypop', role: 'dialog', 'aria-label': 'Sky colour', hidden: true });
  skyBtn.setAttribute('aria-expanded', 'false'); skyBtn.setAttribute('aria-controls', 'pm-skypop');
  const zoom = h('div', { class: 'pm-zoom' }, skyBtn, h('div', { class: 'pm-zoomset', role: 'group', 'aria-label': 'Zoom' },
    zoomBtn('Zoom in', 'plus', () => S.cam && S.cam.zoomBy(1.6)), zoomBtn('Zoom out', 'minus', () => S.cam && S.cam.zoomBy(1 / 1.6)),
    zoomBtn('The whole map', 'fit', () => wholeMap(true))));
  const key = h('div', { class: 'pm-key', 'aria-label': 'Colour key' });
  const status = h('div', { class: 'pm-status', role: 'status' });
  const say = h('div', { class: 'sr', 'aria-live': 'polite' });
  const el = h('section', { class: 'pmap', 'aria-label': 'Map' }, scene, namesC, overC, top, zoom, skyPop, key, status, say);
  host.replaceChildren(el);
  const sky = createSky(el);
  const families = createFamilies(el);
  const beadLayer = h('div', { class: 'pm-beads', 'aria-label': 'Due on the map' });
  overC.after(beadLayer);
  const beads = {
    data: null, list: [], forModel: null, forData: null, forKey: '',
    load() { get('/api/p/map/beads').then(d => { if (alive) { beads.data = d; beads.build(); redraw(); } }).catch(() => {}); },
    build() {
      const m = S.model, d = beads.data;
      beads.forModel = m; beads.forData = d; beads.forKey = m ? `${m.layoutVersion}|${!!S.portrait}|${S.arranging ? 1 : 0}` : '';
      beadLayer.replaceChildren();
      beads.list = [];
      if (!m || !d) return;
      const sums = new Map();
      for (let i = 0; i < m.n; i++) {
        if (!m.placed[i]) continue;
        let g = sums.get(m.cat[i]);
        if (!g) sums.set(m.cat[i], (g = { x: 0, y: 0, n: 0, list: [], due: 0 }));
        g.x += m.x[i]; g.y += m.y[i]; g.n++; g.list.push(i); g.due += d.cards[m.id[i]] || 0;
      }
      const mnemonicsDone = new Set();
      for (const [c, g] of sums) {
        const cat = m.cats[c];
        if (!cat) continue;
        const cx = g.x / g.n, cy = g.y / g.n;
        let R = 0;
        for (const i of g.list) R = Math.max(R, Math.hypot(m.x[i] - cx, m.y[i] - cy) + (m.r[i] || 0));
        const subject = cat.kind === 'section' ? cat.parent : cat.kind === 'subject' ? cat.id : null;
        const mn = subject && !mnemonicsDone.has(subject) && d.mnemonics[subject] ? d.mnemonics[subject] : null;
        if (mn) mnemonicsDone.add(subject);
        const els = [];
        if (g.due) els.push(h('a', { class: 'pm-bead cards', href: '#cards/review', 'aria-label': `${g.due} cards due in ${cat.name}` }, icon('cards'), h('b', null, String(g.due))));
        if (mn && (mn.due || mn.new)) els.push(h('a', { class: 'pm-bead mn', href: `#mnemonics/${encodeURIComponent(subject)}`, 'aria-label': `${mn.due + mn.new} mnemonics to test` }, icon('teach'), h('b', null, String(mn.due + mn.new))));
        if (!els.length) continue;
        const box = h('div', { class: 'pm-bead-set' }, els);
        beadLayer.append(box);
        beads.list.push({ box, cx, cy, R });
      }
    },
    place() {
      if (beads.forModel !== S.model || beads.forData !== beads.data || beads.forKey !== `${S.model.layoutVersion}|${!!S.portrait}|${S.arranging ? 1 : 0}`) beads.build();
      const t = S.cam.transform, show = !S.arranging && S.cam.ratio() < 3;
      beadLayer.hidden = !show;
      if (!show) return;
      for (const b of beads.list) {
        const x = t.x + t.k * (b.cx + b.R * 0.72), y = t.y + t.k * (b.cy - b.R * 0.72);
        b.box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      }
    },
  };

  const S = {
    model: null, pal: null, tokens: null, linkTokens: null, halos: null, skyParts: null, haze: null, curves: null, picker: null, cam: null,
    linkSel: [], dim: null, spot: null, spotLinks: [], selected: -1, forcedLabels: new Set(), labelOrder: [], labelCap: 45, labelTier: () => 3,
    glows: true, lowPower: false, linksAtRestOnly: false, blocked: [], system: null,
    hover: createHover(), tweens: createTweens(), appear: createTweens(),
    hoverCache: { node: -1, links: [], nb: [] },
    hoverLinks: i => hoverFor(i).links, hoverNeighbours: i => hoverFor(i).nb,
    canon: new Map(), etag: null, key: `p:${(app.me && app.me.user) || 'me'}`,
  };
  // Arranged once on this device: later re-arranges (a galaxy changed) settle in place without the card.
  const arrangedKey = `sh-map-arranged:${(app.me && app.me.user) || 'me'}`;
  try { S.everArranged = localStorage.getItem(arrangedKey) === '1'; } catch { S.everArranged = false; }
  const arrangedOnce = () => { if (S.everArranged) return; S.everArranged = true; try { localStorage.setItem(arrangedKey, '1'); } catch { /* private mode */ } };
  let layers = null, alive = true, want = firstParam || null, userMoved = false, cameraSet = false;
  const redraw = () => { if (layers) layers.request('both'); };
  const redrawOver = () => { if (layers) layers.request('over'); };

  let trying = null, skyTimer = 0;
  const skyTheme = () => (el.dataset.sky === 'night' ? 'night' : 'light');
  function skyColours() { S.sky = trying || skyOf(app.custom); paintSky(el, S.sky, skyTheme()); S.tokens = readTokens(el); S.linkTokens = readLinkTokens(getComputedStyle(el)); }
  function applySky() {
    const night = theme() === 'dark';
    el.dataset.sky = night ? 'night' : 'light';
    sky.show(night);
    skyColours();
    S.pal = palette(night ? 'night' : 'light', { stops: STOPS_DARK, stopsLight: STOPS_LIGHT, edgesLight: EDGES_LIGHT, dpr: layers ? layers.dpr : 2, unseen: night ? S.tokens['--map-unseen'] : null });
    if (S.model) { rebuildHalos(); paintChrome(); }
    drawKey();
    redraw();
  }
  // A swatch or slider: the sky's CSS follows at once, the haze at most every 100 ms; the choice saves on release.
  function trySky(p, save) {
    trying = skyChoice(p);
    skyColours();
    const rb = skyPop.querySelector('.pm-skyreset'); if (rb) rb.hidden = trying.swatch === SKY.swatch && trying.brightness === SKY.brightness;
    if (!skyTimer) skyTimer = setTimeout(() => { skyTimer = 0; if (alive && S.model) { rebuildHalos(); redraw(); } }, 100);
    if (!save) return;
    const c = trying, custom = c.swatch === 'custom';
    patch('/api/p/custom', { patch: { theme: { sky: c.swatch === SKY.swatch ? null : c.swatch, sky_hue: custom ? c.h : null, sky_brightness: c.brightness === SKY.brightness ? null : c.brightness } } })
      .then(r => { trying = null; applyAll(r.custom, app); }, () => { trying = null; applySky(); say.textContent = 'The sky could not be saved. Try again.'; });
  }
  function skyOpen(open) {
    skyPop.hidden = !open;
    skyBtn.setAttribute('aria-expanded', String(open));
    if (open) { drawSkyPop(); const f = skyPop.querySelector('[aria-pressed="true"]'); if (f) f.focus(); }
  }
  function drawSkyPop() {
    const c = trying || skyOf(app.custom), th = skyTheme();
    const p = { sky_swatch: c.swatch, sky_hue: c.h, sky_brightness: c.brightness };
    const hues = [0, 60, 120, 180, 240, 300, 360].map(x => skySample(skyChoice({ sky_swatch: 'custom', sky_hue: x % 360 }), th)).join(', ');
    const sw = (id, label, bg) => h('button', { type: 'button', class: 'pm-sw', 'aria-pressed': String(c.swatch === id), 'aria-label': label, title: label, style: `background:${bg}`,
      onclick: () => { trySky({ ...p, sky_swatch: id }, true); drawSkyPop(); skyPop.querySelector(`[title="${label}"]`).focus(); } });
    const slide = (label, min, max, step, value, text, key) => {
      const r = h('input', { type: 'range', min, max, step, value, 'aria-label': label, 'aria-valuetext': text(value) });
      const out = h('span', null, text(value));
      r.addEventListener('input', () => { const v = Number(r.value); out.textContent = text(v); r.setAttribute('aria-valuetext', text(v)); trySky({ ...p, [key]: v }); });
      r.addEventListener('change', () => { p[key] = Number(r.value); trySky(p, true); });
      return h('label', { class: 'pm-skyrow' }, h('span', null, label, ' · ', out), r);
    };
    const isDefault = c.swatch === SKY.swatch && c.brightness === SKY.brightness;
    skyPop.replaceChildren(
      h('div', { class: 'pm-skyhead' }, h('b', null, 'Sky · ', c.label), h('button', { type: 'button', class: 'pm-skyreset', hidden: isDefault,
        onclick: () => { trySky({}, true); drawSkyPop(); skyPop.querySelector('[aria-pressed="true"]').focus(); } }, 'Reset')),
      h('div', { class: 'pm-sws' }, SKY_SWATCHES.map(s => sw(s.id, s.label, skySample(skyChoice({ sky_swatch: s.id }), th))), sw('custom', 'Custom', `conic-gradient(${hues})`)),
      c.swatch === 'custom' ? slide('Hue', 0, 359, 1, c.h, v => `${v}°`, 'sky_hue') : null,
      slide('Brightness', SKY.min, SKY.max, 0.05, c.brightness, pct, 'sky_brightness'));
  }
  on(skyPop, 'keydown', e => { if (e.key === 'Escape') { skyOpen(false); skyBtn.focus(); } });
  on(document, 'pointerdown', e => { if (!skyPop.hidden && !skyPop.contains(e.target) && !skyBtn.contains(e.target)) skyOpen(false); });
  on(window, 'sh-custom', () => { if (!trying) applySky(); });

  function hoverFor(i) {
    const c = S.hoverCache;
    if (c.node === i && c.model === S.model) return c;
    const m = S.model;
    const links = i >= 0 && m ? selectLinks({ mode: 'hover', node: i }, { links: m.links, t1000: j => (m.t[j] < 0 ? null : m.t[j]), yield100: m.yield100 }) : [];
    const nb = [], seen = new Set();
    for (const k of links) { const l = m.links[k], j = l[0] === i ? l[1] : l[0]; if (!seen.has(j)) { seen.add(j); nb.push(j); } }
    Object.assign(c, { node: i, model: m, links, nb });
    return c;
  }
  function rebuildHalos() {
    const m = S.model;
    S.halos = buildHalos(m, { colourOf: t => S.pal.colourOf(t), unseenHex: S.pal.unseen });
    const night = S.pal.theme !== 'light', b = (S.sky && S.sky.brightness) || 1;
    S.skyParts = skyParts(m, S.halos, { colourOf: t => S.pal.colourOf(t), neutral: skyNeutral(S.sky || skyChoice(), S.pal.theme) });
    releaseHaze(S.haze);
    S.haze = buildHaze(m, S.skyParts, { glowSprite: t => S.pal.glows[bucketOf(t)], night, glowScale: night ? 0.5 + 0.5 * b : 1,
      loudOf: i => loudOf(m.yield100[i] / 100) });
  }
  function rebuildCurves() {
    const m = S.model, b = bounds(m);
    S.curves = buildCurves(m.links, m.x, m.y, m.cat, b ? [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] : [0, 0]);
  }
  function rebuildLinks() {
    const m = S.model;
    S.linkSel = selectLinks({ mode: 'default', limit: innerWidth < 640 ? 800 : densityLimit('normal'), visible: () => true },
      { links: m.links, t1000: j => (m.t[j] < 0 ? null : m.t[j]), yield100: m.yield100 });
  }
  function rebuildLabels() {
    const m = S.model;
    const tier = new Uint8Array(m.n);
    for (let i = 0; i < m.n; i++) tier[i] = labelTier(m.yield100[i], m.t[i]);
    S.labelTier = i => tier[i];
    S.labelOrder = Array.from({ length: m.n }, (_, i) => i).sort((a, b) => tier[a] - tier[b] || priority(m.yield100[b], m.t[b]) - priority(m.yield100[a], m.t[a]));
    S.labelCap = capFor(layers ? layers.w : innerWidth, 'normal');
  }
  function everything() {
    S.picker = createPicker(S.model);
    rebuildHalos(); rebuildCurves(); rebuildLinks(); rebuildLabels();
    S.hoverCache.node = -2;
    S.hoverLay = null; S.nameCache = null; S.lastPlace = null;
    if (S.cam) S.cam.setBounds(bounds(S.model));
    paintChrome();
  }

  // ---- the frame: counts, subject chips, key, status
  function paintChrome() {
    const m = S.model;
    if (!m) return;
    const c = counts(m);
    countsEl.textContent = m.n ? [plural(c.topics, 'topic'), c.weak ? `${c.weak} weak` : null, c.unseen ? `${c.unseen} not seen yet` : null].filter(Boolean).join(' · ') : '';
    const subs = m.cats.filter(cat => cat.n > 0);
    const chip = (label, fn, pressed, extra) => h('button', { type: 'button', class: 'pm-chip', 'aria-pressed': String(pressed), onclick: fn }, extra, label);
    // A chip a family (a subject, or their own galaxies): it flies to all its galaxies.
    const fams = (m.families || []).filter(f => f.cats.some(c => m.cats[c] && m.cats[c].n > 0));
    chips.replaceChildren(
      subs.length > 1 ? chip('All', () => pickSubject(-1), S.system == null && S.family == null) : null,
      ...fams.map(f => chip(f.name, () => fitFamily(f), S.family === f.id, dot(familyT(m, f)))),
      h('button', { type: 'button', class: 'pm-chip pm-changed', 'aria-pressed': String(!!changed), onclick: toggleChanged }, icon('clock'), changed ? `Changed today (${changed.size})` : 'Changed today'));
    const sel = S.system != null ? m.cats[S.system] : null;
    listLink.setAttribute('href', !sel ? '#subjects' : sel.kind === 'galaxy' ? `#galaxy/${encodeURIComponent(sel.ref)}` : `#subject/${encodeURIComponent(sel.kind === 'section' ? sel.parent : sel.id)}`);
    reblock();
  }
  // "Changed today": the topics changed in the last 24 hours stay lit and the rest dim (GET /api/p/map/recent).
  let changed = null;
  async function toggleChanged() {
    if (changed) { changed = null; S.dim = null; paintChrome(); redraw(); return; }
    try {
      const d = await get('/api/p/map/recent?hours=24');
      const m = S.model;
      if (!m || !alive) return;
      changed = new Set();
      for (const t of d.topics || []) { const i = m.index.get(t.id); if (i != null) changed.add(i); }
      S.dim = changed.size ? Array.from({ length: m.n }, (_, i) => (changed.has(i) ? 0 : 1)) : null;
      say.textContent = changed.size ? `${plural(changed.size, 'topic')} changed today` : 'Nothing changed today';
      paintChrome(); redraw();
    } catch (e) { say.textContent = (e && e.message) || 'What changed could not load.'; }
  }
  function drawKey() {
    const row = [[100, 'Strong'], [300, 'Getting there'], [500, 'Shaky'], [700, 'Weak'], [900, 'Very weak'], [null, 'Not seen yet']];
    key.replaceChildren(...row.map(([t, w]) => h('span', null, dot(t), w)));
  }
  function setStatus(kind, title, text, action) {
    status.hidden = !kind;
    status.dataset.kind = kind || '';
    if (!kind) { status.replaceChildren(); return; }
    status.replaceChildren(h('div', { class: 'pm-card' }, kind === 'busy' ? h('div', { class: 'pm-spin', 'aria-hidden': 'true' }) : icon(kind === 'error' ? 'warn' : 'sparkle'),
      h('b', null, title), text ? h('p', null, text) : null, action || null));
  }

  // ---- what names must keep clear of: the map's own buttons, in canvas px
  function measureBlocked() {
    const c = scene.getBoundingClientRect();
    const out = [];
    for (const b of el.querySelectorAll('.pm-head > *, .pm-chip, .pm-zoom > *, .pm-key')) {
      if (b.offsetParent === null) continue;
      const r = b.getBoundingClientRect();
      if (r.width && r.height) out.push({ x: r.left - c.left - 2, y: r.top - c.top - 2, w: r.width + 4, h: r.height + 4 });
    }
    S.blocked = out;
  }
  let blockTimer = 0;
  const reblock = () => { clearTimeout(blockTimer); blockTimer = setTimeout(() => { if (alive) { measureBlocked(); redraw(); } }, 60); };

  function fitSystem(c, ms = SYSTEM_MS) {
    const m = S.model;
    const list = [];
    for (let i = 0; i < m.n; i++) if (m.cat[i] === c && m.placed[i]) list.push(i);
    if (!list.length) return;
    S.system = c; S.family = null;
    S.hover.clear(performance.now());
    const b = bounds(m, list);
    if (!S.blocked.length) measureBlocked();
    const topPx = Math.max(0, ...S.blocked.filter(r => r.y < S.cam.size.h / 3).map(r => r.y + r.h));
    const pad = Math.max(40, Math.min(innerWidth, innerHeight) * 0.08);
    const k = Math.min((S.cam.size.w - 2 * pad) / Math.max(1, b.x1 - b.x0), (S.cam.size.h - topPx - 2 * pad - 40) / Math.max(1, b.y1 - b.y0));
    S.cam.fit({ x0: b.x0 - 6, y0: b.y0 - (40 + topPx) / Math.max(1e-3, k), x1: b.x1 + 6, y1: b.y1 + 8 }, { ms, pad, maxRatio: 6 });
    say.textContent = `${m.cats[c] ? m.cats[c].name : 'Subject'}.`;
    paintChrome();
    redraw();
  }
  // A whole family (a subject's sections, or their own galaxies) on screen.
  function fitFamily(f, ms = SYSTEM_MS) {
    const m = S.model, set = new Set(f.cats), list = [];
    for (let i = 0; i < m.n; i++) if (set.has(m.cat[i]) && m.placed[i]) list.push(i);
    if (!list.length) return;
    S.system = null; S.family = f.id;
    const b = bounds(m, list);
    S.cam.fit({ x0: b.x0 - 20, y0: b.y0 - 60, x1: b.x1 + 20, y1: b.y1 + 20 }, { ms, pad: Math.max(40, Math.min(innerWidth, innerHeight) * 0.08), maxRatio: 4 });
    say.textContent = `${f.name}.`;
    paintChrome(); redraw();
  }
  function wholeMap(byUser) {
    S.system = null; S.family = null;
    if (S.model && S.cam) S.cam.fit(mapBounds(), { ms: byUser ? SYSTEM_MS : 0 });
    if (byUser) { userMoved = false; setHash(null); }
    paintChrome();
    redraw();
  }
  function mapBounds() {
    const b = bounds(S.model);
    if (!b || !S.cam) return b;
    const { w, h: hh } = S.cam.size;
    if (!S.blocked.length) measureBlocked();
    const topPx = Math.max(0, ...S.blocked.filter(r => r.y < hh / 3).map(r => r.y + r.h));
    const bottom = Math.max(0, ...S.blocked.filter(r => r.y > (2 * hh) / 3).map(r => hh - r.y));
    const pad = w < 640 ? 24 : 48, title = 46, margin = 12;
    const k = Math.max(1e-3, Math.min((w - 2 * pad) / Math.max(1, b.x1 - b.x0), (hh - topPx - bottom - title - 2 * margin) / Math.max(1, b.y1 - b.y0)));
    return { ...b, y0: b.y0 - (title + topPx + margin - pad) / k, y1: b.y1 + Math.max(0, bottom + margin - pad) / k };
  }
  function pickSubject(c) {
    if (!S.model) return;
    if (c < 0) { wholeMap(true); return; }
    setHash(S.model.cats[c].id);
    fitSystem(c);
  }
  function setHash(sub) {
    want = sub;
    const next = sub ? `#map/${encodeURIComponent(sub)}` : '#map';
    if (location.hash !== next) history.replaceState(history.state, '', next);
  }
  function applyRoute(sub, ms) {
    want = sub;
    if (!S.model || !S.cam || S.arranging) return;
    const c = sub ? S.model.catIndex.get(sub) : undefined;
    if (c != null) fitSystem(c, ms);
    else if (S.system != null || !userMoved) wholeMap(false);
  }

  // ---- the galaxy title, or the galaxy's own sky, under a point (canvas px)
  const titleAt = (x, y) => {
    const p = S.placed;
    if (!p) return -1;
    for (const c of p.cats) if (x >= c.box.x - 4 && x <= c.box.x + c.box.w + 4 && y >= c.box.y - 4 && y <= c.box.y + c.box.h + 4) return c.c;
    return -1;
  };
  const galaxyAt = (x, y) => {
    if (!S.halos || S.cam.ratio() > 2.2) return -1;
    const [wx, wy] = S.cam.toWorld(x, y);
    let best = -1, bestD = Infinity;
    for (const g of S.halos) {
      const d = Math.hypot(wx - g.cx, wy - g.cy) / Math.max(1, g.R - 12);
      if (d < 1 && d < bestD && g.c !== S.system) { best = g.c; bestD = d; }
    }
    return best;
  };
  const pickAt = (cx, cy, touch) => {
    if (!S.model || !S.picker) return -1;
    const r = scene.getBoundingClientRect();
    const [wx, wy] = S.cam.toWorld(cx - r.left, cy - r.top);
    const k = S.cam.transform.k, ds = dotScaleFor(S.cam.ratio()), hv = S.hover.node;
    return S.picker.nearest(wx, wy, (touch ? 12 : 6) / k, null, i => ds * (i === hv ? 1.8 : 1), touch ? 10 / k : 0);
  };

  // ---- the topic sheet
  async function openTopic(i) {
    const m = S.model;
    if (i < 0 || i >= m.n) return;
    S.selected = i;
    S.hover.clear(performance.now());
    redraw();
    const drawnIn = m.cats[m.cat[i]];
    const home = m.home[m.id[i]];
    const cat = home ? { id: home[0], name: home[1] } : drawnIn && drawnIn.kind === 'section' ? { id: drawnIn.parent, name: drawnIn.name.split(': ')[0] } : drawnIn;
    const band = (m.meta.bands || [])[m.band[i]];
    say.textContent = `${m.name[i]} opened.`;
    const mod = await import('./topic.js');
    mod.openTopicSheet({ id: m.id[i], name: m.name[i], t1000: m.t[i] < 0 ? null : m.t[i], band: m.t[i] < 0 ? 'Not seen yet' : band ? band[1] : null,
      subject_id: cat ? cat.id : null, subject_name: cat ? cat.name : null }, {
      app,
      onClose: () => { if (!alive) return; S.selected = -1; redraw(); try { scene.focus({ preventScroll: true }); } catch { /* gone */ } },
      onTopic: id => { const j = S.model.index.get(id); if (j != null) { S.selected = j; if (S.model.placed[j]) S.cam.ensureVisible(S.model.x[j], S.model.y[j]); redraw(); } },
    });
  }

  // ---- pointer: a tap opens; a mouse hovers (one pick per frame)
  let down = null, fingers = 0, multi = false, moveEv = null, moveRaf = 0;
  on(scene, 'pointerdown', e => {
    fingers++;
    if (fingers > 1) multi = true;
    else { multi = false; down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; }
  });
  const lift = e => {
    fingers = Math.max(0, fingers - 1);
    const d = down;
    if (!d || d.id !== e.pointerId) return null;
    down = null;
    return multi || e.type === 'pointercancel' ? null : d;
  };
  on(scene, 'pointercancel', lift);
  on(scene, 'pointerup', e => {
    const d = lift(e);
    if (!d || !S.model || !isTap(d, { x: e.clientX, y: e.clientY, t: performance.now() })) return;
    const touch = e.pointerType !== 'mouse';
    const r = scene.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const direct = pickAt(e.clientX, e.clientY, false);
    const title = direct < 0 ? titleAt(x, y) : -1;
    if (title >= 0) { setHash(S.model.cats[title].id); fitSystem(title); return; }
    const i = direct >= 0 ? direct : touch ? pickAt(e.clientX, e.clientY, true) : -1;
    if (i >= 0) { openTopic(i); return; }
    const c = galaxyAt(x, y);
    if (c >= 0) { setHash(S.model.cats[c].id); fitSystem(c); return; }
    S.hover.clear(performance.now());
    redrawOver();
  });
  const processMove = () => {
    moveRaf = 0;
    const e = moveEv;
    moveEv = null;
    if (!e || !alive || !S.model || S.cam.gesturing) return;
    const i = pickAt(e.clientX, e.clientY, false);
    S.hover.move(i, performance.now(), e.pointerType);
    let cursor = i >= 0 ? 'pointer' : '';
    if (i < 0) { const r = scene.getBoundingClientRect(); if (titleAt(e.clientX - r.left, e.clientY - r.top) >= 0) cursor = 'zoom-in'; }
    scene.style.cursor = cursor;
    redrawOver();
  };
  on(scene, 'pointermove', e => {
    if (e.pointerType === 'touch' || e.buttons || !S.model || !S.cam || S.cam.gesturing) return;
    moveEv = e;
    if (!moveRaf) moveRaf = requestAnimationFrame(processMove);
  });
  on(scene, 'pointerleave', e => { if (e.pointerType === 'mouse') { S.hover.move(-1, performance.now(), 'mouse'); redrawOver(); } });
  on(scene, 'keydown', e => {
    if (e.key === 'Enter' && S.hover.node >= 0) { e.preventDefault(); openTopic(S.hover.node); }
    else if (e.key === 'Escape' && S.system != null) { e.preventDefault(); wholeMap(true); }
    else if ((e.key === '+' || e.key === '=') && S.cam) S.cam.zoomBy(1.6);
    else if (e.key === '-' && S.cam) S.cam.zoomBy(1 / 1.6);
  });

  // ---- drawing
  function sceneFrame(c2d, lctx, info) {
    if (!S.model || !S.cam || S.arranging || !S.pal) {
      for (const c of [c2d, lctx]) { c.setTransform(info.dpr, 0, 0, info.dpr, 0, 0); c.clearRect(0, 0, info.w, info.h); }
      return false;
    }
    const more = drawScene(c2d, lctx, S, info);
    sky.drift(null, null, [S.cam.transform.x, S.cam.transform.y]);
    families.update(S.model, S.cam.transform, { show: S.model.layoutVersion >= 5 && S.model.families.length > 1, dim: !!S.dim, view: S.cam.size, ratio: S.cam.ratio() });
    beads.place();
    return more;
  }
  function overFrame(octx, info) {
    if (!S.model || !S.cam || S.arranging || !S.pal) { octx.setTransform(info.dpr, 0, 0, info.dpr, 0, 0); octx.clearRect(0, 0, info.w, info.h); return false; }
    const more = drawOver(octx, S, info);
    namesC.classList.toggle('is-dim', S.hover.node >= 0 && S.hoverVeil > 0.05);
    return more;
  }

  const portraitNow = () => { const w = scene.clientWidth || innerWidth, hh = scene.clientHeight || innerHeight; return hh > w * 1.05; };
  function rememberCanon(m) { for (let i = 0; i < m.n; i++) if (m.placed[i]) S.canon.set(m.id[i], [m.x[i], m.y[i]]); }
  async function reshape() {
    const m = S.model;
    if (!m) return;
    S.portrait = portraitNow();
    const shifts = S.portrait ? (await layoutJs()).screenShifts(m, ...canonXY(m), { aspect: (scene.clientWidth || innerWidth) / Math.max(1, scene.clientHeight || innerHeight) }) : null;
    if (m !== S.model) return;
    for (let i = 0; i < m.n; i++) {
      const c = S.canon.get(m.id[i]), d = shifts && shifts.get(m.cat[i]);
      if (!c) continue;
      m.x[i] = c[0] + (d ? d[0] : 0);
      m.y[i] = c[1] + (d ? d[1] : 0);
    }
  }
  function canonXY(m) {
    const cx = new Float64Array(m.n), cy = new Float64Array(m.n);
    for (let i = 0; i < m.n; i++) { const c = S.canon.get(m.id[i]); cx[i] = c ? c[0] : m.x[i]; cy[i] = c ? c[1] : m.y[i]; }
    return [cx, cy];
  }

  // ---- data
  function tweenFrom(prev, next) {
    if (!prev) return;
    for (let i = 0; i < next.n; i++) {
      const j = prev.index.get(next.id[i]);
      if (j == null) { S.appear.set(i, 0, 1, APPEAR_MS); continue; }
      const a = prev.t[j], b = next.t[i];
      if (a !== b && a >= 0 && b >= 0) S.tweens.set(i, a, b, TWEEN_MS);
      else if (a < 0 && b >= 0) S.appear.set(i, 0.6, 1, APPEAR_MS);
    }
  }
  async function useModel(m) {
    const prevSel = S.selected >= 0 && S.model ? S.model.id[S.selected] : null;
    if ((S.model && S.model.layoutVersion > 0) || m.layoutVersion > 0) arrangedOnce();
    S.model = m;
    if (changed) { changed = null; S.dim = null; }   // indexes are new; they can switch it on again
    S.canon = new Map();
    rememberCanon(m);
    await reshape();
    if (S.model !== m || !alive) return;
    if (prevSel) S.selected = m.index.get(prevSel) ?? -1;
    everything();
    if (!m.n) setStatus('empty', 'Your map is empty', 'Add topics to a subject and each one becomes a star here, coloured by how well you know it.', linkBtn('Add topics', '#subjects', 'primary', 'plus'));
    else if (!S.arranging && m.placed.some(Boolean)) setStatus(null);
    if (!cameraSet && m.n && S.cam && !S.arranging) placeCamera();
    redraw();
  }
  function placeCamera() {
    S.cam.setBounds(bounds(S.model));
    cameraSet = true;
    const c = want ? S.model.catIndex.get(want) : undefined;
    if (c != null) fitSystem(c, 0); else S.cam.fit(mapBounds(), { ms: 0 });
  }
  async function load() {
    const cached = await loadCached(S.key);
    if (!alive) return;
    if (cached && cached.payload) { S.etag = cached.etag; await useModel(decode(cached.payload)); }
    else setStatus('busy', 'Loading your map');
    try {
      const r = await getTagged(PATH, S.etag);
      if (!alive) return;
      if (!r.notModified && r.data) {
        const next = decode(r.data);
        tweenFrom(S.model, next);
        S.etag = r.etag;
        await useModel(next);
        if (r.etag) saveCached(S.key, r.etag, r.data);
      }
    } catch (e) {
      if (!S.model) { setStatus('error', 'The map did not load', e.message || 'Please try again.', btn('Try again', () => { setStatus('busy', 'Loading your map'); load(); }, 'tinted', 'refresh')); return; }
    }
    maybeArrange();
    beads.load();
    whenIdle(() => { if (alive) import('./topic.js').catch(() => {}); });
  }

  async function maybeArrange() {
    const m = S.model;
    if (!alive || !m || !m.n || S.arranging) return;
    const L = await layoutJs();
    if (m.layoutVersion >= L.LAYOUT_VERSION || !alive) return;
    S.arranging = true;
    // Arranged before (a galaxy changed): no card, it settles in place; the very first time says what is happening.
    if (!S.everArranged) setStatus('busy', 'Arranging your map', 'Each subject becomes a galaxy. This happens once.');
    redraw();
    let res = null;
    try { res = await L.fullLayout(m, null, { sim: [], signal: abort.signal, onProgress: p => { const b = status.querySelector('p'); if (b) b.textContent = `Each subject becomes a galaxy. ${Math.round(p * 100)}%`; } }); }
    catch (e) { if (!e.aborted) console.error('layout failed', e); }
    S.arranging = false;
    if (!alive) return;
    const sane = res && [...res.topics, ...res.categories].every(p => okXY(p[1]) && okXY(p[2]));
    if (!sane || S.model !== m) { setStatus(null); if (S.model && !cameraSet) placeCamera(); redraw(); return; }
    L.applyLayout(m, res);
    m.layoutVersion = L.LAYOUT_VERSION;
    arrangedOnce();
    rememberCanon(m);
    await reshape();
    everything();
    setStatus(null);
    placeCamera();
    redraw();
    try {
      await put('/api/p/map/positions', { layout_version: L.LAYOUT_VERSION, topics: res.topics, categories: res.categories });
      S.etag = null;   // the saved copy is older than the layout now
    } catch (e) { console.error('saving the layout failed', e); }
  }

  // ---- start
  layers = createLayers(scene, namesC, overC, {
    drawScene: sceneFrame, drawOver: overFrame,
    onResize: (w, hh) => {
      sky.draw(w, hh, Math.min(2, devicePixelRatio || 1));
      if (!S.cam) return;
      S.cam.resize(w, hh);
      measureBlocked();
      if (!S.model || S.arranging || !S.model.n) return;
      S.labelCap = capFor(w, 'normal');
      if (portraitNow() !== !!S.portrait) {
        reshape().then(() => { if (!alive) return; everything(); userMoved = false; if (S.system != null) fitSystem(S.system, 0); else S.cam.fit(mapBounds(), { ms: 0 }); redraw(); });
        return;
      }
      S.cam.setBounds(bounds(S.model));
      if (!userMoved && cameraSet && S.selected < 0) { if (S.system != null) fitSystem(S.system, 0); else S.cam.fit(mapBounds(), { ms: 0 }); }
    },
  });
  sky.draw(layers.w, layers.h, layers.dpr);
  S.cam = createCamera(scene, {
    onChange: (t, byUser) => { if (byUser) { userMoved = true; if (S.hover.node >= 0) S.hover.move(-1, performance.now(), 'mouse'); } S.hoverLay = null; redraw(); },
    onGesture: () => redraw(),
  });
  S.cam.resize(layers.w, layers.h);
  applySky();
  measureBlocked();
  load();

  const destroy = () => {
    if (!alive) return;
    alive = false;
    abort.abort();
    if (moveRaf) cancelAnimationFrame(moveRaf);
    clearTimeout(blockTimer); clearTimeout(skyTimer);
    layers.destroy();
    S.cam.destroy();
    releaseHaze(S.haze);
    S.haze = S.skyParts = S.curves = S.picker = S.hoverLay = S.placed = null;
    sky.destroy();
    el.remove();
    document.body.classList.remove('pmap-on');
  };
  return {
    get alive() { return alive; },
    destroy,
    reload: () => load(),
    reattach(root, param) {
      document.body.classList.add('pmap-on');
      root.replaceChildren(el);
      applySky();
      layers.resize();
      const cur = S.system != null && S.model && S.model.cats[S.system] ? S.model.cats[S.system].id : null;
      if ((param || null) !== cur) applyRoute(param || null);
    },
    // For the headless checks: a topic's place on screen, and the open galaxy.
    testHooks: { pos: name => { const m = S.model, i = m && m.name.indexOf(name); if (i == null || i < 0) return null; const r = scene.getBoundingClientRect(); const [x, y] = S.cam.toScreen(m.x[i], m.y[i]); return { x: r.left + x, y: r.top + y }; },
      stats: () => ({ topics: S.model ? S.model.n : 0, names: S.placed ? S.placed.topics.length : 0, titles: S.placed ? S.placed.cats.length : 0, system: S.system, layout: S.model ? S.model.layoutVersion : 0 }),
      perf: () => ({ frames: [...layers.stats.frames], scene: [...layers.stats.scene], over: [...layers.stats.over] }) },
  };
}

// For the headless checks only (never used by the page): the mounted map.
export const _live = () => live;
