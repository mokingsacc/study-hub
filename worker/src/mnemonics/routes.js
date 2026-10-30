// Mnemonics' routes (registry mnemonics.js; CONTRACT I35). Every one answers 404 unless MNEMONICS is "on".
//
//   GET    /api/mnemonics?category=&q=     -> {mnemonics, subjects, today: {new_done, new_cap}}
//   GET    /api/mnemonics/counts           -> {by_category: {id: {total, due, new}}}   (the map's balls, the page's chips)
//   GET    /api/mnemonics/test?category=   -> {queue: [{id, dir}], mnemonics}           (today's test, due first)
//   GET    /api/mnemonics/galaxy?category= -> {nodes, edges}                           (the subject's galaxy, public/js/galaxy)
//   POST   /api/mnemonics                  {cue, about, kind?, items, category_id?, topics?, notes?} -> {ok, batch_id, mnemonic}
//   PATCH  /api/mnemonics/:id              {any of those}
//   DELETE /api/mnemonics/:id
//   POST   /api/mnemonics/:id/rate         {dir, missed, easy?} -> {ok, batch_id, rating, review}
//   POST   /api/mnemonics/import           {source, items}   (the seed script; actor code)
import { json, readJson, londonDayStart } from '../util.js';
import { applyChange, changeResponse } from '../map/change.js';
import { CATEGORY_IDS, STEP2_CATEGORIES } from '../map/vocab.js';
import { seedLeft } from './seed.js';
import { shapeMnemonic, testQueue, countsOf, galaxyOf, NEW_PER_DAY } from './store.js';

const on = env => env.MNEMONICS === 'on';
const off = () => json({ error: 'Not found.' }, 404);
const noTable = e => /no such table/i.test(String(e && e.message));
const notReady = () => json({ error: 'Mnemonics need their database update (migration 0033).' }, 503);
// The map's subjects, for the page's chips and headings.
const SUBJECTS = STEP2_CATEGORIES.map(c => ({ id: c.id, name: c.name, short: c.short_name || c.name }));
const catOf = url => { const c = url.searchParams.get('category'); return c === 'other' ? 'other' : CATEGORY_IDS.includes(c) ? c : null; };

// One read batch: the live mnemonics (all, or one subject's), their reviews and the names of the topics they cover.
async function readList(env, user, category) {
  const where = category === 'other' ? 'AND m.category_id IS NULL' : category ? 'AND m.category_id = ?2' : '';
  const bind = s => (category && category !== 'other' ? s.bind(user, category) : s.bind(user));
  const [ms, rs, ts] = await env.DB.batch([
    bind(env.DB.prepare(`SELECT * FROM mnemonics m WHERE m.user_id = ?1 AND m.deleted_at IS NULL ${where} ORDER BY m.category_id, lower(m.cue)`)),
    bind(env.DB.prepare(`SELECT r.* FROM mnemonic_reviews r JOIN mnemonics m ON m.user_id = r.user_id AND m.id = r.mnemonic_id
      WHERE r.user_id = ?1 AND m.deleted_at IS NULL ${where}`)),
    bind(env.DB.prepare(`SELECT t0.id AS asked, t.id, t.name FROM topics t0
      LEFT JOIN topics t ON t.user_id = t0.user_id AND t.id = CASE WHEN t0.status = 'merged' THEN t0.merged_into ELSE t0.id END
      WHERE t0.user_id = ?1 AND t0.id IN (SELECT DISTINCT j.value FROM mnemonics m, json_each(m.topics_json) j WHERE m.user_id = ?1 AND m.deleted_at IS NULL ${where})`)),
  ]);
  const reviews = new Map();
  for (const r of rs.results || []) {
    const by = reviews.get(r.mnemonic_id) || {};
    by[r.dir] = r;
    reviews.set(r.mnemonic_id, by);
  }
  const names = new Map((ts.results || []).filter(t => t.id).map(t => [t.asked, { id: t.id, name: t.name }]));
  return (ms.results || []).map(m => shapeMnemonic(m, reviews.get(m.id) || {}, names));
}

async function newToday(env, user, now) {
  const r = await env.DB.prepare(`SELECT count(*) AS n FROM mnemonic_reviews WHERE user_id = ? AND dir = 'fwd' AND first_at >= ?`).bind(user, londonDayStart(now)).first();
  return (r && r.n) || 0;
}

// Plain-text search over cue, about, items, notes and topic names (case-insensitive, every word must appear).
export function matchesQuery(m, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [m.cue, m.about, m.notes, ...m.items.map(i => `${i.key} ${i.text}`), ...m.topics.map(t => t.name || '')].join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
}

/** The list as the page and the connector read it: {mnemonics, subjects, today}. category: a subject id, 'other' or null. */
export async function listRouteData(env, user, { category = null, q = '' } = {}, now = Date.now()) {
  const cat = category === 'other' ? 'other' : CATEGORY_IDS.includes(category) ? category : null;
  const all = await readList(env, user, cat);
  const [done, seed] = await Promise.all([newToday(env, user, now), seedLeft(env, user)]);
  return { mnemonics: q ? all.filter(m => matchesQuery(m, q)) : all, subjects: SUBJECTS, today: { new_done: done, new_cap: NEW_PER_DAY }, seed_left: seed };
}

export async function listRoute(request, env, ctx, params, url, user) {
  if (!on(env)) return off();
  try {
    return json(await listRouteData(env, user, { category: catOf(url), q: url.searchParams.get('q') || '' }));
  } catch (e) { if (noTable(e)) return notReady(); throw e; }
}

export async function countsRoute(request, env, ctx, params, url, user) {
  if (!on(env)) return off();
  try {
    const rows = (await env.DB.prepare(`SELECT m.category_id,
        (SELECT due FROM mnemonic_reviews r WHERE r.user_id = m.user_id AND r.mnemonic_id = m.id AND r.dir = 'fwd') AS fwd_due,
        (SELECT first_at FROM mnemonic_reviews r WHERE r.user_id = m.user_id AND r.mnemonic_id = m.id AND r.dir = 'fwd') AS fwd_first,
        (SELECT due FROM mnemonic_reviews r WHERE r.user_id = m.user_id AND r.mnemonic_id = m.id AND r.dir = 'rev') AS rev_due
      FROM mnemonics m WHERE m.user_id = ? AND m.deleted_at IS NULL`).bind(user).all()).results || [];
    return json({ by_category: countsOf(rows, Date.now()) });
  } catch (e) { if (noTable(e)) return notReady(); throw e; }
}

export async function testRoute(request, env, ctx, params, url, user) {
  if (!on(env)) return off();
  const now = Date.now();
  try {
    const list = await readList(env, user, catOf(url));
    const queue = testQueue(list, { now, newToday: await newToday(env, user, now) });
    const used = new Set(queue.map(x => x.id));
    return json({ queue, mnemonics: list.filter(m => used.has(m.id)) });
  } catch (e) { if (noTable(e)) return notReady(); throw e; }
}

export async function galaxyRoute(request, env, ctx, params, url, user) {
  if (!on(env)) return off();
  const category = catOf(url);
  if (!category) return json({ error: 'Which subject? Send ?category=<subject id>.' }, 400);
  try {
    const all = await readList(env, user, null);
    const covered = [...new Set(all.filter(m => (category === 'other' ? !m.category_id : m.category_id === category)).flatMap(m => m.topics.map(t => t.id)))];
    const ids = JSON.stringify(covered);
    const [links, bands] = await env.DB.batch([
      env.DB.prepare(`SELECT from_id, to_id FROM links WHERE user_id = ? AND type = 'versus' AND status = 'active'
        AND (from_id IN (SELECT value FROM json_each(?2)) OR to_id IN (SELECT value FROM json_each(?2)))`).bind(user, ids),
      env.DB.prepare('SELECT topic_id, band FROM topic_scores WHERE user_id = ? AND topic_id IN (SELECT value FROM json_each(?))').bind(user, ids),
    ]);
    const pairs = (links.results || []).map(l => [l.from_id, l.to_id]);
    return json(galaxyOf(all, category, pairs, { bands: new Map((bands.results || []).map(b => [b.topic_id, b.band])),
      subjects: new Map(SUBJECTS.map(s => [s.id, s.name])), now: Date.now() }));
  } catch (e) { if (noTable(e)) return notReady(); throw e; }
}

const change = (env, user, op, via, args, actor = 'mo') =>
  applyChange(env, user, { actor, surface: actor === 'mo' ? 'web' : 'code', op, via, args }).then(changeResponse);

export async function addRoute(request, env, ctx, params, url, user) {
  if (!on(env)) return off();
  return change(env, user, 'mnemonic.add', 'api:POST /api/mnemonics', await readJson(request, 64_000));
}

export async function editRoute(request, env, ctx, params, url, user) {
  if (!on(env)) return off();
  return change(env, user, 'mnemonic.edit', 'api:PATCH /api/mnemonics/:id', { ...(await readJson(request, 64_000)), id: String(params.id || '') });
}

export async function removeRoute(request, env, ctx, params, url, user) {
  if (!on(env)) return off();
  return change(env, user, 'mnemonic.remove', 'api:DELETE /api/mnemonics/:id', { id: String(params.id || '') });
}

export async function rateRoute(request, env, ctx, params, url, user) {
  if (!on(env)) return off();
  const b = await readJson(request, 8_000);
  return change(env, user, 'mnemonic.rate', 'api:POST /api/mnemonics/:id/rate', { id: String(params.id || ''), dir: b.dir, missed: b.missed, easy: b.easy });
}

export async function importRoute(request, env, ctx, params, url, user) {
  if (!on(env)) return off();
  const b = await readJson(request, 2_000_000);
  return change(env, user, 'mnemonic.import', 'api:POST /api/mnemonics/import', { source: b.source, items: b.items }, 'code');
}
