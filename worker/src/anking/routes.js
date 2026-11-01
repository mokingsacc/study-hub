import { json, HttpError, readJson } from '../util.js';
import { ankiCall, ankiCallFull, AnkiError } from '../anki.js';
import { reserveSpend, spendCap } from '../db.js';
import { callJson, MODELS } from '../claude.js';
import { REF, ROW_ID, TABLE_V, READ_SYSTEM, READ_SCHEMA, catalogueRows, galaxyFor, shapeTable, withBoxes, imageSize, rowsOf, progressOf, countsOf, markOf, stepReview, shapeReview } from './store.js';

export const ROLE = 'tabler';
export const RESERVE_USD = 0.4;               // held against the caps while a table is read, then settled to its real cost
export const CATALOGUE_EVERY_MS = 24 * 3600_000;

const on = env => !!env && env.ANKING === 'on';
const need = env => { if (!on(env)) throw new HttpError(404, 'Not found.'); };
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const NEEDS_MIGRATION = 'The hub needs its newest database update (migration 0050) for AnKing tables.';
const notReady = e => { if (noTable(e)) throw new HttpError(503, NEEDS_MIGRATION); throw e; };
const parse = (t, fb) => { try { return JSON.parse(t); } catch { return fb; } };
const refOf = params => { const ref = String(params.ref || ''); if (!REF.test(ref)) throw new HttpError(404, 'There is no AnKing picture with that name.'); return ref; };

// ---------------------------------------------------------------- reads

/** The catalogue [{ref, title, kind, subject, category_id, seq}], read again from Anki when it is empty or a day old. */
export async function catalogue(env, user, { now = Date.now(), anki = null } = {}) {
  const read = async () => (await env.DB.prepare(`SELECT ref, title, kind, subject, category_id, seq, updated_at FROM anking_catalogue WHERE user_id = ? ORDER BY seq`)
    .bind(user).all()).results || [];
  let rows = await read();
  const newest = rows.reduce((m, r) => Math.max(m, Number(r.updated_at) || 0), 0);
  if (rows.length && now - newest < CATALOGUE_EVERY_MS) return rows;
  let cat;
  try { cat = anki ? await anki() : await ankiCall(env, 'picture_catalogue', {}, { timeoutMs: 20_000 }); } catch (e) {
    if (rows.length) return rows;   // Anki asleep: the copy we have
    if (e instanceof AnkiError) throw new HttpError(502, 'The Anki server could not be reached for the AnKing pictures.');
    throw e;
  }
  const list = catalogueRows(cat);
  if (!list.length) return rows;
  // Each picture's galaxy: where most of its matched topics are (map/pictures.js matches them), else its subject's.
  const topicCats = new Map();
  try {
    const t = (await env.DB.prepare(`SELECT p.ref, t.category_id FROM topic_pictures p JOIN topics t ON t.user_id = p.user_id AND t.id = p.topic_id
      WHERE p.user_id = ? AND p.source = 'anking' AND p.hidden_at IS NULL AND t.status IN ('proposed', 'confirmed')`).bind(user).all()).results || [];
    for (const r of t) { const l = topicCats.get(r.ref) || []; l.push(r.category_id); topicCats.set(r.ref, l); }
  } catch (e) { if (!noTable(e)) throw e; }
  const q = env.DB.prepare(`INSERT INTO anking_catalogue (user_id, ref, title, kind, subject, category_id, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, ref) DO UPDATE SET title = excluded.title, kind = excluded.kind, subject = excluded.subject, category_id = excluded.category_id,
      seq = excluded.seq, updated_at = excluded.updated_at`);
  const fresh = list.map(r => ({ ...r, category_id: galaxyFor(r, topicCats), updated_at: now }));
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM anking_catalogue WHERE user_id = ?`).bind(user),   // (a picture gone from Anki goes too)
    ...fresh.map(r => q.bind(user, r.ref, r.title, r.kind, r.subject, r.category_id, r.seq, now)),
  ]);
  rows = fresh;
  return rows;
}

async function tablesAndReviews(env, user, ref = null) {
  const [t, r] = await env.DB.batch([
    env.DB.prepare(`SELECT ref, rows FROM anking_tables WHERE user_id = ?1 AND (?2 IS NULL OR ref = ?2)`).bind(user, ref),
    env.DB.prepare(`SELECT ref, row_id, due FROM anking_reviews WHERE user_id = ?1 AND (?2 IS NULL OR ref = ?2)`).bind(user, ref),
  ]);
  return { tables: new Map((t.results || []).map(x => [x.ref, Number(x.rows)])), reviews: r.results || [] };
}

function diagramOf(p, tables, reviews, now) {
  const read = tables.has(p.ref);
  return { ref: p.ref, title: p.title, kind: p.kind || null, subject: p.subject || null, category_id: p.category_id || null, read,
    ...progressOf(read ? tables.get(p.ref) : 0, reviews.filter(r => r.ref === p.ref), now) };
}

export async function listRoute(request, env, ctx, params, url, user) {
  need(env);
  const now = Date.now();
  const cat = await catalogue(env, user, { now }).catch(notReady);
  const { tables, reviews } = await tablesAndReviews(env, user).catch(notReady);
  return json({ diagrams: cat.map(p => diagramOf(p, tables, reviews, now)), by_category: countsOf(cat, tables, reviews, now) });
}

export async function countsRoute(request, env, ctx, params, url, user) {
  need(env);
  const now = Date.now();
  let cat;
  try {
    cat = (await env.DB.prepare(`SELECT ref, category_id FROM anking_catalogue WHERE user_id = ?`).bind(user).all()).results || [];
    if (!cat.length) cat = await catalogue(env, user, { now }).catch(() => []);
  } catch (e) { if (noTable(e)) return json({ by_category: {} }); throw e; }
  const { tables, reviews } = await tablesAndReviews(env, user);
  return json({ by_category: countsOf(cat, tables, reviews, now) });
}

async function storedTable(env, user, ref) {
  const r = await env.DB.prepare(`SELECT table_json FROM anking_tables WHERE user_id = ? AND ref = ?`).bind(user, ref).first().catch(notReady);
  return r ? parse(r.table_json, null) : null;
}

async function reviewsOf(env, user, ref) {
  const rows = (await env.DB.prepare(`SELECT * FROM anking_reviews WHERE user_id = ? AND ref = ?`).bind(user, ref).all()).results || [];
  return Object.fromEntries(rows.map(r => [r.row_id, shapeReview(r)]));
}

export async function oneRoute(request, env, ctx, params, url, user) {
  need(env);
  const ref = refOf(params);
  const now = Date.now();
  const cat = await catalogue(env, user, { now }).catch(notReady);
  const p = cat.find(x => x.ref === ref);
  if (!p) return json({ error: 'There is no AnKing picture with that name.' }, 404);
  const table = await storedTable(env, user, ref);
  const { tables, reviews } = await tablesAndReviews(env, user, ref);
  return json({ diagram: diagramOf(p, tables, reviews, now), table, reviews: table ? await reviewsOf(env, user, ref) : {} });
}

// ---------------------------------------------------------------- writes

/** The picture from the Anki server as {data (base64), mimeType}. */
async function pictureOf(env, ref) {
  let r;
  try { r = await ankiCallFull(env, 'show_picture', { names: [ref] }, { timeoutMs: 20_000 }); } catch (e) {
    if (e instanceof AnkiError) throw new HttpError(502, 'The Anki server could not be reached for that picture.');
    throw e;
  }
  const img = (r.images || [])[0];
  if (!img || !img.data) throw new HttpError(404, 'There is no AnKing picture with that name.');
  return img;
}

export async function readRoute(request, env, ctx, params, url, user, { call = null, picture = null } = {}) {
  need(env);
  const ref = refOf(params);
  const body = await readJson(request).catch(() => ({}));
  const have = await storedTable(env, user, ref);
  if (have && have.v === TABLE_V && !(body && body.again === true)) return json({ table: have, cached: true, usd: 0 });
  const p = (await catalogue(env, user).catch(notReady)).find(x => x.ref === ref);
  if (!p) return json({ error: 'There is no AnKing picture with that name.' }, 404);
  const img = picture ? await picture(ref) : await pictureOf(env, ref);
  const seen = imageSize(img.data);
  const size = seen || { w: 1000, h: 1000 };
  const frame = seen ? `The picture is ${size.w} × ${size.h} pixels.` : 'Give the boxes as if the picture were 1000 × 1000 pixels (its width and its height each 1000).';
  const ask = { system: READ_SYSTEM, schema: READ_SCHEMA, effort: 'high', maxTokens: 24000,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: img.mimeType || 'image/png', data: img.data } },
      { type: 'text', text: `The picture: "${p.title}" (${p.kind || 'summary picture'}, AnKing Step 2 High Yield, ${p.subject || 'no subject'}). ${frame} Copy it into the table, with the boxes.` },
    ] }] };
  let data, usd = 0;
  if (call) ({ data, usd = 0 } = await call({ role: ROLE, ...ask }));
  else {
    const release = await reserveSpend(env, RESERVE_USD, await spendCap(env));   // 429 past the day's or month's cap
    try { ({ data, usd } = await callJson(env, { role: 'tabler', ...ask })); } finally { await release(0); }
  }
  const table = shapeTable(data, p.title, size);
  if (!table) throw new HttpError(502, 'Claude could not make a table of that picture. Try again in a moment.');
  const rows = rowsOf(table);
  const now = Date.now();
  const writes = [env.DB.prepare(`INSERT INTO anking_tables (user_id, ref, table_json, rows, model, usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, ref) DO UPDATE SET table_json = excluded.table_json, rows = excluded.rows, model = excluded.model, usd = excluded.usd,
      created_at = excluded.created_at`).bind(user, ref, JSON.stringify(table), rows.length, MODELS[ROLE], usd, now)];
  if (have) {
    // the marks on a row stay only where the row is still the same row
    const label = new Map(rows.map(r => [r.id, r.label]));
    const gone = rowsOf(have).filter(r => label.get(r.id) !== r.label).map(r => r.id);
    if (gone.length) writes.push(env.DB.prepare(`DELETE FROM anking_reviews WHERE user_id = ? AND ref = ? AND row_id IN (${gone.map(() => '?').join(', ')})`)
      .bind(user, ref, ...gone));
  }
  await env.DB.batch(writes).catch(notReady);
  return json({ table, cached: false, usd: Math.round(usd * 1e4) / 1e4 });
}

export async function boxesRoute(request, env, ctx, params, url, user) {
  need(env);
  const ref = refOf(params);
  const body = await readJson(request).catch(() => ({}));
  const table = await storedTable(env, user, ref);
  if (!table) return json({ error: 'That picture has no table yet.' }, 409);
  const { table: next, changed } = withBoxes(table, body && typeof body.rows === 'object' ? body.rows : {});
  if (!changed) return json({ error: 'No covers to save.' }, 400);
  await env.DB.prepare(`UPDATE anking_tables SET table_json = ? WHERE user_id = ? AND ref = ?`).bind(JSON.stringify(next), user, ref).run();
  return json({ table: next });
}

export async function rateRoute(request, env, ctx, params, url, user) {
  need(env);
  const ref = refOf(params);
  const body = await readJson(request).catch(() => ({}));
  const rowId = String((body && body.row) || '');
  if (!ROW_ID.test(rowId)) return json({ error: 'Which row?' }, 400);
  const table = await storedTable(env, user, ref);
  if (!table) return json({ error: 'That picture has no table yet.' }, 409);
  const row = rowsOf(table).find(r => r.id === rowId);
  if (!row) return json({ error: 'That table has no such row.' }, 404);
  const { missed, rating } = markOf(body.missed, row.cells.length, body.easy === true);
  const now = Date.now();
  const prev = await env.DB.prepare(`SELECT * FROM anking_reviews WHERE user_id = ? AND ref = ? AND row_id = ?`).bind(user, ref, rowId).first();
  const next = stepReview(prev, rating, now);
  await env.DB.prepare(`INSERT INTO anking_reviews (user_id, ref, row_id, due, stability, difficulty, scheduled_days, learning_steps, reps, lapses, state,
      last_review, last_rating, last_missed_json, first_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, ref, row_id) DO UPDATE SET due = excluded.due, stability = excluded.stability, difficulty = excluded.difficulty,
      scheduled_days = excluded.scheduled_days, learning_steps = excluded.learning_steps, reps = excluded.reps, lapses = excluded.lapses, state = excluded.state,
      last_review = excluded.last_review, last_rating = excluded.last_rating, last_missed_json = excluded.last_missed_json, updated_at = excluded.updated_at`)
    .bind(user, ref, rowId, next.due, next.stability, next.difficulty, next.scheduled_days, next.learning_steps, next.reps, next.lapses, next.state,
      next.last_review, next.last_rating, JSON.stringify(missed), prev ? Number(prev.first_at) : now, now).run();
  const { tables, reviews } = await tablesAndReviews(env, user, ref);
  return json({ review: shapeReview({ ...next, last_missed_json: JSON.stringify(missed), first_at: prev ? prev.first_at : now }), rating,
    progress: progressOf(tables.get(ref), reviews, now) });
}
