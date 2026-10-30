// Study Hub How it works, the live part (docs/platform/v2-plan.md 2.5, WP4): GET /api/p/guide gives the page a person's
// own subjects, counts and what is left to set up; hub_guide gives their Claude the same guide as text. Nothing of
// one person's reaches another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';

const rpc = async (env, path, name, args) => {
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} });
  return (await res.json()).result;
};
const out = r => JSON.parse(r.content[0].text);

async function setup() {
  const { d, env } = platformEnv();
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  await alex.c.call('POST', '/api/p/subjects/alevel-biology/topics', { sections: [{ name: 'Biological molecules', topics: [{ name: 'Enzymes' }, { name: 'Lipids' }] }] });
  await alex.c.call('PATCH', '/api/p/subjects/alevel-biology', { board: 'aqa' });
  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  return { d, env, alex, sam, link };
}

test('GET /api/p/guide: their track, subjects with boards, counts and what is left to set up', async () => {
  const { alex, sam } = await setup();
  const r = await alex.c.call('GET', '/api/p/guide');
  assert.equal(r.status, 200);
  const g = r.data;
  assert.equal(g.track, 'alevel');
  const bio = g.subjects.find(s => s.subject === 'biology');
  assert.equal(bio.board, 'aqa'); assert.equal(bio.board_name, 'AQA'); assert.equal(bio.topics_n, 2);
  assert.equal(g.counts.topics, 2); assert.equal(g.counts.galaxies, 0);
  for (const k of ['docs', 'cards_due', 'papers_to_sit', 'papers_marked']) assert.equal(typeof g.counts[k], 'number', k);
  assert.equal(g.setup.claude, false, 'a link that was never used is not connected');
  assert.ok(!g.setup.boards_missing.includes('Biology'));
  assert.ok(!g.setup.no_topics.includes('Biology'));
  assert.ok(g.setup.no_topics.length >= 1, 'the other subjects still need topics');
  assert.equal(typeof g.setup.exam_date, 'boolean');
  assert.equal(g.claude.links, 1);

  const b = (await sam.c.call('GET', '/api/p/guide')).data;
  assert.equal(b.track, 'gcse');
  assert.equal(b.counts.topics, 0);
  assert.ok(!b.subjects.some(s => s.subject === 'psychology'), 'Sam sees only his own subjects');
  assert.equal(b.claude.links, 0);
});

test('hub_guide: the guide as text under 8,000 characters, one subject on request, plain words for an unknown one', async () => {
  const { env, alex, link } = await setup();
  const all = out(await rpc(env, link, 'hub_guide', {}));
  assert.ok(all.guide.length <= 8000, `${all.guide.length} characters`);
  assert.match(all.guide, /Track: A-level/);
  assert.match(all.guide, /AQA required practicals/);
  assert.ok(all.still_to_set_up.some(x => /topics/.test(x)));
  const one = out(await rpc(env, link, 'hub_guide', { subject: 'biology' }));
  assert.match(one.guide, /Biology \(AQA\)/);
  assert.doesNotMatch(one.guide, /Chemistry/);
  const none = out(await rpc(env, link, 'hub_guide', { subject: 'Astrology' }));
  assert.match(none.note, /no subject called Astrology/);
  // The link has now been used, so the page counts their Claude as connected.
  assert.equal((await alex.c.call('GET', '/api/p/guide')).data.setup.claude, true);
});
