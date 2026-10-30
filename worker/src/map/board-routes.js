// The Review page's REST routes (plan §13; owner REV), registered in registry/review.js:
//   GET   /api/board/summary                      the summary strip (all-time counts, the checklist's Done line)
//   GET   /api/board/log?since=7|30|all&topic=    the error log's rows (default 30 days), topics, units, categories
//   GET   /api/board/misses?ids=a,b,c             the stored long fields of the rows being opened (100 at most)
//   GET   /api/board/misses/:id/anki              Right reasoning and Other options, live from Anki, never stored
//   GET   /api/board/tally?since=7|30|all         the Topic tally's and High yield's data (default all)
//   GET   /api/board/checklist                    the Master Checklist
//   PATCH /api/board/checklist {unit_id, step, value}   op checklist.tick; Undo is POST /api/changes/undo
//   PATCH /api/board/misses/:id {reviewed}        op miss.review
// The four data GETs carry an ETag made of the map's change seq and the London day, so a page that already holds
// that copy gets a 304 for one indexed read; their bodies are D1's own JSON text, spliced, never re-parsed.
import { HttpError, json, readJson, londonDay } from '../util.js';
import { applyChange, changeResponse } from './change.js';
import { latestSeq } from './events.js';
import { fnv1a } from './ingest/map-fields.js';
import { logData, tallyData, checklistData, summaryData, missDetail, missFromAnki } from './board.js';
import { LOG_COLS, TALLY_COLS, RANGES, isDay, sinceDay } from '../../../public/js/board/shape.js';

export const ETAG_VERSION = 'b1';
const CACHE = 'private, no-cache';

export const etagOf = (kind, seq, today, sig = '') => `W/"${ETAG_VERSION}-${kind}-${seq}-${today}-${fnv1a(sig)}"`;
const matchesTag = (header, tag) => !!header && header.split(',').map(s => s.trim()).some(s => s === tag || s === '*');

function tagged(body, tag) {
  return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': CACHE, ETag: tag } });
}
const notModified = tag => new Response(null, { status: 304, headers: { 'Cache-Control': CACHE, ETag: tag } });

// A cached GET: 304 when the page already holds this seq's copy (one read), else the built body with its tag.
async function cachedGet(request, env, user, { kind, sig, today, build }) {
  const want = request.headers.get('If-None-Match');
  if (want) {
    const seq = await latestSeq(env, user);
    const tag = etagOf(kind, seq, today, sig);
    if (matchesTag(want, tag)) return notModified(tag);
  }
  const { seq, body } = await build();
  return tagged(body, etagOf(kind, seq, today, sig));
}

// ?since=7|30|all, or a day; the default when it is missing. Returns {range, since}.
export function readRange(v, today, fallback) {
  const s = v == null || v === '' ? fallback : String(v);
  if (RANGES.includes(s)) return { range: s, since: sinceDay(today, s) };
  if (isDay(s)) return { range: 'day', since: s };
  throw new HttpError(400, 'since is 7, 30, all or a day like 2026-10-18.');
}
const str = v => JSON.stringify(v ?? null);

// GET /api/board/summary
export async function summaryRoute(request, env, ctx, params, url, user) {
  const today = londonDay();
  return cachedGet(request, env, user, {
    kind: 'summary', sig: '', today,
    build: async () => { const s = await summaryData(env, user, { today }); return { seq: s.seq, body: JSON.stringify(s) }; },
  });
}

// GET /api/board/log?since=&topic=
export async function logRoute(request, env, ctx, params, url, user) {
  const today = londonDay();
  const { range, since } = readRange(url.searchParams.get('since'), today, '30');
  const topic = (url.searchParams.get('topic') || '').slice(0, 120) || null;
  return cachedGet(request, env, user, {
    kind: 'log', sig: `${since}|${topic}`, today,
    build: async () => {
      const d = await logData(env, user, { since, topic });
      return { seq: d.seq, body: `{"seq":${d.seq},"today":${str(today)},"range":${str(range)},"since":${str(since)},"topic":${str(topic)},`
        + `"cols":${JSON.stringify(LOG_COLS)},"rows":${d.rows},"topics":${d.topics},"units":${d.units},"categories":${d.categories}}` };
    },
  });
}

// GET /api/board/tally?since=
export async function tallyRoute(request, env, ctx, params, url, user) {
  const today = londonDay();
  const { range, since } = readRange(url.searchParams.get('since'), today, 'all');
  return cachedGet(request, env, user, {
    kind: 'tally', sig: `${since}`, today,
    build: async () => {
      const d = await tallyData(env, user, { since });
      return { seq: d.seq, body: `{"seq":${d.seq},"today":${str(today)},"range":${str(range)},"since":${str(since)},"cols":${JSON.stringify(TALLY_COLS)},`
        + `"rows":${d.rows},"topics":${d.topics},"units":${d.units},"progress":${d.progress},"chips":${d.chips},"categories":${d.categories}}` };
    },
  });
}

// GET /api/board/checklist
export async function checklistRoute(request, env, ctx, params, url, user) {
  const today = londonDay();
  return cachedGet(request, env, user, {
    kind: 'checklist', sig: '', today,
    build: async () => {
      const d = await checklistData(env, user);
      return { seq: d.seq, body: `{"seq":${d.seq},"today":${str(today)},"units":${d.units},"progress":${d.progress},"miss_counts":${d.miss_counts},`
        + `"chips":${d.chips},"categories":${d.categories}}` };
    },
  });
}

// GET /api/board/misses?ids=a,b,c
export async function missesRoute(request, env, ctx, params, url, user) {
  const raw = (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!raw.length) throw new HttpError(400, 'Which misses? (ids is missing)');
  if (raw.length > 100) throw new HttpError(400, 'At most 100 misses at a time.');
  return json({ misses: await missDetail(env, user, raw, { audience: 'page' }) });
}

// GET /api/board/misses/:id/anki (no-store: json() never lets it be cached)
export async function missAnkiRoute(request, env, ctx, params, url, user) {
  return json(await missFromAnki(env, user, params.id));
}

// PATCH /api/board/checklist {unit_id, step, value}
export async function tickRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'checklist.tick', args: body, via: 'api:PATCH /api/board/checklist' }));
}

// PATCH /api/board/misses/:id {reviewed}
export async function reviewRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  for (const k of Object.keys(body)) if (k !== 'reviewed') throw new HttpError(400, `Unknown field ${k}.`);
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'miss.review', args: { ids: [params.id], reviewed: body.reviewed },
    via: 'api:PATCH /api/board/misses/:id' }));
}
