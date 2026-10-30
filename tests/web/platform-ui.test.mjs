// Study Hub page (public/platform.html, public/js/platform/*.js), without a browser: the page works under the hub's
// strict CSP (no inline scripts or handlers), every module parses, no HTML is built from data, the first view stays
// under its JS budget, and the Add to Home Screen pieces are in place.
// Run: node --test tests/web/platform-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8');
const JS_DIR = 'js/platform';
const modules = fs.readdirSync(path.join(PUB, JS_DIR)).filter(f => f.endsWith('.js')).sort();
const html = read('platform.html');

test('platform.html has no inline scripts or inline event handlers (pageCsp: script-src self)', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1, 'loads at least one script');
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc=/, 'every script has a src');
    assert.equal(body.trim(), '', 'no inline script body');
    assert.doesNotMatch(attrs, /src=["']?(https?:)?\/\//, 'scripts come from the hub itself');
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline on* handlers');
  assert.doesNotMatch(html, /javascript:/i, 'no javascript: URLs');
  assert.match(html, /<script type="module" src="js\/platform\/main\.js"><\/script>/);
});

test('platform.html carries the iPhone and iPad pieces', () => {
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover/);
  assert.match(html, /<link rel="manifest" href="platform\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/platform-180\.png">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="theme-color"/);
  assert.match(html, /<html lang="en-GB">/);
  assert.ok(fs.existsSync(path.join(PUB, 'icons/platform-180.png')));
});

test('every public/js/platform/*.js parses as an ES module', () => {
  assert.ok(modules.length >= 10, `found ${modules.length} modules`);
  for (const f of modules) {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: read(`${JS_DIR}/${f}`), encoding: 'utf8' });
    assert.equal(r.status, 0, `${f} does not parse: ${r.stderr}`);
  }
});

test('no HTML is built from data: no innerHTML/outerHTML assignment except a literal, no insertAdjacentHTML or document.write', () => {
  for (const f of modules) {
    const src = read(`${JS_DIR}/${f}`);
    for (const m of src.matchAll(/\.(innerHTML|outerHTML)\s*\+?=\s*([^;\n]*)/g)) {
      assert.match(m[2].trim(), /^(['"])[^'"$]*\1$/, `${f}: ${m[0]} assigns non-literal HTML`);
    }
    assert.doesNotMatch(src, /insertAdjacentHTML|document\.write|new Function\(|\beval\(/, `${f} uses an HTML or code string sink`);
    assert.doesNotMatch(src, /localStorage\.[a-zA-Z]+\([^)]*csrf/i, `${f} must keep the CSRF token in memory only`);
  }
});

test('the CSRF token lives in api.js memory and goes out on writes with same-origin credentials', () => {
  const api = read(`${JS_DIR}/api.js`);
  assert.match(api, /'X-CSRF-Token'/);
  assert.match(api, /credentials: 'same-origin'/);
  assert.doesNotMatch(api, /(localStorage|sessionStorage)\.setItem\([^)]*csrf/i);
});

// The static import graph from a module (dynamic import() is on demand and not counted).
function graph(rel, seen = new Set()) {
  if (seen.has(rel)) return seen;
  seen.add(rel);
  const src = read(rel);
  for (const m of src.matchAll(/^\s*import\s+(?:[^'"()]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    graph(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])), seen);
  }
  return seen;
}

test('first view (shell + Today) stays under 40 KB of JS gzipped; demo fixtures never load outside demo mode', () => {
  const files = new Set([...graph(`${JS_DIR}/main.js`), ...graph(`${JS_DIR}/today.js`)]);
  assert.ok(!files.has(`${JS_DIR}/demo.js`), 'demo.js is not in the first view');
  let raw = 0, gz = 0;
  for (const f of files) { const b = fs.readFileSync(path.join(PUB, f)); raw += b.length; gz += zlib.gzipSync(b, { level: 9 }).length; }
  assert.ok(gz < 40 * 1024, `first view is ${gz} bytes gzipped`);
  assert.ok(raw < 40 * 1024, `first view is ${raw} bytes raw`);
  for (const f of modules) {
    if (f === 'api.js') continue;
    assert.doesNotMatch(read(`${JS_DIR}/${f}`), /from\s+['"]\.\/demo\.js['"]/, `${f} must not import demo.js statically`);
  }
  assert.match(read(`${JS_DIR}/api.js`), /import\('\.\/demo\.js'\)/, 'api.js loads demo.js on demand');
  // Each screen is loaded with import() by the router.
  const main = read(`${JS_DIR}/main.js`);
  for (const s of ['today', 'subjects', 'cards', 'results', 'library', 'settings', 'welcome', 'auth']) {
    assert.match(main, new RegExp(`import\\('\\./${s}\\.js'\\)`), `${s}.js is loaded on demand`);
  }
});

test('platform.webmanifest: standalone, colours, icons that exist and stay small', () => {
  const m = JSON.parse(read('platform.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.name && m.short_name && m.start_url && m.theme_color && m.background_color);
  const sizes = new Set(m.icons.map(i => i.sizes));
  assert.ok(sizes.has('192x192') && sizes.has('512x512'));
  for (const i of m.icons) {
    const f = path.join(PUB, i.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(f), `${i.src} exists`);
    const b = fs.readFileSync(f);
    assert.ok(b.length < 10 * 1024, `${i.src} is ${b.length} bytes`);
    assert.equal(b.subarray(1, 4).toString(), 'PNG');
    const [w, hgt] = [b.readUInt32BE(16), b.readUInt32BE(20)];
    assert.equal(`${w}x${hgt}`, i.sizes, `${i.src} is really ${i.sizes}`);
  }
});

test('stylesheet: Bento tokens, light and dark, 16 px inputs, safe areas, long lists', () => {
  const css = read('css/platform.css');
  assert.match(css, /--font: -apple-system/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /\.input[^{]*\{[^}]*font: 400 16px/, 'inputs are 16 px so iOS does not zoom');
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /100dvh/);
  assert.match(css, /content-visibility: auto/);
  assert.match(css, /--tap: 44px/);
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/, 'no web fonts or remote assets');
});

// ------------------------------------------------------------------ v1.5: the galaxy map, topic sheet, today's choice, sharing

// Every file outside js/platform/ the map's pages load (the static allowlist PLATFORM_FILES in worker/src/index.js
// must serve exactly these, besides scale.js which is already there). layout.js comes in by import() for the first
// layout and the upright reshape, so it is listed with its own graph.
const MAP_STATIC = ['js/map/camera.js', 'js/map/colour.js', 'js/map/data.js', 'js/map/donut.js', 'js/map/families.js', 'js/map/halos.js', 'js/map/hover.js', 'js/map/labels.js', 'js/map/layout.js',
  'js/map/links-draw.js', 'js/map/marks.js', 'js/map/motion.js', 'js/map/nodes.js', 'js/map/pick.js', 'js/map/render.js', 'js/map/scale.js', 'js/map/semantic.js', 'js/map/similarity.js',
  'js/map/sky.js', 'js/map/sprites.js', 'js/map/tween.js', 'js/shared/link-rank.js'];

test('the map screen reuses Mo\'s map modules, loads on demand, and pulls in no hub client, no d3 and no HTML sink', () => {
  const main = read(`${JS_DIR}/main.js`);
  assert.match(main, /map: \(\) => import\('\.\/map\.js'\)/, 'map.js is loaded on demand');
  const graphOf = files => { const s = new Set(); for (const f of files) graph(f, s); return s; };
  const first = graphOf([`${JS_DIR}/main.js`, `${JS_DIR}/today.js`]);
  for (const f of ['map.js', 'map-camera.js', 'topic.js', 'teach.js', 'choice.js', 'kit.js']) assert.ok(!first.has(`${JS_DIR}/${f}`), `${f} is not in the first view`);
  const g = graphOf([`${JS_DIR}/map.js`, 'js/map/layout.js', `${JS_DIR}/topic.js`, `${JS_DIR}/choice.js`]);
  const outside = [...g].filter(f => !f.startsWith(`${JS_DIR}/`)).sort();
  assert.deepEqual(outside, MAP_STATIC, 'the static paths the lead allows on the platform Worker');
  for (const f of ['js/map/render.js', 'js/map/data.js', 'js/map/layout.js', 'js/map/sky.js']) assert.ok(g.has(f), `reuses ${f}`);
  for (const f of g) {
    const src = read(f);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, `${f} builds no HTML from strings`);
    assert.ok(!/from '\.\.\/api\.js'|from '\.\/d3\.js'|from '\.\.\/map\/d3\.js'|from '\.\.\/map\/main\.js'/.test(src), `${f} pulls in neither Mo's hub client, d3 nor his map page`);
  }
  assert.match(read(`${JS_DIR}/map.js`), /import\('\.\.\/map\/layout\.js'\)/, 'the layout loads only when needed');
  assert.match(read(`${JS_DIR}/map.js`), /getTagged\(PATH, S\.etag\)/, 'the map revalidates its saved copy with the ETag');
  assert.match(read(`${JS_DIR}/map.js`), /put\('\/api\/p\/map\/positions'/);
});

test('nav: Map in the side bar and the tab bar; Papers only when switched on', () => {
  assert.equal((html.match(/<a href="#map" data-nav="map">/g) || []).length, 2);
  assert.match(html, /<a href="#papers" data-nav="papers" data-module="papers" data-optin hidden>/);
  assert.doesNotMatch(html, /<nav class="tabbar"[\s\S]*data-nav="subjects"[\s\S]*<\/nav>/, 'Subjects moves to More on a phone');
});

test('Teach me and the morning choice record the tap with keepalive and open Claude through a real link', () => {
  const teach = read(`${JS_DIR}/teach.js`);
  assert.match(teach, /https:\/\/claude\.ai\/new\?q=\$\{encodeURIComponent\(prompt\)\}/);
  assert.match(teach, /post\('\/api\/p\/teach\/request', \{ topic_id: topic\.id \}, \{ keepalive: true \}\)/);
  const choice = read(`${JS_DIR}/choice.js`);
  assert.match(choice, /post\('\/api\/p\/today\/choice\/choose', \{ topic_id: o\.topic\.id \}, \{ keepalive: true \}\)/);
  assert.match(choice, /get\('\/api\/p\/today\/choice'\)/);
  assert.match(read(`${JS_DIR}/api.js`), /keepalive: !!opts\.keepalive/);
  assert.match(read(`${JS_DIR}/today.js`), /import\('\.\/choice\.js'\)/, 'the choice paints after Today');
  const topic = read(`${JS_DIR}/topic.js`);
  assert.match(topic, /\/api\/p\/topics\/\$\{enc\(t\.id\)\}\/knowledge/);
  assert.match(read(`${JS_DIR}/settings.js`), /put\('\/api\/p\/sharing', \{ share: on \}\)/);
});

test('demo mode answers every v1.5 route the new screens call', () => {
  const demo = read(`${JS_DIR}/demo.js`);
  for (const r of ["on('GET', '/api/p/map'", "on('PUT', '/api/p/map/positions'", "on('GET', '/api/p/topics/:id/knowledge'", "on('POST', '/api/p/teach/request'",
    "on('GET', '/api/p/today/choice'", "on('POST', '/api/p/today/choice/choose'", "on('GET', '/api/p/sharing'", "on('PUT', '/api/p/sharing'"]) {
    assert.ok(demo.includes(r), `demo.js answers ${r.slice(4)}`);
  }
});

test('stylesheet: the map is full-bleed between the bars with Mo\'s canvas tokens for the light map and the night sky', () => {
  const css = read('css/platform.css');
  assert.match(css, /\.pmap \{[^}]*--map-ground: #f7f9fc/);
  assert.match(css, /\.pmap\[data-sky="night"\] \{[^}]*--map-ground: #0b1016/);
  assert.match(css, /\.pm-scene \{ touch-action: none;/, 'pinch and pan go to the map, not the page');
  assert.match(css, /\.shell:not\(\.solo\) \.pmap \{ left: var\(--side-w\); bottom: 0; \}/);
});
