// Platform feature: me (docs/platform/plan.md §5, §15 UK GDPR, api.md WP3). The person's own account page:
// name, exam date, which parts of the hub are switched on; a download of everything held about them; and deleting
// the account (sessions and connector links end at once, the rows and files are purged by the lead's cron through
// purgeDeleted). Every query names user_id and uses the signed-in person from the session, never the request.
//
// Exports ROUTES, CHECKS and purgeDeleted(env) for platform/cron.js.
import { HttpError, json, readJson, londonDay, safeParse, now } from '../util.js';
import { buildProfile } from '../profiles.js';
import { prefsStatement } from '../users.js';
import { writeBatch, summaryOf } from '../map/events.js';
import { moduleChange, moduleList, modulesFor, LEARNER } from './modules.js';
import { PLATFORM_EXPORT } from './export-tables.js';
import { verifyPassword } from './crypto.js';
import * as auth from './auth.js';
import * as libStore from '../library/store.js';
import { vectorizeDelete } from '../library/vectors.js';
import { EXPORT as LIBRARY_EXPORT } from '../map/registry/library.js';

const ok = (data, status = 200) => json(data, status);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(s) {
  const m = DATE_RE.exec(String(s));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] && +m[1] >= 2000 && +m[1] <= 2100;
}

// ------------------------------------------------------------------ GET and PATCH /api/p/me

async function account(env, user) {
  // claude_links / claude_used: their Claude connector links and when one last reached the hub (the Anki push key aside).
  const row = await env.DB.prepare(
    `SELECT u.name, u.profile, u.profile_json, u.prefs_json, c.email IS NOT NULL AS email_set,
       (SELECT COUNT(*) FROM connector_keys k WHERE k.user_id = ?1 AND k.revoked_at IS NULL AND coalesce(k.label, '') != 'anki') AS claude_links,
       (SELECT MAX(k.last_used_at) FROM connector_keys k WHERE k.user_id = ?1 AND coalesce(k.label, '') != 'anki') AS claude_used
     FROM users u LEFT JOIN credentials c ON c.user_id = u.id WHERE u.id = ?1`).bind(user).first();
  if (!row) throw new HttpError(404, 'There is no such account.');
  return row;
}

function shape(user, row, env) {
  const overrides = safeParse(row.profile_json, {});
  const prefs = safeParse(row.prefs_json, {});
  const profile = buildProfile(row.profile, isObj(overrides) ? overrides : {});
  // A name the profiles file does not know falls back to the default profile; its exam date is not this person's.
  const known = profile.id === row.profile;
  const examDate = (isObj(overrides) && typeof overrides.exam_date === 'string' && overrides.exam_date) || (known && profile.exam_date) || null;
  return {
    user, name: row.name, track: row.profile, track_label: profile.label || profile.exam || row.profile,
    exam_date: examDate, email_set: !!row.email_set,
    claude: { links: Number(row.claude_links) || 0, last_used_at: row.claude_used || null },
    modules: moduleList(known ? profile : row.profile, isObj(prefs) ? prefs : {}, env),
    ...(auth.ownerMode(env) ? { own_copy: true } : {}),   // their own copy: Settings offers bringing data in
  };
}

async function getMe(request, env, ctx, params, url, user) {
  return ok(shape(user, await account(env, user), env));
}

/** The date of their first exam (Today's countdown), or null or '' to clear it: one statement and its event. */
function examDateChange(env, user, d, t) {
  if (d === null || d === '') {
    return { statement: env.DB.prepare(`UPDATE users SET profile_json = json_remove(CASE WHEN json_valid(profile_json) THEN profile_json ELSE '{}' END, '$.exam_date'), updated_at = ?2 WHERE id = ?1`).bind(user, t),
      event: { kind: 'pref.changed', target_type: 'pref', target_id: 'exam_date', summary: 'Exam date cleared', before: null, after: null } };
  }
  if (typeof d !== 'string' || !validDate(d)) throw new HttpError(400, 'Give the exam date as a day, like 2027-06-14.');
  return { statement: env.DB.prepare(`UPDATE users SET profile_json = json_set(CASE WHEN json_valid(profile_json) THEN profile_json ELSE '{}' END, '$.exam_date', ?3), updated_at = ?2 WHERE id = ?1`).bind(user, t, d),
    event: { kind: 'pref.changed', target_type: 'pref', target_id: 'exam_date', summary: `Exam date set to ${d}`, before: null, after: { exam_date: d } } };
}

/** Sets or clears the exam date (subject_edit); not undoable, like the Settings field. */
export async function setExamDate(env, user, d, { actor = LEARNER, surface = 'web', via = 'me' } = {}) {
  const c = examDateChange(env, user, d, now());
  await writeBatch(env, user, { actor, surface, via, undoable: false, statements: [c.statement], events: [c.event] });
  return d || null;
}

async function patchMe(request, env, ctx, params, url, user, session) {
  const body = await readJson(request, 10_000);
  const row = await account(env, user);
  const t = now();
  const statements = [];
  const events = [];
  const ev = (target_id, summary, before, after) => events.push({ kind: 'pref.changed', target_type: 'pref', target_id, summary: summaryOf(summary), before, after });

  if ('name' in body) {
    const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!name || name.length > 60) throw new HttpError(400, 'Please give a name of up to 60 characters.');
    if (name !== row.name) {
      statements.push(env.DB.prepare('UPDATE users SET name = ?2, updated_at = ?3 WHERE id = ?1').bind(user, name, t));
      ev('name', 'Name changed', null, null);
    }
  }
  if ('exam_date' in body) {
    const c = examDateChange(env, user, body.exam_date, t);
    statements.push(c.statement); events.push(c.event);
  }
  if ('modules' in body) {
    if (!isObj(body.modules)) throw new HttpError(400, 'Modules must be a list of ids with on or off.');
    const prefs = safeParse(row.prefs_json, {});
    const was = modulesFor(row.profile, isObj(prefs) ? prefs : {}, env);
    for (const [id, on] of Object.entries(body.modules)) {
      const c = moduleChange(row.profile, id, on, env);   // 400 for an unknown part, one that cannot be switched, or a non-boolean
      statements.push(prefsStatement(env, user, c.path, c.value));
      ev(c.path, `${id.replace(/_/g, ' ')} switched ${on ? 'on' : 'off'}`, { on: !!was[id] }, { on });
    }
  }
  if (statements.length) {
    await writeBatch(env, user, { actor: LEARNER, surface: 'web', via: 'me', undoable: false, statements, events });
    return ok(shape(user, await account(env, user), env));
  }
  return ok(shape(user, row, env));
}

// ------------------------------------------------------------------ export

// Map tables the person owns, exported whole (every column; nothing in them is a secret).
// Lessons, notes, links, pinned positions and mnemonics too (30 Oct), so a move to their own copy keeps them.
export const MAP_EXPORT = ['topics', 'categories', 'units', 'unit_topics', 'topic_aliases', 'evidence', 'gaps', 'topic_scores',
  'links', 'topic_notes', 'topic_positions', 'lessons', 'misconceptions', 'teach_memory', 'mnemonics', 'mnemonic_reviews'];
// Their AI choices and spend (never the keys).
const AI_EXPORT = ['ai_settings', 'ai_usage'];
// The library's document list (release 2.5): the rows as the hub's own backup keeps them, without the storage
// internals (R2 key, multipart upload id and parts). The files themselves are listed under `files`.
const LIBRARY_COLS = LIBRARY_EXPORT.library_docs.cols.filter(c => !['r2_key', 'upload_id', 'parts_json'].includes(c));

async function exportMe(request, env, ctx, params, url, user) {
  const row = await account(env, user);
  const studyNames = Object.keys(PLATFORM_EXPORT);
  const others = [...MAP_EXPORT, ...AI_EXPORT];
  const stmts = [
    ...studyNames.map(n => env.DB.prepare(`SELECT ${PLATFORM_EXPORT[n].cols.join(', ')} FROM ${n} WHERE user_id = ? ORDER BY 1, 2`).bind(user)),
    ...others.map(n => env.DB.prepare(`SELECT * FROM ${n} WHERE user_id = ?`).bind(user)),
    env.DB.prepare(`SELECT ${LIBRARY_COLS.join(', ')}, r2_key IS NOT NULL AS has_file FROM library_docs WHERE user_id = ? ORDER BY id`).bind(user),
  ];
  const res = await env.DB.batch(stmts);
  const tables = {};
  [...studyNames, ...others].forEach((n, i) => { tables[n] = res[i].results || []; });
  const docs = res[res.length - 1].results || [];
  tables.library_docs = docs.map(({ has_file, ...row }) => row);
  const files = docs.filter(d => d.has_file && d.status !== 'uploading' && d.status !== 'refused')
    .map(d => ({ id: d.id, title: d.title, filename: d.file_name, mime: 'application/pdf', size: d.bytes, download: `/api/p/library/docs/${encodeURIComponent(d.id)}/file` }));
  const t = now();
  const body = {
    about: 'Everything the Study Hub holds about you. Passwords, sign-in sessions and AI keys are never included.',
    exported_at: t, user,
    account: { name: row.name, track: row.profile, profile: safeParse(row.profile_json, {}), settings: safeParse(row.prefs_json, {}), email_saved: !!row.email_set },
    tables, files,
  };
  return new Response(JSON.stringify(body, null, 1), { status: 200, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="study-hub-${user}-${londonDay(t)}.json"`,
  } });
}

// ------------------------------------------------------------------ delete

const DELETE_LIMIT = { limit: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };

async function deleteMe(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  const bucket = 'delete:' + user;
  const wait = await auth.lockedFor(env, user, bucket);
  if (wait) throw new HttpError(429, `Too many tries. Please wait ${Math.max(1, Math.ceil(wait / 60))} minutes and try again.`);
  const cred = await env.DB.prepare('SELECT password_hash FROM credentials WHERE user_id = ?').bind(user).first();
  if (!cred || !(await verifyPassword(String(body.password || ''), cred.password_hash))) {
    await auth.bump(env, user, bucket, DELETE_LIMIT);
    throw new HttpError(401, 'That password is not right, so nothing was deleted.');
  }
  const t = now();
  // One batch: the account is marked deleted, every sign-in, reset code and connector link ends.
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET status = 'deleted', updated_at = ?2 WHERE id = ?1").bind(user, t),
    env.DB.prepare('UPDATE sessions SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL').bind(user, t),
    env.DB.prepare('UPDATE auth_codes SET used_at = ?2 WHERE user_id = ?1 AND used_at IS NULL').bind(user, t),
    env.DB.prepare('UPDATE connector_keys SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL').bind(user, t),
  ]);
  const res = ok({ ok: true, message: 'Your account is closed and you have been signed out. Your data is deleted within 24 hours.' });
  res.headers.append('Set-Cookie', auth.clearCookie());
  return res;
}

// Every table that holds rows with a user_id, in the order they are cleared. The test compares this with the
// migrated schema, so a new table cannot be forgotten.
export const PURGE_TABLES = [
  // platform accounts and study data
  'sessions', 'auth_codes', 'rate_limits', 'connector_keys', 'upload_links', 'study_pictures', 'chat_notes', 'activity_days', 'galaxy_topics', 'galaxies', 'ai_keys', 'ai_settings', 'ai_usage', 'credentials',
  'cards', 'card_reviews', 'result_logs', 'papers', 'subjects',
  // the library (release 2.5): library_fts has no user_id, so purgeLibrary clears it with the passages
  'library_links', 'library_terms', 'library_coverage', 'library_pages', 'library_passages', 'library_docs',
  'topic_photos', 'topic_pictures', 'learn_points', 'learn_summaries', 'learn_cards', 'learn_faq', 'note_books', 'note_sections', 'note_pages', 'note_blocks',
  'note_strokes', 'note_fts', 'uk_entries', 'uk_fts', 'atlas_pages', 'orbit_sections', 'orbit_items', 'orbit_links', 'card_due', 'card_subjects',
  'uk_img_findings', 'uk_img_media', 'card_home', 'retests', 'pattern_runs', 'pattern_items', 'habits', 'learner_profile', 'history_items', 'job_runs',
  'mnemonic_reviews', 'mnemonics',
  // the map
  'evidence', 'map_events', 'topic_scores', 'topic_dirty', 'sync_state', 'category_priors', 'topic_embeddings', 'topic_positions', 'topic_queue', 'topic_notes',
  'topic_aliases', 'link_support', 'links', 'unit_topics', 'units', 'category_aliases', 'categories', 'topics', 'gaps', 'misses', 'checklist_progress',
  'card_topics', 'card_cache', 'resource_links', 'resources', 'lessons', 'teach_memory', 'misconceptions', 'tactic_scores', 'onenote_pages', 'onenote_parts',
  'source_fetches',
  'exam_topics', 'teach_offers', 'teach_skips', 'uworld_readings', 'uworld_adjust', 'uworld_block_kind',
  'card_rates', 'mehlman_summaries', 'uworld_judging', 'uworld_reviews', 'xq', 'xq_rank',
];

/**
 * A deleted person's library through 2.5's own store delete (their R2 files, vectors, FTS rows, passages, pages and
 * the row, document by document), then anything left over: FTS rows are removed before the passages they index (the
 * index keeps no text of its own) and their Vectorize ids are deleted. The R2 prefix and the other tables follow.
 */
export async function purgeLibrary(env, user) {
  let docs;
  try { docs = (await env.DB.prepare('SELECT id FROM library_docs WHERE user_id = ?').bind(user).all()).results || []; }
  catch (e) { if (libStore.noTable(e)) return 0; throw e; }
  for (const d of docs) {
    try { await libStore.deleteDoc(env, user, d.id); } catch (e) { console.error('purge: library document', d.id, e && e.message); }
  }
  const left = (await env.DB.prepare('SELECT pid FROM library_passages WHERE user_id = ?').bind(user).all()).results || [];
  if (left.length) {
    await env.DB.prepare(`INSERT INTO library_fts (library_fts, rowid, heading, text) SELECT 'delete', pid, coalesce(heading, ''), text FROM library_passages WHERE user_id = ?`).bind(user).run();
    await vectorizeDelete(env, left.map(r => r.pid));
  }
  return docs.length;
}

async function purgeFiles(env, user) {
  const bucket = env && env.LIBRARY;
  if (!bucket || typeof bucket.list !== 'function' || typeof bucket.delete !== 'function') return 0;
  let n = 0, cursor;
  for (let guard = 0; guard < 200; guard++) {
    const page = await bucket.list({ prefix: `u/${user}/`, cursor, limit: 1000 });
    const keys = (page.objects || []).map(o => o.key);
    if (keys.length) { await bucket.delete(keys); n += keys.length; }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return n;
}

/**
 * For platform/cron.js: deletes every row and file of accounts marked deleted (a few at a time), the account row
 * last. Returns the ids purged.
 */
export async function purgeDeleted(env, { max = 3 } = {}) {
  const { results } = await env.DB.prepare("SELECT id FROM users WHERE status = 'deleted' AND id != 'mo' ORDER BY updated_at LIMIT ?").bind(max).all();
  const done = [];
  for (const { id } of results || []) {
    await purgeLibrary(env, id);
    await purgeFiles(env, id);
    await env.DB.batch([
      ...PURGE_TABLES.map(t => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(id)),
      env.DB.prepare("DELETE FROM users WHERE id = ? AND status = 'deleted'").bind(id),
    ]);
    done.push(id);
  }
  return done;
}

// ------------------------------------------------------------------ self-check

async function meChecks(env, user) {
  const row = await env.DB.prepare('SELECT profile, profile_json, prefs_json FROM users WHERE id = ?').bind(user).first();
  if (!row) return [];
  const s = shape(user, { ...row, name: '', email_set: 0 }, env);
  const on = new Set(s.modules.filter(m => m.on).map(m => m.id));
  const out = [];
  if (on.has('countdown')) {
    out.push(s.exam_date
      ? { id: 'exam_date', ok: true, level: 'ok', says: `Exam date: ${s.exam_date}.` }
      : { id: 'exam_date', ok: true, level: 'info', says: 'Exam date: not set, so Today cannot count down to your exams.', fix: 'Add it in Settings.' });
  }
  return out;
}

export const CHECKS = [meChecks];

export const ROUTES = [
  ['GET', '/api/p/me', getMe],
  ['PATCH', '/api/p/me', patchMe],
  ['GET', '/api/p/me/export', exportMe],
  ['POST', '/api/p/me/delete', deleteMe],
];
// Their own Claude switches whole parts of their hub on or off ("turn off Results", "switch Exams back on").
export const TOOLS = [{
  name: 'my_hub_parts',
  description: 'Lists the parts of the student\'s own Study Hub (Exams, Flashcards, Results, Library, Practice papers, Link your Anki, ...) and switches them on or off when they ask ("I do not use Results, turn it off"). '
    + 'Only their hub changes. Call with no parts to see the list first. A part they switch off keeps its data and comes back as it was when switched on.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    parts: { type: 'object', additionalProperties: { type: 'boolean' }, description: 'Part id to true (on) or false (off), e.g. {"results": false}.' } } },
  annotations: { readOnlyHint: false, destructiveHint: false },
  async run(env, user, args) {
    const row = await account(env, user);
    const prefs = safeParse(row.prefs_json, {});
    const parts = isObj(args.parts) ? args.parts : {};
    const statements = [], events = [], changed = [];
    const was = modulesFor(row.profile, isObj(prefs) ? prefs : {}, env);
    for (const [id, on] of Object.entries(parts)) {
      const c = moduleChange(row.profile, id, on, env);
      statements.push(prefsStatement(env, user, c.path, c.value));
      events.push({ kind: 'pref.changed', target_type: 'pref', target_id: c.path, summary: summaryOf(`${id.replace(/_/g, ' ')} switched ${on ? 'on' : 'off'} by their Claude`), before: { on: !!was[id] }, after: { on } });
      changed.push(`${id} ${on ? 'on' : 'off'}`);
    }
    if (statements.length) await writeBatch(env, user, { actor: 'claude', surface: 'chat', via: 'me', undoable: false, statements, events });
    const fresh = changed.length ? await account(env, user) : row;
    return { parts: moduleList(fresh.profile, safeParse(fresh.prefs_json, {}), env).map(m => ({ id: m.id, label: m.label, on: m.on, can_switch: m.can_switch })),
      ...(changed.length ? { changed: changed.join(', '), say: 'Done. The page shows it next time it loads.' } : {}) };
  },
}];
