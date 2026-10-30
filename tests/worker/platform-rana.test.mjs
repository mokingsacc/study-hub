// Alex's requests (25 Oct): her map laid out the way she tells her Claude (each subject, each section, or her own
// clusters), removing topics by asking her Claude, and her own Anki (computer and phone, through the desktop add-on)
// landing on her topics; only her hub changes, and the map and removals can be undone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';
import { regroup } from '../../worker/src/platform/map.js';
import * as cards from '../../worker/src/platform/cards.js';
import { norm } from '../../public/js/shared/names.js';

const { ankiTopicOf } = cards;

const rpc = async (env, path, name, args) => {
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} });
  return (await res.json()).result;
};

async function setup() {
  const { d, env } = platformEnv();
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  const add = (sid, sections) => alex.c.call('POST', `/api/p/subjects/${sid}/topics`, { sections });
  await add('alevel-biology', [{ name: 'Biological molecules', topics: [{ name: 'Enzymes' }, { name: 'Lipids' }] }, { name: 'Cells', topics: [{ name: 'Mitosis' }, { name: 'Cell membranes' }] }]);
  await add('alevel-chemistry', [{ name: 'Organic chemistry', topics: [{ name: 'Alkanes' }, { name: 'Alkenes' }] }, { name: 'Physical chemistry', topics: [{ name: 'Enthalpy' }] }]);
  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  return { d, env, alex, sam, link };
}
const catsOf = p => p.categories.map(c => c[2]);
const topicCat = (p, name) => { const t = p.topics.find(x => x[2] === name); return p.categories[t[4]][2]; };

test('her map: a galaxy per section by default; by subject; or her own clusters, in her order; ETag follows her layout', async () => {
  const s = await setup();
  const link = s.link;
  const def = await s.alex.c.call('GET', '/api/p/map');
  assert.equal(topicCat(def.data, 'Alkanes'), 'Chemistry: Organic chemistry', 'sections are the galaxies by default');
  const bySubject = await rpc(s.env, link, 'my_hub_change', { patch: { map: { group_by: 'subject' } } });
  assert.ok(!bySubject.isError, JSON.stringify(bySubject));
  const base = await s.alex.c.call('GET', '/api/p/map');
  assert.deepEqual(catsOf(base.data).filter(n => /Biology|Chemistry/.test(n)).sort(), ['Biology', 'Chemistry']);
  assert.equal(topicCat(base.data, 'Alkanes'), 'Chemistry');

  const bySection = await rpc(s.env, link, 'my_hub_change', { patch: { map: { group_by: 'section' } } });
  assert.ok(!bySection.isError, JSON.stringify(bySection));
  const m1 = await s.alex.c.call('GET', '/api/p/map');
  assert.equal(topicCat(m1.data, 'Alkanes'), 'Chemistry: Organic chemistry');
  assert.equal(topicCat(m1.data, 'Enzymes'), 'Biology: Biological molecules');
  assert.notEqual(m1.headers.get('etag'), base.headers.get('etag'), 'a new layout is a new map for the cache');
  assert.equal(m1.data.meta.layout_version || 0, 0, 'positions were cleared: her map arranges itself again');

  const mine = await rpc(s.env, link, 'my_hub_change', { patch: { map: { group_by: 'custom', clusters: [{ title: 'Exam 1 topics', topics: ['Enzymes', 'Enthalpy'] }], order: ['Exam 1 topics', 'Chemistry'] } } });
  assert.ok(!mine.isError, JSON.stringify(mine));
  const m2 = await s.alex.c.call('GET', '/api/p/map');
  assert.equal(catsOf(m2.data)[0], 'Exam 1 topics');
  assert.equal(catsOf(m2.data)[1], 'Chemistry');
  assert.equal(topicCat(m2.data, 'Enthalpy'), 'Exam 1 topics');
  assert.equal(topicCat(m2.data, 'Alkenes'), 'Chemistry', 'topics not in a cluster stay in their subject');
  const again = await s.alex.c.call('GET', '/api/p/map', undefined, { headers: { 'If-None-Match': m2.headers.get('etag') } });
  assert.equal(again.status, 304, 'unchanged: still cached');
  assert.ok(m2.data.topics.every(t => Number.isInteger(t[4]) && t[4] < m2.data.categories.length));

  const b = await s.sam.c.call('GET', '/api/p/map');
  assert.ok(!catsOf(b.data).includes('Exam 1 topics'));
  // Undo goes back a step.
  await rpc(s.env, link, 'my_hub_undo', {});
  assert.equal(topicCat((await s.alex.c.call('GET', '/api/p/map')).data, 'Alkanes'), 'Chemistry: Organic chemistry');
  s.d.close();
});

test('removing topics by asking her Claude: by name, one undoable change, history kept; ambiguity asked back', async () => {
  const s = await setup();
  const r = await rpc(s.env, s.link, 'remove_topics', { topics: ['Lipids', 'Alkenes', 'Not a topic'] });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.deepEqual(r.structuredContent.removed.sort(), ['Alkenes', 'Lipids']);
  assert.deepEqual(r.structuredContent.not_found, ['Not a topic']);
  const m = await s.alex.c.call('GET', '/api/p/map');
  assert.ok(!m.data.topics.some(t => t[2] === 'Lipids'));
  const u = await rpc(s.env, s.link, 'undo_change', { batch_id: r.structuredContent.batch_id });
  assert.ok(!u.isError, JSON.stringify(u));
  assert.ok((await s.alex.c.call('GET', '/api/p/map')).data.topics.some(t => t[2] === 'Lipids'), 'undo brings them back');
  const blink = new URL((await s.sam.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  const br = await rpc(s.env, blink, 'remove_topics', { topics: ['Enzymes'] });
  assert.deepEqual(br.structuredContent.removed, []);
  assert.ok((await s.alex.c.call('GET', '/api/p/map')).data.topics.some(t => t[2] === 'Enzymes'));
  s.d.close();
});

test('regroup is pure and keeps topic indices for links', () => {
  const p = { categories: [[0, 'bio', 'Biology', 'Bio', null, 0, 0, 2, 2]], units: [[0, 'u1', 'Cells', 0, null, null]],
    topics: [[0, 't1', 'Mitosis', null, 0, 0, 1, 2, 0, null, 0, 5], [1, 't2', 'Enzymes', null, 0, null, 3, 4, 0, 700, 0, 4]], links: [[0, 1, 0, 50, 0, 0]] };
  const q = regroup(p, { group_by: 'section' });
  assert.deepEqual(q.topics.map(t => t[0]), [0, 1]);
  assert.deepEqual(q.categories.map(c => c[2]), ['Bio: Cells', 'Biology']);
  assert.equal(q.categories[1][6], 1, 'Enzymes (Very weak) counts as weak');
  assert.equal(regroup(p, { group_by: 'subject' }), p);
});

test('ankiTopicOf: her rules first (deck prefix or exact tag), then a deck level or tag that names a topic', () => {
  const aliases = new Map(['Enzymes', 'Alkenes', 'Mitosis'].map((n, i) => [norm(n), 't' + (i + 1)]));
  assert.equal(ankiTopicOf({ deck: 'A-level::Biology::Enzymes' }, aliases), 't1', 'the deepest deck level');
  assert.equal(ankiTopicOf({ deck: 'Chem', tags: ['organic::alkenes'] }, aliases), 't2', 'a tag level');
  assert.equal(ankiTopicOf({ deck: 'Bio::cell_division' }, aliases), null, 'no topic named, no guess');
  const rules = [{ match: 'deck', value: 'Bio::Cell division', topic: 'Mitosis' }, { match: 'tag', value: 'redox', topic: 't9' }];
  assert.equal(ankiTopicOf({ deck: 'bio::cell division::extra' }, aliases, rules), 't3', 'a deck rule covers its sub-decks, any case');
  assert.equal(ankiTopicOf({ deck: 'Bio::Cell divisionX' }, aliases, rules), null, 'a prefix must end at a deck level');
  assert.equal(ankiTopicOf({ tags: ['redox'] }, aliases, rules), null, 'a rule for a topic she does not have is skipped');
});

test("her Anki: she asks her Claude to send a deck to a topic; synced cards land on her topics and feed her map, never Sam's", async () => {
  const { d, env } = platformEnv({ ANKI_LINK: '1' });
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  await alex.c.call('POST', '/api/p/subjects/alevel-biology/topics', { sections: [{ name: 'Cells', topics: [{ name: 'Mitosis' }, { name: 'Enzymes' }] }] });
  assert.equal((await alex.c.call('POST', '/api/p/anki/key')).status, 404, 'off until the part is switched on');
  assert.equal((await alex.c.call('PATCH', '/api/p/me', { modules: { anki_link: true } })).status, 200);
  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  const ch = await rpc(env, link, 'my_hub_change', { patch: { anki: { rules: [{ match: 'deck', value: 'Biology::Cell cycle', topic: 'Mitosis' }] } } });
  assert.ok(!ch.isError, JSON.stringify(ch));
  assert.match(ch.structuredContent.changed, /Anki/);
  const key = (await alex.c.call('POST', '/api/p/anki/key')).data.key;
  const push = body => cards.ankiPushWithKey(new Request(BASE + '/api/p/anki/push', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify(body) }), env);
  const r = await (await push({ card_stats: [
    { card_id: 501, question: 'Stages of mitosis?', answer: 'PMAT', schedule: 'due in 3 days', deck: 'Biology::Cell cycle', tags: [] },
    { card_id: 502, question: 'Lock and key?', answer: 'Enzymes', schedule: 'due in 8 days', deck: 'Biology::Enzymes' },
    { card_id: 503, question: 'Loose card', answer: 'x', schedule: 'new', deck: 'Default' }],
    card_reviews: [{ card_id: 501, at: Date.now() - 1000, rating: 1 }] })).json();
  assert.deepEqual(r, { cards: 3, reviews: 1, on_topics: 2 });
  const st = (await alex.c.call('GET', '/api/p/anki/status')).data;
  assert.deepEqual([st.linked, st.cards, st.on_topics], [true, 3, 2]);
  const topicOf = async ext => (await env.DB.prepare('SELECT t.name FROM cards c JOIN topics t ON t.user_id = c.user_id AND t.id = c.topic_id WHERE c.user_id = ? AND c.ext_id = ?').bind(alex.id, ext).first())?.name;
  assert.equal(await topicOf(501), 'Mitosis');
  assert.equal(await topicOf(502), 'Enzymes');
  assert.equal((await sam.c.call('GET', '/api/p/anki/status')).status, 404, "Sam's Anki part stays off");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM cards WHERE user_id = ? AND source = 'anki'").bind(sam.id).first()).n, 0);
  d.close();
});

test('her add-on: a real .ankiaddon zip with her hub and key inside, valid Python, read-only SQL, made only for her', async () => {
  const { d, env } = platformEnv({ ANKI_LINK: '1' });
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  await alex.c.call('PATCH', '/api/p/me', { modules: { anki_link: true } });
  const r = await alex.c.call('POST', '/api/p/anki/key', { addon: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.addon_name, 'study-hub.ankiaddon');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), cp = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-'));
  const zip = path.join(dir, 'study-hub.ankiaddon');
  fs.writeFileSync(zip, Buffer.from(r.data.addon_b64, 'base64'));
  const py = `import zipfile,json,sys\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({n: z.read(n).decode() for n in z.namelist()}))`;
  const files = JSON.parse(cp.execFileSync('python3', ['-I', '-c', py, zip], { encoding: 'utf8' }));
  assert.deepEqual(Object.keys(files).sort(), ['__init__.py', 'config.md', 'link.json', 'manifest.json']);
  const link = JSON.parse(files['link.json']);
  assert.equal(link.key, r.data.key);
  assert.equal(link.hub, new URL(BASE).origin);
  assert.equal(JSON.parse(files['manifest.json']).package, 'study_hub_link');
  fs.writeFileSync(path.join(dir, 'init.py'), files['__init__.py']);
  cp.execFileSync('python3', ['-I', '-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', path.join(dir, 'init.py')]);
  const sql = [...files['__init__.py'].matchAll(/"((?:select|insert|update|delete|replace)[^"]*)"/gi)].map(m => m[1]);
  assert.ok(sql.length >= 2 && sql.every(q => /^select /i.test(q)), 'it only reads Anki');
  assert.match(files['__init__.py'], /sync_did_finish/, 'it sends after every sync, so phone reviews count');
  fs.rmSync(dir, { recursive: true, force: true });
  d.close();
});
