// Study Hub How it works (#how, docs/platform/v2-plan.md 2.4 and 2.5, WP4): the words (how-data.js), the per-track
// guide (guide.js), the copy rules, and the wiring (route, #help alias, side bar, CSS, not in the first view).
// Run: node --test tests/web/platform-how.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTIONS, NODES, PLACES, LEFT_OUT, targetOf, filterPhrases, phraseCount, INTRO, SUB, LEFT_OUT_WHY } from '../../public/js/platform/how-data.js';
import { GUIDE, DEFAULT_SUBJECT, guideFor, guideText } from '../../public/js/platform/guide.js';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8');
const ui = read('js/platform/ui.js') + read('js/platform/kit.js') + read('js/platform/how.js');
const known = name => new RegExp(`\\b${name}: '`).test(ui);

test('15 sections, each with 4 or more [icon, title, sentence] items, known icons and unique ids', () => {
  assert.equal(SECTIONS.length, 15);
  assert.equal(new Set(SECTIONS.map(s => s.id)).size, 15);
  for (const s of SECTIONS) {
    assert.ok(s.items.length >= 4, `${s.id} has ${s.items.length} items`);
    assert.ok(known(s.icon), `${s.id} icon ${s.icon}`);
    assert.ok(!['red', 'orange'].includes(s.tint), `${s.id} tint`);
    for (const it of s.items) { assert.equal(it.length, 3); assert.ok(known(it[0]), `${s.id}: icon ${it[0]}`); assert.ok(it[1] && it[2]); }
  }
  for (const n of NODES) assert.ok(known(n.icon), `node ${n.id} icon ${n.icon}`);
  for (const n of NODES.filter(x => x.section)) assert.ok(SECTIONS.some(s => s.id === n.section), `node ${n.id} section`);
});

test('every old Help id lands somewhere; plan and say are targets; unknown ids go to the top', () => {
  for (const id of ['claude', 'map', 'cards', 'exams', 'thinking', 'library', 'results', 'mine']) assert.equal(targetOf(id), id);
  assert.equal(targetOf('help'), 'fix');
  assert.equal(targetOf('start'), null);
  assert.equal(targetOf('plan'), 'plan');
  assert.equal(targetOf('say'), 'say');
  assert.equal(targetOf('galaxies'), 'galaxies');
  assert.equal(targetOf('nope'), null);
  assert.equal(targetOf('__proto__'), null);
});

test('what to say: 4 places, 30 or more phrases, and a filter that finds galaxy phrases only', () => {
  assert.equal(PLACES.length, 4);
  assert.ok(phraseCount() >= 30, `${phraseCount()} phrases`);
  for (const p of PLACES) for (const i of p.items) assert.ok(i.say && i.does, `${p.id}: ${i.say}`);
  const g = filterPhrases('galaxy');
  assert.ok(g.length >= 4, `${g.length} galaxy phrases`);
  for (const x of g) assert.match(`${x.item.say} ${x.item.does}`.toLowerCase(), /galax/);
  assert.equal(filterPhrases('zzz').length, 0);
  assert.equal(filterPhrases('').length, phraseCount());
});

const bio = { id: 'b', subject: 'biology', name: 'Biology', board: 'aqa', board_name: 'AQA', weakest: 'Enzymes' };
test('guide, A-level: AQA Biology with practicals, OCR Chemistry with the board line, AQA Psychology with its 96 marks', () => {
  const gd = guideFor({ track: 'alevel', subjects: [bio, { id: 'c', subject: 'chemistry', name: 'Chemistry', board: 'ocr', board_name: 'OCR' },
    { id: 'p', subject: 'psychology', name: 'Psychology', board: 'aqa', board_name: 'AQA' }] });
  assert.equal(gd.label, 'A-level');
  assert.equal(gd.subjects.length, 3);
  const [b, c, p] = gd.subjects;
  assert.ok(b.practicals && b.practicals.length === 12);
  assert.ok(!c.practicals && !p.practicals);
  assert.match(c.note, /OCR Chemistry/);
  assert.ok(p.rewards.some(r => /96 marks/.test(r)));
  assert.ok(b.say.some(s => /Enzymes/.test(s)), 'the weakest topic is filled in');
  for (const s of gd.subjects) for (const l of [...s.say, ...s.rewards]) assert.doesNotMatch(l, /\{(topic|board|level|subject)\}/);
});

test('guide, GCSE: Maths Higher line only, Trilogy for Combined Science, a custom subject falls back, any other level gets the open guide', () => {
  const gd = guideFor({ track: 'gcse', subjects: [{ id: 'm', subject: 'maths', name: 'Maths', board: 'edexcel', board_name: 'Pearson Edexcel', tier: 'higher' },
    { id: 'cs', subject: 'combined_science', name: 'Combined Science', board: 'aqa', board_name: 'AQA', tier: 'higher' },
    { id: 'x', subject: null, name: 'Latin', board: 'other', board_name: 'Other' }] });
  const [m, cs, x] = gd.subjects;
  assert.ok(m.rewards.some(r => /Higher covers/.test(r)) && !m.rewards.some(r => /Foundation covers/.test(r)));
  assert.ok(cs.rewards.some(r => /Trilogy/.test(r)));
  assert.equal(x.say.length, DEFAULT_SUBJECT.say.length);
  assert.match(x.note, /Pick your exam board/);
  const open = guideFor({ track: 'university', subjects: [], label: 'University' });
  assert.equal(open.track, 'open'); assert.equal(open.label, 'University'); assert.ok(open.moves.length >= 4);
  const sep = guideFor({ track: 'gcse', subjects: [{ id: 'b', subject: 'biology', name: 'Biology', board: 'aqa', board_name: 'AQA', tier: 'higher' }] }).subjects[0];
  assert.ok(!sep.rewards.some(r => /Trilogy/.test(r)) && sep.rewards.some(r => /10 AQA required practicals/.test(r)));
  assert.ok(guideText(gd, 500).length <= 500);
});

// Plain, calm words: no exclamation marks, no jargon, short sentences, UK spelling.
test('copy rules over every visible string', () => {
  const words = [INTRO, SUB, LEFT_OUT_WHY, ...LEFT_OUT, ...NODES.flatMap(n => [n.title, n.line || '', n.text]), ...SECTIONS.flatMap(s => [s.name, ...s.items.flatMap(i => [i[1], i[2]])]),
    ...PLACES.flatMap(p => [p.name, p.where, ...p.items.flatMap(i => [i.say, i.does, i.when || ''])])];
  for (const t of Object.values(GUIDE)) {
    words.push(...t.moves, ...t.week.flatMap(w => [w[0], w[1], ...w[2]]));
    for (const s of Object.values(t.subjects)) for (const k of ['rewards', 'say', 'watch']) words.push(...(s[k] || []).map(l => (typeof l === 'string' ? l : l[1])));
  }
  for (const w of words) {
    assert.doesNotMatch(w, /!/, w);
    assert.doesNotMatch(w, /\b(learner|journey|unlock|color|organize)\b/i, w);
    for (const s of w.split(/(?<=[.?])\s+/)) assert.ok(s.length <= 220, `too long: ${s}`);
  }
});

test('wiring: a route on demand with the #help alias, the side bar link, .hw styles with no web fonts, not in the first view', () => {
  const main = read('js/platform/main.js');
  assert.match(main, /how: \(\) => import\('\.\/how\.js'\)/);
  assert.match(main, /ALIAS = \{ help: 'how' \}/);
  assert.doesNotMatch(main, /help\.js/);
  assert.ok(!fs.existsSync(path.join(PUB, 'js/platform/help.js')), 'help.js is gone');
  assert.match(read('platform.html'), /href="#how" data-nav="how"/);
  const css = read('css/platform.css');
  assert.match(css, /\.hw-head h1 \{/);
  assert.doesNotMatch(css, /fonts\.googleapis|url\(\s*['"]?https?:/);
  assert.doesNotMatch(main + read('js/platform/today.js'), /from\s+['"]\.\/(how|how-data|guide)\.js/, 'not in the first view');
  assert.doesNotMatch(read('js/platform/how.js'), /innerHTML|insertAdjacentHTML/);
});
