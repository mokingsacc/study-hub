import { HttpError, json, readJson } from './util.js';
import { getSetting, setSetting } from './db.js';

export const PERF_KEY = 'perf_frames';
export const KEEP = 60;
const DEVICES = ['phone', 'tablet', 'laptop'];
const PAGES = ['map'];

const num = (v, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, 'That frame summary is not valid.');
  return Math.round(n * 10) / 10;
};

/** The summary as stored, or a 400 for anything out of shape. */
export function cleanSummary(b, at = Date.now()) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'That frame summary is not valid.');
  const device = DEVICES.includes(b.device) ? b.device : null;
  const page = PAGES.includes(b.page) ? b.page : null;
  if (!device || !page) throw new HttpError(400, 'That frame summary is not valid.');
  const s = { at, page, device, frames: Math.round(num(b.frames, 1e6)), p50: num(b.p50, 1000), p90: num(b.p90, 1000), p99: num(b.p99, 1000),
    over50: Math.round(num(b.over50 ?? 0, 1e6)), w: Math.round(num(b.w ?? 0, 10000)), dpr: num(b.dpr ?? 1, 10) };
  if (s.frames < 1 || !(s.p50 <= s.p90 && s.p90 <= s.p99)) throw new HttpError(400, 'That frame summary is not valid.');
  // which way the map drew (gl/layers.js: a worker, the main thread, or Canvas 2D); anything else is left out
  if (['worker', 'main', '2d'].includes(b.renderer)) s.renderer = b.renderer;
  return s;
}

const median = a => { const d = [...a].sort((x, y) => x - y); return d.length ? d[Math.floor((d.length - 1) / 2)] : 0; };

export function byDevice(list) {
  const out = {};
  for (const dev of DEVICES) {
    const rows = list.filter(r => r.device === dev);
    if (!rows.length) continue;
    out[dev] = { visits: rows.length, frames: rows.reduce((t, r) => t + r.frames, 0),
      p50: median(rows.map(r => r.p50)), p90: median(rows.map(r => r.p90)), p99: median(rows.map(r => r.p99)) };
  }
  return out;
}

export async function record(request, env) {
  const s = cleanSummary(await readJson(request, 4000));
  const prev = await getSetting(env, PERF_KEY);
  const list = Array.isArray(prev) ? prev : [];
  await setSetting(env, PERF_KEY, [s, ...list].slice(0, KEEP));
  return json({ ok: true });
}

export async function list(request, env) {
  const prev = await getSetting(env, PERF_KEY);
  const recent = Array.isArray(prev) ? prev : [];
  return json({ recent, by_device: byDevice(recent) });
}
