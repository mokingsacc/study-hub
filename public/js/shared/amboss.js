
export const KNOWLEDGE = 'https://www.amboss.com/us/knowledge/';
const KNOWLEDGE_RE = /^https:\/\/(?:www\.)?amboss\.com\/us\/knowledge\/([a-z0-9]+(?:-[a-z0-9]+)*)(#Z[0-9a-f]{32})?$/;
const ARTICLE_RE = /^https:\/\/next\.amboss\.com\/us\/article\/([A-Za-z0-9_-]{4,12})(#[A-Za-z0-9_-]{0,64})?$/;
export const URL_MAX = 300;

/** NFKD, accents stripped, lowercase, '&' as 'and', apostrophes dropped, any other run of non [a-z0-9] as '-'. */
export function ambossSlug(title) {
  return String(title ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’‘`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function ambossUrl(title) {
  const s = ambossSlug(title);
  return s ? KNOWLEDGE + s : null;
}

/**
 * Accepts only https://www.amboss.com/us/knowledge/<slug>[#Z<32 hex>] (www optional) and
 * https://next.amboss.com/us/article/<xid>[#anchor]. Query strings, other hosts, http and anything over 300
 * characters are refused. Returns the link with www. added and spaces trimmed, or null.
 */
export function checkAmbossUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > URL_MAX) return null;
  let m = KNOWLEDGE_RE.exec(s);
  if (m) return KNOWLEDGE + m[1] + (m[2] || '');
  m = ARTICLE_RE.exec(s);
  if (m) return s;
  return null;
}

/** A Google search limited to AMBOSS's US articles: always works, even when a guessed slug does not. */
export function ambossSearch(title) {
  const q = String(title ?? '').replace(/\s+/g, ' ').trim();
  return 'https://www.google.com/search?q=' + encodeURIComponent(`site:amboss.com/us/knowledge ${q}`.trim());
}
