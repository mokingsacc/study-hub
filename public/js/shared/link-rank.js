
export const LINK_TYPES = {
  versus: { code: 0, directed: false, label: 'Look-alike', pill: 'versus', dash: [], arrow: false, typeW: 1.0 },
  treated_by: { code: 1, directed: true, label: 'Treated with', back: 'Treats', pill: 'treats', dash: [], arrow: 'to', typeW: 0.9,
    from_kinds: ['condition', 'organism', 'approach'], to_kinds: ['drug', 'procedure'], hows: ['first_line', 'alternative', 'prophylaxis', 'definitive'] },
  adverse_effect: { code: 2, directed: true, label: 'Side effect', back: 'Caused by drug', pill: 'side effect', dash: [], arrow: 'to', typeW: 0.8,
    from_kinds: ['drug'], hows: ['common', 'serious', 'teratogen'] },
  causes: { code: 3, directed: true, label: 'Causes', back: 'Caused by', pill: 'causes', dash: [], arrow: 'to', typeW: 0.6,
    hows: ['organism', 'risk_factor', 'complication'] },
};
// Payload type codes, in order (meta.link_types).
export const TYPE_NAMES = Object.keys(LINK_TYPES);

// A versus pair counts as mixed up at confusion >= 0.5 (payload confusion100 >= 50).
export const MIXED_UP = 0.5;

// Payload link flags (look's): 1 directed, 2 proposed, 4 has a picture. 8 is retired (it was "pair check due";
// the teaching redesign has no hub check-backs), so do not reuse it.
export const FLAGS = { directed: 1, proposed: 2, picture: 4 };

// How many links each view draws (plan §8). pref map.link_density picks the default budget.
export const LIMITS = { default: 1500, hover: 24, focus: 150 };
export const DENSITY = { few: 600, normal: 1500, many: 3000 };

// Payload row positions: [a_idx, b_idx, type_idx, strength100, confusion100, flags].
export const A = 0, B = 1, TYPE = 2, STRENGTH = 3, CONFUSION = 4, FLAG = 5;

const clamp01 = x => (x > 1 ? 1 : x > 0 ? x : 0);
const typeW = code => (LINK_TYPES[TYPE_NAMES[code]] || { typeW: 0.5 }).typeW;

/**
 * imp = strength × typeW × (0.4 + 0.6·max(wA,wB)) × (0.5 + 0.5·max(yA,yB)) + 2·min(1, c)
 * strength and c as fractions (c may exceed 1); w is the colour position t/1000 (an unseen topic counts 0.3);
 * y is yield100/100.
 */
export function importance({ strength = 0, typeW: tw = 1, wA = 0.3, wB = 0.3, yA = 0, yB = 0, c = 0 }) {
  return clamp01(strength) * tw * (0.4 + 0.6 * Math.max(clamp01(wA), clamp01(wB))) * (0.5 + 0.5 * Math.max(clamp01(yA), clamp01(yB)))
    + 2 * Math.min(1, Math.max(0, c));
}

// w for a topic from its t1000 (null or undefined when unseen).
export const colourW = t1000 => (t1000 == null || !Number.isFinite(t1000) ? 0.3 : t1000 / 1000);

/** importance() of one payload row; t1000[i] and yield100[i] are per-topic arrays (or functions of the index). */
export function rowImportance(row, t1000 = [], yield100 = []) {
  const at = (arr, i) => (typeof arr === 'function' ? arr(i) : arr[i]);
  return importance({
    strength: row[STRENGTH] / 100, typeW: typeW(row[TYPE]),
    wA: colourW(at(t1000, row[A])), wB: colourW(at(t1000, row[B])),
    yA: (at(yield100, row[A]) || 0) / 100, yB: (at(yield100, row[B]) || 0) / 100,
    c: row[CONFUSION] / 100,
  });
}

export const isMixedRow = row => row[TYPE] === LINK_TYPES.versus.code && row[CONFUSION] >= MIXED_UP * 100;

/**
 * Which links to draw, as indices into links, in draw order (most important last is not assumed: the caller
 * draws mixed-up pairs on top by style). view:
 *   {mode: 'default', limit?, visible?(i)}      every mixed-up pair with both ends visible, then the rest by imp
 *   {mode: 'hover', node, limit?}               the node's links, mixed-up first, then by imp (24)
 *   {mode: 'focus', node, limit?, visible?(i)}  the node's own links, then links among its 1-hop neighbours (150)
 * filters (optional): {types: Set|array of type codes, mixedOnly, hideProposed}.
 */
export function selectLinks(view, { links = [], t1000 = [], yield100 = [] } = {}, filters = {}) {
  const mode = view && view.mode || 'default';
  const limit = Math.max(0, view && Number.isFinite(view.limit) ? view.limit : LIMITS[mode] ?? LIMITS.default);
  const types = filters.types ? new Set(filters.types) : null;
  const visible = view && typeof view.visible === 'function' ? view.visible : () => true;
  const ok = row => row && (!types || types.has(row[TYPE])) && (!filters.mixedOnly || isMixedRow(row))
    && (!filters.hideProposed || !(row[FLAG] & FLAGS.proposed));
  const imp = new Map();
  const impOf = i => { if (!imp.has(i)) imp.set(i, rowImportance(links[i], t1000, yield100)); return imp.get(i); };
  const byImp = (a, b) => impOf(b) - impOf(a) || a - b;
  const mixedFirst = (a, b) => (isMixedRow(links[b]) - isMixedRow(links[a])) || byImp(a, b);

  if (mode === 'hover' || mode === 'focus') {
    const node = view.node;
    const own = [];
    links.forEach((r, i) => { if (ok(r) && (r[A] === node || r[B] === node)) own.push(i); });
    own.sort(mixedFirst);
    if (mode === 'hover') return own.slice(0, limit);
    const out = own.slice(0, limit);
    if (out.length >= limit) return out;
    const hop = new Set(own.map(i => (links[i][A] === node ? links[i][B] : links[i][A])));
    const among = [];
    links.forEach((r, i) => { if (ok(r) && r[A] !== node && r[B] !== node && hop.has(r[A]) && hop.has(r[B]) && visible(r[A]) && visible(r[B])) among.push(i); });
    among.sort(mixedFirst);
    return out.concat(among.slice(0, limit - out.length));
  }

  const mixed = [], rest = [];
  links.forEach((r, i) => {
    if (!ok(r) || !visible(r[A]) || !visible(r[B])) return;
    (isMixedRow(r) ? mixed : rest).push(i);
  });
  mixed.sort(byImp);
  if (mixed.length >= limit) return mixed;
  rest.sort(byImp);
  return mixed.concat(rest.slice(0, limit - mixed.length));
}

// The default budget for a pref value (few, normal, many), else 1,500.
export const densityLimit = pref => DENSITY[pref] || LIMITS.default;
