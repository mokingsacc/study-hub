import { summaryOf } from '../map/events.js';

export const KINDS = ['condition', 'exam', 'skill', 'interpretation', 'investigation', 'law'];
// The atlas tabs' words, and each kind's usual sections (the go-live import follows them; nothing enforces them).
export const KIND_LABELS = { condition: 'Conditions', exam: 'Examinations', skill: 'Skills', interpretation: 'Data', investigation: 'Tests', law: 'Law and ethics' };
export const KIND_SECTIONS = {
  condition: ['Risk factors', 'Features', 'Examination findings', 'Investigations', 'Interpretation', 'Management', 'Prescribing points', 'Red flags', 'Law points'],
  exam: ['Steps', 'Look for', 'Findings and meaning'],
  skill: ['Indications', 'Contraindications', 'Kit', 'Steps', 'Complications', 'Aftercare'],
  interpretation: ['Approach', 'Patterns and meaning', 'Pitfalls'],
  investigation: ['First-line', 'Further', 'What results mean'],
  law: ['The rule', 'When it applies', 'What you do', 'Pitfalls', 'Source'],
};

// Limits, refused (never cut). An import is at most 30 entries, so its JSON stays well inside D1's 2 MB a value.
export const LIMITS = {
  entries: 30, remove: 200, id: 80, title: 120, category: 60, summary: 160, aliases: 12, alias: 120,
  sections: 20, sectionTitle: 80, caption: 160, rows: 30, group: 120, items: 40, item: 400, source: 200, sources: 10, sourceLabel: 160, url: 300,
  sectionsJson: 30000,
};
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

class Bad extends Error {}
function need(ok, msg) { if (!ok) throw new Bad(msg); }
function str(v, max, what, { required = true } = {}) {
  const s = text(v);
  need(!required || s, `${what} is missing.`);
  need(s.length <= max, `${what} is ${s.length} characters; the limit is ${max}.`);
  return s;
}
const httpsUrl = u => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password; } catch { return false; } };

/** One entry checked and tidied, or throws with a plain sentence naming it. Pure. */
export function cleanEntry(e, i = 0) {
  need(isObj(e), `Entry ${i + 1} is not an object.`);
  const id = text(e.id);
  const name = id || `entry ${i + 1}`;
  need(ID_RE.test(id) && id.length <= LIMITS.id, `${name}: id is lower-case letters, digits and dashes (at most ${LIMITS.id}).`);
  need(KINDS.includes(e.kind), `${name}: kind is one of ${KINDS.join(', ')}.`);
  const out = {
    id, kind: e.kind,
    category: str(e.category, LIMITS.category, `${name}: category`),
    title: str(e.title, LIMITS.title, `${name}: title`),
    summary: str(e.summary, LIMITS.summary, `${name}: summary`, { required: false }) || null,
    demo: e.demo === true,
  };
  need(e.aliases == null || Array.isArray(e.aliases), `${name}: aliases is a list.`);
  const aliases = (e.aliases || []).map((a, j) => str(a, LIMITS.alias, `${name}: alias ${j + 1}`));
  need(aliases.length <= LIMITS.aliases, `${name}: at most ${LIMITS.aliases} aliases.`);
  out.aliases = aliases;

  need(Array.isArray(e.sections) && e.sections.length >= 1 && e.sections.length <= LIMITS.sections, `${name}: sections is a list of 1 to ${LIMITS.sections}.`);
  out.sections = e.sections.map((s, j) => {
    const where = `${name}: section ${j + 1}`;
    need(isObj(s), `${where} is not an object.`);
    const sec = { title: str(s.title, LIMITS.sectionTitle, `${where} title`) };
    const caption = str(s.caption, LIMITS.caption, `${where} caption`, { required: false });
    if (caption) sec.caption = caption;
    if (s.ordered === true) sec.ordered = true;
    need(Array.isArray(s.rows) && s.rows.length >= 1 && s.rows.length <= LIMITS.rows, `${where} (${sec.title}): rows is a list of 1 to ${LIMITS.rows}.`);
    sec.rows = s.rows.map((r, k) => {
      need(isObj(r), `${where}, row ${k + 1} is not an object.`);
      need(Array.isArray(r.items) && r.items.length >= 1 && r.items.length <= LIMITS.items, `${where}, row ${k + 1}: items is a list of 1 to ${LIMITS.items}.`);
      return { group: str(r.group, LIMITS.group, `${where}, row ${k + 1} group`, { required: false }),
        items: r.items.map((t, n) => str(t, LIMITS.item, `${where}, row ${k + 1}, item ${n + 1}`)) };
    });
    const source = str(s.source, LIMITS.source, `${where} source`, { required: false });
    if (source) sec.source = source;
    return sec;
  });

  need(e.sources == null || Array.isArray(e.sources), `${name}: sources is a list.`);
  out.sources = (e.sources || []).map((s, j) => {
    const src = isObj(s) ? s : { label: s };
    const o = { label: str(src.label, LIMITS.sourceLabel, `${name}: source ${j + 1}`) };
    if (src.url != null && src.url !== '') {
      need(httpsUrl(src.url) && String(src.url).length <= LIMITS.url, `${name}: source ${j + 1} url must be an https link.`);
      o.url = String(src.url);
    }
    return o;
  });
  need(out.sources.length <= LIMITS.sources, `${name}: at most ${LIMITS.sources} sources.`);
  // Each table cites its source: its own line, or the entry's sources.
  need(out.sources.length || out.sections.every(s => s.source), `${name}: give sources, or a source on every section.`);
  need(JSON.stringify(out.sections).length <= LIMITS.sectionsJson, `${name}: its tables are over ${LIMITS.sectionsJson} characters; split it into two entries.`);
  return out;
}

/** The import's arguments checked: {entries, remove, remove_demo} or {refuse}. Pure. */
export function cleanImport(args) {
  try {
    need(isObj(args), 'The import is malformed.');
    for (const k of Object.keys(args)) need(['entries', 'remove', 'remove_demo'].includes(k), `Unknown argument ${k}.`);
    need(args.entries == null || Array.isArray(args.entries), 'entries is a list.');
    need(args.remove == null || (Array.isArray(args.remove) && args.remove.every(x => typeof x === 'string')), 'remove is a list of entry ids.');
    const entries = (args.entries || []).map(cleanEntry);
    need(entries.length <= LIMITS.entries, `At most ${LIMITS.entries} entries in one import; send the rest in another.`);
    need(new Set(entries.map(e => e.id)).size === entries.length, 'An entry id is given twice.');
    const remove = [...new Set(args.remove || [])];
    need(remove.length <= LIMITS.remove, `At most ${LIMITS.remove} removals in one import.`);
    need(!remove.some(id => entries.some(e => e.id === id)), 'An entry cannot be both imported and removed.');
    const removeDemo = args.remove_demo === true;
    need(entries.length || remove.length || removeDemo, 'Nothing to import: give entries, remove or remove_demo.');
    return { entries, remove, remove_demo: removeDemo };
  } catch (e) {
    if (e instanceof Bad) return { refuse: e.message };
    throw e;
  }
}

// The stored columns of an entry (JSON as text), and back.
const COLS = ['kind', 'category', 'title', 'aliases_json', 'summary', 'sections_json', 'sources_json', 'demo'];
export function rowOf(e) {
  return { kind: e.kind, category: e.category, title: e.title, aliases_json: JSON.stringify(e.aliases), summary: e.summary,
    sections_json: JSON.stringify(e.sections), sources_json: JSON.stringify(e.sources), demo: e.demo ? 1 : 0 };
}
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
export function entryOut(r, { full = false } = {}) {
  const e = { id: r.id, kind: r.kind, category: r.category, title: r.title, aliases: parse(r.aliases_json, []), summary: r.summary || null,
    demo: !!r.demo, updated_at: r.updated_at };
  if (full) { e.sections = parse(r.sections_json, []); e.sources = parse(r.sources_json, []); }
  return e;
}

/**
 * Op uk.import's planner: reads the entries it names (one query) and returns row diffs (insert, update or
 * soft_delete) with one event each. Unchanged entries are skipped; nothing to change is a noop.
 */
export async function planImport(env, user, args, ctx) {
  const c = cleanImport(args);
  if (c.refuse) return { refuse: c.refuse };
  const ids = [...c.entries.map(e => e.id), ...c.remove];
  const rows = (await env.DB.prepare(
    `SELECT * FROM uk_entries WHERE user_id = ?1 AND (id IN (SELECT value FROM json_each(?2)) OR (?3 = 1 AND demo = 1 AND deleted_at IS NULL))`)
    .bind(user, JSON.stringify(ids), c.remove_demo ? 1 : 0).all()).results || [];
  const have = new Map(rows.map(r => [r.id, r]));
  const now = ctx.now || Date.now();
  const diffs = [], events = [];
  for (const e of c.entries) {
    const cur = have.get(e.id);
    const next = rowOf(e);
    if (!cur) {
      diffs.push({ table: 'uk_entries', op: 'insert', key: { id: e.id }, before: null, after: { ...next, created_at: now, updated_at: now, deleted_at: null } });
      events.push({ kind: 'uk.added', target_type: 'uk_entries', target_id: e.id, summary: summaryOf(`UK entry added: ${e.title}`) });
      continue;
    }
    const changed = COLS.filter(k => String(cur[k] ?? '') !== String(next[k] ?? ''));
    if (!changed.length && cur.deleted_at == null) continue;
    const before = { updated_at: cur.updated_at, deleted_at: cur.deleted_at };
    const after = { updated_at: now, deleted_at: null };
    for (const k of changed) { before[k] = cur[k]; after[k] = next[k]; }
    diffs.push({ table: 'uk_entries', op: 'update', key: { id: e.id }, before, after });
    events.push({ kind: 'uk.updated', target_type: 'uk_entries', target_id: e.id, summary: summaryOf(`UK entry ${cur.deleted_at == null ? 'updated' : 'restored'}: ${e.title}`) });
  }
  const gone = new Set();
  const removeRow = r => {
    if (!r || r.deleted_at != null || gone.has(r.id)) return;
    gone.add(r.id);
    diffs.push({ table: 'uk_entries', op: 'soft_delete', key: { id: r.id }, before: { deleted_at: null, updated_at: r.updated_at }, after: { deleted_at: now, updated_at: now } });
    events.push({ kind: 'uk.removed', target_type: 'uk_entries', target_id: r.id, summary: summaryOf(`UK entry removed: ${r.title}`) });
  };
  for (const id of c.remove) removeRow(have.get(id));
  if (c.remove_demo) for (const r of rows) if (r.demo) removeRow(r);
  if (!diffs.length) return { noop: true, summary: 'The UK entries are already up to date.' };
  const n = { added: 0, updated: 0, removed: 0 };
  for (const ev of events) n[ev.kind.slice(3)]++;
  const words = Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ');
  return { rows: diffs, events, summary: `UK import: ${words}`, reply: { counts: n } };
}

// ---------------------------------------------------------------- reads (one D1 query or batch each)

/** The atlas: every live entry without its tables, and the counts by kind. kind and category filter. */
export async function listEntries(env, user, { kind = null, category = null } = {}) {
  const where = 'user_id = ?1 AND deleted_at IS NULL';
  const [list, counts] = await env.DB.batch([
    env.DB.prepare(`SELECT id, kind, category, title, aliases_json, summary, demo, updated_at FROM uk_entries
      WHERE ${where} AND (?2 IS NULL OR kind = ?2) AND (?3 IS NULL OR category = ?3) ORDER BY category COLLATE NOCASE, title COLLATE NOCASE`)
      .bind(user, kind, category),
    env.DB.prepare(`SELECT kind, count(*) AS n, sum(demo) AS demo FROM uk_entries WHERE ${where} GROUP BY kind`).bind(user),
  ]);
  const by = Object.fromEntries(KINDS.map(k => [k, 0]));
  let demo = 0;
  for (const r of counts.results || []) { by[r.kind] = r.n; demo += r.demo || 0; }
  return { entries: (list.results || []).map(r => entryOut(r)), counts: by, demo };
}

export async function getEntry(env, user, id) {
  const r = await env.DB.prepare('SELECT * FROM uk_entries WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL').bind(user, id).first();
  return r ? entryOut(r, { full: true }) : null;
}

// Search words as an FTS5 query: each word a quoted prefix, all of them needed. null with no words. Hyphens split
// words ("CURB-65" is curb and 65); the index's joined column holds them unsplit, so "CURB65" matches too. A word
// is matched from its start only (unicode61 tokens): "CO2" does not find "pCO2".
export function ftsQuery(q) {
  const words = String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.length ? words.slice(0, 8).map(w => `"${w}"*`).join(' ') : null;
}
// Snippet marks: control characters the page turns into <mark> after escaping the text.
export const MARK_ON = '\u0002', MARK_OFF = '\u0003';

/** Search: hits by rank, a title match first, each with a short snippet of where the words are. */
export async function searchEntries(env, user, q, limit = 30) {
  const match = ftsQuery(q);
  if (!match) return [];
  const rows = (await env.DB.prepare(
    `SELECT e.id, e.kind, e.category, e.title, e.demo, snippet(uk_fts, 4, ?3, ?4, '…', 14) AS snippet
     FROM uk_fts f JOIN uk_entries e ON e.user_id = f.user_id AND e.id = f.id
     WHERE uk_fts MATCH ?2 AND f.user_id = ?1 AND e.deleted_at IS NULL
     ORDER BY bm25(uk_fts, 0, 0, 8.0, 4.0, 1.0, 1.0) LIMIT ?5`).bind(user, match, MARK_ON, MARK_OFF, limit).all()).results || [];
  return rows.map(r => ({ id: r.id, kind: r.kind, category: r.category, title: r.title, demo: !!r.demo, snippet: r.snippet || '' }));
}
