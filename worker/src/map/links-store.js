import { londonDay } from '../util.js';
import {
  LINK_TYPES, VISIBLE, EDITABLE, CODE_COLS, MIXED_UP, SOURCES, W, CAPS, aggregate, nextStatus, drawnChanged, normaliseLink,
  linkId, isMixedUp, decayed, pairOrder, orderName, markPairItems, pairTestSupport, pairLessonSupport, retestSupport, checkHow, versusLine,
} from './links.js';
import { leakIndexFor } from './guard.js';
import { HALF_LIFE } from './weights.js';
import { resolveTopic } from './resolve.js';
import { writeBatch } from './events.js';
import { leaks } from '../checks.js';
import { rowImportance } from '../../../public/js/shared/link-rank.js';

// Other areas' code, behind one object so tests can swap it (_setDeps).
const deps = {
  halfLifeDays: async () => HALF_LIFE.q,
  resolveTopic: (...a) => resolveTopic(...a),
  writeBatch: (...a) => writeBatch(...a),
};
export function _setDeps(over) {
  const prev = { ...deps };
  Object.assign(deps, over);
  return () => Object.assign(deps, prev);
}
export const halfLife = () => deps.halfLifeDays();

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const ids = list => JSON.stringify([...new Set((list || []).filter(x => x != null).map(String))]);
const short = s => { const t = String(s || '').trim(); return t.length > 60 ? t.slice(0, 59).trimEnd() + '…' : t; };
const parse = v => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const VIS_SQL = "('active','proposed')";

// ------------------------------------------------------------------ reads

/**
 * One D1 batch: the topics named (and the ends of the links named), the links among them or by id, and every
 * support row of those links. {topics: Map, links: [], support: Map(link_id -> rows)}.
 */
export async function readState(env, user, { topicIds = [], linkIds = [] } = {}) {
  const t = ids(topicIds), l = ids(linkIds);
  const [tr, lr, sr] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, short_name, kind, status, merged_into, yield FROM topics WHERE user_id = ?1 AND (id IN (SELECT value FROM json_each(?2))
      OR id IN (SELECT from_id FROM links WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?3)))
      OR id IN (SELECT to_id FROM links WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?3))))`).bind(user, t, l),
    env.DB.prepare(`SELECT * FROM links WHERE user_id = ?1 AND (id IN (SELECT value FROM json_each(?3))
      OR (from_id IN (SELECT value FROM json_each(?2)) AND to_id IN (SELECT value FROM json_each(?2))))`).bind(user, t, l),
    env.DB.prepare(`SELECT * FROM link_support WHERE user_id = ?1 AND link_id IN (SELECT id FROM links WHERE user_id = ?1 AND (id IN (SELECT value FROM json_each(?3))
      OR (from_id IN (SELECT value FROM json_each(?2)) AND to_id IN (SELECT value FROM json_each(?2))))) ORDER BY at, id`).bind(user, t, l),
  ]);
  const topics = new Map((tr.results || []).map(x => [x.id, x]));
  const support = new Map();
  for (const s of sr.results || []) { if (!support.has(s.link_id)) support.set(s.link_id, []); support.get(s.link_id).push(s); }
  return { topics, links: lr.results || [], support };
}

// ------------------------------------------------------------------ snapshots and summaries

// A link as map_events keeps it: the row without its support, plus the support rows this change touched.
export function snapshot(link, touched = []) {
  if (!link) return null;
  const s = {};
  for (const k of ['id', 'type', 'from_id', 'to_id', 'directed', ...EDITABLE, 'strength', 'confusion', 'removed_by', 'removed_reason']) s[k] = link[k] ?? null;
  if (touched.length) s.support = touched.map(r => ({ obs_key: r.obs_key, w: r.w, cw: r.cw }));
  return s;
}

const nameOf = (topics, id) => short((topics.get(id) || {}).name || id);
export function pairName(topics, link) {
  return `${nameOf(topics, link.from_id)} and ${nameOf(topics, link.to_id)}`;
}
function summaryFor(topics, before, after, label) {
  const pair = pairName(topics, after);
  const from = label ? ` (${short(label)})` : '';
  let what;
  if (!before || before.status === 'held' || (before.status === 'removed' && before.removed_by === 'undo')) what = after.type === 'versus' ? (isMixedUp(after.confusion) ? 'mixed up' : 'look-alikes') : LINK_TYPES[after.type].label.toLowerCase();
  else if (after.status === 'removed') what = 'link removed';
  else if (before.status === 'removed') what = 'link restored';
  else if (isMixedUp(before.confusion || 0) && !isMixedUp(after.confusion || 0)) what = 'no longer mixed up';
  else if (!isMixedUp(before.confusion || 0) && isMixedUp(after.confusion || 0)) what = 'mixed up';
  else what = 'link updated';
  return `${pair}: ${what}${from}`.slice(0, 160);
}

// ------------------------------------------------------------------ the engine

const SUPPORT_COLS = ['src', 'role', 'w', 'cw', 'truth_id', 'text', 'miss_id', 'card_id', 'note_id', 'gap_id', 'lesson_id', 'sitting_id', 'held', 'at'];
const LINK_FIELDS = ['how', 'a_vs_b', 'b_vs_a', 'note', 'picture'];

// A topic a link may point at: live (not merged or retired).
const liveTopic = t => t && t.status !== 'merged' && t.status !== 'retired';

export async function planLinks(env, user, proposals, ctx = {}) {
  const now = ctx.now || Date.now();
  const hl = ctx.hl || await halfLife();
  const list = (proposals || []).filter(Boolean);
  if (!list.length) return { rows: [], events: [], links: [], problems: [] };
  const state = ctx.state || await readState(env, user, {
    topicIds: list.flatMap(p => [p.from, p.to]).filter(Boolean),
    linkIds: list.map(p => p.link_id).filter(Boolean),
  });
  const { topics } = state;
  const byKey = new Map(state.links.map(l => [`${l.type}|${l.from_id}|${l.to_id}`, l]));
  const byId = new Map(state.links.map(l => [l.id, l]));
  const problems = [];
  const work = new Map(); // link id -> {link (before), next, isNew, support: Map(obs_key -> row), touched: Map, label}

  for (const p of list) {
    let link, norm;
    if (p.link_id) {
      link = byId.get(p.link_id);
      if (!link) { problems.push({ link_id: p.link_id, why: 'No link has that id.' }); continue; }
    } else {
      const ta = topics.get(p.from), tb = topics.get(p.to);
      if (!liveTopic(ta) || !liveTopic(tb)) { problems.push({ from: p.from, to: p.to, why: 'A topic is missing, merged or retired.' }); continue; }
      const kinds = { [p.from]: ta.kind, [p.to]: tb.kind };
      norm = normaliseLink({ type: p.type, from: p.from, to: p.to, a_vs_b: p.a_vs_b ?? null, b_vs_a: p.b_vs_a ?? null, kinds });
      if (norm.error) { problems.push({ from: p.from, to: p.to, why: norm.error }); continue; }
      link = byKey.get(`${norm.type}|${norm.from_id}|${norm.to_id}`);
    }
    let w = link && work.get(link.id);
    if (!link) {
      if (p.create === false) { problems.push({ from: p.from, to: p.to, why: 'There is no such link.' }); continue; }
      const id = await linkId(user, norm.type, norm.from_id, norm.to_id);
      const fresh = { id, user_id: user, type: norm.type, from_id: norm.from_id, to_id: norm.to_id, directed: norm.directed,
        how: p.how ?? null, a_vs_b: norm.a_vs_b, b_vs_a: norm.b_vs_a, note: p.note ?? null, picture: p.picture ?? null,
        strength: 0, support_n: 0, confusion: 0, confusion_at: null, confused_n: 0, last_confused_at: null, last_truth_id: null, last_tested_at: null,
        status: p.status === 'proposed' ? 'proposed' : 'held', source: p.source || (p.support && p.support.src) || p.by || 'code',
        source_ref: p.source_ref ?? null, created_by: p.by || 'code', created_at: now, updated_at: now, removed_at: null, removed_by: null, removed_reason: null };
      byKey.set(`${fresh.type}|${fresh.from_id}|${fresh.to_id}`, fresh);
      byId.set(id, fresh);
      state.support.set(id, []);
      w = { link: null, next: { ...fresh }, isNew: true, support: new Map(), touched: new Map(), label: p.label || null };
      work.set(id, w);
    } else if (!w) {
      w = { link, next: { ...link }, isNew: false, support: new Map((state.support.get(link.id) || []).map(s => [s.obs_key, { ...s }])), touched: new Map(), label: p.label || null };
      work.set(link.id, w);
    }
    const next = w.next;
    if (!w.label && p.label) w.label = p.label;
    // Facts and fields: fill empty ones (or set them when asked); a swapped pair swaps its facts.
    const given = norm ? { ...p, a_vs_b: norm.a_vs_b, b_vs_a: norm.b_vs_a } : p;
    for (const f of LINK_FIELDS) {
      if (given[f] == null || given[f] === '') continue;
      if (p.set_fields || next[f] == null || next[f] === '') next[f] = given[f];
    }
    if (p.restore && next.status === 'removed') {
      Object.assign(next, { status: 'active', removed_at: null, removed_by: null, removed_reason: null });
    }
    if (p.support) addSupport(w, p.support, now, user, next.id);
  }

  const rows = [], events = [], links = [];
  for (const w of work.values()) {
    const all = [...w.support.values()];
    const next = w.next;
    const touched = [...w.touched.values()];
    // Code columns move only with the support that moves them; a fact or a restore alone keeps them.
    const changed = w.isNew || touched.length || EDITABLE.concat('removed_by').some(k => (w.link[k] ?? null) !== (next[k] ?? null));
    if (!changed) { links.push({ link_id: next.id, op: 'unchanged', link: next, before: w.link }); continue; }
    if (w.isNew || touched.length) Object.assign(next, aggregate(all, now, hl, next.type));
    // An undone add is not a tombstone: new support brings the link back as code would have made it.
    if (next.status === 'removed' && next.removed_by === 'undo' && touched.some(t => t.row.w > 0 || t.row.cw)) {
      Object.assign(next, { status: 'held', removed_at: null, removed_by: null, removed_reason: null });
    }
    next.status = nextStatus(next.status, all);
    next.updated_at = now;
    if (w.isNew) rows.push({ table: 'links', op: 'insert', key: { user_id: user, id: next.id }, before: null, after: withoutKey(next, ['user_id', 'id']) });
    else {
      const after = {};
      for (const k of Object.keys(next)) if (k !== 'id' && k !== 'user_id' && (w.link[k] ?? null) !== (next[k] ?? null)) after[k] = next[k];
      rows.push({ table: 'links', op: 'update', key: { user_id: user, id: next.id }, before: w.link, after });
    }
    for (const t of touched) {
      if (t.isNew) rows.push({ table: 'link_support', op: 'insert', key: { user_id: user, link_id: next.id, obs_key: t.row.obs_key }, before: null, after: supportAfter(t.row) });
      else {
        const after = {};
        for (const k of ['w', 'cw', 'role', 'truth_id', 'held', 'sitting_id']) if ((t.before[k] ?? null) !== (t.row[k] ?? null)) after[k] = t.row[k];
        rows.push({ table: 'link_support', op: 'update', key: { user_id: user, link_id: next.id, obs_key: t.before.obs_key }, before: t.before, after });
      }
    }
    const visibleBefore = w.link && VISIBLE.includes(w.link.status);
    const undone = w.link && w.link.status === 'removed' && w.link.removed_by === 'undo';
    const op = w.isNew || undone || (w.link && w.link.status === 'held') ? 'created' : w.link.status === 'removed' && next.status !== 'removed' ? 'restored' : 'supported';
    links.push({ link_id: next.id, op, link: next, before: w.link });
    const show = VISIBLE.includes(next.status) || (visibleBefore && next.status === 'removed');
    if (show && (!visibleBefore || drawnChanged(w.link, next) || ctx.undoable)) {
      // A held or undone link keeps its earlier row as before, so undoing this puts it back as it was.
      const before = w.link || null;
      const wasShown = visibleBefore || (w.link && w.link.status === 'removed' && w.link.removed_by !== 'undo');
      events.push({
        kind: !wasShown ? 'link.added' : next.status === 'removed' ? 'link.removed' : 'link.updated',
        target_type: 'link', target_id: next.id, topic_id: next.from_id,
        summary: summaryFor(topics, before, next, w.label),
        before: before ? snapshot(before, touched.map(t => t.before || { obs_key: t.row.obs_key, w: 0, cw: 0 })) : null,
        after: snapshot(next, touched.map(t => t.row)),
        ...(ctx.undoable == null ? { undoable: false } : {}),
      });
    }
  }
  return { rows, events, links, problems, topics };
}

const withoutKey = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const supportAfter = r => { const o = {}; for (const k of [...SUPPORT_COLS, 'created_at']) if (r[k] != null && !(k === 'held' && !r[k])) o[k] = r[k]; return o; };

// One observation on a link in work: new, or an enrichment that only raises w or |cw| (or releases it).
function addSupport(w, s, now, user, link_id) {
  if (!s || typeof s.obs_key !== 'string' || !s.obs_key) return;
  const src = SOURCES.includes(s.src) ? s.src : 'derived';
  const row = { user_id: user, link_id, obs_key: s.obs_key.slice(0, 120), src, role: s.role || 'named', w: +s.w || 0, cw: +s.cw || 0,
    truth_id: s.truth_id ?? null, text: s.text ?? null, miss_id: s.miss_id ?? null, card_id: s.card_id ?? null, note_id: s.note_id ?? null,
    gap_id: s.gap_id ?? null, lesson_id: s.lesson_id ?? null, sitting_id: s.sitting_id ?? null, held: s.held ? 1 : 0,
    at: Number.isFinite(s.at) ? s.at : now, created_at: now };
  const have = w.support.get(row.obs_key);
  if (!have) {
    w.support.set(row.obs_key, row);
    w.touched.set(row.obs_key, { row, isNew: true, before: null });
    return;
  }
  const was = w.touched.get(row.obs_key);
  const before = was ? was.before : { ...have };
  const up = { ...have };
  if (s.force) Object.assign(up, { w: row.w, cw: row.cw, role: row.role, truth_id: row.truth_id });
  else {
    if (row.w > up.w) up.w = row.w;
    if (Math.abs(row.cw) > Math.abs(up.cw)) Object.assign(up, { cw: row.cw, role: row.role, truth_id: row.truth_id ?? up.truth_id });
  }
  if (up.held && !row.held) up.held = 0;
  if (['w', 'cw', 'held', 'role', 'truth_id'].every(k => (up[k] ?? null) === (have[k] ?? null))) return;
  w.support.set(row.obs_key, up);
  w.touched.set(row.obs_key, { row: up, isNew: was ? was.isNew : false, before: was ? was.before : before });
}

// ------------------------------------------------------------------ release, pair tests, re-tests

export async function staleSupport(env, user, misses, ctx = {}) {
  const list = (misses || []).filter(m => m && m.id);
  if (!list.length) return { rows: [], events: [] };
  let sup;
  try {
    sup = (await env.DB.prepare(`SELECT s.link_id, s.obs_key, s.miss_id, s.src, s.role, s.truth_id, l.from_id, l.to_id FROM link_support s
        JOIN links l ON l.user_id = s.user_id AND l.id = s.link_id
        WHERE s.user_id = ? AND s.miss_id IN (SELECT value FROM json_each(?)) AND (s.w > 0 OR s.cw != 0)`).bind(user, ids(list.map(m => m.id))).all()).results || [];
  } catch (e) { if (noTable(e)) return { rows: [], events: [] }; throw e; }
  const topicOf = new Map(list.map(m => [String(m.id), m.topic_id || null]));
  const stale = sup.filter(r => { const t = topicOf.get(String(r.miss_id)); return !t || (r.from_id !== t && r.to_id !== t); });
  if (!stale.length) return { rows: [], events: [] };
  const r = await planLinks(env, user, stale.map(x => ({ link_id: x.link_id, by: 'code',
    support: { obs_key: x.obs_key, src: x.src, role: x.role, truth_id: x.truth_id, miss_id: x.miss_id, w: 0, cw: 0, force: true } })), { now: ctx.now });
  return { rows: r.rows, events: r.events };
}

/** A finished sitting: its held support released and its links recomputed, for realtime's releaseSitting batch. */
export async function releaseLinks(env, user, sittingId, ctx = {}) {
  let held;
  try {
    held = (await env.DB.prepare('SELECT link_id, obs_key FROM link_support WHERE user_id = ? AND sitting_id = ? AND held = 1').bind(user, String(sittingId)).all()).results || [];
  } catch (e) { if (noTable(e)) return { rows: [], events: [] }; throw e; }
  if (!held.length) return { rows: [], events: [] };
  const proposals = held.map(h => ({ link_id: h.link_id, support: { obs_key: h.obs_key, held: 0, w: 0, cw: 0 } }));
  // w 0 and cw 0 never lower an existing row; held 1 -> 0 is the only change.
  const r = await planLinks(env, user, proposals, ctx);
  return { rows: r.rows, events: r.events };
}

// Days compare in London time: a check on a later day than the last mix-up or lesson is delayed proof.
const laterDay = (at, ref) => ref != null && londonDay(at) > londonDay(ref);

export async function applyPairTest(env, user, { lesson_id, link_id, kind = 'pair_test', items, outcome, at, taught_at = null }, ctx = {}) {
  const now = ctx.now || Date.now();
  const when = Number.isFinite(at) ? at : now;
  const state = ctx.state || await readState(env, user, { linkIds: [link_id] });
  const link = state.links.find(l => l.id === link_id);
  if (!link || !VISIBLE.includes(link.status)) return { error: 'That pair is not on the map.' };
  if (link.type !== 'versus') return { error: 'Only look-alike pairs are tested.' };
  let support, marks = null, right_n = null, order = null;
  if (kind === 'pair_test') {
    order = pairOrder(lesson_id);
    const m = markPairItems(items, order);
    if (m.error) return { error: m.error, order };
    ({ marks, right_n, outcome } = m);
    const ref = Math.max(link.last_confused_at || 0, link.last_tested_at || 0, taught_at || 0) || null;
    support = pairTestSupport({ lessonId: lesson_id, marks, link, at: when, delayed: laterDay(when, ref) });
  } else {
    const s = pairLessonSupport({ lessonId: lesson_id, outcome, at: when });
    if (!s) return { error: 'A pair lesson needs its outcome (landed, partial or not_landed).' };
    support = [s];
  }
  const r = await planLinks(env, user, support.map(s => ({ link_id, support: { ...s, force: true }, label: kind === 'pair_test' ? `pair test ${right_n}/4` : 'pair lesson' })), { ...ctx, now, state });
  return { rows: r.rows, events: r.events, marks, right_n, outcome, order, link: r.links[0] && r.links[0].link };
}

/** A concept re-test result on a miss: every versus link that miss supports moves (v1.5; realtime's re-test ingestion). */
export async function applyRetest(env, user, { miss_id, mistake_id, due, result, at }, ctx = {}) {
  let sup;
  try {
    sup = (await env.DB.prepare(`SELECT s.link_id, s.truth_id FROM link_support s JOIN links l ON l.id = s.link_id AND l.user_id = s.user_id
      WHERE s.user_id = ? AND s.miss_id = ? AND s.held = 0 AND l.type = 'versus' AND l.status IN ${VIS_SQL}`).bind(user, String(miss_id)).all()).results || [];
  } catch (e) { if (noTable(e)) return { rows: [], events: [] }; throw e; }
  const proposals = [];
  for (const s of sup) {
    const row = retestSupport({ missId: miss_id, mistakeId: mistake_id, due, result, at: Number.isFinite(at) ? at : Date.now(), truthId: s.truth_id });
    if (row) proposals.push({ link_id: s.link_id, support: row, label: 're-test' });
  }
  if (!proposals.length) return { rows: [], events: [] };
  const r = await planLinks(env, user, proposals, ctx);
  return { rows: r.rows, events: r.events };
}

// ------------------------------------------------------------------ the hourly decay

/**
 * Decays every versus confusion to now in one statement (the plan's pow() UPDATE) and emits link.updated for
 * pairs that stop being mixed up. Run hourly by the minute dispatcher (m = 29). Returns {n, crossed}.
 */
export async function decayLinks(env, user, now = Date.now()) {
  const hl = await halfLife();
  let rows;
  try {
    rows = (await env.DB.prepare(`SELECT l.id, l.from_id, l.to_id, l.type, l.status, l.confusion, l.confusion_at, ta.name AS a_name, tb.name AS b_name
      FROM links l LEFT JOIN topics ta ON ta.user_id = l.user_id AND ta.id = l.from_id LEFT JOIN topics tb ON tb.user_id = l.user_id AND tb.id = l.to_id
      WHERE l.user_id = ? AND l.type = 'versus' AND l.confusion >= ? AND l.status IN ${VIS_SQL}`).bind(user, MIXED_UP).all()).results || [];
  } catch (e) { if (noTable(e)) return { n: 0, crossed: 0 }; throw e; }
  const events = [];
  for (const r of rows) {
    const c = decayed(r.confusion, r.confusion_at, now, hl);
    if (c >= MIXED_UP) continue;
    events.push({ kind: 'link.updated', target_type: 'link', target_id: r.id, topic_id: r.from_id, undoable: false,
      summary: `${short(r.a_name || r.from_id)} and ${short(r.b_name || r.to_id)}: no longer mixed up`.slice(0, 160),
      before: { id: r.id, confusion: r.confusion }, after: { id: r.id, confusion: c } });
  }
  const stmt = env.DB.prepare(`UPDATE links SET confusion = round(confusion * pow(0.5, (?2 - confusion_at) / ?3), 4), confusion_at = ?2
    WHERE user_id = ?1 AND type = 'versus' AND confusion > 0.01 AND confusion_at IS NOT NULL AND confusion_at < ?2`).bind(user, now, hl * 86_400_000);
  if (!events.length) { await stmt.run(); return { n: rows.length, crossed: 0 }; }
  await deps.writeBatch(env, user, { actor: 'cron', surface: 'cron', via: 'cron:links.decay', statements: [stmt], events, undoable: false });
  return { n: rows.length, crossed: events.length };
}

// ------------------------------------------------------------------ readers

const dayOf = at => (at ? londonDay(at) : null);

export function sourceLabel(s) {
  const k = String(s.obs_key || '');
  let m;
  if ((m = /^anking_hy_(\d+)/.exec(k))) return `AnKing HY ${m[1]}`;
  if ((m = /^anki:(\d+)/.exec(k))) return `Anki #${m[1]}`;
  if ((m = /^uw:(\d+)/.exec(k))) return `UW ${m[1]}`;
  if (/^hub:/.test(k)) return 'NBME';
  if (/^gap:/.test(k)) return `gap ${new Date(s.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' })}`;
  if (/^lesson:/.test(k)) return 'lesson';
  if (/^retest:/.test(k)) return 're-test';
  return { claude: 'Claude', mo: 'Mo', seed: 'seed', onenote: 'OneNote', mehlman: 'Mehlman', card: 'card', extractor: 'suggested' }[s.src] || s.src;
}

/**
 * A topic's links, mixed-up pairs first, then by importance: map_neighbours, the panel and teach_next.
 * opts: {types?: [], confused_only?, limit (1-24)}. Held and removed links never show. One D1 batch.
 */
export async function neighbours(env, user, topicId, { types = null, confused_only = false, limit = 24 } = {}) {
  const lim = Math.max(1, Math.min(24, Number(limit) || 24));
  const tlist = Array.isArray(types) && types.length ? types.filter(t => LINK_TYPES[t]) : Object.keys(LINK_TYPES);
  const now = Date.now();
  const hl = await halfLife();
  const linkSql = `SELECT * FROM links WHERE user_id = ?1 AND (from_id = ?2 OR to_id = ?2) AND status IN ${VIS_SQL}
    AND type IN (SELECT value FROM json_each(?3)) ${confused_only ? `AND type = 'versus' AND confusion >= ${MIXED_UP}` : ''} ORDER BY confusion DESC, strength DESC LIMIT 200`;
  let links, others, support, scores = [];
  try {
    const [lr, tr, sr] = await env.DB.batch([
      env.DB.prepare(linkSql).bind(user, topicId, JSON.stringify(tlist)),
      env.DB.prepare(`SELECT id, name, yield FROM topics WHERE user_id = ?1 AND (id = ?2 OR id IN (SELECT to_id FROM links WHERE user_id = ?1 AND from_id = ?2)
        OR id IN (SELECT from_id FROM links WHERE user_id = ?1 AND to_id = ?2))`).bind(user, topicId),
      env.DB.prepare(`SELECT link_id, obs_key, src, at FROM link_support WHERE user_id = ?1 AND held = 0 AND (w > 0 OR cw != 0)
        AND link_id IN (SELECT id FROM links WHERE user_id = ?1 AND (from_id = ?2 OR to_id = ?2) AND status IN ${VIS_SQL}) ORDER BY at DESC`).bind(user, topicId),
    ]);
    [links, others, support] = [lr.results || [], tr.results || [], sr.results || []];
  } catch (e) { if (noTable(e)) return []; throw e; }
  try {
    scores = (await env.DB.prepare(`SELECT topic_id, t, seen FROM topic_scores WHERE user_id = ?1 AND (topic_id = ?2 OR topic_id IN (SELECT to_id FROM links WHERE user_id = ?1 AND from_id = ?2)
      OR topic_id IN (SELECT from_id FROM links WHERE user_id = ?1 AND to_id = ?2))`).bind(user, topicId).all()).results || [];
  } catch (e) { if (!noTable(e)) throw e; }
  const topic = new Map(others.map(t => [t.id, t]));
  const score = new Map(scores.map(s => [s.topic_id, s]));
  const t1000 = id => { const s = score.get(id); return s && s.seen && s.t != null ? Math.round(s.t * 1000) : null; };
  const sources = new Map();
  for (const s of support) {
    const list = sources.get(s.link_id) || [];
    const lab = sourceLabel(s);
    if (!list.includes(lab) && list.length < 4) list.push(lab);
    sources.set(s.link_id, list);
  }
  const rows = links.map(l => {
    const mine = l.from_id === topicId;
    const other = mine ? l.to_id : l.from_id;
    const c = decayed(l.confusion, l.confusion_at, now, hl);
    const truth = l.last_truth_id;
    const tookFor = truth && l.type === 'versus' && c > 0
      ? `You took ${short((topic.get(truth) || {}).name || truth)} for ${short((topic.get(truth === l.from_id ? l.to_id : l.from_id) || {}).name || '')}` : null;
    const row = [0, 1, LINK_TYPES[l.type].code, Math.round(l.strength * 100), Math.round(Math.min(c, 2.55) * 100), 0];
    return {
      link_id: l.id, type: l.type, direction: l.directed ? (mine ? 'out' : 'in') : 'both',
      other: { id: other, name: (topic.get(other) || {}).name || other, t: t1000(other), seen: !!(score.get(other) || {}).seen },
      side: mine ? 'a' : 'b', fact: (mine ? l.a_vs_b : l.b_vs_a) || null, how: l.how, note: l.note,
      confusion: Math.round(c * 10) / 10, mixed_up: l.type === 'versus' && isMixedUp(c), confused_n: l.confused_n,
      last_confused_day: dayOf(l.last_confused_at), took_for: tookFor, strength: Math.round(l.strength * 100) / 100,
      picture: l.picture, status: l.status, sources: sources.get(l.id) || [],
      _imp: rowImportance(row, [t1000(topicId), t1000(other)], [Math.round(((topic.get(topicId) || {}).yield || 0) * 100), Math.round(((topic.get(other) || {}).yield || 0) * 100)]),
    };
  });
  rows.sort((a, b) => (b.mixed_up - a.mixed_up) || (b._imp - a._imp));
  return rows.slice(0, lim).map(({ _imp, ...r }) => r);
}

/** teach_next's look_alikes (at most 3): versus partners, by confusion then importance. */
export async function lookAlikes(env, user, topicId, limit = 3) {
  const rows = await neighbours(env, user, topicId, { types: ['versus'], limit: 24 });
  rows.sort((a, b) => (b.confusion - a.confusion) || 0);
  return rows.slice(0, Math.max(1, Math.min(3, limit))).map(r => ({
    link_id: r.link_id, other: r.other, side: r.side, fact: r.fact, confusion: r.confusion, confused_n: r.confused_n,
    last_confused_day: r.last_confused_day, took_for: r.took_for, picture: r.picture,
  }));
}

/** The top versus pairs by confusion × max(yield): map_weakest {purpose:'pairs'} and the Review page's list. */
export async function topPairs(env, user, limit = 10, { mixedOnly = true } = {}) {
  const lim = Math.max(1, Math.min(50, Number(limit) || 10));
  const now = Date.now();
  const hl = await halfLife();
  let rows;
  try {
    rows = (await env.DB.prepare(`SELECT l.id, l.from_id, l.to_id, l.confusion, l.confusion_at, l.confused_n, l.last_confused_at, l.last_truth_id,
        l.last_tested_at, l.a_vs_b, l.b_vs_a, l.picture, ta.name AS a_name, tb.name AS b_name, ta.yield AS a_yield, tb.yield AS b_yield
      FROM links l JOIN topics ta ON ta.user_id = l.user_id AND ta.id = l.from_id JOIN topics tb ON tb.user_id = l.user_id AND tb.id = l.to_id
      WHERE l.user_id = ? AND l.type = 'versus' AND l.status IN ${VIS_SQL} AND l.confusion > 0.01
      ORDER BY l.confusion * max(coalesce(ta.yield, 0), coalesce(tb.yield, 0), 0.1) DESC LIMIT 200`).bind(user).all()).results || [];
  } catch (e) { if (noTable(e)) return []; throw e; }
  return rows.map(r => {
    const c = decayed(r.confusion, r.confusion_at, now, hl);
    const y = Math.max(r.a_yield || 0, r.b_yield || 0, 0.1);
    return { link_id: r.id, a: { id: r.from_id, name: r.a_name }, b: { id: r.to_id, name: r.b_name }, confusion: Math.round(c * 100) / 100,
      mixed_up: isMixedUp(c), confused_n: r.confused_n, last_confused_day: dayOf(r.last_confused_at), last_tested_day: dayOf(r.last_tested_at),
      took_for: r.last_truth_id ? `You took ${short(r.last_truth_id === r.from_id ? r.a_name : r.b_name)} for ${short(r.last_truth_id === r.from_id ? r.b_name : r.a_name)}` : null,
      vs_a: r.a_vs_b, vs_b: r.b_vs_a, picture: r.picture, rank: Math.round(c * y * 1000) / 1000 };
  }).filter(r => !mixedOnly || r.mixed_up).sort((a, b) => b.rank - a.rank).slice(0, lim);
}

/** One pair for teach_next's pair modes: both sides, both facts and, given the lesson id, the order of the four cases. */
export async function pairBrief(env, user, linkId, lessonId = null) {
  let r;
  try {
    r = await env.DB.prepare(`SELECT l.*, ta.name AS a_name, tb.name AS b_name FROM links l
      JOIN topics ta ON ta.user_id = l.user_id AND ta.id = l.from_id JOIN topics tb ON tb.user_id = l.user_id AND tb.id = l.to_id
      WHERE l.user_id = ? AND l.id = ? AND l.type = 'versus' AND l.status IN ${VIS_SQL}`).bind(user, linkId).first();
  } catch (e) { if (noTable(e)) return null; throw e; }
  if (!r) return null;
  const hl = await halfLife();
  const order = lessonId ? pairOrder(lessonId) : null;
  return { link_id: r.id, a: { id: r.from_id, name: r.a_name }, b: { id: r.to_id, name: r.b_name }, vs_a: r.a_vs_b, vs_b: r.b_vs_a,
    confusion: Math.round(decayed(r.confusion, r.confusion_at, Date.now(), hl) * 100) / 100, picture: r.picture,
    ...(order ? { order: orderName(order), order_list: order } : {}) };
}

// ------------------------------------------------------------------ merges (taxonomy's mergeTopics, v1.5)

/**
 * Re-points fromId's links onto intoId, for taxonomy's merge batch: {rows, events, repointed: {links: [ids]}}.
 * A key collision moves the support onto the older link and removes the newer one (reason 'merged'); a versus
 * link that becomes a self-link is removed with reason 'merged'. Ids are kept, so undoMerge can restore them.
 * taxonomy's topic.merge entry needs LINK_WRITES (registry/links.js) in its writes.
 */
export async function relinkOnMerge(env, user, fromId, intoId, ctx = {}) {
  const now = ctx.now || Date.now();
  let state;
  try {
    const lr = await env.DB.prepare(`SELECT id FROM links WHERE user_id = ?1 AND (from_id = ?2 OR to_id = ?2)`).bind(user, fromId).all();
    const mine = (lr.results || []).map(r => r.id);
    if (!mine.length) return { rows: [], events: [], repointed: { links: [] } };
    const touched = await env.DB.prepare(`SELECT DISTINCT CASE WHEN from_id = ?2 THEN to_id ELSE from_id END AS other FROM links WHERE user_id = ?1 AND (from_id = ?2 OR to_id = ?2)`).bind(user, fromId).all();
    state = await readState(env, user, { topicIds: [intoId, fromId, ...(touched.results || []).map(r => r.other)], linkIds: mine });
  } catch (e) { if (noTable(e)) return { rows: [], events: [], repointed: { links: [] } }; throw e; }
  const hl = ctx.hl || await halfLife();
  const rows = [], events = [], moved = [];
  const byKey = new Map(state.links.map(l => [`${l.type}|${l.from_id}|${l.to_id}`, l]));
  for (const l of state.links.filter(x => x.from_id === fromId || x.to_id === fromId)) {
    const from = l.from_id === fromId ? intoId : l.from_id;
    const to = l.to_id === fromId ? intoId : l.to_id;
    moved.push(l.id);
    if (from === to) {
      if (l.status !== 'removed') rows.push({ table: 'links', op: 'update', key: { user_id: user, id: l.id }, before: l, after: { status: 'removed', removed_at: now, removed_by: 'code', removed_reason: 'merged', updated_at: now } });
      continue;
    }
    const swap = l.type === 'versus' && from > to;
    const nf = swap ? to : from, nt = swap ? from : to;
    const other = byKey.get(`${l.type}|${nf}|${nt}`);
    if (other && other.id !== l.id) {
      // Collision: keep the older link, move this one's support onto it, recompute it, remove this one.
      const keep = other.created_at <= l.created_at ? other : l;
      const drop = keep === other ? l : other;
      const keepRows = [...(state.support.get(keep.id) || [])];
      const keepKeys = new Set(keepRows.map(s => s.obs_key));
      for (const s of state.support.get(drop.id) || []) {
        if (keepKeys.has(s.obs_key)) continue;
        rows.push({ table: 'link_support', op: 'update', key: { user_id: user, id: s.id }, before: s, after: { link_id: keep.id } });
        keepRows.push({ ...s, link_id: keep.id });
      }
      const agg = aggregate(keepRows, now, hl, keep.type);
      const keepAfter = { ...agg, updated_at: now };
      if (keep === l) Object.assign(keepAfter, { from_id: nf, to_id: nt, ...(swap ? { a_vs_b: l.b_vs_a, b_vs_a: l.a_vs_b } : {}) });
      for (const f of ['a_vs_b', 'b_vs_a', 'picture', 'how', 'note']) if (keepAfter[f] == null && keep[f] == null && drop[f] != null) keepAfter[f] = drop[f];
      rows.push({ table: 'links', op: 'update', key: { user_id: user, id: drop.id }, before: drop, after: { status: 'removed', removed_at: now, removed_by: 'code', removed_reason: 'merged', updated_at: now } });
      rows.push({ table: 'links', op: 'update', key: { user_id: user, id: keep.id }, before: keep, after: keepAfter });
      continue;
    }
    rows.push({ table: 'links', op: 'update', key: { user_id: user, id: l.id }, before: l,
      after: { from_id: nf, to_id: nt, updated_at: now, ...(swap ? { a_vs_b: l.b_vs_a, b_vs_a: l.a_vs_b } : {}) } });
    byKey.set(`${l.type}|${nf}|${nt}`, { ...l, from_id: nf, to_id: nt });
  }
  return { rows, events, repointed: { links: moved } };
}

// ------------------------------------------------------------------ undo (realtime's undoBatch calls this)

/**
 * Undoes one link event (link.added, link.updated, link.removed, or the 'undo' event this handler wrote,
 * which redoes it). Code support may have changed the row since, so the conflict check compares only the
 * editable fields; the change's own support rows go back to their earlier w and cw (0 for rows it added), and
 * strength and confusion are recomputed. A link that had no earlier state is soft-removed (removed_by 'undo',
 * which link.add treats as never removed).
 * Called by undo.js as handler(env, user, event, ctx); returns {rows} or {conflict: true, reason}. The rows are
 * keyed by the tables' own keys (links id, link_support user_id + link_id + obs_key), so undoing the undo
 * (a redo) is undo.js's plain restoreRow on each of them.
 */
export async function undoLinkEvent(env, user, event, ctx = {}) {
  const before = parse(event.before_json ?? event.before);
  const after = parse(event.after_json ?? event.after);
  const id = event.target_id || (after && after.id) || (before && before.id);
  const state = await readState(env, user, { linkIds: [id] });
  const cur = state.links.find(l => l.id === id);
  if (!cur) return { conflict: true, reason: 'That link is no longer there.' };
  if (after && EDITABLE.some(k => k in after && (after[k] ?? null) !== (cur[k] ?? null))) {
    return { conflict: true, reason: 'That was changed again since; undo the later change first.' };
  }
  const now = ctx.now || Date.now();
  const hl = ctx.hl || await halfLife();
  const sup = new Map((state.support.get(id) || []).map(s => [s.obs_key, s]));
  const prevSupport = new Map(((before && before.support) || []).map(s => [s.obs_key, s]));
  const rows = [];
  for (const s of (after && after.support) || []) {
    const row = sup.get(s.obs_key);
    if (!row) continue;
    const to = prevSupport.get(s.obs_key) || { w: 0, cw: 0 };
    if (row.w !== to.w || row.cw !== to.cw) {
      rows.push({ table: 'link_support', op: 'update', key: { user_id: user, link_id: id, obs_key: row.obs_key }, before: row, after: { w: to.w, cw: to.cw } });
      sup.set(row.obs_key, { ...row, w: to.w, cw: to.cw });
    }
  }
  const next = { ...cur };
  if (before) for (const k of EDITABLE) { if (k in before) next[k] = before[k] ?? null; }
  else Object.assign(next, { status: 'removed', removed_by: 'undo', removed_at: now, removed_reason: null });
  if (before && next.status !== 'removed') Object.assign(next, { removed_at: null, removed_by: null, removed_reason: null });
  if (before && before.status === 'removed') Object.assign(next, { removed_by: before.removed_by ?? 'undo', removed_reason: before.removed_reason ?? null, removed_at: cur.removed_at || now });
  Object.assign(next, aggregate([...sup.values()], now, hl, cur.type), { updated_at: now });
  const diff = {};
  for (const k of Object.keys(next)) if (k !== 'id' && k !== 'user_id' && (cur[k] ?? null) !== (next[k] ?? null)) diff[k] = next[k];
  rows.unshift({ table: 'links', op: 'update', key: { user_id: user, id }, before: cur, after: diff });
  return { rows };
}



// Columns link changes write beyond guard.js WRITABLE: the code-computed counts, and enriching a support row.
export const LINK_WRITES = {
  links: { actions: 'iu', cols: [...CODE_COLS] },
  link_support: { actions: 'iu', cols: ['w', 'cw', 'role', 'truth_id'] },
};
const PICTURE = /^[a-z0-9_]{3,60}$/;
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const whoRemoved = l => `${l.removed_by === 'mo' ? 'Mo' : l.removed_by === 'claude' ? 'Claude' : 'The hub'} removed this link${l.removed_at ? ` on ${new Date(l.removed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' })}` : ''}`;
const tombstone = l => l && l.status === 'removed' && l.removed_by !== 'undo';

function unknownKeys(args, allowed) {
  const bad = Object.keys(args || {}).filter(k => !allowed.includes(k));
  return bad.length ? `Unknown argument ${bad[0]}.` : null;
}

/** A topic named by id or by name: {id, name} at confidence >= 0.9, or {error} with up to 3 candidates. */
export async function resolveEndpoint(env, user, text, field) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 120) return { error: `${field} is a topic name or id (at most 120 characters).` };
  let row = await env.DB.prepare('SELECT id, name, status, merged_into FROM topics WHERE user_id = ? AND id = ?').bind(user, s).first();
  if (row && row.status === 'merged' && row.merged_into) {
    row = await env.DB.prepare('SELECT id, name, status, merged_into FROM topics WHERE user_id = ? AND id = ?').bind(user, row.merged_into).first();
  }
  if (row) return row.status === 'retired' ? { error: `${row.name} is retired, so nothing links to it.` } : { id: row.id, name: row.name };
  const r = await deps.resolveTopic(env, user, { texts: [s], source: 'link', source_ref: field });
  if (r && r.topic_id && (r.confidence ?? 0) >= 0.9) {
    const t = await env.DB.prepare('SELECT id, name, status FROM topics WHERE user_id = ? AND id = ?').bind(user, r.topic_id).first();
    if (t && t.status !== 'retired' && t.status !== 'merged') return { id: t.id, name: t.name };
  }
  const c = ((r && r.candidates) || []).slice(0, 3).map(x => `${x.name || x.topic_id} (${x.topic_id || x.id})`);
  return { error: `I can't place "${s.slice(0, 60)}" on the map${c.length ? `. Did you mean ${c.join(', ')}?` : '. Add it with map_add_topic first.'}`, candidates: c };
}

async function leakCheck(env, user, topicIds, texts) {
  const live = texts.filter(([, t]) => t);
  if (!live.length) return null;
  const index = await leakIndexFor(env, user, { topicIds });
  for (const [field, t] of live) { const run = index.size && leaks(index, t); if (run) return { refuse: `${field} copies the question ("${run}"). Use your own words.`, field }; }
  return null;
}

const linkReply = (topics, link) => ({ type: link.type, a: (topics.get(link.from_id) || {}).name || link.from_id, b: (topics.get(link.to_id) || {}).name || link.to_id,
  fact: link.a_vs_b || link.b_vs_a || link.note || null, strength: link.strength, confusion: Math.round((link.confusion || 0) * 100) / 100, status: link.status });

export async function planAdd(env, user, args, ctx = {}) {
  const bad = unknownKeys(args, ['type', 'from', 'to', 'how', 'fact', 'evidence', 'picture', 'restore', 'run_id']);
  if (bad) return { refuse: bad };
  if (!LINK_TYPES[args.type]) return { refuse: `type is one of ${Object.keys(LINK_TYPES).join(', ')}.`, field: 'type' };
  if (args.evidence != null && (typeof args.evidence !== 'string' || args.evidence.length > CAPS.evidence)) return { refuse: `evidence is at most ${CAPS.evidence} characters.`, field: 'evidence' };
  if (args.picture != null && !PICTURE.test(String(args.picture))) return { refuse: 'picture is a media id such as anking_hy_021.', field: 'picture' };
  if (args.restore != null && typeof args.restore !== 'boolean') return { refuse: 'restore is true or false.', field: 'restore' };
  const how = checkHow(args.type, args.how);
  if (how && how.error) return { refuse: how.error, field: 'how' };
  const a = await resolveEndpoint(env, user, args.from, 'from');
  if (a.error) return { refuse: a.error, field: 'from' };
  const b = await resolveEndpoint(env, user, args.to, 'to');
  if (b.error) return { refuse: b.error, field: 'to' };
  if (a.id === b.id) return { refuse: 'A topic cannot be linked to itself.' };

  let fact = null, note = null;
  if (args.fact != null && args.fact !== '') {
    if (typeof args.fact !== 'string' || args.fact.length > CAPS.fact) return { refuse: `fact is at most ${CAPS.fact} characters.`, field: 'fact' };
    if (args.type === 'versus') {
      const v = versusLine(b.name, args.fact);
      if (v.error) return { refuse: v.error, field: 'fact' };
      fact = v.line;
    } else {
      if (args.fact.length > CAPS.note) return { refuse: `For a ${args.type} link the fact is a note of at most ${CAPS.note} characters.`, field: 'fact' };
      note = args.fact.trim();
    }
  }
  const leak = await leakCheck(env, user, [a.id, b.id], [['fact', fact || note], ['evidence', args.evidence]]);
  if (leak) return leak;

  const state = await readState(env, user, { topicIds: [a.id, b.id] });
  const kinds = { [a.id]: (state.topics.get(a.id) || {}).kind, [b.id]: (state.topics.get(b.id) || {}).kind };
  const norm = normaliseLink({ type: args.type, from: a.id, to: b.id, kinds });
  if (norm.error) return { refuse: norm.error };
  const existing = state.links.find(l => l.type === norm.type && l.from_id === norm.from_id && l.to_id === norm.to_id);
  if (tombstone(existing) && !args.restore) return { refuse: `${whoRemoved(existing)}; ask him first, then add it again with restore: true.` };

  const src = ctx.actor === 'mo' ? 'mo' : 'claude';
  const now = ctx.now || Date.now();
  const r = await planLinks(env, user, [{
    type: args.type, from: a.id, to: b.id, how: how || null, a_vs_b: fact, note, picture: args.picture || null,
    restore: !!existing && existing.status === 'removed', by: src, source: src, label: src === 'mo' ? 'Mo' : 'Claude',
    support: { obs_key: `${src}:${ctx.request_id || rand()}`, src, role: 'added', w: W[src], cw: 0, text: args.evidence ? args.evidence.trim() : null, at: now },
  }], { now, state, undoable: true });
  if (r.problems.length) return { refuse: r.problems[0].why };
  const l = r.links[0];
  if (!r.rows.length) return { noop: true, summary: 'That link is already there.' };
  return { rows: r.rows, events: r.events, summary: r.events[0] ? r.events[0].summary : `${pairName(state.topics, l.link)}: supported`,
    reply: { link_id: l.link_id, op: l.op, link: linkReply(state.topics, l.link) } };
}

/**
 * link.update (map_update_link {link_id, set: {fact?, fact_for?, how?, note?, picture?, status?: active|removed},
 * reason?}). Changing the type is refused (remove it and add the new one, so where it came from stays clear);
 * status 'removed' is link.remove; status 'active' restores a removed link.
 */
export async function planUpdate(env, user, args, ctx = {}) {
  const bad = unknownKeys(args, ['link_id', 'set', 'reason', 'run_id']);
  if (bad) return { refuse: bad };
  const set = args.set;
  if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length) return { refuse: 'set says what to change: fact, fact_for, how, note, picture or status.', field: 'set' };
  if ('type' in set) return { refuse: 'A link keeps its type: remove it and add the new one.', field: 'set.type' };
  const badSet = unknownKeys(set, ['fact', 'fact_for', 'how', 'note', 'picture', 'status']);
  if (badSet) return { refuse: badSet.replace('argument', 'field in set'), field: 'set' };
  if (args.reason != null && (typeof args.reason !== 'string' || args.reason.length > CAPS.reason)) return { refuse: `reason is at most ${CAPS.reason} characters.`, field: 'reason' };
  if (set.status === 'removed') {
    const others = Object.keys(set).filter(k => k !== 'status');
    if (others.length) return { refuse: 'Removing a link changes nothing else: send status alone.', field: 'set' };
    return planRemove(env, user, { link_id: args.link_id, reason: args.reason }, ctx);
  }
  if (set.status != null && set.status !== 'active') return { refuse: 'status is active or removed.', field: 'set.status' };
  if (typeof args.link_id !== 'string') return { refuse: 'link_id is the id map_neighbours gave.', field: 'link_id' };
  const state = await readState(env, user, { linkIds: [args.link_id] });
  const link = state.links.find(l => l.id === args.link_id);
  if (!link || link.status === 'held') return { refuse: 'No link has that id.', field: 'link_id' };
  const next = { ...link };
  if (set.status === 'active' && link.status === 'removed') Object.assign(next, { status: 'active', removed_at: null, removed_by: null, removed_reason: null });
  if (set.how !== undefined) {
    const how = checkHow(link.type, set.how);
    if (how && how.error) return { refuse: how.error, field: 'set.how' };
    next.how = how;
  }
  if (set.note !== undefined) {
    if (set.note != null && (typeof set.note !== 'string' || set.note.length > CAPS.note)) return { refuse: `note is at most ${CAPS.note} characters.`, field: 'set.note' };
    next.note = set.note ? set.note.trim() : null;
  }
  if (set.picture !== undefined) {
    if (set.picture != null && !PICTURE.test(String(set.picture))) return { refuse: 'picture is a media id such as anking_hy_021.', field: 'set.picture' };
    next.picture = set.picture || null;
  }
  if (set.fact !== undefined) {
    if (link.type !== 'versus') {
      if (set.fact != null && (typeof set.fact !== 'string' || set.fact.length > CAPS.note)) return { refuse: `For a ${link.type} link the fact is a note of at most ${CAPS.note} characters.`, field: 'set.fact' };
      next.note = set.fact ? set.fact.trim() : null;
    } else {
      let side = 'a';
      if (set.fact_for != null) {
        const f = await resolveEndpoint(env, user, set.fact_for, 'fact_for');
        if (f.error) return { refuse: f.error, field: 'set.fact_for' };
        if (f.id !== link.from_id && f.id !== link.to_id) return { refuse: 'fact_for is one of the two topics of this link.', field: 'set.fact_for' };
        side = f.id === link.from_id ? 'a' : 'b';
      }
      if (set.fact == null || set.fact === '') next[side === 'a' ? 'a_vs_b' : 'b_vs_a'] = null;
      else {
        if (typeof set.fact !== 'string' || set.fact.length > CAPS.fact) return { refuse: `fact is at most ${CAPS.fact} characters.`, field: 'set.fact' };
        const other = (state.topics.get(side === 'a' ? link.to_id : link.from_id) || {}).name || (side === 'a' ? link.to_id : link.from_id);
        const v = versusLine(other, set.fact);
        if (v.error) return { refuse: v.error, field: 'set.fact' };
        next[side === 'a' ? 'a_vs_b' : 'b_vs_a'] = v.line;
      }
    }
  }
  const leak = await leakCheck(env, user, [link.from_id, link.to_id], [['fact', next.a_vs_b !== link.a_vs_b ? next.a_vs_b : null], ['fact', next.b_vs_a !== link.b_vs_a ? next.b_vs_a : null], ['note', next.note !== link.note ? next.note : null]]);
  if (leak) return leak;
  const after = {};
  for (const k of [...EDITABLE, 'removed_at', 'removed_by', 'removed_reason']) if ((link[k] ?? null) !== (next[k] ?? null)) after[k] = next[k];
  if (!Object.keys(after).length) return { noop: true, summary: 'Nothing to change.' };
  const now = ctx.now || Date.now();
  after.updated_at = now;
  const restored = link.status === 'removed' && next.status === 'active';
  const summary = `${pairName(state.topics, link)}: ${restored ? 'link restored' : 'link updated'}`.slice(0, 160);
  return {
    rows: [{ table: 'links', op: 'update', key: { user_id: user, id: link.id }, before: link, after }],
    events: [{ kind: 'link.updated', target_type: 'link', target_id: link.id, topic_id: link.from_id, summary, before: snapshot(link), after: snapshot({ ...link, ...after }) }],
    summary, reply: { link_id: link.id, op: restored ? 'restored' : 'updated', link: linkReply(state.topics, { ...link, ...after }) },
  };
}

export async function planRemove(env, user, args, ctx = {}) {
  const bad = unknownKeys(args, ['link_id', 'link_ids', 'reason', 'run_id']);
  if (bad) return { refuse: bad };
  const list = args.link_ids != null ? args.link_ids : args.link_id != null ? [args.link_id] : [];
  if (!Array.isArray(list) || !list.length || list.length > 25 || !list.every(x => typeof x === 'string')) return { refuse: 'Say which links: link_id, or link_ids (1 to 25).', field: 'link_ids' };
  if (args.reason != null && (typeof args.reason !== 'string' || args.reason.length > CAPS.reason)) return { refuse: `reason is at most ${CAPS.reason} characters.`, field: 'reason' };
  const state = await readState(env, user, { linkIds: list });
  const found = state.links.filter(l => list.includes(l.id) && l.status !== 'held');
  if (!found.length) return { refuse: list.length === 1 ? 'No link has that id.' : 'None of those links is on the map.', field: 'link_ids' };
  const live = found.filter(l => l.status !== 'removed');
  if (!live.length) return { noop: true, summary: 'Already removed.' };
  const now = ctx.now || Date.now();
  const by = ctx.actor === 'mo' ? 'mo' : ctx.actor === 'claude' ? 'claude' : 'code';
  const rows = [], events = [];
  for (const l of live) {
    const after = { status: 'removed', removed_at: now, removed_by: by, removed_reason: args.reason ? args.reason.trim() : null, updated_at: now };
    rows.push({ table: 'links', op: 'update', key: { user_id: user, id: l.id }, before: l, after });
    events.push({ kind: 'link.removed', target_type: 'link', target_id: l.id, topic_id: l.from_id,
      summary: `${pairName(state.topics, l)}: link removed`.slice(0, 160), before: snapshot(l), after: snapshot({ ...l, ...after }) });
  }
  return { rows, events, count: live.length, summary: live.length === 1 ? events[0].summary : `Removed ${live.length} links`,
    reply: { removed: live.map(l => l.id), already: found.length - live.length } };
}
export const removeTier = (args, plan) => (plan && plan.count > 5 ? 'confirm' : 'free');
