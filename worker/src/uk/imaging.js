// The UK imaging lab (CONTRACT I34, DESIGN §15): findings and their pictures (0030_uk_labs.sql), keyed and private.
// Every route answers 404 unless UK is on (or import) and UK_LABS is "on" (or "import", the go-live upload step). Reads are one D1 batch; the only write to
// the tables is op uk_img.import through applyChange (undoable, page_only, refused for Claude). Pictures go up with
// the keyed PUT (JPEG, PNG or WebP up to 8 MB) into R2 under u/<user>/uk-imaging/<id>.<ext>; demo pictures are drawn
// in the page ("demo:<key>"), and demo rows are refused anywhere but a local dev server.
import { HttpError, json, readJson } from '../util.js';
import { applyChange, changeResponse } from '../map/change.js';
import { summaryOf } from '../map/events.js';
import { labsOn, labsRoutesOn } from './routes.js';

export { labsOn };
function gate(env) { if (!labsRoutesOn(env)) throw new HttpError(404, 'There is nothing at that address.'); }
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const MODALITIES = ['cxr', 'axr', 'ct_head', 'ct', 'mri', 'us', 'xr_msk'];
export const SOURCES = ['commons', 'nih_cxr14', 'mo', 'demo'];
export const SHAPES = ['ellipse', 'box', 'poly'];
export const MIMES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const MAX_BYTES = 8 * 1024 * 1024;
export const LIMITS = { findings: 60, media: 150, remove: 200, id: 80, title: 120, text: 400, signs: 12, versus: 8, uk: 6, sources: 8, aliases: 10, hotspots: 16, pts: 80, attribution: 300, licence: 60, url: 400 };
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const httpsUrl = u => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password; } catch { return false; } };
class Bad extends Error {}
function need(ok, msg) { if (!ok) throw new Bad(msg); }
function str(v, max, what, { required = true } = {}) {
  const s = text(v);
  need(!required || s, `${what} is missing.`);
  need(s.length <= max, `${what} is ${s.length} characters; the limit is ${max}.`);
  return s;
}
const list = (v, max, what) => { need(v == null || (Array.isArray(v) && v.length <= max), `${what} is a list of at most ${max}.`); return v || []; };
export const r2KeyFor = (user, id, mime) => `u/${user}/uk-imaging/${id}.${MIMES[mime]}`;

/** One finding checked and tidied, or throws. Pure. */
export function cleanFinding(f, i = 0) {
  need(isObj(f), `Finding ${i + 1} is not an object.`);
  const id = text(f.id), name = id || `finding ${i + 1}`;
  need(ID_RE.test(id) && id.length <= LIMITS.id, `${name}: id is lower-case letters, digits and dashes.`);
  need(MODALITIES.includes(f.modality), `${name}: modality is one of ${MODALITIES.join(', ')}.`);
  const signs = list(f.signs, LIMITS.signs, `${name}: signs`).map((s, j) => {
    need(isObj(s) && ID_RE.test(text(s.id).replace(/_/g, '-')), `${name}: sign ${j + 1} needs an id and text.`);
    return { id: text(s.id), text: str(s.text, LIMITS.text, `${name}: sign ${j + 1}`) };
  });
  need(new Set(signs.map(s => s.id)).size === signs.length, `${name}: a sign id is given twice.`);
  const sources = list(f.sources, LIMITS.sources, `${name}: sources`).map((s, j) => {
    const o = { label: str(isObj(s) ? s.label : s, 200, `${name}: source ${j + 1}`) };
    if (isObj(s) && s.url) { need(httpsUrl(s.url) && String(s.url).length <= LIMITS.url, `${name}: source ${j + 1} url must be an https link.`); o.url = String(s.url); }
    return o;
  });
  const uk = list(f.uk, LIMITS.uk, `${name}: uk`).map((u, j) => {
    need(isObj(u), `${name}: UK line ${j + 1} is {text, source}.`);
    return { text: str(u.text, LIMITS.text, `${name}: UK line ${j + 1}`), source: str(u.source, 200, `${name}: UK line ${j + 1} source`) };
  });
  return {
    id, modality: f.modality, title: str(f.title, LIMITS.title, `${name}: title`),
    aliases: list(f.aliases, LIMITS.aliases, `${name}: aliases`).map((a, j) => str(a, LIMITS.title, `${name}: alias ${j + 1}`)),
    signs, versus: list(f.versus, LIMITS.versus, `${name}: versus`).map((v, j) => str(v, LIMITS.text, `${name}: look-alike ${j + 1}`)),
    uk, sources, normal_media_id: f.normal_media_id == null ? null : str(f.normal_media_id, LIMITS.id, `${name}: normal_media_id`),
    sort: Number.isInteger(f.sort) ? f.sort : i, demo: f.demo === true,
  };
}

/** One picture checked and tidied, or throws. user decides the only r2_key allowed for a real picture. Pure. */
export function cleanMedia(m, i = 0, user = 'mo') {
  need(isObj(m), `Picture ${i + 1} is not an object.`);
  const id = text(m.id), name = id || `picture ${i + 1}`;
  need(ID_RE.test(id) && id.length <= LIMITS.id, `${name}: id is lower-case letters, digits and dashes.`);
  need(ID_RE.test(text(m.finding_id)), `${name}: finding_id is missing.`);
  need(SOURCES.includes(m.source), `${name}: source is one of ${SOURCES.join(', ')}.`);
  const demo = m.source === 'demo';
  if (demo) need(m.r2_key === `demo:${id}` && m.mime === 'image/svg+xml', `${name}: a demo picture is "demo:<id>", image/svg+xml.`);
  else need(MIMES[m.mime] && m.r2_key === r2KeyFor(user, id, m.mime), `${name}: r2_key must be ${MIMES[m.mime] ? r2KeyFor(user, id, m.mime) : 'the uploaded key (JPEG, PNG or WebP)'}.`);
  for (const k of ['w', 'h', 'bytes']) need(Number.isInteger(m[k]) && m[k] > 0 && (k !== 'bytes' || m[k] <= MAX_BYTES), `${name}: ${k} is a positive whole number${k === 'bytes' ? ' up to 8 MB' : ''}.`);
  if (!demo) need(m.source !== 'commons' || httpsUrl(m.source_url), `${name}: a Commons picture keeps its https source link.`);
  if (m.source_url != null && m.source_url !== '') need(httpsUrl(m.source_url) && String(m.source_url).length <= LIMITS.url, `${name}: source_url must be an https link.`);
  const hotspots = list(m.hotspots, LIMITS.hotspots, `${name}: hotspots`).map((h, j) => {
    const where = `${name}: hotspot ${j + 1}`;
    need(isObj(h) && SHAPES.includes(h.shape), `${where}: shape is ellipse, box or poly.`);
    need(Array.isArray(h.pts) && h.pts.every(x => typeof x === 'number' && x >= -0.1 && x <= 1.1), `${where}: pts are fractions of the picture.`);
    need(h.shape === 'poly' ? h.pts.length >= 4 && h.pts.length % 2 === 0 && h.pts.length <= LIMITS.pts : h.pts.length === 4, `${where}: ${h.shape === 'poly' ? 'an even list of x, y' : 'four numbers'}.`);
    const o = { sign_id: str(h.sign_id, 40, `${where} sign_id`), label: str(h.label, 200, `${where} label`), shape: h.shape, pts: h.pts.map(x => Math.round(x * 10000) / 10000) };
    if (h.open === true) o.open = true;
    return o;
  });
  return {
    id, finding_id: text(m.finding_id), view: str(m.view, 30, `${name}: view`, { required: false }) || null, r2_key: m.r2_key, mime: m.mime, w: m.w, h: m.h, bytes: m.bytes,
    hotspots, source: m.source, source_url: m.source_url ? String(m.source_url) : null, licence: str(m.licence, LIMITS.licence, `${name}: licence`),
    author: str(m.author, 200, `${name}: author`, { required: false }) || null, attribution: str(m.attribution, LIMITS.attribution, `${name}: attribution`),
    sort: Number.isInteger(m.sort) ? m.sort : i,
  };
}

/** The import's arguments: {findings, media, remove: {findings, media}, remove_demo} or {refuse}. Pure. */
export function cleanImport(args, user = 'mo') {
  try {
    need(isObj(args), 'The import is malformed.');
    for (const k of Object.keys(args)) need(['findings', 'media', 'remove', 'remove_demo'].includes(k), `Unknown argument ${k}.`);
    const findings = list(args.findings, LIMITS.findings, 'findings').map(cleanFinding);
    const media = list(args.media, LIMITS.media, 'media').map((m, i) => cleanMedia(m, i, user));
    need(new Set(findings.map(f => f.id)).size === findings.length, 'A finding id is given twice.');
    need(new Set(media.map(m => m.id)).size === media.length, 'A picture id is given twice.');
    const rm = isObj(args.remove) ? args.remove : {};
    need(args.remove == null || isObj(args.remove), 'remove is {findings: [ids], media: [ids]}.');
    const remove = { findings: [...new Set(list(rm.findings, LIMITS.remove, 'remove.findings'))], media: [...new Set(list(rm.media, LIMITS.remove, 'remove.media'))] };
    need([...remove.findings, ...remove.media].every(x => typeof x === 'string'), 'remove lists ids.');
    need(!remove.findings.some(id => findings.some(f => f.id === id)) && !remove.media.some(id => media.some(m => m.id === id)), 'Something cannot be both imported and removed.');
    // a picture's signs must be its finding's, when the finding comes in the same import
    for (const m of media) {
      const f = findings.find(x => x.id === m.finding_id);
      if (f) for (const h of m.hotspots) need(f.signs.some(s => s.id === h.sign_id), `${m.id}: hotspot sign ${h.sign_id} is not one of ${f.id}'s signs.`);
    }
    const removeDemo = args.remove_demo === true;
    need(findings.length || media.length || remove.findings.length || remove.media.length || removeDemo, 'Nothing to import.');
    return { findings, media, remove, remove_demo: removeDemo };
  } catch (e) {
    if (e instanceof Bad) return { refuse: e.message };
    throw e;
  }
}

const F_COLS = ['modality', 'title', 'aliases_json', 'signs_json', 'versus_json', 'uk_json', 'sources_json', 'normal_media_id', 'sort', 'demo'];
const M_COLS = ['finding_id', 'view', 'r2_key', 'mime', 'w', 'h', 'bytes', 'hotspots_json', 'source', 'source_url', 'licence', 'author', 'attribution', 'sort'];
export const findingRow = f => ({ modality: f.modality, title: f.title, aliases_json: JSON.stringify(f.aliases), signs_json: JSON.stringify(f.signs), versus_json: JSON.stringify(f.versus),
  uk_json: JSON.stringify(f.uk), sources_json: JSON.stringify(f.sources), normal_media_id: f.normal_media_id, sort: f.sort, demo: f.demo ? 1 : 0 });
export const mediaRow = m => ({ finding_id: m.finding_id, view: m.view, r2_key: m.r2_key, mime: m.mime, w: m.w, h: m.h, bytes: m.bytes, hotspots_json: JSON.stringify(m.hotspots),
  source: m.source, source_url: m.source_url, licence: m.licence, author: m.author, attribution: m.attribution, sort: m.sort });
export const WRITE_COLS = { findings: [...F_COLS, 'updated_at', 'deleted_at'], media: [...M_COLS, 'created_at', 'deleted_at'] };

/**
 * Op uk_img.import's planner: reads what it names (one batch) and returns row diffs with one event each. Findings
 * and pictures are inserted, updated or soft-deleted (deleted_at); undo restores them.
 */
export async function planImport(env, user, args, ctx) {
  const c = cleanImport(args, user);
  if (c.refuse) return { refuse: c.refuse };
  const fIds = [...c.findings.map(f => f.id), ...c.remove.findings], mIds = [...c.media.map(m => m.id), ...c.remove.media];
  const [fr, mr] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM uk_img_findings WHERE user_id = ?1 AND (id IN (SELECT value FROM json_each(?2)) OR (?3 = 1 AND demo = 1))').bind(user, JSON.stringify(fIds), c.remove_demo ? 1 : 0),
    env.DB.prepare(`SELECT * FROM uk_img_media WHERE user_id = ?1 AND (id IN (SELECT value FROM json_each(?2)) OR (?3 = 1 AND source = 'demo' AND deleted_at IS NULL)
      OR finding_id IN (SELECT value FROM json_each(?4)))`).bind(user, JSON.stringify(mIds), c.remove_demo ? 1 : 0, JSON.stringify(c.remove.findings)),
  ]);
  const haveF = new Map((fr.results || []).map(r => [r.id, r])), haveM = new Map((mr.results || []).map(r => [r.id, r]));
  const now = ctx.now || Date.now();
  const rows = [], events = [], n = { added: 0, updated: 0, removed: 0 };
  const ev = (kind, type, id, words) => { events.push({ kind, target_type: type, target_id: id, summary: summaryOf(words) }); n[kind.slice(3)]++; };
  for (const f of c.findings) {
    const cur = haveF.get(f.id), next = findingRow(f);
    if (!cur) { rows.push({ table: 'uk_img_findings', op: 'insert', key: { id: f.id }, before: null, after: { ...next, updated_at: now, deleted_at: null } }); ev('uk.added', 'uk_img_findings', f.id, `Imaging finding added: ${f.title}`); continue; }
    const changed = F_COLS.filter(k => String(cur[k] ?? '') !== String(next[k] ?? ''));
    if (!changed.length && cur.deleted_at == null) continue;
    const before = { updated_at: cur.updated_at, deleted_at: cur.deleted_at }, after = { updated_at: now, deleted_at: null };
    for (const k of changed) { before[k] = cur[k]; after[k] = next[k]; }
    rows.push({ table: 'uk_img_findings', op: 'update', key: { id: f.id }, before, after });
    ev('uk.updated', 'uk_img_findings', f.id, `Imaging finding updated: ${f.title}`);
  }
  for (const m of c.media) {
    const cur = haveM.get(m.id), next = mediaRow(m);
    if (!cur) { rows.push({ table: 'uk_img_media', op: 'insert', key: { id: m.id }, before: null, after: { ...next, created_at: now, deleted_at: null } }); ev('uk.added', 'uk_img_media', m.id, `Imaging picture added: ${m.id}`); continue; }
    const changed = M_COLS.filter(k => String(cur[k] ?? '') !== String(next[k] ?? ''));
    if (!changed.length && cur.deleted_at == null) continue;
    const before = { deleted_at: cur.deleted_at }, after = { deleted_at: null };
    for (const k of changed) { before[k] = cur[k]; after[k] = next[k]; }
    rows.push({ table: 'uk_img_media', op: 'update', key: { id: m.id }, before, after });
    ev('uk.updated', 'uk_img_media', m.id, `Imaging picture ${cur.deleted_at == null ? 'updated' : 'restored'}: ${m.id}`);
  }
  const goneF = new Set(), goneM = new Set();
  const dropM = r => { if (!r || r.deleted_at != null || goneM.has(r.id)) return; goneM.add(r.id); rows.push({ table: 'uk_img_media', op: 'update', key: { id: r.id }, before: { deleted_at: null }, after: { deleted_at: now } }); ev('uk.removed', 'uk_img_media', r.id, `Imaging picture removed: ${r.id}`); };
  const dropF = r => { if (!r || r.deleted_at != null || goneF.has(r.id)) return; goneF.add(r.id); rows.push({ table: 'uk_img_findings', op: 'update', key: { id: r.id }, before: { deleted_at: null, updated_at: r.updated_at }, after: { deleted_at: now, updated_at: now } }); ev('uk.removed', 'uk_img_findings', r.id, `Imaging finding removed: ${r.title}`); };
  for (const id of c.remove.media) dropM(haveM.get(id));
  for (const id of c.remove.findings) { dropF(haveF.get(id)); for (const r of haveM.values()) if (r.finding_id === id) dropM(r); }
  if (c.remove_demo) { for (const r of haveF.values()) if (r.demo) dropF(r); for (const r of haveM.values()) if (r.source === 'demo') dropM(r); }
  if (!rows.length) return { noop: true, summary: 'The imaging lab is already up to date.' };
  const words = Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ');
  return { rows, events, summary: `Imaging import: ${words}`, reply: { counts: n } };
}

// ---------------------------------------------------------------- reads
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
export const findingOut = r => ({ id: r.id, modality: r.modality, title: r.title, aliases: parse(r.aliases_json, []), signs: parse(r.signs_json, []), versus: parse(r.versus_json, []),
  uk: parse(r.uk_json, []), sources: parse(r.sources_json, []), normal_media_id: r.normal_media_id, sort: r.sort, demo: !!r.demo, updated_at: r.updated_at });
export const mediaOut = r => ({ id: r.id, finding_id: r.finding_id, view: r.view, mime: r.mime, w: r.w, h: r.h, hotspots: parse(r.hotspots_json, []), source: r.source,
  source_url: r.source_url, licence: r.licence, author: r.author, attribution: r.attribution, sort: r.sort, demo_key: r.source === 'demo' ? r.r2_key.slice(5) : null });

/** The lab's list: every finding (no tables) with its picture count, and counts by modality. */
export async function listFindings(env, user) {
  const [f, c] = await env.DB.batch([
    env.DB.prepare('SELECT id, modality, title, aliases_json, normal_media_id, sort, demo FROM uk_img_findings WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY modality, sort, title COLLATE NOCASE').bind(user),
    env.DB.prepare('SELECT finding_id, count(*) AS n FROM uk_img_media WHERE user_id = ?1 AND deleted_at IS NULL GROUP BY finding_id').bind(user),
  ]);
  const counts = new Map((c.results || []).map(r => [r.finding_id, r.n]));
  const findings = (f.results || []).map(r => ({ id: r.id, modality: r.modality, title: r.title, aliases: parse(r.aliases_json, []), normal_media_id: r.normal_media_id, sort: r.sort, demo: !!r.demo, count: counts.get(r.id) || 0 }));
  const by = {};
  for (const x of findings) by[x.modality] = (by[x.modality] || 0) + 1;
  return { findings, modalities: by };
}
/** One finding with its pictures and its normal picture (or null). */
export async function getFinding(env, user, id) {
  const [f, m] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM uk_img_findings WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL').bind(user, id),
    env.DB.prepare(`SELECT * FROM uk_img_media WHERE user_id = ?1 AND deleted_at IS NULL AND (finding_id = ?2
      OR id = (SELECT normal_media_id FROM uk_img_findings WHERE user_id = ?1 AND id = ?2)) ORDER BY sort, id`).bind(user, id),
  ]);
  const row = (f.results || [])[0];
  if (!row) return null;
  const finding = findingOut(row), all = (m.results || []).map(mediaOut);
  return { finding, media: all.filter(x => x.finding_id === id), normal: all.find(x => x.id === finding.normal_media_id && x.finding_id !== id) || all.find(x => x.id === finding.normal_media_id) || null };
}

// ---------------------------------------------------------------- routes
export async function listRoute(request, env, ctx, params, url, user) { gate(env); return json(await listFindings(env, user)); }
export async function findingRoute(request, env, ctx, params, url, user) {
  gate(env);
  const r = await getFinding(env, user, params.id);
  if (!r) throw new HttpError(404, 'That imaging finding is not on the hub.');
  return json(r);
}
// GET /api/uk/imaging/media/:id -> the picture's bytes, private (it never sits in a shared cache).
export async function mediaGetRoute(request, env, ctx, params, url, user) {
  gate(env);
  const row = await env.DB.prepare('SELECT r2_key, mime FROM uk_img_media WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL').bind(user, params.id).first();
  if (!row) throw new HttpError(404, 'That picture is not on the hub.');
  if (row.r2_key.startsWith('demo:')) throw new HttpError(404, 'Demo pictures are drawn in the page.');
  if (!env.LIBRARY) throw new HttpError(503, 'The picture store is not set up on this hub.');
  const obj = await env.LIBRARY.get(row.r2_key);
  if (!obj) throw new HttpError(404, 'That picture is missing from the store.');
  return new Response(obj.body, { headers: { 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
}
/** The picture's type from its first bytes (JPEG, PNG or WebP), or null. Pure. */
export function sniff(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}
// PUT /api/uk/imaging/media/:id (the raw picture) -> {id, r2_key, mime, bytes}. The row comes with the import.
export async function mediaPutRoute(request, env, ctx, params, url, user) {
  gate(env);
  const id = String(params.id || '');
  if (!ID_RE.test(id) || id.length > LIMITS.id) throw new HttpError(400, 'The picture id is lower-case letters, digits and dashes.');
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new HttpError(413, 'Pictures are at most 8 MB.');
  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length) throw new HttpError(400, 'Send the picture as the request body.');
  if (buf.length > MAX_BYTES) throw new HttpError(413, 'Pictures are at most 8 MB.');
  const mime = sniff(buf);
  if (!mime) throw new HttpError(415, 'Pictures are JPEG, PNG or WebP.');
  if (!env.LIBRARY || typeof env.LIBRARY.put !== 'function') throw new HttpError(503, 'The picture store is not set up on this hub.');
  const r2_key = r2KeyFor(user, id, mime);
  await env.LIBRARY.put(r2_key, buf, { httpMetadata: { contentType: mime } });
  return json({ id, r2_key, mime, bytes: buf.length });
}
// POST /api/uk/imaging/import {findings?, media?, remove?, remove_demo?} -> applyChange's answer
export async function importRoute(request, env, ctx, params, url, user) {
  gate(env);
  const body = await readJson(request, 2_000_000);
  const demo = (Array.isArray(body.findings) && body.findings.some(f => f && f.demo === true)) || (Array.isArray(body.media) && body.media.some(m => m && m.source === 'demo'));
  if (demo && !LOCAL.has(url.hostname)) throw new HttpError(400, 'Demo pictures are only for a local hub.');
  return changeResponse(await applyChange(env, user, { actor: 'code', surface: 'code', op: 'uk_img.import', args: body, via: 'api:POST /api/uk/imaging/import' }));
}
