import { json, readJson, HttpError, londonDay } from '../util.js';
import { noteJob } from '../job-log.js';
import { sameQuestion, rawKey, fnv1a, isBoilerplate, saidInWindow, windowText, uworldResultOf, blockComplete, MISS_CAUSE_COLS } from './ingest/map-fields.js';
import { FORMS_SQL, fakeQuotes } from './forms-check.js';

export const PARTS = ['misses', 'misconceptions', 'retests', 'said', 'gaps', 'blocks', 'forms'];
export const HYGIENE = { per_batch: 20, examples: 12, blocks: 10 };
export const RETEST_DAYS = 2, GAP_TWIN_MS = 5_000, SAID_REPEAT_MIN = 25;
export const KIND = 'data.cleaned', TARGET = 'hygiene';
// The tables a clean-up touches and the columns that find one row.
export const TABLE_KEYS = {
  misses: ['user_id', 'id'], gaps: ['user_id', 'id'], misconceptions: ['user_id', 'id'], retests: ['user_id', 'id'], anki_cards: ['session_id', 'n'],
  // patterns.js recountHabits: a look-alike swap taken off an item that was no real confusion, undone the same way.
  pattern_items: ['user_id', 'item_kind', 'item_id'],
};

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const words = s => new Set(String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
export function jaccard(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const keyOf = (table, row) => Object.fromEntries(TABLE_KEYS[table].map(c => [c, row[c]]));
const hasWords = m => !!((m.my_reasoning && String(m.my_reasoning).trim()) || (m.cause_quote && String(m.cause_quote).trim()));

// ---------------------------------------------------------------- pure plans

export function missGroups(rows) {
  const byQid = new Map();
  for (const r of rows || []) {
    if (!r || r.deleted_at != null || Number(r.held) === 1 || !r.uw_qid) continue;
    const k = String(r.uw_qid);
    if (!byQid.has(k)) byQid.set(k, []);
    byQid.get(k).push(r);
  }
  const out = [];
  for (const list of byQid.values()) {
    list.sort((a, b) => Number(a.at) - Number(b.at));
    const groups = [];
    for (const r of list) {
      const g = groups.find(g => sameQuestion(g[0], r) && g.every(x => !(x.uworld_block_id && r.uworld_block_id && x.uworld_block_id !== r.uworld_block_id)));
      if (g) g.push(r); else groups.push([r]);
    }
    for (const g of groups) {
      if (g.length < 2) continue;
      const score = m => (m.anki_mistake_id != null ? 4 : 0) + (hasWords(m) ? 2 : 0) + (m.uworld_block_id ? 1 : 0);
      const survivor = [...g].sort((a, b) => score(b) - score(a) || Number(a.at) - Number(b.at))[0];
      out.push({ survivor, dups: g.filter(x => x !== survivor) });
    }
  }
  return out;
}

// What a survivor takes from its duplicates when it has none of its own.
const FILL = ['my_reasoning', 'reasoning_source', 'rule', 'look_alikes', 'learning_point', 'error_type', 'time_s', 'others_pct', 'time_source',
  'condition_raw', 'topic_raw', 'system_raw', 'step', 'outcome', 'flaw_kind'];
const empty = v => v == null || v === '' || v === '[]';

/** The merge of one group (pure): {survivor: set, dups: [{id, set}]}. now: the clean-up's time. */
export function mergePlan({ survivor, dups }, now) {
  const set = {};
  const cur = k => (k in set ? set[k] : survivor[k]);
  let ankiMoved = false;
  const dupSets = [];
  for (const d of dups) {
    for (const k of FILL) if (empty(cur(k)) && !empty(d[k])) set[k] = d[k];
    if (empty(cur('confidence')) && !empty(d.confidence)) { set.confidence = d.confidence; set.confidence_source = d.confidence_source ?? null; }
    if (empty(cur('look_alike_names_json')) && !empty(d.look_alike_names_json)) set.look_alike_names_json = d.look_alike_names_json;
    if (cur('cause') == null && d.cause != null) for (const k of MISS_CAUSE_COLS) set[k] = d[k] ?? null;
    if (!cur('uworld_block_id') && d.uworld_block_id) Object.assign(set, { uworld_block_id: d.uworld_block_id, uworld_q: d.uworld_q ?? null, at: d.at, day: d.day });
    const dset = { deleted_at: now, merged_into: survivor.id, updated_at: now };
    // The Anki-log record follows the survivor, so the next pass of the log updates it instead of the deleted row.
    if (!ankiMoved && survivor.anki_mistake_id == null && d.anki_mistake_id != null) { set.anki_mistake_id = d.anki_mistake_id; dset.anki_mistake_id = null; ankiMoved = true; }
    dupSets.push({ id: d.id, set: dset });
  }
  if (Object.keys(set).length) set.updated_at = now;
  return { survivor: set, dups: dupSets };
}

/**
 * The re-tests of one merged group (pure): a duplicate's open re-test whose card is not made goes when the survivor has
 * re-tests of its own; every other re-test of a duplicate joins the survivor. Returns {remove, move, next_day}.
 */
export function retestPlan(survivorId, dupIds, rows) {
  const own = rows.filter(r => r.miss_id === survivorId), theirs = rows.filter(r => dupIds.includes(r.miss_id));
  const remove = [], move = [];
  for (const r of theirs) {
    if (own.length && r.result == null && ['pending', 'failed'].includes(r.card_state)) remove.push(r); else move.push(r);
  }
  const open = [...own, ...move].filter(r => r.result == null).map(r => r.due).sort();
  return { remove, move, next_day: open[0] || null };
}

/** Near-identical open beliefs on one topic (pure): [{survivor, dups}]. */
export function miscGroups(rows) {
  const live = (rows || []).filter(r => r && r.status !== 'closed' && (r.topic_id || r.ref)).sort((a, b) => Number(a.first_seen) - Number(b.first_seen));
  const groups = [];
  for (const r of live) {
    const g = groups.find(g => (g[0].topic_id ? g[0].topic_id === r.topic_id : g[0].ref === r.ref)
      && g.some(x => jaccard(x.belief, r.belief) >= 0.6 || (x.ref && x.ref === r.ref && jaccard(x.belief, r.belief) >= 0.4)));
    if (g) g.push(r); else groups.push([r]);
  }
  return groups.filter(g => g.length > 1).map(g => {
    const survivor = g.find(x => x.words === 'mo') || g[0];
    return { survivor, dups: g.filter(x => x !== survivor) };
  });
}

/** The survivor's merged counts (pure). */
export function miscMerge(survivor, dups, now) {
  const all = [survivor, ...dups];
  const lessons = [...new Set(all.flatMap(x => parse(x.lesson_ids_json, [])))];
  const set = { seen_n: all.reduce((a, x) => a + (Number(x.seen_n) || 1), 0), first_seen: Math.min(...all.map(x => Number(x.first_seen))),
    last_seen: Math.max(...all.map(x => Number(x.last_seen))), lesson_ids_json: JSON.stringify(lessons), updated_at: now };
  const targeted = all.find(x => x.status === 'targeted');
  if (survivor.status === 'open' && targeted) Object.assign(set, { status: 'targeted', targeted_at: targeted.targeted_at ?? now });
  return set;
}

/** Two open re-tests of one miss due within RETEST_DAYS (pure): [{keep, remove}] (a made card is never removed). */
export function retestDupes(rows) {
  const byMiss = new Map();
  for (const r of rows || []) {
    if (!r || r.result != null || !r.miss_id) continue;
    if (!byMiss.has(r.miss_id)) byMiss.set(r.miss_id, []);
    byMiss.get(r.miss_id).push(r);
  }
  const out = [];
  const days = (a, b) => Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000;
  for (const list of byMiss.values()) {
    const made = r => ['made', 'written', 'done'].includes(r.card_state);
    list.sort((a, b) => (made(b) ? 1 : 0) - (made(a) ? 1 : 0) || String(a.due).localeCompare(String(b.due)));
    const kept = [];
    for (const r of list) {
      const near = kept.find(k => days(k.due, r.due) <= RETEST_DAYS);
      if (near && !made(r)) out.push({ keep: near, remove: r }); else kept.push(r);
    }
  }
  return out;
}

export function junkSaid(rows) {
  const out = new Map();
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const cards = new Map();
  for (const r of rows || []) {
    if (!r || !r.said) continue;
    if (isBoilerplate(r.said)) { out.set(r.id, { id: r.id, why: 'stock' }); continue; }
    if (r.card && r.started_at != null && r.card.shown_at != null) {
      const parts = [...parse(r.card.before_json, []), ...parse(r.card.after_json, [])];
      if (!saidInWindow(r.said, windowText(parts, r.card, r.started_at))) { out.set(r.id, { id: r.id, why: 'window', session_id: r.card.session_id, n: r.card.n }); continue; }
    }
    if (r.card_id != null && norm(r.said).length >= SAID_REPEAT_MIN) {
      const k = norm(r.said);
      if (!cards.has(k)) cards.set(k, []);
      cards.get(k).push(r);
    }
  }
  for (const list of cards.values()) {
    if (new Set(list.map(r => r.card_id)).size < 2) continue;
    for (const r of list) if (!out.has(r.id)) out.set(r.id, { id: r.id, why: 'repeated', ...(r.card ? { session_id: r.card.session_id, n: r.card.n } : {}) });
  }
  return [...out.values()];
}

const gapScore = g => (g.said ? 4 : 0) + (g.gap && !isBoilerplate(g.gap) ? 2 : 0) + (g.source !== 'anki_voice' ? 1 : 0);
/**
 * Duplicate gaps (pure): one card's rows within GAP_TWIN_MS of each other or with one review id, and chat gaps of one
 * day saying the same thing (same topic, words alike). Returns [{survivor, dups}].
 */
export function gapGroups(rows) {
  const live = (rows || []).filter(g => g && Number(g.held) !== 1).sort((a, b) => Number(a.at) - Number(b.at));
  const groups = [];
  for (const g of live) {
    const hit = groups.find(G => G.some(x => {
      if (g.card_id != null && x.card_id != null) {
        return Number(g.card_id) === Number(x.card_id) && ((g.review_id != null && g.review_id === x.review_id) || Math.abs(Number(g.at) - Number(x.at)) <= GAP_TWIN_MS);
      }
      return g.card_id == null && x.card_id == null && g.source === 'chat' && x.source === 'chat' && g.day === x.day
        && String(g.topic || '').toLowerCase() === String(x.topic || '').toLowerCase() && jaccard(g.gap, x.gap) >= 0.8;
    }));
    if (hit) hit.push(g); else groups.push([g]);
  }
  return groups.filter(G => G.length > 1).map(G => {
    const survivor = [...G].sort((a, b) => gapScore(b) - gapScore(a) || Number(a.at) - Number(b.at))[0];
    return { survivor, dups: G.filter(x => x !== survivor) };
  });
}

/** Saved block questions with a result that the map has no answer for (pure): Map(blockId -> [q]). */
export function missingAnswers(blocks, onMap) {
  const out = new Map();
  for (const b of blocks || []) {
    const qs = parse(b.questions_json, []).filter(q => q && Number.isInteger(q.q) && uworldResultOf(q));
    const missing = qs.filter(q => !onMap.has(`${b.id}:${q.q}`)).map(q => q.q);
    if (missing.length) out.set(String(b.id), missing);
  }
  return out;
}

// ---------------------------------------------------------------- row changes and their undo

// One row change as a statement: delete (after null), insert (before null) or update (after: the columns set).
export function changeStatement(DB, c) {
  const k = TABLE_KEYS[c.table];
  if (!k) throw new Error(`hygiene: no key for ${c.table}`);
  const where = k.map(col => `${col} = ?`).join(' AND '), keyVals = k.map(col => c.key[col]);
  if (c.after == null) return DB.prepare(`DELETE FROM ${c.table} WHERE ${where}`).bind(...keyVals);
  if (c.before == null) {
    const row = { ...c.after, ...c.key }, cols = Object.keys(row);
    return DB.prepare(`INSERT INTO ${c.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map(x => row[x] ?? null));
  }
  const cols = Object.keys(c.after).filter(x => !k.includes(x));
  return DB.prepare(`UPDATE ${c.table} SET ${cols.map(x => `${x} = ?`).join(', ')} WHERE ${where}`).bind(...cols.map(x => c.after[x] ?? null), ...keyVals);
}

// The event that records one change, so undo can put it back: before {t, k, row: what was there}, after {t, k, row}.
export function changeEvent(c, summary, topicId = null) {
  const id = `${c.table}:${TABLE_KEYS[c.table].filter(x => x !== 'user_id').map(x => c.key[x]).join(':')}`;
  const before = c.before == null ? null : c.after == null ? c.before : Object.fromEntries(Object.keys(c.after).map(x => [x, c.before[x] ?? null]));
  return { kind: KIND, target_type: TARGET, target_id: id.slice(0, 200), topic_id: topicId, summary: cut(summary, 160), undoable: true,
    before: { t: c.table, k: c.key, row: before }, after: { t: c.table, k: c.key, row: c.after } };
}

const same = (a, b) => (a == null && b == null) || String(a ?? '') === String(b ?? '');
/**
 * undo.js handler for 'target:hygiene': the row back as it was, when it is still as the clean-up left it (else the
 * usual "changed again since"). Returns {statements} or {conflict}.
 */
export async function undoHygiene(env, user, event) {
  const b = parse(event.before_json, null), a = parse(event.after_json, null);
  const t = (a && a.t) || (b && b.t), k = (a && a.k) || (b && b.k);
  const keys = TABLE_KEYS[t];
  if (!keys || !k) return { conflict: "That change can't be undone automatically." };
  const cur = await env.DB.prepare(`SELECT * FROM ${t} WHERE ${keys.map(c => `${c} = ?`).join(' AND ')}`).bind(...keys.map(c => k[c])).first();
  const left = a && a.row, was = b && b.row;
  const changed = 'That was changed again since; undo the later change first.';
  if (left == null) {   // deleted: it comes back
    if (cur) return { conflict: changed };
    return { statements: [changeStatement(env.DB, { table: t, key: k, before: null, after: Object.fromEntries(Object.entries(was || {}).filter(([c]) => !keys.includes(c))) })] };
  }
  if (!cur || Object.entries(left).some(([c, v]) => c !== 'updated_at' && !same(cur[c], v))) return { conflict: changed };
  if (was == null) return { statements: [changeStatement(env.DB, { table: t, key: k, before: cur, after: null })] };
  return { statements: [changeStatement(env.DB, { table: t, key: k, before: cur, after: was })] };
}

// ---------------------------------------------------------------- reads

const MISS_DUPES_SQL = `SELECT * FROM misses WHERE user_id = ?1 AND deleted_at IS NULL AND held = 0 AND uw_qid IN (SELECT uw_qid FROM misses
  WHERE user_id = ?1 AND deleted_at IS NULL AND held = 0 AND uw_qid IS NOT NULL GROUP BY uw_qid HAVING count(*) > 1) ORDER BY uw_qid, at`;
const SAID_SQL = `SELECT g.id, g.said, g.card_id, g.source, c.session_id, c.n, c.shown_at, c.revealed_at, c.answered_at, c.before_json, c.after_json, s.started_at
  FROM gaps g LEFT JOIN anki_cards c ON g.id = 'anki:' || c.session_id || ':' || c.n LEFT JOIN anki_sessions s ON s.id = c.session_id
  WHERE g.user_id = ?1 AND g.said IS NOT NULL AND g.said <> ''`;
const GAPS_SQL = `SELECT id, at, day, source, card_id, review_id, topic, gap, said, mixed_with, step, confidence, held, topic_id FROM gaps
  WHERE user_id = ?1 AND (card_id IN (SELECT card_id FROM gaps WHERE user_id = ?1 AND card_id IS NOT NULL GROUP BY card_id HAVING count(*) > 1)
    OR (card_id IS NULL AND source = 'chat' AND day IN (SELECT day FROM gaps WHERE user_id = ?1 AND card_id IS NULL AND source = 'chat' GROUP BY day HAVING count(*) > 1)))`;

async function readAll(env, user) {
  const DB = env.DB;
  const [m, mc, rt, sd, gp, bl, onMap, stock] = await DB.batch([
    DB.prepare(MISS_DUPES_SQL).bind(user),
    DB.prepare("SELECT * FROM misconceptions WHERE user_id = ?1 AND status <> 'closed'").bind(user),
    DB.prepare('SELECT * FROM retests WHERE user_id = ?1 AND kind = \'miss\'').bind(user),
    DB.prepare(SAID_SQL).bind(user),
    DB.prepare(GAPS_SQL).bind(user),
    DB.prepare('SELECT id, day, count, questions_json, complete FROM uworld_blocks').bind(),
    DB.prepare(`SELECT DISTINCT substr(source_ref, 8) AS k FROM evidence WHERE user_id = ?1 AND slot = 0 AND source_ref LIKE 'uworld:%:q%'
      UNION SELECT m.uworld_block_id || ':q' || m.uworld_q FROM misses m WHERE m.user_id = ?1 AND m.uworld_block_id IS NOT NULL AND m.deleted_at IS NULL`).bind(user),
    DB.prepare("SELECT id, card_id, gap FROM gaps WHERE user_id = ?1 AND source = 'anki_voice' AND card_id IS NOT NULL AND coalesce(gap, '') <> ''").bind(user),
  ]);
  return { misses: m.results || [], miscs: mc.results || [], retests: rt.results || [], said: sd.results || [], gaps: gp.results || [], blocks: bl.results || [],
    stock: (stock.results || []).filter(g => isBoilerplate(g.gap)),
    onMap: new Set((onMap.results || []).map(r => String(r.k).replace(/:q(\d+)$/, ':$1'))) };
}

// ---------------------------------------------------------------- the plan

/** Every part's changes (one read batch), as {parts: {name: {groups, changes, evidence, items, counts}}, confirm}. */
export async function planHygiene(env, user, { parts = PARTS, now = Date.now() } = {}) {
  const d = await readAll(env, user);
  const out = {};
  const want = new Set(parts);
  // misses (and the misconceptions and re-tests their merge leaves behind)
  if (want.has('misses')) {
    const groups = missGroups(d.misses).map(g => {
      const plan = mergePlan(g, now);
      const rt = retestPlan(g.survivor.id, g.dups.map(x => x.id), d.retests);
      const changes = [];
      // The duplicates first (their Anki record moves), then the survivor (it takes it): the unique index holds throughout.
      for (const x of plan.dups) {
        const row = g.dups.find(r => r.id === x.id);
        changes.push({ table: 'misses', key: keyOf('misses', row), before: row, after: x.set });
      }
      const sset = { ...plan.survivor };
      if (rt.remove.length || rt.move.length) { sset.next_retest_day = rt.next_day; sset.updated_at = now; }
      if (Object.keys(sset).length) changes.push({ table: 'misses', key: keyOf('misses', g.survivor), before: g.survivor, after: sset });
      for (const r of rt.remove) changes.push({ table: 'retests', key: keyOf('retests', r), before: r, after: null });
      for (const r of rt.move) changes.push({ table: 'retests', key: keyOf('retests', r), before: r, after: { miss_id: g.survivor.id, updated_at: now } });
      const label = g.survivor.label || `UW ${g.survivor.uw_qid}`;
      return { label, topic_id: g.survivor.topic_id || null, survivor: g.survivor, dups: g.dups, sset, changes,
        item: { label, keep: { id: g.survivor.id, day: g.survivor.day }, merge: g.dups.map(x => ({ id: x.id, day: x.day })), retests_removed: rt.remove.length, retests_moved: rt.move.length,
          filled: Object.keys(plan.survivor).filter(k => k !== 'updated_at') } };
    });
    out.misses = { groups, counts: { groups: groups.length, merged: groups.reduce((a, g) => a + g.dups.length, 0),
      retests_removed: groups.reduce((a, g) => a + g.item.retests_removed, 0) } };
  }
  if (want.has('misconceptions')) {
    const groups = miscGroups(d.miscs).map(g => ({ label: `Misconception on ${g.survivor.topic_name || g.survivor.ref || 'a topic'}`, topic_id: g.survivor.topic_id || null,
      changes: [{ table: 'misconceptions', key: keyOf('misconceptions', g.survivor), before: g.survivor, after: miscMerge(g.survivor, g.dups, now) },
        ...g.dups.map(x => ({ table: 'misconceptions', key: keyOf('misconceptions', x), before: x, after: null }))],
      item: { topic: g.survivor.topic_name || null, keep: g.survivor.id, belief: cut(g.survivor.belief, 120), merge: g.dups.map(x => x.id) } }));
    out.misconceptions = { groups, counts: { groups: groups.length, merged: groups.reduce((a, g) => a + g.item.merge.length, 0) } };
  }
  if (want.has('retests')) {
    // Re-tests of misses the misses part merges are handled there.
    const merging = new Set((out.misses ? out.misses.groups : []).flatMap(g => g.dups.map(x => x.id)));
    const groups = retestDupes(d.retests.filter(r => !merging.has(r.miss_id))).map(p => ({ label: `Card booking ${p.remove.id}`, topic_id: p.remove.topic_id || null,
      changes: [{ table: 'retests', key: keyOf('retests', p.remove), before: p.remove, after: null }], item: { keep: p.keep.id, remove: p.remove.id } }));
    out.retests = { groups, counts: { removed: groups.length } };
  }
  if (want.has('said')) {
    const rows = d.said.map(r => ({ id: r.id, said: r.said, card_id: r.card_id, started_at: r.started_at,
      card: r.session_id != null ? { session_id: r.session_id, n: r.n, shown_at: r.shown_at, revealed_at: r.revealed_at, answered_at: r.answered_at, before_json: r.before_json, after_json: r.after_json } : null }));
    const groups = junkSaid(rows).map(j => {
      const g = d.said.find(r => r.id === j.id);
      const changes = [{ table: 'gaps', key: { user_id: user, id: j.id }, before: { said: g.said }, after: { said: null } }];
      if (j.session_id != null) changes.push({ table: 'anki_cards', key: { session_id: j.session_id, n: j.n }, before: { said: g.said }, after: { said: null } });
      return { label: `Gap ${j.id}`, topic_id: null, changes, item: { id: j.id, why: j.why, card_id: g.card_id ?? null } };
    });
    // A card note's stock gap line ("Missed this card in a voice review.") is no words at all.
    for (const g of d.stock) {
      groups.push({ label: `Gap ${g.id}`, topic_id: null, changes: [{ table: 'gaps', key: { user_id: user, id: g.id }, before: { gap: g.gap }, after: { gap: '' } }],
        item: { id: g.id, why: 'stock gap line', card_id: g.card_id } });
    }
    out.said = { groups, counts: { cleared: groups.length, stock: groups.filter(g => /stock/.test(g.item.why)).length, window: groups.filter(g => g.item.why === 'window').length,
      repeated: groups.filter(g => g.item.why === 'repeated').length } };
  }
  if (want.has('gaps')) {
    const groups = gapGroups(d.gaps).map(G => {
      const set = {};
      for (const x of G.dups) for (const k of ['said', 'topic', 'mixed_with', 'step', 'confidence', 'review_id']) if (empty(G.survivor[k]) && empty(set[k]) && !empty(x[k])) set[k] = x[k];
      if ((!G.survivor.gap || isBoilerplate(G.survivor.gap))) { const w = G.dups.find(x => x.gap && !isBoilerplate(x.gap)); if (w) set.gap = w.gap; }
      const changes = [];
      if (Object.keys(set).length) changes.push({ table: 'gaps', key: { user_id: user, id: G.survivor.id }, before: G.survivor, after: set });
      // Deleted rows come back whole on undo, so each is read in full when the plan is applied (fullGaps).
      for (const x of G.dups) changes.push({ table: 'gaps', key: { user_id: user, id: x.id }, before: x, after: null, full: true });
      return { label: `Gap ${G.survivor.id}`, topic_id: G.survivor.topic_id || null, changes, stated: G.dups.filter(x => x.card_id == null).map(x => `gap:${x.id}`),
        item: { keep: G.survivor.id, merge: G.dups.map(x => x.id), card_id: G.survivor.card_id ?? null } };
    });
    out.gaps = { groups, counts: { groups: groups.length, merged: groups.reduce((a, g) => a + g.item.merge.length, 0) } };
  }
  if (want.has('forms')) {
    const mixedSql = FORMS_SQL.find(([k]) => k === 'mixed_no_confusion')[1];
    const mixed = (await env.DB.prepare(`SELECT g.id, g.mixed_with, g.cause, g.topic_id FROM gaps g WHERE g.id IN (SELECT id FROM (${mixedSql}))`).bind(user).all()).results || [];
    const fake = await fakeQuotes(env, user, { now });
    const missRows = fake.length ? (await env.DB.prepare('SELECT id, label, topic_id, cause_quote, cause_inferred FROM misses WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))')
      .bind(user, JSON.stringify(fake.map(f => f.id))).all()).results || [] : [];
    const groups = [
      ...mixed.map(g => ({ label: `Gap ${g.id}`, topic_id: g.topic_id || null,
        changes: [{ table: 'gaps', key: { user_id: user, id: g.id }, before: { mixed_with: g.mixed_with }, after: { mixed_with: null } }],
        item: { id: g.id, why: 'mixed-with without a confusion', cause: g.cause } })),
      ...missRows.map(m => ({ label: m.label || `Miss ${m.id}`, topic_id: m.topic_id || null,
        changes: [{ table: 'misses', key: { user_id: user, id: m.id }, before: { cause_quote: m.cause_quote, cause_inferred: m.cause_inferred }, after: { cause_quote: null, cause_inferred: 1 } }],
        item: { id: m.id, why: 'cause quote not his words' } })),
    ];
    out.forms = { groups, counts: { cleared: groups.length, mixed: mixed.length, quotes: missRows.length } };
  }
  if (want.has('blocks')) {
    const miss = missingAnswers(d.blocks, d.onMap);
    const unflagged = d.blocks.filter(b => b.complete == null || Number(b.complete) !== blockComplete(b.count, parse(b.questions_json, [])));
    out.blocks = { groups: [], missing: miss, unflagged: unflagged.map(b => b.id),
      counts: { blocks: miss.size, answers: [...miss.values()].reduce((a, l) => a + l.length, 0), flags: unflagged.length,
        complete: d.blocks.filter(b => blockComplete(b.count, parse(b.questions_json, []))).length } };
  }
  const sig = Object.entries(out).map(([k, p]) => [k, k === 'blocks' ? [[...p.missing].sort(), p.unflagged.sort()]
    : p.groups.map(g => g.changes.map(c => [c.table, JSON.stringify(c.key), JSON.stringify(c.before), JSON.stringify(c.after)]))]);
  // The clean-up's own time is left out, so the real run, a moment later, has the same confirm when the data has not moved.
  return { parts: out, confirm: fnv1a(JSON.stringify(sig, (k, v) => (v === now ? '$now' : v)).replace(new RegExp(`\\b${now}\\b`, 'g'), '$now')) };
}

// The dry run's answer: counts and a few examples a part (labels and ids only).
function shown(plan) {
  const parts = {};
  for (const [k, p] of Object.entries(plan.parts)) {
    parts[k] = { counts: p.counts, ...(k === 'blocks' ? { missing: Object.fromEntries([...p.missing].slice(0, HYGIENE.examples)), unflagged: p.unflagged.slice(0, HYGIENE.examples) }
      : { items: p.groups.slice(0, HYGIENE.examples).map(g => g.item), ...(p.groups.length > HYGIENE.examples ? { more: p.groups.length - HYGIENE.examples } : {}) }) };
  }
  return parts;
}

// ---------------------------------------------------------------- apply

const evStrip = r => { const o = {}; for (const [k, v] of Object.entries(r)) if (!['id', 'user_id', 'created_at', 'created_by', 'updated_at', 'gen'].includes(k)) o[k] = v; return o; };

/** One part's groups in undoable batches. Returns [{batch_id, groups}]. */
async function applyPart(env, user, name, groups, now) {
  const { writeBatch } = await import('./events.js');
  const out = [];
  for (const part of chunk(groups, HYGIENE.per_batch)) {
    const changes = part.flatMap(g => g.changes.map(c => ({ c, g })));
    // A deleted gap comes back whole on undo: read in full now.
    const fullIds = changes.filter(x => x.c.full).map(x => x.c.key.id);
    if (fullIds.length) {
      const rows = (await env.DB.prepare('SELECT * FROM gaps WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))').bind(user, JSON.stringify(fullIds)).all()).results || [];
      for (const x of changes) if (x.c.full) x.c.before = rows.find(r => r.id === x.c.key.id) || x.c.before;
    }
    const evidence = { upsert: [], remove: [] };
    if (name === 'misses') {
      // The duplicates' answers leave the map; the survivor's answer takes the block's real time and the words it gained.
      const keys = part.map(g => rawKey(user, g.survivor.id));
      const evs = (await env.DB.prepare('SELECT * FROM evidence WHERE user_id = ? AND slot = 0 AND obs_key IN (SELECT value FROM json_each(?))').bind(user, JSON.stringify(keys)).all()).results || [];
      for (const g of part) {
        for (const x of g.dups) evidence.remove.push(rawKey(user, x.id));
        const e = evs.find(r => r.obs_key === rawKey(user, g.survivor.id));
        if (!e) continue;
        const o = evStrip(e);
        let moved = false;
        if (g.sset.at != null && Number(g.sset.at) !== Number(e.at)) { o.at = g.sset.at; o.day = g.sset.day; moved = true; }
        for (const k of ['confidence', 'error_type']) if (e[k] == null && g.sset[k] != null) { o[k] = g.sset[k]; moved = true; }
        if (moved) evidence.upsert.push(o);
      }
    }
    if (name === 'gaps') for (const g of part) evidence.remove.push(...g.stated);
    const stmts = changes.map(x => changeStatement(env.DB, x.c));
    const events = changes.map(x => changeEvent(x.c, `${x.g.label}: ${SUMMARY[name]}`, x.g.topic_id));
    const topics = [...new Set(part.map(g => g.topic_id).filter(Boolean))];
    const w = await writeBatch(env, user, { actor: 'code', surface: 'code', via: 'api:POST /api/map/hygiene', undoable: true, statements: stmts, events,
      evidence: evidence.upsert.length || evidence.remove.length ? evidence : undefined, recompute: topics });
    out.push({ batch_id: w.batch_id, groups: part.length });
  }
  return out;
}
const SUMMARY = { misses: 'one miss for one question (duplicates merged)', misconceptions: 'near-identical misconceptions made one', retests: 'a duplicate card booking removed',
  said: 'words that were not his cleared', gaps: 'duplicate gaps made one', forms: 'a mixed-with without a mix-up, or a quote that was not his, cleared' };

/** The blocks part: each block's missing answers ingested (ingest/hub.js) and its complete flag set. */
async function applyBlocks(env, user, p) {
  const out = { ingested: 0, batches: [], flags: 0 };
  const ids = [...new Set([...p.missing.keys(), ...p.unflagged])].slice(0, HYGIENE.blocks);
  const { ingestUworldQuestions } = await import('./ingest/hub.js');
  const { markComplete } = await import('../uworld.js');
  for (const id of ids) {
    const b = await env.DB.prepare('SELECT questions_json FROM uworld_blocks WHERE id = ?').bind(id).first();
    if (!b) continue;
    const qs = parse(b.questions_json, []);
    if (p.missing.has(id)) {
      const r = await ingestUworldQuestions(env, user, id, qs);
      out.ingested += p.missing.get(id).length;
      if (r && r.batch) out.batches.push(r.batch);
    }
    if ((await markComplete(env, id, qs)) != null) out.flags++;
  }
  out.left = Math.max(0, new Set([...p.missing.keys(), ...p.unflagged]).size - ids.length);
  return out;
}

/** The clean-up: a dry run (the default) or the plan applied. See the header. */
export async function hygiene(env, user, { dry_run = true, parts = PARTS, confirm = null, now = Date.now() } = {}) {
  let plan;
  try { plan = await planHygiene(env, user, { parts, now }); } catch (e) { if (noTable(e)) throw new HttpError(503, 'Run migration 0054 first.'); throw e; }
  const res = { dry_run: !!dry_run, parts: shown(plan), confirm: plan.confirm };
  if (dry_run) return res;
  if (confirm !== plan.confirm) throw new HttpError(409, 'The data changed since the dry run (or no dry run was given): run the dry run again and apply its confirm.');
  res.batches = {};
  for (const [name, p] of Object.entries(plan.parts)) {
    if (name === 'blocks') { res.blocks = await applyBlocks(env, user, p); continue; }
    if (p.groups.length) res.batches[name] = (await applyPart(env, user, name, p.groups, now)).map(b => b.batch_id);
  }
  return res;
}

function noteRun(env, user, ref, res, now, error = null) {
  const c = k => (res && res.parts && res.parts[k] ? res.parts[k].counts : {}) || {};
  return noteJob(env, { job: 'hygiene', key: `${ref}:${londonDay(now)}`, ref, user, at: now, add: ref !== 'dry', state: error ? 'failed' : 'ok', detail: error,
    counts: error ? { n: 1 } : { misses: Number(c('misses').merged) || 0, miscs: Number(c('misconceptions').merged) || 0, retests: (Number(c('retests').removed) || 0) + (Number(c('misses').retests_removed) || 0),
      said: Number(c('said').cleared) || 0, gaps: Number(c('gaps').merged) || 0, answers: Number(c('blocks').answers) || 0, forms: Number(c('forms').cleared) || 0,
      batches: Object.values((res && res.batches) || {}).reduce((a, l) => a + l.length, 0), undone: Number(res && res.undone) || 0 } });
}

// POST /api/map/hygiene {dry_run = true, parts?, confirm?, undo?}
export async function hygieneRoute(request, env, ctx, params, url, user) {
  const body = (await readJson(request, 20_000).catch(() => ({}))) || {};
  for (const k of Object.keys(body)) if (!['dry_run', 'parts', 'confirm', 'undo'].includes(k)) throw new HttpError(400, `Unknown field ${k}.`);
  const now = Date.now();
  if (body.undo != null) {
    const ids = (Array.isArray(body.undo) ? body.undo : [body.undo]).filter(x => typeof x === 'string' && x);
    if (!ids.length || ids.length > 60) throw new HttpError(400, 'undo is a batch id or a list of at most 60.');
    const { undoBatch } = await import('./undo.js');
    const done = [];
    // Newest first, so a later batch that touched the same rows is undone before an earlier one.
    for (const id of [...ids].reverse()) done.push({ batch_id: id, ...(await undoBatch(env, user, id, { actor: 'code', surface: 'code', via: 'api:POST /api/map/hygiene' })) });
    const res = { undone: done.filter(d => !d.conflict).length, results: done };
    await noteRun(env, user, 'undo', res, now);
    return json(res);
  }
  const parts = body.parts == null ? PARTS : Array.isArray(body.parts) ? body.parts : [body.parts];
  for (const p of parts) if (!PARTS.includes(p)) throw new HttpError(400, `parts are ${PARTS.join(', ')}.`);
  const dry = body.dry_run !== false;
  try {
    const res = await hygiene(env, user, { dry_run: dry, parts, confirm: body.confirm ?? null, now });
    await noteRun(env, user, dry ? 'dry' : 'run', res, now);
    return json(res);
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 409)) await noteRun(env, user, dry ? 'dry' : 'run', null, now, (e && e.message) || 'failed');   // a failure posts too
    throw e;
  }
}
