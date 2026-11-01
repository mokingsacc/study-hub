// Report a problem (public/js/platform/report.js): the message it copies, the trail api.js keeps, the side bar button,
// and that it is not in the first view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8');
// report.js imports kit.js and api.js (browser modules); the message builder is pure, so it is read from the source.
const src = read('js/platform/report.js');
const reportText = new Function(`const t = ms => new Date(ms).toTimeString().slice(0, 8); return ${src.match(/export function reportText[\s\S]*?\n}\n/)[0].replace('export ', '')}`)();

test('the copied message: what they wrote, the page, the errors and the browser; a fix request only on their own copy', () => {
  const base = { what: 'The map stayed blank', trying: 'adding Physics', page: '#map', device: 'Safari; screen 820x1180',
    errors: [[Date.UTC(2026, 9, 31, 10), 'HTTP 500', '/api/p/map', 'Something went wrong'], [Date.UTC(2026, 9, 31, 10, 1), 'error', 'map.js:40', 'x is undefined']],
    visited: [[Date.UTC(2026, 9, 31, 9, 59), '#subjects']] };
  const own = reportText({ ...base, ownCopy: true });
  assert.match(own, /^Please fix a bug in my Study Hub/);
  assert.match(own, /What went wrong: The map stayed blank/);
  assert.match(own, /HTTP 500 \/api\/p\/map: Something went wrong/);
  assert.match(own, /error map\.js:40: x is undefined/);
  assert.match(own, /run npm test, then commit and push to main/);
  const shared = reportText({ ...base, ownCopy: false, errors: [] });
  assert.doesNotMatch(shared, /push to main/);
  assert.match(shared, /none recorded/);
});

test('wiring: api.js keeps the trail, boot listens, the side bar and More have the button, not in the first view', () => {
  assert.match(read('js/platform/api.js'), /globalThis\.shTrail \|\|= \[\]\)\.push\(\[Date\.now\(\), status, path, msg\]\)/);
  assert.match(read('js/platform/custom.js'), /import\('\.\/report\.js'\)\.then\(m => m\.listen\(app\)\)/);
  assert.match(read('platform.html'), /id="report"[^>]*>[\s\S]*?Report a problem<\/button>/);
  assert.match(read('js/platform/more.js'), /Report a problem/);
  for (const f of ['js/platform/main.js', 'js/platform/today.js', 'js/platform/api.js']) assert.doesNotMatch(read(f), /from '\.\/report\.js'/);
  assert.doesNotMatch(src, /document\.cookie|localStorage|csrf/i, 'no login or cookies go in it');
});
