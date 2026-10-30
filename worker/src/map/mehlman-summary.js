import { json, HttpError } from '../util.js';
import { reserveSpend, spendCap } from '../db.js';
import { callJson, MODELS } from '../claude.js';
import { resourceId } from './mehlman.js';

export const ROLE = 'summariser';
export const PASSAGES_MAX = 4;
export const FULL_MAX = 2400;             // one passage's text, at most (a library passage is 150-400 tokens)
export const SUMMARY_MAX = 900;           // characters kept of Claude's paragraph
export const RESERVE_USD = 0.25;          // held against the caps while the call runs, then settled to its real cost
export const ANCHOR = 48;                 // the snippet's opening characters that find its passage in the library

export const SUMMARY_SYSTEM = `You summarise what Mo's Mehlman notes say about one topic, for his USMLE Step 2 CK revision. He reads it on his study map, under the passages themselves.

Write ONE short paragraph of 3 to 5 plain sentences (at most 110 words):
- Only what the Mehlman passages given say. Add nothing from elsewhere; if the passages leave out something important (such as the treatment), say in a few words that Mehlman does not cover it here.
- Lead with what decides the diagnosis or the next step, then management, in US-guideline terms and US practice. If a passage seems to disagree with current US guidelines, say so in one short clause.
- Plain words a tired doctor reads in ten seconds. No lists, headings, markdown, bold or abbreviations he would have to decode (spell out any that are not standard).
- Cite the pages in brackets after the sentence they support, like (p. 112) or (pp. 40–41).
- Never quote or rebuild question-bank text (UWorld, NBME); this is about Mehlman's notes only.

Answer as JSON: summary (the paragraph) and pages (the page references you cited, like "p. 112").`;

export const SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'pages'],
  properties: { summary: { type: 'string' }, pages: { type: 'array', items: { type: 'string' } } },
};

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const norm = s => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const notReady = e => { if (noTable(e)) throw new HttpError(503, "The map isn't set up yet."); throw e; };

export const passageKey = p => `${p.resource_id || ''}:${p.page ?? ''}`;
/** 'p. 112' or 'pp. 40–41'. */
export const pageWords = p => (p.page == null ? '' : p.page_to && p.page_to !== p.page ? `pp. ${p.page}–${p.page_to}` : `p. ${p.page}`);

/** A short hash of the passages' ids (book and pages), the summary's cache key: the same passages, the same key. */
export async function passagesKey(items) {
  const ids = (items || []).map(p => `${p.resource_id || ''}:${p.page ?? ''}-${p.page_to ?? ''}`).sort().join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ids));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function matchPassage(snippet, resource, rows) {
  const anchor = norm(snippet).slice(0, ANCHOR).replace(/\s\S*$/, '');
  if (anchor.length < 12) return null;
  let best = null;
  for (const r of rows || []) {
    const at = norm(r.text).indexOf(anchor);
    if (at < 0) continue;
    const sameBook = resourceId(r.title || '') === resource;
    const score = (sameBook ? 0 : 1e6) + at;   // the same book first, then the passage where the snippet starts soonest
    if (!best || score < best.score) best = { row: r, score };
  }
  return best ? best.row : null;
}

export async function topicPassages(env, user, topicId) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [t, l] = await env.DB.batch([
    q(`SELECT id, name, status, merged_into FROM topics WHERE user_id = ? AND id = ?`, user, topicId),
    q(`SELECT r.resource_id, coalesce(x.title, r.label, r.resource_id) AS title, r.page, r.page_to, r.section, r.snippet
      FROM resource_links r LEFT JOIN resources x ON x.user_id = r.user_id AND x.id = r.resource_id
      WHERE r.user_id = ? AND r.topic_id = ? AND r.kind = 'mehlman' AND r.status = 'live' ORDER BY r.rank DESC LIMIT ${PASSAGES_MAX}`, user, topicId),
  ]);
  const topic = (t.results || [])[0];
  if (!topic) return null;
  const links = l.results || [];
  // The library's passages on the same pages (one read for all of them); none when the book is not in the library.
  let lib = links.map(() => []);
  const paged = links.map((p, i) => [p, i]).filter(([p]) => p.page != null && p.snippet);
  if (paged.length) {
    try {
      const res = await env.DB.batch(paged.map(([p]) => q(`SELECT p.page, p.page_to, p.heading, p.text, d.title FROM library_passages p
          JOIN library_docs d ON d.user_id = p.user_id AND d.id = p.doc_id
          WHERE p.user_id = ?1 AND d.collection = 'mehlman' AND p.page <= ?3 AND p.page_to >= ?2 ORDER BY p.doc_id, p.seq LIMIT 40`,
      user, Number(p.page), Number(p.page_to ?? p.page))));
      paged.forEach(([, i], k) => { lib[i] = res[k].results || []; });
    } catch (e) {
      if (!noTable(e)) throw e;   // no library yet: the snippets are the passages
      lib = links.map(() => []);
    }
  }
  const items = links.map((p, i) => {
    const hit = matchPassage(p.snippet, p.resource_id, lib[i]);
    const text = clean(hit ? hit.text : p.snippet).slice(0, FULL_MAX);
    return {
      key: passageKey(p), resource_id: p.resource_id, title: p.title, page: p.page == null ? null : Number(p.page),
      page_to: p.page_to == null ? null : Number(p.page_to), heading: clean((hit && hit.heading) || p.section) || null, text, full: !!hit,
    };
  });
  return { topic: { id: topic.id, name: topic.name }, items };
}

const NEEDS_MIGRATION = 'The hub needs its newest database update (migration 0021) to keep summaries.';
// The stored summary for these passages, or null. Before migration 0021 a read says null, and a summary is refused
// (strict) before Claude is asked, so nothing is spent on a summary that could not be kept.
async function cachedSummary(env, user, topicId, key, { strict = false } = {}) {
  const r = await env.DB.prepare(`SELECT summary, pages_json, created_at FROM mehlman_summaries WHERE user_id = ? AND topic_id = ? AND passages_key = ?`)
    .bind(user, topicId, key).first().catch(e => { if (!noTable(e)) throw e; if (strict) throw new HttpError(503, NEEDS_MIGRATION); return null; });
  if (!r) return null;
  let pages = [];
  try { pages = JSON.parse(r.pages_json || '[]'); } catch { pages = []; }
  return { text: r.summary, pages: Array.isArray(pages) ? pages : [], at: r.created_at };
}

/** The user turn: the topic, then each passage with its book and pages. */
export function summaryPrompt(topic, items) {
  return `Topic: ${topic.name}\n\nMehlman passages on it:\n\n${items.map((p, i) => `[${i + 1}] ${p.title || 'Mehlman'}, ${pageWords(p) || 'page unknown'}`
    + `${p.heading ? ` (${p.heading})` : ''}:\n${p.text}`).join('\n\n')}`;
}

export async function mehlmanRoute(request, env, ctx, params, url, user) {
  const id = String(params.id || '');
  if (!id || id.length > 120) return json({ error: 'Which topic?' }, 400);
  const got = await topicPassages(env, user, id).catch(notReady);
  if (!got) return json({ error: 'There is no topic with that id on the map.' }, 404);
  const key = got.items.length ? await passagesKey(got.items) : null;
  return json({ items: got.items, passages_key: key, summary: key ? await cachedSummary(env, user, id, key) : null });
}

export async function summaryRoute(request, env, ctx, params, url, user, { call = null } = {}) {
  const id = String(params.id || '');
  if (!id || id.length > 120) return json({ error: 'Which topic?' }, 400);
  const got = await topicPassages(env, user, id).catch(notReady);
  if (!got) return json({ error: 'There is no topic with that id on the map.' }, 404);
  if (!got.items.length) return json({ error: 'There are no Mehlman passages on this topic to summarise yet.' }, 409);
  const key = await passagesKey(got.items);
  const hit = await cachedSummary(env, user, id, key, { strict: true });
  if (hit) return json({ summary: hit.text, pages: hit.pages, cached: true, passages_key: key, usd: 0 });

  const ask = { system: SUMMARY_SYSTEM, schema: SUMMARY_SCHEMA, effort: 'high', maxTokens: 8000,
    messages: [{ role: 'user', content: summaryPrompt(got.topic, got.items) }] };
  let data, usd = 0;
  if (call) ({ data, usd = 0 } = await call({ role: ROLE, ...ask }));
  else {
    const release = await reserveSpend(env, RESERVE_USD, await spendCap(env));   // 429 past the day's or month's cap
    try {
      ({ data, usd } = await callJson(env, { role: 'summariser', ...ask }));
    } finally {
      await release(0);   // callJson added the real cost (also for a call that failed after Claude answered)
    }
  }
  const summary = clean(data && data.summary).slice(0, SUMMARY_MAX);
  if (!summary) throw new HttpError(502, 'Claude sent back no summary. Try again in a moment.');
  const pages = (Array.isArray(data.pages) ? data.pages : []).map(clean).filter(Boolean).slice(0, 12);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM mehlman_summaries WHERE user_id = ? AND topic_id = ? AND passages_key != ?`).bind(user, id, key),
    env.DB.prepare(`INSERT INTO mehlman_summaries (user_id, topic_id, passages_key, summary, pages_json, model, usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, topic_id, passages_key) DO UPDATE SET summary = excluded.summary, pages_json = excluded.pages_json, model = excluded.model,
        usd = excluded.usd, created_at = excluded.created_at`).bind(user, id, key, summary, JSON.stringify(pages), MODELS[ROLE], usd, now),
  ]).catch(e => { if (noTable(e)) throw new HttpError(503, NEEDS_MIGRATION); throw e; });
  return json({ summary, pages, cached: false, passages_key: key, usd: Math.round(usd * 1e4) / 1e4 });
}
