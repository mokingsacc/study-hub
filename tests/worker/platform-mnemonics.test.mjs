import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';

const rpc = async (env, path, name, args) => {
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} });
  const r = (await res.json()).result;
  return { error: !!r.isError, data: r.structuredContent, text: r.content[0].text };
};

async function setup() {
  const { d, env } = platformEnv();
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  await alex.c.call('POST', '/api/p/subjects/alevel-biology/topics', { sections: [{ name: 'Cells', topics: [{ name: 'Mitosis' }] }] });
  const mitosis = (await alex.c.call('GET', '/api/p/topics')).data.topics.find(t => t.name === 'Mitosis');
  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  return { d, env, alex, sam, mitosis, link };
}

test('add, list by subject, test and rate, edit, remove and undo', async () => {
  const { alex, sam, mitosis } = await setup();
  let r = await alex.c.call('POST', '/api/p/mnemonics', { cue: 'PMAT', about: 'Stages of mitosis', items: ['P: Prophase', 'M: Metaphase', 'A: Anaphase', 'T: Telophase'], topics: [mitosis.id] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.mnemonic.id;
  assert.equal(r.data.mnemonic.category_id, 'alevel-biology', 'its subject follows its topic');
  let list = (await alex.c.call('GET', '/api/p/mnemonics?subject=alevel-biology')).data;
  assert.equal(list.mnemonics.length, 1);
  assert.ok(list.subjects.some(s => s.name === 'Biology'));
  const t = (await alex.c.call('GET', '/api/p/mnemonics/test')).data;
  assert.deepEqual(t.queue, [{ id, dir: 'fwd' }]);
  r = await alex.c.call('POST', `/api/p/mnemonics/${id}/rate`, { dir: 'fwd', missed: [2] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.rating, 'hard');
  assert.ok(r.data.batch_id);
  r = await alex.c.call('PATCH', `/api/p/mnemonics/${id}`, { notes: 'People Meet And Talk' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await alex.c.call('POST', '/api/p/mnemonics', { cue: 'X', about: 'Y', items: ['Z'], subject_id: 'gcse-maths' })).status, 400, 'not her subject');
  const del = (await alex.c.call('DELETE', `/api/p/mnemonics/${id}`)).data;
  assert.equal((await alex.c.call('GET', '/api/p/mnemonics')).data.mnemonics.length, 0);
  assert.equal((await alex.c.call('POST', '/api/p/undo', { batch_id: del.batch_id })).status, 200);
  assert.equal((await alex.c.call('GET', '/api/p/mnemonics')).data.mnemonics.length, 1, 'undo brings it back');
  assert.equal((await sam.c.call('GET', '/api/p/mnemonics')).data.mnemonics.length, 0, 'Sam sees none of hers');
  assert.equal((await sam.c.call('DELETE', `/api/p/mnemonics/${id}`)).status, 400);
});

test('her Claude adds and lists mnemonics, never rates', async () => {
  const { env, alex, link } = await setup();
  const a = await rpc(env, link, 'mnemonic_edit', { add: [{ cue: 'MRS GREN', about: 'Life processes', items: ['M: Movement', 'R: Respiration', 'S: Sensitivity', 'G: Growth', 'R: Reproduction', 'E: Excretion', 'N: Nutrition'], subject: 'Biology' }] });
  assert.equal(a.error, false, a.text);
  assert.equal(a.data.added.length, 1);
  const l = await rpc(env, link, 'mnemonic_edit', {});
  assert.equal(l.data.mnemonics[0].subject, 'Biology');
  assert.equal(l.data.mnemonics[0].items.length, 7);
  const items = (await alex.c.call('GET', '/api/p/mnemonics')).data.mnemonics;
  assert.equal(items[0].source, 'claude');
  const recent = (await alex.c.call('GET', '/api/p/recent')).data.items;
  assert.ok(recent.some(i => i.who === 'Your Claude' && /MRS GREN/.test(i.what)), 'Recent changes shows it');
});
