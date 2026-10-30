// Tiny method + path router for /api/*. Handlers get (request, env, ctx, params, url). The map's routes
// come from the area registries (map/registry/index.js), read on the first request, after these; their
// handlers also get the user, worked out once here: (request, env, ctx, params, url, user).
import { errorResponse, HttpError } from './util.js';
import * as registry from './map/registry/index.js';
import { currentUser } from './users.js';
import * as exams from './exams.js';
import * as sittings from './sittings.js';
import * as blocks from './blocks.js';
import * as transcribe from './transcribe.js';
import * as analyze from './analyze.js';
import * as outbox from './outbox.js';
import * as review from './review.js';
import * as focus from './focus.js';
import * as results from './results.js';
import * as settings from './settings.js';
import * as exporter from './export.js';
import * as plan from './plan.js';
import * as extract from './extract.js';
import * as link from './link.js';
import * as images from './images.js';
import * as summary from './summary.js';
import * as uworld from './uworld.js';
import { reviewRoute as uworldReviewRoute } from './uworld-review.js';
import * as gaps from './gaps.js';
import * as spoken from './spoken.js';
import * as backfillSignals from './backfill-signals.js';
import * as backfillAudit from './backfill-audit.js';
import { catchupRoute as patternCatchup, catchupStatusRoute as patternCatchupStatus } from './map/patterns.js';
import * as cards from './cards.js';
import * as listen from './listen.js';
import * as cardsAsk from './cards-ask.js';
import { connectorToken } from './mcp.js';
import * as perf from './perf.js';
import { NOTES_SERVER } from './mcp/notes-registry.js';
import * as examBank from './exam-bank.js';

function compile(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  return { method, pattern, re, keys, handler, who: opts.who || 'mo' };
}

const routes = [];
function add(method, pattern, handler, opts) {
  routes.push(compile(method, pattern, handler, opts));
}

// The registries' routes, compiled once. A bad entry is skipped and logged (the conventions test fails
// on it), so one area's mistake never takes the hub's own routes down.
let mapRoutes = null;
function registryRoutes() {
  if (mapRoutes) return mapRoutes;
  const out = [];
  try {
    for (const r of registry.routes()) {
      if (!registry.METHODS.includes(r.method) || typeof r.pattern !== 'string' || !r.pattern.startsWith('/api/') || typeof r.handler !== 'function') {
        console.error('registry route skipped', r.area, r.method, r.pattern);
        continue;
      }
      out.push(...compileRoutes([r]));
    }
  } catch (e) {
    console.error('registry routes failed', e && e.stack || e);
  }
  return (mapRoutes = out);
}

// Every route as {method, pattern, area} (area null for the hub's own), for the tests.
export function routeTable() {
  return routes.map(r => ({ method: r.method, pattern: r.pattern, area: null }))
    .concat(registryRoutes().map(r => ({ method: r.method, pattern: r.pattern, area: r.area })));
}

add('GET', '/api/state', settings.state);
add('POST', '/api/exams', exams.create);
add('POST', '/api/exams/extract', extract.extract);
add('POST', '/api/link', link.link);
add('POST', '/api/link/image', link.image);
add('POST', '/api/images', images.upload);
add('GET', '/api/images/:id', images.get);
add('GET', '/api/exams/:id', exams.get);
add('PUT', '/api/exams/:id', exams.putAnswers);
add('DELETE', '/api/exams/:id', exams.remove);
add('POST', '/api/sittings', sittings.create);
add('GET', '/api/sittings/:id', sittings.get);
add('PATCH', '/api/sittings/:id', sittings.patch);
add('DELETE', '/api/sittings/:id', sittings.remove);
add('POST', '/api/sittings/:id/finish-review', review.finishReview);
add('GET', '/api/sittings/:id/summary', summary.summaryRoute);
// The connector link for Settings (behind the key gate like every /api route).
add('GET', '/api/connector', async (request, env, ctx, params, url) => new Response(JSON.stringify({ url: `${url.origin}/mcp/${await connectorToken(env.HUB_KEY)}`,
  // The Notes connector (I30), only once Notes is released.
  ...(env.NOTES === 'on' ? { notes_url: `${url.origin}/mcp/${await connectorToken(env.HUB_KEY, NOTES_SERVER)}` } : {}) }), { headers: { 'Content-Type': 'application/json' } }));
add('PUT', '/api/blocks', blocks.upsert);
add('POST', '/api/blocks/:id/end', blocks.end);
add('POST', '/api/transcribe', transcribe.transcribe);
add('PUT', '/api/transcripts', transcribe.putTranscript);
add('POST', '/api/analyze', analyze.analyzeRoute);
add('PATCH', '/api/analyses', analyze.patchAnalysis);
add('POST', '/api/outbox/flush', outbox.flushRoute);
add('GET', '/api/outbox', outbox.list);
add('GET', '/api/results', results.list);
add('GET', '/api/healthhub/scores', results.healthhub);
add('GET', '/api/focus', focus.get);
add('GET', '/api/settings', settings.get);
add('PUT', '/api/settings', settings.put);
add('GET', '/api/plan', plan.get);
add('POST', '/api/plan/seed', plan.seed);
add('POST', '/api/uworld', plan.addUworld);
add('DELETE', '/api/uworld/:id', plan.removeUworld);
add('PUT', '/api/uworld-blocks', uworld.put);
add('DELETE', '/api/uworld-blocks/:id', uworld.deleteBlock);
add('POST', '/api/uworld-blocks/:id/results', uworld.resultsShot);
add('GET', '/api/uworld-blocks/:id/review', uworldReviewRoute);
add('PUT', '/api/anki-sessions', spoken.put);
add('POST', '/api/anki-sessions/:id/check', spoken.checkRoute);
add('POST', '/api/anki-sessions/:id/alive', spoken.aliveRoute);
add('POST', '/api/gaps', gaps.post);
add('POST', '/api/backfill/spoken-signals', backfillSignals.startRoute);
add('POST', '/api/backfill/audit-cleanup', backfillAudit.route);
add('GET', '/api/backfill/spoken-signals', backfillSignals.statusRoute);
add('POST', '/api/backfill/patterns', patternCatchup);
add('GET', '/api/backfill/patterns', patternCatchupStatus);
// Cards (#cards): Anki review in the hub, proxied to the Anki Voice server's review tools (cards.js).
add('GET', '/api/cards/open', cards.open);
add('GET', '/api/cards/decks', cards.decks);
add('POST', '/api/cards/deck', cards.deck);
add('POST', '/api/cards/start', cards.start);
add('GET', '/api/cards/next', cards.next);
add('GET', '/api/cards/notes', cards.notes);
add('POST', '/api/cards/undo', cards.undo);
add('POST', '/api/cards/end', cards.end);
// Voice commands on the Cards page: a ticket, then the WebSocket to the speech model (listen.js; index.js lets this GET
// past the key gate, the ticket stands in for the key).
add('POST', '/api/cards/listen', listen.ticket);
add('GET', '/api/cards/listen', listen.socket);
// Ask Claude about the card on screen (cards-ask.js): the answer streams back; read aloud on request.
add('POST', '/api/cards/speak', cardsAsk.speak);
add('POST', '/api/cards/:id/ask', cardsAsk.ask);
add('GET', '/api/cards/:id/intervals', cards.intervals);
add('GET', '/api/cards/:id/images', cards.images);
add('POST', '/api/cards/:id/rate', cards.rate);
add('POST', '/api/cards/:id/bury', cards.bury);
add('POST', '/api/cards/:id/suspend', cards.suspend);
add('PUT', '/api/cms', plan.putCms);
add('DELETE', '/api/cms/:id', plan.removeCms);
// The exam bank (exam-bank.js): the Library's exam questions, their filters and "Ask the data".
add('GET', '/api/exam-bank/search', examBank.searchRoute);
add('GET', '/api/exam-bank/facets', examBank.facetsRoute);
add('GET', '/api/exam-bank/q/:id', examBank.questionRoute);
add('POST', '/api/exam-bank/ask', examBank.askRoute);
// Real-use frame times from the map (perf.js, speed 29 Oct).
add('POST', '/api/perf/frames', perf.record);
add('GET', '/api/perf/frames', perf.list);
add('GET', '/api/export', exporter.exportAll);
add('POST', '/api/import', exporter.importAll);

export async function handleApi(request, env, ctx, url) {
  return dispatch(request, env, ctx, url, routes.concat(registryRoutes()));
}

// Registry-shaped routes ({area, method, pattern, handler, opts}) compiled for dispatch (the tests use it).
export function compileRoutes(list) {
  return list.map(r => ({ ...compile(r.method, r.pattern, r.handler, r.opts), area: r.area, withUser: true }));
}

export async function dispatch(request, env, ctx, url, table) {
  let pathMatched = false;
  for (const r of table) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== request.method) continue;
    try {
      const params = {};
      try {
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      } catch {
        return errorResponse(400, 'That address is not valid.');
      }
      if (r.withUser) return await r.handler(request, env, ctx, params, url, await currentUser(env, request));
      return await r.handler(request, env, ctx, params, url);
    } catch (e) {
      if (e instanceof HttpError) return errorResponse(e.status, e.message);
      console.error('api error', request.method, url.pathname, e && e.stack || e);
      return errorResponse(500, 'Something went wrong on the hub. Please try again in a moment.');
    }
  }
  if (pathMatched) return errorResponse(405, 'That action is not available here.');
  return errorResponse(404, 'There is nothing at that address.');
}
