// Study Hub v2, WP5: making the hub their own by talking to their Claude. subject_edit (subjects, boards, tiers, the
// exam date), topic_edit (rename, move section) and card_edit (find, fix, pause, delete), each one change they can undo
// where the app's own change can be, each only ever about the student who owns the link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';
import { INSTRUCTIONS } from '../../worker/src/platform/mcp.js';

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
  await alex.c.call('POST', '/api/p/subjects/alevel-biology/topics', { sections: [{ name: 'Biological molecules', topics: [{ name: 'Cell membranes' }, { name: 'Enzymes' }] }] });
  await alex.c.call('POST', '/api/p/subjects/alevel-chemistry/topics', { sections: [{ name: 'Physical chemistry', topics: [{ name: 'Enzymes' }] }] });
  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  const blink = new URL((await sam.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  const R = (name, args) => rpc(env, link, name, args), B = (name, args) => rpc(env, blink, name, args);
  return { d, env, alex, sam, R, B };
}

test('subject_edit: add, board in words, tier refused where there are none, remove and undo, exam date', async () => {
  const { alex, sam, R, B } = await setup();
  let r = await R('subject_edit', { action: 'add', subject: 'Maths' });
  assert.equal(r.error, false, r.text);
  assert.ok(r.data.subjects.some(s => s.name === 'Maths'));
  r = await R('subject_edit', { action: 'change', subject: 'Chemistry', board: 'OCR' });
  assert.equal(r.error, false, r.text);
  assert.equal(r.data.subjects.find(s => s.name === 'Chemistry').board, 'OCR');
  r = await R('subject_edit', { action: 'change', subject: 'Biology', tier: 'higher' });
  assert.equal(r.error, true);
  assert.match(r.text, /no tiers/);
  r = await R('subject_edit', { action: 'add', subject: 'Latin' });
  assert.equal(r.error, false, r.text);
  assert.ok(r.data.subjects.some(s => s.name === 'Latin'), 'a subject of their own');

  r = await R('subject_edit', { action: 'remove', subject: 'Psychology' });
  assert.equal(r.error, false, r.text);
  assert.ok(!r.data.subjects.some(s => s.name === 'Psychology'));
  const u = await R('undo_change', { batch_id: r.data.batch_id });
  assert.equal(u.error, false, u.text);
  assert.ok((await alex.c.call('GET', '/api/p/subjects')).data.subjects.some(s => s.name === 'Psychology'), 'undo brings it back');

  r = await R('subject_edit', { action: 'exam_date', date: '2027-05-14' });
  assert.equal(r.data.exam_date, '2027-05-14');
  assert.equal((await alex.c.call('GET', '/api/p/me')).data.exam_date, '2027-05-14');
  r = await R('subject_edit', { action: 'exam_date', date: null });
  assert.equal((await alex.c.call('GET', '/api/p/me')).data.exam_date ?? null, null);
  assert.equal((await R('subject_edit', { action: 'exam_date', date: 'soon' })).error, true);

  r = await B('subject_edit', { action: 'change', subject: 'Maths', tier: 'Foundation' });
  assert.equal(r.error, false, r.text);
  assert.equal(r.data.subjects.find(s => s.name === 'Maths').tier, 'foundation');
  assert.ok(!(await sam.c.call('GET', '/api/p/subjects')).data.subjects.some(s => s.name === 'Latin'));
  assert.equal((await B('subject_edit', { action: 'remove', subject: 'Chemistry' })).error, true, 'not his subject');
});

test('topic_edit: rename (the old name still finds it), a new section, ambiguous names, undo, isolation', async () => {
  const { R, B } = await setup();
  let r = await R('topic_edit', { topic: 'Cell membranes', name: 'Membranes and transport' });
  assert.equal(r.error, false, r.text);
  assert.equal(r.data.topic.name, 'Membranes and transport');
  const found = await R('topic_detail', { topic: 'Cell membranes' });
  assert.equal(found.data.topic.name, 'Membranes and transport', 'the old name still finds it');
  r = await R('topic_edit', { topic: 'Membranes and transport', section: 'Cells' });
  assert.equal(r.data.topic.section, 'Cells');
  const amb = await R('topic_edit', { topic: 'Enzymes', name: 'Enzyme action' });
  assert.equal(amb.data.ambiguous, true);
  r = await R('topic_edit', { topic: 'Enzymes', subject: 'Biology', name: 'Enzyme action' });
  assert.equal(r.error, false, r.text);
  await R('undo_change', { batch_id: r.data.batch_id });
  assert.equal((await R('topic_detail', { topic: 'Enzymes', subject: 'Biology' })).data.topic.name, 'Enzymes');
  assert.equal((await B('topic_edit', { topic: 'Membranes and transport', name: 'Mine now' })).error, true, 'not his topic');
});

test('card_edit: find, fix, pause, delete; another student\'s card is not found', async () => {
  const { R, B } = await setup();
  const add = await R('cards_add', { cards: [{ front: 'What is osmosis?', back: 'Water moving across a membrane' }, { front: 'What is a lipid?', back: 'A fat' }] });
  assert.equal(add.error, false, add.text);
  let r = await R('card_edit', { find: 'osmosis' });
  assert.equal(r.data.cards.length, 1);
  const id = r.data.cards[0].id;
  r = await R('card_edit', { card_id: id, back: 'The net movement of water across a partially permeable membrane, down a water potential gradient' });
  assert.equal(r.error, false, r.text);
  assert.match(r.data.card.back, /water potential/);
  r = await R('card_edit', { card_id: id, suspended: true });
  assert.equal(r.data.card.suspended, true);
  assert.equal((await B('card_edit', { card_id: id, front: 'Hijacked' })).error, true);
  assert.equal((await B('card_edit', { find: 'osmosis' })).data.cards.length, 0);
  r = await R('card_edit', { card_id: id, delete: true });
  assert.equal(r.data.deleted, true);
  assert.equal((await R('card_edit', { find: 'osmosis' })).data.cards.length, 0);
});

test('the instructions name every new tool', () => {
  for (const t of ['galaxy_edit', 'subject_edit', 'topic_edit', 'card_edit', 'paper_make', 'hub_guide']) assert.ok(INSTRUCTIONS.includes(t), t);
  assert.ok(INSTRUCTIONS.length <= 2000);
});

test('setup: setup_guide says what is left and what to suggest; a university student gets their level and their own subjects', async () => {
  const { env, alex, link } = await (async () => {
    const { d, env } = platformEnv();
    const alex = await signedIn(env, 'Sam', { profile: 'gcse' });
    const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
    return { env, alex, link };
  })();
  let g = await rpc(env, link, 'setup_guide', {});
  assert.equal(g.error, false, g.text);
  assert.equal(g.data.level.track, 'gcse');
  assert.ok(g.data.still_to_do.some(x => /results/.test(x)));
  assert.ok(g.data.ideas.length >= 4);
  const lv = await rpc(env, link, 'subject_edit', { action: 'level', level: 'university' });
  assert.equal(lv.error, false, lv.text);
  const add = await rpc(env, link, 'subject_edit', { action: 'add', subject: 'Sociology' });
  assert.equal(add.error, false, add.text);
  assert.ok(add.data.subjects.some(s => s.name === 'Sociology'));
  g = await rpc(env, link, 'setup_guide', {});
  assert.equal(g.data.level.label, 'University');
  assert.equal((await rpc(env, link, 'subject_edit', { action: 'level', level: 'wizard' })).error, true);
  const guide = await rpc(env, link, 'hub_guide', {});
  assert.match(guide.data.guide, /Track: University/);
});
