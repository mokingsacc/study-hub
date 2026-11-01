import { ratingOf, stepReview, shapeReview } from '../mnemonics/store.js';

export { ratingOf, stepReview, shapeReview };

export const REF = /^anking_hy_\d{3}$/;
export const ROW_ID = /^r\d{1,3}$/;
export const LIMITS = { columns: 6, sections: 8, rows: 60, cell: 400, label: 160, heading: 160, notes: 8 };
export const TABLE_V = 2;   // tables read with boxes

export const SUBJECT_CAT = {
  'Cardiology': 'cardiology',
  'Emergency and resuscitation': 'emergency-toxicology-and-environment',
  'Endocrine': 'endocrine-and-diabetes',
  'Gastroenterology and surgery': 'gi-and-hepatology',
  'Gynecology and breast': 'gynaecology-and-breast',
  'Hematology and oncology': 'haematology',
  'Infectious diseases and immunology': 'infectious-disease',
  'Kidney and metabolic': 'renal-urinary-and-electrolytes',
  'Neurology': 'neurology',
  'Nutrition and prevention': 'prevention-and-geriatrics',
  'Obstetrics and newborn': 'obstetrics',
  'Pediatrics': 'neonates-genetics-and-child-development',
  'Prevention, ethics and statistics': 'biostatistics-and-epidemiology',
  'Psychiatry and toxicology': 'psychiatry',
  'Respiratory': 'respiratory',
  'Rheumatology and skin': 'rheumatology-and-msk',
  'Ophthalmology and ENT': 'ophthalmology',
  'Orthopedics': 'rheumatology-and-msk',
};

export function catalogueRows(cat) {
  const out = [];
  for (const [subject, list] of Object.entries((cat && cat.subjects) || {})) {
    for (const e of Array.isArray(list) ? list : []) {
      if (!e || typeof e.library !== 'string' || !REF.test(e.library) || !e.title) continue;
      out.push({ ref: e.library, title: clean(e.title).slice(0, 200), kind: e.kind ? clean(e.kind).slice(0, 60) : null, subject: clean(subject).slice(0, 80), seq: Number(e.library.slice(-3)) });
    }
  }
  return out;
}

/**
 * The galaxy for each picture: the one most of its matched topics are on (topicCats: Map ref -> [category_id]), a
 * tie going to its subject's galaxy, else its subject's galaxy, else null. Pure.
 */
export function galaxyFor(row, topicCats = new Map()) {
  const home = SUBJECT_CAT[row.subject] || null;
  const n = new Map();
  for (const c of topicCats.get(row.ref) || []) if (c) n.set(c, (n.get(c) || 0) + 1);
  let best = home, most = home ? n.get(home) || 0 : 0;
  for (const [c, k] of n) if (k > most) { best = c; most = k; }
  return best;
}

// ---------------------------------------------------------------- the reader

export const READ_SYSTEM = `You copy one AnKing Step 2 High Yield summary picture into a table, for Mo to learn by heart for USMLE Step 2 CK. He will see the row and column headings and recall every cell with the cell covered, so the table must hold exactly what the picture says, cell by cell.

Copy the words as printed: keep arrows (↑ ↓ →), symbols, numbers, units and abbreviations; keep bold words but drop the bolding. Correct nothing and add nothing. Leave out the image credit, the copyright line and the illustrator's name.

How to lay it out:
- columns: the headings of the answer columns, left to right. A picture comparing things side by side ("Crohn disease" | "Ulcerative colitis") has one column per thing compared.
- rows: label is the row's heading (the feature compared, such as "Smoking"), wherever it sits in the picture (left or in the middle); cells is one text per column, in the columns' order.
- If instead each row is one of the things compared and the columns are its features, keep that layout: the label is the thing, the columns are the features.
- sections: start a new section where the picture has a subheading running across the table (such as "Drug of choice for remission induction"); heading is that subheading, or "" for the first part when it has none. A section's columns: [] when they are the same as the table's columns, else its own column headings.
- A picture that is not a grid (a timeline, a flowchart, a labelled graphic): one row per step or part in reading order, label its name or time, and one column named for what it gives (such as "Features" or "Next step").
- A cell that is blank in the picture: "—". A cell spanning several columns: its text in each of them.
- notes: any short text in the picture that sits in no row (a footnote, a key, a caption with facts), one line each; [] if none.

Never invent content that is not in the picture, and never shorten a cell.

Where each part sits: Mo learns the picture itself, with a cover laid over each answer cell. For every row give label_box, the box around the row label's own cell, and boxes, one box per cell in the cells' order. A box is [left, top, right, bottom] in pixels of the picture as you see it, (0, 0) its top-left corner, drawn around the cell's whole background (its edges, not just its text) so a cover laid on it hides the cell completely and nothing of the cells beside it. A cell that spans several rows or columns: the box of the whole merged cell, the same in each. A cell with nothing of its own in the picture ("—"): [0, 0, 0, 0]. Measure carefully: line the boxes up with the gaps and lines between the cells.

Answer as JSON: title (the picture's own title), columns, sections, notes.`;

export const READ_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'columns', 'sections', 'notes'],
  properties: {
    title: { type: 'string' },
    columns: { type: 'array', items: { type: 'string' } },
    sections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['heading', 'columns', 'rows'],
        properties: {
          heading: { type: 'string' },
          columns: { type: 'array', items: { type: 'string' } },
          rows: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['label', 'cells', 'label_box', 'boxes'],
              properties: { label: { type: 'string' }, cells: { type: 'array', items: { type: 'string' } },
                label_box: { type: 'array', items: { type: 'integer' } }, boxes: { type: 'array', items: { type: 'array', items: { type: 'integer' } } } } },
          },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
};

function clean(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }

/**
 * The reader's answer as the stored table, or null when it holds no row: {v, title, columns, sections: [{heading,
 * columns, rows: [{id, label, cells, label_box, boxes}]}], notes, boxed}. Every row has one cell per column of its
 * section (padded with "—" or cut); rows are numbered r1, r2... through the whole table, which is stored once, so the
 * ids never move. size {w, h}: the picture's pixels as the reader saw it; boxes are kept as fractions of it ([x0, y0,
 * x1, y1], 0 to 1; null where a cell has none). boxed: every cell with content has a box. Pure.
 */
export function shapeTable(data, fallbackTitle = '', size = null) {
  if (!data || typeof data !== 'object') return null;
  const cut = (s, n) => clean(s).slice(0, n);
  const top = (Array.isArray(data.columns) ? data.columns : []).map(c => cut(c, LIMITS.label)).filter(Boolean).slice(0, LIMITS.columns);
  let n = 0, boxed = !!size;
  const sections = [];
  for (const s of (Array.isArray(data.sections) ? data.sections : []).slice(0, LIMITS.sections)) {
    if (!s || typeof s !== 'object') continue;
    const own = (Array.isArray(s.columns) ? s.columns : []).map(c => cut(c, LIMITS.label)).filter(Boolean).slice(0, LIMITS.columns);
    const columns = own.length ? own : top;
    const width = Math.max(1, columns.length);
    const rows = [];
    for (const r of Array.isArray(s.rows) ? s.rows : []) {
      if (n >= LIMITS.rows) break;
      if (!r || typeof r !== 'object') continue;
      const label = cut(r.label, LIMITS.label);
      const cells = (Array.isArray(r.cells) ? r.cells : []).slice(0, width).map(c => cut(c, LIMITS.cell) || '—');
      while (cells.length < width) cells.push('—');
      if (!label && cells.every(c => c === '—')) continue;
      const row = { id: `r${++n}`, label: label || '—', cells };
      if (size) {
        const bs = Array.isArray(r.boxes) ? r.boxes : [];
        row.label_box = boxOf(r.label_box, size);
        row.boxes = cells.map((c, i) => boxOf(bs[i], size));
        if (row.boxes.some((b, i) => !b && cells[i] !== '—')) boxed = false;
      }
      rows.push(row);
    }
    if (rows.length) sections.push({ heading: cut(s.heading, LIMITS.heading), columns: columns.length ? columns : ['Answer'], rows });
  }
  if (!sections.length) return null;
  const notes = (Array.isArray(data.notes) ? data.notes : []).map(x => cut(x, LIMITS.cell)).filter(Boolean).slice(0, LIMITS.notes);
  return { v: TABLE_V, title: cut(data.title, 200) || cut(fallbackTitle, 200), columns: top.length ? top : sections[0].columns, sections, notes, boxed };
}

/** A box in pixels of size {w, h} as fractions [x0, y0, x1, y1], or null when it is missing, empty or off the picture. Pure. */
export function boxOf(b, size) {
  if (!Array.isArray(b) || b.length !== 4 || !size || !(size.w > 0) || !(size.h > 0)) return null;
  const [a, c, d, e] = b.map(Number);
  if (![a, c, d, e].every(Number.isFinite)) return null;
  const x0 = Math.max(0, Math.min(a, d)), x1 = Math.min(size.w, Math.max(a, d)), y0 = Math.max(0, Math.min(c, e)), y1 = Math.min(size.h, Math.max(c, e));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const f = v => Math.round(v * 1e4) / 1e4;
  return [f(x0 / size.w), f(y0 / size.h), f(x1 / size.w), f(y1 / size.h)];
}

/** A box sent back by the drill (fractions), checked, or null. Pure. */
export function fracBox(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const v = b.map(Number);
  if (!v.every(x => Number.isFinite(x) && x >= 0 && x <= 1) || v[2] - v[0] < 0.003 || v[3] - v[1] < 0.003) return null;
  return v.map(x => Math.round(x * 1e4) / 1e4);
}

export function withBoxes(table, rows) {
  let changed = 0;
  const next = { ...table, sections: table.sections.map(s => ({ ...s, rows: s.rows.map(r => {
    const f = rows && rows[r.id];
    if (!f || !Array.isArray(f.boxes)) return r;
    const boxes = r.cells.map((c, i) => fracBox(f.boxes[i]) || null);
    changed++;
    return { ...r, boxes, label_box: f.label_box === undefined ? r.label_box || null : fracBox(f.label_box), fixed: true };
  }) })) };
  next.boxed = rowsOf(next).every(r => Array.isArray(r.boxes) && r.boxes.every((b, i) => b || r.cells[i] === '—'));
  return { table: next, changed };
}

/** A JPEG, PNG, GIF or WebP picture's size {w, h} from its base64, or null. Pure. */
export function imageSize(b64) {
  let bin;
  try { bin = atob(String(b64 || '').slice(0, 400_000)); } catch { return null; }
  const at = i => bin.charCodeAt(i), u16 = i => (at(i) << 8) | at(i + 1), le16 = i => at(i) | (at(i + 1) << 8);
  if (bin.startsWith('\x89PNG')) return { w: (u16(16) << 16) | u16(18), h: (u16(20) << 16) | u16(22) };
  if (bin.startsWith('GIF8')) return { w: le16(6), h: le16(8) };
  if (bin.startsWith('RIFF') && bin.slice(8, 12) === 'WEBP') {
    const k = bin.slice(12, 16);
    if (k === 'VP8 ') return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (k === 'VP8L') { const b = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
    if (k === 'VP8X') return { w: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)), h: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)) };
    return null;
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < bin.length) {
      if (at(i) !== 0xff) { i++; continue; }
      const m = at(i + 1);
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16(i + 7), h: u16(i + 5) };
      i += 2 + u16(i + 2);
    }
  }
  return null;
}

/** Every row of a stored table, in order: [{id, label, cells, columns, heading}]. Pure. */
export function rowsOf(table) {
  const out = [];
  for (const s of (table && table.sections) || []) for (const r of s.rows) out.push({ ...r, columns: s.columns, heading: s.heading });
  return out;
}

// ---------------------------------------------------------------- counts

export function progressOf(rows, reviews, now) {
  let seen = 0, due = 0, known = 0;
  for (const r of reviews || []) {
    seen++;
    if (Number(r.due) <= now) due++; else known++;
  }
  return { rows: Number(rows) || 0, seen, due, known };
}

/**
 * Per galaxy, for the map's moons and the page's chips: {category_id: {total, read, rows, known, due}}. catalogue:
 * [{ref, category_id}]; tables: Map ref -> row count; reviews: [{ref, due}]. Pictures on no galaxy count as 'other'.
 */
export function countsOf(catalogue, tables, reviews, now) {
  const byRef = new Map();
  for (const r of reviews || []) { const l = byRef.get(r.ref) || []; l.push(r); byRef.set(r.ref, l); }
  const by = {};
  for (const p of catalogue || []) {
    const c = p.category_id || 'other';
    const b = by[c] || (by[c] = { total: 0, read: 0, rows: 0, known: 0, due: 0 });
    b.total++;
    if (!tables.has(p.ref)) continue;
    const g = progressOf(tables.get(p.ref), byRef.get(p.ref), now);
    b.read++; b.rows += g.rows; b.known += g.known; b.due += g.due;
  }
  return by;
}

/** The marks on one row as a rating and the missed columns: missed is a list of column indexes. Pure. */
export function markOf(missed, width, easy = false) {
  const m = [...new Set((Array.isArray(missed) ? missed : []).map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < width))].sort((a, b) => a - b);
  return { missed: m, rating: ratingOf(m.length, width, easy) };
}
