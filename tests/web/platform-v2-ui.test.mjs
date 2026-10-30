// Study Hub v2, WP6 (docs/platform/v2-plan.md 2.6): Settings leads with Your Claude and folds built-in AI, the phone
// tab bar is solid, Recent changes is reachable and the demo answers it.
// Run: node --test tests/web/platform-v2-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8');

test('Settings: your Claude comes before built-in AI, which is folded', () => {
  const s = read('js/platform/settings.js');
  const order = s.match(/const parts = \{([^}]+)\}/)[1].match(/\w+(?=:)/g);
  assert.ok(order.indexOf('connector') < order.indexOf('ai') && order.indexOf('account') === 0, order.join());
  assert.ok(s.indexOf("card('Your Claude'") > 0 && s.includes("'Built-in AI and your own keys'"));
  assert.match(s, /h\('details', \{ class: 'ai-fold' \}/);
});

test('the phone tab bar is solid; More lists How it works first and Recent changes', () => {
  assert.match(read('css/platform.css'), /@media \(max-width: 1023px\) \{ \.tabbar \{ background: var\(--surface\); -webkit-backdrop-filter: none; backdrop-filter: none; \} \}/);
  const more = read('js/platform/more.js');
  assert.ok(more.indexOf("row('#how'") < more.indexOf("row('#exams'"));
  assert.match(more, /recentRow\(app\)/);
});

test('the demo answers Recent changes and the map\'s Changed today', () => {
  const demo = read('js/platform/demo.js');
  assert.match(demo, /on\('GET', '\/api\/p\/recent'/);
  assert.match(demo, /on\('GET', '\/api\/p\/map\/recent'/);
  assert.match(demo, /on\('GET', '\/api\/p\/guide'/);
});

test('card review: a New, Learning, Review counts row, intervals on the buttons, and no red or orange on them', () => {
  const js = read('js/platform/cards.js'), css = read('css/platform.css');
  assert.match(js, /rv-counts/);
  assert.match(js, /current\.intervals\[r\]/);
  const rate = css.split('\n').filter(l => /^\.rate /.test(l)).join('\n');
  assert.doesNotMatch(rate, /--bad|--warn/);
});
