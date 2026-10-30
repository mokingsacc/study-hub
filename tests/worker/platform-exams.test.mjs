import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { fakeR2, fakeAI, fakeVectorize, page } from './library-helpers.mjs';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';
import { _resetVectorize, _clearD1Cache, _clearQueryCache } from '../../worker/src/library/vectors.js';
import { pdfLinks, validExam, UPLOAD_LINK_MS } from '../../worker/src/platform/exams.js';

const pdfBytes = (size = 2000) => { const b = new Uint8Array(Math.max(size, 40)); b.set(new TextEncoder().encode('%PDF-1.4\n% test paper\n')); return b; };

function setup() {
  _resetVectorize(); _clearD1Cache(); _clearQueryCache();
  const ai = fakeAI();
  const run = ai.run;
  ai.whisper = [];
  ai.run = async (model, input) => {
    if (/whisper/.test(model)) { ai.whisper.push(input); return { text: ai.say ?? 'So it says explain, two marks, so I need two points. I think the enzyme denatures because the active site changes shape.', transcription_info: { duration: 14 } }; }
    return run(model, input);
  };
  ai.toMarkdown = async files => files.map(f => ({ name: f.name, format: 'markdown', data: '# Paper 1\n\n01.1 Name the organelle. [1 mark]\fPage 2\n\n02 Explain why the enzyme stops working. [2 marks]' }));
  const { d, env } = platformEnv({ LIBRARY: fakeR2(), LIBRARY_VEC: fakeVectorize(), AI: ai });
  return { d, env, ai };
}

async function people(env) {
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  await alex.c.call('POST', '/api/p/subjects/alevel-biology/topics', { sections: [{ name: 'Biological molecules', topics: [{ name: 'Enzymes' }, { name: 'Cells' }] }] });
  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  return { alex, sam, link };
}

const rpc = async (env, path, name, args) => {
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} });
  return (await res.json()).result;
};
const toolsOf = async (env, path) => {
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), env, { waitUntil() {} });
  return (await res.json()).result.tools.map(t => t.name);
};

// The upload screen's requests, with the link's token instead of a session.
const up = (env, token, method, path, body, raw) => worker.fetch(new Request(BASE + path, { method,
  headers: { 'X-Upload-Token': token, 'CF-Connecting-IP': '9.9.9.9', ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) },
  body: raw || (body ? JSON.stringify(body) : undefined) }), env, { waitUntil() {} });

// A library document straight into the table (the exam tests do not need a real upload).
const putDoc = (d, user, id, title, collection = 'exam-paper', pages = 12) => d.env.DB.prepare(`INSERT INTO library_docs (user_id, id, title, file_name, collection, source, bytes, status, page_count, created_at, updated_at)
  VALUES (?1, ?2, ?3, 'p.pdf', ?4, 'upload', 2000, 'ready', ?5, 1, 1)`).bind(user, id, title, collection, pages).run();

test('exams is on for her track by default; her Claude sees the new tools', async () => {
  const s = setup();
  const { alex, link } = await people(s.env);
  const me = (await alex.c.call('GET', '/api/p/me')).data;
  assert.equal(me.modules.find(m => m.id === 'exams').on, true);
  const names = await toolsOf(s.env, link);
  for (const t of ['library_upload_link', 'library_add_link', 'exam_make', 'thinking_get', 'thinking_note', 'paper_get', 'paper_mark']) assert.ok(names.includes(t), t);
  s.d.close();
});

test('upload link: her Claude makes it, the upload screen adds an exam paper with no sign-in, and it can do nothing else', async () => {
  const s = setup();
  const { alex, sam, link } = await people(s.env);
  const made = await rpc(s.env, link, 'library_upload_link', { kind: 'exam_paper', title: 'AQA Biology Paper 1 June 2023' });
  assert.ok(!made.isError, JSON.stringify(made));
  const url = made.structuredContent.url;
  assert.match(url, /^https:\/\/hub\.test\/#up\/up_/);
  assert.match(made.structuredContent.say, /Tap this link/);
  const token = url.split('#up/')[1];

  const info = await (await worker.fetch(new Request(`${BASE}/api/p/up/${token}`, { headers: { 'X-Upload-Token': token } }), s.env, { waitUntil() {} })).json();
  assert.deepEqual([info.kind, info.name, info.title, info.files_left], ['exam_paper', 'Alex', 'AQA Biology Paper 1 June 2023', 30]);

  const bytes = pdfBytes();
  const create = await up(s.env, token, 'POST', '/api/p/library/docs', { file_name: 'photos-1.pdf', bytes: bytes.length, title: 'Photos 25 Oct' });
  assert.equal(create.status, 201, await create.clone().text());
  const doc = (await create.json()).doc;
  assert.equal((await up(s.env, token, 'PUT', `/api/p/library/docs/${doc.id}/parts/1`, null, bytes)).status, 200);
  assert.equal((await up(s.env, token, 'POST', `/api/p/library/docs/${doc.id}/complete`, {})).status, 200);
  const pages = await up(s.env, token, 'POST', `/api/p/library/docs/${doc.id}/pages`, { page_count: 1, pages: [page(1, ['01.1 Name the organelle where respiration happens. [1 mark]'])], extractor: 'pdfjs' });
  assert.equal(pages.status, 200, await pages.clone().text());
  const row = s.d.rows('SELECT user_id, title, collection FROM library_docs WHERE id = ?', doc.id)[0];
  assert.deepEqual(row, { user_id: alex.id, title: 'AQA Biology Paper 1 June 2023', collection: 'exam-paper' }, 'her library, named and kept as an exam paper');
  assert.equal(s.d.rows('SELECT files FROM upload_links')[0].files, 1);

  // Nothing else opens with the token.
  for (const [m, p] of [['GET', '/api/p/papers'], ['GET', '/api/p/library/search?q=x'], ['GET', `/api/p/library/docs/${doc.id}/file`], ['GET', '/api/auth/me'], ['DELETE', `/api/p/library/docs/${doc.id}`]]) {
    assert.equal((await up(s.env, token, m, p)).status, 403, `${m} ${p}`);
  }
  assert.equal((await up(s.env, 'up_' + 'x'.repeat(32), 'POST', '/api/p/library/docs', { file_name: 'a.pdf', bytes: 100 })).status, 401);
  // Expired.
  await s.env.DB.prepare('UPDATE upload_links SET expires_at = ?').bind(Date.now() - 1).run();
  assert.equal((await up(s.env, token, 'POST', '/api/p/library/docs', { file_name: 'b.pdf', bytes: 100 })).status, 401);
  assert.equal((await worker.fetch(new Request(`${BASE}/api/p/up/${token}`), s.env, { waitUntil() {} })).status, 404);
  // Sam's library is untouched.
  assert.equal((await sam.c.call('GET', '/api/p/library')).data.docs?.length ?? 0, 0);
  assert.ok(UPLOAD_LINK_MS === 3_600_000);
  s.d.close();
});

test('library_add_link: a PDF link is fetched into her library; a web page gives its PDF links; not https is refused', async () => {
  const s = setup();
  const { alex, link } = await people(s.env);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.endsWith('.pdf')) return new Response(pdfBytes(3000), { headers: { 'Content-Type': 'application/pdf' } });
    if (url.includes('/papers')) return new Response('<html><a href="/files/AQA-74011-QP-JUN23.PDF">Paper 1 question paper</a> <a href="https://cdn.test/ms-jun23.pdf">Mark scheme</a></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return realFetch(u);
  };
  try {
    const page1 = await rpc(s.env, link, 'library_add_link', { url: 'https://boards.test/papers/biology' });
    assert.equal(page1.structuredContent.page_not_pdf, true);
    assert.deepEqual(page1.structuredContent.pdf_links.map(l => l.url), ['https://boards.test/files/AQA-74011-QP-JUN23.PDF', 'https://cdn.test/ms-jun23.pdf']);
    const r = await rpc(s.env, link, 'library_add_link', { url: 'https://cdn.test/ms-jun23.pdf', kind: 'mark_scheme', title: 'AQA Biology Paper 1 June 2023 mark scheme' });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.added, true);
    const row = s.d.rows('SELECT user_id, collection, status, title FROM library_docs WHERE id = ?', r.structuredContent.doc_id)[0];
    assert.deepEqual([row.user_id, row.collection, row.title], [alex.id, 'mark-scheme', 'AQA Biology Paper 1 June 2023 mark scheme']);
    assert.notEqual(row.status, 'uploading', 'stored and handed to the reader');
    const again = await rpc(s.env, link, 'library_add_link', { url: 'https://cdn.test/ms-jun23.pdf', kind: 'mark_scheme' });
    assert.equal(again.structuredContent.duplicate, true);
    assert.equal((await rpc(s.env, link, 'library_add_link', { url: 'http://cdn.test/x.pdf' })).isError, true);
    assert.equal((await rpc(s.env, link, 'library_add_link', { url: 'https://localhost/x.pdf' })).isError, true);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(pdfLinks('<a href="a.pdf">A</a><a href="http://x.test/b.pdf">B</a>', 'https://s.test/dir/'), [{ url: 'https://s.test/dir/a.pdf', text: 'A' }]);
  s.d.close();
});

test('exam_make: her Claude turns a past paper into an exam she sits on screen; marked by her Claude with or without a mark scheme; onto her map', async () => {
  const s = setup();
  const { alex, sam, link } = await people(s.env);
  await putDoc(s.d, alex.id, 'doc_qp', 'AQA Biology Paper 1 June 2023');
  await putDoc(s.d, alex.id, 'doc_ms', 'AQA Biology Paper 1 June 2023 mark scheme', 'mark-scheme');
  await putDoc(s.d, sam.id, 'doc_b', 'Sam maths');
  let list = (await alex.c.call('GET', '/api/p/exams')).data;
  assert.deepEqual(list.waiting.map(x => x.id), ['doc_qp'], 'an exam paper not made into an exam yet');

  const bad = await rpc(s.env, link, 'exam_make', { doc_id: 'doc_b', subject: 'Biology', questions: [{ label: '1', marks: 2 }] });
  assert.equal(bad.isError, true, "Sam's document is not hers");
  const made = await rpc(s.env, link, 'exam_make', { doc_id: 'doc_qp', scheme_doc_id: 'doc_ms', subject: 'Biology', minutes: 120,
    questions: [{ label: '01.1', marks: 1, page: 2, text: 'Name the organelle', topic: 'Cells' }, { label: '02', marks: 2, page: 3, text: 'Why the enzyme stops', topic: 'Enzymes' }, { label: '03(a)', marks: 4, page: 5 }],
    scheme: [{ label: '02', points: ['active site changes shape', 'substrate no longer fits'] }] });
  assert.ok(!made.isError, JSON.stringify(made));
  const sc = made.structuredContent;
  assert.deepEqual([sc.questions, sc.out_of, sc.minutes, sc.with_mark_scheme, sc.on_topics], [3, 7, 120, 1, 2]);
  assert.match(sc.open, /#papers\/ex_/);

  list = (await alex.c.call('GET', '/api/p/exams')).data;
  assert.equal(list.waiting.length, 0);
  assert.equal(list.papers[0].from_document, true);
  const got = (await alex.c.call('GET', `/api/p/papers/${sc.paper_id}`)).data;
  assert.equal(got.own_key, false);
  assert.deepEqual(got.paper.source, { kind: 'document', doc_id: 'doc_qp', scheme_doc_id: 'doc_ms' });
  assert.deepEqual(got.paper.questions.map(q => [q.label, q.page, q.marks]), [['01.1', 2, 1], ['02', 3, 2], ['03(a)', 5, 4]]);
  assert.equal(got.paper.minutes, 120);
  assert.equal((await sam.c.call('GET', `/api/p/papers/${sc.paper_id}`)).status, 404);

  // She answers on screen; her Claude marks by voice: points where there is a scheme, whole marks where there is not.
  assert.equal((await alex.c.call('PUT', `/api/p/papers/${sc.paper_id}/answers`, { answers: [{ n: 1, answer: 'Mitochondrion', confidence: 'sure' }, { n: 2, answer: 'It denatures', confidence: 'think_so' }] })).status, 200);
  const view = await rpc(s.env, link, 'paper_get', { paper_id: sc.paper_id, show_mark_scheme: true });
  assert.equal(view.structuredContent.status, 'marking');
  assert.ok(view.structuredContent.from_document);
  const mk = await rpc(s.env, link, 'paper_mark', { paper_id: sc.paper_id, marks: [{ n: 1, awarded: 1 }, { n: 2, points: [1], reason: 'knowledge_gap', note: 'forgot the substrate no longer fits' }], finish: true });
  assert.ok(!mk.isError, JSON.stringify(mk));
  assert.deepEqual([mk.structuredContent.total, mk.structuredContent.out_of, mk.structuredContent.on_map], [2, 7, true]);
  s.d.close();
});

test('validExam: labels, marks and pages checked; a whole paper of up to 60 parts', () => {
  assert.throws(() => validExam({ questions: [] }), /Give the questions/);
  assert.throws(() => validExam({ questions: [{ label: '1', marks: 0 }] }), /needs its marks/);
  assert.throws(() => validExam({ questions: [{ label: '1', marks: 2, page: 30 }] }, 20), /not in the PDF/);
  assert.throws(() => validExam({ questions: [{ label: '<b>', marks: 2 }] }), /not a question label/);
  assert.throws(() => validExam({ questions: [{ label: '1', marks: 2 }], scheme: [{ label: '9', points: ['x'] }] }), /not in the list/);
  const big = validExam({ questions: Array.from({ length: 60 }, (_, i) => ({ label: `${i + 1}`, marks: 2 })) });
  assert.equal(big.questions.length, 60);
  assert.throws(() => validExam({ questions: Array.from({ length: 61 }, (_, i) => ({ label: `${i + 1}`, marks: 2 })) }), /At most 60/);
});

test('her thinking: Record turns speech into words kept with the question; her Claude reads it with her answer and marks and saves feedback; Sam cannot', async () => {
  const s = setup();
  const { alex, sam, link } = await people(s.env);
  await putDoc(s.d, alex.id, 'doc_qp', 'OCR Chemistry Paper 2');
  const sc = (await rpc(s.env, link, 'exam_make', { doc_id: 'doc_qp', subject: 'Biology', questions: [{ label: '1', marks: 2 }, { label: '2', marks: 3 }] })).structuredContent;
  await alex.c.call('PUT', `/api/p/papers/${sc.paper_id}/answers`, { answers: [{ n: 2, answer: 'Active site changes', confidence: 'guess' }] });

  const send = async (who, n, size = 20_000) => {
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(size)], { type: 'audio/webm' }), 'clip.webm');
    if (n != null) form.append('n', String(n));
    form.append('secs', '14');
    return worker.fetch(new Request(`${BASE}/api/p/papers/${sc.paper_id}/thinking`, { method: 'POST', headers: { Cookie: who.c.jar.cookie, 'X-CSRF-Token': who.c.jar.csrf, 'CF-Connecting-IP': '5.6.7.8' }, body: form }), s.env, { waitUntil() {} });
  };
  const r = await send(alex, 2);
  assert.equal(r.status, 201, await r.clone().text());
  const rec = (await r.json()).recording;
  assert.equal(rec.n, 2);
  assert.match(rec.text, /active site/);
  assert.equal(s.ai.whisper.length, 1);
  assert.equal(s.d.rows("SELECT COUNT(*) AS n FROM ai_usage WHERE user_id = ?", alex.id)[0].n >= 1, true, 'metered');
  assert.equal((await send(sam, 2)).status, 404, "Sam cannot record onto Alex's paper");
  const short = await (await send(alex, 1, 300)).json();
  assert.equal(short.saved, false);

  const got = await rpc(s.env, link, 'thinking_get', {});
  const item = got.structuredContent.recordings[0];
  assert.deepEqual([item.question.label, item.her_answer, item.confidence], ['2', 'Active site changes', 'guess']);
  assert.match(item.what_she_said, /two marks/);
  const note = await rpc(s.env, link, 'thinking_note', { paper_id: sc.paper_id, n: 2, feedback: 'You used the marks to plan: keep that. Next time, say what happens to the substrate too.' });
  assert.ok(!note.isError, JSON.stringify(note));
  const paper = (await alex.c.call('GET', `/api/p/papers/${sc.paper_id}`)).data.paper;
  assert.equal(paper.thinking.length, 1);
  assert.match(paper.thinking_notes['2'].text, /plan/);
  const barakLink = new URL((await sam.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  assert.deepEqual((await rpc(s.env, barakLink, 'thinking_get', {})).structuredContent.recordings, [], 'never hers to Sam');
  assert.equal((await alex.c.call('DELETE', `/api/p/papers/${sc.paper_id}/thinking/${rec.id}`)).status, 200);
  s.d.close();
});

test('my_hub_parts: her Claude lists the parts of her hub and switches them on or off; only hers', async () => {
  const s = setup();
  const { alex, sam, link } = await people(s.env);
  const list = (await rpc(s.env, link, 'my_hub_parts', {})).structuredContent.parts;
  assert.ok(list.some(p => p.id === 'exams' && p.on));
  const r = await rpc(s.env, link, 'my_hub_parts', { parts: { results: false } });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal(r.structuredContent.changed, 'results off');
  assert.equal((await alex.c.call('GET', '/api/p/me')).data.modules.find(m => m.id === 'results').on, false);
  assert.equal((await sam.c.call('GET', '/api/p/me')).data.modules.find(m => m.id === 'results').on, true, "Sam's hub is unchanged");
  assert.equal((await rpc(s.env, link, 'my_hub_parts', { parts: { map: false } })).isError, true, 'the map is always on');
  s.d.close();
});
