import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { fakeR2 } from './library-helpers.mjs';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]);
const upload = (env, who) => {
  const fd = new FormData();
  fd.append('file', new Blob([JPEG], { type: 'image/jpeg' }), 'p.jpg');
  fd.append('thumb', new Blob([JPEG], { type: 'image/jpeg' }), 't.jpg');
  return worker.fetch(new Request(BASE + '/api/p/photo-inbox', { method: 'POST', headers: { Cookie: who.c.jar.cookie, 'X-CSRF-Token': who.c.jar.csrf, 'CF-Connecting-IP': '5.6.7.8' }, body: fd }), env, { waitUntil() {} })
    .then(async r => ({ status: r.status, data: await r.json() }));
};
const rpc = async (env, path, name, args) => (await (await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} })).json()).result;

test('add, list as images for their Claude, file on a topic with one undo, discard; Show first; isolation', async () => {
  const { d, env } = platformEnv({ LIBRARY: fakeR2() });
  const a = await signedIn(env, 'Ana', { profile: 'gcse' });
  const sid = (await a.c.call('GET', '/api/p/subjects')).data.subjects[0].id;
  await a.c.call('POST', `/api/p/subjects/${sid}/topics`, { sections: [{ name: 'Cells', topics: [{ name: 'Osmosis' }] }] });
  const topic = (await a.c.call('GET', `/api/p/subjects/${sid}`)).data.sections.flatMap(s => s.topics).find(t => t.name === 'Osmosis').id;
  const p1 = await upload(env, a), p2 = await upload(env, a);
  assert.equal(p1.status, 200, JSON.stringify(p1.data));
  assert.match(p1.data.photo.src, /^\/api\/p\/photo-inbox\//, 'the upload reply links to the Study Hub address, not Mo\'s');
  const list = (await a.c.call('GET', '/api/p/photo-inbox')).data;
  assert.equal(list.count, 2);
  assert.match(list.photos[0].thumb, /^\/api\/p\/photo-inbox\/pi_[a-z0-9]+\?size=thumb$/);
  const path = new URL((await a.c.call('POST', '/api/p/connector', { label: 'x' })).data.url).pathname;
  const seen = await rpc(env, path, 'photo_inbox', { action: 'list' });
  assert.equal(seen.content.filter(c => c.type === 'image').length, 2, 'their Claude sees the photos');
  const ids = list.photos.map(p => p.id);
  const filed = await rpc(env, path, 'photo_inbox', { action: 'file', items: [{ id: ids[0], topic: 'Osmosis' }, { id: ids[1], topic: 'Osmosis' }] });
  assert.ok(!filed.isError, filed.content[0].text);
  const pics = (await a.c.call('GET', `/api/p/topics/${encodeURIComponent(topic)}/pictures`)).data.pictures;
  assert.equal(pics.length, 2);
  assert.equal((await a.c.call('GET', '/api/p/photo-inbox')).data.count, 0);
  // one undo takes both off and back to the inbox
  await a.c.call('POST', '/api/p/undo', { batch_id: filed.structuredContent.batch_id });
  assert.equal((await a.c.call('GET', `/api/p/topics/${encodeURIComponent(topic)}/pictures`)).data.pictures.length, 0);
  assert.equal((await a.c.call('GET', '/api/p/photo-inbox')).data.count, 2);
  // filed again, then Show first puts the second ahead
  await rpc(env, path, 'photo_inbox', { action: 'file', items: [{ id: ids[0], topic: 'Osmosis' }] });
  await rpc(env, path, 'photo_inbox', { action: 'file', items: [{ id: ids[1], topic: 'Osmosis' }] });
  const two = (await a.c.call('GET', `/api/p/topics/${encodeURIComponent(topic)}/pictures`)).data.pictures;
  await a.c.call('PATCH', `/api/p/pictures/${two[1].id}`, { first: true });
  assert.equal((await a.c.call('GET', `/api/p/topics/${encodeURIComponent(topic)}/pictures`)).data.pictures[0].id, two[1].id);
  // discard from the page (a photo uploaded after)
  const p3 = await upload(env, a);
  ids[0] = p3.data.photo.id;
  assert.equal((await a.c.call('DELETE', `/api/p/photo-inbox/${ids[0]}`)).status, 200);
  assert.equal((await a.c.call('GET', '/api/p/photo-inbox')).data.count, 0);
  // someone else cannot see, file or take out Ana's photos
  const b = await signedIn(env, 'Ben', { profile: 'gcse' });
  assert.equal((await b.c.call('GET', '/api/p/photo-inbox')).data.count, 0);
  assert.notEqual((await b.c.call('GET', `/api/p/photo-inbox/${ids[0]}`)).status, 200);
  const bp = new URL((await b.c.call('POST', '/api/p/connector', { label: 'x' })).data.url).pathname;
  assert.ok((await rpc(env, bp, 'photo_inbox', { action: 'file', items: [{ id: ids[0], topic: 'Osmosis' }] })).isError);
  d.close();
});
