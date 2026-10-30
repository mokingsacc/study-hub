// The hub's own files, versioned per deploy (PERF5): a page's scripts and styles are served under /v/<version>/...
// with `immutable`, so a repeat open reads every module and stylesheet from the browser's cache instead of asking
// the hub about each one again (a warm open used to send 20 to 50 revalidations). The version is the Worker's
// deploy (CF_VERSION_METADATA.id, wrangler.toml [version_metadata]): every `wrangler deploy` makes a new one, so
// the next open after a deploy fetches the new files, and the pages themselves are always asked for again
// (`no-cache`, with an ETag of the page and the version), so they never point at old files.
//
// Nothing else changes: API answers are never cached here (they stay no-store behind the key), relative imports
// inside a module resolve under the same /v/<version>/ prefix by themselves, and without the binding (tests, an
// older wrangler) or on wrangler dev (whose files change under one version) everything is served as before.

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/i;
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'no-cache';
const VERSION_RE = /^[A-Za-z0-9-]{1,64}$/;

/** The deploy's asset version, or null when files are served unversioned. */
export function assetVersion(env, url) {
  const id = env && env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id;
  if (!id) return null;
  const v = String(id).replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
  if (!v) return null;
  // wrangler dev serves edited files under one fixed version: caching them for a year would hide the edits.
  if (LOCAL.test(url.hostname) && !(env.ASSET_VERSIONS === '1' || env.ASSET_VERSIONS === 'on')) return null;
  return v;
}

/** /v/<version>/<js|css>/... -> {version, path}; anything else null. */
export function parseVersioned(pathname) {
  const m = /^\/v\/([^/]+)(\/(?:js|css)\/.+)$/.exec(pathname);
  if (!m || !VERSION_RE.test(m[1]) || m[2].includes('/../') || m[2].includes('//')) return null;
  return { version: m[1], path: m[2] };
}

/**
 * The page's own script and style addresses moved under /v/<version>/: src="js/…" and href="css/…" (or "js/…") in
 * <script> and <link> tags only. Links between pages, anchors and the favicon are left as they are.
 */
export function rewriteHtml(html, version) {
  if (!version) return html;
  return String(html).replace(/(<(?:script|link)\b[^>]*?\s(?:src|href)=["'])(?:\.\/|\/)?((?:js|css)\/)/gi, `$1/v/${version}/$2`);
}

// If-None-Match may list several tags; a weak comparison is enough.
export function tagMatches(header, tag) {
  if (!header || !tag) return false;
  const bare = t => t.trim().replace(/^W\//, '');
  return header === '*' || header.split(',').some(t => bare(t) === bare(tag));
}

/** The page's ETag for this version: the file's own tag and the version, so a deploy always changes it. */
export function pageTag(fileTag, version) {
  const base = String(fileTag || '').replace(/^W\//, '').replace(/"/g, '') || 'p';
  return `W/"${base}-${version}"`;
}

const withoutConditionals = headers => {
  const h = new Headers(headers);
  for (const k of ['If-None-Match', 'If-Modified-Since', 'If-Match', 'If-Unmodified-Since', 'If-Range', 'Range']) h.delete(k);
  return h;
};

/**
 * An HTML page with its scripts and styles pointed at this version. Asked for again on every open (no-cache), 304
 * when the browser already holds this page for this version. Non-HTML answers pass through untouched.
 */
export async function servePage(env, request, assetUrl, version) {
  const res = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method === 'HEAD' ? 'HEAD' : 'GET', headers: withoutConditionals(request.headers) }));
  if (!version || res.status !== 200 || !/^text\/html\b/i.test(res.headers.get('Content-Type') || '')) return res;
  const tag = pageTag(res.headers.get('ETag'), version);
  const headers = new Headers(res.headers);
  headers.set('ETag', tag);
  headers.set('Cache-Control', REVALIDATE);
  headers.delete('Content-Length');
  if (tagMatches(request.headers.get('If-None-Match'), tag)) return new Response(null, { status: 304, headers });
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(rewriteHtml(await res.text(), version), { status: 200, headers });
}

/**
 * A file under /v/<version>/: the plain file, immutable when the version is this deploy's. An address from another
 * version (a tab opened before a deploy) still gets today's file, but revalidated, never kept for a year.
 */
export async function serveVersioned(env, request, url, parsed, version) {
  const u = new URL(url);
  u.pathname = parsed.path;
  const res = await env.ASSETS.fetch(new Request(u, request));
  const r = new Response(res.body, res);
  if (res.status === 200 || res.status === 304) r.headers.set('Cache-Control', version && parsed.version === version ? IMMUTABLE : REVALIDATE);
  return r;
}
