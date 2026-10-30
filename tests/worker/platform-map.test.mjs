import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, getMap, putPositions } from '../../worker/src/platform/map.js';
import { writeBatch } from '../../worker/src/map/events.js';
import { decode } from '../../public/js/map/data.js';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';

const session = (user, profile, prefs = {}) => ({ user, profile, prefs_json: JSON.stringify(prefs), csrf: 'x', must_change: false });

async function call(handler, env, user, sess, { method = 'GET', path = '/api/p/map', body, headers = {} } = {}) {
  const url = new URL(BASE + path);
  const req = new Request(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const res = await handler(req, env, { waitUntil() {} }, {}, url, user, sess);
  const text = await res.text();
  return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
}

// Two people with their own subjects and topics (A: A-level Biology, B: GCSE Maths).
async function twoPeople() {
  const { env } = platformEnv();
  const a = await signedIn(env, 'Sara', { profile: 'alevel' });
  const b = await signedIn(env, 'Adam', { profile: 'gcse' });
  const add = async (p, sid, section, names) => {
    const r = await p.c.call('POST', `/api/p/subjects/${sid}/topics`, { sections: [{ name: section, topics: names.map(name => ({ name })) }] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  };
  await add(a, 'alevel-biology', 'Biological molecules', ['Enzymes', 'Proteins', 'Lipids']);
  await add(a, 'alevel-chemistry', 'Energetics', ["Hess's law"]);
  await add(b, 'gcse-maths', 'Algebra', ['Quadratic equations', 'Sequences']);
  // These tests read the subject layout (one galaxy a subject); the sections default has its own test below.
  for (const p of [a, b]) await p.c.call('PATCH', '/api/p/custom', { patch: { map: { group_by: 'subject' } } });
  const subj = async p => (await p.c.call('GET', `/api/p/subjects/${p === a ? 'alevel-biology' : 'gcse-maths'}`)).data;
  const topicOf = async (p, name) => (await subj(p)).sections.flatMap(s => s.topics).find(t => t.name === name);
  return { env, a, b, sa: session(a.id, 'alevel'), sb: session(b.id, 'gcse'), topicOf };
}

test('ROUTES: the map and its positions, both under /api/p/', () => {
  assert.deepEqual(ROUTES.map(([m, p]) => `${m} ${p}`), ['GET /api/p/map', 'GET /api/p/map/beads', 'PUT /api/p/map/positions']);
  for (const [, p, h] of ROUTES) { assert.ok(p.startsWith('/api/p/')); assert.equal(typeof h, 'function'); }
});

test('GET /api/p/map: the person\'s subjects as galaxies and their topics placed, in Mo\'s payload shape, with ETag and 304', async () => {
  const { env, a, sa, topicOf } = await twoPeople();
  const enz = await topicOf(a, 'Enzymes');
  // One wrong past-paper answer on Enzymes: it is seen and coloured.
  await writeBatch(env, a.id, { actor: 'code', surface: 'code', via: 'test', events: [], evidence: { upsert: [{ obs_key: `t:${enz.id}`, kind: 'question', at: Date.now(),
    day: '2026-10-25', source: 'past_paper', topic_id: enz.id, category_id: 'alevel-biology', result: 'wrong', detail_json: '{}' }] } });

  const r = await call(getMap, env, a.id, sa);
  assert.equal(r.status, 200);
  const p = r.data;
  assert.equal(p.v, 2);
  assert.equal(p.meta.user, a.id);
  assert.ok(Array.isArray(p.meta.bands) && p.meta.bands.some(b => b[1] === 'Very weak'), 'band words come with the payload');
  const catIds = p.categories.map(c => c[1]).sort();
  assert.deepEqual(catIds, ['alevel-biology', 'alevel-chemistry', 'alevel-psychology']);
  const m = decode(p);
  assert.equal(m.n, 4);
  for (let i = 0; i < m.n; i++) assert.equal(m.placed[i], 1, `${m.name[i]} has a position`);
  const i = m.index.get(enz.id);
  assert.ok(i != null && m.t[i] >= 0, 'Enzymes is seen and has a colour');
  assert.equal(m.cats[m.cat[i]].id, 'alevel-biology');
  const tag = r.headers.get('ETag');
  assert.match(tag, /^W\/"m\d+-/);
  assert.equal(r.headers.get('Cache-Control'), 'private, no-store');
  const again = await call(getMap, env, a.id, sa, { headers: { 'If-None-Match': tag } });
  assert.equal(again.status, 304);
});

test('isolation: B never sees A\'s topics or subjects, by the full map or by ?ids, and cannot move them', async () => {
  const { env, a, b, sa, sb, topicOf } = await twoPeople();
  const enz = await topicOf(a, 'Enzymes');
  const pa = (await call(getMap, env, a.id, sa)).data;
  const pb = (await call(getMap, env, b.id, sb)).data;
  const aIds = new Set(pa.topics.map(t => t[1]));
  assert.ok(aIds.has(enz.id));
  for (const t of pb.topics) assert.ok(!aIds.has(t[1]), `B sees A's topic ${t[1]}`);
  assert.deepEqual(pb.categories.map(c => c[1]).sort(), ['gcse-combined_science', 'gcse-english_language', 'gcse-english_literature', 'gcse-maths']);
  assert.ok(!JSON.stringify(pb).includes('Enzymes'));
  assert.equal(pb.meta.user, b.id);

  const ids = await call(getMap, env, b.id, sb, { path: `/api/p/map?ids=${encodeURIComponent(enz.id)}` });
  assert.equal(ids.status, 200);
  assert.deepEqual(ids.data.topics, []);
  assert.deepEqual(ids.data.gone, [enz.id]);

  // B saves a "layout" naming A's topic: nothing of A's moves.
  const before = pa.topics.find(t => t[1] === enz.id).slice(6, 8);
  const put = await call(putPositions, env, b.id, sb, { method: 'PUT', path: '/api/p/map/positions', body: { layout_version: 3, topics: [[enz.id, 4321, 1234]], categories: [] } });
  assert.equal(put.status, 200);
  const after = (await call(getMap, env, a.id, sa)).data.topics.find(t => t[1] === enz.id).slice(6, 8);
  assert.deepEqual(after, before);
  assert.ok(!(await call(getMap, env, b.id, sb)).data.topics.some(t => t[1] === enz.id));
});

test('PUT /api/p/map/positions: the first layout of a version is saved and drawn; a second save of it is not applied', async () => {
  const { env, a, sa } = await twoPeople();
  const p = (await call(getMap, env, a.id, sa)).data;
  const topics = p.topics.map((t, k) => [t[1], 100 + k * 30, -50 + k * 10]);
  const categories = p.categories.map((c, k) => [c[1], k * 400, 0]);
  const put = await call(putPositions, env, a.id, sa, { method: 'PUT', path: '/api/p/map/positions', body: { layout_version: 3, topics, categories } });
  assert.equal(put.status, 200);
  assert.equal(put.data.applied, true);
  const p2 = (await call(getMap, env, a.id, sa)).data;
  assert.equal(p2.meta.layout_version, 3);
  for (const [id, x, y] of topics) {
    const row = p2.topics.find(t => t[1] === id);
    assert.deepEqual([row[6], row[7]], [x, y]);
  }
  const twice = await call(putPositions, env, a.id, sa, { method: 'PUT', path: '/api/p/map/positions', body: { layout_version: 3, topics: topics.map(([id]) => [id, 0, 0]), categories } });
  assert.equal(twice.data.applied, false);
  // A bad body is a 400 in plain words (routes.js turns the HttpError into the reply).
  await assert.rejects(call(putPositions, env, a.id, sa, { method: 'PUT', path: '/api/p/map/positions', body: { layout_version: 3, topics: [['x', 'far', 0]] } }), e => e.status === 400);
});

test('gates: the map is always on; Mo\'s id and a session for someone else are refused', async () => {
  const { env, a, b, sa } = await twoPeople();
  const off = await call(getMap, env, a.id, session(a.id, 'alevel', { modules: { map: false, results: false, cards: false, library: false } }));
  assert.equal(off.status, 200, 'the map cannot be switched off');
  await assert.rejects(call(getMap, env, 'mo', session('mo', 'step2')), e => e.status === 401);
  await assert.rejects(call(getMap, env, b.id, sa), e => e.status === 401, 'a session must be the user\'s own');
  await assert.rejects(call(putPositions, env, a.id, null, { method: 'PUT', path: '/api/p/map/positions', body: { layout_version: 3, topics: [] } }), e => e.status === 401);
});

test('by default sections are the galaxies, each subject a family of them (Mo\'s donut); positions cleared once for it', async () => {
  const { env } = platformEnv();
  const a = await signedIn(env, 'Sara', { profile: 'alevel' });
  await a.c.call('POST', '/api/p/subjects/alevel-biology/topics', { sections: [{ name: 'Cells', topics: [{ name: 'Mitosis' }] }, { name: 'Exchange', topics: [{ name: 'Lungs' }] }] });
  await a.c.call('POST', '/api/p/subjects/alevel-chemistry/topics', { sections: [{ name: 'Energetics', topics: [{ name: 'Enthalpy' }] }] });
  const p = (await a.c.call('GET', '/api/p/map')).data;
  assert.equal(p.categories.length, 3, 'one galaxy a section');
  assert.deepEqual(p.families.map(f => [f.name, f.members.length]), [['Biology', 2], ['Chemistry', 1]]);
  assert.ok(p.groups.every(g => g.kind === 'section'));
  const beads = await a.c.call('GET', '/api/p/map/beads');
  assert.equal(beads.status, 200);
  assert.deepEqual(Object.keys(beads.data).sort(), ['cards', 'mnemonics']);
});
