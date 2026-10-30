
export const CHUNKER_VERSION = 1;
export const TARGET_TOKENS = 300, MAX_TOKENS = 400, MIN_TOKENS = 150, OVERLAP_TOKENS = 70, TABLE_MAX = 520;
export const PAGE_TEXT_MAX = 40_000;          // characters kept per page (a page past it is cut, and says so)
export const LINE_MAX = 4_000;

/** Tokens in a text, estimated (about 3.7 characters a token for this kind of English). */
export const tokensOf = s => Math.ceil(String(s || '').length / 3.7);

const BULLET = /^\s*(?:[-–—•▪◦●○■□§➢➤►✓✔*]|o(?=\s)|\d{1,2}[.)](?=\s)|[a-h][.)](?=\s))\s*/;
const BULLET_ONLY = /^\s*(?:[-–—•▪◦●○■□§➢➤►✓✔*o]|\d{1,2}[.)])\s*$/;
const CAPTION = /^(?:fig(?:ure)?\.?|image|diagram|table|chart|photo)\s*\d*[a-z]?\s*[:.\-–]/i;
const PAGE_NUMBER = /^(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$/i;

// ------------------------------------------------------------------ glyphs and lines

export function fixGlyphs(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/(^|\s)à(?=\s|$)/g, '$1→')
    .replace(/(^|[\s(])(\u00ad+)(?=\s|\w)/g, (m, a, r) => a + '↑'.repeat(r.length))
    .replace(/\u00ad/g, '')
    .replace(/(^|[\s(])(¯+)(?=\s|\w)/g, (m, a, r) => a + '↓'.repeat(r.length))
    .replace(/[\uf0b7\uf0a7\uf076\uf0d8\uf0fc]/g, '•')
    .replace(/[ \t]*\t[ \t]*/g, '\t')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const boilerKey = s => String(s || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/** The page's lines as [{t, s, b, x, y}] from either shape: {lines} or {text} (plain or markdown). */
export function linesOf(page) {
  if (Array.isArray(page && page.lines)) {
    return page.lines.filter(l => l && typeof l.t === 'string' && l.t.trim()).slice(0, 3000).map((l, i) => ({
      t: fixGlyphs(l.t.slice(0, LINE_MAX)), s: Number.isFinite(+l.s) && +l.s > 0 ? +l.s : null, b: l.b ? 1 : 0,
      x: Number.isFinite(+l.x) ? +l.x : null, y: Number.isFinite(+l.y) ? +l.y : i * 12,
    })).filter(l => l.t);
  }
  const text = String((page && page.text) || '');
  return text.split(/\r?\n/).map((raw, i) => {
    const md = /^(#{1,4})\s+(.*)$/.exec(raw.trim());
    const t = fixGlyphs(md ? md[2] : raw);
    return { t, s: null, b: 0, x: null, y: i * 12, h: md ? md[1].length : null };
  }).filter(l => l.t);
}

/** Lines repeated on many pages (headers, footers, page numbers): their keys. */
export function boilerplateKeys(pagesLines) {
  const count = new Map();
  for (const lines of pagesLines) {
    for (const k of new Set(lines.filter(l => !BULLET_ONLY.test(l.t)).map(l => boilerKey(l.t)).filter(k => k && k.length <= 80 && /[a-z#]{2}/.test(k)))) count.set(k, (count.get(k) || 0) + 1);
  }
  const n = pagesLines.length;
  const out = new Set();
  if (n >= 4) for (const [k, c] of count) if (c >= Math.max(3, 0.3 * n)) out.add(k);
  return out;
}

/** Document-wide type facts: the body size (most characters), the body's left margin and the heading sizes. */
export function docStyle(pagesLines, boiler = new Set()) {
  const bySize = new Map(), byX = new Map(), sizePages = new Map();
  pagesLines.forEach((lines, pi) => { for (const l of lines) {
    if (boiler.has(boilerKey(l.t)) || PAGE_NUMBER.test(l.t.trim())) continue;
    if (l.s) { bySize.set(l.s, (bySize.get(l.s) || 0) + l.t.length); if (!sizePages.has(l.s)) sizePages.set(l.s, new Set()); sizePages.get(l.s).add(pi); }
    if (l.x != null && !l.b) { const x = Math.round(l.x / 3) * 3; byX.set(x, (byX.get(x) || 0) + l.t.length); }
  } });
  const top = m => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  const body = top(bySize) ? top(bySize)[0] : null;
  const margin = byX.size ? Math.min(...[...byX.entries()].filter(([, c]) => c >= 0.05 * Math.max(...byX.values())).map(([x]) => x)) : null;
  // Heading sizes: bigger than the body and used on several pages (a cover's big type is not a heading level).
  const minPages = Math.max(2, Math.min(5, Math.ceil(0.04 * pagesLines.length)));
  const bodyChars = body ? bySize.get(body) : 0;
  const heads = [...bySize.keys()].filter(s => body && s >= body * 1.12 && s <= body * 3 && sizePages.get(s).size >= minPages && bySize.get(s) >= 0.002 * bodyChars)
    .sort((a, b) => b - a).slice(0, 3);
  return { body, margin, heads };
}

// ------------------------------------------------------------------ rows and items

// Lines within 2.5 pt of the same baseline form one row; cells sorted left to right.
function rowsOf(lines) {
  const sorted = lines.slice().sort((a, b) => a.y - b.y || (a.x ?? 0) - (b.x ?? 0));
  const rows = [];
  for (const l of sorted) {
    const r = rows[rows.length - 1];
    if (r && l.x != null && Math.abs(l.y - r.y) <= 2.5) r.cells.push(l);
    else rows.push({ y: l.y, cells: [l] });
  }
  for (const r of rows) {
    r.cells.sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
    // A bullet glyph alone in front of its text is one cell.
    const merged = [];
    for (const c of r.cells) {
      const prev = merged[merged.length - 1];
      if (prev && BULLET_ONLY.test(prev.t)) merged[merged.length - 1] = { ...c, t: `${prev.t.trim()} ${c.t}`, x: prev.x, tx: c.x };
      else merged.push({ ...c });
    }
    // Cells made by the extractor's tab join count as cells too.
    r.cells = merged.flatMap(c => (c.t.includes('\t') ? c.t.split('\t').filter(Boolean).map((t, i) => ({ ...c, t, x: (c.x ?? 0) + i * 40 })) : [c]));
  }
  return rows;
}

function headingLevel(line, style, centred) {
  const t = line.t;
  if (line.h) return line.h;
  if (/^@|https?:|www\.|youtube|instagram|facebook|twitter|copyright/i.test(t)) return 0;
  if (t.length > 100 || /[.;,:]$/.test(t) && !/:$/.test(t) || !/[A-Za-z]{3}/.test(t) || BULLET.test(t) && !/^\d{1,2}[.)]\s+[A-Z]/.test(t)) return 0;
  if (/:$/.test(t) && t.length > 40) return 0;
  if (style.body && line.s) {
    const i = style.heads.findIndex(s => Math.abs(s - line.s) < 0.25);
    if (i >= 0 && t.split(/\s+/).length <= 14) return i + 1;
    if (line.b && Math.abs(line.s - style.body) < 0.6 && t.split(/\s+/).length <= 12) return style.heads.length + 1 + (centred ? 0 : 1);
    return 0;
  }
  // Plain text: a short line in capitals.
  if (line.s == null && t.length <= 60 && /^[A-Z0-9][A-Z0-9 ,&/()+'’-]{3,}$/.test(t) && /[A-Z]{3}/.test(t)) return 2;
  return 0;
}

/**
 * One page's items: {kind: heading|bullet|para|table|caption, text, level?, glue?}. Rows of side-by-side cells are a
 * table ("cell | cell" per row) until a row comes back to the body margin with a single cell.
 */
export function pageItems(lines, style, boiler = new Set()) {
  const kept = lines.filter(l => !boiler.has(boilerKey(l.t)) && !PAGE_NUMBER.test(l.t.trim()));
  const rows = rowsOf(kept);
  const items = [];
  const margin = style.margin ?? 0;
  let cur = null, table = null, lastY = null;
  const lineGap = style.body ? style.body * 2.6 : 30;
  const endTable = () => { if (table) { items.push({ kind: 'table', text: table.rows.join('\n') }); table = null; } };
  const flush = () => { if (cur) { items.push(cur); cur = null; } };
  for (const r of rows) {
    const multi = r.cells.length >= 2 && r.cells.some(c => !BULLET_ONLY.test(c.t));
    const first = r.cells[0];
    const inTableCol = table && r.cells.length === 1 && first.x != null && table.cols.some(x => Math.abs(x - first.x) <= 4) && Math.abs(first.x - table.cols[0]) > 4;
    if (multi || inTableCol) {
      flush();
      if (!table) table = { rows: [], cols: [] };
      for (const c of r.cells) if (c.x != null && !table.cols.some(x => Math.abs(x - c.x) <= 4)) table.cols.push(c.x);
      table.cols.sort((a, b) => a - b);
      table.rows.push(r.cells.map(c => c.t.trim()).join(' | '));
      lastY = r.y;
      continue;
    }
    endTable();
    const l = first;
    const centred = l.x != null && l.x > margin + 60;
    const lvl = headingLevel(l, style, centred);
    if (lvl) { flush(); items.push({ kind: 'heading', text: l.t.trim(), level: lvl }); lastY = r.y; continue; }
    if (CAPTION.test(l.t)) { flush(); items.push({ kind: 'caption', text: l.t.trim() }); lastY = r.y; continue; }
    const gap = lastY == null ? 0 : r.y - lastY;
    const bullet = BULLET.test(l.t);
    const textX = l.tx ?? l.x;
    const continues = cur && !bullet && !cur.closed && gap <= lineGap && (l.x == null || cur.tx == null || l.x >= cur.tx - 3);
    if (continues) {
      cur.text += (cur.text.endsWith('-') && /^[a-z]/.test(l.t) ? '' : ' ') + l.t.trim();
    } else {
      flush();
      cur = { kind: bullet ? 'bullet' : 'para', text: l.t.trim(), tx: bullet ? (textX ?? null) : l.x };
    }
    // A short question line ("Tx for uric acid stones?") stays glued to the answer that follows.
    if (/\?\s*$/.test(cur.text) && cur.text.length <= 200) { cur.glue = true; flush(); }
    lastY = r.y;
  }
  flush();
  endTable();
  return items.map(({ tx, closed, ...it }) => it);
}

// ------------------------------------------------------------------ sentences and splitting

export function sentences(text) {
  return String(text).split(/(?<=[.!?;])\s+(?=[A-Z(“"0-9↑↓→-])|(?<=\S)\s+(?=→\s)/).filter(s => s.trim());
}

// A long item cut into pieces of at most `max` tokens on sentence ends (a single huge sentence on words).
function splitLong(text, max) {
  const out = [];
  let buf = '';
  const push = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const s of sentences(text)) {
    if (tokensOf(s) > max) {
      push();
      const words = s.split(/\s+/);
      let w = '';
      for (const x of words) { if (tokensOf(w + ' ' + x) > max) { out.push(w.trim()); w = ''; } w += ' ' + x; }
      if (w.trim()) buf = w.trim();
      continue;
    }
    if (tokensOf(buf + ' ' + s) > max) push();
    buf += (buf ? ' ' : '') + s;
  }
  push();
  return out;
}

// A table past TABLE_MAX: row groups, each repeating the header row.
function splitTable(text, max) {
  const rows = text.split('\n');
  const head = rows[0];
  const out = [];
  let buf = [head];
  for (const r of rows.slice(1)) {
    if (buf.length > 1 && tokensOf([...buf, r].join('\n')) > max) { out.push(buf.join('\n')); buf = [head]; }
    buf.push(r);
  }
  if (buf.length > 1 || !out.length) out.push(buf.join('\n'));
  return out;
}

// ------------------------------------------------------------------ the document

/**
 * The whole document: pages in, {pages: [{n, text, kind, chars}], passages: [...], terms: [...], style}. pages:
 * [{n, lines?|text?, images?, kind?}] in any order. A passage: {seq, page, page_to, heading, kind, text, char_start,
 * char_end, tokens}; char_start is an offset in page `page`'s text and char_end one in page `page_to`'s.
 */
export function chunkDocument(pagesIn, opts = {}) {
  const target = opts.target ?? TARGET_TOKENS, max = opts.max ?? MAX_TOKENS, min = opts.min ?? MIN_TOKENS, overlap = opts.overlap ?? OVERLAP_TOKENS;
  const pages = pagesIn.filter(p => Number.isInteger(p && p.n) && p.n > 0).slice().sort((a, b) => a.n - b.n);
  const lines = pages.map(linesOf);
  const boiler = boilerplateKeys(lines);
  const style = docStyle(lines, boiler);
  // Items with their page and their place in that page's text.
  const outPages = [], items = [];
  pages.forEach((p, i) => {
    const its = pageItems(lines[i], style, boiler);
    let text = '';
    for (const it of its) {
      if (text.length >= PAGE_TEXT_MAX) break;
      const start = text.length ? text.length + 1 : 0;
      text += (text.length ? '\n' : '') + it.text;
      items.push({ ...it, page: p.n, start, end: text.length });
    }
    if (text.length > PAGE_TEXT_MAX) text = text.slice(0, PAGE_TEXT_MAX);
    const kind = p.kind === 'ocr' ? 'ocr' : text.trim().length >= 40 ? 'text' : (p.images || 0) > 0 ? 'image' : 'empty';
    outPages.push({ n: p.n, text, kind, chars: text.length });
  });

  // A heading repeated on many pages is a running title, not a section.
  const headPages = new Map();
  for (const it of items) if (it.kind === 'heading') { const k = it.text.toLowerCase(); if (!headPages.has(k)) headPages.set(k, new Set()); headPages.get(k).add(it.page); }
  const running = new Set([...headPages].filter(([, ps]) => ps.size >= 4).map(([k]) => k));
  const passages = [];
  const stack = [];          // the heading path: [{level, text}]
  let buf = [];              // items in the passage being packed
  const headingPath = () => stack.map(h => h.text).join(' › ').slice(0, 300) || null;
  let bufHeading = null;
  const emit = (its, heading) => {
    if (!its.length) return;
    const text = its.map(x => x.text).join('\n');
    const kinds = new Set(its.map(x => x.kind));
    passages.push({
      seq: passages.length, page: its[0].page, page_to: its[its.length - 1].page, heading,
      kind: kinds.size === 1 && kinds.has('table') ? 'table' : kinds.has('caption') && kinds.size === 1 ? 'caption' : [...kinds].every(k => k === 'bullet') ? 'list' : 'text',
      text, char_start: its[0].start, char_end: its[its.length - 1].end, tokens: tokensOf(text),
    });
  };
  const flush = ({ carry = false } = {}) => {
    if (!buf.length) return;
    emit(buf, bufHeading);
    // Overlap: the next passage opens with the last short item (never a heading-only tail).
    const last = buf[buf.length - 1];
    buf = carry && tokensOf(last.text) <= overlap && buf.length > 1 ? [last] : [];
  };
  const size = () => tokensOf(buf.map(x => x.text).join('\n'));
  for (const it of items) {
    if (it.kind === 'heading' && running.has(it.text.toLowerCase())) continue;
    if (it.kind === 'heading') {
      // A heading closes the passage unless it is still tiny (then the two sections share one passage).
      if (buf.length && (size() >= 40 || buf.some(x => x.kind === 'table'))) flush();
      while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
      stack.push({ level: it.level, text: it.text });
      if (!buf.length) bufHeading = headingPath();
      else bufHeading = [bufHeading, it.text].filter(Boolean).join('; ').slice(0, 300);
      continue;
    }
    // A new page closes a passage that is big enough; a small one carries over (page_to).
    if (buf.length && it.page !== buf[buf.length - 1].page && size() >= min) flush();
    if (!buf.length) bufHeading = headingPath();
    const t = tokensOf(it.text);
    const cap = it.kind === 'table' ? TABLE_MAX : max;
    if (t > cap) {
      flush();
      const parts = it.kind === 'table' ? splitTable(it.text, TABLE_MAX) : splitLong(it.text, max - 20);
      let off = it.start;
      parts.forEach((part, k) => {
        const at = it.text.indexOf(part.split('\n')[k && it.kind === 'table' ? 1 : 0].slice(0, 40));
        const start = it.kind === 'table' ? it.start : (at >= 0 ? it.start + at : off);
        const piece = { ...it, text: part, start, end: Math.min(it.end, start + part.length) };
        off = piece.end;
        bufHeading = headingPath();
        emit([piece], bufHeading);
      });
      continue;
    }
    const prevGlue = buf.length && buf[buf.length - 1].glue;
    if (buf.length && !prevGlue && size() + t > (it.kind === 'table' ? TABLE_MAX : max)) flush({ carry: it.kind !== 'table' });
    if (!buf.length) bufHeading = headingPath();
    buf.push(it);
    if (size() >= target && !it.glue) flush({ carry: true });
  }
  if (buf.length) emit(buf, bufHeading);
  // A carried item alone at the end of a section duplicates the passage before: drop such tails.
  const out = passages.filter((p, i) => !(i > 0 && passages[i - 1].text.endsWith(p.text) && p.page === passages[i - 1].page_to));
  out.forEach((p, i) => { p.seq = i; });
  return { pages: outPages, passages: out, terms: harvestTerms(items.map(i => i.text)), style };
}

// ------------------------------------------------------------------ abbreviations from the text

const ABBR = /([A-Za-z][A-Za-z0-9'’\- ]{2,70}?)\s*\(([A-Z][A-Za-z0-9]{1,7})\)/g;
const initials = s => s.split(/[\s\-]+/).filter(w => w && !/^(of|and|the|in|to|for|with|a|an)$/i.test(w)).map(w => w[0].toLowerCase()).join('');

/** "serum-ascites albumin gradient (SAAG)" pairs: [{abbr, long}], the long form's words matching the letters. */
export function harvestTerms(texts) {
  const seen = new Map();
  for (const t of texts) {
    for (const m of String(t).matchAll(ABBR)) {
      const abbr = m[2];
      if ((abbr.match(/[A-Z]/g) || []).length < 2) continue;
      const letters = abbr.toLowerCase().replace(/[^a-z]/g, '');
      const words = m[1].trim().split(/\s+/);
      // The shortest tail of the words whose initials give the abbreviation (allowing one missing letter).
      for (let k = 1; k <= Math.min(words.length, letters.length + 2); k++) {
        const long = words.slice(-k).join(' ').replace(/^[^A-Za-z]+/, '');
        const ini = initials(long);
        if (ini === letters || (letters.length >= 3 && ini.length >= letters.length - 1 && letters.startsWith(ini.slice(0, 2)) && ini.slice(-1) === letters.slice(-1))) {
          if (long.length >= 6 && long.toLowerCase() !== letters) {
            const key = `${abbr.toLowerCase()}|${long.toLowerCase()}`;
            seen.set(key, { abbr, long, n: ((seen.get(key) || {}).n || 0) + 1 });
          }
          break;
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.n - a.n).slice(0, 2000);
}

// ------------------------------------------------------------------ question-bank material

const QB_MARKS = [
  [/copyright\s*©?\s*uworld|©\s*uworld|uworld\s*,?\s*llc/i, 'UWorld copyright'],
  [/\bquestion\s*id\s*[:#]?\s*\d{3,}/i, 'Question Id'],
  [/\bitem\s+\d{1,3}\s+of\s+\d{1,3}\b/i, 'Item N of M'],
  [/\beducational\s+objective\b/i, 'Educational objective'],
  [/\b\d{1,3}\s*%\s*(?:of\s+\w+\s+)?answered\s+(?:this\s+)?correctly\b/i, '% answered correctly'],
  [/\bcorrect\s+answer\s*[:.]?\s*[A-H]\b.{0,80}\b\d{1,3}\s*%/i, 'Correct answer with %'],
  [/\b(?:time\s+spent|exhibit\s+display|previous\s+next\s+lab\s+values)\b/i, 'test-interface text'],
  [/national\s+board\s+of\s+medical\s+examiners|\bnbme\b[^.\n]{0,30}\b(?:form|self[- ]assessment)\s*\d+\b[^.\n]{0,40}\bblock\s*\d/i, 'NBME form'],
  [/\bamboss\s*(?:qbank|question)\b|\bkaplan\s+qbank\b|\btruelearn\b|\brx\s*bricks\b/i, 'another question bank'],
];
const OPTION_LINE = /^\s*\(?[A-H][.)]\s+\S/;
const VIGNETTE = /\b\d{1,3}[\s-]?(?:year|yr|month|week|day)s?[\s-]?old\b[^.?!]{0,160}?\b(?:comes?|came|presents?|presented|is brought|was brought|is admitted|was admitted|is evaluated|is seen|visits|is referred|was referred)\b/i;
const WHICH = /which of the following/i;
const INLINE_OPTS = /(?:^|\s)\(?[Aa][.)]\s+\S.{0,200}?\s\(?[Bb][.)]\s+\S.{0,200}?\s\(?[Cc][.)]\s+\S.{0,200}?\s\(?[Dd][.)]\s+\S/;
const NOTES_MARK = /mehlman/i;
export const SHAPE_SHARE = 0.6, SHAPE_MIN = 5;

export function questionBankVerdict(pagesIn) {
  const hits = [];
  const marks = new Set();
  let n = 0, shaped = 0;
  for (const p of pagesIn) {
    n++;
    const lines = linesOf(p);
    const text = lines.map(l => l.t).join('\n');
    const found = QB_MARKS.filter(([re]) => re.test(text)).map(([, name]) => name);
    const options = lines.filter(l => OPTION_LINE.test(l.t)).length;
    if ((options >= 4 || INLINE_OPTS.test(text)) && (VIGNETTE.test(text) || WHICH.test(text)) && !NOTES_MARK.test(text)) shaped++;
    const uw = found.includes('UWorld copyright');
    if (found.length >= 2 || (found.length && options >= 3) || (uw && options >= 1)) { hits.push(p.n); found.forEach(f => marks.add(f)); }
  }
  const byShape = shaped >= SHAPE_MIN && shaped >= SHAPE_SHARE * n;
  if (byShape) marks.add('question pages: vignettes with lettered options');
  const shown = Math.max(hits.length, byShape ? shaped : 0);
  const refuse = byShape || hits.length >= 2 && hits.length >= 0.1 * n || hits.length >= 1 && n <= 3 || [...marks].includes('UWorld copyright') && hits.length >= 1;
  return {
    refuse, pages: hits.slice(0, 20), marks: [...marks],
    shaped,
    reason: refuse ? `This looks like question-bank material (${[...marks].slice(0, 3).join(', ')} on ${shown} page${shown === 1 ? '' : 's'}). The Library is for study notes such as Mehlman's PDFs; UWorld and NBME questions are never stored as study material. To sit an NBME form, add it under Exams instead.` : null,
  };
}

// ------------------------------------------------------------------ small text helpers shared with search

/** A passage cut to at most n characters on a word, with an ellipsis. */
export function cut(s, n) {
  const t = String(s || '').replace(/[ \t]+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t;
}

/** Word shingles (5-grams) of a text, as a Set of strings: two passages that share most of them are one note copied. */
export function shingles(text, k = 5) {
  const w = String(text || '').toLowerCase().replace(/[^a-z0-9↑↓→ ]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(' '));
  if (!out.size && w.length) out.add(w.join(' '));
  return out;
}
export function overlapRatio(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of s) if (l.has(x)) n++;
  return n / s.size;
}
