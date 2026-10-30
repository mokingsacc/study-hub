// Platform "me" (WP3): the account page, the person's own export, deleting the account and the purge behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { BASE, platformEnv, signedIn, client } from './platform-helpers.mjs';
import * as cards from '../../worker/src/platform/cards.js';
import * as me from '../../worker/src/platform/me.js';

const t0 = Date.now();

// Vectorize, as far as the purge uses it: ids in, ids out.
function fakeVec() {
  const rows = new Map(), deleted = [];
  return { rows, deleted, query: async () => ({ matches: [] }), upsert: async list => { for (const r of list) rows.set(r.id, r); },
    deleteByIds: async ids => { for (const i of ids) { deleted.push(i); rows.delete(i); } } };
}

// A very small R2: key -> bytes, with list by prefix and delete of one key or many.
function fakeR2() {
  const objects = new Map();
  return {
    objects,
    put: async (k, v) => { objects.set(k, v); },
    list: async ({ prefix = '', cursor, limit = 1000 } = {}) => {
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      const from = cursor ? keys.findIndex(k => k > cursor) : 0;
      const page = from < 0 ? [] : keys.slice(from, from + limit);
      const more = from >= 0 && from + limit < keys.length;
      return { objects: page.map(key => ({ key })), truncated: more, cursor: more ? page[page.length - 1] : undefined };
    },
    delete: async k => { for (const x of Array.isArray(k) ? k : [k]) objects.delete(x); },
  };
}

// Study rows for one person: subject, topic, cards (one reviewed, so evidence and a score exist), a gap, a result,
// a library file and note.
async function seed(env, c, user, tag) {
  const run = (sql, ...b) => env.DB.prepare(sql).bind(...b).run();
  await run(`INSERT INTO subjects (user_id, id, track, subject, name, created_at, updated_at) VALUES (?, 'gcse-biology', 'gcse', 'biology', ?, ?, ?)`, user, `Biology ${tag}`, t0, t0);
  await run(`INSERT INTO topics (user_id, id, name, kind, status, category_id, source, created_by, created_at, updated_at) VALUES (?, 'gcse-biology-cells', ?, 'concept', 'confirmed', 'gcse-biology', 'test', 'mo', ?, ?)`, user, `Cells ${tag}`, t0, t0);
  const id = (await c.call('POST', '/api/p/cards', { front: `front ${tag}`, back: `back ${tag}`, topic_id: 'gcse-biology-cells' })).data.card.id;
  await cards.reviewCard(env, user, id, 1);
  await run(`INSERT INTO gaps (id, at, day, source, gap, user_id, topic_id, created_at) VALUES (?, ?, '2026-10-25', 'chat', ?, ?, 'gcse-biology-cells', ?)`, `g-${tag}`, t0, `gap ${tag}`, user, t0);
  await run(`INSERT INTO result_logs (user_id, id, bank, subject_id, day, label, how, created_at) VALUES (?, ?, 'bank', 'gcse-biology', '2026-10-25', ?, 'typed', ?)`, user, `r-${tag}`, `label ${tag}`, t0);
  // The library is release 2.5's: a document, its page, passage (with its FTS row), link, abbreviation and coverage.
  await run(`INSERT INTO library_docs (user_id, id, title, file_name, source, sha256, bytes, page_count, r2_key, status, n_passages, created_at, updated_at, indexed_at)
    VALUES (?, ?, ?, 'p.pdf', 'upload', ?, 10, 1, ?, 'ready', 1, ?, ?, ?)`, user, `lib-${tag}`, `Paper ${tag}`, 'c'.repeat(64), `u/${user}/lib-${tag}/file.pdf`, t0, t0, t0);
  await run(`INSERT INTO library_docs (user_id, id, title, source, status, r2_key, upload_id, parts_json, created_at, updated_at) VALUES (?, ?, ?, 'upload', 'uploading', ?, 'up-secret-id', '[{"n":1,"etag":"e1"}]', ?, ?)`,
    user, `half-${tag}`, `Half ${tag}`, `u/${user}/half-${tag}/file.pdf`, t0, t0);
  await run(`INSERT INTO library_pages (user_id, doc_id, n, text, chars, kind) VALUES (?, ?, 1, ?, 5, 'text')`, user, `lib-${tag}`, `chunk ${tag}`);
  await run(`INSERT INTO library_passages (user_id, doc_id, seq, page, page_to, heading, text, char_start, char_end, tokens, vec_state, created_at) VALUES (?, ?, 0, 1, 1, ?, ?, 0, 5, 3, 2, ?)`,
    user, `lib-${tag}`, `heading ${tag}`, `chunk ${tag}`, t0);
  const pid = (await env.DB.prepare('SELECT pid FROM library_passages WHERE user_id = ? AND doc_id = ?').bind(user, `lib-${tag}`).first()).pid;
  await run(`INSERT INTO library_fts (rowid, heading, text) VALUES (?, ?, ?)`, pid, `heading ${tag}`, `chunk ${tag}`);
  await run(`INSERT INTO library_links (user_id, topic_id, pid, score, method, updated_at) VALUES (?, 'gcse-biology-cells', ?, 0.9, 'match', ?)`, user, pid, t0);
  await run(`INSERT INTO library_terms (user_id, abbr_key, abbr, long) VALUES (?, 'atp', 'ATP', ?)`, user, `adenosine triphosphate ${tag}`);
  await run(`INSERT INTO library_coverage (user_id, topic_id, n, lib_at, built_at) VALUES (?, 'gcse-biology-cells', 1, ?, ?)`, user, t0, t0);
  if (env.LIBRARY_VEC) await env.LIBRARY_VEC.upsert([{ id: `p${pid}`, values: [1], namespace: user }]);
  await run(`INSERT INTO papers (user_id, id, subject_id, title, paper_json, created_at, updated_at) VALUES (?, ?, 'gcse-biology', ?, '{}', ?, ?)`, user, `p-${tag}`, `paper ${tag}`, t0, t0);
  await env.LIBRARY.put(`u/${user}/lib-${tag}/file.pdf`, new Uint8Array([1, 2, 3]));
  await env.LIBRARY.put(`u/${user}/half-${tag}/raw/00001.json`, new Uint8Array([9]));
  await env.LIBRARY.put(`u/${user}/extra-${tag}`, new Uint8Array([4]));
  return id;
}

const count = (env, table, user) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).bind(user).first().then(r => r.n);

test('GET /api/p/me: name, track, exam date, email and every part with whether it can be switched', async () => {
  const { d, env } = platformEnv();
  const { c, id } = await signedIn(env, 'Adam', { profile: 'gcse' });
  const r = await c.call('GET', '/api/p/me');
  assert.equal(r.status, 200);
  assert.equal(r.data.user, id);
  assert.equal(r.data.name, 'Adam');
  assert.equal(r.data.track, 'gcse');
  assert.equal(typeof r.data.track_label, 'string');
  assert.equal(r.data.email_set, false);
  assert.ok(r.data.modules.length >= 9);
  assert.deepEqual(Object.keys(r.data.modules[0]).sort(), ['can_switch', 'id', 'label', 'on']);
  assert.equal(r.data.modules.find(m => m.id === 'map').can_switch, false);
  assert.equal(r.data.modules.find(m => m.id === 'cards').on, true);
  assert.equal(r.data.modules.find(m => m.id === 'anki_link').can_switch, false, 'the flag is off');
  assert.equal(r.data.modules.find(m => m.id === 'anki_link').on, false);
  await c.call('PUT', '/api/p/email', { email: 'adam@example.com' });
  assert.equal((await c.call('GET', '/api/p/me')).data.email_set, true);
  assert.equal((await client(env).call('GET', '/api/p/me')).status, 401);
  d.close();
});

test('PATCH /api/p/me: name, exam date and modules, with pref.changed events', async () => {
  const { d, env } = platformEnv();
  const { c, id } = await signedIn(env, 'Adam', { profile: 'gcse' });
  const r = await c.call('PATCH', '/api/p/me', { name: '  Adam  Smith ', exam_date: '2027-06-14', modules: { results: false, countdown: false } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.name, 'Adam Smith');
  assert.equal(r.data.exam_date, '2027-06-14');
  assert.equal(r.data.modules.find(m => m.id === 'results').on, false);
  assert.equal(r.data.modules.find(m => m.id === 'countdown').on, false);
  assert.equal(r.data.modules.find(m => m.id === 'cards').on, true);
  const u = await env.DB.prepare('SELECT name, profile_json, prefs_json FROM users WHERE id = ?').bind(id).first();
  assert.equal(JSON.parse(u.profile_json).exam_date, '2027-06-14');
  assert.equal(JSON.parse(u.prefs_json).modules.results, false);
  assert.equal((await c.call('GET', '/api/auth/me')).data.name, 'Adam Smith');
  const ev = (await env.DB.prepare("SELECT kind, target_id, summary FROM map_events WHERE user_id = ? AND kind = 'pref.changed' ORDER BY seq").bind(id).all()).results;
  assert.deepEqual(ev.map(e => e.target_id), ['name', 'exam_date', 'modules.results', 'modules.countdown']);
  // clear the date, switch back on
  const back = await c.call('PATCH', '/api/p/me', { exam_date: null, modules: { results: true } });
  assert.equal(back.data.modules.find(m => m.id === 'results').on, true);
  assert.notEqual(back.data.exam_date, '2027-06-14');
  // bad input
  for (const body of [{ name: '' }, { name: 'x'.repeat(61) }, { name: 5 }, { exam_date: '14/06/2027' }, { exam_date: '2027-02-30' }, { modules: [] },
    { modules: { nope: true } }, { modules: { map: false } }, { modules: { cards: 'yes' } }, { modules: { anki_link: true } }]) {
    const bad = await c.call('PATCH', '/api/p/me', body);
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
  assert.equal((await c.call('GET', '/api/p/me')).data.name, 'Adam Smith', 'a refused change changes nothing');
  assert.equal((await c.call('PATCH', '/api/p/me', {})).status, 200);
  d.close();
});

test("PATCH /api/p/me only ever changes the signed-in person, whatever the body says", async () => {
  const { d, env } = platformEnv();
  const A = await signedIn(env, 'Adam', { profile: 'gcse' });
  const B = await signedIn(env, 'Beth', { profile: 'gcse' });
  await A.c.call('PATCH', '/api/p/me', { name: 'Adam Two', user: B.id, user_id: B.id, id: B.id, modules: { cards: false } });
  const b = await B.c.call('GET', '/api/p/me');
  assert.equal(b.data.name, 'Beth');
  assert.equal(b.data.modules.find(m => m.id === 'cards').on, true);
  assert.equal((await A.c.call('GET', '/api/p/me')).data.name, 'Adam Two');
  d.close();
});

test('export: only their own rows, as a download, never a password, session, key or connector secret', async () => {
  const { d, env } = platformEnv({ LIBRARY: fakeR2() });
  const A = await signedIn(env, 'Adam', { profile: 'gcse' });
  const B = await signedIn(env, 'Beth', { profile: 'gcse' });
  const cardA = await seed(env, A.c, A.id, 'ALPHA');
  await seed(env, B.c, B.id, 'BETA');
  await A.c.call('PUT', '/api/p/email', { email: 'adam@example.com' });
  const conn = await A.c.call('POST', '/api/p/connector', { label: 'Claude' });
  await env.DB.prepare("INSERT INTO ai_keys (user_id, provider, sealed, hint, created_at, updated_at) VALUES (?, 'anthropic', 'v1.SEALED-SECRET-XYZ.abc', '...WXYZ', ?, ?)").bind(A.id, t0, t0).run();
  await env.DB.prepare("INSERT INTO ai_usage (user_id, day, provider, usd, calls) VALUES (?, '2026-10-25', 'workers_ai', 0.01, 2)").bind(A.id).run();

  const r = await worker.fetch(new Request(BASE + '/api/p/me/export', { headers: { Cookie: A.c.jar.cookie } }), env, { waitUntil() {} });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Disposition'), /^attachment; filename="study-hub-adam-[a-z0-9]+-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.match(r.headers.get('Content-Type'), /json/);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  const raw = await r.text();
  const out = JSON.parse(raw);
  assert.equal(out.user, A.id);
  assert.equal(out.account.name, 'Adam');
  const T = out.tables;
  for (const name of ['subjects', 'result_logs', 'cards', 'card_reviews', 'library_docs', 'papers', 'topics', 'evidence', 'gaps', 'topic_scores', 'ai_settings', 'ai_usage', 'categories', 'units', 'unit_topics', 'topic_aliases']) {
    assert.ok(Array.isArray(T[name]), name);
  }
  for (const name of ['subjects', 'result_logs', 'cards', 'card_reviews', 'library_docs', 'papers', 'topics', 'evidence', 'gaps', 'topic_scores', 'ai_usage'])
    assert.ok(T[name].length > 0, `${name} has their rows`);
  for (const [name, rows] of Object.entries(T)) for (const row of rows) assert.equal(row.user_id, A.id, `${name} row belongs to them`);
  assert.equal(T.cards[0].id, cardA);
  assert.ok(raw.includes('ALPHA'));
  assert.ok(!raw.includes('BETA'), "nothing of Beth's");
  assert.ok(!raw.includes(B.id));
  assert.deepEqual(T.library_docs.map(r => r.id), ['half-ALPHA', 'lib-ALPHA'], 'both of their documents, none of Beth\'s');
  assert.deepEqual(out.files, [{ id: 'lib-ALPHA', title: 'Paper ALPHA', filename: 'p.pdf', mime: 'application/pdf', size: 10, download: '/api/p/library/docs/lib-ALPHA/file' }], 'an upload that did not finish has no file to download');
  for (const internal of ['r2_key', 'upload_id', 'parts_json', 'up-secret-id', 'u/' + A.id + '/']) assert.ok(!raw.includes(internal), `the export must not contain ${internal}`);
  assert.ok(!raw.includes('chunk ALPHA'), 'the index (pages and passages) is rebuilt from the files, not exported');
  // never secrets
  const token = new URL(conn.data.url).pathname.split('/').pop();
  for (const secret of ['SEALED-SECRET-XYZ', 'password_hash', 'pbkdf2', token, A.c.jar.csrf, A.c.jar.cookie.split('=')[1], 'adam@example.com', 'sealed', 'credentials', 'auth_codes', 'rate_limits', 'connector_keys', 'ai_keys']) {
    assert.ok(!raw.includes(secret), `the export must not contain ${secret}`);
  }
  assert.ok(!('sessions' in T) && !('credentials' in T) && !('ai_keys' in T) && !('connector_keys' in T));
  assert.equal((await client(env).call('GET', '/api/p/me/export')).status, 401);
  d.close();
});

test('delete: wrong password refused; the right one signs out everywhere at once and revokes connector links', async () => {
  const { d, env } = platformEnv({ LIBRARY: fakeR2() });
  const { c, id, password } = await signedIn(env, 'Adam', { profile: 'gcse' });
  const second = client(env);
  assert.equal((await second.call('POST', '/api/auth/login', { username: id, password })).status, 200, 'a second browser is signed in');
  const conn = await c.call('POST', '/api/p/connector', { label: 'Claude' });
  const path = new URL(conn.data.url).pathname;
  const rpc = body => worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, { waitUntil() {} });
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);

  const wrong = await c.call('POST', '/api/p/me/delete', { password: 'not my password' });
  assert.equal(wrong.status, 401);
  assert.equal((await c.call('POST', '/api/p/me/delete', {})).status, 401);
  assert.equal((await c.call('GET', '/api/p/me')).status, 200, 'still signed in after a wrong password');
  assert.equal((await env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(id).first()).status, 'active');

  const done = await c.call('POST', '/api/p/me/delete', { password });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.ok, true);
  assert.match(done.data.message, /24 hours/);
  assert.match(done.headers.get('Set-Cookie'), /Max-Age=0/, 'the cookie is cleared');
  assert.equal(c.jar.cookie, null);
  assert.equal((await env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(id).first()).status, 'deleted');
  assert.equal((await second.call('GET', '/api/p/me')).status, 401, 'every other browser is out at once');
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404, 'the connector link is dead');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM connector_keys WHERE user_id = ? AND revoked_at IS NULL').bind(id).first()).n, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL').bind(id).first()).n, 0);
  assert.equal((await client(env).call('POST', '/api/auth/login', { username: id, password })).status, 401, 'and the password no longer works');
  d.close();
});

test('delete: wrong passwords are rate limited', async () => {
  const { d, env } = platformEnv();
  const { c, password } = await signedIn(env, 'Adam');
  for (let i = 0; i < 6; i++) assert.equal((await c.call("POST", "/api/p/me/delete", { password: "nope" + i })).status, 401);
  assert.equal((await c.call('POST', '/api/p/me/delete', { password: 'nope' })).status, 429);
  assert.equal((await c.call('POST', '/api/p/me/delete', { password })).status, 429, 'even the right one waits');
  d.close();
});

test('purgeDeleted removes every row and file of a deleted account and nothing of anyone else', async () => {
  const { d, env } = platformEnv({ LIBRARY: fakeR2(), LIBRARY_VEC: fakeVec() });
  const A = await signedIn(env, 'Adam', { profile: 'gcse' });
  const B = await signedIn(env, 'Beth', { profile: 'gcse' });
  await seed(env, A.c, A.id, 'ALPHA');
  await seed(env, B.c, B.id, 'BETA');
  const pidA = (await env.DB.prepare('SELECT pid FROM library_passages WHERE user_id = ?').bind(A.id).first()).pid;
  assert.equal(env.LIBRARY_VEC.rows.size, 2);
  await env.DB.prepare("INSERT INTO ai_usage (user_id, day, provider, usd, calls) VALUES (?, '2026-10-25', 'workers_ai', 0.01, 2)").bind(A.id).run();
  await A.c.call('PATCH', '/api/p/me', { name: 'Adam Two' });   // map_events rows
  const before = {};
  for (const t of me.PURGE_TABLES) before[t] = { a: await count(env, t, A.id), b: await count(env, t, B.id) };
  for (const t of ['cards', 'card_reviews', 'evidence', 'map_events', 'topic_scores', 'subjects', 'topics', 'gaps', 'result_logs', 'library_docs', 'library_pages', 'library_passages', 'library_links', 'library_terms', 'library_coverage', 'papers', 'credentials', 'sessions', 'ai_settings', 'ai_usage'])
    assert.ok(before[t].a > 0, `${t} has rows to purge`);

  assert.deepEqual(await me.purgeDeleted(env), [], 'an active account is never purged');
  assert.equal((await A.c.call('POST', '/api/p/me/delete', { password: A.password })).status, 200);
  assert.ok(await count(env, 'cards', A.id) > 0, 'the rows wait for the cron');
  assert.deepEqual(await me.purgeDeleted(env), [A.id]);

  for (const t of me.PURGE_TABLES) {
    assert.equal(await count(env, t, A.id), 0, `${t} of the deleted account is gone`);
    assert.equal(await count(env, t, B.id), before[t].b, `${t} of the other account is untouched`);
  }
  assert.equal(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(A.id).first(), null);
  assert.ok(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(B.id).first());
  assert.deepEqual([...env.LIBRARY.objects.keys()].sort(), [`u/${B.id}/extra-BETA`, `u/${B.id}/half-BETA/raw/00001.json`, `u/${B.id}/lib-BETA/file.pdf`].sort(), 'only the deleted account\'s R2 prefix went');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM library_fts_docsize').first()).n, 1, "Adam's FTS rows are gone and Beth's stay");
  assert.deepEqual(env.LIBRARY_VEC.deleted.sort(), [`p${pidA}`], "Adam's Vectorize vectors went, Beth's stay");
  assert.equal(env.LIBRARY_VEC.rows.size, 1);
  assert.ok((await env.DB.prepare("SELECT rowid FROM library_fts WHERE library_fts MATCH 'chunk' ").all()).results.length === 1, 'the search index still finds Beth\'s passage only');
  assert.deepEqual(await me.purgeDeleted(env), []);
  assert.equal((await B.c.call('GET', '/api/p/cards/due')).status, 200);
  d.close();
});

test('purgeDeleted pages through a big R2 prefix and works without an R2 binding', async () => {
  const { d, env } = platformEnv({ LIBRARY: fakeR2() });
  const A = await signedIn(env, 'Adam');
  for (let i = 0; i < 2300; i++) await env.LIBRARY.put(`u/${A.id}/f${i}`, new Uint8Array(1));
  await env.LIBRARY.put('u/someone-else/keep', new Uint8Array(1));
  await A.c.call('POST', '/api/p/me/delete', { password: A.password });
  await me.purgeDeleted(env);
  assert.deepEqual([...env.LIBRARY.objects.keys()], ['u/someone-else/keep']);
  d.close();
  const bare = platformEnv();
  const B = await signedIn(bare.env, 'Beth');
  await B.c.call('POST', '/api/p/me/delete', { password: B.password });
  assert.deepEqual(await me.purgeDeleted(bare.env), [B.id]);
  bare.d.close();
});

test('PURGE_TABLES covers every table that has a user_id column, so a new table cannot be forgotten', async () => {
  const { d, env } = platformEnv();
  const { results } = await env.DB.prepare("SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND p.name = 'user_id'").all();
  const have = new Set(me.PURGE_TABLES);
  const missing = results.map(r => r.name).filter(n => !have.has(n));
  assert.deepEqual(missing, []);
  for (const t of me.PURGE_TABLES) assert.ok(results.some(r => r.name === t), `${t} exists with a user_id`);
  d.close();
});

test('self-check: exam date, only while the countdown is on', async () => {
  const { d, env } = platformEnv();
  const { c } = await signedIn(env, 'Adam', { profile: 'gcse' });
  const exam = async () => (await c.call('GET', '/api/p/self-check')).data.items.find(i => i.id === 'exam_date');
  await c.call('PATCH', '/api/p/me', { exam_date: null });
  const me0 = (await c.call('GET', '/api/p/me')).data;
  if (!me0.exam_date) assert.match((await exam()).says, /not set/);
  await c.call('PATCH', '/api/p/me', { exam_date: '2027-06-14' });
  assert.match((await exam()).says, /2027-06-14/);
  await c.call('PATCH', '/api/p/me', { modules: { countdown: false } });
  assert.equal(await exam(), undefined);
  d.close();
});

test('GET /api/p/me says whether their Claude has reached the hub (the Anki push key aside); only their own links count', async () => {
  const { d, env } = platformEnv({ ANKI_LINK: '1' });
  const a = await signedIn(env, 'Alex', { profile: 'alevel' });
  const b = await signedIn(env, 'Sam', { profile: 'gcse' });
  assert.deepEqual((await a.c.call('GET', '/api/p/me')).data.claude, { links: 0, last_used_at: null });
  const link = new URL((await a.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  assert.deepEqual((await a.c.call('GET', '/api/p/me')).data.claude, { links: 1, last_used_at: null }, 'made, not used yet');
  await worker.fetch(new Request(BASE + link, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), env, { waitUntil() {} });
  const after = (await a.c.call('GET', '/api/p/me')).data.claude;
  assert.equal(after.links, 1);
  assert.ok(after.last_used_at > 0, 'used once their Claude calls the connector');
  assert.match((await a.c.call('GET', '/api/p/self-check')).data.items.find(i => i.id === 'connector').says, /has reached your hub/);
  assert.deepEqual((await b.c.call('GET', '/api/p/me')).data.claude, { links: 0, last_used_at: null }, "Sam's status is his own");
  d.close();
});
