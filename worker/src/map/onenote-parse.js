import { norm, slug } from '../../../public/js/shared/names.js';
import { categoryFor } from './vocab.js';

export const PARSER_VERSION = 1;
// What the checklist held when the import was designed (verified 24 Oct); a difference stops the import.
export const EXPECT = Object.freeze({ units: 229, lanes: Object.freeze({ A: 87, B: 119, C: 23 }), gaps: 2, rapid: 15, pairs: 50 });
export const MAX_ROWS = 300;              // rows per import call (a unit and its queue item count as 2, a Done tick as 5)
export const STEPS = ['recognise', 'distinguish', 'test', 'treat', 'trap'];
const HEADER = ['done', 'lane', 'unit', 'page', 'your notes', 'mehlman'];
const KNOWLEDGE = /^https:\/\/(www\.)?amboss\.com\/us\/knowledge\/[^\s?#]+$/i;
const QUESTION_ID = /\bUW(orld)?\s?#?\d{4,6}\b|\bNBME\s?\d+\s?Q\d+\b/i;

// ---------------------------------------------------------------- text helpers

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…' };
/** HTML entities decoded (&#183; &#x2014; &amp; …). */
export function decode(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
/** The visible text of an HTML fragment: tags dropped, entities decoded, white space collapsed. */
export function text(html) {
  return decode(String(html ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}
const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag); return m ? decode(m[1]) : null; };

/** The parts of one fetch joined in part order: [html, …] or [{part, html}, …]. */
export function joinParts(parts) {
  const list = (parts || []).map((p, i) => (typeof p === 'string' ? { part: i + 1, html: p } : p));
  return list.slice().sort((a, b) => a.part - b.part).map(p => String(p.html ?? '')).join('');
}

/** sha256 of a string, as hex (Workers and node both have crypto.subtle). */
export async function sha256Hex(s) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const redactCid = s => String(s ?? '').replace(/(d\.docs\.live\.net\/)[0-9a-f]{8,20}\//gi, '$1cid0000/');

// ---------------------------------------------------------------- the page list

const SECTIONS = ['Obstetrics', 'Paediatrics', "Gynaecology and Men's Health", 'Endocrine', 'Cardiology', 'Respiratory', 'Renal and Acid-Base',
  'GI and Hepatology', 'Haematology and Oncology', 'Infectious Disease', 'Immunology and Allergy', 'Neurology, Eye and ENT', 'Psychiatry',
  'Emergency and Toxicology', 'Rheumatology and MSK', 'Dermatology', 'Surgery', 'Prevention, Nutrition and Geriatrics', 'Ethics, Safety and Biostatistics'];
export const SYSTEM_SECTIONS = Object.freeze(SECTIONS);
const REVIEW_TABLES = [/^screening\b/i, /^risk factors\b/i, /^nbme alternative vocabulary\b/i];

export function pageKind({ title, section } = {}) {
  const t = String(title ?? '').trim(), s = String(section ?? '').trim();
  if (/^step 2 master checklist$/i.test(t)) return 'checklist';
  if (/^topic tally$/i.test(t)) return 'tally';
  if (SECTIONS.includes(s)) return 'system';
  if (/^review$/i.test(s) && REVIEW_TABLES.some(re => re.test(t))) return 'review_table';
  if (/^mnemonics$/i.test(s)) return /\(tidy\)/i.test(t) ? 'mnemonics' : 'skip';
  if (/^errors$/i.test(s)) return 'derived';
  return 'skip';
}

export function sectionPages(pages) {
  const out = {};
  const rank = p => (p.fetch_status === 'fetched' || p.fetch_status === 'fetching' ? 0 : 1) + (String(p.title).trim() === String(p.section).trim() ? 0 : 2);
  const live = (pages || []).filter(p => p && p.kind === 'system' && p.fetch_status !== 'dead');
  for (const p of live.map((p, i) => ({ ...p, i })).sort((a, b) => rank(a) - rank(b) || a.i - b.i)) if (!out[p.section]) out[p.section] = p.page_id;
  return out;
}

// ---------------------------------------------------------------- the Master Checklist

// "Clinical medicine (4), Ethics and Risk Factors/ Social (3), Mnemonics" -> {name: count|null}; a gap -> {}.
export function parseCoverage(cell) {
  const t = text(cell);
  if (!t || /^gap\b/i.test(t)) return {};
  const out = {};
  for (const raw of t.split(/,\s+/)) {
    const m = /^(.*?)\s*\((\d+)\)$/.exec(raw.trim());
    const name = (m ? m[1] : raw).trim();
    if (name) out[name] = m ? Number(m[2]) : null;
  }
  return out;
}

function pageLink(cell) {
  const a = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(cell);
  if (!a) return { href: null, section: null, object_id: null };
  const href = attr(a[1], 'href');
  const obj = href && /object-id=(\{[0-9a-f-]+\})/i.exec(href);
  return { href: href && /^onenote:/i.test(href) ? href : null, section: text(a[2]) || null, object_id: obj ? obj[1].toUpperCase() : null };
}

const cells = row => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);

export function parseChecklist(html, { sectionPages: pages = {} } = {}) {
  const src = String(html ?? '');
  const units = [], ticks = [], problems = [];
  const seen = new Set();
  let system = null;
  for (const m of src.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>|<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    if (m[1] != null) { system = text(m[1]); continue; }
    const rows = [...m[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(r => cells(r[1]));
    if (!rows.length || rows[0].map(c => text(c).toLowerCase()).join('|') !== HEADER.join('|')) continue;
    for (const c of rows.slice(1)) {
      if (c.length < 6) { problems.push(`A row under ${system} has ${c.length} cells, not 6.`); continue; }
      const num = Number(/(\d{1,3})/.exec(text(c[0]))?.[1]);
      if (!Number.isInteger(num) || num < 1) { problems.push(`A row under ${system} has no unit number.`); continue; }
      const id = `u${String(num).padStart(3, '0')}`;
      if (seen.has(id)) { problems.push(`Unit ${num} is listed twice; the first row is kept.`); continue; }
      seen.add(id);
      const lane = text(c[1]).toUpperCase();
      const name = text(c[2]);
      const link = pageLink(c[3]);
      const notesText = text(c[4]);
      const coverage = parseCoverage(c[4]);
      const rank = Number(/#\s*(\d+)/.exec(text(c[5]))?.[1]);
      if (QUESTION_ID.test(name)) { problems.push(`Unit ${num}'s name names a question id, so it is left out.`); continue; }
      units.push({
        id, num, kind: 'checklist', name, lane: ['A', 'B', 'C'].includes(lane) ? lane : null,
        mehlman_rank: Number.isInteger(rank) && rank >= 1 && rank <= 229 ? rank : null,
        checklist_system: system, checklist_order: units.length + 1,
        onenote_section: link.section, onenote_page_id: (link.section && pages[link.section]) || null,
        onenote_object_id: link.object_id, onenote_link: link.href,
        coverage_json: coverage, nbme_images: Number.isInteger(coverage['NBME High Yield Images']) ? coverage['NBME High Yield Images'] : 0,
        notes_gap: /^gap\b/i.test(notesText) ? 1 : 0, source_ref: `onenote:checklist#${id}`,
      });
      if (/data-tag="to-do:completed"/i.test(c[0])) ticks.push({ unit_id: id, step: 'done', source_ref: `done-${String(num).padStart(3, '0')}` });
    }
  }
  return { units, ticks, rapid: parseRapid(src), gaps: units.filter(u => u.notes_gap).length, problems };
}

/** 'DKA vs HHS · SIADH vs DI' -> [['DKA','HHS'], ['SIADH','DI']]. */
export function rapidGroups(s) {
  return String(s ?? '').split(/\s+·\s+/).map(g => g.split(/\s+vs\.?\s+/i).map(x => x.trim()).filter(Boolean)).filter(g => g.length >= 2);
}
/** Every pair inside each group, in reading order. */
export function rapidPairs(groups) {
  const out = [];
  for (const g of groups || []) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) out.push([g[i], g[j]]);
  return out;
}

/** The Rapid differentials: [{n, text, groups, pairs, ticked, source_ref}], by n. */
export function parseRapid(html) {
  const out = new Map();
  for (const m of String(html ?? '').matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    const id = attr(m[1], 'data-id');
    const r = id && /^rapid-(\d+)$/.exec(id);
    if (!r || out.has(Number(r[1]))) continue;
    const t = text(m[2]);
    const groups = rapidGroups(t);
    out.set(Number(r[1]), { n: Number(r[1]), text: t, groups, pairs: rapidPairs(groups), ticked: /to-do:completed/i.test(attr(m[1], 'data-tag') || ''),
      source_ref: `onenote:checklist#rapid-${r[1]}` });
  }
  return [...out.values()].sort((a, b) => a.n - b.n);
}

// ---------------------------------------------------------------- the Topic tally

function unitLine(rest) {
  const s = text(rest);
  const n = re => { const m = re.exec(s); return m ? Number(m[1]) : null; };
  const lane = /\blane ([ABC])\b/.exec(s);
  return { misses: n(/(\d+)\s+miss/), lane: lane ? lane[1] : null, mehlman_rank: n(/Mehlman #(\d+)/), off: /not on the checklist/i.test(s),
    sure_wrong: n(/(\d+)\s+sure and wrong/) || 0, slow: n(/(\d+)\s+slow/) || 0 };
}

export function parseTally(html) {
  const groups = [], lines = [], problems = [];
  let group = null, line = null;
  const RE = /<h2\b[^>]*>([\s\S]*?)<\/h2>|<p\b[^>]*>\s*<span\b[^>]*font-weight:\s*bold[^>]*>([\s\S]*?)<\/span>\s*:([\s\S]*?)<\/p>|<li\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*:([^<]*)<\/li>/gi;
  for (const m of String(html ?? '').matchAll(RE)) {
    if (m[1] != null) {
      const h = text(m[1]);
      const c = /^(.*?)\s*\((\d+)\)$/.exec(h);
      group = { system: c ? c[1] : h, count: c ? Number(c[2]) : null, lines: [] };
      groups.push(group);
      line = null;
    } else if (m[2] != null) {
      if (!group) { problems.push('A tally line comes before any system heading.'); continue; }
      line = { name: text(m[2]), system: group.system, ...unitLine(m[3]), conditions: [] };
      group.lines.push(line);
      lines.push(line);
    } else {
      if (!line) { problems.push('A tally condition comes before any unit line.'); continue; }
      const url = attr(m[4], 'href');
      const rest = text(m[6]);
      const condition = text(m[5]);
      if (!condition) continue;
      if (QUESTION_ID.test(condition)) { problems.push('A tally condition names a question id, so it is left out.'); continue; }
      line.conditions.push({ condition, url: url || null, amboss_url: url && KNOWLEDGE.test(url) ? url : null,
        misses: Number(/^(\d+)/.exec(rest)?.[1]) || null, last: /last (\d{4}-\d{2}-\d{2})/.exec(rest)?.[1] || null });
    }
  }
  // A heading's number is its misses ('Cardiovascular (8)'), so it checks the lines were all read.
  for (const g of groups) {
    const n = g.lines.reduce((a, l) => a + (l.misses || 0), 0);
    if (g.count != null && g.count !== n) problems.push(`${g.system}: the heading says ${g.count} misses, the lines read add up to ${n}.`);
  }
  return { groups, lines, conditions: lines.reduce((a, l) => a + l.conditions.length, 0), problems };
}

export function matchTally(tally, units) {
  const byRank = new Map(), byName = new Map();
  for (const u of units || []) {
    if (u.mehlman_rank != null) byRank.set(u.mehlman_rank, u);
    const k = norm(u.name);
    byName.set(k, byName.has(k) ? null : u);   // a name two units share never matches by name alone
  }
  const byUnit = {}, labels = [], unmatched = [], problems = [];
  for (const l of (tally && tally.lines) || []) {
    let unit = null;
    if (!l.off) {
      const r = l.mehlman_rank != null ? byRank.get(l.mehlman_rank) : null;
      unit = r && norm(r.name) === norm(l.name) ? r : byName.get(norm(l.name)) || null;
      if (!unit) { unmatched.push(l.name); problems.push(`The tally line "${l.name}" matches no checklist unit; its conditions wait as labels.`); }
    }
    if (unit) {
      const list = byUnit[unit.id] || (byUnit[unit.id] = []);
      for (const c of l.conditions) if (!list.some(x => norm(x.condition) === norm(c.condition))) list.push(c);
      continue;
    }
    const cat = (categoryFor(l.system, 'checklist_system') || {}).category_id || null;
    for (const c of l.conditions) {
      if (labels.some(x => norm(x.condition) === norm(c.condition))) continue;
      labels.push({ condition: c.condition, amboss_url: c.amboss_url, system: l.system, category_id: cat, misses: c.misses, last: c.last,
        ...(l.off ? {} : { unit_hint: l.name }) });
    }
  }
  return { byUnit, labels, unmatched, problems };
}

// ---------------------------------------------------------------- a system page's Contents

const TAGS = [[/\s*Core topic\s*$/i, 'onenote_core'], [/\s*Mehlman topic\s*$/i, 'onenote_mehlman']];

export function parseContents(html, { pageId = null, section = null, taken = new Set() } = {}) {
  const src = String(html ?? '');
  const h = /<h1\b[^>]*>\s*Contents\s*<\/h1>/i.exec(src);
  if (!h) return { entries: [], units: [] };
  const end = src.indexOf('</div>', h.index);
  const block = src.slice(h.index, end < 0 ? undefined : end);
  const entries = [], units = [];
  for (const m of block.matchAll(/<p\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>([\s\S]*?)<\/p>/gi)) {
    const t = text(m[2]);
    const n = /^(\d+)\.\s+(.*)$/.exec(t);
    if (!n) continue;
    let title = n[2], kind = 'checklist';
    for (const [re, k] of TAGS) if (re.test(title)) { title = title.replace(re, '').trim(); kind = k; }
    const href = attr(m[1], 'href');
    const obj = href && /object-id=(\{[0-9a-f-]+\})/i.exec(href);
    const e = { num: Number(n[1]), title, kind, href: href && /^onenote:/i.test(href) ? href : null, object_id: obj ? obj[1].toUpperCase() : null };
    entries.push(e);
    if (kind === 'checklist') continue;
    if (QUESTION_ID.test(title)) continue;
    const id = pseudoId(title, taken);
    taken.add(id);
    units.push({ id, kind, name: title.slice(0, 200), heading: title.slice(0, 200), onenote_section: section, onenote_page_id: pageId,
      onenote_object_id: e.object_id, onenote_link: e.href, source_ref: `onenote:${section || 'contents'}#${id}` });
  }
  return { entries, units };
}

// 'x-' and the slug of the name before any ':' or '(' ('Hypertension: diagnosis…' -> 'x-hypertension').
function pseudoId(title, taken) {
  const short = slug(String(title).split(/[:(]/)[0]).slice(0, 58).replace(/-+$/, '');
  const full = slug(title).slice(0, 58).replace(/-+$/, '');
  for (const base of [short, full].filter(Boolean)) if (!taken.has(`x-${base}`)) return `x-${base}`;
  const base = short || full || 'heading';
  for (let i = 2; ; i++) if (!taken.has(`x-${base}-${i}`)) return `x-${base}-${i}`;
}

// ---------------------------------------------------------------- checks

export function checklistChecks(parsed, expect = EXPECT) {
  const units = (parsed && parsed.units) || [];
  const rapid = (parsed && parsed.rapid) || [];
  const lanes = { A: 0, B: 0, C: 0 };
  for (const u of units) if (lanes[u.lane] != null) lanes[u.lane] += 1;
  const gaps = units.filter(u => u.notes_gap).length;
  const pairs = rapid.reduce((a, r) => a + r.pairs.length, 0);
  const noCat = units.filter(u => !((categoryFor(u.onenote_section, 'onenote_section') || {}).category_id || (categoryFor(u.checklist_system, 'checklist_system') || {}).category_id));
  const noLink = units.filter(u => !u.onenote_link);
  const noLane = units.filter(u => !u.lane);
  const problems = [];
  if (units.length !== expect.units) problems.push(`${units.length} units, expected ${expect.units}.`);
  for (const k of ['A', 'B', 'C']) if (lanes[k] !== expect.lanes[k]) problems.push(`Lane ${k}: ${lanes[k]} units, expected ${expect.lanes[k]}.`);
  if (gaps !== expect.gaps) problems.push(`${gaps} gaps in the notes, expected ${expect.gaps}.`);
  if (rapid.length !== expect.rapid) problems.push(`${rapid.length} Rapid differentials, expected ${expect.rapid}.`);
  if (pairs !== expect.pairs) problems.push(`${pairs} Rapid pairs, expected ${expect.pairs}.`);
  if (noCat.length) problems.push(`No category for units ${noCat.slice(0, 10).map(u => u.num).join(', ')}.`);
  if (noLink.length) problems.push(`No OneNote link for units ${noLink.slice(0, 10).map(u => u.num).join(', ')}.`);
  if (noLane.length) problems.push(`No lane for units ${noLane.slice(0, 10).map(u => u.num).join(', ')}.`);
  const lines = [`${units.length} units: A ${lanes.A} / B ${lanes.B} / C ${lanes.C}`, `${gaps} gaps in the notes`,
    `${rapid.length} Rapid items, ${pairs} pairs`, `${(parsed && parsed.ticks || []).length} Done ticks`];
  return { ok: problems.length === 0, lines, problems };
}

// ---------------------------------------------------------------- import bodies

const unitCost = 2, labelCost = 1, versusCost = 1, tickCost = STEPS.length;

export function importBodies({ pages, kind, units = [], tallyByUnit = {}, ticks = [], labels = [], rapid = [], counts = null }, { max = MAX_ROWS } = {}) {
  const items = [
    ...units.map(u => ({ cost: unitCost, key: 'units', value: { ...u, tally: (tallyByUnit[u.id] || []).map(c => ({ condition: c.condition, amboss_url: c.amboss_url || null, misses: c.misses ?? null, last: c.last ?? null })) } })),
    ...ticks.map(t => ({ cost: tickCost, key: 'ticks', value: t })),
    ...labels.map(l => ({ cost: labelCost, key: 'labels', value: l })),
    ...rapid.map(r => ({ cost: versusCost, key: 'versus', value: { n: r.n, text: r.text, pairs: r.pairs } })),
  ];
  const bodies = [];
  let cur = null;
  const open = () => { cur = { pages, kind, parser_version: PARSER_VERSION, rows: 0 }; bodies.push(cur); };
  for (const it of items) {
    if (!cur || cur.rows + it.cost > max) open();
    (cur[it.key] || (cur[it.key] = [])).push(it.value);
    cur.rows += it.cost;
  }
  if (!bodies.length) open();
  bodies.forEach((b, i) => { delete b.rows; b.final = i === bodies.length - 1; if (b.final && counts) b.counts = counts; });
  return bodies;
}
