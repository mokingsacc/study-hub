import { fsrs, createEmptyCard, Rating } from 'ts-fsrs';
import { CATEGORY_IDS } from '../map/vocab.js';

export const KINDS = ['acronym', 'hook', 'rule'];
export const SOURCES = ['onenote', 'ajmonics', 'mo', 'claude'];
export const DIRS = ['fwd', 'rev'];
export const RATINGS = ['again', 'hard', 'good', 'easy'];
export const CAP = { cue: 60, about: 160, key: 12, item: 240, items: 24, notes: 1500, topics: 12, source_ref: 200 };
export const NEW_PER_DAY = 10;    // new mnemonics a London day (each starts with its fwd test)
export const ID = /^mn_[a-z0-9]{8,40}$/;
const TOPIC_ID = /^[a-z0-9][a-z0-9._-]{0,119}$/;   // a dot: Study Hub ids (user.subject-topic)
// The Study Hub's subjects (platform/subjects.js ids such as alevel-biology) are subjects too.
const PLATFORM_SUBJECT = /^(gcse|alevel|language|uk_med|primary|university|other)-[a-z0-9_-]{1,60}$/;

const SCHED = fsrs({ request_retention: 0.9, enable_fuzz: false });
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const parse = (s, d) => { if (s == null) return d; if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return d; } };

/**
 * A mnemonic's fields from a request, checked: {fields} or {refuse, field}. partial: only the fields given (an edit).
 * items: [{key, text}] or ["Supraspinatus", ...] (key then empty) or "S: Supraspinatus\nI: ..." (one a line).
 */
export function cleanFields(a, { partial = false } = {}) {
  if (!isObj(a)) return { refuse: 'Send the mnemonic as an object.' };
  const out = {};
  const has = k => Object.prototype.hasOwnProperty.call(a, k);
  if (!partial || has('cue')) {
    const cue = text(a.cue);
    if (!cue || cue.length > CAP.cue) return { refuse: `cue is the word or letters to remember, 1 to ${CAP.cue} characters.`, field: 'cue' };
    out.cue = cue;
  }
  if (!partial || has('about')) {
    const about = text(a.about);
    if (!about || about.length > CAP.about) return { refuse: `about says what it is for (Rotator cuff muscles), 1 to ${CAP.about} characters.`, field: 'about' };
    out.about = about;
  }
  if (!partial || has('kind')) {
    const kind = a.kind == null ? 'acronym' : a.kind;
    if (!KINDS.includes(kind)) return { refuse: `kind is one of ${KINDS.join(', ')}.`, field: 'kind' };
    out.kind = kind;
  }
  if (!partial || has('items')) {
    const items = itemsOf(a.items);
    if (items.refuse) return items;
    out.items_json = JSON.stringify(items.list);
  }
  if (has('category_id') || !partial) {
    const c = a.category_id == null || a.category_id === '' ? null : String(a.category_id);
    if (c != null && !CATEGORY_IDS.includes(c) && !PLATFORM_SUBJECT.test(c)) return { refuse: 'category_id is a subject on the map (such as cardiology).', field: 'category_id' };
    out.category_id = c;
  }
  if (has('topics') || !partial) {
    const t = a.topics == null ? [] : a.topics;
    if (!Array.isArray(t) || t.length > CAP.topics || !t.every(x => typeof x === 'string' && TOPIC_ID.test(x))) {
      return { refuse: `topics is a list of up to ${CAP.topics} map topic ids.`, field: 'topics' };
    }
    out.topics_json = JSON.stringify([...new Set(t)]);
  }
  if (has('notes') || !partial) {
    const n = a.notes == null ? '' : String(a.notes).trim();
    if (n.length > CAP.notes) return { refuse: `notes is at most ${CAP.notes} characters.`, field: 'notes' };
    out.notes = n || null;
  }
  return { fields: out };
}

/** [{key, text}] from the forms cleanFields takes, or {refuse}. */
export function itemsOf(v) {
  let list = v;
  if (typeof v === 'string') list = v.split(/\n+/).map(s => s.trim()).filter(Boolean).map(s => { const m = s.match(/^(\S{1,12}?)\s*[:=]\s+(.+)$/); return m ? { key: m[1], text: m[2] } : { key: '', text: s }; });
  if (!Array.isArray(list) || !list.length || list.length > CAP.items) return { refuse: `items is the expansion, 1 to ${CAP.items} parts.`, field: 'items' };
  const out = [];
  for (const x of list) {
    const it = typeof x === 'string' ? { key: '', text: text(x) } : isObj(x) ? { key: text(x.key ?? ''), text: text(x.text ?? x.item ?? '') } : null;
    if (!it || !it.text || it.text.length > CAP.item || it.key.length > CAP.key) return { refuse: `Each item is a short key (up to ${CAP.key} characters) and its text (up to ${CAP.item}).`, field: 'items' };
    out.push(it);
  }
  return { list: out };
}

export function ratingOf(missed, total, easy = false) {
  if (missed <= 0) return easy ? 'easy' : 'good';
  if (total <= 1 || missed >= 2) return 'again';
  return 'hard';
}

const RATING = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };

/** The FSRS card a stored review row holds (or a new one). */
export function cardOf(row, now) {
  if (!row) return createEmptyCard(new Date(now));
  return {
    due: new Date(Number(row.due)), stability: Number(row.stability), difficulty: Number(row.difficulty), elapsed_days: 0,
    scheduled_days: Number(row.scheduled_days) || 0, learning_steps: Number(row.learning_steps) || 0, reps: Number(row.reps) || 0,
    lapses: Number(row.lapses) || 0, state: Number(row.state) || 0, last_review: row.last_review == null ? undefined : new Date(Number(row.last_review)),
  };
}

/** One review: the stored row's columns after rating (pure). prev: the row as it is, or null for a first test. */
export function stepReview(prev, rating, now) {
  const r = SCHED.next(cardOf(prev, now), new Date(now), RATING[rating]);
  const c = r.card;
  return {
    due: c.due.getTime(), stability: Math.round(c.stability * 1e4) / 1e4, difficulty: Math.round(c.difficulty * 1e4) / 1e4,
    scheduled_days: c.scheduled_days, learning_steps: c.learning_steps, reps: c.reps, lapses: c.lapses, state: c.state,
    last_review: now, last_rating: rating,
  };
}

/** A review row as the page reads it. */
export function shapeReview(r) {
  if (!r) return null;
  return { due: Number(r.due), state: Number(r.state), reps: Number(r.reps), lapses: Number(r.lapses), stability: Number(r.stability),
    last_review: r.last_review == null ? null : Number(r.last_review), last_rating: r.last_rating || null, last_missed: parse(r.last_missed_json, []),
    first_at: Number(r.first_at) || null };
}

/** A mnemonics row (with its reviews and the names of its topics) as the page reads it. */
export function shapeMnemonic(m, reviews = {}, topicNames = new Map()) {
  const ids = parse(m.topics_json, []);
  return {
    id: m.id, cue: m.cue, about: m.about, kind: m.kind, items: parse(m.items_json, []), category_id: m.category_id || null, notes: m.notes || '',
    topics: ids.map(id => { const t = topicNames.get(id); return { id: t ? t.id : id, name: t ? t.name : null }; }),
    source: m.source, source_ref: m.source_ref || null, created_at: Number(m.created_at), updated_at: Number(m.updated_at),
    fwd: shapeReview(reviews.fwd), rev: shapeReview(reviews.rev),
  };
}

export const REV_AFTER_MS = 20 * 3600_000;
/** Is a mnemonic's rev test open yet (its first fwd test long enough ago)? */
export const revOpen = (fwdFirst, now) => fwdFirst != null && Number(fwdFirst) + REV_AFTER_MS <= now;

export function testQueue(list, { now, newToday = 0, newPerDay = NEW_PER_DAY, limit = 60 } = {}) {
  const due = [], fresh = [];
  for (const m of list) {
    for (const dir of DIRS) {
      const r = m[dir];
      if (r && r.due <= now) due.push({ id: m.id, dir, due: r.due });
      else if (!r && dir === 'fwd') fresh.push({ id: m.id, dir, due: null, created_at: m.created_at });
      else if (!r && dir === 'rev' && revOpen(m.fwd && m.fwd.first_at, now)) due.push({ id: m.id, dir, due: m.fwd.first_at + REV_AFTER_MS });
    }
  }
  due.sort((a, b) => a.due - b.due || a.id.localeCompare(b.id));
  fresh.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const room = Math.max(0, newPerDay - newToday);
  return [...due, ...fresh.slice(0, room)].slice(0, limit).map(({ id, dir }) => ({ id, dir }));
}

/** Per subject: {total, due, new} for the counts route and the map's ball. Pure. */
export function countsOf(rows, now) {
  const by = {};
  for (const r of rows) {
    const c = r.category_id || 'other';
    const b = by[c] || (by[c] = { total: 0, due: 0, new: 0 });
    b.total += 1;
    if (r.fwd_due == null) b.new += 1;
    else if (Number(r.fwd_due) <= now || (r.rev_due != null ? Number(r.rev_due) <= now : revOpen(r.fwd_first, now))) b.due += 1;
  }
  return by;
}

/** Due, new or later for one shaped mnemonic now (the page's statusOf, the same rule as countsOf). Pure. */
export function statusOf(m, now) {
  if (!m.fwd) return 'new';
  if (m.fwd.due <= now) return 'due';
  if (m.rev ? m.rev.due <= now : revOpen(m.fwd.first_at, now)) return 'due';
  return 'later';
}

/**
 * A subject's mnemonics galaxy for public/js/galaxy (pure): its mnemonics as items, the topics they cover, a line from
 * each to its topics, and a dashed line between two mnemonics that cover look-alike topics (pairs: [[a, b]] of
 * active versus links). A look-alike's mnemonic in another subject is a far node on the rim, named with its subject.
 * all: every shaped mnemonic; bands: Map topic -> band; subjects: Map id -> name.
 */
export function galaxyOf(all, category, pairs, { bands = new Map(), subjects = new Map(), now = Date.now() } = {}) {
  const inCat = m => (category === 'other' ? !m.category_id || !subjects.has(m.category_id) : m.category_id === category);
  const here = all.filter(inCat);
  const nodes = [], edges = [], topics = new Map();
  for (const m of here) {
    nodes.push({ id: m.id, kind: 'item', label: m.cue, sub: m.about, state: statusOf(m, now) });
    for (const t of m.topics) {
      if (!t.name) continue;
      if (!topics.has(t.id)) topics.set(t.id, { id: `t:${t.id}`, topic: t.id, kind: 'topic', label: t.name, band: bands.get(t.id) || null });
      edges.push({ a: m.id, b: `t:${t.id}`, kind: 'covers' });
    }
  }
  nodes.push(...topics.values());
  const covering = new Map();
  for (const m of all) for (const t of m.topics) { const l = covering.get(t.id) || []; l.push(m); covering.set(t.id, l); }
  const seen = new Set(), far = new Map();
  for (const [x, y] of pairs) {
    for (const [p, q] of [[x, y], [y, x]]) {
      for (const a of (covering.get(p) || []).filter(inCat)) {
        for (const b of covering.get(q) || []) {
          if (a.id === b.id) continue;
          const bId = inCat(b) ? b.id : `far:${b.id}`;
          const k = [a.id, bId].sort().join('|');
          if (seen.has(k)) continue;
          seen.add(k);
          if (!inCat(b) && !far.has(bId)) far.set(bId, { id: bId, mnemonic: b.id, kind: 'far', label: b.cue, sub: subjects.get(b.category_id) || 'Other', category_id: b.category_id || 'other' });
          edges.push({ a: a.id, b: bId, kind: 'versus' });
        }
      }
    }
  }
  nodes.push(...far.values());
  return { nodes, edges };
}
