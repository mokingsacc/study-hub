const KEEP = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'ul', 'ol', 'li', 'p', 'div', 'br', 'h1', 'h2', 'h3', 'span', 'a', 'sub', 'sup']);
const VOID = new Set(['br']);
export const HTML_MAX = 100_000;

const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function hrefOf(attrs) {
  const m = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs || '');
  const v = m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : '';
  return /^(https?:|mailto:)/i.test(v) ? v : null;
}

export function sanitizeHtml(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template|iframe|object|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|template|iframe|object|svg|math)\b[^>]*>/gi, '');
  const out = [];
  let last = 0;
  // Quote-aware: a ">" inside an attribute value (alt="BP > 140") never ends the tag early and leaks the rest as text.
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = re.exec(s))) {
    out.push(s.slice(last, m.index).replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    last = re.lastIndex;
    const name = m[1].toLowerCase(), closing = m[0][1] === '/';
    if (!KEEP.has(name)) continue;
    if (closing) { if (!VOID.has(name)) out.push(`</${name}>`); continue; }
    if (name === 'a') { const h = hrefOf(m[2]); out.push(h ? `<a href="${escAttr(h)}" target="_blank" rel="noopener">` : '<a>'); continue; }
    out.push(`<${name}>`);
  }
  out.push(s.slice(last).replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  return out.join('').slice(0, HTML_MAX);
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
export function plainText(html) {
  return String(html || '')
    .replace(/<(br|\/?p|\/?div|\/?li|\/?h[1-3]|\/?ul|\/?ol|\/?tr)\b[^>]*>/gi, '\n').replace(/<\/t[dh]>/gi, ' ').replace(/<\/?[a-zA-Z](?:[^>"']|"[^"]*"|'[^']*')*>/g, '').replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (all, e) => {
      if (ENT[e.toLowerCase()] != null) return ENT[e.toLowerCase()];
      if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16) || 32);
      if (/^#/.test(e)) return String.fromCodePoint(Number(e.slice(1)) || 32);
      return all;
    })
    .replace(/[ \t]+/g, ' ').replace(/ *\n\s*/g, '\n').trim();
}

// Plain text as safe HTML paragraphs (Claude's text, table cells shown as text).
export function textToHtml(text) {
  const e = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text || '').split(/\n/).map(l => `<p>${e(l) || '<br>'}</p>`).join('');
}
