
export const STOPS_DARK = ['#3a85ea', '#2ca9e4', '#14c7cd', '#67d79f', '#bcd560', '#f7bb08', '#f9a005', '#f28404', '#ed6603', '#e7410a', '#d91729'];
export const STOPS_LIGHT = ['#2470d3', '#0b94cd', '#0eabcc', '#40b47e', '#94ab31', '#f9bd12', '#f59e0f', '#ed820c', '#e76409', '#e33f07', '#d91729'];
export const EDGES_LIGHT = ['#0f61c3', '#0673a0', '#077b94', '#078757', '#6a7d06', '#936e06', '#9e6406', '#a85a05', '#b44c05', '#bd3305', '#c20820'];

// The grounds the stops were checked against (look's --map-ground and the light map).
export const GROUND = { dark: '#111923', light: '#e7f0fa' };   // 25 Oct: the night a step brighter, the light map pale sky blue

// Not seen yet: a ring only, 1.25 px wide at 0.8 × the radius. The dark grey may be tuned up to #6b7785 on the
// real map; the scale test guards anything in that range (#66707d: 3.5:1 on the brighter night ground).
export const UNSEEN = { hex: '#66707d', dark: '#66707d', light: '#7d8894', width: 1.25, radiusScale: 0.8, word: 'Not seen yet', code: 'unseen' };

// The bands, from t1000. The words are canonical everywhere: map, panel, Review page, Claude and teach.
export const BANDS = [
  { code: 'strong', word: 'Strong', from: 0, to: 199 },
  { code: 'good', word: 'Getting there', from: 200, to: 399 },
  { code: 'mixed', word: 'Shaky', from: 400, to: 599 },
  { code: 'weak', word: 'Weak', from: 600, to: 799 },
  { code: 'very_weak', word: 'Very weak', from: 800, to: 1000 },
];
export const BAND_CODES = [...BANDS.map(b => b.code), 'unseen'];

// The legend's copy (look's legend.js places it).
export const LEGEND = {
  title: 'How strong you are',
  ends: { left: 'Strong', middle: 'Shaky', right: 'Very weak' },
  ticks: [200, 400, 600, 800],
  unseen: 'Not seen yet',
  glow: 'Glow = plenty of evidence. No glow = only a little to go on.',
  drift: "Colours drift back to the middle when a topic hasn't been tested for a few weeks.",
};

// Certainty shows as a glow of the node's own colour, never as fading (plan §7.4).
export const GLOW = { min_cert100: 33, radius: [1.6, 1.4], alpha: [0.1, 0.3] };
export const TWEEN_MS = 600;
// Selection is a ring in white (black on a light map), never --focus, which sits beside the yellow middle.
export const SELECTION = { dark: '#ffffff', light: '#000000', width: 2 };

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// The band code for a t1000 (null or not a number: unseen).
export function bandOf(t1000) {
  if (t1000 == null || t1000 === '' || !Number.isFinite(Number(t1000))) return 'unseen';
  const t = clamp(Math.round(Number(t1000)), 0, 1000);
  for (const b of BANDS) if (t <= b.to) return b.code;
  return 'very_weak';
}

export function bandWord(code) {
  if (code === 'unseen') return UNSEEN.word;
  const b = BANDS.find(x => x.code === code);
  return b ? b.word : UNSEEN.word;
}

// An SQL CASE giving the band code from an integer t1000 expression (for payloads that band in SQL).
export function bandCaseSql(expr = 't1000') {
  return `CASE WHEN ${expr} IS NULL THEN 'unseen' ` + BANDS.map(b => `WHEN ${expr} <= ${b.to} THEN '${b.code}'`).join(' ') + ` ELSE 'very_weak' END`;
}

// {radiusScale, alpha} for a node's glow, or null when there is too little evidence to show one.
export function glowFor(cert100) {
  const c = Number(cert100);
  if (!Number.isFinite(c) || c < GLOW.min_cert100) return null;
  const k = clamp(c, 0, 100) / 100;
  return { radiusScale: GLOW.radius[0] + GLOW.radius[1] * k, alpha: GLOW.alpha[0] + GLOW.alpha[1] * k };
}

// ------------------------------------------------------------------ colour maths (sRGB, OKLab)

const toLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  if (!/^[0-9a-f]{6}$/i.test(v)) throw new Error(`Not a colour: ${hex}`);
  return [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16) / 255);
}

export function rgbToHex(rgb) {
  return '#' + rgb.map(c => Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
}

// Linear sRGB -> OKLab (Ottosson 2020).
export function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export const hexToLinear = hex => hexToRgb(hex).map(toLinear);
export const hexToOklab = hex => linearToOklab(hexToLinear(hex));
export const oklabToHex = lab => rgbToHex(oklabToLinear(lab).map(c => toGamma(clamp(c, 0, 1))));

// WCAG relative luminance and contrast ratio.
export function luminance(hex) {
  const [r, g, b] = hexToLinear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// ------------------------------------------------------------------ tables

// A 256-entry hex table from evenly spaced stops (or [[t, hex], ...] with t in 0..1), interpolated in OKLab.
export function lutFromStops(stops, size = 256) {
  const pts = stops.map((s, i) => (Array.isArray(s) ? [Number(s[0]), s[1]] : [i / (stops.length - 1), s]))
    .map(([t, hex]) => [t, hexToOklab(hex)]).sort((a, b) => a[0] - b[0]);
  const out = new Array(size);
  for (let i = 0; i < size; i++) {
    const t = size === 1 ? 0 : i / (size - 1);
    let j = 0;
    while (j < pts.length - 2 && t > pts[j + 1][0]) j++;
    const [t0, a] = pts[j], [t1, b] = pts[Math.min(j + 1, pts.length - 1)];
    const k = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 0;
    out[i] = oklabToHex([0, 1, 2].map(c => a[c] + (b[c] - a[c]) * k));
  }
  return out;
}

const LUTS = {};
const themeOf = theme => (theme === 'light' ? 'light' : 'dark');

// The 256-entry fill table for a theme ('dark' by default).
export function lut(theme = 'dark') {
  const th = themeOf(theme);
  return LUTS[th] || (LUTS[th] = lutFromStops(th === 'light' ? STOPS_LIGHT : STOPS_DARK));
}
function edgeLut() { return LUTS.edge || (LUTS.edge = lutFromStops(EDGES_LIGHT)); }

const lutIndex = t1000 => Math.round(clamp(Number(t1000), 0, 1000) / 1000 * 255);
const unseenIn = theme => (themeOf(theme) === 'light' ? UNSEEN.light : UNSEEN.dark);

// A node's fill for t1000 (0..1000); null gives the unseen ring colour.
export function colourAt(t1000, theme = 'dark') {
  if (t1000 == null || !Number.isFinite(Number(t1000))) return unseenIn(theme);
  return lut(theme)[lutIndex(t1000)];
}

// The 1 px outline on light grounds (on dark grounds the fill is its own edge).
export function edgeAt(t1000, theme = 'light') {
  if (t1000 == null || !Number.isFinite(Number(t1000))) return unseenIn(theme);
  return themeOf(theme) === 'light' ? edgeLut()[lutIndex(t1000)] : colourAt(t1000, 'dark');
}

// ------------------------------------------------------------------ CSS tokens

// --w-0 ... --w-10 (fills at t = 0, 0.1 ... 1), --w-edge-0 ... --w-edge-10, --w-unseen and --w-select.
export function tokenValues(theme = 'dark') {
  const th = themeOf(theme);
  const fills = th === 'light' ? STOPS_LIGHT : STOPS_DARK;
  const edges = th === 'light' ? EDGES_LIGHT : STOPS_DARK;
  const out = {};
  fills.forEach((hex, i) => { out[`--w-${i}`] = hex; });
  edges.forEach((hex, i) => { out[`--w-edge-${i}`] = hex; });
  out['--w-unseen'] = unseenIn(th);
  out['--w-select'] = SELECTION[th];
  return out;
}

// The token CSS, following hub.css: light by default, dark under prefers-color-scheme unless data-theme says
// light, and dark whenever data-theme says dark.
export function tokensCss() {
  const block = th => Object.entries(tokenValues(th)).map(([k, v]) => `${k}:${v}`).join(';');
  return `:root{${block('light')}}\n@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${block('dark')}}}\n:root[data-theme="dark"]{${block('dark')}}`;
}

// Puts the tokens into the page once (a <style id="w-tokens"> in <head>). Safe to call again.
export function applyTokens(doc = globalThis.document) {
  if (!doc || !doc.head) return false;
  let el = doc.getElementById('w-tokens');
  if (!el) {
    el = doc.createElement('style');
    el.id = 'w-tokens';
    doc.head.appendChild(el);
  }
  const css = tokensCss();
  if (el.textContent !== css) el.textContent = css;
  return true;
}
