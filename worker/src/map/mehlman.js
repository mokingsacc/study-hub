import { ankiCall } from '../anki.js';

export const CACHE_MS = 7 * 86_400_000;
export const KEEP = 5, SNIPPET_MAX = 400, PASSAGE_MAX = 350;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const words = s => clean(s).split(' ').filter(Boolean);
const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'with', 'and', 'or', 'to', 'for', 'is', 'are', 'then', 'give', 'do', 'get', 'start']);

// The If-clause and the Then-clause of a rule written "If X, then Y" (or "X → Y").
export function ruleParts(rule) {
  const r = clean(rule);
  let m = /^if\s+(.+?),?\s+then\s+(.+)$/i.exec(r) || /^(.+?)\s*(?:→|->|=>)\s*(.+)$/.exec(r);
  return m ? { if: m[1].replace(/[.,;]+$/, ''), then: m[2].replace(/[.,;]+$/, '') } : { if: null, then: null };
}

/**
 * Up to 4 deduplicated search wordings (pure). topic: {name, aliases?: [..], newest_rule?, top_look_alike?}.
 *   1. the name plus the shortest alias;  2. the newest rule's If-clause (at most 8 words);
 *   3. the name plus the Then-clause's first noun phrase (at most 5 words);  4. "<look-alike> versus <name>".
 * With no rule, 2 and 3 fall back to the two longest aliases.
 */
export function mehlmanQueries(topic) {
  const name = clean(topic && topic.name);
  if (!name) return [];
  const aliases = [...new Set((topic.aliases || []).map(clean).filter(a => a && a.toLowerCase() !== name.toLowerCase()))];
  const byLen = aliases.slice().sort((a, b) => a.length - b.length);
  const out = [byLen.length ? `${name} ${byLen[0]}` : name];
  const { if: cond, then } = ruleParts(topic.newest_rule);
  if (cond || then) {
    if (cond) out.push(words(cond).slice(0, 8).join(' '));
    if (then) {
      const np = [];
      for (const w of words(then)) {
        if (np.length && STOP.has(w.toLowerCase())) break;
        if (!STOP.has(w.toLowerCase())) np.push(w);
        if (np.length >= 5) break;
      }
      if (np.length) out.push(`${name} ${np.join(' ')}`);
    }
  } else {
    out.push(...byLen.slice().reverse().slice(0, 2));
  }
  if (topic.top_look_alike) out.push(`${clean(topic.top_look_alike)} versus ${name}`);
  const seen = new Set();
  return out.map(q => q.slice(0, 120)).filter(q => q && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase())).slice(0, 4);
}

export const resourceId = source => clean(source).replace(/\.pdf$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'mehlman';
// '225-226' -> [225, 226]; '7' -> [7, null].
export function pagesOf(page) {
  const m = /^(\d+)(?:\s*[-–]\s*(\d+))?/.exec(String(page ?? ''));
  return m ? [Number(m[1]), m[2] ? Number(m[2]) : null] : [null, null];
}

// The server's answer as passages {resource_id, title, page, page_to, section, text}, best first.
export function passagesFrom(reply, max = KEEP) {
  const list = Array.isArray(reply && reply.passages) ? reply.passages : [];
  const out = [], seen = new Set();
  for (const p of list) {
    const text = clean(p.text || p.passage || p.snippet);
    if (!text) continue;
    const title = clean(p.source || p.pdf || p.title).replace(/\.pdf$/i, '');
    const [page, page_to] = pagesOf(p.page);
    const key = `${resourceId(title)}|${page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ resource_id: resourceId(title), title, page, page_to, section: clean(p.section) || null, text: text.slice(0, SNIPPET_MAX) });
    if (out.length >= max) break;
  }
  return out;
}
export const matchOf = (reply, passages) => (reply && (reply.match === 'weak' || reply.match === 'strong') ? reply.match : passages.length ? 'strong' : 'weak');

export const MIN_SHARED = 3;
const LONG = /^[a-z]{5,}$/;
const MEH_STOP = new Set(['about', 'after', 'again', 'because', 'before', 'being', 'between', 'could', 'every', 'first', 'their', 'there',
  'these', 'think', 'those', 'which', 'while', 'would', 'without', 'means', 'patient', 'patients', 'usually', 'other', 'often', 'still',
  // Words on every other page, so sharing them says nothing (Q13's lung picture matched on "disease").
  'disease', 'diseases', 'syndrome', 'normal', 'chronic', 'acute', 'infection', 'common', 'cause', 'causes', 'treatment', 'diagnosis']);
const lower = s => clean(s).toLowerCase();
const stems = s => new Set(lower(s).replace(/[^a-z\s-]+/g, ' ').split(/[\s-]+/).filter(w => LONG.test(w) && !MEH_STOP.has(w)).map(w => w.slice(0, 5)));
/** Does the passage name it: the phrase, an acronym as a word, or every long word of a longer name. */
export function names(text, name) {
  const n = clean(name);
  if (!n) return false;
  const t = ` ${lower(text).replace(/[^a-z0-9]+/g, ' ')} `;
  const phrase = lower(n).replace(/[^a-z0-9]+/g, ' ').trim();
  if (phrase && t.includes(` ${phrase} `)) return true;
  const long = phrase.split(' ').filter(w => w.length >= 4 && !MEH_STOP.has(w));
  return long.length >= 2 && long.every(w => t.includes(` ${w}`));
}
/**
 * The passage that fits a question best, or null. want: {names: [the condition and its other names], look_alike, rule,
 * clue, separator}. Pure.
 */
export function bestPassage(passages, want) {
  const nameList = (want.names || []).filter(Boolean);
  const key = stems([want.rule, want.clue, want.separator].filter(Boolean).join(' '));
  let best = null;
  for (const p of passages || []) {
    const text = [p.title, p.section, p.text].filter(Boolean).join(' ');
    // A practice question whose answer is something else only lists the name among its options (hyphema beside
    // "The answer is B (macular degeneration)"): it does not count as naming it.
    const answer = /the answer is\s+[a-h]\b[^.]{0,80}/i.exec(p.text || '');
    // A practice question with its options and no answer in view ("46) A 28-year-old ... C) Hyphema D) Scleritis")
    // is not a note on the topic either.
    const quiz = !answer && /(?:^|\s)\d{1,3}\)\s/.test(p.text || '') && ((p.text || '').match(/\b[A-H]\)\s/g) || []).length >= 2;
    if (quiz) continue;
    const named = nameList.some(n => names(text, n) && (!answer || names(answer[0], n)));
    // About the look-alike and not the condition (Klebsiella aspiration pneumonia on chemical pneumonitis): not this one.
    if (!named && want.look_alike && names(text, want.look_alike)) continue;
    let shared = 0;
    for (const w of stems(text)) if (key.has(w)) shared++;
    if (!named && shared < MIN_SHARED) continue;
    const score = (named ? 10 : 0) + (want.look_alike && names(text, want.look_alike) ? 2 : 0) + shared;
    if (!best || score > best.score) best = { score, p };
  }
  return best ? best.p : null;
}

const sameQueries = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);
const cut = (p, n) => ({ ...p, text: p.text.length > n ? p.text.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : p.text });

// The topic's wordings inputs, in one batch: name, aliases, the newest rule, the top look-alike's name.
async function topicInputs(env, user, topicId) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [t, al, rule, la] = await env.DB.batch([
    q(`SELECT id, name FROM topics WHERE user_id = ? AND id = ?`, user, topicId),
    q(`SELECT alias FROM topic_aliases WHERE user_id = ? AND topic_id = ? AND status = 'active' LIMIT 12`, user, topicId),
    q(`SELECT rule FROM misses WHERE user_id = ? AND topic_id = ? AND held = 0 AND deleted_at IS NULL AND rule IS NOT NULL ORDER BY at DESC LIMIT 1`, user, topicId),
    q(`SELECT o.name FROM links k JOIN topics o ON o.user_id = k.user_id AND o.id = CASE WHEN k.from_id = ?2 THEN k.to_id ELSE k.from_id END
       WHERE k.user_id = ?1 AND k.type = 'versus' AND k.status IN ('active','proposed') AND (k.from_id = ?2 OR k.to_id = ?2)
       ORDER BY k.confusion DESC, k.strength DESC LIMIT 1`, user, topicId),
  ]);
  const row = (t.results || [])[0];
  if (!row) return null;
  return { id: row.id, name: row.name, aliases: (al.results || []).map(r => r.alias), newest_rule: ((rule.results || [])[0] || {}).rule || null,
    top_look_alike: ((la.results || [])[0] || {}).name || null };
}

async function readCache(env, user, topicId) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [f, l] = await env.DB.batch([
    q(`SELECT fetched_at, status, queries_json FROM source_fetches WHERE user_id = ? AND topic_id = ? AND kind = 'mehlman'`, user, topicId),
    q(`SELECT r.resource_id, coalesce(s.title, r.label, r.resource_id) AS title, r.page, r.page_to, r.section, r.snippet AS text FROM resource_links r
       LEFT JOIN resources s ON s.user_id = r.user_id AND s.id = r.resource_id
       WHERE r.user_id = ? AND r.topic_id = ? AND r.kind = 'mehlman' AND r.status = 'live' ORDER BY r.rank DESC LIMIT ${KEEP}`, user, topicId),
  ]);
  const fetch = (f.results || [])[0] || null;
  return fetch ? { fetched_at: fetch.fetched_at, match: fetch.status === 'weak' ? 'weak' : 'strong', queries: JSON.parse(fetch.queries_json || '[]'), passages: l.results || [] } : null;
}

function cacheStatements(env, user, topicId, queries, passages, match, now) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const stmts = [
    q(`DELETE FROM resource_links WHERE user_id = ? AND topic_id = ? AND kind = 'mehlman' AND status = 'live' AND created_by = 'code'`, user, topicId),
  ];
  passages.forEach((p, i) => stmts.push(q(`INSERT INTO resource_links (id, user_id, topic_id, kind, resource_id, page, page_to, label, section, snippet, query, rank,
      status, fetched_at, source, source_ref, created_by, created_at)
    VALUES (?, ?, ?, 'mehlman', ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, 'high_yield_notes', 'mehlman', 'code', ?)
    ON CONFLICT (user_id, topic_id, kind, resource_id, page) DO UPDATE SET snippet = excluded.snippet, page_to = excluded.page_to,
      section = excluded.section, label = excluded.label, rank = excluded.rank, fetched_at = excluded.fetched_at
      WHERE resource_links.status = 'live'`,
  crypto.randomUUID(), user, topicId, p.resource_id, p.page, p.page_to, p.title, p.section, p.text, queries[0] || null, KEEP - i, now, now)));
  stmts.push(q(`INSERT INTO source_fetches (user_id, topic_id, kind, fetched_at, n, status, error, queries_json) VALUES (?, ?, 'mehlman', ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, topic_id, kind) DO UPDATE SET fetched_at = excluded.fetched_at, n = excluded.n, status = excluded.status,
      error = excluded.error, queries_json = excluded.queries_json`,
  user, topicId, now, passages.length, match === 'weak' ? 'weak' : 'ok', match === 'weak' ? 'weak' : null, JSON.stringify(queries)));
  return stmts;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { timeout: true })), ms))]);

/**
 * {status: 'fresh'|'cached'|'stale'|'unreachable', match: 'strong'|'weak'|null, passages: [≤5 {resource_id, title,
 * page, page_to, section, text ≤350}], queries}. topic: a topic id, or {id?, name, aliases?, newest_rule?,
 * top_look_alike?} (no id: a topic not on the map, searched as typed and never cached).
 * opts: {timeoutMs = 2500, maxAgeMs = 7 days, force, now, ctx}; with ctx the cache write goes to waitUntil.
 * Never throws for the Anki server: a failure gives the stale cache ('stale') or nothing ('unreachable').
 */
export async function mehlmanFor(env, user, topic, opts = {}) {
  const { timeoutMs = 2500, maxAgeMs = CACHE_MS, force = false, keep = KEEP } = opts;
  const now = opts.now ?? Date.now();
  let t = typeof topic === 'string' ? null : topic;
  let cache = null;
  try {
    if (typeof topic === 'string') t = await topicInputs(env, user, topic);
  } catch (e) {
    if (!noTable(e)) throw e;
    t = null;
  }
  try {
    if (t && t.id) cache = await readCache(env, user, t.id);
  } catch (e) {
    if (!noTable(e)) throw e;   // no cache tables yet: search live, and the write below fails soft
  }
  if (!t || !t.name) return { status: 'unreachable', match: null, passages: [], queries: [] };
  const queries = mehlmanQueries(t);
  const shape = (status, match, passages) => ({ status, match, passages: passages.slice(0, keep).map(p => cut(p, PASSAGE_MAX)), queries });
  if (!force && cache && now - cache.fetched_at < maxAgeMs && sameQueries(cache.queries, queries)) return shape('cached', cache.match, cache.passages);

  let reply;
  try {
    reply = await withTimeout(ankiCall(env, 'high_yield_notes', { queries, exam: 'Step 2', limit: 8 }, { timeoutMs }), timeoutMs + 100);
  } catch {
    return cache ? shape('stale', cache.match, cache.passages) : shape('unreachable', null, []);
  }
  const passages = passagesFrom(reply, Math.max(keep, KEEP));
  const match = matchOf(reply, passages);
  const pictures = (Array.isArray(reply && reply.pictures) ? reply.pictures : []).filter(p => p && typeof p.library === 'string')
    .slice(0, 10).map(p => ({ library: p.library.slice(0, 120), caption: clean(p.caption).slice(0, 200), source: clean(p.source).slice(0, 120) || null }));
  if (t.id) {
    const write = env.DB.batch(cacheStatements(env, user, t.id, queries, passages, match, now))
      .catch(e => { if (!noTable(e)) console.error('mehlman cache write failed', e && e.message); });
    if (opts.ctx && typeof opts.ctx.waitUntil === 'function') opts.ctx.waitUntil(write);
    else await write;
  }
  return { ...shape('fresh', match, passages), ...(pictures.length ? { pictures } : {}) };
}

export function bestPictures(pictures, want) {
  const nameList = [...(want.names || []), want.look_alike].filter(Boolean);
  // Named only (Q20, 30 Oct 2026: acromegaly got the osteoarthritis picture on "joint space"): a picture is shown as
  // being of this condition, so a caption that only shares its words is not enough.
  const fits = p => nameList.some(n => names(p.caption || '', n));
  const ok = (pictures || []).filter(fits);
  const nbme = ok.find(p => /^nbme_/i.test(p.library)), anking = ok.find(p => /^anking_hy_/i.test(p.library));
  return [nbme, anking].filter(Boolean);
}
