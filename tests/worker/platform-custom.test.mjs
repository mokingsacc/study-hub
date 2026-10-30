// Make it mine (layer 1): each person customises only their own hub, as validated data (spec 1), with undo; their
// Claude does it through my_hub_* tools; nothing reaches anyone else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.js';
import { BASE, platformEnv, signedIn } from './platform-helpers.mjs';
import { validateCustom, applyPatch, describe, OPTIONS } from '../../worker/src/platform/custom.js';
import { SKY, SKY_SWATCHES } from '../../public/js/map/colour.js';

const rpc = async (env, path, name, args) => {
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), env, { waitUntil() {} });
  return (await res.json()).result;
};

test('the spec: fixed choices, typed blocks, https links only, plain-words refusals; never red or orange accents', () => {
  const c = validateCustom({ theme: { accent: 'purple', text_size: 'large' }, today: { order: ['cards', 'subjects'], hidden: ['results'], greeting: 'Hi Alex' },
    nav: { hidden: ['results'] }, pages: [{ title: 'Required practicals', icon: 'flask', blocks: [{ type: 'checklist', items: ['Making salts', { text: 'Chromatography', done: true }] },
      { type: 'links', items: [{ label: 'BBC Bitesize', url: 'https://www.bbc.co.uk/bitesize' }] }, { type: 'countdown', label: 'Paper 1', date: '2027-05-20' }] }],
    teach: { notes: 'More diagrams, shorter turns.' } });
  assert.equal(c.pages[0].id, 'required-practicals');
  assert.deepEqual(c.pages[0].blocks[0].items[0], { text: 'Making salts', done: false });
  assert.ok(!OPTIONS.theme.accent.includes('red') && !OPTIONS.theme.accent.includes('orange'), 'Ember colours stay for weakness only');
  for (const [badSpec, re] of [
    [{ theme: { accent: 'red' } }, /accent must be one of/],
    [{ theme: { css: 'body{}' } }, /theme has no "css"/],
    [{ script: 'alert(1)' }, /has no "script"/],
    [{ pages: [{ title: 'X', blocks: [{ type: 'html', html: '<script>' }] }] }, /type must be one of/],
    [{ pages: [{ title: 'X', blocks: [{ type: 'links', items: [{ label: 'x', url: 'javascript:alert(1)' }] }] }] }, /https/],
    [{ pages: [{ title: 'X', blocks: [{ type: 'links', items: [{ label: 'x', url: 'http://a.test' }] }] }] }, /https/],
    [{ today: { hidden: ['everything'] } }, /tile in today.hidden/],
    [{ teach: { notes: 'x'.repeat(601) } }, /at most 600/],
  ]) assert.throws(() => validateCustom(badSpec), re);
  const p = applyPatch(c, { theme: { accent: 'teal', text_size: null }, nav: null });
  assert.equal(p.theme.accent, 'teal');
  assert.equal(p.theme.text_size, undefined, 'null removes');
  assert.equal(p.nav, undefined);
  assert.match(describe(c, p), /accent: teal/);
});

test('routes: patch, undo, reset, export and import; only the signed-in person changes', async () => {
  const { d, env } = platformEnv();
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  let r = await alex.c.call('PATCH', '/api/p/custom', { patch: { theme: { accent: 'purple' }, today: { hidden: ['results'] } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.changed, /accent: purple/);
  r = await alex.c.call('PATCH', '/api/p/custom', { patch: { theme: { accent: 'green' } } });
  assert.equal((await sam.c.call('GET', '/api/p/custom')).data.custom.theme, undefined, "Sam's hub is untouched");
  r = await alex.c.call('POST', '/api/p/custom/undo');
  assert.equal(r.data.custom.theme.accent, 'purple');
  assert.equal((await alex.c.call('PATCH', '/api/p/custom', { patch: { theme: { accent: 'red' } } })).status, 400);
  const exp = await alex.c.call('GET', '/api/p/custom/export');
  assert.equal(exp.data.kind, 'study-hub-custom');
  assert.equal((await sam.c.call('POST', '/api/p/custom/import', exp.data)).status, 200);
  assert.equal((await sam.c.call('GET', '/api/p/custom')).data.custom.theme.accent, 'purple', 'an export carries over (layer 2 reads the same spec)');
  assert.equal((await alex.c.call('POST', '/api/p/custom/reset')).data.custom.theme, undefined);
  const row = d.row("SELECT prefs_json FROM users WHERE id = 'mo'");
  assert.ok(!/custom/.test(row.prefs_json), "Mo's own prefs are never touched");
  d.close();
});

test("their own Claude changes their hub with my_hub_change, and teaching notes reach teach_next's brief", async () => {
  const { d, env } = platformEnv();
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  const link = new URL((await alex.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  const got = await rpc(env, link, 'my_hub_get', {});
  assert.ok(got.structuredContent.options.theme.accent.includes('purple'));
  const ch = await rpc(env, link, 'my_hub_change', { patch: { theme: { accent: 'pink', mode: 'dark' }, teach: { notes: 'Use diagrams and short turns.' },
    pages: [{ title: 'Psychology studies', blocks: [{ type: 'checklist', items: ['Milgram', 'Asch', 'Zimbardo'] }] }] } });
  assert.ok(!ch.isError, JSON.stringify(ch));
  assert.match(ch.structuredContent.changed, /new page: Psychology studies/);
  const bad = await rpc(env, link, 'my_hub_change', { patch: { theme: { accent: 'orange' } } });
  assert.equal(bad.isError, true);
  assert.match(bad.structuredContent.reason, /accent must be one of/);
  assert.equal((await rpc(env, link, 'my_hub_reset', { confirm: false })).isError, true, 'reset asks first');
  assert.equal((await sam.c.call('GET', '/api/p/custom')).data.custom.pages, undefined, 'only Alex has the page');
  const undo = await rpc(env, link, 'my_hub_undo', {});
  assert.match(undo.structuredContent.changed, /undone/);
  d.close();
});

test("the map sky per person: Mo's swatches or a custom hue, his brightness range, Ink at 1 by default; only their hub changes", async () => {
  assert.deepEqual(OPTIONS.theme.sky, [...SKY_SWATCHES.map(s => s.id), 'custom']);
  assert.deepEqual([OPTIONS.sky.brightness.min, OPTIONS.sky.brightness.max, OPTIONS.sky.brightness.default], [SKY.min, SKY.max, 1]);
  assert.equal(SKY.swatch, 'ink', 'the default is the Ink swatch, as Mo');
  assert.deepEqual(validateCustom({ theme: { sky: 'plum', sky_brightness: 1.234 } }).theme, { sky: 'plum', sky_brightness: 1.25 }, 'brightness in steps of 0.05');
  assert.deepEqual(validateCustom({ theme: { sky_hue: 140.4 } }).theme, { sky: 'custom', sky_hue: 140 }, 'a hue alone is a custom sky');
  assert.deepEqual(validateCustom({ theme: { sky: 'teal', sky_hue: 140 } }).theme, { sky: 'teal' }, 'a swatch drops the hue');
  for (const [badSpec, re] of [
    [{ theme: { sky: 'red' } }, /theme.sky must be one of/],
    [{ theme: { sky_hue: 360 } }, /sky_hue must be a number from 0 to 359/],
    [{ theme: { sky_hue: '40' } }, /sky_hue must be a number/],
    [{ theme: { sky_brightness: 1.5 } }, /sky_brightness must be a number from 0.6 to 1.4/],
    [{ theme: { sky_brightness: 0.5 } }, /from 0.6 to 1.4/],
  ]) assert.throws(() => validateCustom(badSpec), re);
  const c = applyPatch({ spec: 1, theme: { sky: 'custom', sky_hue: 200, sky_brightness: 0.8 } }, { theme: { sky: 'ember' } });
  assert.deepEqual(c.theme, { sky: 'ember', sky_brightness: 0.8 });
  assert.match(describe({ spec: 1 }, { spec: 1, theme: { sky: 'custom', sky_hue: 200, sky_brightness: 0.8 } }), /map sky: custom; sky hue: 200; sky brightness: 80%/);
  assert.match(describe(c, applyPatch(c, { theme: { sky: null, sky_brightness: null } })), /map sky: default; sky brightness: 100%/);

  const { d, env } = platformEnv();
  const alex = await signedIn(env, 'Alex', { profile: 'alevel' });
  const sam = await signedIn(env, 'Sam', { profile: 'gcse' });
  const r = await alex.c.call('PATCH', '/api/p/custom', { patch: { theme: { sky: 'custom', sky_hue: 30, sky_brightness: 1.2 } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.custom.theme, { sky: 'custom', sky_hue: 30, sky_brightness: 1.2 });
  assert.equal((await alex.c.call('PATCH', '/api/p/custom', { patch: { theme: { sky_brightness: 2 } } })).status, 400);
  assert.equal((await sam.c.call('GET', '/api/p/custom')).data.custom.theme, undefined, "Sam's sky is untouched");
  const got = await alex.c.call('GET', '/api/p/custom');
  assert.deepEqual(got.data.options.sky.hue, { min: 0, max: 359, default: SKY.hue });
  const link = new URL((await sam.c.call('POST', '/api/p/connector', { label: 'Claude' })).data.url).pathname;
  const ch = await rpc(env, link, 'my_hub_change', { patch: { theme: { sky: 'midnight', sky_brightness: 0.7 } } });
  assert.ok(!ch.isError, JSON.stringify(ch));
  assert.match(ch.structuredContent.changed, /map sky: midnight/);
  assert.match((await rpc(env, link, 'my_hub_get', {})).structuredContent.how, /sky_brightness/);
  assert.deepEqual((await alex.c.call('GET', '/api/p/custom')).data.custom.theme.sky, 'custom', "Alex's sky is hers");
  const row = d.row("SELECT prefs_json FROM users WHERE id = 'mo'");
  assert.ok(!/sky/.test(row.prefs_json || ''), "Mo's own map prefs are never touched");
  d.close();
});

test('the front end paints the sky with colour.js skyVars; the demo offers the same sky options', async () => {
  const { skyVars, skyChoice } = await import('../../public/js/map/colour.js');
  const fs = await import('node:fs');
  const src = f => fs.readFileSync(new URL(`../../public/js/platform/${f}`, import.meta.url), 'utf8');
  assert.match(src('custom.js'), /skyVars\(choice, theme\)/);
  assert.match(src('map.js'), /paintSky\(el, S\.sky, skyTheme\(\)\)/);
  assert.match(src('map.js'), /'Sky colour'/);
  assert.match(src('demo.js'), /sky: \['ink', 'ember', 'plum', 'aubergine', 'indigo', 'teal', 'midnight', 'custom'\]/);
  assert.deepEqual(OPTIONS.theme.sky, ['ink', 'ember', 'plum', 'aubergine', 'indigo', 'teal', 'midnight', 'custom']);
  assert.equal(skyVars(skyChoice({}), 'night')['--map-ground'], '#16181d', 'nothing chosen: Ink at brightness 1');
});

test('v2: a topics block can show one of their galaxies; a stored help tab is How it works now', () => {
  const c = validateCustom({ pages: [{ title: 'Mock 1', blocks: [{ type: 'topics', title: 'Mock 1 topics', galaxy: 'Mock 1', show: 'all' }] }], nav: { hidden: ['help', 'results'] } });
  assert.equal(c.pages[0].blocks[0].galaxy, 'Mock 1');
  assert.deepEqual(c.nav.hidden, ['how', 'results']);
  assert.ok(OPTIONS.tabs.includes('how') && !OPTIONS.tabs.includes('help'));
});
