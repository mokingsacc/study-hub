import { ankiCall, AnkiError } from '../anki.js';
import { HttpError, json, readJson, londonDay } from '../util.js';
import { norm, userKey } from '../../../public/js/shared/names.js';
import { writeBatch, summaryOf, rand } from './events.js';
import { unitRow, unitUpsertStatements, unitQueueRow } from './topics.js';
import { capContext } from './queue.js';
import { looksLikeQuestionBank, ambossUrlOk } from './guard.js';
import { pageKind, joinParts, sha256Hex, STEPS, MAX_ROWS } from './onenote-parse.js';

export const FETCH_TIMEOUT_MS = 45_000;
export const THROTTLE_PAUSE_S = 3600;
const PAGE_ID = /^[0-9A-Za-z!._-]{1,200}$/;
const FETCH_ID = /^f_[a-z0-9]{6,32}$/;
const SHA = /^[0-9a-f]{64}$/;
const UNIT_ID = /^(u\d{3}|x-[a-z0-9-]{1,60})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['checklist', 'tally', 'contents'];
const QUESTION_ID = /\bUW(orld)?\s?#?\d{4,6}\b|\bNBME\s?\d+\s?Q\d+\b/i;
const UNIT_KEYS = new Set(['id', 'num', 'kind', 'name', 'heading', 'lane', 'mehlman_rank', 'checklist_system', 'checklist_order', 'category_id',
  'onenote_section', 'onenote_page_id', 'onenote_object_id', 'onenote_link', 'coverage_json', 'nbme_images', 'notes_gap', 'source_ref', 'tally']);
// Unit columns compared on a re-import (what unitUpsertStatements writes), and those that move a topic's yield.
const UNIT_COMPARE = ['num', 'kind', 'name', 'heading', 'lane', 'mehlman_rank', 'checklist_system', 'checklist_order', 'category_id', 'onenote_section',
  'onenote_page_id', 'onenote_object_id', 'onenote_link', 'coverage_json', 'nbme_images', 'notes_gap'];
const YIELD_FIELDS = ['lane', 'mehlman_rank', 'nbme_images'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const bad = msg => { throw new HttpError(400, msg); };
const same = (a, b) => String(a ?? '') === String(b ?? '');
const inList = (n = 1) => `(SELECT value FROM json_each(?${n}))`;

// ---------------------------------------------------------------- the page list

export async function refreshPages(env, user, { now = Date.now() } = {}) {
  let reply;
  try { reply = await ankiCall(env, 'onenote_topics', {}, { timeoutMs: FETCH_TIMEOUT_MS }); } catch (e) { throw ankiHttp(e); }
  const topics = Array.isArray(reply && reply.topics) ? reply.topics : null;
  if (!topics) throw new HttpError(502, 'The Anki server sent no OneNote page list.');
  const rows = topics.filter(t => t && typeof t.page_id === 'string' && PAGE_ID.test(t.page_id))
    .map((t, i) => ({ page_id: t.page_id, title: String(t.title ?? '').slice(0, 200), section: String(t.section ?? '').slice(0, 120), kind: pageKind(t), sort: i + 1 }));
  if (rows.length) {
    await env.DB.batch([env.DB.prepare(`INSERT INTO onenote_pages (user_id, page_id, title, section, kind, sort, updated_at)
      SELECT ?1, json_extract(value, '$.page_id'), json_extract(value, '$.title'), json_extract(value, '$.section'), json_extract(value, '$.kind'),
        json_extract(value, '$.sort'), ?2 FROM json_each(?3) WHERE true
      ON CONFLICT (user_id, page_id) DO UPDATE SET title = excluded.title, section = excluded.section, kind = excluded.kind, sort = excluded.sort,
        updated_at = excluded.updated_at`).bind(user, now, JSON.stringify(rows))]);
  }
  return { listed: rows.length, pages: await ledger(env, user) };
}

const LEDGER_COLS = 'page_id, title, section, kind, parts, pictures, content_sha, prev_sha, fetch_status, next_part, fetched_at, parsed_at, parser_version, counts_json, error, fetch_id, parsed_fetch_id, sort';
async function ledger(env, user) {
  const rows = (await env.DB.prepare(`SELECT ${LEDGER_COLS} FROM onenote_pages WHERE user_id = ? ORDER BY sort, page_id`).bind(user).all()).results || [];
  return rows.map(r => ({ ...r, counts: parse(r.counts_json, {}), counts_json: undefined }));
}

// ---------------------------------------------------------------- one part

// An Anki server failure as the driver should see it: 410 for a page Graph no longer has, 429 for a throttle.
const isDead = msg => /20102|does not exist|not found|\b404\b/i.test(msg);
const isThrottle = msg => /\b429\b|throttl|too many requests|rate limit/i.test(msg);
function ankiHttp(e) {
  if (!(e instanceof AnkiError)) return e;
  const msg = String(e.message || '');
  if (isThrottle(msg)) return Object.assign(new HttpError(429, 'OneNote is throttling the Anki server; wait an hour before the next fetch.'), { throttled: true });
  return new HttpError(502, msg.slice(0, 300) || 'The Anki server failed.');
}

export async function fetchPart(env, user, body, { now = Date.now() } = {}) {
  const pageId = body && body.page_id;
  if (typeof pageId !== 'string' || !PAGE_ID.test(pageId)) bad('page_id is the OneNote page id from the page list.');
  const part = body.part;
  if (!Number.isInteger(part) || part < 1 || part > 400) bad('part is a whole number from 1.');
  const row = await env.DB.prepare(`SELECT ${LEDGER_COLS} FROM onenote_pages WHERE user_id = ? AND page_id = ?`).bind(user, pageId).first();
  if (!row) throw new HttpError(404, 'That page is not in the OneNote list yet; refresh the page list first.');
  if (row.fetch_status === 'dead') throw Object.assign(new HttpError(410, `${row.title || 'That page'} no longer exists in OneNote.`), { dead: true });
  let fetchId = body.fetch_id ?? null;
  if (fetchId != null && (typeof fetchId !== 'string' || !FETCH_ID.test(fetchId))) bad('fetch_id is the one part 1 returned.');
  const fresh = part === 1 && fetchId == null;
  if (fresh) fetchId = `f_${now.toString(36)}${rand().slice(0, 6)}`;
  else if (fetchId == null) bad('Parts after the first need the fetch_id part 1 returned.');
  else if (fetchId !== row.fetch_id) throw new HttpError(409, 'That fetch is no longer the one under way; start again from part 1.');

  let reply;
  try {
    reply = await ankiCall(env, 'onenote_page_source', { page: pageId, part }, { timeoutMs: FETCH_TIMEOUT_MS });
  } catch (e) {
    const msg = String((e && e.message) || '');
    if (e instanceof AnkiError && isDead(msg)) {
      await env.DB.prepare(`UPDATE onenote_pages SET fetch_status = 'dead', error = ?3, updated_at = ?4 WHERE user_id = ?1 AND page_id = ?2`)
        .bind(user, pageId, msg.slice(0, 300), now).run();
      throw Object.assign(new HttpError(410, `${row.title || 'That page'} no longer exists in OneNote.`), { dead: true });
    }
    const h = ankiHttp(e);
    if (h instanceof HttpError) {
      await env.DB.prepare(`UPDATE onenote_pages SET error = ?3, updated_at = ?4 WHERE user_id = ?1 AND page_id = ?2`).bind(user, pageId, h.message.slice(0, 300), now).run();
    }
    throw h;
  }
  const html = reply && reply.html;
  const parts = reply && reply.parts;
  if (typeof html !== 'string' || !Number.isInteger(parts) || parts < 1) throw new HttpError(502, 'The Anki server sent a page part without its HTML.');
  if (part > parts) throw new HttpError(400, `${row.title || 'That page'} has only ${parts} parts.`);
  const pictures = Number.isInteger(reply.pictures) ? reply.pictures : null;
  const done = part === parts;
  const stmts = [];
  if (fresh) {
    stmts.push(env.DB.prepare(`DELETE FROM onenote_parts WHERE user_id = ?1 AND page_id = ?2 AND fetch_id != ?3 AND fetch_id != coalesce(?4, '')`)
      .bind(user, pageId, fetchId, row.parsed_fetch_id ?? null));
  }
  stmts.push(env.DB.prepare(`INSERT INTO onenote_parts (user_id, page_id, fetch_id, part, html, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT (user_id, page_id, fetch_id, part) DO UPDATE SET html = excluded.html, fetched_at = excluded.fetched_at`)
    .bind(user, pageId, fetchId, part, html, now));
  stmts.push(env.DB.prepare(`UPDATE onenote_pages SET title = coalesce(?3, title), section = coalesce(?4, section), parts = ?5, pictures = coalesce(?6, pictures),
      fetch_id = ?7, fetch_status = ?8, next_part = ?9, fetched_at = CASE WHEN ?10 THEN ?11 ELSE fetched_at END, error = NULL, updated_at = ?11
      WHERE user_id = ?1 AND page_id = ?2`)
    .bind(user, pageId, typeof reply.title === 'string' ? reply.title.slice(0, 200) : null, typeof reply.section === 'string' ? reply.section.slice(0, 120) : null,
      parts, pictures, fetchId, done ? 'fetched' : 'fetching', done ? parts + 1 : part + 1, done ? 1 : 0, now));
  await env.DB.batch(stmts);
  return { page_id: pageId, title: reply.title ?? row.title, section: reply.section ?? row.section, part, parts, pictures, html, fetch_id: fetchId };
}

// ---------------------------------------------------------------- the import

const str = (v, max, name, { required = false } = {}) => {
  if (v == null || v === '') { if (required) bad(`${name} is needed.`); return null; }
  if (typeof v !== 'string' || v.length > max) bad(`${name} is text of at most ${max} characters.`);
  return v;
};
const intOrNull = (v, name) => { if (v == null) return null; if (!Number.isInteger(v) || v < 0 || v > 100000) bad(`${name} is a whole number.`); return v; };
const textOk = (s, what) => { if (s && (QUESTION_ID.test(s) || looksLikeQuestionBank(s))) bad(`${what} looks like question-bank text, so it is not imported.`); };

function checkCondition(c, where) {
  if (!isObj(c)) bad(`${where}: each condition is an object.`);
  const condition = str(c.condition, 120, `${where}: condition`, { required: true }).trim();
  textOk(condition, `${where}: "${condition.slice(0, 40)}"`);
  const url = str(c.amboss_url, 300, `${where}: amboss_url`);
  return { condition, amboss_url: url && ambossUrlOk(url) ? url : null, misses: intOrNull(c.misses, `${where}: misses`), last: c.last != null && DAY.test(String(c.last)) ? c.last : null };
}

/** The import body checked: every enum and length, at most MAX_ROWS rows. Throws HttpError(400). */
export function checkImportBody(body) {
  if (!isObj(body)) bad('The import body is an object.');
  const pages = body.pages;
  if (!Array.isArray(pages) || !pages.length || pages.length > 25) bad('pages lists 1 to 25 {page_id, fetch_id, content_sha}.');
  const seen = new Set();
  for (const p of pages) {
    if (!isObj(p) || typeof p.page_id !== 'string' || !PAGE_ID.test(p.page_id)) bad('Each page needs its page_id.');
    if (typeof p.fetch_id !== 'string' || !FETCH_ID.test(p.fetch_id)) bad('Each page needs the fetch_id its parts were stored under.');
    if (typeof p.content_sha !== 'string' || !SHA.test(p.content_sha)) bad('Each page needs the sha256 of its joined parts.');
    if (seen.has(p.page_id)) bad('Each page once.');
    seen.add(p.page_id);
  }
  if (!KINDS.includes(body.kind)) bad(`kind is ${KINDS.join(', ')}.`);
  if (!Number.isInteger(body.parser_version) || body.parser_version < 1 || body.parser_version > 1000) bad('parser_version is a whole number.');
  for (const k of ['units', 'ticks', 'labels', 'versus']) if (body[k] != null && !Array.isArray(body[k])) bad(`${k} is a list.`);
  const units = (body.units || []).map((u, i) => {
    if (!isObj(u)) bad(`Unit ${i + 1} is not an object.`);
    const extra = Object.keys(u).find(k => !UNIT_KEYS.has(k));
    if (extra) bad(`Unit ${u.id || i + 1}: unknown field ${extra}.`);
    if (typeof u.id !== 'string' || !UNIT_ID.test(u.id)) bad(`Unit ${i + 1}: id is 'u' and 3 digits, or 'x-<slug>'.`);
    for (const k of ['name', 'heading', 'checklist_system']) { str(u[k], 200, `Unit ${u.id}: ${k}`); textOk(u[k], `Unit ${u.id}'s ${k}`); }
    str(u.onenote_section, 120, `Unit ${u.id}: onenote_section`);
    str(u.onenote_page_id, 200, `Unit ${u.id}: onenote_page_id`);
    str(u.onenote_object_id, 60, `Unit ${u.id}: onenote_object_id`);
    str(u.source_ref, 200, `Unit ${u.id}: source_ref`);
    if (str(u.onenote_link, 1000, `Unit ${u.id}: onenote_link`) && !/^onenote:https:\/\//.test(u.onenote_link)) bad(`Unit ${u.id}: onenote_link is a onenote: link.`);
    if (u.coverage_json != null && JSON.stringify(u.coverage_json).length > 2000) bad(`Unit ${u.id}: coverage_json is too long.`);
    const tally = u.tally == null ? [] : Array.isArray(u.tally) && u.tally.length <= 40 ? u.tally.map(c => checkCondition(c, `Unit ${u.id}`)) : bad(`Unit ${u.id}: tally lists at most 40 conditions.`);
    const { tally: _t, ...rest } = u;
    return { unit: rest, tally };
  });
  const ticks = (body.ticks || []).map(t => {
    if (!isObj(t) || typeof t.unit_id !== 'string' || !UNIT_ID.test(t.unit_id)) bad('Each tick names its unit_id.');
    if (!['done', ...STEPS].includes(t.step)) bad(`A tick's step is done or one of ${STEPS.join(', ')}.`);
    const ref = str(t.source_ref, 60, 'A tick\'s source_ref', { required: true });
    if (!/^(done|mastery)-[A-Za-z0-9-]+$/.test(ref)) bad("A tick's source_ref is its OneNote data-id ('done-001', 'mastery-U001-b2').");
    return { unit_id: t.unit_id, step: t.step, source_ref: ref };
  });
  const labels = (body.labels || []).map((l, i) => {
    if (!isObj(l)) bad(`Label ${i + 1} is not an object.`);
    const c = checkCondition(l, `Label ${i + 1}`);
    const unit_hint = str(l.unit_hint, 200, `Label ${i + 1}: unit_hint`);
    textOk(unit_hint, `Label ${i + 1}'s unit_hint`);
    return { ...c, system: str(l.system, 80, `Label ${i + 1}: system`), category_id: str(l.category_id, 80, `Label ${i + 1}: category_id`), unit_hint };
  });
  const versus = (body.versus || []).map(v => {
    if (!isObj(v) || !Number.isInteger(v.n) || v.n < 1 || v.n > 99) bad('Each Rapid differential has its number n.');
    const t = str(v.text, 200, `Rapid ${v.n}: text`, { required: true });
    textOk(t, `Rapid ${v.n}`);
    if (!Array.isArray(v.pairs) || !v.pairs.length || v.pairs.length > 20) bad(`Rapid ${v.n}: pairs lists 1 to 20 pairs.`);
    const pairs = v.pairs.map(p => (Array.isArray(p) && p.length === 2 && p.every(x => typeof x === 'string' && x.trim() && x.length <= 80) ? p.map(x => x.trim()) : bad(`Rapid ${v.n}: each pair is two names.`)));
    return { n: v.n, text: t, pairs };
  });
  if (body.counts != null && (!isObj(body.counts) || JSON.stringify(body.counts).length > 2000)) bad('counts is a small object.');
  const rows = units.length * 2 + ticks.length * STEPS.length + labels.length + versus.length;
  if (rows > MAX_ROWS) bad(`At most ${MAX_ROWS} rows per import call (this one has ${rows}); the driver splits them.`);
  return { pages, kind: body.kind, parser_version: body.parser_version, units, ticks, labels, versus, counts: body.counts || null, final: body.final === true };
}

// The stored parts of each page checked against the sha256 the driver parsed: throws HttpError(409) on a mismatch.
async function verifyPages(pages, ledgerRows, partRows, kind) {
  const byPage = new Map(ledgerRows.map(r => [r.page_id, r]));
  const parts = new Map();
  for (const r of partRows) {
    const k = `${r.page_id}|${r.fetch_id}`;
    if (!parts.has(k)) parts.set(k, []);
    parts.get(k).push(r);
  }
  for (const p of pages) {
    const row = byPage.get(p.page_id);
    if (!row) throw new HttpError(404, `Page ${p.page_id.slice(0, 24)}… is not in the OneNote list.`);
    if (row.fetch_status === 'dead') throw new HttpError(410, `${row.title || 'That page'} no longer exists in OneNote.`);
    const list = (parts.get(`${p.page_id}|${p.fetch_id}`) || []).sort((a, b) => a.part - b.part);
    if (!list.length) throw new HttpError(409, `No parts of ${row.title || 'that page'} are stored under that fetch; fetch it again.`);
    if (list.some((x, i) => x.part !== i + 1)) throw new HttpError(409, `A part of ${row.title || 'that page'} is missing; fetch it again.`);
    if (kind !== 'contents' && row.parts && list.length !== row.parts) throw new HttpError(409, `Only ${list.length} of the ${row.parts} parts of ${row.title || 'that page'} are stored.`);
    if (await sha256Hex(joinParts(list)) !== p.content_sha) throw new HttpError(409, `${row.title || 'That page'} changed since it was parsed; fetch and parse it again.`);
  }
  return byPage;
}

const queueInsert = (env, rows, onConflict) => env.DB.prepare(`INSERT INTO topic_queue (id, user_id, kind, label_norm, label_raw, context_json, candidates_json, refs, first_seen_at, last_seen_at, status)
    SELECT json_extract(value, '$.id'), json_extract(value, '$.user_id'), json_extract(value, '$.kind'), json_extract(value, '$.label_norm'), json_extract(value, '$.label_raw'),
      json_extract(value, '$.context_json'), json_extract(value, '$.candidates_json'), 1, json_extract(value, '$.first_seen_at'), json_extract(value, '$.last_seen_at'), 'open'
    FROM json_each(?1) WHERE true ${onConflict}`).bind(JSON.stringify(rows));
// Unit and Rapid items: an open item takes the new wording; one Claude settled is left as it is.
const REFRESH_OPEN = `ON CONFLICT (id) DO UPDATE SET label_raw = excluded.label_raw, label_norm = excluded.label_norm, context_json = excluded.context_json,
    last_seen_at = excluded.last_seen_at WHERE topic_queue.user_id = excluded.user_id AND topic_queue.status IN ('open','claimed')`;

function labelRow(user, l, now) {
  const key = norm(l.condition);
  return { id: userKey(user, `label:${key}`), user_id: user, kind: 'label', label_norm: key, label_raw: l.condition,
    context_json: JSON.stringify(capContext({ system: l.system, category_hint: l.category_id, unit_hint: l.unit_hint, amboss_url: l.amboss_url, source: 'onenote_tally', ref_label: 'Topic tally' })),
    candidates_json: '[]', first_seen_at: now, last_seen_at: now };
}
function versusRow(user, v, now) {
  const names = [...new Set(v.pairs.flat())];
  return { id: userKey(user, `versus:rapid-${v.n}`), user_id: user, kind: 'versus', label_norm: `onenote:checklist#rapid-${v.n}`, label_raw: v.text,
    context_json: JSON.stringify({ source: 'onenote', title: v.text, ref_label: `Rapid differentials ${v.n}`, names, pairs: v.pairs }),
    candidates_json: '[]', first_seen_at: now, last_seen_at: now };
}

const TITLE = { checklist: 'Master Checklist', tally: 'Topic tally', contents: 'System pages' };

export async function importPages(env, user, raw, { now = Date.now() } = {}) {
  const b = checkImportBody(raw);
  const unitRows = b.units.map(x => unitRow(x.unit));   // taxonomy's own check (category, lane override); throws 400
  const ids = new Set();
  for (const u of unitRows) { if (ids.has(u.id)) bad(`Unit ${u.id} is listed twice.`); ids.add(u.id); }
  const tallyOf = new Map(b.units.map(x => [x.unit.id, x.tally]));
  const queueRows = [
    ...b.units.map(x => ({ ...unitQueueRow(user, x.unit, { tally: x.tally, now }), refresh: true })),
    ...b.versus.map(v => ({ ...versusRow(user, v, now), refresh: true })),
    ...b.labels.map(l => ({ ...labelRow(user, l, now), refresh: false })),
  ];
  const tickRows = b.ticks.flatMap(t => (t.step === 'done' ? STEPS : [t.step]).map(step => ({ unit_id: t.unit_id, step, source_ref: t.source_ref })));

  const keys = b.pages.map(p => `${p.page_id}|${p.fetch_id}`);
  const unitIds = unitRows.map(u => u.id);
  const [lr, pr, ur, qr, utr] = await env.DB.batch([
    env.DB.prepare(`SELECT ${LEDGER_COLS} FROM onenote_pages WHERE user_id = ?2 AND page_id IN ${inList(1)}`).bind(JSON.stringify(b.pages.map(p => p.page_id)), user),
    env.DB.prepare(`SELECT page_id, fetch_id, part, html FROM onenote_parts WHERE user_id = ?2 AND (page_id || '|' || fetch_id) IN ${inList(1)} ORDER BY page_id, part`).bind(JSON.stringify(keys), user),
    env.DB.prepare(`SELECT id, ${UNIT_COMPARE.join(', ')}, locked_json FROM units WHERE user_id = ?2 AND id IN ${inList(1)}`).bind(JSON.stringify(unitIds), user),
    env.DB.prepare(`SELECT id, status, context_json, label_raw FROM topic_queue WHERE user_id = ?2 AND id IN ${inList(1)}`).bind(JSON.stringify(queueRows.map(q => q.id)), user),
    env.DB.prepare(`SELECT DISTINCT unit_id FROM unit_topics WHERE user_id = ?2 AND unit_id IN ${inList(1)}`).bind(JSON.stringify(unitIds), user),
  ]);
  const byPage = await verifyPages(b.pages, lr.results || [], pr.results || [], b.kind);

  const have = new Map((ur.results || []).map(r => [r.id, r]));
  const newUnits = [], changed = [], lockedKept = [], yieldUnits = [];
  const withTopics = new Set((utr.results || []).map(r => r.unit_id));
  for (const u of unitRows) {
    const cur = have.get(u.id);
    if (!cur) { newUnits.push(u.id); continue; }
    const locked = new Set(parse(cur.locked_json, []));
    const diff = UNIT_COMPARE.filter(c => !same(cur[c], u[c]));
    for (const c of diff.filter(c => locked.has(c))) lockedKept.push({ unit_id: u.id, field: c });
    const moved = diff.filter(c => !locked.has(c));
    if (moved.length) changed.push(u.id);
    if (moved.some(c => YIELD_FIELDS.includes(c)) && withTopics.has(u.id)) yieldUnits.push(u.id);
  }
  const haveQ = new Map((qr.results || []).map(r => [r.id, r]));
  const newQueue = queueRows.filter(q => !haveQ.has(q.id)).map(q => q.id);
  const refreshed = queueRows.filter(q => q.refresh && haveQ.has(q.id) && ['open', 'claimed'].includes(haveQ.get(q.id).status)
    && (haveQ.get(q.id).context_json !== q.context_json || haveQ.get(q.id).label_raw !== q.label_raw)).map(q => q.id);

  let newTicks = [], ticksSkipped = 0, tickEvidence = [];
  if (tickRows.length) {
    const tickUnits = JSON.stringify([...new Set(tickRows.map(t => t.unit_id))]);
    try {
      const [done, tt] = await env.DB.batch([
        env.DB.prepare(`SELECT unit_id, step FROM checklist_progress WHERE user_id = ?2 AND mastered = 1 AND unit_id IN ${inList(1)}`).bind(tickUnits, user),
        env.DB.prepare(`SELECT DISTINCT u.value AS unit_id, t.id, t.category_id FROM json_each(?1) u JOIN topics t ON t.user_id = ?2
            AND t.status IN ('proposed', 'confirmed') AND (t.unit_id = u.value
              OR t.id IN (SELECT topic_id FROM unit_topics WHERE user_id = ?2 AND unit_id = u.value AND role = 'primary'))`).bind(tickUnits, user),
      ]);
      const got = new Set((done.results || []).map(r => `${r.unit_id}|${r.step}`));
      newTicks = tickRows.filter(t => !got.has(`${t.unit_id}|${t.step}`));
      const topicsOf = new Map();
      for (const r of tt.results || []) (topicsOf.get(r.unit_id) || topicsOf.set(r.unit_id, []).get(r.unit_id)).push(r);
      const day = londonDay(now);
      tickEvidence = newTicks.flatMap(t => (topicsOf.get(t.unit_id) || []).map(tp => ({
        obs_key: `tick:${t.unit_id}:${t.step}:${tp.id}`, slot: 0, topic_id: tp.id, category_id: tp.category_id || null, kind: 'self_mastered',
        at: now, day, source: 'onenote', source_ref: t.source_ref, created_by: 'code' })));
    } catch (e) { if (!noTable(e)) throw e; ticksSkipped = tickRows.length; newTicks = []; tickEvidence = []; }
  }

  const ledgerSt = b.pages.map(p => env.DB.prepare(`UPDATE onenote_pages SET prev_sha = CASE WHEN content_sha IS NOT NULL AND content_sha != ?3 THEN content_sha ELSE prev_sha END,
      content_sha = ?3, parsed_at = ?4, parser_version = ?5, parsed_fetch_id = ?6, counts_json = coalesce(?7, counts_json), error = NULL, updated_at = ?4
      WHERE user_id = ?1 AND page_id = ?2`).bind(user, p.page_id, p.content_sha, now, b.parser_version, p.fetch_id, b.counts ? JSON.stringify(b.counts) : null));
  const counts = { units: unitRows.length, new_units: newUnits.length, updated_units: changed.length, locked_kept: lockedKept.length,
    queued: newQueue.length, queue_updated: refreshed.length, ticks: newTicks.length, ticks_skipped: ticksSkipped, tick_evidence: tickEvidence.length,
    labels: b.labels.length, versus: b.versus.length };
  const base = { ok: true, kind: b.kind, final: b.final, ...counts, locked: lockedKept.slice(0, 20) };
  if (!newUnits.length && !changed.length && !newQueue.length && !refreshed.length && !newTicks.length) {
    await env.DB.batch(ledgerSt);
    return { ...base, unchanged: true, seq: null, batch_id: null };
  }

  const statements = [...unitUpsertStatements(env, user, b.units.map(x => x.unit), { now })];
  const refresh = queueRows.filter(q => q.refresh).map(({ refresh: _r, ...q }) => q);
  const once = queueRows.filter(q => !q.refresh).map(({ refresh: _r, ...q }) => q);
  for (let i = 0; i < refresh.length; i += 150) statements.push(queueInsert(env, refresh.slice(i, i + 150), REFRESH_OPEN));
  for (let i = 0; i < once.length; i += 150) statements.push(queueInsert(env, once.slice(i, i + 150), 'ON CONFLICT (id) DO NOTHING'));
  if (newTicks.length) {
    statements.push(env.DB.prepare(`INSERT INTO checklist_progress (user_id, unit_id, step, mastered, mastered_at, source, source_ref, created_by, updated_at)
      SELECT ?1, json_extract(value, '$.unit_id'), json_extract(value, '$.step'), 1, ?2, 'onenote', json_extract(value, '$.source_ref'), 'code', ?2 FROM json_each(?3) WHERE true
      ON CONFLICT (user_id, unit_id, step) DO UPDATE SET mastered = 1, mastered_at = excluded.mastered_at, source = 'onenote', source_ref = excluded.source_ref,
        updated_at = excluded.updated_at WHERE checklist_progress.mastered = 0`).bind(user, now, JSON.stringify(newTicks)));
  }
  statements.push(...ledgerSt);
  const title = (byPage.get(b.pages[0].page_id) || {}).title || TITLE[b.kind];
  const placeN = newQueue.length;
  const summary = summaryOf(`${b.kind === 'contents' ? TITLE.contents : title}: ${unitRows.length} units (${newUnits.length} new${changed.length ? `, ${changed.length} changed` : ''}), `
    + `${newTicks.length} ticks, ${placeN} to place${lockedKept.length ? `; ${lockedKept.length} locked fields kept` : ''}${b.labels.length ? `; ${b.labels.length} conditions off the checklist` : ''}`);
  const event = { kind: 'onenote.imported', target_type: 'map', target_id: `onenote:${b.pages[0].page_id}`, topic_id: null, summary, before: null,
    after: { kind: b.kind, pages: b.pages.map(p => ({ page_id: p.page_id, content_sha: p.content_sha, fetch_id: p.fetch_id })), counts,
      new_units: newUnits, new_queue: newQueue, new_ticks: newTicks.map(t => `${t.unit_id}|${t.step}`), locked_kept: lockedKept.slice(0, 20) } };
  const w = await writeBatch(env, user, { actor: 'code', surface: 'code', via: 'onenote-import', statements, events: [event], undoable: true,
    ...(tickEvidence.length ? { evidence: { upsert: tickEvidence } } : {}) });

  let yieldRefreshed = 0;
  if (yieldUnits.length) {
    try {
      const { applyChange } = await import('./change.js');
      const r = await applyChange(env, user, { actor: 'code', surface: 'code', op: 'yield.refresh', args: { unit_ids: yieldUnits }, via: 'onenote-import' });
      if (r && r.ok) yieldRefreshed = yieldUnits.length;
    } catch (e) { console.error('onenote import: yield refresh failed', e && e.message); }
  }
  return { ...base, seq: w.seq, batch_id: w.batch_id, yield_refreshed: yieldRefreshed, tally_units: [...tallyOf.values()].filter(t => t.length).length };
}

export async function undoImport(env, user, ev) {
  const after = parse(ev && ev.after_json, null);
  if (!isObj(after)) return { conflict: "That import can't be undone automatically." };
  const units = Array.isArray(after.new_units) ? after.new_units : [];
  const queue = Array.isArray(after.new_queue) ? after.new_queue : [];
  const ticks = Array.isArray(after.new_ticks) ? after.new_ticks : [];
  const [ut, q] = await env.DB.batch([
    env.DB.prepare(`SELECT count(*) AS n FROM unit_topics WHERE user_id = ?2 AND unit_id IN ${inList(1)}`).bind(JSON.stringify(units), user),
    env.DB.prepare(`SELECT count(*) AS n FROM topic_queue WHERE user_id = ?2 AND id IN ${inList(1)} AND status NOT IN ('open','claimed')`).bind(JSON.stringify(queue), user),
  ]);
  if (((ut.results || [])[0] || {}).n || ((q.results || [])[0] || {}).n) {
    return { conflict: 'Topics have been placed from this import since; undo those first.' };
  }
  const statements = [
    env.DB.prepare(`DELETE FROM units WHERE user_id = ?2 AND id IN ${inList(1)}`).bind(JSON.stringify(units), user),
    // An item ingestion has since bumped (a miss now waits on the same label) stays.
    env.DB.prepare(`DELETE FROM topic_queue WHERE user_id = ?2 AND id IN ${inList(1)} AND status IN ('open','claimed') AND refs <= 1`).bind(JSON.stringify(queue), user),
  ];
  if (ticks.length) {
    statements.push(env.DB.prepare(`DELETE FROM checklist_progress WHERE user_id = ?2 AND (unit_id || '|' || step) IN ${inList(1)} AND source = 'onenote'`)
      .bind(JSON.stringify(ticks), user));
  }
  const rows = (Array.isArray(after.pages) ? after.pages : []).filter(p => p && typeof p.page_id === 'string')
    .map(p => ({ table: 'onenote_pages', op: 'update', key: { page_id: p.page_id }, before: { parsed_at: null }, after: { parsed_at: null } }));
  return { statements, rows };
}

// ---------------------------------------------------------------- status and raw parts

/** The ledger, stored parts per page and fetch, and the open queue by kind: one read batch, no HTML. */
export async function onenoteStatus(env, user) {
  let res;
  try {
    res = await env.DB.batch([
      env.DB.prepare(`SELECT ${LEDGER_COLS} FROM onenote_pages WHERE user_id = ? ORDER BY sort, page_id`).bind(user),
      env.DB.prepare(`SELECT page_id, fetch_id, count(*) AS parts, sum(length(html)) AS chars, max(fetched_at) AS fetched_at FROM onenote_parts WHERE user_id = ?
        GROUP BY page_id, fetch_id`).bind(user),
      env.DB.prepare(`SELECT kind, count(*) AS n FROM topic_queue WHERE user_id = ? AND status = 'open' GROUP BY kind`).bind(user),
    ]);
  } catch (e) { if (noTable(e)) throw new HttpError(409, 'The map tables are not there yet: apply migration 0010 first.'); throw e; }
  const stored = {};
  for (const r of res[1].results || []) (stored[r.page_id] || (stored[r.page_id] = [])).push({ fetch_id: r.fetch_id, parts: r.parts, chars: r.chars, fetched_at: r.fetched_at });
  const pages = (res[0].results || []).map(r => ({ ...r, counts: parse(r.counts_json, {}), counts_json: undefined, stored: stored[r.page_id] || [] }));
  return { pages, queue: Object.fromEntries((res[2].results || []).map(r => [r.kind, r.n])) };
}

/** The stored parts of one fetch, in order (the fetch under way when fetch_id is left out). */
export async function rawParts(env, user, pageId, fetchId = null) {
  if (typeof pageId !== 'string' || !PAGE_ID.test(pageId)) bad('page_id is the OneNote page id.');
  if (fetchId != null && !FETCH_ID.test(fetchId)) bad('fetch_id is the one part 1 returned.');
  const row = await env.DB.prepare('SELECT fetch_id, parsed_fetch_id, parts FROM onenote_pages WHERE user_id = ? AND page_id = ?').bind(user, pageId).first();
  if (!row) throw new HttpError(404, 'That page is not in the OneNote list.');
  const id = fetchId || row.fetch_id;
  if (!id) throw new HttpError(404, 'That page has not been fetched yet.');
  const parts = (await env.DB.prepare('SELECT part, html FROM onenote_parts WHERE user_id = ? AND page_id = ? AND fetch_id = ? ORDER BY part').bind(user, pageId, id).all()).results || [];
  return { page_id: pageId, fetch_id: id, parts_total: row.parts, parts };
}

// ---------------------------------------------------------------- import.start (map_import_start)

export const IMPORT_KINDS = ['seed', 'onenote'];
export const RUN_HOURS = 3, RUN_ROWS = 2000;

export async function planImportStart(env, user, args, ctx) {
  const extra = Object.keys(args || {}).find(k => !['kind', 'reason'].includes(k));
  if (extra) return { refuse: `Unknown argument ${extra}; give kind and reason.`, field: extra };
  if (!IMPORT_KINDS.includes(args.kind)) return { refuse: `kind is ${IMPORT_KINDS.join(' or ')}.`, field: 'kind' };
  if (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 200) return { refuse: 'reason says in up to 200 characters what the run is for.', field: 'reason' };
  const now = ctx.now || Date.now();
  const run_id = `r_${rand().slice(0, 12)}`;
  const expires_at = now + RUN_HOURS * 3600_000;
  let open = {};
  try {
    const rows = (await env.DB.prepare(`SELECT kind, count(*) AS n FROM topic_queue WHERE user_id = ? AND status = 'open' GROUP BY kind`).bind(user).all()).results || [];
    open = Object.fromEntries(rows.map(r => [r.kind, r.n]));
  } catch (e) { if (!noTable(e)) throw e; }
  const what = args.kind === 'onenote' ? 'the OneNote import' : 'seeding the map';
  return {
    rows: [],
    events: [{ kind: 'import.started', target_type: 'run', target_id: run_id, topic_id: null, summary: `Import run started for ${what} (3 hours, up to 2,000 rows)`,
      before: null, after: { run_id, kind: args.kind, reason: args.reason.trim(), expires_at, max_rows: RUN_ROWS } }],
    count: 1,
    summary: `Start an import run for ${what}`,
    ask: `Start an import run for ${what}? For the next 3 hours Claude can place up to 2,000 rows without asking each time.`,
    reply: { run_id, expires_at, max_rows: RUN_ROWS, open },
  };
}

// ---------------------------------------------------------------- routes

async function guarded(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof HttpError && (e.dead || e.throttled)) {
      return json({ error: e.message, ...(e.dead ? { dead: true } : {}), ...(e.throttled ? { throttled: true, retry_after_s: THROTTLE_PAUSE_S } : {}) }, e.status);
    }
    if (noTable(e)) throw new HttpError(409, 'The map tables are not there yet: apply migration 0010 first.');
    throw e;
  }
}
export const pagesRoute = (request, env, ctx, params, url, user) => guarded(async () => json(await refreshPages(env, user)));
export const fetchRoute = (request, env, ctx, params, url, user) => guarded(async () => json(await fetchPart(env, user, await readJson(request, 10_000))));
export const importRoute = (request, env, ctx, params, url, user) => guarded(async () => json(await importPages(env, user, await readJson(request, 3_000_000))));
export const statusRoute = (request, env, ctx, params, url, user) => guarded(async () => json(await onenoteStatus(env, user)));
export const rawRoute = (request, env, ctx, params, url, user) => guarded(async () => json(await rawParts(env, user, url.searchParams.get('page_id'), url.searchParams.get('fetch_id') || null)));
