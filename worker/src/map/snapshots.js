// "What changed overnight and why" (wave 2, 31 Oct 2026): before and after a weights change.
//
// Each topic's band and t1000 are kept just before its first recompute under a new WEIGHTS_VERSION (weakness.js
// recomputeTopics calls snapshotStatements with the stored row and the evidence it held then), with the look-alike
// penalty rows it carried. Once the colours are recomputed, overnight() compares each kept topic with its colour now
// and says why it moved, from what changed: a look-alike penalty gone (the re-judge found no confusion), a miss now
// counted by its cause, or new answers since. Shown once on the map (a small notice, then POST .../seen) and in
// map_overview for Claude while it is fresh.
//
//   snapshotStatements(DB, user, list, now)    INSERT OR IGNORE of the old rows [{stored, rows}] (pure but for DB.prepare)
//   overnight(env, user, {version, limit})      {version, taken_at, seen, items: [{topic_id, name, before, after, reason}], more}
//   overnightRoute / overnightSeenRoute        GET /api/map/overnight, POST /api/map/overnight/seen
import { json } from '../util.js';
import { noteJob, noteSql } from '../job-log.js';
import { WEIGHTS_VERSION, SHIPPED_WEIGHTS_VERSION, GATES, detailOf, guessM0 } from './weights.js';
import { bandWord } from '../../../public/js/map/scale.js';

export const OVERNIGHT = { limit: 12, min_dt: 40, fresh_ms: 3 * 86_400_000 };
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const t1000Of = row => (row && row.t != null ? Math.round(Number(row.t) * 1000) : null);
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const seenKey = (user, version) => `overnight_seen:${user}:v${version}`;

// The labels of a topic's look-alike penalty rows ("UW 15128"), from its evidence.
export const cwLabels = rows => [...new Set((rows || []).filter(r => r && r.kind === 'confused_with' && Number(r.held) !== 1)
  .map(r => detailOf(r).label || r.source_ref || r.obs_key).filter(Boolean).map(String))].slice(0, 12);

/**
 * The snapshot rows for topics about to be recomputed under WEIGHTS_VERSION whose stored score is older: one INSERT OR
 * IGNORE, so a topic keeps the state it had before the first recompute however many follow. list: [{topic_id,
 * stored (topic_scores row), rows (its evidence as stored, before this change)}].
 */
export function snapshotStatements(DB, user, list, now = Date.now()) {
  const old = (list || []).filter(x => x && x.stored && Number(x.stored.formula_version) < WEIGHTS_VERSION);
  if (!old.length) return [];
  const rows = old.map(x => ({ topic_id: x.topic_id, band: x.stored.band || 'unseen', t1000: t1000Of(x.stored), seen: Number(x.stored.seen) ? 1 : 0,
    why_json: typeof x.stored.why_json === 'string' ? x.stored.why_json : '[]', cw_json: JSON.stringify(cwLabels(x.rows)) }));
  // Its Recent activity line, in the same batch (one line per weights version, the topics added up).
  const { sql, binds } = noteSql({ job: 'overnight', key: `snap:v${WEIGHTS_VERSION}`, ref: 'snapshot', counts: { topics: old.length, version: WEIGHTS_VERSION }, add: true, at: now, user });
  return [DB.prepare(sql).bind(...binds), DB.prepare(`INSERT OR IGNORE INTO score_snapshots (user_id, version, topic_id, band, t1000, seen, why_json, cw_json, taken_at)
      SELECT ?1, ?2, json_extract(value, '$.topic_id'), json_extract(value, '$.band'), json_extract(value, '$.t1000'), json_extract(value, '$.seen'),
        json_extract(value, '$.why_json'), json_extract(value, '$.cw_json'), ?3 FROM json_each(?4) WHERE true`)
    .bind(user, WEIGHTS_VERSION, now, JSON.stringify(rows))];
}

export function reasonFor(name, before, after, ctx = {}) {
  const gone = (before.cw || []).filter(l => !(after.cw || []).includes(l));
  const dt = before.t1000 != null && after.t1000 != null ? after.t1000 - before.t1000 : null;
  if (before.band === after.band && !(dt != null && Math.abs(dt) >= OVERNIGHT.min_dt) && before.seen === after.seen) return null;
  if (before.seen && !after.seen) return `${name}: back to unseen; its only mark was a look-alike penalty${gone.length ? ` from ${gone.slice(0, 2).join(', ')}` : ''} that was not a mix-up`;
  if (gone.length) return `${name}: look-alike penalty from ${gone.slice(0, 2).join(', ')}${gone.length > 2 ? ` and ${gone.length - 2} more` : ''} removed (your words showed no mix-up)`;
  if ((after.cw || []).length > (before.cw || []).length) return `${name}: a real mix-up counted against it`;
  const dir = dt == null ? 'moved' : dt > 0 ? 'weaker' : 'stronger';
  // A switch to a challenger's rules (shadow mode, weight-sets.js): the move is the new rules', said as such.
  if (ctx && ctx.rules) return `${name}: ${dir} under the new scoring rules (${ctx.rules}), with any new answers since`;
  if (ctx && ctx.lifted && dir === 'stronger') return `${name}: ${ctx.lifted === 'deep' ? 'deep blue' : 'blue'} allowed: your viva and spaced card answers count now`;
  const m = ctx && ctx.m0;
  if (m && m.before != null && m.after != null && Math.abs(Math.round(100 * m.after) - Math.round(100 * m.before)) >= 1) {
    return `${name}: starting guess ${m.after > m.before ? 'raised' : 'lowered'} from ${Math.round(100 * m.before)}% to ${Math.round(100 * m.after)}% from your first answers`;
  }
  if (ctx && Number(ctx.version) >= 7) return `${name}: ${dir} with your new answers since`;
  return `${name}: ${dir} as its misses are now weighed by cause (reasoning slips and misreads count less than a missing fact), with any new answers since`;
}

/**
 * The gate a strong viva or right card days open on a stored topic_scores row now (pure): 'blue' when it is blue with
 * under 1.0 from right questions and re-tests, 'deep' when deep blue with under 2.5, else null.
 */
export function liftedOf(s) {
  if (!s || !(Number(s.gate_nq) > 0) || s.mastery == null) return null;
  const q = Number(s.q_pass) || 0, m = Number(s.mastery);
  return q < GATES.blue.q_pass && m > GATES.blue.max ? 'blue' : q < GATES.deep.q_pass && m > GATES.deep.max ? 'deep' : null;
}

/** The topics that moved since the snapshot of `version`, biggest first: {version, taken_at, seen, items, more}. */
export async function overnight(env, user, { version = WEIGHTS_VERSION, limit = OVERNIGHT.limit } = {}) {
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(`SELECT p.topic_id, p.band AS band_before, p.t1000 AS t1000_before, p.seen AS seen_before, p.cw_json, p.taken_at,
          s.band AS band_after, s.t AS t_after, s.seen AS seen_after, s.formula_version, t.name, t.category_id${version >= 8 ? ', s.q_pass, s.gate_nq, s.mastery' : ''}
        FROM score_snapshots p LEFT JOIN topic_scores s ON s.user_id = p.user_id AND s.topic_id = p.topic_id
          LEFT JOIN topics t ON t.user_id = p.user_id AND t.id = p.topic_id
        WHERE p.user_id = ?1 AND p.version = ?2`).bind(user, version),
      env.DB.prepare(`SELECT e.topic_id, e.kind, e.held, e.detail_json, e.source_ref, e.obs_key FROM evidence_live e
        WHERE e.user_id = ?1 AND e.kind = 'confused_with' AND e.topic_id IN (SELECT topic_id FROM score_snapshots WHERE user_id = ?1 AND version = ?2)`).bind(user, version),
      env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(seenKey(user, version)),
    ]);
  } catch (e) {
    if (noTable(e)) return { version, taken_at: null, seen: true, items: [], more: 0 };
    throw e;
  }
  // Version 7 learned the starting guess: each topic's m0 under the old rule (the version 'sg:base') and now. Only that
  // version's snapshot predates the learned guess, so a later version never names it again.
  let guess = null;
  if (version === 7) {
    const { readVersions, SG } = await import('./starting-guess.js');
    const vs = await readVersions(env, user).catch(() => []);
    const base = vs.find(v => v.id === SG.base_id), real = vs.filter(v => v.id !== SG.base_id);
    if (base && real.length) guess = { before: base.params, after: real[real.length - 1].params };
  }
  const snaps = res[0].results || [];
  const cwNow = new Map();
  for (const r of res[1].results || []) { if (!cwNow.has(r.topic_id)) cwNow.set(r.topic_id, []); cwNow.get(r.topic_id).push(r); }
  const all = [];
  for (const p of snaps) {
    if (p.formula_version != null && Number(p.formula_version) !== version) continue;   // not recomputed yet (or rules switched since)
    const before = { band: p.band_before || 'unseen', t1000: p.t1000_before == null ? null : Number(p.t1000_before), seen: Number(p.seen_before) ? 1 : 0, cw: parse(p.cw_json, []) };
    const after = { band: p.band_after || 'unseen', t1000: p.t_after == null ? null : Math.round(Number(p.t_after) * 1000), seen: Number(p.seen_after) ? 1 : 0,
      cw: cwLabels(cwNow.get(p.topic_id) || []) };
    const name = p.name || p.topic_id;
    const reason = reasonFor(name, before, after, { version, lifted: version >= 8 ? liftedOf(p) : null, rules: version > SHIPPED_WEIGHTS_VERSION ? `v${version}` : null,
      m0: guess ? { before: guessM0(guess.before, p.category_id), after: guessM0(guess.after, p.category_id) } : null });
    if (!reason) continue;
    all.push({ topic_id: p.topic_id, name, before: { band: before.band, band_words: bandWord(before.band), t1000: before.t1000 },
      after: { band: after.band, band_words: bandWord(after.band), t1000: after.t1000 }, reason,
      _size: Math.abs((after.t1000 ?? 0) - (before.t1000 ?? 0)) + (before.band !== after.band ? 1000 : 0) });
  }
  all.sort((a, b) => b._size - a._size || a.name.localeCompare(b.name));
  const items = all.slice(0, Math.max(1, Math.min(50, limit | 0 || OVERNIGHT.limit))).map(({ _size, ...x }) => x);
  // Recent activity: what moved and why, one line per weights version, updated as the recompute goes on.
  if (all.length) {
    await noteJob(env, { job: 'overnight', key: `list:v${version}`, ref: 'list', user, counts: { moved: all.length,
      penalties: all.filter(i => / penalty /.test(i.reason) && /removed|unseen/.test(i.reason)).length, unseen: all.filter(i => /back to unseen/.test(i.reason)).length,
      guess: all.filter(i => /starting guess/.test(i.reason)).length, lifted: all.filter(i => / allowed: your viva/.test(i.reason)).length, version } });
  }
  const takenAt = snaps.length ? Math.min(...snaps.map(p => Number(p.taken_at) || Infinity)) : null;
  return { version, taken_at: Number.isFinite(takenAt) ? takenAt : null, seen: !!(res[2].results || [])[0], items, more: Math.max(0, all.length - items.length) };
}

/** The overview's short form while it is fresh (Claude reads it in map_overview), or null. */
export async function overnightBrief(env, user, now = Date.now()) {
  const o = await overnight(env, user, { limit: 5 }).catch(e => { console.error('overnight failed', e && e.message); return null; });
  if (!o || !o.items.length || !o.taken_at || now - o.taken_at > OVERNIGHT.fresh_ms) return null;
  return { since: o.taken_at, lines: o.items.map(i => i.reason), more: o.more,
    say: o.version >= 8 ? 'A strong viva and right cards on different days now count toward blue, so topics never met in a real question can turn blue: tell Mo in a line what moved and why if he asks why a colour changed.'
      : o.version >= 7 ? 'The starting guess for new topics was learned from his own first answers overnight: tell Mo in a line what moved and why if he asks why a colour changed.'
      : 'The map was re-weighed by cause overnight: tell Mo in a line what moved and why if he asks why a colour changed.' };
}

export async function overnightRoute(request, env, ctx, params, url, user) {
  return json(await overnight(env, user, { limit: Number(url.searchParams.get('limit')) || OVERNIGHT.limit }));
}

// POST /api/map/overnight/seen: the map's notice was shown, so it is not shown again for this version.
export async function overnightSeenRoute(request, env, ctx, params, url, user) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .bind(seenKey(user, WEIGHTS_VERSION), JSON.stringify({ at: Date.now() })).run();
  return json({ ok: true });
}
