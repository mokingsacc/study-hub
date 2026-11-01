import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { fakeR2, fakeAI, fakeVectorize, page } from './library-helpers.mjs';
import { BASE, HUB_KEY, platformEnv, signedIn } from './platform-helpers.mjs';
import * as plib from '../../worker/src/platform/library.js';
import { ROUTES, TOOLS, CHECKS, retryExtraction, searchTool, readTool, MAX_FILE, MAX_DOCS, MAX_TOTAL, READ_MAX, SEARCH_TOP } from '../../worker/src/platform/library.js';
import { ROUTES as MO_ROUTES } from '../../worker/src/map/registry/library.js';
import * as store from '../../worker/src/library/store.js';
import { searchLibrary } from '../../worker/src/library/search.js';
import { libraryRun, libraryJob } from '../../worker/src/library/jobs.js';
import { _resetVectorize, _clearD1Cache, _clearQueryCache } from '../../worker/src/library/vectors.js';
import { activeUsers } from '../../worker/src/users.js';
import { londonDay } from '../../worker/src/util.js';
import { dispatchMinute } from '../../worker/src/map/sync.js';
import * as features from '../../worker/src/platform/features.js';
import { platformRoutes } from '../../worker/src/platform/routes.js';

const NOW = Date.parse('2026-10-25T10:00:00Z');

// GCSE biology notes as the browser's reader sends them (lines with size, bold and position).
const BIO = [
  page(1, [{ h: 'Cell biology' },
    '- Mitochondria are the site of aerobic respiration in a cell; they release energy from glucose.',
    '- Ribosomes make proteins and the nucleus holds the genetic material of the cell.']),
  page(2, [{ h: 'Transport in cells' },
    '- Osmosis is the diffusion of water through a partially permeable membrane from a dilute solution to a concentrated solution.',
    '- Active transport moves substances against a concentration gradient and needs energy from respiration.']),
  page(3, [{ h: 'Enzymes' },
    '- Amylase is an enzyme that breaks down starch into sugars in the mouth and small intestine.',
    '- Enzymes are denatured at high temperature because the active site changes shape.']),
];
const MO_NOTES = [page(1, [{ h: 'Hyperkalemia' }, '- Hyperkalemia shows peaked T waves on the ECG; give calcium gluconate first, then insulin with glucose.'])];
const UWORLD = n => ({ n, text: `Item ${n} of 40\nQuestion Id: 1234${n}\nA 34-year-old woman comes to the emergency department with flank pain.\nWhich of the following is the most likely diagnosis?\nA. Uric acid stone\nB. Struvite stone\nC. Cystine stone\nD. Calcium oxalate stone\nE. Papillary necrosis\nCorrect answer: A  62% answered correctly\nEducational objective: uric acid stones are radiolucent.\nCopyright © UWorld. All rights reserved.` });

const pdfBytes = (size = 2000) => { const b = new Uint8Array(Math.max(size, 40)); b.set(new TextEncoder().encode('%PDF-1.4\n% test file\n')); return b; };

function platformAi() {
  const ai = fakeAI();
  // A test can hold the vision model (ai.gate) to look at pictures while they wait to be read.
  const run = ai.run;
  ai.run = async (model, input) => { if (/llama-4/.test(model) && ai.gate) await ai.gate; return run(model, input); };
  ai.toMarkdownCalls = [];
  ai.toMarkdown = async files => { ai.toMarkdownCalls.push(files.map(f => f.name)); return files.map(f => ({ name: f.name, format: 'markdown', data: '# Photosynthesis\n\nPlants make glucose from carbon dioxide and water using light.\fPage 2\n\nChlorophyll absorbs red and blue light.' })); };
  return ai;
}

function setup(over = {}) {
  _resetVectorize(); _clearD1Cache(); _clearQueryCache();
  const r2 = fakeR2(), vec = fakeVectorize(), ai = platformAi();
  const { d, env } = platformEnv({ LIBRARY: r2, LIBRARY_VEC: vec, AI: ai, ...over });
  return { d, env, r2, vec, ai };
}

// One request as a signed-in person, with ctx.waitUntil work awaited (so indexing and embedding have finished).
async function api(s, who, method, path, body, { raw = null, headers = {}, binary = false, waits = [], hold = false } = {}) {
  const h = { 'CF-Connecting-IP': '5.6.7.8', Cookie: who.c.jar.cookie, ...headers };
  if (method !== 'GET') h['X-CSRF-Token'] = who.c.jar.csrf;
  let payload;
  if (raw) { payload = raw; h['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body: payload }), s.env, { waitUntil: p => waits.push(p) });
  let data, text = null;
  if (binary) data = new Uint8Array(await res.arrayBuffer());
  else { text = await res.text(); try { data = JSON.parse(text); } catch { data = text; } }
  if (!hold) await Promise.all(waits);
  return { status: res.status, data, text, headers: res.headers };
}

const L = '/api/p/library';

/** The browser's flow: create, send the parts, complete, send the pages. Returns {doc, pages} (the pages answer). */
async function upload(s, who, { name = 'biology-notes.pdf', pages = BIO, size = 2000, sha = null, title = undefined, extractor = 'pdfjs', waits = [], hold = false } = {}) {
  const bytes = pdfBytes(size);
  const made = await api(s, who, 'POST', `${L}/docs`, { file_name: name, bytes: bytes.length, ...(sha ? { sha256: sha } : {}), ...(title ? { title } : {}) });
  assert.ok(made.status === 201 || made.status === 200, JSON.stringify(made.data));
  if (made.data.duplicate) return { doc: made.data.doc, duplicate: true };
  const id = made.data.doc.id;
  const { part_size: size1, parts } = made.data.upload;
  for (let n = 1; n <= parts; n++) {
    const r = await api(s, who, 'PUT', `${L}/docs/${id}/parts/${n}`, undefined, { raw: bytes.slice((n - 1) * size1, n * size1) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const done = await api(s, who, 'POST', `${L}/docs/${id}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const sent = await api(s, who, 'POST', `${L}/docs/${id}/pages`, { page_count: pages.length, pages, extractor }, { waits, hold });
  return { doc: done.data.doc, id, pages: sent };
}

const docRow = (d, id) => d.rows('SELECT * FROM library_docs WHERE id = ?', id)[0];
const ready = async (s, user) => { await libraryRun(s.env, user, { ms: 20_000, cover: false }); };
const askFor = async (s, who) => {
  const k = await api(s, who, 'POST', '/api/p/connector', { label: 'Claude' });
  return new URL(k.data.url).pathname;
};
const rpc = async (s, path, method, params) => {
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), s.env, { waitUntil() {} });
  return (await res.json()).result;
};

// ------------------------------------------------------------------ routes and the module gate

test('routes: 2.5\'s handlers under /api/p/library with the same paths and methods as Mo\'s /api/library, minus objectives', () => {
  // The Study Hub's own additions: folders (0108) here, writing on a document in ink.js.
  const OWN = ['POST /api/p/library/folders', 'GET /api/p/library/docs/:id/ink', 'GET /api/p/library/docs/:id/ink/:page', 'PUT /api/p/library/docs/:id/ink/:page'];
  const mine = ROUTES.map(([m, p]) => `${m} ${p}`).filter(r => !OWN.includes(r)).sort();
  const theirs = MO_ROUTES.filter(([, p]) => !p.endsWith('/objectives')).map(([m, p]) => `${m} ${p.replace('/api/library', '/api/p/library')}`).sort();
  assert.deepEqual(mine, theirs);
  assert.ok(!mine.some(r => /objectives/.test(r)));
  assert.ok(mine.length >= 14);
  // They are mounted by the platform's route table, behind a session.
  const mounted = platformRoutes().filter(r => r.pattern.startsWith('/api/p/library'));
  assert.deepEqual(mounted.map(r => `${r.method} ${r.pattern}`).sort(), [...mine, ...OWN].sort());
  assert.ok(mounted.every(r => r.who === 'session'));
  assert.ok(features.routes().some(r => r[1] === '/api/p/library/docs/:id/pages'));
});

test('the library is behind the module switch: every route and both tools say it is switched off', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const up = await upload(s, a);
  assert.equal(up.pages.status, 200);
  assert.equal((await api(s, a, 'GET', L)).status, 200);
  const path = await askFor(s, a);
  assert.deepEqual((await rpc(s, path, 'tools/list')).tools.map(t => t.name).filter(n => n.startsWith('library')), ['library_search', 'library_read', 'library_folders', 'library_upload_link', 'library_add_link']);
  assert.equal((await api(s, a, 'PATCH', '/api/p/me', { modules: { library: false } })).status, 200);
  for (const [m, p, body] of [['GET', L], ['GET', `${L}/status`], ['GET', `${L}/search?q=osmosis`], ['POST', `${L}/run`, {}], ['POST', `${L}/docs`, { file_name: 'x.pdf', bytes: 5 }],
    ['GET', `${L}/docs/${up.id}`], ['DELETE', `${L}/docs/${up.id}`], ['PUT', `${L}/docs/${up.id}/parts/1`], ['POST', `${L}/docs/${up.id}/complete`, {}],
    ['POST', `${L}/docs/${up.id}/pages`, { page_count: 1, pages: [{ n: 1, text: 'x' }] }], ['POST', `${L}/docs/${up.id}/extract`, {}], ['POST', `${L}/docs/${up.id}/reindex`, {}],
    ['GET', `${L}/docs/${up.id}/file`], ['GET', `${L}/doc/${up.id}/page/1`], ['GET', `${L}/topic/anything`]]) {
    const r = await api(s, a, m, p, body, m === 'PUT' ? { raw: pdfBytes(10) } : {});
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.match(r.data.error, /switched off/);
  }
  assert.deepEqual((await rpc(s, path, 'tools/list')).tools.map(t => t.name).filter(n => n.startsWith('library')), []);
  const call = await rpc(s, path, 'tools/call', { name: 'library_search', arguments: { query: 'osmosis' } });
  assert.equal(call.isError, true);
  assert.match(call.structuredContent.reason, /switched off/);
  assert.deepEqual(await CHECKS[0](s.env, a.id), [], 'the self-check says nothing about a part that is off');
  s.d.close();
});

test('signed-out requests are refused (401) and nothing falls back to Mo', async () => {
  const s = setup();
  const res = await worker.fetch(new Request(BASE + L, { headers: { 'CF-Connecting-IP': '5.6.7.8' } }), s.env, { waitUntil() {} });
  assert.equal(res.status, 401);
  const withKey = await worker.fetch(new Request(BASE + L, { headers: { 'X-Hub-Key': HUB_KEY } }), s.env, { waitUntil() {} });
  assert.equal(withKey.status, 401, "the admin key does not open a person's library");
  s.d.close();
});

// ------------------------------------------------------------------ upload, pages, index

test('upload: create, parts, complete, pages -> indexed, listed with its status, then ready after the background work', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  assert.deepEqual((await api(s, a, 'GET', L)).data.docs, []);
  const up = await upload(s, a, { title: 'Biology notes' });
  assert.equal(up.doc.status, 'uploaded');
  assert.equal(up.pages.data.complete, true);
  assert.equal(up.pages.data.pages_in, 3);
  const row = docRow(s.d, up.id);
  assert.equal(row.user_id, a.id);
  assert.equal(row.source, 'upload');
  assert.equal(row.r2_key, `u/${a.id}/${up.id}/file.pdf`);
  assert.ok(s.r2.objects.has(row.r2_key), 'the PDF is in R2 under the person\'s prefix');
  assert.ok([...s.r2.objects.keys()].every(k => k.startsWith(`u/${a.id}/`)));
  // The upload route kicked the background work: the document is indexed and (the fakes being instant) ready.
  assert.equal(row.status, 'ready');
  assert.ok(row.n_passages >= 3);

  const list = (await api(s, a, 'GET', L)).data;
  assert.equal(list.docs.length, 1);
  assert.equal(list.docs[0].title, 'Biology notes');
  assert.equal(list.docs[0].status, 'ready');
  assert.equal(list.docs[0].ocr_pending, 0);
  assert.equal(list.docs[0].r2_key, undefined, 'storage internals never leave the Worker');
  assert.equal(list.docs[0].upload_id, undefined);
  assert.deepEqual(list.quota, { docs: 1, bytes: 2000, max_docs: MAX_DOCS, max_bytes: MAX_TOTAL });
  assert.equal(list.limits.max_file_bytes, MAX_FILE);
  assert.equal(list.totals.docs, 1);
  assert.equal(list.vectors, 'vectorize');

  const one = (await api(s, a, 'GET', `${L}/docs/${up.id}`)).data;
  assert.equal(one.doc.id, up.id);
  assert.deepEqual(one.pages.map(p => [p.n, p.kind]), [[1, 'text'], [2, 'text'], [3, 'text']]);

  const pg = (await api(s, a, 'GET', `${L}/doc/${up.id}/page/2?q=osmosis`)).data;
  assert.match(pg.page.text, /Osmosis is the diffusion of water/);
  assert.equal(pg.prev, 1);
  assert.equal(pg.next, 3);
  assert.ok(pg.marks.length >= 1, 'the query word is marked in the page text');
  assert.equal((await api(s, a, 'GET', `${L}/doc/${up.id}/page/9`)).status, 404);

  const status = (await api(s, a, 'GET', `${L}/status`)).data;
  assert.equal(status.docs.ready, 1);
  assert.equal(status.pending.embed, 0);
  s.d.close();
});

test('upload: a document that is still being indexed shows that, and reindex rebuilds it from the stored pages', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const up = await upload(s, a);
  s.d.run("UPDATE library_docs SET status = 'indexing', n_embedded = 0, n_linked = 0 WHERE id = ?", up.id);
  const doc = (await api(s, a, 'GET', L)).data.docs[0];
  assert.equal(doc.status, 'indexing');
  assert.deepEqual(Object.keys(doc.progress), ['passages', 'embedded', 'linked', 'pct']);
  const re = await api(s, a, 'POST', `${L}/docs/${up.id}/reindex`, {});
  assert.equal(re.status, 200);
  assert.ok(re.data.passages >= 3);
  assert.equal(docRow(s.d, up.id).status, 'ready');
  s.d.close();
});

test('upload: a two-part (9 MB) PDF, the same file again is the same document, a failed copy is replaced', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const sha = 'a'.repeat(64);
  const up = await upload(s, a, { size: 9 * 1024 * 1024, sha });
  assert.equal(up.pages.status, 200);
  assert.equal(docRow(s.d, up.id).bytes, 9 * 1024 * 1024);
  const again = await upload(s, a, { sha });
  assert.equal(again.duplicate, true);
  assert.equal(again.doc.id, up.id);
  assert.equal(s.d.rows('SELECT id FROM library_docs WHERE user_id = ?', a.id).length, 1);
  s.d.close();
});

test('upload: only PDFs, sized and counted; the first part must be a PDF; limits are plain words', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const bad = await api(s, a, 'POST', `${L}/docs`, { file_name: 'notes.docx', bytes: 100 });
  assert.equal(bad.status, 400);
  const big = await api(s, a, 'POST', `${L}/docs`, { file_name: 'big.pdf', bytes: MAX_FILE + 1 });
  assert.equal(big.status, 413);
  assert.match(big.data.error, /too big/);
  // Not a PDF inside: refused at the first part and nothing stays behind.
  const made = await api(s, a, 'POST', `${L}/docs`, { file_name: 'sneaky.pdf', bytes: 40 });
  assert.equal(made.status, 201);
  const html = await api(s, a, 'PUT', `${L}/docs/${made.data.doc.id}/parts/1`, undefined, { raw: new TextEncoder().encode('<html><script>alert(1)</script></html>') });
  assert.equal(html.status, 400);
  assert.match(html.data.error, /not a PDF/);
  assert.equal(docRow(s.d, made.data.doc.id), undefined);
  assert.equal([...s.r2.objects.keys()].length, 0);
  // Count and total size.
  s.d.run(`INSERT INTO library_docs (user_id, id, title, source, bytes, status, created_at, updated_at)
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) SELECT ?, 'x' || i, 'Filler ' || i, 'upload', 1000, 'ready', ?, ? FROM n`, MAX_DOCS, a.id, NOW, NOW);
  const full = await api(s, a, 'POST', `${L}/docs`, { file_name: 'one-more.pdf', bytes: 100 });
  assert.equal(full.status, 409);
  assert.match(full.data.error, /library is full/);
  s.d.run('DELETE FROM library_docs WHERE user_id = ?', a.id);
  s.d.run("INSERT INTO library_docs (user_id, id, title, source, bytes, status, created_at, updated_at) VALUES (?, 'big', 'Big', 'upload', ?, 'ready', ?, ?)", a.id, MAX_TOTAL - 50, NOW, NOW);
  const over = await api(s, a, 'POST', `${L}/docs`, { file_name: 'one-more.pdf', bytes: 100 });
  assert.equal(over.status, 409);
  assert.match(over.data.error, /go over/);
  s.d.run('DELETE FROM library_docs WHERE user_id = ?', a.id);
  const imp = await api(s, a, 'POST', `${L}/docs`, { file_name: 'a.pdf', bytes: 100, source: 'import' });
  assert.equal(docRow(s.d, imp.data.doc.id).source, 'upload');
  s.d.close();
});

test('upload: an hour\'s worth of uploads is limited (429)', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  s.d.run("INSERT INTO rate_limits (user_id, bucket, window_start, count) VALUES (?, 'upload', ?, ?)", a.id, Date.now(), plib.UPLOAD_RATE.limit);
  const r = await api(s, a, 'POST', `${L}/docs`, { file_name: 'a.pdf', bytes: 100 });
  assert.equal(r.status, 429);
  assert.match(r.data.error, /lot of uploads/);
  s.d.close();
});

test('question-bank material is refused exactly as 2.5 does: 422, the file and pages deleted, the reason kept', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const up = await upload(s, a, { name: 'export.pdf', pages: [UWORLD(1), UWORLD(2), UWORLD(3)] });
  assert.equal(up.pages.status, 422);
  assert.equal(up.pages.data.refused, true);
  assert.match(up.pages.data.reason, /question-bank material/);
  const row = docRow(s.d, up.id);
  assert.equal(row.status, 'refused');
  assert.equal(row.r2_key, null);
  assert.match(row.status_note, /question-bank/);
  assert.equal([...s.r2.objects.keys()].length, 0, 'the PDF is deleted at once');
  assert.equal(s.d.rows('SELECT * FROM library_pages WHERE user_id = ?', a.id).length, 0);
  const list = (await api(s, a, 'GET', L)).data;
  assert.equal(list.docs[0].status, 'refused');
  assert.equal((await api(s, a, 'GET', `${L}/docs/${up.id}/file`)).status, 404);
  assert.equal((await api(s, a, 'POST', `${L}/docs/${up.id}/reindex`, {})).status, 409);
  // The same rule applies to the server-side reader's route and to later pages.
  const more = await api(s, a, 'POST', `${L}/docs/${up.id}/pages`, { page_count: 3, pages: BIO });
  assert.equal(more.status, 422);
  s.d.close();
});

test('the file route serves the person\'s own PDF with Range, as an inline PDF that browsers will not sniff', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const up = await upload(s, a, { size: 3000, title: 'My notes' });
  const full = await api(s, a, 'GET', `${L}/docs/${up.id}/file`, undefined, { binary: true });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('Content-Type'), 'application/pdf');
  assert.equal(full.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(full.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(full.headers.get('Cache-Control'), 'private, no-store');
  assert.match(full.headers.get('Content-Disposition'), /^inline; filename="biology-notes\.pdf"$/);
  assert.equal(full.data.length, 3000);
  assert.equal(new TextDecoder().decode(full.data.slice(0, 5)), '%PDF-');
  const part = await api(s, a, 'GET', `${L}/docs/${up.id}/file`, undefined, { binary: true, headers: { Range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('Content-Range'), 'bytes 0-9/3000');
  assert.equal(part.data.length, 10);
  s.d.close();
});

test('the server-side reader (extract) is metered, needs toMarkdown, and turns the text into pages', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const made = await api(s, a, 'POST', `${L}/docs`, { file_name: 'scan.pdf', bytes: 500 });
  const id = made.data.doc.id;
  await api(s, a, 'PUT', `${L}/docs/${id}/parts/1`, undefined, { raw: pdfBytes(500) });
  await api(s, a, 'POST', `${L}/docs/${id}/complete`, {});
  const r = await api(s, a, 'POST', `${L}/docs/${id}/extract`, {});
  assert.equal(r.status, 202);
  assert.equal(r.data.pages, 2);
  assert.deepEqual(s.ai.toMarkdownCalls, [['scan.pdf']]);
  assert.equal(s.d.rows("SELECT calls FROM ai_usage WHERE user_id = ? AND provider = 'workers_ai'", a.id).length, 1, 'recorded against the person\'s AI use');
  assert.equal(docRow(s.d, id).status, 'ready');
  assert.match((await api(s, a, 'GET', `${L}/search?q=chlorophyll+absorbs`)).data.results[0].text, /Chlorophyll absorbs red and blue light/);
  assert.equal((await api(s, a, 'POST', `${L}/docs/${id}/extract`, {})).status, 409, 'an indexed document is re-indexed instead');
  // Without toMarkdown: a plain 503, nothing metered.
  const s2 = setup();
  const b = await signedIn(s2.env, 'Beth', { profile: 'gcse' });
  s2.env.AI = { run: s2.ai.run };
  const m2 = await api(s2, b, 'POST', `${L}/docs`, { file_name: 'scan.pdf', bytes: 500 });
  await api(s2, b, 'PUT', `${L}/docs/${m2.data.doc.id}/parts/1`, undefined, { raw: pdfBytes(500) });
  await api(s2, b, 'POST', `${L}/docs/${m2.data.doc.id}/complete`, {});
  assert.equal((await api(s2, b, 'POST', `${L}/docs/${m2.data.doc.id}/extract`, {})).status, 503);
  s.d.close(); s2.d.close();
});

// ------------------------------------------------------------------ pictures (photos of notes and past papers)

test('a photo is a one-page PDF whose page image is read by 2.5\'s OCR step; several photos are one document', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const jpeg = Buffer.from('not really a jpeg but base64 of some bytes '.repeat(200)).toString('base64');
  const photos = [1, 2].map(n => ({ n, lines: [], images: 1, image: jpeg }));
  let release;
  s.ai.gate = new Promise(r => { release = r; });
  const waits = [];
  const up = await upload(s, a, { name: 'photos-25-oct.pdf', pages: photos, extractor: 'photo', waits, hold: true });
  assert.equal(up.pages.status, 200);
  assert.equal(up.pages.data.complete, true);
  // Both pictures are stored for OCR beside the PDF, under the person's prefix, and wait to be read.
  assert.deepEqual([...s.r2.objects.keys()].filter(k => k.includes('/ocr/')).sort(), [`u/${a.id}/${up.id}/ocr/1.jpg`, `u/${a.id}/${up.id}/ocr/2.jpg`]);
  assert.deepEqual(s.d.rows('SELECT kind, ocr_state FROM library_pages WHERE user_id = ? ORDER BY n', a.id).map(p => [p.kind, p.ocr_state]), [['image', 'pending'], ['image', 'pending']]);
  const doc = (await api(s, a, 'GET', L)).data.docs[0];
  assert.equal(doc.ocr_pending, 2, 'the page can say the pictures are still being read');
  assert.match((await api(s, a, 'GET', '/api/p/self-check')).data.items.find(i => i.id === 'library_pictures').says, /2 pictures waiting to be read/);
  // The fake vision model reads them (jobs.js ocrStep, two pages a step); then they are searchable.
  release();
  await Promise.all(waits);
  for (let i = 0; i < 12; i++) await libraryJob(s.env, a.id, { cover: false });
  const after = s.d.rows('SELECT n, kind, ocr_state FROM library_pages WHERE user_id = ? ORDER BY n', a.id);
  assert.deepEqual(after.map(p => [p.kind, p.ocr_state]), [['ocr', 'done'], ['ocr', 'done']]);
  assert.equal(docRow(s.d, up.id).status, 'ready');
  assert.equal(docRow(s.d, up.id).n_ocr, 2);
  const found = (await api(s, a, 'GET', `${L}/search?q=hyperkalemia+peaked+T+waves`)).data;
  assert.ok(found.results.some(r => r.doc_id === up.id && r.kind === 'ocr'), 'text read from a picture is found by search');
  assert.equal((await api(s, a, 'GET', L)).data.docs[0].ocr_pending, 0);
  s.d.close();
});

test('pictures past the daily reading limit wait for the next day and the self-check says so, not lost silently', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  s.d.run("INSERT INTO sync_state (user_id, source, cursor, last_ok_at) VALUES (?, 'library.ocr', ?, ?)", a.id, `${londonDay(Date.now())}:150`, Date.now());
  const jpeg = Buffer.from('x'.repeat(9000)).toString('base64');
  const up = await upload(s, a, { name: 'photo.pdf', pages: [{ n: 1, lines: [], images: 1, image: jpeg }], extractor: 'photo' });
  assert.deepEqual(s.d.rows('SELECT kind, ocr_state FROM library_pages WHERE user_id = ?', a.id).map(p => [p.kind, p.ocr_state]), [['image', 'pending']], 'kept for the next day (2.5 AUD-019)');
  const items = (await api(s, a, 'GET', '/api/p/self-check')).data.items;
  const waiting = items.find(i => i.id === 'library_pictures');
  assert.match(waiting.says, /1 picture waiting to be read/);
  assert.match(waiting.fix, /next day/);
  assert.equal(items.find(i => i.id === 'library_pictures_lost'), undefined);
  assert.ok(up.id);
  s.d.close();
});

// ------------------------------------------------------------------ search

test('search: hybrid results cited by title and page; an empty or long query is refused; page links work', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const up = await upload(s, a, { title: 'Biology notes' });
  const r = await api(s, a, 'GET', `${L}/search?q=${encodeURIComponent('how does osmosis work')}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.q, 'how does osmosis work');
  const top = r.data.results[0];
  assert.equal(top.doc_id, up.id);
  assert.equal(top.title, 'Biology notes');
  assert.equal(top.page, 2);
  assert.match(top.cite, /^Biology notes, p\. 2/);
  assert.match(top.text, /Osmosis is the diffusion of water/);
  assert.equal(r.data.vectors, 'vectorize');
  assert.ok(s.vec.calls.query >= 1, 'the vector side ran in the person\'s namespace');
  const hit = (await api(s, a, 'GET', `${L}/doc/${up.id}/page/${top.page}?passage=${top.id}&q=osmosis`)).data;
  assert.ok(hit.highlight && hit.highlight.end > hit.highlight.start, 'the passage can be highlighted in its page');
  assert.equal((await api(s, a, 'GET', `${L}/search`)).status, 400);
  assert.equal((await api(s, a, 'GET', `${L}/search?q=${'x'.repeat(201)}`)).status, 400);
  assert.equal((await api(s, a, 'GET', `${L}/search?q=osmosis&k=500`)).status, 400);
  assert.deepEqual((await api(s, a, 'GET', `${L}/search?q=quantum+chromodynamics+lagrangian`)).data.results.filter(x => /quantum/i.test(x.text)), []);
  s.d.close();
});

test('searches are limited per hour (they embed and rerank on Workers AI), on the page and in the tool', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  await upload(s, a);
  assert.equal((await api(s, a, 'GET', `${L}/search?q=osmosis`)).status, 200);
  s.d.run("UPDATE rate_limits SET count = ?, window_start = ? WHERE user_id = ? AND bucket = 'library_search'", plib.SEARCH_RATE.limit, Date.now(), a.id);
  const r = await api(s, a, 'GET', `${L}/search?q=osmosis`);
  assert.equal(r.status, 429);
  assert.match(r.data.error, /lot of searches/);
  await assert.rejects(searchTool(s.env, a.id, { query: 'osmosis' }), e => e.status === 429);
  s.d.close();
});

test('search works on the D1 vectors when Vectorize is not bound', async () => {
  const s = setup({ LIBRARY_VEC: undefined });
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  await upload(s, a);
  const r = (await api(s, a, 'GET', `${L}/search?q=aerobic+respiration+mitochondria`)).data;
  assert.equal(r.vectors, 'd1');
  assert.equal(r.results[0].page, 1);
  s.d.close();
});

// ------------------------------------------------------------------ connector tools

test('library_search: top 8, cited by title and page, text capped; through the person\'s own connector', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const WORDS = 'amber basil cedar dune ember fjord glade harbor iris jade koala lotus maple nectar olive pearl quartz raven sable tundra umber velvet willow xenon yarrow zephyr acorn birch coral dahlia elm fern ginger hazel indigo juniper kelp lilac mint nutmeg orchid poppy quince reed sage thyme urchin violet wheat'.split(' ');
  const long = Array.from({ length: 30 }, (_, i) => page(i + 1, [{ h: `Topic ${WORDS[i]}` },
    `- Diffusion in ${WORDS[i]} cells: particles move from a high concentration to a low concentration. ${Array.from({ length: 70 }, (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length] + k).join(' ')}`]));
  const up = await upload(s, a, { title: 'Big book', pages: long });
  assert.ok(TOOLS.every(t => t.module === 'library'));
  assert.deepEqual(TOOLS.map(t => t.name), ['library_search', 'library_read', 'library_folders']);
  const path = await askFor(s, a);
  const call = await rpc(s, path, 'tools/call', { name: 'library_search', arguments: { query: 'diffusion high concentration to low concentration' } });
  assert.ok(!call.isError, JSON.stringify(call));
  const out = call.structuredContent;
  assert.ok(out.results.length >= 5 && out.results.length <= SEARCH_TOP, `${out.results.length} results`);
  for (const r of out.results) {
    assert.equal(r.doc_id, up.id);
    assert.equal(r.title, 'Big book');
    assert.match(r.cite, /^Big book, p\. \d+/);
    assert.ok(r.text.length <= plib.SNIPPET_MAX, `text is capped (${r.text.length})`);
    assert.ok(Number.isInteger(r.page));
  }
  const none = await searchTool(s.env, a.id, { query: 'zzzzqqqq' });
  assert.deepEqual(none.results.filter(r => /zzzz/.test(r.text)), []);
  await assert.rejects(searchTool(s.env, a.id, { query: '  ' }), e => e.status === 400);
  s.d.close();
});

test('library_read: pages by number, at most 12,000 characters, with a next pointer to carry on', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const pages = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, text: `Page ${i + 1} text. ` + `Sentence about cells number ${i + 1}. `.repeat(70) }));
  const up = await upload(s, a, { title: 'Long notes', pages });
  const first = await readTool(s.env, a.id, { doc_id: up.id });
  assert.ok(first.text.length <= READ_MAX, `${first.text.length} characters`);
  assert.match(first.text, /^\[page 1\]\nPage 1 text\./);
  assert.ok(first.next && first.next.page > 1, 'it says where to carry on');
  assert.equal(first.title, 'Long notes');
  // Carry on to the end: every page is read once, in order, nothing skipped.
  let seen = new Set(), next = { page: 1, offset: 0 }, guard = 0, chars = 0;
  while (next && guard++ < 20) {
    const r = await readTool(s.env, a.id, { doc_id: up.id, page: next.page, offset: next.offset });
    assert.ok(r.text.length <= READ_MAX);
    for (const m of r.text.matchAll(/\[page (\d+)\]/g)) seen.add(Number(m[1]));
    chars += r.text.length;
    next = r.next;
  }
  assert.deepEqual([...seen].sort((x, y) => x - y), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.ok(chars > READ_MAX, 'it took more than one call');
  // A start page, and one past the end.
  const p5 = await readTool(s.env, a.id, { doc_id: up.id, page: 5 });
  assert.match(p5.text, /^\[page 5\]/);
  const past = await readTool(s.env, a.id, { doc_id: up.id, page: 99 });
  assert.equal(past.text, null);
  assert.match(past.note, /12 pages/);
  // A single page longer than the cap is cut and continued by offset.
  const huge = await upload(s, a, { name: 'huge.pdf', title: 'Huge page', pages: [{ n: 1, text: 'word '.repeat(5000) }] });
  const h1 = await readTool(s.env, a.id, { doc_id: huge.id });
  assert.ok(h1.text.length <= READ_MAX && h1.next && h1.next.page === 1 && h1.next.offset > 0);
  const h2 = await readTool(s.env, a.id, { doc_id: huge.id, page: 1, offset: h1.next.offset });
  assert.ok(h2.text.length > 0 && h2.from.offset === h1.next.offset);
  // Without a document: the list. A document that is not theirs: refused in plain words.
  const list = await readTool(s.env, a.id, {});
  assert.deepEqual(list.docs.map(d => d.title).sort(), ['Huge page', 'Long notes']);
  await assert.rejects(readTool(s.env, a.id, { doc_id: 'nope' }), e => e.status === 404);
  const path = await askFor(s, a);
  const via = await rpc(s, path, 'tools/call', { name: 'library_read', arguments: { doc_id: up.id, page: 2 } });
  assert.match(via.structuredContent.text, /^\[page 2\]/);
  const bad = await rpc(s, path, 'tools/call', { name: 'library_read', arguments: { doc_id: 'someone-elses' } });
  assert.equal(bad.isError, true);
  assert.match(bad.structuredContent.reason, /not in this library/);
  s.d.close();
});

test('library_read says so for a document still uploading, refused, or a picture not read yet', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const made = await api(s, a, 'POST', `${L}/docs`, { file_name: 'later.pdf', bytes: 50, title: 'Later' });
  const wait = await readTool(s.env, a.id, { doc_id: made.data.doc.id });
  assert.equal(wait.text, null);
  assert.match(wait.note, /still being read/);
  const jpeg = Buffer.from('y'.repeat(9000)).toString('base64');
  let release;
  s.ai.gate = new Promise(res => { release = res; });
  const waits = [];
  const photo = await upload(s, a, { name: 'photo.pdf', title: 'Photo', pages: [{ n: 1, lines: [], images: 1, image: jpeg }], waits, hold: true });
  const r = await readTool(s.env, a.id, { doc_id: photo.id });
  assert.match(r.text, /a picture; its text has not been read/);
  release();
  await Promise.all(waits);
  assert.match((await readTool(s.env, a.id, { doc_id: photo.id })).text, /transcribed by the fake vision model/, 'once read, the picture\'s text can be read');
  const bank = await upload(s, a, { name: 'bank.pdf', pages: [UWORLD(1), UWORLD(2), UWORLD(3)] });
  assert.match((await readTool(s.env, a.id, { doc_id: bank.id })).note, /question-bank/);
  s.d.close();
});

// ------------------------------------------------------------------ self-check

test('self-check: documents still being read, failed, unfinished, refused; storage missing; plain words', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const items = async () => (await api(s, a, 'GET', '/api/p/self-check')).data.items.filter(i => i.id.startsWith('library'));
  assert.match((await items())[0].says, /Library: empty/);
  const up = await upload(s, a);
  const ok = (await items())[0];
  assert.equal(ok.level, 'ok');
  assert.match(ok.says, /Library: 1 library file, 3 pages, 0\.0 MB of 300 MB used/);
  s.d.run("UPDATE library_docs SET status = 'indexing' WHERE id = ?", up.id);
  assert.match((await items()).find(i => i.id === 'library_indexing').says, /1 library file still being read and indexed/);
  s.d.run("UPDATE library_docs SET status = 'failed', status_note = 'x' WHERE id = ?", up.id);
  const failed = (await items()).find(i => i.id === 'library_failed');
  assert.equal(failed.level, 'warn');
  assert.match(failed.says, /could not be read, so Claude cannot search it/);
  assert.match(failed.fix, /Read again/);
  s.d.run("UPDATE library_docs SET status = 'uploading' WHERE id = ?", up.id);
  assert.match((await items()).find(i => i.id === 'library_uploading').fix, /Add the file again/);
  s.d.run("UPDATE library_docs SET status = 'refused' WHERE id = ?", up.id);
  assert.match((await items()).find(i => i.id === 'library_refused').says, /question-bank/);
  const noStore = await CHECKS[0]({ ...s.env, LIBRARY: undefined }, a.id);
  assert.deepEqual(noStore.map(i => [i.id, i.level]), [['library_storage', 'warn']]);
  assert.ok((await api(s, a, 'GET', '/api/p/self-check')).data.items.every(i => typeof i.says === 'string'));
  s.d.close();
});

// ------------------------------------------------------------------ background work

test('platform people are covered by 2.5\'s minute job (HUB_OFF): users.js lists them and the library step runs for each', async () => {
  const s = setup({ HUB_OFF: '1', D1_QUERY_BUDGET: '5000' });
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const b = await signedIn(s.env, 'Beth', { profile: 'gcse' });
  assert.deepEqual((await activeUsers(s.env)).sort(), [a.id, b.id].sort());
  // Two documents indexed but not yet embedded or linked (the upload's own kick never ran).
  for (const [who, name] of [[a, 'Adam'], [b, 'Beth']]) {
    const c = await store.createDoc(s.env, who.id, { file_name: `${name}.pdf`, bytes: 100 }, NOW);
    await store.putPart(s.env, who.id, c.doc.id, 1, pdfBytes(100).buffer);
    await store.completeUpload(s.env, who.id, c.doc.id, NOW);
    await store.savePages(s.env, who.id, c.doc.id, { page_count: 3, pages: BIO }, NOW);
    await store.indexDocument(s.env, who.id, c.doc.id, { now: NOW });
    assert.equal(s.d.rows('SELECT status FROM library_docs WHERE user_id = ?', who.id)[0].status, 'indexing');
  }
  // London minute % 5 === 4 is the library's slot; a few of them finish embedding, linking and marking ready.
  for (const minute of [4, 9, 14, 19]) await dispatchMinute(s.env, { waitUntil() {} }, Date.UTC(2026, 9, 25, 10, minute));
  for (const who of [a, b]) {
    const doc = s.d.rows('SELECT status, n_passages, n_embedded, n_linked FROM library_docs WHERE user_id = ?', who.id)[0];
    assert.equal(doc.status, 'ready', JSON.stringify(doc));
    assert.equal(doc.n_embedded, doc.n_passages);
  }
  assert.ok(s.vec.rows.size >= 6);
  assert.ok([...s.vec.rows.values()].every(v => v.namespace === a.id || v.namespace === b.id), 'every vector sits in a person\'s own namespace');
  s.d.close();
});

test('retryExtraction (hourly): one more step for a waiting document, clears uploads that never finished, skips otherwise', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  assert.deepEqual(await retryExtraction(s.env, a.id), { skipped: 'nothing is waiting' });
  const c = await store.createDoc(s.env, a.id, { file_name: 'half.pdf', bytes: 100 }, NOW);
  assert.equal(c.doc.status, 'uploading');
  s.d.run('UPDATE library_docs SET updated_at = ? WHERE id = ?', Date.now() - plib.STALE_UPLOAD_MS - 1000, c.doc.id);
  const fresh = await store.createDoc(s.env, a.id, { file_name: 'fresh.pdf', bytes: 100 });
  assert.deepEqual(await retryExtraction(s.env, a.id), { cleared: 1 });
  assert.equal(docRow(s.d, c.doc.id), undefined);
  assert.ok(docRow(s.d, fresh.doc.id), 'a recent upload is left alone');
  assert.equal([...s.r2.objects.keys()].filter(k => k.includes(c.doc.id)).length, 0);
  const up = await upload(s, a);
  s.d.run("UPDATE library_docs SET status = 'indexing', n_embedded = 0, n_linked = 0 WHERE id = ?", up.id);
  s.d.run('UPDATE library_passages SET vec_state = 0, linked = 0 WHERE doc_id = ?', up.id);
  const r = await retryExtraction(s.env, a.id);
  assert.ok(r.step && r.step.embed, JSON.stringify(r));
  const cron = await import('../../worker/src/platform/cron.js');
  assert.equal(typeof (await import('../../worker/src/platform/library.js')).retryExtraction, 'function');
  assert.ok(cron.platformJobs(Date.UTC(2026, 9, 25, 10, 7)).includes('library'));
  s.d.close();
});

test('POST /run is limited per hour and clamped by 2.5; status shows the job', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  await upload(s, a);
  const run = await api(s, a, 'POST', `${L}/run`, { ms: 1000, cover: false });
  assert.equal(run.status, 200);
  s.d.run("INSERT INTO rate_limits (user_id, bucket, window_start, count) VALUES (?, 'library_run', ?, ?) ON CONFLICT (user_id, bucket) DO UPDATE SET count = excluded.count, window_start = excluded.window_start", a.id, Date.now(), plib.RUN_RATE.limit);
  const limited = await api(s, a, 'POST', `${L}/run`, { ms: 1000 });
  assert.equal(limited.status, 429);
  s.d.close();
});

// ------------------------------------------------------------------ delete

test('delete: the PDF, pictures, passages, FTS rows and vectors all go; the search no longer finds it; others are untouched', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const b = await signedIn(s.env, 'Beth', { profile: 'gcse' });
  const mine = await upload(s, a, { title: 'Mine' });
  const theirs = await upload(s, b, { title: 'Theirs' });
  const vecBefore = s.vec.rows.size;
  assert.ok(s.d.rows('SELECT pid FROM library_passages WHERE user_id = ?', a.id).length > 0);
  const del = await api(s, a, 'DELETE', `${L}/docs/${mine.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.deleted, true);
  assert.equal(docRow(s.d, mine.id), undefined);
  for (const t of ['library_pages', 'library_passages']) assert.equal(s.d.rows(`SELECT * FROM ${t} WHERE user_id = ?`, a.id).length, 0, t);
  assert.deepEqual([...s.r2.objects.keys()].filter(k => k.startsWith(`u/${a.id}/`)), []);
  assert.ok([...s.r2.objects.keys()].some(k => k.startsWith(`u/${b.id}/`)), "Beth's files stay");
  assert.ok(s.vec.rows.size < vecBefore && s.vec.rows.size > 0);
  assert.deepEqual((await api(s, a, 'GET', `${L}/search?q=osmosis`)).data.results, []);
  assert.ok((await api(s, b, 'GET', `${L}/search?q=osmosis`)).data.results.length > 0);
  assert.equal(docRow(s.d, theirs.id).status, 'ready');
  assert.equal((await api(s, a, 'DELETE', `${L}/docs/${mine.id}`)).status, 404);
  s.d.close();
});

// ------------------------------------------------------------------ isolation

test('isolation: two people and Mo cannot read, search, list, change or delete each other\'s library', async () => {
  const s = setup();
  const a = await signedIn(s.env, 'Adam', { profile: 'gcse' });
  const b = await signedIn(s.env, 'Beth', { profile: 'gcse' });
  const aDoc = await upload(s, a, { title: 'Adam biology' });
  const bDoc = await upload(s, b, { name: 'beth-chemistry.pdf', title: 'Beth chemistry', pages: [page(1, [{ h: 'Bonding' }, '- Ionic bonding is the transfer of electrons from a metal to a non-metal atom to make oppositely charged ions.'])] });
  const moDoc = await store.createDoc(s.env, 'mo', { file_name: 'mo-notes.pdf', bytes: 100, collection: 'mehlman' }, NOW);
  await store.putPart(s.env, 'mo', moDoc.doc.id, 1, pdfBytes(100).buffer);
  await store.completeUpload(s.env, 'mo', moDoc.doc.id, NOW);
  await store.savePages(s.env, 'mo', moDoc.doc.id, { page_count: 1, pages: MO_NOTES }, NOW);
  await store.indexDocument(s.env, 'mo', moDoc.doc.id, { now: NOW });
  await libraryRun(s.env, 'mo', { ms: 10_000, cover: false });
  const moFiles = [...s.r2.objects.keys()].filter(k => k.startsWith('u/mo/'));
  assert.ok(moFiles.length > 0);

  // Lists show only their own.
  assert.deepEqual((await api(s, a, 'GET', L)).data.docs.map(d => d.id), [aDoc.id]);
  assert.deepEqual((await api(s, b, 'GET', L)).data.docs.map(d => d.id), [bDoc.id]);
  for (const id of [bDoc.id, moDoc.doc.id]) {
    for (const [m, p, body, opts] of [['GET', `${L}/docs/${id}`], ['GET', `${L}/docs/${id}/file`], ['GET', `${L}/doc/${id}/page/1`], ['POST', `${L}/docs/${id}/reindex`, {}],
      ['POST', `${L}/docs/${id}/pages`, { page_count: 1, pages: [{ n: 1, text: 'planted' }] }], ['POST', `${L}/docs/${id}/complete`, {}], ['POST', `${L}/docs/${id}/extract`, {}],
      ['PUT', `${L}/docs/${id}/parts/1`, undefined, { raw: pdfBytes(10) }], ['DELETE', `${L}/docs/${id}`]]) {
      const r = await api(s, a, m, p, body, opts || {});
      assert.equal(r.status, 404, `${m} ${p}`);
    }
  }
  assert.ok(docRow(s.d, bDoc.id) && docRow(s.d, moDoc.doc.id), 'nothing was deleted');
  assert.equal(s.d.rows('SELECT * FROM library_pages WHERE doc_id = ? AND text LIKE ?', bDoc.id, '%planted%').length, 0);
  // Search: each sees only their own words, with and without the vector side.
  const inA = q => api(s, a, 'GET', `${L}/search?q=${encodeURIComponent(q)}`).then(r => r.data.results);
  assert.deepEqual((await inA('ionic bonding transfer of electrons')).filter(r => r.doc_id !== aDoc.id), []);
  assert.deepEqual((await inA('hyperkalemia peaked T waves calcium gluconate')).filter(r => r.doc_id !== aDoc.id), []);
  assert.ok((await api(s, b, 'GET', `${L}/search?q=ionic+bonding`)).data.results.every(r => r.doc_id === bDoc.id));
  const mo = await searchLibrary(s.env, 'mo', { q: 'osmosis diffusion of water' });
  assert.deepEqual(mo.results.filter(r => r.doc_id !== moDoc.doc.id), [], 'Mo never sees a student\'s text');
  assert.deepEqual((await searchLibrary(s.env, a.id, { q: 'hyperkalemia', ai: null })).results, []);
  // Tools.
  assert.deepEqual((await searchTool(s.env, a.id, { query: 'ionic bonding electrons' })).results.filter(r => r.doc_id !== aDoc.id), []);
  await assert.rejects(readTool(s.env, a.id, { doc_id: bDoc.id }), e => e.status === 404);
  await assert.rejects(readTool(s.env, a.id, { doc_id: moDoc.doc.id }), e => e.status === 404);
  assert.deepEqual((await readTool(s.env, b.id, {})).docs.map(d => d.doc_id), [bDoc.id]);
  // Storage: keys and vectors.
  for (const [who, doc] of [[a, aDoc], [b, bDoc]]) {
    const keys = [...s.r2.objects.keys()].filter(k => k.includes(doc.id));
    assert.ok(keys.length > 0 && keys.every(k => k.startsWith(`u/${who.id}/`)));
  }
  const spaces = new Set([...s.vec.rows.values()].map(v => v.namespace));
  assert.deepEqual([...spaces].sort(), ['mo', a.id, b.id].sort());
  // The self-check and counts are per person.
  assert.match((await api(s, a, 'GET', '/api/p/self-check')).data.items.find(i => i.id === 'library').says, /1 library file, 3 pages/);
  assert.match((await api(s, b, 'GET', '/api/p/self-check')).data.items.find(i => i.id === 'library').says, /1 library file, 1 page,/);
  const moList = await worker.fetch(new Request(BASE + '/api/library', { headers: { 'X-Hub-Key': HUB_KEY } }), s.env, { waitUntil() {} });
  assert.deepEqual((await moList.json()).docs.map(d => d.id), [moDoc.doc.id]);
  // And a student deleting their own account-level data leaves the others alone.
  assert.equal((await api(s, a, 'DELETE', `${L}/docs/${aDoc.id}`)).status, 200);
  assert.ok(docRow(s.d, bDoc.id) && docRow(s.d, moDoc.doc.id));
  assert.equal([...s.r2.objects.keys()].filter(k => k.startsWith('u/mo/')).length, moFiles.length);
  s.d.close();
});
