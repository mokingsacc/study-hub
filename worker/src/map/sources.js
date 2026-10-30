import { json, readJson, londonDay } from '../util.js';
import { ankiCall } from '../anki.js';
import { writeBatch, summaryOf } from './events.js';
import { applyChange, changeResponse, UNDO_HINT } from './change.js';
import { cardEvidence, mergeCardDay, parseSchedule, MAX_TOPICS_PER_CARD } from './cards.js';
import { mehlmanFor, resourceId, CACHE_MS as MEHLMAN_MS } from './mehlman.js';
import { fnv1a, EVIDENCE_COLS } from './ingest/map-fields.js';
import { norm, contentWords, spanQualified, contextWords, contextBars, namedIn } from '../../../public/js/shared/names.js';

export const MY_DECK = 'Step 2 — My Cards';
export const CARDS_MS = 10 * 60_000;          // cards are stale after 10 minutes
export const ERROR_RETRY_MS = 2 * 60_000;     // a failed Anki call is retried after 2 minutes
export { MEHLMAN_MS };
export const CARD_FULL_MS = 86_400_000;       // an opened card is re-read from Anki after a day
export const CHECK_LIMIT = 5;                 // cards per search (check_deck's limit is 1 to 5)
export const KINDS = ['cards', 'mehlman'];
export const NOTE_GAP_MAX = 50;               // a card id is its note id plus 1 to 50 (Anki makes the card just after the note)
const TIMEOUT_MS = 8000, CARD_TIMEOUT_MS = 4000;
const CARD_CAPS = { question: 2000, answer: 4000, vs: 600, notes: 4000, deck: 120, schedule: 120 };

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (s, d) => { if (s == null || s === '') return d; if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return d; } };
const intOf = v => (v == null || v === '' || !Number.isSafeInteger(Number(v)) ? null : Number(v));
const capText = (s, n) => (s == null ? null : String(s).length > n ? String(s).slice(0, n) : String(s));

// ---------------------------------------------------------------- pure helpers

/** Which kinds are due a refresh, from the topic's source_fetches rows (no row: due; a failed read: after 2 min). */
export function staleKinds(fetches, now = Date.now(), kinds = KINDS) {
  return kinds.filter(k => {
    const f = (fetches || []).find(x => x.kind === k);
    if (!f) return true;
    const age = now - (Number(f.fetched_at) || 0);
    if (f.status === 'error') return age > ERROR_RETRY_MS;
    return age > (k === 'cards' ? CARDS_MS : MEHLMAN_MS);
  });
}

const searchWords = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const SEARCH_STOP = new Set(['and', 'or', 'the', 'of', 'in', 'with', 'a', 'an', 'to', 'for', 'vs', 'versus', 'on', 'by']);

/**
 * Up to 4 check_deck searches for a topic: abbreviations and the short name first (they are what cards say),
 * then the name and other aliases. Each is 1 to 4 words (one word only when it has 3 or more letters), lower
 * case, without small words, deduplicated.
 */
const WORDY_ABBREVS = new Set(['all', 'men', 'hit', 'ten', 'last', 'cap', 'aids', 'fast', 'crest', 'sad', 'cat', 'pan', 'pad', 'ice', 'arm', 'leg', 'cell',
  'mass', 'map', 'pain', 'rash', 'sids', 'bad', 'mad', 'pid', 'tic', 'tics', 'acid', 'base', 'gap', 'tear', 'bone', 'dash', 'cage', 'gold', 'apgar']);
const riskyAbbrev = w => w.length <= 3 || WORDY_ABBREVS.has(w);
export function cardSearches(topic) {
  const t = topic || {};
  const aliases = (t.aliases || []).map(a => (isObj(a) ? a : { alias: a, kind: null }));
  const ordered = [
    ...aliases.filter(a => a.kind === 'abbrev').map(a => ({ text: a.alias, abbrev: true })),
    { text: t.short_name, abbrev: true }, { text: t.name },
    ...aliases.filter(a => a.kind !== 'abbrev').map(a => ({ text: a.alias })),
  ];
  const nameWords = searchWords(t.name).filter(x => !SEARCH_STOP.has(x) && x.length >= 4).sort((a, b) => b.length - a.length);
  const out = [], seen = new Set();
  for (const raw of ordered) {
    let w = searchWords(raw.text).filter(x => !SEARCH_STOP.has(x)).slice(0, 4);
    if (raw.abbrev && w.length === 1 && riskyAbbrev(w[0])) {
      const with_ = nameWords.find(x => x !== w[0]);
      if (!with_) continue;
      w = [w[0], with_];
    }
    if (!w.length || (w.length === 1 && w[0].length < 3)) continue;
    const q = w.join(' ');
    if (seen.has(q)) continue;
    seen.add(q);
    out.push(q);
    if (out.length >= 4) break;
  }
  return out;
}

/** The miss note a card was made from: a note id 1 to 50 below the card id, or null. */
export function noteOf(cardId, noteIds) {
  const c = Number(cardId);
  let best = null;
  for (const n of noteIds || []) {
    const d = c - Number(n);
    if (d >= 1 && d <= NOTE_GAP_MAX && (best == null || d < c - best)) best = Number(n);
  }
  return best;
}

// A name given as a string, or as {alias, kind}: an abbreviation ('abbrev') counts only as written, in capitals.
const nameOf = n => (isObj(n) ? { alias: n.alias, abbrev: n.kind === 'abbrev' } : { alias: n, abbrev: false });
const capsWord = (raw, alias) => new RegExp(`(?:^|[^A-Za-z0-9])${String(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^A-Za-z0-9]|$)`).test(raw);

/**
 * Does the card's text name the topic? A name or alias (3 or more characters) appears as whole words in the
 * case or answer, or every content word of a name of 2 or more content words does. Both sides through norm();
 * an abbreviation alias ({alias, kind: 'abbrev'}) only as written, in capitals ('LAST', never "last month").
 */
export function namesTopic(card, names) {
  return nameHits(`${card.question || ''} ${card.answer || ''}`, names).length > 0;
}

// The keys of the names that the text names (see namesTopic).
function nameHits(raw, names) {
  const text = ` ${norm(raw)} `;
  const words = new Set(text.trim().split(' '));
  const out = [];
  for (const x of names || []) {
    const n = nameOf(x);
    const k = norm(n.alias);
    if (!k) continue;
    if (n.abbrev) { if (k.length >= 2 && capsWord(raw, String(n.alias).trim())) out.push(k); continue; }
    if (k.length >= 3 && text.includes(` ${k} `)) { out.push(k); continue; }
    const cw = contentWords(k);
    if (cw.length >= 2 && cw.every(w => words.has(w))) out.push(k);
  }
  return out;
}

// Words before a name that make it a finding of something else, for cards (with names.js's span qualifiers):
// "ST depression" is not depression, "respiratory depression" neither.
const CARD_MODIFIERS = new Set(['st', 'respiratory', 'cns', 'myocardial', 'marrow', 'arterial', 'venous', 'ocular', 'renovascular', 'secondary']);
function nameUnqualified(raw, names, topic) {
  for (const k of nameHits(raw, names)) {
    if (spanQualified(raw, k)) continue;
    const ctx = contextWords(raw, k, { near: true });
    // The topic's disciplines count too (taxonomy v2): "in pregnancy" next to a name does not bar a topic tagged ObGyn.
    if (ctx.length && contextBars(ctx, { category_id: topic && topic.category_id, category2_id: topic && topic.category2_id, disciplines: topic && topic.disciplines })) continue;
    const w = norm(raw).split(' ');
    const kw = k.split(' ');
    let modified = false;
    for (let i = 0; i + kw.length <= w.length; i++) {
      if (kw.some((x, j) => w[i + j] !== x)) continue;
      if (w.slice(Math.max(0, i - 2), i).some(t => CARD_MODIFIERS.has(t))) modified = true;
    }
    if (!modified) return true;
  }
  return false;
}

export function cardSubject(card, topic, names) {
  const answer = String(card.answer || '');
  // Its first clause: "This is **NSTEMI**: ST depression ...", "This is CREST; screen for pulmonary hypertension".
  const first = answer.split(/\n|[.!?;:,](?:\s|$)|\s[–—-]\s/)[0] || '';
  if (nameUnqualified(first, names, topic)) return true;
  if (topic && topic.kind && topic.kind !== 'condition') return nameUnqualified(`${card.question || ''}\n${answer}`, names, topic);
  return false;
}

/** The first 8 content words of a card's case: the find_cards search that finds that card again. */
export function cardKey(question) {
  const w = searchWords(cleanCardText(question)).filter(x => x.length >= 3 && !SEARCH_STOP.has(x));
  return w.slice(0, 8).join(' ');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
/** Card HTML as plain text: bold kept as **bold**, line breaks kept, every other tag dropped. */
export function cleanCardText(s) {
  if (s == null) return null;
  const t = String(s)
    .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/\s*(div|p|li)\s*>/gi, '\n')
    .replace(/<\s*(b|strong)\b[^>]*>/gi, '**').replace(/<\/\s*(b|strong)\s*>/gi, '**')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
      if (ENTITIES[e.toLowerCase()] != null) return ENTITIES[e.toLowerCase()];
      if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (/^#\d+$/.test(e)) return String.fromCodePoint(Number(e.slice(1)));
      return m;
    })
    .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return t || null;
}

/**
 * The fields the hub keeps from one card in a server reply (check_deck or find_cards), cleaned; null without a
 * card id. The Versus line comes from its own field, or is lifted out of the answer.
 */
export function cardFields(c) {
  if (!isObj(c)) return null;
  const card_id = intOf(c.card_id ?? c.id);
  if (!card_id || card_id <= 0) return null;
  let answer = cleanCardText(c.answer ?? c.back);
  let vs = cleanCardText(c.vs ?? c.versus);
  if (!vs && answer) {
    const lines = answer.split('\n');
    const i = lines.findIndex(l => /^\**\s*versus\s/i.test(l));
    if (i >= 0) { vs = lines[i].replace(/\*\*/g, '').trim(); lines.splice(i, 1); answer = lines.join('\n').trim() || null; }
  }
  const schedule = c.schedule == null ? null : String(c.schedule).trim();
  const lapses = intOf(c.lapses) ?? (schedule ? parseSchedule(schedule).lapses : null);
  const images = Array.isArray(c.images) ? c.images : Array.isArray(c.image_names) ? c.image_names : null;
  return {
    card_id, note_id: intOf(c.note_id), deck: capText(c.deck, CARD_CAPS.deck), question: capText(cleanCardText(c.question ?? c.front), CARD_CAPS.question),
    answer: capText(answer, CARD_CAPS.answer), vs: capText(vs, CARD_CAPS.vs), notes: capText(cleanCardText(c.notes ?? c.extra), CARD_CAPS.notes),
    schedule: capText(schedule, CARD_CAPS.schedule), lapses, image_count: intOf(c.image_count) ?? (images ? images.length : null),
    images: images ? images.filter(x => typeof x === 'string').map(x => x.slice(0, 200)).slice(0, 12) : null,
  };
}

/** The 'Why:' line and the rest of the notes, apart. */
export function splitNotes(notes) {
  if (!notes) return { why: null, notes: null };
  const lines = String(notes).split('\n');
  const i = lines.findIndex(l => /^\**\s*why\s*:/i.test(l));
  if (i < 0) return { why: null, notes: String(notes) };
  const why = lines[i].replace(/\*\*/g, '').replace(/^\s*why\s*:\s*/i, '').trim() || null;
  lines.splice(i, 1);
  return { why, notes: lines.join('\n').trim() || null };
}

export function mehlmanFile(title) {
  const t = String(title || '').trim().replace(/^Mehlman\s+/i, '');
  const lm = /^(.+?)\s+Learning Modules\s*\(key facts\)$/i.exec(t);
  if (lm) return `new/${lm[1]} Learning Modules.pdf`;
  return t.replace(/\s*,\s*|\s*&\s*|\s*\/\s*/g, '-').replace(/\s+/g, ' ') + '.pdf';
}

// The evidence columns an upsert carries (the key's user_id is set by realtime; first-creator columns stay).
const EV_WRITE = EVIDENCE_COLS.filter(c => !['user_id', 'created_at', 'updated_at'].includes(c));
const evRow = r => Object.fromEntries(EV_WRITE.filter(c => r[c] !== undefined).map(c => [c, r[c]]));

/**
 * Evidence slots for new card rows, so each (observation, topic) keeps its own row: a topic that already has a
 * row under the key keeps that slot; a new topic takes the lowest free slot (0 to 2) or is left out. A card-day
 * row merges with the stored one (mergeCardDay), so a gap's card check that day is kept.
 */
export function placeCardRows(rows, existing) {
  const byKey = new Map();
  for (const e of existing || []) {
    if (!byKey.has(e.obs_key)) byKey.set(e.obs_key, []);
    byKey.get(e.obs_key).push(e);
  }
  const out = [];
  for (const r of rows) {
    const here = byKey.get(r.obs_key) || [];
    let slot = null;
    const mine = here.find(e => e.topic_id === r.topic_id);
    if (mine) slot = Number(mine.slot) || 0;
    else {
      const used = new Set(here.map(e => Number(e.slot) || 0));
      for (let s = 0; s < MAX_TOPICS_PER_CARD; s++) if (!used.has(s)) { slot = s; break; }
      if (slot == null) continue;
      here.push({ obs_key: r.obs_key, slot, topic_id: r.topic_id });
      byKey.set(r.obs_key, here);
    }
    let row = { ...r, slot };
    if (mine && /^card:/.test(r.obs_key) && mine.kind) row = { ...mergeCardDay(mine, row), slot };
    out.push(evRow(row));
  }
  return out;
}

// ---------------------------------------------------------------- refreshSources

// In-flight refreshes per database binding (an isolate serves one), keyed by user, topic and kinds.
const inflight = new WeakMap();

export function refreshSources(env, user, topicId, opts = {}) {
  const key = `${user}|${topicId}|${(opts.kinds || KINDS).join(',')}`;
  const bind = env && env.DB && typeof env.DB === 'object' ? env.DB : inflight;
  if (!inflight.has(bind)) inflight.set(bind, new Map());
  const running = inflight.get(bind);
  if (running.has(key)) return running.get(key);
  const p = runRefresh(env, user, topicId, opts).finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

async function readTopicSources(env, user, topicId) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [t, al, mn, ln, f, ct, mb] = await env.DB.batch([
    q(`SELECT id, name, short_name, kind, category_id, category2_id, status, merged_into, disciplines, oncology FROM topics WHERE user_id = ? AND id = ?`, user, topicId),
    q(`SELECT alias, kind FROM topic_aliases WHERE user_id = ? AND topic_id = ? AND status = 'active' AND kind NOT IN ('typo','truncated')
       ORDER BY kind = 'abbrev' DESC, length(alias) LIMIT 8`, user, topicId),
    q(`SELECT anki_note_ids_json FROM misses_live WHERE user_id = ? AND topic_id = ? AND anki_note_ids_json NOT IN ('[]','') LIMIT 60`, user, topicId),
    q(`SELECT card_note_id, card_id, card_action FROM lessons WHERE user_id = ? AND topic_id = ? AND (card_note_id IS NOT NULL OR card_id IS NOT NULL) LIMIT 30`, user, topicId),
    q(`SELECT kind, fetched_at, n, status, list_sha FROM source_fetches WHERE user_id = ? AND topic_id = ?`, user, topicId),
    q(`SELECT card_id, match, strong, removed_at FROM card_topics WHERE user_id = ? AND topic_id = ?`, user, topicId),
    q(`SELECT resource_id, page FROM resource_links WHERE user_id = ? AND topic_id = ? AND kind = 'mehlman' AND status = 'live' ORDER BY rank DESC`, user, topicId),
  ]);
  const rows = r => r.results || [];
  const notes = new Set();
  for (const m of rows(mn)) for (const n of parse(m.anki_note_ids_json, []) || []) if (intOf(n)) notes.add(Number(n));
  for (const l of rows(ln)) if (intOf(l.card_note_id)) notes.add(Number(l.card_note_id));
  return { topic: rows(t)[0] || null, aliases: rows(al), noteIds: [...notes], lessonCards: new Set(rows(ln).map(l => intOf(l.card_id)).filter(Boolean)),
    lessonMade: new Set(rows(ln).filter(l => l.card_action === 'added').map(l => intOf(l.card_id)).filter(Boolean)),
    fetches: rows(f), links: new Map(rows(ct).map(l => [Number(l.card_id), l])), mehlmanBefore: rows(mb) };
}

// What the hub already holds about these cards: the cache, every topic's links to them, and their evidence rows.
async function readCards(env, user, cardIds, day) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const ids = JSON.stringify(cardIds);
  const keys = JSON.stringify(cardIds.flatMap(id => [`cardstate:${id}`, `cardlapses:${id}`, `card:${id}:${day}`]));
  const [c, l, e] = await env.DB.batch([
    q(`SELECT card_id, note_id, question, answer, schedule, lapses, full FROM card_cache WHERE user_id = ? AND card_id IN (SELECT value FROM json_each(?))`, user, ids),
    q(`SELECT card_id, topic_id, strong FROM card_topics WHERE user_id = ? AND card_id IN (SELECT value FROM json_each(?)) AND removed_at IS NULL
       ORDER BY created_at, topic_id`, user, ids),
    q(`SELECT * FROM evidence WHERE user_id = ? AND obs_key IN (SELECT value FROM json_each(?))`, user, keys),
  ]);
  const cache = new Map((c.results || []).map(r => [Number(r.card_id), r]));
  const strong = new Map();
  for (const r of l.results || []) if (Number(r.strong)) { const k = Number(r.card_id); if (!strong.has(k)) strong.set(k, []); strong.get(k).push(r.topic_id); }
  return { cache, strong, evidence: e.results || [] };
}

/**
 * The card part of one refresh, pure: the cache and link upserts, the evidence rows and the list sha.
 * cards: cardFields() rows from check_deck; src: readTopicSources(); held: readCards().
 */
export function planCards(cards, src, held, { topicId, now, day, deck }) {
  const names = [src.topic.name, src.topic.short_name ? { alias: src.topic.short_name, kind: 'abbrev' } : null, ...src.aliases].filter(Boolean);
  const cacheRows = [], linkRows = [], evidence = [];
  for (const c of cards) {
    const prev = held.cache.get(c.card_id) || null;
    const missNote = noteOf(c.card_id, src.noteIds);
    const link = src.links.get(c.card_id) || null;
    const sameQ = prev && prev.question === c.question;
    cacheRows.push({
      card_id: c.card_id, note_id: c.note_id ?? missNote ?? (prev && prev.note_id) ?? null, deck: c.deck || deck, question: c.question,
      answer: prev && Number(prev.full) && sameQ ? prev.answer : c.answer, full: prev && Number(prev.full) && sameQ ? 1 : 0,
      schedule: c.schedule, lapses: c.lapses, image_count: c.image_count, fetched_at: now,
    });
    if (link && link.removed_at != null) continue;
    const match = missNote ? 'miss' : src.lessonCards.has(c.card_id) ? 'claude' : 'search';
    const strongNow = match !== 'search' || cardSubject(c, src.topic, names) ? 1 : 0;
    const wasStrong = !!(link && Number(link.strong));
    const isStrong = wasStrong || !!strongNow;
    // The Anki server's search matches inside words, in every field, and falls back to any one word ('ms' in
    // "symptoms", a look-alike in the notes): a keyword hit becomes a link only when the case or answer names the
    // topic strictly (namedIn).
    const named = strongNow || namedIn(`${c.question || ''}\n${c.answer || ''}`, names);
    if ((!link && named) || (link && ((!wasStrong && strongNow) || (link.match === 'search' && match !== 'search')))) {
      linkRows.push({ card_id: c.card_id, topic_id: topicId, match: link && link.match !== 'search' ? link.match : match, strong: isStrong ? 1 : 0, created_at: now });
    }
    // Evidence for every strong topic of the card (this one included), up to 3. A topic with no state row for
    // the card yet sees it for the first time.
    const topics = [...new Set([...(held.strong.get(c.card_id) || []), ...(isStrong ? [topicId] : [])])].slice(0, MAX_TOPICS_PER_CARD);
    const next = { card_id: c.card_id, note_id: c.note_id ?? missNote ?? (prev && prev.note_id) ?? null, schedule: c.schedule, lapses: c.lapses };
    const rows = [];
    for (const t of topics) {
      const hasState = held.evidence.some(e => e.obs_key === `cardstate:${c.card_id}` && e.topic_id === t);
      const before = prev && hasState ? { schedule: prev.schedule, lapses: prev.lapses } : src.lessonMade && src.lessonMade.has(c.card_id) ? MADE_NEW : null;
      rows.push(...cardEvidence(before, next, { topic_ids: [t], at: now, day, source: 'card' }));
    }
    evidence.push(...placeCardRows(rows, held.evidence));
  }
  const sha = fnv1a(cards.map(c => `${c.card_id}:${c.schedule || ''}:${c.lapses ?? ''}`).sort().join('|'));
  return { cacheRows, linkRows, evidence, sha };
}

function cacheStatements(env, user, rows) {
  if (!rows.length) return [];
  return [env.DB.prepare(`INSERT INTO card_cache (user_id, card_id, note_id, deck, question, answer, schedule, lapses, image_count, full, fetched_at)
    SELECT ?1, json_extract(value, '$.card_id'), json_extract(value, '$.note_id'), json_extract(value, '$.deck'), json_extract(value, '$.question'),
      json_extract(value, '$.answer'), json_extract(value, '$.schedule'), json_extract(value, '$.lapses'), json_extract(value, '$.image_count'),
      json_extract(value, '$.full'), json_extract(value, '$.fetched_at') FROM json_each(?2) WHERE true
    ON CONFLICT (user_id, card_id) DO UPDATE SET note_id = coalesce(excluded.note_id, card_cache.note_id), deck = excluded.deck,
      question = excluded.question, answer = excluded.answer, full = excluded.full, schedule = excluded.schedule, lapses = excluded.lapses,
      image_count = coalesce(excluded.image_count, card_cache.image_count), fetched_at = excluded.fetched_at, deleted_at = NULL`).bind(user, JSON.stringify(rows))];
}

function linkStatements(env, user, rows) {
  if (!rows.length) return [];
  return [env.DB.prepare(`INSERT INTO card_topics (user_id, card_id, topic_id, match, strong, created_by, created_at)
    SELECT ?1, json_extract(value, '$.card_id'), json_extract(value, '$.topic_id'), json_extract(value, '$.match'), json_extract(value, '$.strong'),
      'code', json_extract(value, '$.created_at') FROM json_each(?2) WHERE true
    ON CONFLICT (user_id, card_id, topic_id) DO UPDATE SET strong = max(card_topics.strong, excluded.strong),
      match = CASE WHEN card_topics.match = 'search' THEN excluded.match ELSE card_topics.match END
    WHERE card_topics.removed_at IS NULL`).bind(user, JSON.stringify(rows))];
}

function fetchStatement(env, user, topicId, kind, { now, n = null, status, error = null, sha = null, queries = null }) {
  return env.DB.prepare(`INSERT INTO source_fetches (user_id, topic_id, kind, fetched_at, n, status, error, list_sha, queries_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, topic_id, kind) DO UPDATE SET fetched_at = excluded.fetched_at, n = coalesce(excluded.n, source_fetches.n), status = excluded.status,
      error = excluded.error, list_sha = coalesce(excluded.list_sha, source_fetches.list_sha),
      queries_json = coalesce(excluded.queries_json, source_fetches.queries_json)`)
    .bind(user, topicId, kind, now, n, status, error ? String(error).slice(0, 200) : null, sha, queries ? JSON.stringify(queries) : null);
}

async function deckFor(env, user) {
  if (user === 'mo') return MY_DECK;
  try {
    const { profileFor } = await import('../users.js');
    const p = await profileFor(env, user);
    return (p && p.cards && p.cards.deck) || MY_DECK;
  } catch { return MY_DECK; }
}

const passageIds = list => (list || []).map(p => `${p.resource_id}|${p.page}`).sort().join(',');

async function runRefresh(env, user, topicId, opts) {
  const now = opts.now ?? Date.now();
  const kinds = (opts.kinds || KINDS).filter(k => KINDS.includes(k));
  if (!env.ANKI_MCP_URL) return { cards: 'off', mehlman: 'off', changed: false };
  let src;
  try { src = await readTopicSources(env, user, topicId); } catch (e) { if (noTable(e)) return { cards: 'off', mehlman: 'off', changed: false }; throw e; }
  if (!src.topic || src.topic.status === 'merged') return { cards: 'skipped', mehlman: 'skipped', changed: false };
  const due = opts.force ? kinds : staleKinds(src.fetches, now, kinds);
  const recent = k => { const f = src.fetches.find(x => x.kind === k); return opts.minAgeMs > 0 && f && now - f.fetched_at < opts.minAgeMs; };
  const todo = due.filter(k => !recent(k));
  const out = { cards: kinds.includes('cards') ? 'cached' : 'skipped', mehlman: kinds.includes('mehlman') ? 'cached' : 'skipped', changed: false };
  if (!todo.length) return out;

  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const deck = todo.includes('cards') ? await deckFor(env, user) : MY_DECK;
  const searches = cardSearches({ ...src.topic, aliases: src.aliases });
  const cardsP = todo.includes('cards') && searches.length
    ? ankiCall(env, 'check_deck', { deck, limit: CHECK_LIMIT, topics: [{ key: topicId, searches }] }, { timeoutMs }).then(r => ({ ok: r }), e => ({ error: e }))
    : Promise.resolve(todo.includes('cards') ? { ok: { topics: [] } } : null);
  const mehlP = todo.includes('mehlman')
    ? mehlmanFor(env, user, topicId, { timeoutMs, force: true, now }).catch(e => ({ status: 'unreachable', passages: [], error: e }))
    : Promise.resolve(null);
  const [cardsR, mehl] = await Promise.all([cardsP, mehlP]);

  const statements = [];
  let evidence = [], cardPart = null, cardsChanged = false;
  if (cardsR && cardsR.error) {
    out.cards = 'unreachable';
    statements.push(fetchStatement(env, user, topicId, 'cards', { now, status: 'error', error: cardsR.error.message, queries: searches }));
  } else if (cardsR) {
    const topicReply = ((cardsR.ok && cardsR.ok.topics) || []).find(x => x && String(x.key) === String(topicId)) || ((cardsR.ok && cardsR.ok.topics) || [])[0] || {};
    const seen = new Set();
    const cards = (topicReply.cards || []).map(cardFields).filter(c => c && !seen.has(c.card_id) && seen.add(c.card_id));
    const day = londonDay(now);
    const held = cards.length ? await readCards(env, user, cards.map(c => c.card_id), day) : { cache: new Map(), strong: new Map(), evidence: [] };
    cardPart = planCards(cards, src, held, { topicId, now, day, deck });
    evidence = cardPart.evidence;
    const before = src.fetches.find(x => x.kind === 'cards');
    cardsChanged = !before || before.list_sha !== cardPart.sha || cardPart.linkRows.length > 0 || evidence.length > 0;
    statements.push(...cacheStatements(env, user, cardPart.cacheRows), ...linkStatements(env, user, cardPart.linkRows),
      fetchStatement(env, user, topicId, 'cards', { now, n: cards.length, status: cards.length ? 'ok' : 'weak', sha: cardPart.sha, queries: searches }));
    out.cards = 'fresh';
  }
  let mehlChanged = false;
  if (mehl) {
    out.mehlman = mehl.status || 'unreachable';
    mehlChanged = mehl.status === 'fresh' && passageIds(mehl.passages) !== passageIds(src.mehlmanBefore);
    if (mehl.status === 'unreachable' && !src.fetches.some(x => x.kind === 'mehlman')) {
      statements.push(fetchStatement(env, user, topicId, 'mehlman', { now, status: 'error', error: 'The Anki server could not be reached.' }));
    }
  }

  out.changed = cardsChanged || mehlChanged;
  if (!statements.length) return out;
  if (!out.changed) { await env.DB.batch(statements); return out; }
  const parts = [];
  if (cardPart) parts.push(`${cardPart.cacheRows.length} card${cardPart.cacheRows.length === 1 ? '' : 's'}`);
  if (mehl && mehl.status === 'fresh') parts.push(`${(mehl.passages || []).length} Mehlman passage${(mehl.passages || []).length === 1 ? '' : 's'}`);
  if (evidence.some(e => e.kind === 'card_lapse')) parts.push('a lapse counted');
  const w = await writeBatch(env, user, {
    actor: 'code', surface: 'code', via: 'waitUntil:refreshSources', undoable: false, statements,
    evidence: evidence.length ? { upsert: evidence } : undefined,
    events: [{ kind: 'topic.sources_refreshed', target_type: 'topic', target_id: topicId, topic_id: topicId, before: null,
      after: { cards: cardPart ? cardPart.cacheRows.length : null, mehlman: mehl ? (mehl.passages || []).length : null },
      summary: summaryOf(`Sources refreshed for ${src.topic.name}: ${parts.join(', ') || 'checked'}`) }],
  });
  return { ...out, seq: w.seq };
}

// ---------------------------------------------------------------- lesson cards, once a day (LRN4-4)

export const LESSON_CARDS_DAYS = 60, LESSON_CARDS_MAX = 80;
// A card a lesson made was new, with no lapses, when it was made: seen for the first time later, every lapse it has
// came after the lesson, so it counts as a dated lapse (did it stick), never as a lapse from before the hub knew it.
const MADE_NEW = { schedule: 'new', lapses: 0 };
const DAY_MS = 86_400_000;

/**
 * The cards recent lessons made, read once a night. "Did it stick" rests on the lesson's own card first (overnight
 * decision 3a), but a landed topic is out of "teach me" and its panel may never be opened, so nothing else reads
 * its card. One check_deck call finds each card by its own case's words (else its topic's); its state and lapses
 * become evidence on its strong topics (cardEvidence, as a panel refresh writes it), so a lapse lifts the landed
 * lesson's E2 and counts for "did it stick". Returns {cards, found, evidence}.
 */
export async function refreshLessonCards(env, user, { now = Date.now(), timeoutMs = 20_000 } = {}) {
  if (!env.ANKI_MCP_URL) return { cards: 0, skipped: 'Anki is not connected' };
  let rows;
  try {
    rows = (await env.DB.prepare(`SELECT l.card_id, max(l.ended_at) AS at, max(l.topic_id) AS topic_id, max(l.card_action = 'added') AS made, c.question, t.name, t.short_name FROM lessons l
        LEFT JOIN card_cache c ON c.user_id = l.user_id AND c.card_id = l.card_id AND c.deleted_at IS NULL
        LEFT JOIN topics t ON t.user_id = l.user_id AND t.id = l.topic_id
        WHERE l.user_id = ? AND l.status = 'done' AND l.card_id IS NOT NULL AND l.ended_at >= ? AND l.card_action IN ('added','edited_existing')
        GROUP BY l.card_id ORDER BY at DESC LIMIT ?`).bind(user, now - LESSON_CARDS_DAYS * DAY_MS, LESSON_CARDS_MAX).all()).results || [];
  } catch (e) { if (noTable(e)) return { cards: 0 }; throw e; }
  if (!rows.length) return { cards: 0 };
  // Each card is found by its own case's words when the hub has read it before, else by its topic's names
  // (abbreviations first, as cards say them).
  const al = (await env.DB.prepare(`SELECT topic_id, alias, kind FROM topic_aliases WHERE user_id = ? AND status = 'active' AND kind NOT IN ('typo','truncated')
      AND topic_id IN (SELECT value FROM json_each(?)) ORDER BY kind = 'abbrev' DESC, length(alias) LIMIT 400`)
    .bind(user, JSON.stringify([...new Set(rows.map(r => r.topic_id).filter(Boolean))])).all()).results || [];
  const aliasesOf = id => al.filter(a => a.topic_id === id).slice(0, 8);
  const want = rows.map(r => ({ card_id: Number(r.card_id), topic_id: r.topic_id, name: r.name, made: !!Number(r.made),
    searches: [...new Set([r.question ? cardKey(r.question) : null, ...cardSearches({ name: r.name, short_name: r.short_name, aliases: aliasesOf(r.topic_id) })].filter(Boolean))].slice(0, 4) }))
    .filter(w => Number.isSafeInteger(w.card_id) && w.searches.length);
  if (!want.length) return { cards: 0 };
  const deck = await deckFor(env, user);
  let reply;
  try {
    reply = await ankiCall(env, 'check_deck', { deck, limit: CHECK_LIMIT, topics: want.map(w => ({ key: String(w.card_id), searches: w.searches })) }, { timeoutMs });
  } catch (e) {
    console.error(JSON.stringify({ lesson_cards_unreachable: { user, error: (e && e.message) || String(e) } }));
    return { cards: want.length, found: 0, error: 'unreachable' };
  }
  const found = [];
  for (const w of want) {
    const t = ((reply && reply.topics) || []).find(x => x && String(x.key) === String(w.card_id));
    const c = ((t && t.cards) || []).map(cardFields).find(x => x && x.card_id === w.card_id);
    if (c) found.push({ ...c, topic_id: w.topic_id, name: w.name, made: w.made });
  }
  if (!found.length) return { cards: want.length, found: 0, evidence: 0 };
  const day = londonDay(now);
  const held = await readCards(env, user, found.map(c => c.card_id), day);
  const cacheRows = [], evidence = [], topics = new Map();
  for (const c of found) {
    const prev = held.cache.get(c.card_id) || null;
    const sameQ = prev && prev.question === c.question;
    cacheRows.push({ card_id: c.card_id, note_id: c.note_id ?? (prev && prev.note_id) ?? null, deck: c.deck || deck, question: c.question,
      answer: prev && Number(prev.full) && sameQ ? prev.answer : c.answer, full: prev && Number(prev.full) && sameQ ? 1 : 0,
      schedule: c.schedule, lapses: c.lapses, image_count: c.image_count, fetched_at: now });
    const strong = [...new Set([...(held.strong.get(c.card_id) || []), ...(c.topic_id ? [c.topic_id] : [])])].slice(0, MAX_TOPICS_PER_CARD);
    const next = { card_id: c.card_id, note_id: c.note_id ?? (prev && prev.note_id) ?? null, schedule: c.schedule, lapses: c.lapses };
    const cardRows = [];
    for (const t of strong) {
      const hasState = held.evidence.some(e => e.obs_key === `cardstate:${c.card_id}` && e.topic_id === t);
      cardRows.push(...cardEvidence(prev && hasState ? { schedule: prev.schedule, lapses: prev.lapses } : c.made ? MADE_NEW : null, next, { topic_ids: [t], at: now, day, source: 'card' }));
    }
    const placed = placeCardRows(cardRows, held.evidence);
    evidence.push(...placed);
    for (const r of placed) if (!topics.has(r.topic_id)) topics.set(r.topic_id, { lapse: false, name: r.topic_id === c.topic_id ? c.name : null });
    for (const r of placed) if (r.kind === 'card_lapse') topics.get(r.topic_id).lapse = true;
  }
  const statements = cacheStatements(env, user, cacheRows);
  if (!evidence.length) { if (statements.length) await env.DB.batch(statements); return { cards: want.length, found: found.length, evidence: 0 }; }
  const w = await writeBatch(env, user, {
    actor: 'code', surface: 'code', via: 'cron:lesson_cards', undoable: false, statements, evidence: { upsert: evidence },
    events: [...topics.entries()].slice(0, 20).map(([topicId, x]) => ({ kind: 'topic.sources_refreshed', target_type: 'topic', target_id: topicId, topic_id: topicId,
      before: null, after: { lesson_card: true }, summary: summaryOf(`Lesson card checked${x.name ? ` for ${x.name}` : ''}${x.lapse ? ': a lapse counted' : ''}`) })),
  });
  return { cards: want.length, found: found.length, evidence: evidence.length, seq: w && w.seq };
}

// ---------------------------------------------------------------- one card in full

/**
 * One cached card, read in full from Anki when the cache holds only check_deck's cut-down answer (or is more
 * than a day old). find_cards searches the case's own words, because "cid:" searches do not work on the server.
 * Answers from the cache when Anki cannot be reached. null when the hub has never seen the card.
 */
export async function cardDetail(env, user, cardId, { now = Date.now(), timeoutMs = CARD_TIMEOUT_MS } = {}) {
  const row = await env.DB.prepare(`SELECT c.card_id, c.note_id, c.deck, c.question, c.answer, c.vs, c.notes, c.schedule, c.lapses, c.image_count, c.images_json,
      c.full, c.fetched_at,
      (SELECT m.label FROM misses_live m, json_each(m.anki_note_ids_json) j WHERE m.user_id = c.user_id
         AND (j.value = c.note_id OR (c.card_id - j.value) BETWEEN 1 AND ${NOTE_GAP_MAX}) ORDER BY m.at DESC LIMIT 1) AS made_after
    FROM card_cache c WHERE c.user_id = ? AND c.card_id = ? AND c.deleted_at IS NULL`).bind(user, cardId).first();
  if (!row) return null;
  let card = row, fresh = !!Number(row.full) && now - row.fetched_at < CARD_FULL_MS, source = 'cache';
  if (!fresh && env.ANKI_MCP_URL && row.question) {
    try {
      const r = await ankiCall(env, 'find_cards', { text: cardKey(row.question), deck: row.deck || MY_DECK }, { timeoutMs });
      const hit = ((r && r.cards) || []).map(cardFields).find(c => c && c.card_id === Number(cardId));
      if (hit) {
        card = { ...row, ...Object.fromEntries(Object.entries(hit).filter(([, v]) => v != null)), images_json: JSON.stringify(hit.images || parse(row.images_json, [])) };
        fresh = true;
        source = 'anki';
        await env.DB.prepare(`UPDATE card_cache SET question = ?3, answer = ?4, vs = ?5, notes = ?6, schedule = coalesce(?7, schedule), lapses = coalesce(?8, lapses),
            image_count = coalesce(?9, image_count), images_json = ?10, note_id = coalesce(note_id, ?11), full = 1, fetched_at = ?12
          WHERE user_id = ?1 AND card_id = ?2`)
          .bind(user, cardId, card.question, card.answer, card.vs, card.notes, hit.schedule, hit.lapses, hit.image_count, card.images_json, hit.note_id, now).run();
      }
    } catch (e) {
      console.error('card read failed', e && e.message);
    }
  }
  const { why, notes } = splitNotes(card.notes);
  return {
    card_id: Number(card.card_id), deck: card.deck || MY_DECK, question: card.question, answer: card.answer, vs: card.vs || null, why, notes,
    schedule: card.schedule || null, lapses: Number(card.lapses) || 0, image_count: Number(card.image_count) || 0, images: parse(card.images_json, []) || [],
    made_after: card.made_after || null, full: fresh, source, fetched_at: source === 'anki' ? now : card.fetched_at,
  };
}

// ---------------------------------------------------------------- "Not about this topic" (op card_topic.unlink)

const UNLINK_KEYS = ['cardstate:', 'cardlapses:', 'card:'];
const CARD_KINDS = ['card_new', 'card_young', 'card_mature', 'card_suspended', 'card_lapse'];

export async function planCardUnlink(env, user, args, ctx) {
  for (const k of Object.keys(args || {})) if (!['topic_id', 'card_id', 'reason'].includes(k)) return { refuse: `Unknown argument ${k}.` };
  const topicId = typeof args.topic_id === 'string' ? args.topic_id.trim() : '';
  const cardId = intOf(args.card_id);
  if (!topicId || topicId.length > 120) return { refuse: 'topic_id is the topic the card should leave.' };
  if (!cardId || cardId <= 0) return { refuse: 'card_id is the card number.' };
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [ct, t, ev] = await env.DB.batch([
    q(`SELECT card_id, topic_id, match, strong, removed_at, removed_by FROM card_topics WHERE user_id = ? AND card_id = ? AND topic_id = ?`, user, cardId, topicId),
    q(`SELECT name FROM topics WHERE user_id = ? AND id = ?`, user, topicId),
    q(`SELECT obs_key, slot, kind FROM evidence WHERE user_id = ? AND card_id = ? AND topic_id = ?`, user, cardId, topicId),
  ]);
  const link = (ct.results || [])[0];
  if (!link) return { refuse: 'That card is not linked to this topic.' };
  if (link.removed_at != null) return { noop: true, summary: 'That card is already off this topic.' };
  const name = ((t.results || [])[0] || {}).name || topicId;
  const remove = (ev.results || []).filter(e => CARD_KINDS.includes(e.kind) && UNLINK_KEYS.some(p => e.obs_key.startsWith(p)))
    .map(e => ({ obs_key: e.obs_key, slot: Number(e.slot) || 0 }));
  const summary = summaryOf(`Card ${cardId} is no longer counted for ${name}`);
  return {
    rows: [{ table: 'card_topics', op: 'update', key: { card_id: cardId, topic_id: topicId }, before: { removed_at: null, removed_by: null },
      after: { removed_at: ctx.now, removed_by: ctx.actor } }],
    events: [{ target_type: 'card_topic', target_id: `${cardId}:${topicId}`, topic_id: topicId, summary }],
    touched_topics: [topicId], cardEvidence: remove, summary, reply: { card_id: cardId, topic_id: topicId, evidence_removed: remove.length },
  };
}

// Written here rather than by applyChange's default path because the card's evidence is removed slot by slot
// (another topic's row under the same key stays); the rows and events were checked by guard.js as usual.
export async function applyCardUnlink(env, user, plan, ctx) {
  const w = await writeBatch(env, user, {
    batch_id: ctx.batch_id, actor: ctx.actor, surface: ctx.surface, via: ctx.via, mo_said: ctx.mo_said, request_id: ctx.request_id,
    rows: plan.rows, events: plan.events.map(e => ({ kind: 'card.unlinked', undoable: true, ...e })),
    evidence: plan.cardEvidence.length ? { remove: plan.cardEvidence } : undefined, recompute: plan.touched_topics, undoable: true,
  });
  return { ok: true, batch_id: w.batch_id, seq: w.seq, undo_hint: UNDO_HINT, ...(w.scores ? { scores: w.scores } : {}), ...(plan.reply || {}) };
}

// PATCH /api/map/topic/:id/cards/:card_id {removed: true}
export async function unlinkRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  if (body.removed !== true) return json({ error: 'Send {removed: true} to take the card off this topic (Undo puts it back).' }, 400);
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'card_topic.unlink',
    args: { topic_id: params.id, card_id: Number(params.card_id) }, via: 'api:PATCH /api/map/topic/:id/cards/:card_id' }));
}

// ---------------------------------------------------------------- resources seed (op resources.seed)

export const RESOURCE_COLS = ['kind', 'title', 'subject', 'exam', 'pages', 'file_name'];

/** One high_yield_sources entry as a resources row, or null when it is not usable. */
export function resourceRow(s) {
  if (!isObj(s) || typeof s.title !== 'string' || !s.title.trim() || s.title.length > 200) return null;
  const title = s.title.trim();
  const mehlman = /^mehlman\b/i.test(title);
  return {
    id: resourceId(title), kind: mehlman ? 'mehlman_pdf' : 'pdf', title,
    subject: typeof s.subject === 'string' ? s.subject.slice(0, 120) : null, exam: typeof s.exam === 'string' ? s.exam.slice(0, 40) : null,
    pages: intOf(s.pages), file_name: mehlman ? mehlmanFile(title) : null,
  };
}

export async function planResourcesSeed(env, user, args, ctx) {
  const list = Array.isArray(args && args.sources) ? args.sources : null;
  if (!list || !list.length || list.length > 200) return { refuse: 'sources is the list high_yield_sources gives (1 to 200 PDFs).' };
  const want = new Map();
  for (const s of list) { const r = resourceRow(s); if (r && !want.has(r.id)) want.set(r.id, r); }
  if (!want.size) return { refuse: 'None of those sources has a title.' };
  const have = new Map(((await env.DB.prepare(`SELECT id, ${RESOURCE_COLS.join(', ')} FROM resources WHERE user_id = ?`).bind(user).all()).results || []).map(r => [r.id, r]));
  const now = ctx.now;
  const rows = [];
  for (const r of want.values()) {
    const cur = have.get(r.id);
    const vals = Object.fromEntries(RESOURCE_COLS.map(c => [c, r[c]]));
    if (!cur) { rows.push({ table: 'resources', op: 'insert', key: { id: r.id }, before: null, after: { ...vals, text_status: 'none', exam_profile: 'step2', source: 'high_yield_sources', created_by: 'seed', created_at: now, updated_at: now } }); continue; }
    const diff = Object.fromEntries(RESOURCE_COLS.filter(c => cur[c] !== vals[c]).map(c => [c, vals[c]]));
    if (Object.keys(diff).length) rows.push({ table: 'resources', op: 'update', key: { id: r.id }, before: Object.fromEntries(Object.keys(diff).map(c => [c, cur[c]])), after: { ...diff, updated_at: now } });
  }
  if (!rows.length) return { noop: true, summary: `The ${want.size} Mehlman PDFs are already listed.`, reply: { sources: want.size, written: 0 } };
  const summary = `Resources set: ${rows.filter(r => r.op === 'insert').length} new and ${rows.filter(r => r.op === 'update').length} updated of ${want.size} PDFs`;
  return { rows, count: rows.length, summary, events: [{ kind: 'map.resync', target_type: 'map', target_id: 'resources', summary, undoable: false }],
    reply: { sources: want.size, written: rows.length } };
}

// POST /api/map/seed/resources [{sources}] — the sources from the body, or else from high_yield_sources.
export async function seedResourcesRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 200_000);
  let sources = Array.isArray(body.sources) ? body.sources : null;
  if (!sources) {
    if (!env.ANKI_MCP_URL) return json({ error: 'Anki is not connected, so the Mehlman list cannot be read. Send {sources} instead.' }, 503);
    try {
      const r = await ankiCall(env, 'high_yield_sources', {}, { timeoutMs: 15_000 });
      sources = Array.isArray(r && r.sources) ? r.sources : [];
    } catch (e) {
      return json({ error: `The Mehlman list could not be read: ${e.message}` }, 502);
    }
  }
  const r = await applyChange(env, user, { actor: 'code', surface: 'web', op: 'resources.seed', args: { sources }, via: 'api:POST /api/map/seed/resources' });
  if (r.nothing) return json({ ok: true, ...r, written: 0 });
  return changeResponse(r);
}
