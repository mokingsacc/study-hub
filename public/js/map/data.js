// The map's data on the page (plan §9 Payload): GET /api/map decoded into typed arrays, the IndexedDB copy that
// paints a warm load in well under 300 ms, and the in-place updates live.js applies from ?ids answers. The
// renderer only ever reads these arrays; nothing here computes a score (the colours are stored t values).
//
//   decode(payload)                 the full payload -> model (typed arrays, adjacency, id -> index)
//   applyPartial(model, partial)    a ?ids answer -> {model, changed[], added[], removed[]} (a new model when
//                                   topics were added or removed, the same one updated in place otherwise)
//   loadCached(key) / saveCached(key, payload)   IndexedDB 'ph-map', failing soft (private windows, quota)
//   fetchMap(api, etag)             GET /api/map with If-None-Match -> {payload|null, etag, notModified}

// Topic tuple positions in the full payload (worker/src/map/payload.js).
// ONC and DISC (taxonomy v2): 1 for a cancer, and the discipline bits of meta.disciplines ([[key, word, bit]]).
// TREND (weakness model v2): 1 improving, 0 steady, -1 slipping, null with under two reviews (model.trend: TREND_NONE).
export const TI = { I: 0, ID: 1, NAME: 2, SHORT: 3, CAT: 4, UNIT: 5, X: 6, Y: 7, YIELD: 8, T: 9, CERT: 10, BAND: 11, MISSES: 12, CARDS: 13, LAST: 14, FLAGS: 15,
  ONC: 16, DISC: 17, TREND: 18 };
// The same fields in a ?ids row: [id, name, short, cat_id, unit_id, x, y, yield100, t1000, cert100, band_i, misses, cards, last, flags, onc, disc, trend].
export const PI = { ID: 0, NAME: 1, SHORT: 2, CAT: 3, UNIT: 4, X: 5, Y: 6, YIELD: 7, T: 8, CERT: 9, BAND: 10, MISSES: 11, CARDS: 12, LAST: 13, FLAGS: 14,
  ONC: 15, DISC: 16, TREND: 17 };
export const TREND_NONE = 2;
/** The stored trend (-1, 0, 1 or null) as model.trend holds it (Int8: TREND_NONE for none). */
export const trendCode = v => (v === 1 || v === 0 || v === -1 ? v : v != null && [1, 0, -1].includes(Number(v)) ? Number(v) : TREND_NONE);

export const UNSEEN_T = -1;
export const SIZE = Object.freeze({ top: 9, power: 0.7, floor: 0.25 });
/** A topic's size relative to the top (0.25 .. 1) from yield 0..1. */
export const sizeOf = y => Math.max(SIZE.floor, Math.min(1, Math.max(0, Number(y) || 0)) ** SIZE.power);
/** How loud a topic is by yield: 0 at the floor, 1 at the top (names and nebulae grow with it). */
export const loudOf = y => (sizeOf(y) - SIZE.floor) / (1 - SIZE.floor);
/** The old yield radius (9 × max(0.25, yield^0.7), 2.25 to 9); the dots now take tierRadius. */
export const radiusOf = y100 => SIZE.top * sizeOf((Number(y100) || 0) / 100);

// The Master Checklist lane of a topic's primary unit (topics.unit_id; unit_topics' other roles are not sent):
// model.lane holds 0 off the checklist, 1 A, 2 B, 3 C, kept with the topic fields and refreshed when a unit changes.
export const LANE_CODES = ['A', 'B', 'C'];
export const TIER = Object.freeze({ base: SIZE.top * SIZE.floor, letters: ['', 'C', 'B', 'A', 'A+'], words: ['Off list', 'Lane C', 'Lane B', 'Lane A', 'A+'] });
export const A_PLUS = 20;
/** World radius for tier 0 (off) .. 4 (A+): base × (tier + 1). */
export const tierRadius = tier => TIER.base * (Math.max(0, Math.min(4, tier | 0)) + 1);
/** The A+ units: the A_PLUS best-ranked Lane A units (unit indices). */
export function aPlusUnits(units, top = A_PLUS) {
  const a = (units || []).filter(u => u && u.lane === 'A' && u.rank != null).sort((x, y) => x.rank - y.rank || String(x.id).localeCompare(String(y.id)));
  if (!a.length) return new Set();
  const cut = a[Math.min(top, a.length) - 1].rank;
  return new Set(a.filter(u => u.rank <= cut).map(u => u.i));
}
const laneOfUnit = (model, u) => { const unit = u >= 0 && model.units ? model.units[u] : null; return unit ? LANE_CODES.indexOf(unit.lane) + 1 : 0; };
// lane code (1 A, 2 B, 3 C) -> tier (3 A or 4 A+, 2 B, 1 C); 0 off.
const tierOf = (model, u, lane) => (lane === 1 ? (model.aPlus && model.aPlus.has(u) ? 4 : 3) : lane === 2 ? 2 : lane === 3 ? 1 : 0);
/** Node i's lane code (0 off the checklist, 1 A, 2 B, 3 C). */
export const laneCode = (model, i) => (model.lane && model.lane.length === model.n ? model.lane[i] : laneOfUnit(model, model.unit[i]));
/** Node i's tier: 0 off, 1 C, 2 B, 3 A, 4 A+. */
export const tierCode = (model, i) => (model.tier && model.tier.length === model.n ? model.tier[i] : tierOf(model, model.unit[i], laneCode(model, i)));
/** Refreshes the A+ units, then every topic's lane, tier and radius (after a unit's lane or rank changed). */
export function refreshLanes(model) {
  model.aPlus = aPlusUnits(model.units);
  if (!model.lane || model.lane.length !== model.n) model.lane = new Uint8Array(model.n);
  if (!model.tier || model.tier.length !== model.n) model.tier = new Uint8Array(model.n);
  for (let i = 0; i < model.n; i++) setTier(model, i);
  return model;
}
function setTier(model, i) {
  const u = model.unit[i], lane = laneOfUnit(model, u), tier = tierOf(model, u, lane);
  model.lane[i] = lane; model.tier[i] = tier; model.r[i] = tierRadius(tier);
}

const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function emptyModel(meta, seq) {
  return {
    meta: meta || {}, seq: Number(seq) || 0, layoutVersion: Number(meta && meta.layout_version) || 0, teachingNow: (meta && meta.teaching_now) || null,
    n: 0, id: [], name: [], short: [], index: new Map(),
    cat: new Int16Array(0), unit: new Int32Array(0), x: new Float32Array(0), y: new Float32Array(0), r: new Float32Array(0),
    yield100: new Uint8Array(0), t: new Int16Array(0), cert: new Uint8Array(0), band: new Uint8Array(0), misses: new Uint16Array(0),
    cards: new Uint16Array(0), lastMiss: new Float64Array(0), flags: new Uint16Array(0), placed: new Uint8Array(0),
    onc: new Uint8Array(0), disc: new Uint8Array(0), trend: new Int8Array(0), lane: new Uint8Array(0), tier: new Uint8Array(0), aPlus: new Set(),
    cats: [], catIndex: new Map(), units: [], unitIndex: new Map(), links: [], adjOff: new Uint32Array(1), adj: new Uint32Array(0),
  };
}

function category(c) {
  return { i: c[0], id: c[1], name: c[2], short: c[3] || c[2], t1000: num(c[4]), coverage: (Number(c[5]) || 0) / 100, weak: Number(c[6]) || 0,
    unseen: Number(c[7]) || 0, n: Number(c[8]) || 0 };
}

// Typed arrays for n topics, filled from plain topic records {id, name, short, cat, unit, x, y, yield100, t, cert, band, ...}.
function fill(model, recs) {
  const n = recs.length;
  Object.assign(model, {
    n, id: new Array(n), name: new Array(n), short: new Array(n), index: new Map(),
    cat: new Int16Array(n), unit: new Int32Array(n), x: new Float32Array(n), y: new Float32Array(n), r: new Float32Array(n),
    yield100: new Uint8Array(n), t: new Int16Array(n), cert: new Uint8Array(n), band: new Uint8Array(n), misses: new Uint16Array(n),
    cards: new Uint16Array(n), lastMiss: new Float64Array(n), flags: new Uint16Array(n), placed: new Uint8Array(n),
    onc: new Uint8Array(n), disc: new Uint8Array(n), trend: new Int8Array(n), lane: new Uint8Array(n), tier: new Uint8Array(n),
  });
  recs.forEach((t, i) => {
    model.id[i] = t.id; model.name[i] = t.name || t.id; model.short[i] = t.short || null;
    model.index.set(t.id, i);
    setFields(model, i, t);
  });
}

function setFields(model, i, t) {
  model.cat[i] = t.cat == null ? -1 : t.cat;
  model.unit[i] = t.unit == null ? -1 : t.unit;
  const placed = t.x != null && t.y != null && Number.isFinite(t.x) && Number.isFinite(t.y);
  model.placed[i] = placed ? 1 : 0;
  model.x[i] = placed ? t.x : 0;
  model.y[i] = placed ? t.y : 0;
  model.yield100[i] = Math.max(0, Math.min(100, Math.round(Number(t.yield100) || 0)));
  model.t[i] = t.t == null ? UNSEEN_T : Math.max(0, Math.min(1000, Math.round(t.t)));
  model.cert[i] = Math.max(0, Math.min(100, Math.round(Number(t.cert) || 0)));
  model.band[i] = Number(t.band) || 0;
  model.misses[i] = Math.min(65535, Number(t.misses) || 0);
  model.cards[i] = Math.min(65535, Number(t.cards) || 0);
  model.lastMiss[i] = Number(t.last) || 0;
  model.flags[i] = Number(t.flags) || 0;
  model.onc[i] = Number(t.onc) ? 1 : 0;
  model.disc[i] = Math.max(0, Math.min(255, Number(t.disc) || 0));
  if (model.trend) model.trend[i] = trendCode(t.trend);
  setTier(model, i);
}

// The CSR adjacency: for node i, links adj[adjOff[i] .. adjOff[i+1]) (indices into model.links).
export function buildAdjacency(model) {
  const deg = new Uint32Array(model.n + 1);
  for (const l of model.links) { deg[l[0]]++; deg[l[1]]++; }
  const off = new Uint32Array(model.n + 1);
  for (let i = 0; i < model.n; i++) off[i + 1] = off[i] + deg[i];
  const adj = new Uint32Array(off[model.n]);
  const at = off.slice(0, model.n);
  model.links.forEach((l, k) => { adj[at[l[0]]++] = k; adj[at[l[1]]++] = k; });
  model.adjOff = off;
  model.adj = adj;
  return model;
}

/** Link indices touching node i. */
export function linksOf(model, i) {
  const out = [];
  for (let k = model.adjOff[i]; k < model.adjOff[i + 1]; k++) out.push(model.adj[k]);
  return out;
}

/** The full payload as a model. Rows are placed by their own index, so the payload's order never matters. */
export function decode(p) {
  const m = emptyModel(p && p.meta, p && p.meta && p.meta.seq);
  m.cats = (p.categories || []).map(category).sort((a, b) => a.i - b.i);
  m.cats.forEach((c, k) => { c.i = k; });
  const catByOld = new Map((p.categories || []).map(c => [c[0], m.cats.findIndex(x => x.id === c[1])]));
  m.catIndex = new Map(m.cats.map(c => [c.id, c.i]));
  m.units = (p.units || []).map(u => ({ old: u[0], id: u[1], name: u[2], cat: u[3] == null ? -1 : (catByOld.get(u[3]) ?? -1), lane: u[4] || null, rank: num(u[5]),
    nbme: num(u[6]), cms: num(u[7]) }));
  const unitByOld = new Map(m.units.map((u, k) => [u.old, k]));
  m.units.forEach((u, k) => { u.i = k; delete u.old; });
  m.unitIndex = new Map(m.units.map(u => [u.id, u.i]));
  m.aPlus = aPlusUnits(m.units);
  const rows = [...(p.topics || [])].sort((a, b) => a[TI.I] - b[TI.I]);
  const byOld = new Map(rows.map((r, k) => [r[TI.I], k]));
  fill(m, rows.map(r => ({
    id: r[TI.ID], name: r[TI.NAME], short: r[TI.SHORT], cat: r[TI.CAT] == null ? null : catByOld.get(r[TI.CAT]) ?? null,
    unit: r[TI.UNIT] == null ? null : unitByOld.get(r[TI.UNIT]) ?? null, x: num(r[TI.X]), y: num(r[TI.Y]), yield100: r[TI.YIELD], t: num(r[TI.T]),
    cert: r[TI.CERT], band: r[TI.BAND], misses: r[TI.MISSES], cards: r[TI.CARDS], last: r[TI.LAST], flags: r[TI.FLAGS], onc: r[TI.ONC], disc: r[TI.DISC],
    trend: r[TI.TREND],
  })));
  m.links = (p.links || []).filter(l => byOld.has(l[0]) && byOld.has(l[1]) && l[0] !== l[1])
    .map(l => [byOld.get(l[0]), byOld.get(l[1]), Number(l[2]) || 0, Number(l[3]) || 0, Number(l[4]) || 0, Number(l[5]) || 0]);
  return buildAdjacency(m);
}

// The plain record of node i (for rebuilding a model with topics added or removed).
function recordOf(m, i) {
  return { id: m.id[i], name: m.name[i], short: m.short[i], cat: m.cat[i] < 0 ? null : m.cat[i], unit: m.unit[i] < 0 ? null : m.unit[i],
    x: m.placed[i] ? m.x[i] : null, y: m.placed[i] ? m.y[i] : null, yield100: m.yield100[i], t: m.t[i] < 0 ? null : m.t[i], cert: m.cert[i],
    band: m.band[i], misses: m.misses[i], cards: m.cards[i], last: m.lastMiss[i], flags: m.flags[i], onc: m.onc[i], disc: m.disc[i],
    trend: m.trend && m.trend[i] !== TREND_NONE ? m.trend[i] : null };
}

/**
 * Applies a ?ids answer. Changed topics are updated in place (their old and new t are returned, so the caller
 * can tween); added or gone topics rebuild the arrays. Links touching the asked ids are replaced by the answer's.
 * Returns {model, changed: [{i, prevT, t}], added: [ids], removed: [ids], rebuilt}.
 */
export function applyPartial(model, p, askedIds = []) {
  const m = model;
  if (Array.isArray(p.categories) && p.categories.length) {
    const cats = p.categories.map(category);
    for (const c of cats) {
      const k = m.catIndex.get(c.id);
      if (k == null) { c.i = m.cats.length; m.cats.push(c); m.catIndex.set(c.id, c.i); } else { c.i = k; m.cats[k] = c; }
    }
  }
  let lanesMoved = false;
  for (const u of p.units || []) {
    const rec = { id: u[0], name: u[1], cat: m.catIndex.get(u[2]) ?? -1, lane: u[3] || null, rank: num(u[4]), nbme: num(u[5]), cms: num(u[6]) };
    const k = m.unitIndex.get(rec.id);
    if (k == null) { rec.i = m.units.length; m.units.push(rec); m.unitIndex.set(rec.id, rec.i); if (rec.lane) lanesMoved = true; }
    else { if (m.units[k].lane !== rec.lane || m.units[k].rank !== rec.rank) lanesMoved = true; rec.i = k; m.units[k] = rec; }
  }
  const recOf = r => ({ id: r[PI.ID], name: r[PI.NAME], short: r[PI.SHORT], cat: m.catIndex.get(r[PI.CAT]) ?? null, unit: r[PI.UNIT] == null ? null : m.unitIndex.get(r[PI.UNIT]) ?? null,
    x: num(r[PI.X]), y: num(r[PI.Y]), yield100: r[PI.YIELD], t: num(r[PI.T]), cert: r[PI.CERT], band: r[PI.BAND], misses: r[PI.MISSES], cards: r[PI.CARDS],
    last: r[PI.LAST], flags: r[PI.FLAGS], onc: r[PI.ONC], disc: r[PI.DISC], trend: r[PI.TREND] });
  const incoming = (p.topics || []).map(recOf);
  const gone = new Set((p.gone || []).filter(id => m.index.has(id)));
  const added = incoming.filter(r => !m.index.has(r.id)).map(r => r.id);
  const changed = [];
  // Links touching the asked ids (or the answer's topics) are replaced.
  const asked = new Set([...askedIds, ...incoming.map(r => r.id), ...gone]);
  const keepLinks = m.links.filter(l => !asked.has(m.id[l[0]]) && !asked.has(m.id[l[1]]))
    .map(l => [m.id[l[0]], m.id[l[1]], l[2], l[3], l[4], l[5]]);
  let rebuilt = false;
  if (added.length || gone.size) {
    const recs = [];
    for (let i = 0; i < m.n; i++) if (!gone.has(m.id[i])) recs.push(recordOf(m, i));
    const prevT = new Map(recs.map(r => [r.id, r.t]));
    const byId = new Map(recs.map((r, k) => [r.id, k]));
    for (const r of incoming) {
      if (byId.has(r.id)) { recs[byId.get(r.id)] = r; if ((prevT.get(r.id) ?? null) !== r.t) changed.push({ id: r.id, prevT: prevT.get(r.id) ?? null, t: r.t }); } else recs.push(r);
    }
    fill(m, recs);
    rebuilt = true;
  } else {
    for (const r of incoming) {
      const i = m.index.get(r.id);
      const prevT = m.t[i] < 0 ? null : m.t[i];
      setFields(m, i, r);
      m.name[i] = r.name || r.id; m.short[i] = r.short || null;
      if (prevT !== r.t) changed.push({ id: r.id, prevT, t: r.t });
    }
  }
  const linkRows = keepLinks.concat((p.links || []).map(l => [...l]));
  m.links = linkRows.filter(l => m.index.has(l[0]) && m.index.has(l[1]) && l[0] !== l[1])
    .map(l => [m.index.get(l[0]), m.index.get(l[1]), Number(l[2]) || 0, Number(l[3]) || 0, Number(l[4]) || 0, Number(l[5]) || 0]);
  buildAdjacency(m);
  if (lanesMoved) refreshLanes(m);   // a unit moved lane or rank: its topics' size, letter and the lens follow
  if (p.seq != null) m.seq = Math.max(m.seq, Number(p.seq) || 0);
  if (p.teaching_now !== undefined) m.teachingNow = p.teaching_now || null;
  for (const c of changed) c.i = m.index.get(c.id);
  return { model: m, changed, added, removed: [...gone], rebuilt };
}

/** Counts for the legend: topics, seen, weak (band index at or past weak_from), not seen yet. */
export function counts(m, mask = null) {
  const weakFrom = Number(m.meta && m.meta.weak_from) || 3;
  let seen = 0, weak = 0, shown = 0;
  for (let i = 0; i < m.n; i++) {
    if (mask && !mask[i]) continue;
    shown++;
    if (m.t[i] >= 0) { seen++; if (m.band[i] >= weakFrom && m.band[i] < 5) weak++; }
  }
  return { topics: m.n, shown, seen, weak, unseen: shown - seen };
}

/** The world bounds of the placed topics (with radius), or null for an empty map. */
export function bounds(m, which = null) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const list = which || Array.from({ length: m.n }, (_, i) => i);
  for (const i of list) {
    if (!m.placed[i]) continue;
    x0 = Math.min(x0, m.x[i] - m.r[i]); y0 = Math.min(y0, m.y[i] - m.r[i]);
    x1 = Math.max(x1, m.x[i] + m.r[i]); y1 = Math.max(y1, m.y[i] + m.r[i]);
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

// ------------------------------------------------------------------ IndexedDB copy

const DB_NAME = 'ph-map', STORE = 'payload';
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

/** {etag, payload, saved_at} for this key, or null (never throws). */
export async function loadCached(key) {
  try {
    const db = await openDb();
    return await new Promise(resolve => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(String(key));
      req.onsuccess = () => { const v = req.result; resolve(v && v.payload && v.payload.v === 2 ? v : null); };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    });
  } catch (e) { return null; }
}

/** Keeps the payload for the next warm load (never throws). */
export async function saveCached(key, etag, payload) {
  try {
    const db = await openDb();
    await new Promise(resolve => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ etag, payload, saved_at: Date.now() }, String(key));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); resolve(); };
    });
    return true;
  } catch (e) { return false; }
}

/** GET /api/map with the ETag the page holds: {payload, etag, notModified}. */
export async function fetchMap(api, etag = null) {
  const r = await api.getTagged('/api/map', etag);
  return { payload: r.notModified ? null : r.data, etag: r.etag || etag, notModified: !!r.notModified };
}

/** GET /api/map?ids=… for up to 200 topics. */
export async function fetchIds(api, ids) {
  const list = [...new Set(ids)].slice(0, 200);
  return api.get(`/api/map?ids=${list.map(encodeURIComponent).join(',')}`);
}
