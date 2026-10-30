// Their own copy (30 Oct): owner mode (the first visitor with the SETUP_CODE makes the only account, then the door
// shuts for good) and moving their export in from the shared Study Hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { BASE, platformEnv, signedIn, client } from './platform-helpers.mjs';
import { MOVE_TABLES } from '../../worker/src/platform/move.js';

const CODE = 'blue-river-candle-42';
const own = () => platformEnv({ SETUP_CODE: CODE });
const claim = (c, body = {}) => c.call('POST', '/api/auth/claim', { setup_code: CODE, name: 'Sam', profile: 'university', password: 'sam-own-password', ...body });

test('claim: shut on a hub without a SETUP_CODE (Mo\'s shared hub) or with a short one', async () => {
  for (const over of [{}, { SETUP_CODE: 'short' }]) {
    const { d, env } = platformEnv(over);
    const c = client(env);
    assert.deepEqual((await c.call('GET', '/api/auth/claim')).data, { open: false });
    const r = await claim(c, { setup_code: over.SETUP_CODE || '' });
    assert.equal(r.status, 404);
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM credentials').first()).n, 0);
    d.close();
  }
});

test('claim: the right code makes the only account and signs in; then the door is shut', async () => {
  const { d, env } = own();
  const c = client(env);
  assert.deepEqual((await c.call('GET', '/api/auth/claim')).data, { open: true });
  const wrong = await claim(c, { setup_code: 'not-the-code-at-all' });
  assert.equal(wrong.status, 401);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE id != ?').bind('mo').first()).n, 0, 'a wrong code makes nothing');
  const r = await claim(c);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.user, /^sam-[a-z0-9]{4}$/);
  assert.equal(r.data.profile, 'university');
  assert.match(r.headers.get('Set-Cookie'), /HttpOnly/);
  const me = await c.call('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user, r.data.user);
  assert.equal(me.data.must_change, false);
  assert.equal((await c.call('GET', '/api/p/me')).status, 200);
  // shut for good: the same code, a fresh browser
  const other = client(env);
  assert.deepEqual((await other.call('GET', '/api/auth/claim')).data, { open: false });
  const again = await claim(other, { name: 'Eve' });
  assert.equal(again.status, 403);
  assert.equal(again.headers.get('Set-Cookie'), null);
  // they sign in normally afterwards
  const signIn = await client(env).call('POST', '/api/auth/login', { username: r.data.user, password: 'sam-own-password' });
  assert.equal(signIn.status, 200);
  d.close();
});

test('claim: two at once, exactly one gets in', async () => {
  const { d, env } = own();
  const [a, b] = await Promise.all([claim(client(env), { name: 'Ann' }), claim(client(env), { name: 'Ben' })]);
  assert.deepEqual([a.status, b.status].sort(), [201, 403]);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM credentials').first()).n, 1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id != 'mo'").first()).n, 1, 'the loser leaves no account behind');
  d.close();
});

test('claim: wrong codes are rate limited by address; bad names, passwords and tracks are refused', async () => {
  const { d, env } = own();
  const c = client(env);
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await claim(c, { setup_code: `wrong-${i}-xxxxxxxx` })).status);
  assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(codes[6], 429);
  assert.equal((await claim(c)).status, 429, 'even the right code waits out the lock');
  const c2 = client(env);
  const fresh = (b) => c2.call('POST', '/api/auth/claim', { setup_code: CODE, name: 'Sam', profile: 'gcse', password: 'sam-own-password', ...b }, { headers: { 'CF-Connecting-IP': '9.9.9.9' } });
  assert.equal((await fresh({ password: 'short' })).status, 400);
  assert.equal((await fresh({ name: '' })).status, 400);
  assert.equal((await fresh({ profile: 'step2' })).status, 400, "Mo's track is never offered");
  assert.equal((await fresh({ id: 'mo' })).status, 400, "Mo's id is never taken");
  assert.equal((await fresh({ id: 'Bad Name!' })).status, 400);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM credentials').first()).n, 0);
  d.close();
});

test('move in: the export from the shared hub lands in their own copy under the same login name', async () => {
  // the shared hub: Adam with a subject, topic, card (reviewed), mnemonic and chat note
  const shared = platformEnv();
  const A = await signedIn(shared.env, 'Adam', { profile: 'gcse' });
  const run = (sql, ...b) => shared.env.DB.prepare(sql).bind(...b).run();
  const t = Date.now();
  await run(`INSERT INTO subjects (user_id, id, track, subject, name, created_at, updated_at) VALUES (?, 'gcse-biology', 'gcse', 'biology', 'Biology', ?, ?)`, A.id, t, t);
  await run(`INSERT INTO topics (user_id, id, name, kind, status, category_id, source, created_by, created_at, updated_at) VALUES (?, 'gcse-biology.cells', 'Cells', 'concept', 'confirmed', 'gcse-biology', 'test', 'mo', ?, ?)`, A.id, t, t);
  const card = (await A.c.call('POST', '/api/p/cards', { front: 'What is a cell?', back: 'The unit of life.', topic_id: 'gcse-biology.cells' })).data.card.id;
  await A.c.call('POST', `/api/p/cards/${card}/review`, { rating: 3 });
  await A.c.call('POST', '/api/p/chats', { text: 'We covered cells.', topic_id: 'gcse-biology.cells' });
  await A.c.call('POST', '/api/p/mnemonics', { cue: 'MRS GREN', about: 'Life processes', items: ['Movement', 'Respiration'], subject_id: 'gcse-biology' });
  await A.c.call('POST', '/api/p/activity', { seconds: 60 });
  const raw = await worker.fetch(new Request(BASE + '/api/p/me/export', { headers: { Cookie: A.c.jar.cookie } }), shared.env, { waitUntil() {} });
  const data = JSON.parse(await raw.text());
  assert.ok(data.tables.mnemonics.length >= 1, 'mnemonics are in the export now');

  // moving in is only for their own copy
  assert.equal((await A.c.call('POST', '/api/p/me/import', { table: 'cards', rows: [] })).status, 404);

  const { d, env } = own();
  const c = client(env);
  const r = await claim(c, { name: data.account.name, profile: data.account.track, id: data.user, profile_json: data.account.profile, prefs: data.account.settings });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.user, A.id, 'the same login name');
  let added = 0;
  for (const [table, rows] of Object.entries(data.tables)) {
    if (!rows.length) continue;
    const res = await c.call('POST', '/api/p/me/import', { table, rows });
    if (MOVE_TABLES.includes(table)) { assert.equal(res.status, 200, `${table}: ${JSON.stringify(res.data)}`); added += res.data.added; }
    else assert.equal(res.status, 400, `${table} is not moved in`);
  }
  assert.ok(added > 5);
  // the same again adds nothing (never over a row that is there)
  assert.equal((await c.call('POST', '/api/p/me/import', { table: 'cards', rows: data.tables.cards })).data.added, 0);
  // their hub shows it
  const subj = await c.call('GET', '/api/p/subjects');
  assert.ok(JSON.stringify(subj.data).includes('Biology'));
  const due = await c.call('GET', '/api/p/cards');
  assert.ok(JSON.stringify(due.data).includes('What is a cell?'));
  assert.ok(JSON.stringify((await c.call('GET', '/api/p/chats')).data).includes('cells'));
  assert.ok(JSON.stringify((await c.call('GET', '/api/p/mnemonics')).data).includes('MRS GREN'));
  assert.equal((await c.call('GET', '/api/p/activity?days=30')).data.stats.total_days, 1);
  shared.d.close();
  d.close();
});

test('move in: rows are always theirs, only known columns, only tables an export holds', async () => {
  const { d, env } = own();
  const c = client(env);
  const me = (await claim(c)).data.user;
  const t = Date.now();
  const bad = await c.call('POST', '/api/p/me/import', { table: 'subjects', rows: [{ user_id: 'someone-else', id: 'gcse-maths', track: 'gcse', subject: 'maths', name: 'Maths', created_at: t, updated_at: t, evil: 'x' }] });
  assert.equal(bad.status, 200, JSON.stringify(bad.data));
  const row = await env.DB.prepare("SELECT user_id FROM subjects WHERE id = 'gcse-maths'").first();
  assert.equal(row.user_id, me);
  for (const table of ['credentials', 'sessions', 'connector_keys', 'users', 'ai_keys', 'library_docs', 'study_pictures', 'subjects; DROP TABLE cards']) {
    assert.equal((await c.call('POST', '/api/p/me/import', { table, rows: [] })).status, 400, table);
  }
  assert.equal((await c.call('POST', '/api/p/me/import', { table: 'cards', rows: 'x' })).status, 400);
  assert.equal((await c.call('POST', '/api/p/me/import', { table: 'cards', rows: Array(1001).fill({}) })).status, 400);
  assert.equal((await client(env).call('POST', '/api/p/me/import', { table: 'cards', rows: [] })).status, 401);
  d.close();
});
