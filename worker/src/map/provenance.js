import { json, readJson, londonDay, HttpError } from '../util.js';
import { noteJob } from '../job-log.js';
import { stemSafe } from './guard.js';
import { splitByStarts } from '../../../public/js/uworld/split.js';
import { isBoilerplate } from '../../../public/js/shared/evidence.js';

export const PROVENANCE = { limit: 60, max: 200, words_max: 1200, min_words: 3 };
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const tidy = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);

export function keepable(text) {
  const t = tidy(text);
  if (!t || isBoilerplate(t) || t.split(/\s+/).length < PROVENANCE.min_words) return null;
  return stemSafe(t) ? cut(t, PROVENANCE.words_max) : null;
}

/** The block's start (epoch ms) from its id, when the id is a time on the block's own London day; else null. */
export function blockStart(block) {
  const id = /^\d{12,14}$/.test(String(block && block.id)) ? Number(block.id) : null;
  return id != null && londonDay(id) === block.day ? id : null;
}

export function uworldWords(block, misses) {
  const out = new Map();
  const qs = parse(block.questions_json, []).filter(q => q && q.start_ms != null);
  if (!qs.length) return out;
  let groups;
  try { groups = splitByStarts(parse(block.segments_json, []), qs).groups; } catch { return out; }
  const start = blockStart(block);
  for (const m of misses) {
    const segs = groups.get(Number(m.uworld_q));
    if (!segs || !segs.length) continue;
    const text = keepable(segs.map(s => s.text).join(' '));
    if (!text) continue;
    const off = Number(segs[0].start);
    out.set(m.id, { text, at: start != null && Number.isFinite(off) ? Math.round(start + off) : null });
  }
  return out;
}

/** One pass: the newest misses with no words yet that come from a recording. Returns {looked, filled, none, left}. */
export async function provenancePass(env, user, { limit = PROVENANCE.limit, now = Date.now() } = {}) {
  const n = Math.max(1, Math.min(PROVENANCE.max, Number(limit) || PROVENANCE.limit));
  const where = `deleted_at IS NULL AND his_words IS NULL AND his_words_src IS NULL
    AND json_extract(coalesce(mo_corrected_json, '{}'), '$.his_words') IS NULL
    AND ((uworld_block_id IS NOT NULL AND uworld_q IS NOT NULL) OR (block_id IS NOT NULL AND q_index IS NOT NULL))`;
  const [todo, left] = await env.DB.batch([
    env.DB.prepare(`SELECT id, uworld_block_id, uworld_q, block_id, q_index FROM misses WHERE user_id = ?1 AND ${where} ORDER BY at DESC LIMIT ?2`).bind(user, n),
    env.DB.prepare(`SELECT count(*) AS n FROM misses WHERE user_id = ?1 AND ${where}`).bind(user),
  ]);
  const misses = todo.results || [];
  const out = { looked: misses.length, filled: 0, none: 0, left: Math.max(0, (Number((left.results || [])[0]?.n) || 0) - misses.length) };
  if (!misses.length) return out;
  const blocks = [...new Set(misses.filter(m => m.uworld_block_id).map(m => m.uworld_block_id))];
  const hub = misses.filter(m => !m.uworld_block_id && m.block_id);
  const reads = [];
  if (blocks.length) reads.push(env.DB.prepare('SELECT id, day, segments_json, questions_json FROM uworld_blocks WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(blocks)));
  if (hub.length) reads.push(env.DB.prepare(`SELECT block_id, q_index, mo_quote, cleaned_transcript FROM analyses WHERE block_id || ':' || q_index IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(hub.map(m => `${m.block_id}:${m.q_index}`))));
  const res = reads.length ? await env.DB.batch(reads) : [];
  const words = new Map();
  let i = 0;
  if (blocks.length) {
    for (const b of res[i++].results || []) for (const [k, v] of uworldWords(b, misses.filter(m => m.uworld_block_id === b.id))) words.set(k, { ...v, src: 'uworld' });
  }
  if (hub.length) {
    const by = new Map((res[i++].results || []).map(r => [`${r.block_id}:${r.q_index}`, r.mo_quote || r.cleaned_transcript]));
    for (const m of hub) { const t = keepable(by.get(`${m.block_id}:${m.q_index}`)); if (t) words.set(m.id, { text: t, at: null, src: 'exam' }); }
  }
  // Only rows still without words (a correction or another pass since the read keeps its own).
  const stmts = misses.map(m => {
    const w = words.get(m.id);
    if (w) out.filled++; else out.none++;
    return env.DB.prepare(`UPDATE misses SET his_words = ?1, his_words_at = ?2, his_words_src = ?3 WHERE user_id = ?4 AND id = ?5 AND his_words IS NULL AND his_words_src IS NULL`)
      .bind(w ? w.text : null, w ? w.at : null, w ? w.src : 'none', user, m.id);
  });
  await env.DB.batch(stmts);
  return out;
}

/** The hourly job: one pass, one Recent activity line a day (counts added up), a failure posted too. */
export async function provenanceJob(env, user, { now = Date.now(), limit = PROVENANCE.limit } = {}) {
  try {
    const r = await provenancePass(env, user, { limit, now });
    if (r.looked) await noteJob(env, { job: 'provenance', user, key: londonDay(now), add: true, at: now, state: 'ok', counts: { filled: r.filled, none: r.none, left: r.left } });
    return r;
  } catch (e) {
    if (noTable(e)) return { skipped: 'migration 0055 not applied yet' };
    await noteJob(env, { job: 'provenance', user, key: londonDay(now), at: now, state: 'failed', detail: e });
    throw e;
  }
}

// POST /api/map/provenance {limit?}: a pass now (the backfill of older misses runs this until left is 0).
export async function provenanceRoute(request, env, ctx, params, url, user) {
  const body = (await readJson(request, 2_000).catch(() => ({}))) || {};
  for (const k of Object.keys(body)) if (k !== 'limit') throw new HttpError(400, `Unknown field ${k}.`);
  return json(await provenanceJob(env, user, { limit: body.limit }));
}
