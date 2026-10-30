// Study Hub v2 galaxies (docs/platform/v2-plan.md 2.1, WP2): a person's own named groups of topics on their map, made
// in the app (POST /api/p/galaxies) or by their Claude (galaxy_edit). One change is one undo; topics stay in their
// subject everywhere but the map; the map regroups and lays out again; nothing reaches anyone else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';
import { regroup } from '../../worker/src/platform/map.js';
import { getMap } from '../../worker/src/platform/map.js';

const rpc = async (env, path, name, args) => {
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} });
  return (await res.json()).result;
};

async function setup() {
  const { d, env } = platformEnv();
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  await alex.c.call('POST', '/api/p/subjects/alevel-biology/topics', { sections: [{ name: 'Biological molecules', topics: [{ name: 'Enzymes' }, { name: 'Lipids' }] }, { name: 'Energy transfers', topics: [{ name: 'Respiration' }, { name: 'Photosynthesis' }] }] });
  await alex.c.call('POST', '/api/p/subjects/alevel-chemistry/topics', { sections: [{ name: 'Physical chemistry', topics: [{ name: 'Enthalpy' }, { name: 'Kinetics' }] }] });
  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  // These tests read the subject layout (one galaxy a subject); platform-map.test.mjs covers the sections default.
  await alex.c.call('PATCH', '/api/p/custom', { patch: { map: { group_by: 'subject' } } });
  return { d, env, alex, sam, link };
}
const post = (who, ops) => who.c.call('POST', '/api/p/galaxies', { ops });
const mapOf = async who => (await who.c.call('GET', '/api/p/map')).data;
const catOf = (m, name) => { const t = m.topics.find(x => x[2] === name); return m.categories[t[4]][2]; };
const positions = (d, user) => d.rows('SELECT COUNT(*) AS n FROM topic_positions WHERE user_id = ? AND pinned = 0', user)[0].n;

test('make a galaxy in the app: topics move on the map only; one undo puts it all back', async () => {
  const s = await setup();
  const r = await post(s.alex, [{ op: 'create', title: 'Energy', topics: ['Respiration', 'Photosynthesis', 'Enthalpy'] }]);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.created.title, r.data.galaxies[0].n], ['Energy', 3]);
  assert.match(r.data.changed, /made Energy/);
  const m = await mapOf(s.alex);
  assert.equal(catOf(m, 'Respiration'), 'Energy');
  assert.equal(catOf(m, 'Enthalpy'), 'Energy', 'a galaxy can mix subjects');
  assert.equal(catOf(m, 'Enzymes'), 'Biology', 'the rest stay in their subject');
  const gi = m.categories.findIndex(c => c[2] === 'Energy');
  assert.equal(m.groups[gi].kind, 'galaxy');
  const resp = m.topics.find(x => x[2] === 'Respiration');
  assert.deepEqual(m.home[resp[1]], ['alevel-biology', 'Biology'], 'its home subject travels with it');
  // Everywhere else it is still a Biology topic.
  const bio = (await s.alex.c.call('GET', '/api/p/subjects/alevel-biology')).data;
  assert.ok(bio.sections.flatMap(x => x.topics).some(t => t.name === 'Respiration'));
  // The galaxy page and the topic list.
  const one = (await s.alex.c.call('GET', `/api/p/galaxies/${r.data.created.id}`)).data;
  assert.deepEqual(one.subjects.map(x => [x.name, x.topics.length]), [['Biology', 2], ['Chemistry', 1]]);
  const list = (await s.alex.c.call('GET', '/api/p/topics')).data.topics;
  assert.equal(list.find(t => t.name === 'Enthalpy').galaxy.title, 'Energy');
  assert.equal(list.find(t => t.name === 'Enzymes').galaxy, null);
  // One undo.
  assert.equal((await s.alex.c.call('POST', '/api/p/undo', { batch_id: r.data.batch_id })).status, 200);
  assert.equal(catOf(await mapOf(s.alex), 'Respiration'), 'Biology');
  assert.deepEqual((await s.alex.c.call('GET', '/api/p/galaxies')).data.galaxies, []);
  s.d.close();
});

test('rename, add (moves), remove, delete and order; positions cleared except after a rename', async () => {
  const s = await setup();
  await post(s.alex, [{ op: 'create', title: 'Energy', topics: ['Respiration'] }, { op: 'create', title: 'Mock 1', topics: ['Enzymes'] }]);
  await mapOf(s.alex);
  await s.d.env.DB.prepare("INSERT OR IGNORE INTO topic_positions (user_id, kind, ref_id, x, y, pinned, layout_version, updated_at) SELECT user_id, 'topic', id, 1, 1, 0, 4, 1 FROM topics WHERE user_id = ?").bind(s.alex.id).run();
  const before = positions(s.d, s.alex.id);
  assert.ok(before > 0);
  await post(s.alex, [{ op: 'rename', galaxy: 'Energy', title: 'Bioenergetics' }]);
  assert.equal(positions(s.d, s.alex.id), before, 'a rename keeps the layout');
  let r = await post(s.alex, [{ op: 'add', galaxy: 'Mock 1', topics: ['Respiration'] }]);
  assert.match(r.data.changed, /moved Respiration into Mock 1/);
  assert.equal(positions(s.d, s.alex.id), 0, 'a move lays the map out again');
  assert.equal(r.data.galaxies.find(g => g.title === 'Bioenergetics').n, 0, 'one galaxy per topic');
  r = await post(s.alex, [{ op: 'remove', topics: ['Enzymes'] }]);
  assert.equal(catOf(await mapOf(s.alex), 'Enzymes'), 'Biology');
  r = await post(s.alex, [{ op: 'order', order: ['Mock 1', 'Chemistry'] }]);
  assert.deepEqual(r.data.order.slice(0, 2).map(x => x.title), ['Mock 1', 'Chemistry']);
  const m = await mapOf(s.alex);
  assert.deepEqual(m.categories.slice(0, 2).map(c => c[2]), ['Mock 1', 'Chemistry'], 'the map follows her order');
  assert.equal((await s.alex.c.call('GET', '/api/p/subjects')).data.subjects[0].name, 'Chemistry', 'and so do her subjects');
  r = await post(s.alex, [{ op: 'delete', galaxy: 'Mock 1' }]);
  assert.equal(catOf(await mapOf(s.alex), 'Respiration'), 'Biology', 'deleting sends its topics home');
  assert.equal((await s.alex.c.call('POST', '/api/p/undo', { batch_id: r.data.batch_id })).status, 200);
  assert.equal(catOf(await mapOf(s.alex), 'Respiration'), 'Mock 1', 'undo brings it back whole');
  s.d.close();
});

test('limits and plain refusals', async () => {
  const s = await setup();
  for (const [ops, re] of [
    [[{ op: 'create', title: 'x'.repeat(41) }], /40 characters/],
    [[{ op: 'create', title: 'Biology' }], /one of your subjects/],
    [[{ op: 'create', title: 'Which of the following is true?' }], /exam question/],
    [[{ op: 'rename', galaxy: 'Nope', title: 'X' }], /no galaxy called Nope/],
    [[{ op: 'fly' }], /op is one of/],
  ]) {
    const r = await post(s.alex, ops);
    assert.ok(r.status >= 400, JSON.stringify(ops));
    assert.match(r.data.error, re);
  }
  await post(s.alex, [{ op: 'create', title: 'Energy' }]);
  assert.match((await post(s.alex, [{ op: 'create', title: 'energy' }])).data.error, /already have a galaxy/);
  const ops = Array.from({ length: 10 }, (_, i) => ({ op: 'create', title: `G${i}` }));
  await post(s.alex, ops); await post(s.alex, ops.map(o => ({ ...o, title: o.title + 'b' })));
  const r = await post(s.alex, Array.from({ length: 10 }, (_, i) => ({ op: 'create', title: `H${i}` })));
  assert.match(r.data.error, /30 galaxies/);
  const empty = (await s.alex.c.call('GET', '/api/p/galaxies')).data.galaxies.find(g => g.title === 'Energy');
  assert.equal(empty.n, 0, 'empty galaxies are listed');
  assert.ok(!(await mapOf(s.alex)).categories.some(c => c[2] === 'Energy'), 'but not drawn');
  s.d.close();
});

test('her Claude: galaxy_edit makes a galaxy with brand-new topics in one change undo_change reverses; ambiguous names ask', async () => {
  const s = await setup();
  const r = await rpc(s.env, s.link, 'galaxy_edit', { ops: [{ op: 'create', title: 'Mock 1' }, { op: 'new_topics', galaxy: 'Mock 1', subject: 'Biology', section: 'Cells', names: ['Cell cycle checkpoints', 'Meiosis'] }, { op: 'add', galaxy: 'Mock 1', topics: ['Enzymes'] }] });
  assert.ok(!r.isError, JSON.stringify(r));
  const sc = r.structuredContent;
  assert.match(sc.changed, /made Mock 1; added 2 new Biology topics/);
  assert.equal(sc.galaxies[0].n, 3);
  assert.equal(catOf(await mapOf(s.alex), 'Meiosis'), 'Mock 1');
  assert.ok(s.d.rows("SELECT name FROM units WHERE user_id = ? AND name = 'Cells'", s.alex.id).length, 'the new section is made in Biology');
  assert.equal(s.d.rows("SELECT created_by FROM galaxies WHERE user_id = ?", s.alex.id)[0].created_by, 'claude');
  const u = await rpc(s.env, s.link, 'undo_change', { batch_id: sc.batch_id });
  assert.ok(!u.isError, JSON.stringify(u));
  assert.deepEqual((await s.alex.c.call('GET', '/api/p/galaxies')).data.galaxies, []);
  assert.ok(!(await s.alex.c.call('GET', '/api/p/topics')).data.topics.some(t => t.name === 'Meiosis'), 'the new topics go too');
  // A name in two subjects.
  await s.alex.c.call('POST', '/api/p/subjects/alevel-chemistry/topics', { sections: [{ name: 'Organic', topics: [{ name: 'Enzymes' }] }] });
  const amb = await rpc(s.env, s.link, 'galaxy_edit', { ops: [{ op: 'create', title: 'Catalysts', topics: ['Enzymes'] }] });
  assert.equal(amb.structuredContent.ambiguous[0].candidates.length, 2);
  const list = await rpc(s.env, s.link, 'galaxy_edit', {});
  assert.deepEqual(list.structuredContent.galaxies.map(g => g.title), ['Catalysts']);
  s.d.close();
});

test('clusters made through my_hub_change become galaxies the first time, and the map looks the same', async () => {
  const s = await setup();
  await rpc(s.env, s.link, 'my_hub_change', { patch: { map: { group_by: 'custom', clusters: [{ title: 'Energy', topics: ['Respiration', 'Photosynthesis'] }], order: ['Energy'] } } });
  const before = await mapOf(s.alex);
  assert.equal(catOf(before, 'Respiration'), 'Energy');
  const g = (await s.alex.c.call('GET', '/api/p/galaxies')).data;
  assert.deepEqual(g.galaxies.map(x => [x.title, x.n]), [['Energy', 2]]);
  assert.equal((await s.alex.c.call('GET', '/api/p/custom')).data.custom.map, undefined, 'the clusters moved out of Make it mine');
  const after = await mapOf(s.alex);
  assert.equal(catOf(after, 'Respiration'), 'Energy');
  assert.equal(after.categories[0][2], 'Energy', 'and still first');
  s.d.close();
});

test('ISOLATION: Sam never sees or changes Alex\'s galaxies, and her topic ids are not his', async () => {
  const s = await setup();
  const r = await post(s.alex, [{ op: 'create', title: 'Energy', topics: ['Respiration'] }]);
  assert.deepEqual((await s.sam.c.call('GET', '/api/p/galaxies')).data.galaxies, []);
  assert.equal((await s.sam.c.call('GET', `/api/p/galaxies/${r.data.created.id}`)).status, 404);
  const rid = (await s.alex.c.call('GET', '/api/p/topics')).data.topics.find(t => t.name === 'Respiration').id;
  const b = await post(s.sam, [{ op: 'create', title: 'Mine', topics: [rid] }]);
  assert.deepEqual(b.data.not_found, [rid]);
  assert.equal((await post(s.sam, [{ op: 'delete', galaxy: r.data.created.id }])).status, 404);
  assert.ok(!(await mapOf(s.sam)).categories.some(c => c[2] === 'Energy'));
  s.d.close();
});

test('regroup: galaxies by id first, ranks put galaxies and subjects in her order, sections follow their subject', () => {
  const p = { categories: [[0, 'bio', 'Biology', 'Bio'], [1, 'chem', 'Chemistry', 'Chem']], units: [[0, 'u1', 'Cells', 0, 0, 0], [1, 'u2', 'Energy', 0, 0, 1]],
    topics: [[0, 'a', 'Enzymes', 'E', 0, 0], [1, 'b', 'Respiration', 'R', 0, 1], [2, 'c', 'Enthalpy', 'H', 1, null]] };
  const out = regroup(p, { galaxies: [{ id: 'g1', title: 'Energy', topics: ['b', 'c'] }], ranks: { 'mine~g1': 0, chem: 1, bio: 2 } });
  assert.deepEqual(out.categories.map(c => c[2]), ['Energy', 'Biology']);
  assert.deepEqual(out.groups.map(g => g.kind), ['galaxy', 'subject']);
  assert.deepEqual(out.home, { b: ['bio', 'Biology'], c: ['chem', 'Chemistry'] });
  const sec = regroup(p, { group_by: 'section', galaxies: [{ id: 'g1', title: 'Energy', topics: ['c'] }], ranks: { bio: 0, 'mine~g1': 1, chem: 2 } });
  assert.deepEqual(sec.categories.map(c => c[2]), ['Bio: Cells', 'Bio: Energy', 'Energy']);
  assert.equal(regroup(p, { group_by: 'subject' }), p, 'nothing to change: the same payload');
});
