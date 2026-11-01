// Colours for the canvas (plan §7.4, §9 Renderer): weakness's scale in 32 buckets (one fill() per bucket a
// frame), a glow sprite per bucket (drawImage, never shadowBlur), and the --map-* tokens read from the page.
// The hex values come only from scale.js (weakness's), through the payload's meta stops.
import { lutFromStops, STOPS_DARK, STOPS_LIGHT, EDGES_LIGHT, UNSEEN, GLOW, SELECTION, hexToOklab, oklabToHex, oklabToLinear } from './scale.js';
import { EVIDENCE } from '../shared/evidence.js';
import { TOPIC_FLAGS } from './marks.js';

export const BUCKETS = 32;
export const ALPHA_LEVELS = 7;
const SPRITE_PX = 64;
// The hot core that makes a dot read as a star (concept 8a): white at 38.5% over the dot's middle third, which
// is the concept's mix with white (55%) at 70% opacity, drawn in one pass for every dot.
export const CORE = Object.freeze({ radius: 0.36, alpha: 0.385 });
// On the night sky the glow is a little wider and brighter than the plan's certainty glow, as in the concept.
export const SKY_GLOW = Object.freeze({ radius: 1.6, alpha: 1.3, maxAlpha: 0.55 });
// On the night sky each star has a thin dark casing round its fill (25 Oct), so it reads crisp against a bright
// nebula or a neighbour's glow.
export const CASING = Object.freeze({ colour: 'rgba(5,8,26,0.92)', px: 1.1 });

export const SKY_SWATCHES = Object.freeze([
  Object.freeze({ id: 'ink', label: 'Ink', hex: '#16181d' }),
  Object.freeze({ id: 'ember', label: 'Ember dusk', hex: '#1c1717' }),
  Object.freeze({ id: 'plum', label: 'Plum night', hex: '#1d1622' }),
  Object.freeze({ id: 'aubergine', label: 'Aubergine', hex: '#211520' }),
  Object.freeze({ id: 'indigo', label: 'Indigo dusk', hex: '#18172a' }),
  Object.freeze({ id: 'teal', label: 'Deep teal', hex: '#121c20' }),
  Object.freeze({ id: 'midnight', label: 'Midnight', hex: '#141a2c' }),
]);
// The defaults (worker/src/map/registry/look.js registers the same): Ink; a Custom hue's lightness and chroma (a
// calm dark colour on any hue); brightness 0.6 to 1.4.
export const SKY = Object.freeze({ swatch: 'ink', hue: 25, customL: 0.215, customC: 0.03, brightness: 1, min: 0.6, max: 1.4 });

const clamp01 = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lchOf = hex => { const [L, a, b] = hexToOklab(hex); return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 }; };

export function skyChoice(p = {}) {
  const raw = Number(p.sky_brightness);
  const brightness = Number.isFinite(raw) ? clamp01(raw, SKY.min, SKY.max) : SKY.brightness;
  if (p.sky_swatch === 'custom') {
    const hv = Number(p.sky_hue);
    const h = Number.isFinite(hv) ? ((Math.round(hv) % 360) + 360) % 360 : SKY.hue;
    return { swatch: 'custom', label: 'Custom', L: SKY.customL, C: SKY.customC, h, brightness };
  }
  const s = SKY_SWATCHES.find(x => x.id === p.sky_swatch) || SKY_SWATCHES.find(x => x.id === SKY.swatch);
  return { swatch: s.id, label: s.label, ...lchOf(s.hex), brightness };
}

// OKLCH to hex (or rgba when a < 1), the chroma eased down until the colour fits in sRGB.
function lchCss(L, C, h, a = 1) {
  const r = (h * Math.PI) / 180;
  let c = Math.max(0, C);
  for (let k = 0; k < 40; k++) {
    if (oklabToLinear([L, c * Math.cos(r), c * Math.sin(r)]).every(v => v >= -1e-4 && v <= 1 + 1e-4)) break;
    c *= 0.92;
  }
  const hex = oklabToHex([L, c * Math.cos(r), c * Math.sin(r)]);
  if (a >= 1) return hex;
  const [R, G, B] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${R},${G},${B},${String(+a.toFixed(3)).replace(/^0\./, '.')})`;
}

const DESIGN_NIGHT = { L: 0.194, C: 0.062 };
const NIGHT_SKY = {
  '--map-ground': [0.194, 0.062, 0, 1, 'ground'], '--map-ground-2': [0.241, 0.074, 0, 1, 'ground'],
  '--map-label-halo': [0.172, 0.051, 0, 0.86, 'ground'], '--map-veil': [0.161, 0.044, 0, 0.7, 'ground'], '--map-cat-halo': [0.167, 0.05, 0, 0.55, 'ground'],
  '--map-card-bg': [0.242, 0.065, 0, 0.94, 'ink'], '--map-link': [0.696, 0.081, 0, 1, 'ink'], '--map-link-hi': [0.919, 0.039, 0, 1, 'ink'],
  '--map-unit-label': [0.831, 0.052, 0, 1, 'ink'], '--map-unseen': [0.69, 0.064, 0, 1, 'ink'],
  '--map-glass': [0.272, 0.06, 0, 0.66, 'ink'], '--map-glass-strong': [0.271, 0.056, 0, 0.94, 'ink'], '--map-glass-hover': [0.345, 0.067, 0, 0.82, 'ink'],
  '--map-pop-bg': [0.271, 0.056, 0, 0.96, 'ink'],
  // the sky itself (map.css .map-sky): a slightly lighter centre, the ground, a darker edge and the vignette
  '--map-sky-0': [0.254, 0.08, 0, 1, 'ground'], '--map-sky-1': [0.222, 0.07, 0, 1, 'ground'], '--map-sky-2': [0.194, 0.062, 0, 1, 'ground'],
  '--map-sky-3': [0.162, 0.05, 0, 1, 'ground'], '--map-sky-vig': [0.12, 0.033, 0, 0.6, 'ground'],
  '--map-sky-a': [0.502, 0.194, 23, 0.16, 'glow'], '--map-sky-b': [0.564, 0.143, -25, 0.12, 'glow'], '--map-sky-c': [0.603, 0.192, 65, 0.07, 'glow'],
};
// By day (design hue 256, C .017 on the ground): a very pale tint of the swatch's hue, chroma × (base C / .028)
// within 0.35 to 1.2, so a grey swatch still tints a little and a vivid one stays pale.
const NIGHT_C_LIGHT = 0.028;
const LIGHT_SKY = {
  '--map-ground': [0.952, 0.017, 0, 1, 'ground'], '--map-ground-2': [0.981, 0.008, 0, 1, 'ground'],
  '--map-label-halo': [0.971, 0.011, 0, 0.92, 'ground'], '--map-veil': [0.961, 0.014, 0, 0.74, 'ground'],
  '--map-day-0': [0.993, 0.004, 0, 1, 'ground'], '--map-day-1': [0.962, 0.014, 0, 1, 'ground'], '--map-day-2': [0.927, 0.024, 0, 1, 'ground'],
  '--map-cloud-a': [0.899, 0.049, 9, 0.55, 'glow'], '--map-cloud-b': [0.914, 0.049, 44, 0.5, 'glow'], '--map-cloud-c': [0.935, 0.029, -59, 0.45, 'glow'],
};
export const SKY_VAR_NAMES = Object.freeze({ night: Object.freeze(Object.keys(NIGHT_SKY)), light: Object.freeze(Object.keys(LIGHT_SKY)) });

// Brightness on the ground's lightness: at night × 0.68 to × 1.24 (0.6 to 1.4), never above L 0.25, where the reddest
// dot still has 3:1 on the ground; by day a narrower ± 0.016.
export const GROUND_MAX_L = 0.25;
export const groundL = (L, b, night = true) => (night ? Math.min(GROUND_MAX_L, L * (b < 1 ? 1 - (1 - b) * 0.8 : 1 + (b - 1) * 0.6)) : Math.min(0.995, L + (b - 1) * 0.04));

/**
 * The sky's CSS custom properties for a choice (skyChoice) and theme ('night' or 'light'): {name: css colour}.
 * Night: the ground is the swatch's own colour at brightness 1.
 */
export function skyVars(choice = skyChoice(), theme = 'night') {
  const night = theme !== 'light', b = choice.brightness ?? 1;
  const spec = night ? NIGHT_SKY : LIGHT_SKY;
  const k = night ? choice.C / DESIGN_NIGHT.C : clamp01(choice.C / NIGHT_C_LIGHT, 0.35, 1.2);
  const out = {};
  for (const [name, [L0, C0, dh, a, part]] of Object.entries(spec)) {
    let L = L0;
    // at night the ground follows the brightness, and the lighter centre's lift over it narrows as it brightens
    if (part === 'ground') L = night ? groundL(choice.L, b, true) + (L0 - DESIGN_NIGHT.L) * (L0 > DESIGN_NIGHT.L ? 1 / Math.max(1, b) : 1) : groundL(L0, b, false);
    const alpha = part === 'glow' && night ? a * b : a;
    out[name] = lchCss(L, C0 * k, (choice.h + dh + 360) % 360, alpha);
  }
  return out;
}

/** The colour a choice shows at a glance (its swatch, the hue slider's track): the night ground's lighter centre, or the day's tint. */
export const skySample = (choice, theme = 'night') => skyVars(choice, theme)[theme === 'light' ? '--map-day-2' : '--map-sky-0'];

/** The whisper of neutral a galaxy with no seen topics gets: the sky's own hue, pale at night and grey-dark by day. */
export function skyNeutral(choice = skyChoice(), theme = 'night') {
  return rgbOf(lchCss(theme === 'light' ? 0.55 : 0.82, Math.min(0.03, choice.C * 0.8), choice.h));
}
const rgbOf = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

/**
 * A thin topic's colour (wave 2 C.4, shared/evidence.js): the same lightness and hue at EVIDENCE.pale_chroma of the
 * chroma, so a guess never glows like knowledge. Both renderers draw it with an outline in the full colour.
 */
export function paleOf(hex) {
  const [L, a, b] = hexToOklab(hex);
  return oklabToHex([L, a * EVIDENCE.pale_chroma, b * EVIDENCE.pale_chroma]);
}
/** Is topic i drawn pale (thin evidence)? The map payload's flag bit (map/flags.js). */
export const isPale = (model, i) => !!(model.flags && (model.flags[i] & TOPIC_FLAGS.thin));

/** The bucket (0..31) of a t1000 (0..1000). */
export const bucketOf = t => Math.max(0, Math.min(BUCKETS - 1, Math.floor((Math.max(0, Math.min(1000, t)) / 1000) * BUCKETS)));
const bucketMid = b => ((b + 0.5) / BUCKETS) * 1000;

/** A glow's radius scale and alpha level (quantised to 7 steps), or null below the certainty floor. */
export function glowOf(cert100) {
  if (!(cert100 >= GLOW.min_cert100)) return null;
  const c = Math.min(100, cert100) / 100;
  const alpha = GLOW.alpha[0] + GLOW.alpha[1] * c;
  const level = Math.max(0, Math.min(ALPHA_LEVELS - 1, Math.round(((alpha - GLOW.alpha[0]) / GLOW.alpha[1]) * (ALPHA_LEVELS - 1))));
  return { scale: GLOW.radius[0] + GLOW.radius[1] * c, level, alpha: GLOW.alpha[0] + (GLOW.alpha[1] * level) / (ALPHA_LEVELS - 1) };
}

// The --map-* tokens the canvas uses, with night-sky fallbacks (map.css sets them, per theme). 25 Oct: the
// unseen ring, the highlight ring and its glow, and the soft halo behind a system's name joined them.
export const TOKEN_NAMES = ['--map-ground', '--map-ground-2', '--map-link', '--map-link-hi', '--map-label', '--map-label-halo', '--map-cat-label',
  '--map-unit-label', '--map-mark', '--map-hi', '--map-card-bg', '--map-card-ink', '--map-veil', '--map-unseen', '--map-focus', '--map-focus-glow', '--map-cat-halo'];
// The night sky: Ink's ground (the default swatch) and the threads, rings and halos derived from it (skyVars), and
// near-white names. map.css sets these same values on .map (tests/web/map-chrome-25.test.mjs).
const NIGHT_FIXED = {
  '--map-label': '#eef2ff', '--map-cat-label': '#f5f7ff', '--map-mark': '#f3f5ff', '--map-hi': '#ffffff', '--map-card-ink': '#eef1ff', '--map-focus': '#ffffff',
  '--map-focus-glow': 'rgba(120,196,255,.55)',
};
const NIGHT_SKY_DEFAULT = skyVars(skyChoice(), 'night');
export const NIGHT = Object.freeze(Object.fromEntries(TOKEN_NAMES.map(n => [n, NIGHT_FIXED[n] || NIGHT_SKY_DEFAULT[n]])));

export function readTokens(el) {
  const st = el && typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
  const out = {};
  for (const name of TOKEN_NAMES) out[name] = (st && st.getPropertyValue(name).trim()) || NIGHT[name];
  return out;
}

const makeCanvas = (w, h) => {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return null;
};

function hexA(hex, a) {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

// One radial sprite (concept 8a's star glow): the colour at full strength in the middle, a soft shoulder, then
// nothing at the edge.
function sprite(hex, px) {
  const c = makeCanvas(px, px);
  if (!c) return null;
  const g = c.getContext('2d');
  const r = px / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, hexA(hex, 1));
  grad.addColorStop(0.22, hexA(hex, 0.5));
  grad.addColorStop(0.55, hexA(hex, 0.12));
  grad.addColorStop(1, hexA(hex, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  return c;
}

/**
 * The palette for a sky: 'night' (dark stops) or 'light' (light stops with their edges). stops may come from the
 * payload's meta, so the page always draws the scale the Worker meant; unseen: the ring colour for "not seen yet"
 * (--map-unseen) over scale.js's. dpr sizes the sprites.
 */
export function palette(theme = 'night', { stops = null, stopsLight = null, edgesLight = null, dpr = 1, sprites = true, unseen = null } = {}) {
  const light = theme === 'light';
  const lut = lutFromStops(light ? (stopsLight || STOPS_LIGHT) : (stops || STOPS_DARK));
  const edgeLut = light ? lutFromStops(edgesLight || EDGES_LIGHT) : null;
  const fills = [], edges = [], glows = [], pales = [];
  for (let b = 0; b < BUCKETS; b++) {
    const k = Math.round((bucketMid(b) / 1000) * 255);
    fills.push(lut[k]);
    pales.push(paleOf(lut[k]));
    edges.push(edgeLut ? edgeLut[k] : lut[k]);
    glows.push(sprites ? sprite(lut[k], Math.round(SPRITE_PX * Math.min(2, Math.max(1, dpr)))) : null);
  }
  const ring = unseen || (light ? UNSEEN.light : UNSEEN.dark);
  return {
    theme: light ? 'light' : 'night', fills, edges, glows, lut, pales,
    unseen: ring, unseenWidth: UNSEEN.width, unseenScale: UNSEEN.radiusScale,
    select: light ? SELECTION.light : SELECTION.dark, colourOf: t => (t < 0 ? ring : lut[Math.round((Math.min(1000, Math.max(0, t)) / 1000) * 255)]),
  };
}
