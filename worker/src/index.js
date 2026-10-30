import { handleApi } from './router.js';
import { runScheduled } from './cron.js';
import { handleMcp } from './mcp.js';
import { errorResponse, json } from './util.js';
import { handleLive, MapLive } from './map/feed.js';
import { pageCsp } from './csp.js';
import { platformOn } from './platform/auth.js';
import { handlePlatform, isPlatformPath } from './platform/routes.js';
import { handlePlatformMcp } from './platform/mcp.js';
import { runPlatformCron } from './platform/cron.js';
import { assetVersion, parseVersioned, servePage, serveVersioned } from './assets.js';
import { LISTEN_PATH } from './listen.js';

// The live map's Durable Object (wrangler.toml MAP_LIVE): one per user, holding the open pages' sockets.
export { MapLive };

const KEY_HEADER = 'X-Hub-Key';
const enc = new TextEncoder();
async function keyMatches(given, expected) {
  if (!given || !expected) return false;
  // Hash both so the comparison is constant-time whatever the lengths.
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// The platform's own pages and scripts, hidden while the platform is off.
const PLATFORM_PAGE = /^\/(platform\.html|platform\.webmanifest|js\/platform\/|css\/platform|icons\/platform-)/;

// What the platform Worker serves besides its API: the page, its scripts and styles, the weakness scale, icons.
const PLATFORM_FILES = /^\/(platform\.html|platform\.webmanifest|robots\.txt|js\/platform\/[\w.-]+\.js|js\/map\/(?:scale|camera|colour|data|donut|families|halos|hover|labels|layout|links-draw|marks|motion|nodes|pick|render|semantic|similarity|sky|sprites|tween)\.js|js\/shared\/link-rank\.js|js\/mnemonics\/run\.js|css\/platform\.css|icons\/platform-[\w.-]+\.png)$/;

async function platformOnly(request, env, url) {
  if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true });
  if (url.pathname === '/robots.txt') return new Response(ROBOTS, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const path = url.pathname === '/' || url.pathname === '' ? '/platform.html' : url.pathname;
  if (!PLATFORM_FILES.test(path) || !env.ASSETS || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
  const u = new URL(url);
  u.pathname = path;
  return withPageHeaders(await env.ASSETS.fetch(new Request(u, request)), url);
}

const ROBOTS = 'User-agent: *\nDisallow: /\n';

/** The deploy's id (wrangler.toml [version_metadata]), or null where there is none (tests, older wrangler). */
export function deployOf(env) {
  const id = env && env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id;
  const v = id ? String(id).replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) : '';
  return v || null;
}

function noindex(response) {
  const r = new Response(response.body, response);
  r.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return r;
}

function withPageHeaders(response, url) {
  const r = noindex(response);
  if (/^text\/html\b/i.test(r.headers.get('Content-Type') || '')) {
    r.headers.set('Content-Security-Policy', pageCsp(url));
    r.headers.set('X-Content-Type-Options', 'nosniff');
  }
  return r;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (platformOn(env)) {
      if (url.pathname.startsWith('/mcp/u/') || url.pathname.startsWith('/mcp/admin/')) return noindex(await handlePlatformMcp(request, platformMcpEnv(env, url), url, ctx));
      if (isPlatformPath(url.pathname)) {
        const isAdmin = url.pathname.startsWith('/api/admin/') && await keyMatches(request.headers.get(KEY_HEADER), env.HUB_KEY);
        return noindex(await handlePlatform(request, env, ctx, url, { isAdmin }));
      }
      if (env.HUB_OFF === '1') return noindex(await platformOnly(request, env, url));
    } else if (PLATFORM_PAGE.test(url.pathname)) {
      return noindex(new Response('Not found', { status: 404 }));
    }
    if (url.pathname.startsWith('/mcp/')) return noindex(await handleMcp(request, mcpEnv(env, url, request), url, ctx));
    // The live map's WebSocket (a 60 s ticket from GET /api/map/live-ticket stands in for the key). Never wrapped
    // in noindex(): copying the response would drop the 101's webSocket.
    if (url.pathname === '/live/map') return handleLive(request, env, url);
    // The Cards page's voice commands (listen.js): a WebSocket, so its 60 s ticket (from the key-gated POST to the same
    // path) stands in for the key, checked by the route itself; not wrapped either, for the same reason.
    if (url.pathname === LISTEN_PATH && request.method === 'GET') return handleApi(request, env, ctx, url);
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/health' && request.method === 'GET') return noindex(json({ ok: true }));
      if (!(await keyMatches(request.headers.get(KEY_HEADER), env.HUB_KEY))) return noindex(errorResponse(401, 'This hub needs its bookmark link.'));
      // A change says which device it came from (X-Hub-Device; Recent activity); reads keep the shared env.
      const dev = request.method === 'GET' ? null : deviceOf(request);
      const res = noindex(await handleApi(request, dev ? { ...env, HUB_DEVICE: dev } : env, ctx, url));
      // The deploy this answer came from: an open page that sees it change reloads at its next change of page (api.js).
      const deploy = deployOf(env);
      if (deploy && res.status !== 101) res.headers.set('X-Hub-Deploy', deploy);
      return res;
    }
    if (url.pathname === '/robots.txt') {
      return new Response(ROBOTS, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' } });
    }
    if (!env.ASSETS) return noindex(new Response('Not found', { status: 404 }));
    // Scripts and styles under /v/<deploy>/ are kept by the browser for good; the pages point at them (assets.js).
    const version = assetVersion(env, url);
    const versioned = parseVersioned(url.pathname);
    if (versioned) return noindex(await serveVersioned(env, request, url, versioned, version));
    let assetUrl = url;
    if (url.pathname === '/' || url.pathname === '') {
      assetUrl = new URL(url);
      assetUrl.pathname = '/index.html';
    }
    if (version && /^\/[\w-]+\.html$/.test(assetUrl.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
      return withPageHeaders(await servePage(env, request, assetUrl, version), url);
    }
    return withPageHeaders(await env.ASSETS.fetch(assetUrl === url ? request : new Request(assetUrl, request)), url);
  },

  async scheduled(event, env, ctx) {
    if (env.HUB_OFF === '1') return runPlatformCron(event, env, ctx);
    runScheduled(event, env, ctx);
  },
};

// The platform's connectors run on each person's own Claude subscription: no Anthropic key, no AES root for
// sealed AI keys (no tool can open one).
function platformMcpEnv(env, url, request = null) {
  return { ...mcpEnv(env, url, request), PLATFORM_SECRET: undefined };
}

const DEVICES = ['phone', 'tablet', 'laptop'];
export function deviceOf(request) {
  const h = String(request.headers.get('X-Hub-Device') || '');
  if (DEVICES.includes(h)) return h;
  const ua = String(request.headers.get('User-Agent') || '');
  return /iPhone|Android.+Mobile/.test(ua) ? 'phone' : /iPad|Android/.test(ua) ? 'tablet' : null;
}
// The connector's caller, from its User-Agent: Claude Code says so; the Claude app and Claude in Chrome look alike.
export function mcpClientOf(request) {
  const ua = String((request && request.headers.get('User-Agent')) || '');
  return /claude-code/i.test(ua) ? 'code' : null;
}

function mcpEnv(env, url, request = null) {
  // HUB_ORIGIN: the hub's own address, for the question links the tools hand back (util.js questionLink).
  return { ...env, ANTHROPIC_API_KEY: undefined, CONVERSATION: '1', HUB_ORIGIN: url ? url.origin : undefined, MCP_CLIENT: mcpClientOf(request) };
}
