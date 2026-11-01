// Writing on the exam with a pencil (worker/src/platform/ink.js, 1 Nov): each page's strokes and a picture of it are
// saved as they write; handing it in keeps how sure they were; their Claude sees the written pages as pictures, writes
// the answers down and marks it; writing locks once marking starts; nobody else can read or write it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { fakeR2 } from './library-helpers.mjs';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';
import { cleanStrokes, handwrittenView } from '../../worker/src/platform/ink.js';
import { strokesNear } from '../../public/js/platform/ink-core.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]);
const STROKE = { c: '#111111', w: 0.002, p: [0.1, 0.2, 0.15, 0.22, 0.2, 0.25] };
const putPage = (env, who, id, page, strokes, image = true) => {
  const fd = new FormData();
  fd.append('strokes', JSON.stringify(strokes));
  if (image) fd.append('image', new Blob([JPEG], { type: 'image/jpeg' }), 'p.jpg');
  return worker.fetch(new Request(`${BASE}/api/p/papers/${id}/ink/${page}`, { method: 'PUT', headers: { Cookie: who.c.jar.cookie, 'X-CSRF-Token': who.c.jar.csrf }, body: fd }), env, { waitUntil() {} })
    .then(async r => ({ status: r.status, data: await r.json() }));
};
const rpc = async (env, path, name, args) => (await (await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} })).json()).result;

test('strokes are checked and rounded; the eraser finds the stroke it touches; the view names the questions on each page', () => {
  const [s] = cleanStrokes([{ c: 'red', w: 9, p: [0.123456, 0.5, 0.2, 0.6] }]);
  assert.deepEqual(s, { c: '#111111', w: 0.05, p: [0.1235, 0.5, 0.2, 0.6] });
  assert.throws(() => cleanStrokes([{ p: [0.1] }]), /broken/);
  assert.throws(() => cleanStrokes([{ p: [0.1, 9] }]), /off the page/);
  assert.deepEqual(strokesNear([STROKE, { ...STROKE, p: [0.8, 0.8, 0.9, 0.9] }], 0.151, 0.221), [0]);
  const paper = { questions: [{ n: 1, label: '01.1', page: 2 }, { n: 2, label: '01.2', page: 2 }, { n: 3, label: '02', page: 3 }] };
  const v = handwrittenView(paper, { ink: { pages: { 2: { n: 3 }, 4: { n: 1 }, 13: { n: 2 } } } }, 12);
  assert.deepEqual(v.pages, [{ page: 2, questions: ['01.1', '01.2'] }, { page: 4, questions: ['02'] }, { page: 13, extra_page: true }]);
  assert.equal(handwrittenView(paper, {}), null);
});

test('write on the paper, hand it in, their Claude reads the pages as pictures and marks; locked after; theirs only', async () => {
  const { d, env } = platformEnv({ LIBRARY: fakeR2() });
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'alevel' });
  await d.env.DB.prepare(`INSERT INTO library_docs (user_id, id, title, file_name, collection, source, bytes, status, page_count, created_at, updated_at)
    VALUES (?1, 'doc1', 'Paper 1', 'p.pdf', 'exam-paper', 'upload', 2000, 'ready', 12, 1, 1)`).bind(alex.id).run();
  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  const made = await rpc(env, link, 'exam_make', { doc_id: 'doc1', subject: 'Biology', minutes: 60,
    questions: [{ label: '01.1', marks: 1, page: 2 }, { label: '02', marks: 2, page: 3 }], scheme: [{ label: '01.1', points: ['Mitochondrion'] }, { label: '02', points: ['Active site changes shape', 'Substrate no longer fits'] }] });
  assert.ok(!made.isError, made.content[0].text);
  const id = made.structuredContent.paper_id;

  assert.equal((await putPage(env, alex, id, 2, [STROKE])).status, 200);
  assert.equal((await putPage(env, alex, id, 3, [STROKE, STROKE])).status, 200);
  assert.equal((await putPage(env, alex, id, 13, [STROKE])).status, 200, 'an extra blank page');
  assert.equal((await putPage(env, alex, id, 23, [STROKE])).status, 400, 'past the ten extra pages');
  assert.equal((await alex.c.call('GET', `/api/p/papers/${id}/ink/3`)).data.strokes.length, 2);
  let paper = (await alex.c.call('GET', `/api/p/papers/${id}`)).data.paper;
  assert.deepEqual(paper.ink, { pages: [2, 3, 13], extra: 1 });
  // clearing a page takes it off
  assert.equal((await putPage(env, alex, id, 13, [], false)).status, 200);
  assert.deepEqual((await alex.c.call('GET', `/api/p/papers/${id}`)).data.paper.ink.pages, [2, 3]);

  // somebody else can neither read nor write it
  assert.equal((await sam.c.call('GET', `/api/p/papers/${id}/ink/2`)).status, 404);
  assert.equal((await putPage(env, sam, id, 2, [STROKE])).status, 404);

  const handed = await alex.c.call('POST', `/api/p/papers/${id}/hand-in`, { answers: [{ n: 1, confidence: 'sure' }, { n: 2, confidence: 'guess' }] });
  assert.equal(handed.status, 200);
  assert.ok(handed.data.paper.ink.sent_at);

  // their Claude: the written pages and their questions, then the pages as pictures
  const view = await rpc(env, link, 'paper_get', { paper_id: id });
  assert.deepEqual(view.structuredContent.handwritten.pages, [{ page: 2, questions: ['01.1'] }, { page: 3, questions: ['02'] }]);
  const pics = await rpc(env, link, 'paper_get', { paper_id: id, pages: [2, 3, 9] });
  assert.deepEqual(pics.content.filter(c => c.type === 'image').length, 2, 'only pages written on, as pictures');
  assert.equal(pics.content.find(c => c.type === 'image').mimeType, 'image/jpeg');
  // it writes the answers down (confidence kept from the hand-in), opens the scheme and marks
  const ans = await rpc(env, link, 'paper_mark', { paper_id: id, answers: [{ n: 1, answer: 'mitochondria' }, { n: 2, answer: 'the enzyme denatures' }] });
  assert.ok(!ans.isError, ans.content[0].text);
  const scheme = await rpc(env, link, 'paper_get', { paper_id: id, show_mark_scheme: true });
  assert.ok(!scheme.isError, scheme.content[0].text);
  assert.equal(scheme.structuredContent.status, 'marking');
  assert.equal((await putPage(env, alex, id, 2, [STROKE])).status, 400, 'writing locks once marking starts');
  const fin = await rpc(env, link, 'paper_mark', { paper_id: id, marks: [{ n: 1, points: [1] }, { n: 2, points: [1], reason: 'knowledge_gap', note: 'Did not say the substrate no longer fits' }], finish: true });
  assert.ok(!fin.isError, fin.content[0].text);
  assert.equal(fin.structuredContent.total, 2);

  // deleting the paper deletes its writing
  assert.equal((await alex.c.call('DELETE', `/api/p/papers/${id}`)).status, 200);
  assert.equal((await env.LIBRARY.list({ prefix: `u/${alex.id}/ink/${id}/` })).objects.length, 0);
  d.close();
});

test('a sheet from class: write on any library document, their Claude sees the writing; folders, moved and renamed with undo', async () => {
  const { d, env } = platformEnv({ LIBRARY: fakeR2() });
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'alevel' });
  const doc = (id, title) => d.env.DB.prepare(`INSERT INTO library_docs (user_id, id, title, file_name, collection, source, bytes, status, page_count, created_at, updated_at)
    VALUES (?1, ?2, ?3, 'p.pdf', 'notes', 'upload', 2000, 'ready', 2, 1, 1)`).bind(alex.id, id, title).run();
  await doc('sheet1', 'Osmosis worksheet'); await doc('sheet2', 'Enzymes notes');
  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  const put = (who, page, strokes) => {
    const fd = new FormData();
    fd.append('strokes', JSON.stringify(strokes));
    fd.append('image', new Blob([JPEG], { type: 'image/jpeg' }), 'p.jpg');
    return worker.fetch(new Request(`${BASE}/api/p/library/docs/sheet1/ink/${page}`, { method: 'PUT', headers: { Cookie: who.c.jar.cookie, 'X-CSRF-Token': who.c.jar.csrf }, body: fd }), env, { waitUntil() {} });
  };
  assert.equal((await put(alex, 1, [STROKE])).status, 200);
  assert.equal((await put(alex, 3, [STROKE])).status, 200, 'an extra blank page');
  assert.deepEqual((await alex.c.call('GET', '/api/p/library/docs/sheet1/ink')).data, { pages: [1, 3], extra: 1 });
  assert.equal((await alex.c.call('GET', '/api/p/library/docs/sheet1/ink/1')).data.strokes.length, 1);
  assert.equal((await put(sam, 1, [STROKE])).status, 404, 'not theirs');
  assert.equal((await sam.c.call('GET', '/api/p/library/docs/sheet1/ink/1')).status, 404);
  const seen = await rpc(env, link, 'library_read', { doc_id: 'sheet1', ink: true });
  assert.ok(!seen.isError, seen.content[0].text);
  assert.deepEqual(seen.structuredContent.written_pages, [1, 3]);
  assert.equal(seen.content.filter(c => c.type === 'image').length, 2);

  // folders: the page moves one, their Claude moves both and renames, undo puts it back
  const moved = await alex.c.call('POST', '/api/p/library/folders', { ids: ['sheet1'], folder: 'Biology' });
  assert.equal(moved.data.moved, 1);
  let lib = (await alex.c.call('GET', '/api/p/library')).data;
  assert.deepEqual(lib.folders, ['Biology']);
  assert.equal(lib.docs.find(x => x.id === 'sheet1').folder, 'Biology');
  const all = await rpc(env, link, 'library_folders', { ids: ['sheet1', 'sheet2'], folder: 'Bio: cells' });
  assert.equal(all.structuredContent.moved, 2);
  const ren = await rpc(env, link, 'library_folders', { rename: { from: 'Bio: cells', to: 'Cells' } });
  assert.equal(ren.structuredContent.moved, 2);
  assert.deepEqual((await rpc(env, link, 'library_read', {})).structuredContent.docs.map(x => x.folder), ['Cells', 'Cells']);
  assert.equal((await alex.c.call('POST', '/api/p/undo', { batch_id: ren.structuredContent.batch_id })).status, 200);
  assert.deepEqual((await alex.c.call('GET', '/api/p/library')).data.folders, ['Bio: cells']);
  assert.equal((await sam.c.call('POST', '/api/p/library/folders', { ids: ['sheet1'], folder: 'Mine' })).status, 404, 'not theirs');
  // deleting the document deletes its writing
  assert.equal((await alex.c.call('DELETE', '/api/p/library/docs/sheet1')).status, 200);
  assert.equal((await env.LIBRARY.list({ prefix: `u/${alex.id}/sheet1/ink/` })).objects.length, 0);
  d.close();
});
