// The Library's background work, one resumable step at a time (the map's minute dispatcher runs libraryJob every
// minute; an upload kicks a step at once in waitUntil). Each step does the first of these that has work, so a
// failure leaves everything as it was and the next minute carries on:
//   1. index a document whose pages are all in (store.js indexDocument);
//   2. OCR a page that had no text but an image (Workers AI vision, at most OCR_DAILY pages a London day; past that
//      the page waits for the next day), and add its passages. A failed read is tried again after OCR_RETRY_MS,
//      four times longer each time, up to OCR_MAX_TRIES; then the page is 'failed' and the document's status_note
//      and pages_unread say so;
//   3. embed passages (Workers AI bge, EMBED_STEP a step) into D1 and Vectorize; re-send to Vectorize what only D1 has;
//   4. link passages to map topics: the topic's name or an alias in the text (abbreviations as written, in
//      capitals) and embedding similarity (how far above the passage's usual topic it stands), as a confidence;
//   5. mark finished documents ready;
//   6. with nothing else to do, build the reranked coverage of up to COVER_STEP topics (highest yield first).
import { londonDay } from '../util.js';
import { chunkDocument, cut } from './text.js';
import { embedMany, passageText, quantise, dequantise, vectorizeUpsert, vectorizeOn, EMBED_MODEL, EMBED_DIMS } from './vectors.js';
import { indexDocument, noTable, keyFor, ocrPageSource, OCR_PAGE_SOURCE } from './store.js';
import { buildCoverage, libraryStamp, normKey } from './search.js';

export const EMBED_STEP = 300, LINK_STEP = 400, COVER_STEP = 12, OCR_DAILY = 150, OCR_STEP = 2, RESYNC_STEP = 500;
export const OCR_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const OCR_MAX_TRIES = 5, OCR_RETRY_MS = 5 * 60_000, OCR_RETRY_MAX_MS = 6 * 3600_000;
/** How long a page waits after its tries-th failed read: 5 min, 20 min, 80 min, 5 h 20 min (at most 6 h). */
export const ocrRetryMs = tries => Math.min(OCR_RETRY_MAX_MS, OCR_RETRY_MS * 4 ** Math.max(0, tries - 1));
export const LINK_MIN = 0.4, LINKS_PER_PASSAGE = 6;
const SOURCE = 'library';
const LIVE = "('proposed', 'confirmed')";

// ------------------------------------------------------------------ topic matching (pure)

/**
 * A matcher over the map's topics: {byKey: Map(normKey -> [{topic_id, kind, exact?}]), maxWords}. Abbreviations
 * (an alias of 2 to 5 letters, or kind abbrev) only match as written in capitals.
 */
export function topicMatcher(topics, aliases) {
  const byKey = new Map();
  let maxWords = 1;
  const add = (text, topic_id, kind) => {
    const key = normKey(text);
    if (!key || key.length < 3 && kind !== 'abbrev') return;
    const short = /^[A-Za-z0-9]{2,5}$/.test(String(text).trim());
    const entry = { topic_id, kind: short || kind === 'abbrev' ? 'abbrev' : kind, exact: short || kind === 'abbrev' ? String(text).trim() : null };
    if (!byKey.has(key)) byKey.set(key, []);
    const list = byKey.get(key);
    if (!list.some(e => e.topic_id === topic_id && e.kind === entry.kind)) list.push(entry);
    maxWords = Math.max(maxWords, key.split(' ').length);
  };
  for (const t of topics) { add(t.name, t.id, 'name'); if (t.short_name) add(t.short_name, t.id, 'abbrev'); }
  for (const a of aliases) if (!['uworld_label', 'log_topic', 'analysis_topic', 'gap_topic'].includes(a.kind)) add(a.alias, a.topic_id, a.kind === 'abbrev' ? 'abbrev' : 'alias');
  return { byKey, maxWords: Math.min(8, maxWords) };
}

/** Topics a passage names: Map(topic_id -> score 0..1). Heading hits count most. */
export function matchTopics(m, { heading = '', text = '' }) {
  const out = new Map();
  const scan = (s, inHeading) => {
    const words = normKey(s).split(' ').filter(Boolean);
    const raw = String(s);
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= m.maxWords && i + n <= words.length; n++) {
        const hits = m.byKey.get(words.slice(i, i + n).join(' '));
        if (!hits) continue;
        for (const h of hits) {
          if (h.kind === 'abbrev' && !new RegExp(`(^|[^A-Za-z0-9])${h.exact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`).test(raw)) continue;
          const base = h.kind === 'name' ? 0.8 : h.kind === 'abbrev' ? 0.6 : 0.7;
          const s2 = Math.min(1, (inHeading ? base + 0.15 : base) + (out.has(h.topic_id) ? 0.05 : 0));
          out.set(h.topic_id, Math.max(out.get(h.topic_id) || 0, s2));
        }
      }
    }
  };
  if (heading) scan(heading, true);
  scan(text, false);
  return out;
}

/**
 * Topics a passage's vector stands out for: Map(topic_id -> 0..0.8). z = (cos - mean) / sd over every topic; a
 * topic counts from z 3 and cos 0.6 (bge puts any two medical texts at 0.5 to 0.8).
 */
export function vectorTopics(vec, topicIds, mat, dims = EMBED_DIMS, { minZ = 3, minCos = 0.6, keep = 8 } = {}) {
  const n = topicIds.length;
  if (!n) return new Map();
  const cos = new Float32Array(n);
  let sum = 0, sq = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * dims;
    for (let j = 0; j < dims; j++) s += mat[o + j] * vec[j];
    cos[i] = s; sum += s; sq += s * s;
  }
  const mean = sum / n, sd = Math.sqrt(Math.max(1e-9, sq / n - mean * mean));
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => cos[b] - cos[a]).slice(0, keep);
  const out = new Map();
  for (const i of idx) {
    const z = (cos[i] - mean) / sd;
    if (z >= minZ && cos[i] >= minCos) out.set(topicIds[i], Math.round(Math.min(0.8, 0.3 + 0.5 * Math.min(1, (z - minZ) / 3)) * 1000) / 1000);
  }
  return out;
}

/** The passage's links: [{topic_id, score, method}] at LINK_MIN or more, best LINKS_PER_PASSAGE. */
export function combineLinks(byMatch, byVector) {
  const ids = new Set([...byMatch.keys(), ...byVector.keys()]);
  const out = [];
  for (const id of ids) {
    const a = byMatch.get(id) || 0, b = byVector.get(id) || 0;
    const score = Math.round((1 - (1 - a) * (1 - b)) * 1000) / 1000;
    if (score >= LINK_MIN) out.push({ topic_id: id, score, method: a >= b ? 'match' : 'vector' });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, LINKS_PER_PASSAGE);
}

// ------------------------------------------------------------------ steps

async function pendingIndex(env, user, now) {
  const d = await env.DB.prepare(`SELECT id FROM library_docs WHERE user_id = ?1 AND status = 'extracting' AND page_count IS NOT NULL AND pages_in >= page_count
      AND updated_at < ?2 ORDER BY updated_at LIMIT 1`).bind(user, now - 20_000).first();
  if (!d) return null;
  return { indexed: d.id, ...(await indexDocument(env, user, d.id, { now })) };
}

// Pages to read: pending ones whose next try is due, and (once Workers AI is bound) pages an earlier release left
// 'failed' or 'skipped' with no record of tries, so they get their tries too. A page 'failed' with a record has
// used them all; only "Index again" brings it back.
async function ocrStep(env, user, now, ai) {
  const canRead = !!(ai && env.LIBRARY);
  const page = await env.DB.prepare(`SELECT p.doc_id, p.n, s.fails FROM library_pages p JOIN library_docs d ON d.user_id = p.user_id AND d.id = p.doc_id
      LEFT JOIN sync_state s ON s.user_id = p.user_id AND s.source = ?3 || p.doc_id || ':' || p.n
      WHERE p.user_id = ?1 AND p.ocr_state IN ('pending', 'failed', 'skipped') AND d.status IN ('indexing', 'ready')
        AND (p.ocr_state = 'pending' AND coalesce(s.next_at, 0) <= ?4 OR ?5 AND p.ocr_state != 'pending' AND s.source IS NULL)
      ORDER BY p.doc_id, p.n LIMIT ?2`).bind(user, OCR_STEP, OCR_PAGE_SOURCE, now, canRead ? 1 : 0).all();
  const rows = page.results || [];
  if (!rows.length) return null;
  const day = londonDay(now);
  const st = await env.DB.prepare(`SELECT cursor FROM sync_state WHERE user_id = ?1 AND source = 'library.ocr'`).bind(user).first();
  const [d0, n0] = String((st && st.cursor) || '').split(':');
  let used = d0 === day ? Number(n0) || 0 : 0;
  // Today's reads are spent: the pages stay pending for tomorrow and the rest of the job carries on.
  if (canRead && used >= OCR_DAILY) return null;
  const done = [];
  for (const r of rows) {
    if (!canRead) {
      await env.DB.prepare(`UPDATE library_pages SET ocr_state = 'skipped' WHERE user_id = ?1 AND doc_id = ?2 AND n = ?3`).bind(user, r.doc_id, r.n).run();
      done.push({ doc_id: r.doc_id, n: r.n, skipped: true });
      continue;
    }
    if (used >= OCR_DAILY) break;
    used++;
    let text = '';
    try {
      const obj = await env.LIBRARY.get(keyFor(user, r.doc_id, `ocr/${r.n}.jpg`));
      if (obj) {
        const bytes = new Uint8Array(await obj.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const out = await ai.run(OCR_MODEL, { max_tokens: 1500, messages: [{ role: 'user', content: [
          { type: 'text', text: 'Transcribe every word of text on this page exactly, in reading order, keeping headings, bullet points and table rows (cells separated by " | "). Text only, no commentary. If there is no text, answer NONE.' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${btoa(bin)}` } }] }] });
        text = String((out && (out.response || out.result || out.text)) || '').trim();
        if (/^none\.?$/i.test(text)) text = '';
      }
    } catch (e) {
      console.error('library: OCR failed', e && e.message);
      done.push(await ocrFailed(env, user, r, now, e));
      continue;
    }
    const chunk = chunkDocument([{ n: r.n, text, kind: 'ocr' }]);
    const pageText = chunk.pages[0] ? chunk.pages[0].text : '';
    const top = await env.DB.prepare(`SELECT coalesce(max(seq), -1) AS s FROM library_passages WHERE user_id = ?1 AND doc_id = ?2`).bind(user, r.doc_id).first();
    const list = chunk.passages.map((p, i) => ({ ...p, seq: (top.s ?? -1) + 1 + i, kind: 'ocr' }));
    const stmts = [env.DB.prepare(`UPDATE library_pages SET text = ?4, chars = ?5, kind = ?6, ocr_state = 'done' WHERE user_id = ?1 AND doc_id = ?2 AND n = ?3`)
      .bind(user, r.doc_id, r.n, pageText, pageText.length, pageText.trim() ? 'ocr' : 'empty'),
      env.DB.prepare(`DELETE FROM sync_state WHERE user_id = ?1 AND source = ?2`).bind(user, ocrPageSource(r.doc_id, r.n))];
    if (list.length) {
      stmts.push(env.DB.prepare(`INSERT INTO library_passages (user_id, doc_id, seq, page, page_to, heading, kind, text, char_start, char_end, tokens, vec_state, linked, created_at)
        SELECT ?1, ?2, json_extract(j.value, '$.seq'), json_extract(j.value, '$.page'), json_extract(j.value, '$.page_to'), json_extract(j.value, '$.heading'), 'ocr',
          json_extract(j.value, '$.text'), json_extract(j.value, '$.char_start'), json_extract(j.value, '$.char_end'), json_extract(j.value, '$.tokens'), 0, 0, ?3
        FROM json_each(?4) j WHERE true`).bind(user, r.doc_id, now, JSON.stringify(list)));
      stmts.push(env.DB.prepare(`INSERT INTO library_fts (rowid, heading, text) SELECT pid, coalesce(heading, ''), text FROM library_passages
        WHERE user_id = ?1 AND doc_id = ?2 AND seq >= ?3`).bind(user, r.doc_id, list[0].seq));
      stmts.push(env.DB.prepare(`UPDATE library_docs SET status = 'indexing', n_passages = n_passages + ?3, n_ocr = n_ocr + 1, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`)
        .bind(user, r.doc_id, list.length, now));
    }
    await env.DB.batch(stmts);
    done.push({ doc_id: r.doc_id, n: r.n, passages: list.length });
  }
  await env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at) VALUES (?1, 'library.ocr', ?2, ?3)
    ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at`).bind(user, `${day}:${used}`, now).run();
  return { ocr: done };
}

// A failed read (Workers AI busy, a timeout): the page stays pending until its next try, or after OCR_MAX_TRIES is
// 'failed', and the document's status_note counts the pages that could not be read.
async function ocrFailed(env, user, r, now, e) {
  const tries = (Number(r.fails) || 0) + 1;
  const last = tries >= OCR_MAX_TRIES;
  const nextAt = last ? null : now + ocrRetryMs(tries);
  const stmts = [
    env.DB.prepare(`UPDATE library_pages SET ocr_state = ?4 WHERE user_id = ?1 AND doc_id = ?2 AND n = ?3`).bind(user, r.doc_id, r.n, last ? 'failed' : 'pending'),
    env.DB.prepare(`INSERT INTO sync_state (user_id, source, next_at, fails, last_error) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (user_id, source) DO UPDATE SET next_at = excluded.next_at, fails = excluded.fails, last_error = excluded.last_error`)
      .bind(user, ocrPageSource(r.doc_id, r.n), nextAt, tries, cut(String((e && e.message) || e || 'OCR failed'), 300)),
  ];
  if (last) {
    const failed = `(SELECT count(*) FROM library_pages g WHERE g.user_id = ?1 AND g.doc_id = ?2 AND g.ocr_state = 'failed')`;
    stmts.push(env.DB.prepare(`UPDATE library_docs SET status_note = ${failed} || CASE WHEN ${failed} = 1 THEN ' page' ELSE ' pages' END
        || ' could not be read (text recognition failed ${OCR_MAX_TRIES} times), so search skips them. Index again to try them again.', updated_at = ?3
      WHERE user_id = ?1 AND id = ?2 AND status IN ('indexing', 'ready')`).bind(user, r.doc_id, now));
  }
  await env.DB.batch(stmts);
  return { doc_id: r.doc_id, n: r.n, failed: true, tries, ...(last ? { gave_up: true } : { retry_at: nextAt }) };
}

async function embedStep(env, user, ai, limit = EMBED_STEP) {
  const rows = (await env.DB.prepare(`SELECT pid, doc_id, heading, text FROM library_passages WHERE user_id = ?1 AND vec_state = 0 ORDER BY pid LIMIT ?2`).bind(user, limit).all()).results || [];
  if (!rows.length) return null;
  if (!ai) return { embedded: 0, skipped: 'Workers AI is not bound' };
  const vecs = await embedMany(ai, rows.map(passageText));
  const sent = await vectorizeUpsert(env, user, rows.map((r, i) => ({ pid: r.pid, doc_id: r.doc_id, values: vecs[i] })));
  const data = rows.map((r, i) => ({ pid: r.pid, ...quantise(vecs[i]) }));
  const stmts = [];
  for (let k = 0; k < data.length; k += 150) {
    stmts.push(env.DB.prepare(`UPDATE library_passages SET vec = (SELECT json_extract(j.value, '$.q') FROM json_each(?2) j WHERE json_extract(j.value, '$.pid') = library_passages.pid),
        vec_scale = (SELECT json_extract(j.value, '$.scale') FROM json_each(?2) j WHERE json_extract(j.value, '$.pid') = library_passages.pid), vec_state = ?3
      WHERE user_id = ?1 AND pid IN (SELECT json_extract(value, '$.pid') FROM json_each(?2))`).bind(user, JSON.stringify(data.slice(k, k + 150)), sent ? 2 : 1));
  }
  await env.DB.batch(stmts);
  return { embedded: rows.length, vectorize: sent };
}

// Vectors only D1 has (Vectorize was down, or the index was made after them) go to Vectorize; no AI call.
async function resyncStep(env, user) {
  if (!vectorizeOn(env)) return null;
  const rows = (await env.DB.prepare(`SELECT pid, doc_id, vec, vec_scale FROM library_passages WHERE user_id = ?1 AND vec_state = 1 ORDER BY pid LIMIT ?2`).bind(user, RESYNC_STEP).all()).results || [];
  if (!rows.length) return null;
  const ok = await vectorizeUpsert(env, user, rows.map(r => ({ pid: r.pid, doc_id: r.doc_id, values: dequantise(r.vec, r.vec_scale) })));
  if (ok) await env.DB.prepare(`UPDATE library_passages SET vec_state = 2 WHERE user_id = ?1 AND pid IN (SELECT value FROM json_each(?2))`).bind(user, JSON.stringify(rows.map(r => r.pid))).run();
  return ok ? { resynced: rows.length } : null;
}

async function topicsFor(env, user) {
  const [t, a, e] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, short_name FROM topics WHERE user_id = ?1 AND status IN ${LIVE}`).bind(user),
    env.DB.prepare(`SELECT a.alias, a.kind, a.topic_id FROM topic_aliases a JOIN topics t ON t.user_id = a.user_id AND t.id = a.topic_id AND t.status IN ${LIVE}
      WHERE a.user_id = ?1 AND a.status = 'active' AND length(a.alias) <= 80`).bind(user),
    env.DB.prepare(`SELECT e.topic_id, e.vec, e.scale FROM topic_embeddings e JOIN topics t ON t.user_id = e.user_id AND t.id = e.topic_id AND t.status IN ${LIVE}
      WHERE e.user_id = ?1 AND e.model = ?2`).bind(user, EMBED_MODEL),
  ]);
  const vecRows = e.results || [];
  const ids = [], mat = new Float32Array(vecRows.length * EMBED_DIMS);
  let k = 0;
  for (const r of vecRows) {
    const v = dequantise(r.vec, r.scale);
    if (!v || v.length !== EMBED_DIMS) continue;
    mat.set(v, k * EMBED_DIMS); ids.push(r.topic_id); k++;
  }
  return { matcher: topicMatcher(t.results || [], a.results || []), ids, mat: mat.subarray(0, k * EMBED_DIMS) };
}

async function linkStep(env, user, now, limit = LINK_STEP) {
  const rows = (await env.DB.prepare(`SELECT pid, heading, text, vec, vec_scale FROM library_passages WHERE user_id = ?1 AND linked = 0 AND vec_state >= 1 ORDER BY pid LIMIT ?2`)
    .bind(user, limit).all()).results || [];
  if (!rows.length) return null;
  let topics;
  try { topics = await topicsFor(env, user); } catch (e) { if (!noTable(e)) throw e; topics = { matcher: topicMatcher([], []), ids: [], mat: new Float32Array(0) }; }
  const links = [];
  for (const r of rows) {
    const byMatch = matchTopics(topics.matcher, r);
    const v = r.vec ? dequantise(r.vec, r.vec_scale) : null;
    const byVec = v && topics.ids.length ? vectorTopics(v, topics.ids, topics.mat) : new Map();
    for (const l of combineLinks(byMatch, byVec)) links.push({ pid: r.pid, t: l.topic_id, s: l.score, m: l.method });
  }
  const stmts = [];
  for (let k = 0; k < links.length; k += 400) {
    stmts.push(env.DB.prepare(`INSERT INTO library_links (user_id, topic_id, pid, score, method, updated_at)
      SELECT ?1, json_extract(j.value, '$.t'), json_extract(j.value, '$.pid'), json_extract(j.value, '$.s'), json_extract(j.value, '$.m'), ?2 FROM json_each(?3) j WHERE true
      ON CONFLICT (user_id, topic_id, pid) DO UPDATE SET score = max(library_links.score, excluded.score), updated_at = excluded.updated_at
        WHERE library_links.method != 'search'`).bind(user, now, JSON.stringify(links.slice(k, k + 400))));
  }
  stmts.push(env.DB.prepare(`UPDATE library_passages SET linked = 1 WHERE user_id = ?1 AND pid IN (SELECT value FROM json_each(?2))`).bind(user, JSON.stringify(rows.map(r => r.pid))));
  await env.DB.batch(stmts);
  return { linked: rows.length, links: links.length, topics: topics.ids.length };
}

// When the map's topics change (new topics, new aliases, new embeddings), every passage is linked again, at most
// every RELINK_MS: the signature is the topics', aliases' and topic vectors' counts and newest change.
export const RELINK_MS = 6 * 3600_000;
async function relinkStep(env, user, now) {
  const sig = await env.DB.prepare(`SELECT (SELECT count(*) || ':' || coalesce(max(updated_at), 0) FROM topics WHERE user_id = ?1 AND status IN ${LIVE}) || '|' ||
      (SELECT count(*) FROM topic_aliases WHERE user_id = ?1 AND status = 'active') || '|' ||
      (SELECT count(*) || ':' || coalesce(max(updated_at), 0) FROM topic_embeddings WHERE user_id = ?1) AS s`).bind(user).first().catch(e => { if (noTable(e)) return null; throw e; });
  if (!sig || !sig.s) return null;
  const st = await env.DB.prepare(`SELECT cursor, last_ok_at FROM sync_state WHERE user_id = ?1 AND source = 'library.links'`).bind(user).first();
  if (st && st.cursor === sig.s) return null;
  const write = env.DB.prepare(`INSERT INTO sync_state (user_id, source, cursor, last_ok_at) VALUES (?1, 'library.links', ?2, ?3)
    ON CONFLICT (user_id, source) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at`).bind(user, sig.s, now);
  if (st && st.last_ok_at && now - st.last_ok_at < RELINK_MS) return null;
  const r = await env.DB.batch([env.DB.prepare(`UPDATE library_passages SET linked = 0 WHERE user_id = ?1 AND vec_state >= 1`).bind(user), write]);
  return { relink: (r[0].meta && r[0].meta.changes) || 0 };
}

async function finishDocs(env, user, now) {
  const r = await env.DB.batch([
    env.DB.prepare(`UPDATE library_docs SET
        n_embedded = (SELECT count(*) FROM library_passages p WHERE p.user_id = library_docs.user_id AND p.doc_id = library_docs.id AND p.vec_state >= 1),
        n_linked = (SELECT count(*) FROM library_passages p WHERE p.user_id = library_docs.user_id AND p.doc_id = library_docs.id AND p.linked = 1),
        updated_at = ?2
      WHERE user_id = ?1 AND status = 'indexing'`).bind(user, now),
    env.DB.prepare(`UPDATE library_docs SET status = 'ready', updated_at = ?2 WHERE user_id = ?1 AND status = 'indexing' AND n_embedded >= n_passages AND n_linked >= n_passages
        AND NOT EXISTS (SELECT 1 FROM library_pages g WHERE g.user_id = library_docs.user_id AND g.doc_id = library_docs.id AND g.ocr_state = 'pending')`).bind(user, now),
  ]);
  const n = (r[1] && r[1].meta && r[1].meta.changes) || 0;
  return n ? { ready: n } : null;
}

async function coverStep(env, user, ai, now, n = COVER_STEP) {
  const stamp = await libraryStamp(env, user);
  if (!stamp) return null;
  const any = await env.DB.prepare(`SELECT 1 AS x FROM library_docs WHERE user_id = ?1 AND status = 'ready' LIMIT 1`).bind(user).first();
  if (!any) return null;
  const rows = (await env.DB.prepare(`SELECT t.id FROM topics t LEFT JOIN library_coverage c ON c.user_id = t.user_id AND c.topic_id = t.id
      WHERE t.user_id = ?1 AND t.status IN ${LIVE} AND (c.topic_id IS NULL OR c.lib_at != ?2) ORDER BY c.topic_id IS NOT NULL, coalesce(t.yield, 0) DESC, t.id LIMIT ?3`)
    .bind(user, stamp, n).all()).results || [];
  if (!rows.length) return null;
  const built = [];
  for (const r of rows) {
    const b = await buildCoverage(env, user, r.id, { now, ai });
    built.push({ topic_id: r.id, n: b.n });
  }
  return { covered: built.length, topics: built };
}

/**
 * One step of the Library's background work for a user (the minute cron and the upload kick). Never throws: an
 * error is logged, recorded in sync_state 'library' and retried with back-off.
 */
export async function libraryJob(env, user, { now = Date.now(), ai = env.AI, cover = true } = {}) {
  let st = null;
  try {
    st = await env.DB.prepare(`SELECT next_at, fails FROM sync_state WHERE user_id = ?1 AND source = '${SOURCE}'`).bind(user).first();
    const has = await env.DB.prepare(`SELECT count(*) AS n FROM library_docs WHERE user_id = ?1`).bind(user).first();
    if (!has || !has.n) return { skipped: 'empty library' };
  } catch (e) {
    if (noTable(e)) return { skipped: 'no library yet' };
    throw e;
  }
  if (st && st.next_at && st.next_at > now) return { skipped: 'backing off' };
  // One step at a time per user (the cron, an upload's kick and POST /api/library/run can overlap): a 90 s lock.
  const lock = await env.DB.prepare(`INSERT INTO sync_state (user_id, source, lock_until) VALUES (?1, 'library.lock', ?2)
      ON CONFLICT (user_id, source) DO UPDATE SET lock_until = excluded.lock_until WHERE sync_state.lock_until < ?3`).bind(user, now + 90_000, now).run();
  if (!(lock.meta && lock.meta.changes)) return { skipped: 'another step is running' };
  const unlock = () => env.DB.prepare(`UPDATE sync_state SET lock_until = 0 WHERE user_id = ?1 AND source = 'library.lock'`).bind(user).run().catch(() => {});
  try { return await steps(env, user, { now, ai, cover, st }); } finally { await unlock(); }
}

async function steps(env, user, { now, ai, cover, st }) {
  const fails = Number(st && st.fails) || 0;
  const record = (ok, error = null) => env.DB.prepare(`INSERT INTO sync_state (user_id, source, last_ok_at, next_at, fails, last_error) VALUES (?1, '${SOURCE}', ?2, ?3, ?4, ?5)
      ON CONFLICT (user_id, source) DO UPDATE SET last_ok_at = coalesce(excluded.last_ok_at, sync_state.last_ok_at), next_at = excluded.next_at,
        fails = excluded.fails, last_error = excluded.last_error`)
    .bind(user, ok ? now : null, ok ? null : now + Math.min(30 * 60_000, 60_000 * 2 ** fails), ok ? 0 : fails + 1, error ? cut(String(error), 300) : null).run().catch(() => {});
  try {
    const out = {};
    // Reading picture-only pages comes after the text is searchable: a slow or failing vision call once held every
    // step, and 13,000 passages waited behind 18 cover pages (25 Oct). A page read later is embedded on the next turn.
    const steps = [
      ['index', () => pendingIndex(env, user, now)],
      ['embed', () => embedStep(env, user, ai)],
      ['resync', () => resyncStep(env, user)],
      ['link', () => linkStep(env, user, now)],
      ['ocr', () => ocrStep(env, user, now, ai)],
      ['finish', () => finishDocs(env, user, now)],
    ];
    for (const [name, run] of steps) {
      const r = await run();
      if (r) out[name] = r;
      if (r && name !== 'finish' && name !== 'resync') break;
    }
    if (!out.index && !out.ocr && !out.embed && !out.link) {
      const f = await finishDocs(env, user, now);
      if (f) out.finish = f;
      const rl = await relinkStep(env, user, now);
      if (rl) { out.relink = rl; return out; }
      if (cover && ai) { const c = await coverStep(env, user, ai, now); if (c) out.cover = c; }
    }
    if (fails) await record(true);
    return Object.keys(out).length ? out : { idle: true };
  } catch (e) {
    console.error('library job failed', (e && e.stack) || e);
    await record(false, e && e.message);
    return { error: (e && e.message) || String(e) };
  }
}

/** Runs steps until the library has nothing left or the time is up (the upload's waitUntil and POST /api/library/run). */
export async function libraryRun(env, user, { ms = 20_000, now = Date.now, ai = env.AI, cover = true } = {}) {
  const t0 = Date.now();
  const log = [];
  while (Date.now() - t0 < ms) {
    const r = await libraryJob(env, user, { now: now(), ai, cover });
    log.push(r);
    if (r.skipped === 'another step is running') { await new Promise(res => setTimeout(res, 1500)); continue; }
    if (r.idle || r.skipped || r.error || (r.embed && r.embed.skipped)) break;
  }
  return { steps: log.length, last: log[log.length - 1] || null, ms: Date.now() - t0 };
}
