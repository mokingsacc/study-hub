// Study Hub v2, WP3b: pictures on a topic. Photos they add (checked to really be images, kept in R2 under their own
// prefix) and pages of their own library PDFs, pinned by them or their Claude; up to 12 a topic; a removal can be
// undone; nobody else can list, open or remove them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { fakeR2 } from './library-helpers.mjs';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';
import { imageType, LIMITS } from '../../worker/src/platform/pictures.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]);
const raw = (env, who, path, bytes) => worker.fetch(new Request(BASE + path, { method: 'PUT',
  headers: { Cookie: who.c.jar.cookie, 'X-CSRF-Token': who.c.jar.csrf, 'CF-Connecting-IP': '5.6.7.8', 'Content-Type': 'application/octet-stream' }, body: bytes }), env, { waitUntil() {} })
  .then(async r => ({ status: r.status, data: await r.json().catch(() => null), res: r }));
const rpc = async (env, path, name, args) => {
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} });
  const r = (await res.json()).result;
  return { error: !!r.isError, data: r.structuredContent, text: r.content[0].text };
};

async function setup() {
  const { d, env } = platformEnv({ LIBRARY: fakeR2() });
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  await alex.c.call('POST', '/api/p/subjects/alevel-biology/topics', { sections: [{ name: 'Exchange', topics: [{ name: 'Cardiac cycle' }] }] });
  const topic = (await alex.c.call('GET', '/api/p/topics')).data.topics.find(t => t.name === 'Cardiac cycle');
  await env.DB.prepare(`INSERT INTO library_docs (user_id, id, title, file_name, collection, source, bytes, status, page_count, created_at, updated_at)
    VALUES (?1, 'dnotes1', 'My heart notes', 'n.pdf', 'notes', 'upload', 2000, 'ready', 6, 1, 1)`).bind(alex.id).run();
  return { d, env, alex, sam, topic };
}

test('imageType reads the bytes, not the name', () => {
  assert.equal(imageType(JPEG.buffer), 'image/jpeg');
  assert.equal(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]).buffer), 'image/png');
  assert.equal(imageType(new TextEncoder().encode('<svg onload=alert(1)>').buffer), null);
});

test('a photo: saved, listed, served only to her, removed and brought back with undo', async () => {
  const { env, alex, sam, topic } = await setup();
  let r = await raw(env, alex, `/api/p/pictures?topic=${topic.id}&caption=${encodeURIComponent('My sketch')}`, JPEG);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const pic = r.data.picture;
  assert.equal(pic.kind, 'photo');
  assert.equal(pic.caption, 'My sketch');
  assert.ok([...env.LIBRARY.objects.keys()].some(k => k.startsWith(`u/${alex.id}/pictures/`)), 'kept under her own prefix');
  const list = (await alex.c.call('GET', `/api/p/topics/${topic.id}/pictures`)).data;
  assert.equal(list.pictures.length, 1);
  const file = await alex.c.call('GET', pic.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(file.headers.get('X-Content-Type-Options'), 'nosniff');

  assert.equal((await sam.c.call('GET', pic.url)).status, 404, 'Sam cannot open it');
  assert.equal((await sam.c.call('GET', `/api/p/topics/${topic.id}/pictures`)).status, 404);
  assert.equal((await sam.c.call('DELETE', `/api/p/pictures/${pic.id}`)).status, 404);

  assert.equal((await raw(env, alex, `/api/p/pictures?topic=${topic.id}`, new TextEncoder().encode('not an image'))).status, 400);
  const del = (await alex.c.call('DELETE', `/api/p/pictures/${pic.id}`)).data;
  assert.equal((await alex.c.call('GET', `/api/p/topics/${topic.id}/pictures`)).data.pictures.length, 0);
  const u = await alex.c.call('POST', '/api/p/undo', { batch_id: del.batch_id });
  assert.equal(u.status, 200, JSON.stringify(u.data));
  assert.equal((await alex.c.call('GET', `/api/p/topics/${topic.id}/pictures`)).data.pictures.length, 1, 'undo brings it back');
});

test('a library page, by her or her Claude; only her own documents; 12 at most', async () => {
  const { env, alex, sam, topic } = await setup();
  let r = await alex.c.call('POST', '/api/p/pictures', { topic: topic.id, doc_id: 'dnotes1', page: 3, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(r.data.picture.crop, { x: 0.1, y: 0.2, w: 0.5, h: 0.4 });
  assert.equal((await alex.c.call('POST', '/api/p/pictures', { topic: topic.id, doc_id: 'dnotes1', page: 9 })).status, 400, 'no page 9');
  assert.equal((await sam.c.call('POST', '/api/p/pictures', { topic: topic.id, doc_id: 'dnotes1', page: 1 })).status, 404);

  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  const t = await rpc(env, link, 'topic_picture', { topic: 'Cardiac cycle', doc_id: 'dnotes1', page: 2, caption: 'The heart' });
  assert.equal(t.error, false, t.text);
  assert.equal(t.data.picture.created_by, 'claude');
  const listed = await rpc(env, link, 'topic_picture', { topic: 'Cardiac cycle' });
  assert.equal(listed.data.pictures.length, 2);
  assert.equal(listed.data.pictures[1].doc_title, 'My heart notes');

  for (let i = 2; i < LIMITS.per_topic; i++) await alex.c.call('POST', '/api/p/pictures', { topic: topic.id, doc_id: 'dnotes1', page: 1 });
  r = await alex.c.call('POST', '/api/p/pictures', { topic: topic.id, doc_id: 'dnotes1', page: 1 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /12 pictures/);
});
