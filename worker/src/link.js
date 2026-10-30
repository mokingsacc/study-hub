// Reading a link for the Library's "Paste a link" (questions or answers). The browser cannot fetch other
// sites itself (they do not allow it), so the Worker fetches the address and passes the bytes back as they
// arrive: a PDF goes to pdf.js in the browser like an uploaded file, a web page's HTML is turned into text in
// the browser, and the page's pictures come one by one through /api/link/image. Nothing is stored, and the
// Worker never parses the page, so a large page costs it no computing time.
import { HttpError, readJson } from './util.js';

export const PDF_CAP = 40_000_000;   // bytes of one linked PDF
export const PAGE_CAP = 8_000_000;   // bytes of one web page's HTML
export const IMAGE_CAP = 8_000_000;  // bytes of one picture on a web page
const TIMEOUT_MS = 30_000;           // for the site to start answering
const BODY_TIMEOUT_MS = 120_000;     // for the whole download
const MAX_REDIRECTS = 6;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'];

const SIGN_IN_SITES = [/(^|\.)uworld\.com$/, /(^|\.)mynbme\.org$/, /(^|\.)amboss\.com$/];
// A redirect to one of these means the site wants a sign-in first.
const SIGN_IN_PATH = /(^|\/)(log-?in|sign-?in|signon|sso|oauth2?|auth|authorize|account\/login|users\/sign_in|session\/new)(\/|$|\?|\.)/i;

const PASTE_TIP = 'Open the page yourself, select it all (Cmd+A), copy it and paste it into "Paste from a website", or save it as a PDF and upload it.';
export const signInError = () => new HttpError(422, `That site needs you to sign in, so the hub can't open the link. ${PASTE_TIP}`);

/** Links that open a viewer page rather than the file itself, pointed at the file (Google Drive, Docs, Dropbox). */
export function directLink(u) {
  const url = new URL(u);
  const host = url.hostname.toLowerCase();
  let m;
  if (host === 'drive.google.com' && (m = /^\/file\/d\/([\w-]{10,})/.exec(url.pathname))) {
    return `https://drive.usercontent.google.com/download?id=${m[1]}&export=download&confirm=t`;
  }
  if (host === 'drive.google.com' && url.pathname === '/open' && /^[\w-]{10,}$/.test(url.searchParams.get('id') || '')) {
    return `https://drive.usercontent.google.com/download?id=${url.searchParams.get('id')}&export=download&confirm=t`;
  }
  if (host === 'docs.google.com' && (m = /^\/document\/d\/([\w-]{10,})/.exec(url.pathname))) {
    return `https://docs.google.com/document/d/${m[1]}/export?format=pdf`;
  }
  if ((host === 'www.dropbox.com' || host === 'dropbox.com') && url.searchParams.get('dl') === '0') {
    url.searchParams.set('dl', '1');
    return url.href;
  }
  return url.href;
}

export function privateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(':')) return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return /^\d+$/.test(h); // a bare number is an IPv4 address in disguise
}

export function checkLink(raw, env = {}) {
  let s = String(raw ?? '').trim();
  if (!s) throw new HttpError(400, 'Paste a link first.');
  if (s.length > 4000) throw new HttpError(400, 'That link is too long.');
  if (/^www\./i.test(s)) s = `https://${s}`;
  let url;
  try { url = new URL(s); } catch { throw new HttpError(400, 'That is not a link the hub can open. It should start with https://'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'Only web links (http or https) can be read.');
  if (url.username || url.password) throw new HttpError(400, 'Take the user name and password out of the link.');
  if (env.LINK_ALLOW_LOCAL !== '1' && privateHost(url.hostname)) throw new HttpError(400, 'That link points to a private address the hub cannot reach.');
  if (SIGN_IN_SITES.some(re => re.test(url.hostname.toLowerCase()))) throw signInError();
  return new URL(directLink(url.href));
}

function siteError(status) {
  if (status === 401 || status === 407) return signInError();
  if (status === 403) return new HttpError(422, `That site refused to let the hub open the link (it may need you to sign in, or it blocks programs). ${PASTE_TIP}`);
  if (status === 404 || status === 410) return new HttpError(422, `That site says there is nothing at that link (${status}). Check the link.`);
  if (status === 429) return new HttpError(422, `That site is limiting visitors right now (429). Try again in a minute, or paste the page instead.`);
  return new HttpError(422, `That site answered ${status} instead of the page. ${PASTE_TIP}`);
}

/**
 * Fetch with redirects followed by hand, so every hop is checked (public site, not a sign-in page).
 * Returns {res, url, done} once the site has answered; done() clears the download timer.
 */
async function fetchChecked(start, env, accept) {
  const ctl = new AbortController();
  let answered = false;
  const headTimer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const bodyTimer = setTimeout(() => ctl.abort(), BODY_TIMEOUT_MS);
  const stop = () => { clearTimeout(headTimer); clearTimeout(bodyTimer); };
  let url = start;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res;
      try {
        res = await fetch(url.href, { redirect: 'manual', signal: ctl.signal, headers: { Accept: accept, 'User-Agent': 'Mozilla/5.0 (compatible; Step2PracticeHub/1.0; reads a link for its owner)', 'Accept-Language': 'en' } });
      } catch (e) {
        if (ctl.signal.aborted) throw new HttpError(504, 'That site took too long to answer. Try again, or paste the page instead.');
        throw new HttpError(502, 'The hub could not reach that site. Check the link.');
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        try { await res.body?.cancel(); } catch { /* nothing to cancel */ }
        let next;
        try { next = new URL(res.headers.get('location'), url); } catch { throw new HttpError(502, 'That site sent the hub to an address that does not work.'); }
        if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new HttpError(422, 'That site sent the hub somewhere it cannot follow.');
        if (env.LINK_ALLOW_LOCAL !== '1' && privateHost(next.hostname)) throw new HttpError(422, 'That site sent the hub to a private address.');
        if (SIGN_IN_SITES.some(re => re.test(next.hostname.toLowerCase())) || SIGN_IN_PATH.test(next.pathname) || /(^|\.)accounts\.google\.com$/.test(next.hostname)) throw signInError();
        url = next;
        continue;
      }
      if (!res.ok) {
        try { await res.body?.cancel(); } catch { /* nothing to cancel */ }
        throw siteError(res.status);
      }
      clearTimeout(headTimer); // the site has answered; the download keeps the overall timer
      answered = true;
      return { res, url, done: stop };
    }
    throw new HttpError(422, 'That link redirects too many times.');
  } finally {
    if (!answered) stop();
  }
}

// The body passed on as it arrives, cut off with an error past cap bytes (the browser then says the
// download stopped). A size the site states up front is checked before anything is sent.
function capped(res, cap, tooBig, done) {
  if (!res.body) { done(); return null; }
  const len = Number(res.headers.get('content-length') || 0);
  if (len > cap) {
    try { res.body?.cancel(); } catch { /* ignore */ }
    done();
    throw tooBig;
  }
  let seen = 0;
  const t = new TransformStream({
    transform(chunk, c) {
      seen += chunk.byteLength;
      if (seen > cap) { c.error(new Error('too large')); return; }
      c.enqueue(chunk);
    },
    flush() { done(); },
  });
  return res.body.pipeThrough(t);
}

const mb = n => Math.round(n / 1e6);
const ascii = s => encodeURIComponent(String(s || '')).slice(0, 1500);
const typeOf = res => String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
const charsetOf = res => (/charset\s*=\s*"?([\w.:-]+)/i.exec(res.headers.get('content-type') || '') || [])[1] || '';

/** A file name for a linked PDF: the one the site gives, else the last part of the address. */
export function fileName(disposition, url) {
  const d = String(disposition || '');
  let m = /filename\*\s*=\s*(?:UTF-8'')?"?([^";]+)"?/i.exec(d) || /filename\s*=\s*"?([^";]+)"?/i.exec(d);
  let name = '';
  if (m) { try { name = decodeURIComponent(m[1]); } catch { name = m[1]; } }
  if (!name) {
    const last = String(url.pathname || '').split('/').filter(Boolean).pop() || '';
    try { name = decodeURIComponent(last); } catch { name = last; }
  }
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120);
  if (!name || name === 'download' || name === 'export') name = url.hostname;
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

const SAFE = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'no-store' };

// POST /api/link {url}: a PDF comes back as its bytes (X-Link-Kind: pdf), a web page as its HTML sent as
// plain text (X-Link-Kind: page, X-Link-Charset when the site gives one). X-Link-Url is where it ended up.
export async function link(request, env) {
  const body = await readJson(request, 20_000);
  const start = checkLink(body.url, env);
  const { res, url, done } = await fetchChecked(start, env, 'application/pdf,text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5');
  const type = typeOf(res);
  const disposition = res.headers.get('content-disposition') || '';
  const pdf = type.includes('pdf') || (/^(application\/(octet-stream|binary|x-download|force-download)|)$/.test(type) &&
    (/\.pdf$/i.test(url.pathname) || /\.pdf\b/i.test(disposition)));
  const headers = { ...SAFE, 'X-Link-Url': ascii(url.href) };
  if (pdf) {
    const stream = capped(res, PDF_CAP, new HttpError(413, `That PDF is too large for the hub (limit ${mb(PDF_CAP)} MB). Download it and upload it in parts.`), done);
    return new Response(stream, { headers: { ...headers, 'Content-Type': 'application/pdf', 'X-Link-Kind': 'pdf', 'X-Link-Name': ascii(fileName(disposition, url)) } });
  }
  if (type && !/^(text\/html|application\/xhtml\+xml|text\/plain)$/.test(type)) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    done();
    throw new HttpError(415, IMAGE_TYPES.includes(type)
      ? 'That link is a single picture. Save it and paste it into "Paste from a website" instead.'
      : `That link is not a web page or a PDF (it is ${type}). Download it and upload it if it is a PDF.`);
  }
  const stream = capped(res, PAGE_CAP, new HttpError(413, `That page is too large for the hub (limit ${mb(PAGE_CAP)} MB). Paste the part with the questions instead.`), done);
  return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'X-Link-Kind': 'page', 'X-Link-Type': ascii(type || 'text/html'), 'X-Link-Charset': ascii(charsetOf(res)) } });
}

// POST /api/link/image {url}: one picture from a web page, as its bytes, for Claude and for cutting out.
export async function image(request, env) {
  const body = await readJson(request, 20_000);
  const start = checkLink(body.url, env);
  const { res, done } = await fetchChecked(start, env, 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8');
  const type = typeOf(res);
  if (!IMAGE_TYPES.includes(type)) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    done();
    throw new HttpError(415, 'That is not a picture the hub can use.');
  }
  const stream = capped(res, IMAGE_CAP, new HttpError(413, `That picture is too large (limit ${mb(IMAGE_CAP)} MB).`), done);
  return new Response(stream, { headers: { ...SAFE, 'Content-Type': type } });
}
