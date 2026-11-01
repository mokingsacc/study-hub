import { HttpError, json, readJson, now, londonDay } from './util.js';
import { all, first, run, reserveSpend, spendCap, getSetting } from './db.js';
import { callJson, isPending } from './claude.js';
import { AUDIT_SPECS, auditAndReask, checkItem, reaskText, recordAudit, auditCounts } from './ai-audit.js';
import { buildLeakIndex, leaks, normError, ERROR_TYPES } from './checks.js';
import { gapStatement, mapGaps, hasMapCols, hasSignalCols, hasReviewCol, hasFormCols, saveCues, scrubStems, GAP_MAX, SAID_MAX, TOPIC_MAX, GAP_STEPS, GAP_CONFIDENCE } from './gaps.js';
import { CAUSE_RULES } from '../../public/js/shared/cause.js';
import { coreRules, coreSchema, tidyCore, consideredNotConfused, FORM_VERSIONS } from './answer-core.js';
import { nearNames, withNames, namesToMap } from './map/name-map.js';
import { segmentKey, segmentsDigest } from '../../public/js/cards/speech.js';
import { correctLines, fixesNote } from './asr-fix.js';
import { CONFIDENCE_RULE } from '../../public/js/conf-words.js';
import { noteJob, detailOf } from './job-log.js';
import { isBoilerplate, saidInWindow, windowText } from './map/ingest/map-fields.js';

export const DEVICES = ['mac', 'hub', 'phone', 'voice'];
// open: a session still being recorded (no ended_at yet: the hub's Cards page saves it after every card). It is checked
// once it ends, or once nothing has arrived for OPEN_IDLE_MS (an app closed mid-review).
export const STATUSES = ['open', 'aligned', 'checking', 'checked', 'failed'];
export const CARD_VERDICTS = ['pending', 'sound', 'shaky', 'gap', 'no_speech'];
const MAX_SEGMENTS = 20_000, MAX_EVENTS = 1500, MAX_CARD_TEXT = 1500, MAX_TEXT = 2000;
const BOUNDARY_MS = 1500; // speech just after the next card appears is still about the last one (as in the exam runner)
const IDLE_MS = 180_000; // speech this long after a card's last action belongs to no card
const SOUND_MS = 20_000; // a Good or Easy answer under 20 s with no hedge is settled in code
export const ANKI_DAILY_USD = Infinity;
// The note a session carries while its cards wait for a day with room (the sweep finds them by it).
export const CARRY_NOTE = 'Daily limit for Anki checks';
const OPEN_IDLE_MS = 30 * 60_000;
const BATCH = 40, MAP_NOW = 10, RESERVE_USD = 1, MAX_ATTEMPTS = 8, STALE_MS = 15 * 60_000, KEEP_CARD_TEXT_MS = 7 * 86_400_000;
const READ = '(read the card)';
const HEDGE = /\b(not sure|unsure|no idea|don'?t know|do not know|i guess|guessing|or is it|maybe|can'?t remember|cannot remember|forgot|forget|confus\w*|no clue)\b/i;
const EASE = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ms = v => (Number.isSafeInteger(v) && v > 0 ? v : null);
const wordsIn = s => (String(s || '').trim() ? String(s).trim().split(/\s+/).length : 0);

const GHOST_MS = 10_000;
export function dropGhostEvents(events) {
  const copy = events.map((e, i) => e.ease == null && e.answered != null && events.slice(0, i).some(o => o.card_id === e.card_id && o.answered === e.answered));
  return events.filter((e, i) => {
    if (copy[i]) return false;
    if (e.answered != null || e.ease != null) return true;
    const next = events.slice(i + 1).find(o => o.card_id === e.card_id);
    if (next && next.shown - e.shown <= GHOST_MS) return false;
    return !(i + 1 < events.length && copy[i + 1]);
  });
}

// An Anki Voice event also names its rating's review id (the Anki review log's, the one its gap note carries), so the
// check's gap and that note end as one row, and the tutor's marks per part. Kept only when sent.
const PART_MARKS = ['correct', 'nudged', 'wrong'];
function ratingOf(e) {
  const out = {}, rid = ms(e && e.review_id);
  if (rid) out.review_id = rid;
  if (e && Array.isArray(e.parts) && e.parts.length && e.parts.length <= 6 && e.parts.every(p => PART_MARKS.includes(p))) out.parts = e.parts;
  return out;
}

function cleanSession(b) {
  if (typeof b.id !== 'string' || !/^[\w-]{1,60}$/.test(b.id)) throw new HttpError(400, 'The session needs an id.');
  const device = DEVICES.includes(b.device) ? b.device : null;
  if (!device) throw new HttpError(400, `The session needs its device (${DEVICES.join(', ')}).`);
  const startedAt = ms(b.started_at);
  if (!startedAt) throw new HttpError(400, 'The session needs its start time.');
  const endedAt = b.ended_at == null ? null : ms(b.ended_at);
  if (!Array.isArray(b.segments) || b.segments.length > MAX_SEGMENTS) throw new HttpError(400, 'The transcript is not in the right shape.');
  const segments = b.segments.map(s => {
    const start = num(s && s.start), end = num(s && s.end);
    if (start == null || end == null || typeof s.text !== 'string') throw new HttpError(400, 'The transcript is not in the right shape.');
    return { start: Math.round(start), end: Math.round(Math.max(start, end)), text: s.text.trim().slice(0, MAX_TEXT) };
  }).filter(s => s.text).sort((a, b2) => a.start - b2.start);
  if (!Array.isArray(b.events) || b.events.length > MAX_EVENTS) throw new HttpError(400, `The card events must be a list of at most ${MAX_EVENTS}.`);
  const events = dropGhostEvents(b.events.map(e => ({ card_id: ms(e && e.card_id), note_id: ms(e && e.note_id), shown: ms(e && e.shown),
    revealed: ms(e && e.revealed), answered: ms(e && e.answered), ease: [1, 2, 3, 4].includes(e && e.ease) ? e.ease : null, ...ratingOf(e) }))
    .filter(e => e.card_id && e.shown).sort((a, b2) => a.shown - b2.shown));
  const cards = {};
  const given = b.cards && typeof b.cards === 'object' && !Array.isArray(b.cards) ? b.cards : {};
  for (const e of events) {
    const c = given[e.card_id] || given[String(e.card_id)];
    if (!c || typeof c !== 'object') continue;
    const t = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
    cards[e.card_id] = { front: t(c.front, MAX_CARD_TEXT), back: t(c.back, MAX_CARD_TEXT), deck: t(c.deck, 120) || null,
      tags: Array.isArray(c.tags) ? c.tags.filter(x => typeof x === 'string').slice(0, 40).map(x => x.slice(0, 80)) : [] };
  }
  return { id: b.id, device, startedAt, endedAt, segments, events, cards };
}

/**
 * Give each speech segment to a card. events are sorted by shown (epoch ms); segment times are ms from
 * startedAt. A segment belongs to the last card shown at least 1.5 s before it started (the first card takes
 * anything from its own appearance), and goes under before or after by whether its middle came after the reveal.
 * Speech before the first card or over 3 minutes after a card's last action belongs to none.
 * Returns {cards: [{n, card_id, note_id, shown_at, revealed_at, answered_at, ease, before, after}], owner: [n|null per segment]}.
 */
export function align(startedAt, segments, events) {
  const cards = events.map((e, n) => ({ n, card_id: e.card_id, note_id: e.note_id, shown_at: e.shown, revealed_at: e.revealed,
    answered_at: e.answered, ease: e.ease, before: [], after: [] }));
  const owner = segments.map(s => {
    const abs = startedAt + s.start;
    let i = -1;
    for (let k = 0; k < cards.length && cards[k].shown_at <= abs - BOUNDARY_MS; k++) i = k;
    if (i < 0 && cards.length && abs >= cards[0].shown_at) i = 0;
    if (i < 0) return null;
    const c = cards[i];
    if (abs > (c.answered_at || c.revealed_at || c.shown_at) + IDLE_MS) return null;
    const mid = startedAt + (s.start + s.end) / 2;
    (c.revealed_at && mid >= c.revealed_at ? c.after : c.before).push({ t: s.start, text: s.text });
    return i;
  });
  return { cards, owner };
}

// The leak index of each card's text, built once and only when asked for.
function cardIndexes(events, texts) {
  const cache = new Map();
  return n => {
    const e = events[n];
    if (!e) return null;
    if (!cache.has(n)) {
      const t = texts[e.card_id] || texts[String(e.card_id)];
      cache.set(n, t ? buildLeakIndex({ stem: t.front, expl: t.back }) : null);
    }
    return cache.get(n);
  };
}

export function scrubSegments(startedAt, segments, events, texts, owner) {
  const indexOf = cardIndexes(events, texts || {});
  return segments.map((s, i) => {
    let n = owner[i];
    if (n == null) {
      const abs = startedAt + s.start;
      n = -1;
      for (let k = 0; k < events.length && events[k].shown <= abs; k++) n = k;
    }
    const idx = [indexOf(n), indexOf(n + 1)].filter(Boolean);
    if (!idx.length) return s;
    const parts = s.text.split(/(?<=[.!?])\s+/).map(x => (idx.some(ix => leaks(ix, x)) ? READ : x));
    return { ...s, text: parts.filter((x, k) => !(x === READ && parts[k - 1] === READ)).join(' ') };
  });
}

const spokenWords = card => [...card.before, ...card.after].reduce((n, p) => n + wordsIn(p.text.split(READ).join(' ').split('(read the question)').join(' ')), 0);

/** The plain cases, settled in code: nothing said, or a quick Good/Easy with no hedge. Otherwise pending. */
export function settle(card) {
  const words = spokenWords(card);
  if (!words) return 'no_speech';
  const spoken = [...card.before, ...card.after].map(p => p.text).join(' ');
  const took = card.answered_at && card.shown_at ? card.answered_at - card.shown_at : null;
  if (card.ease >= 3 && !HEDGE.test(spoken) && took != null && took < SOUND_MS) return 'sound';
  return 'pending';
}

// The acknowledgement of a PUT (AUD-024): how many of the segments sent the hub now holds, and their digest. The Cards
// page deletes a clip's audio only when this covers everything it sent (public/js/cards/speech.js acknowledged).
function acceptedOf(sent, held) {
  const keys = new Set(held.map(segmentKey));
  return segmentsDigest(sent.filter(x => keys.has(segmentKey(x))));
}

const cueOnCard = (cue, where) => where.card_id != null || !!cue.topic;

export const ECHO_SHARE = 0.5, ECHO_MIN_RUNS = 30;
export function echoShare(sessionSegs, blockSegs) {
  const plain = list => scrubStems(list).map(x => String(x.text || '').split('(read the question)').join(' ')).join(' ');
  const index = buildLeakIndex({ stem: plain(blockSegs) });
  const w = plain(sessionSegs).split(/\s+/).filter(Boolean);
  let runs = 0, shared = 0;
  // leaks() reads one run at a time (6 words: checks.js RUN), so each window is checked on its own.
  for (let i = 0; i + 6 <= w.length; i++) { runs++; if (leaks(index, w.slice(i, i + 6).join(' '))) shared++; }
  return { runs, shared, share: runs ? shared / runs : 0 };
}

async function refuseEcho(env, s, cur) {
  const last = s.segments.length ? s.segments[s.segments.length - 1].end : 0;
  const end = s.endedAt ?? s.startedAt + last;
  let blocks = [];
  try {
    blocks = await all(env, `SELECT id, segments_json FROM uworld_blocks WHERE created_at >= ? AND day IN (?, ?) ORDER BY created_at DESC LIMIT 6`,
      s.startedAt, londonDay(s.startedAt), londonDay(s.startedAt - 86_400_000));
  } catch (e) { if (/no such table/i.test(String(e && e.message))) return; throw e; }
  for (const b of blocks) {
    if (/^\d{12,14}$/.test(b.id) && Number(b.id) > end) continue;   // begun after this session ended
    const o = echoShare(s.segments, JSON.parse(b.segments_json || '[]'));
    if (o.shared < ECHO_MIN_RUNS || o.share <= ECHO_SHARE) continue;
    // A copy not checked yet goes, with its cards and cues: the block holds these words.
    if (cur && (cur.status === 'open' || cur.status === 'aligned')) {
      await saveCues(env, [], `anki:${s.id}`, () => ({}));
      await env.DB.batch([env.DB.prepare('DELETE FROM anki_cards WHERE session_id = ?').bind(s.id), env.DB.prepare('DELETE FROM anki_sessions WHERE id = ?').bind(s.id)]);
    }
    await noteJob(env, { job: 'anki_echo', key: s.id, ref: s.device, state: 'held', counts: { share: Math.round(o.share * 100) } });   // Recent activity says why
    throw new HttpError(409, `The UWorld recorder was on: ${Math.round(o.share * 100)}% of this review's words are UWorld block ${b.id}'s, so it is not saved as an Anki review.`);
  }
}

// PUT /api/anki-sessions {id, device, started_at, ended_at, segments, events, cards}: save one review session.
// Replies {saved, id, cards, to_check, words, cues, accepted: {segments, digest}}.
export async function put(request, env) {
  const body = await readJson(request, 4_000_000);
  let s;
  try { s = cleanSession(body); } catch (e) {
    // An Anki Voice session the hub cannot take is dropped by its server (a 400 is final), so Recent activity says so.
    if (body && body.device === 'voice') {
      await noteJob(env, { job: 'anki_check', key: `${/^[\w-]{1,60}$/.test(String(body.id)) ? body.id : londonDay()}:received`, ref: 'voice', state: 'failed',
        counts: { received: 0 }, detail: detailOf(e) });
    }
    throw e;
  }
  const cur = await first(env, 'SELECT status, ended_at, segments_json, events_json FROM anki_sessions WHERE id = ?', s.id);
  await refuseEcho(env, s, cur);
  if (cur && (cur.status === 'checked' || cur.status === 'checking')) return late(env, s, cur);
  const carded = scrubSegments(s.startedAt, s.segments, s.events, s.cards, align(s.startedAt, s.segments, s.events).owner);
  const segments = scrubStems(carded);
  const { cards, owner } = align(s.startedAt, segments, s.events);
  const rows = cards.map(c => ({ ...c, words: spokenWords(c), verdict: settle(c), deck: s.cards[c.card_id]?.deck || null, tags: s.cards[c.card_id]?.tags || [] }));
  const pending = rows.filter(r => r.verdict === 'pending').length;
  const words = s.segments.reduce((n, x) => n + wordsIn(x.text), 0);
  const t = now();
  const status = s.endedAt == null ? 'open' : pending ? 'aligned' : 'checked';
  const stmts = [
    env.DB.prepare(`INSERT INTO anki_sessions (id, device, day, started_at, ended_at, segments_json, events_json, cards_json, words, status, attempts, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, segments_json = excluded.segments_json, events_json = excluded.events_json,
        cards_json = excluded.cards_json, words = excluded.words, status = excluded.status, attempts = 0, last_error = NULL, updated_at = excluded.updated_at`)
      .bind(s.id, s.device, londonDay(s.startedAt), s.startedAt, s.endedAt, JSON.stringify(segments), JSON.stringify(s.events),
        pending ? JSON.stringify(s.cards) : null, words, status, t, t),
    env.DB.prepare('DELETE FROM anki_cards WHERE session_id = ?').bind(s.id),
    ...rows.map(r => env.DB.prepare(`INSERT INTO anki_cards (session_id, n, card_id, note_id, deck, tags, shown_at, revealed_at, answered_at, ease,
        before_json, after_json, words, verdict, checked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(s.id, r.n, r.card_id, r.note_id, r.deck, JSON.stringify(r.tags), r.shown_at, r.revealed_at, r.answered_at, r.ease,
        JSON.stringify(r.before), JSON.stringify(r.after), r.words, r.verdict, r.verdict === 'pending' ? null : 'code')),
  ];
  await env.DB.batch(stmts);
  // "Gap, I don't get ..." said during the review: tied to the card on screen (from the card-scrubbed speech).
  const cues = await saveCues(env, carded, `anki:${s.id}`, (seg, i) => {
    const c = owner[i] != null ? cards[owner[i]] : null;
    return { ref: `anki:${s.id}`, card_id: c ? c.card_id : null, note_id: c ? c.note_id : null, at: s.startedAt + seg.start };
  }, { keep: cueOnCard });
  // An Anki Voice review arrives whole, from its server: Recent activity shows it came, and its check line follows.
  if (s.device === 'voice') await noteJob(env, { job: 'anki_check', key: `${s.id}:received`, ref: s.device, state: 'ok', counts: { received: rows.length, to_check: pending } });
  return json({ saved: true, id: s.id, cards: rows.length, to_check: pending, words, cues, accepted: acceptedOf(s.segments, segments) });
}

async function late(env, s, cur) {
  const held = JSON.parse(cur.segments_json || '[]');
  const heldKeys = new Set(held.map(segmentKey));
  const stored = JSON.parse(cur.events_json || '[]');
  const evKey = e => `${e.card_id}:${e.shown}`;
  const storedKeys = new Set(stored.map(evKey));
  const newSegs = s.segments.filter(x => !heldKeys.has(segmentKey(x)));
  const newEvents = s.events.filter(e => !storedKeys.has(evKey(e)));
  const fresh = newSegs.length > 0 || newEvents.length > 0;
  if (!fresh || cur.status === 'checking') return json({ saved: !fresh, already: true, ...(fresh ? { busy: true } : {}), id: s.id, accepted: acceptedOf(s.segments, held) });
  const events = [...stored, ...newEvents].sort((a, b) => a.shown - b.shown);
  // Only the new segments are aligned: the speech the first check judged stays with the cards it was given to.
  const carded = scrubSegments(s.startedAt, newSegs, events, s.cards, align(s.startedAt, newSegs, events).owner);
  const segs = scrubStems(carded);
  const { cards, owner } = align(s.startedAt, segs, events);
  const rows = await all(env, 'SELECT n, card_id, shown_at, answered_at, ease, before_json, after_json, verdict, checked_by FROM anki_cards WHERE session_id = ?', s.id);
  const byKey = new Map(rows.map(r => [`${r.card_id}:${r.shown_at}`, r]));
  const verdicts = new Map(rows.map(r => [r.n, r.verdict]));
  let nextN = rows.reduce((m, r) => Math.max(m, r.n + 1), 0);
  const stmts = [];
  for (const c of cards) {
    const old = byKey.get(`${c.card_id}:${c.shown_at}`);
    if (!old) {
      const n = nextN++, verdict = settle(c);
      verdicts.set(n, verdict);
      const t = s.cards[c.card_id] || {};
      stmts.push(env.DB.prepare(`INSERT INTO anki_cards (session_id, n, card_id, note_id, deck, tags, shown_at, revealed_at, answered_at, ease,
          before_json, after_json, words, verdict, checked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(s.id, n, c.card_id, c.note_id, t.deck || null, JSON.stringify(t.tags || []), c.shown_at, c.revealed_at, c.answered_at, c.ease,
          JSON.stringify(c.before), JSON.stringify(c.after), spokenWords(c), verdict, verdict === 'pending' ? null : 'code'));
      continue;
    }
    if (!c.before.length && !c.after.length) continue;
    const byT = (a, b) => a.t - b.t;
    const merged = { ...c, ease: old.ease, answered_at: old.answered_at,
      before: [...JSON.parse(old.before_json || '[]'), ...c.before].sort(byT), after: [...JSON.parse(old.after_json || '[]'), ...c.after].sort(byT) };
    const words = spokenWords(merged), again = settle(merged);
    // Judged already (a gap or shaky with its gaps row, or Claude's own sound) and still not pending: only the words are added.
    if (['shaky', 'gap'].includes(old.verdict) || (old.checked_by === 'api' && again !== 'pending')) {
      stmts.push(env.DB.prepare('UPDATE anki_cards SET before_json = ?, after_json = ?, words = ? WHERE session_id = ? AND n = ?')
        .bind(JSON.stringify(merged.before), JSON.stringify(merged.after), words, s.id, old.n));
      continue;
    }
    verdicts.set(old.n, again);
    stmts.push(env.DB.prepare(`UPDATE anki_cards SET before_json = ?, after_json = ?, words = ?, verdict = ?, error_type = NULL, gap = NULL, said = NULL,
        checked_by = ? WHERE session_id = ? AND n = ?`)
      .bind(JSON.stringify(merged.before), JSON.stringify(merged.after), words, again, again === 'pending' ? null : 'code', s.id, old.n));
  }
  const pending = [...verdicts.values()].filter(v => v === 'pending').length;
  const endedAt = s.endedAt ?? cur.ended_at ?? null;
  const status = endedAt == null ? 'open' : pending ? 'aligned' : 'checked';
  const kept = [...held, ...segs].sort((a, b) => a.start - b.start);
  const words = newSegs.reduce((n, x) => n + wordsIn(x.text), 0);
  stmts.push(env.DB.prepare(`UPDATE anki_sessions SET ended_at = ?, segments_json = ?, events_json = ?, cards_json = ?, words = words + ?, status = ?,
      attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?`)
    .bind(endedAt, JSON.stringify(kept), JSON.stringify(events), pending ? JSON.stringify(s.cards) : null, words, status, now(), s.id));
  await env.DB.batch(stmts);
  const cues = segs.length ? await saveCues(env, carded, `anki:${s.id}@${segs[0].start}`, (seg, i) => {
    const c = owner[i] != null ? cards[owner[i]] : null;
    return { ref: `anki:${s.id}`, card_id: c ? c.card_id : null, note_id: c ? c.note_id : null, at: s.startedAt + seg.start };
  }, { keep: cueOnCard }) : 0;
  return json({ saved: true, merged: true, id: s.id, cards: newEvents.length, to_check: pending, words, cues, accepted: acceptedOf(s.segments, kept) });
}

export const ANKI_SYSTEM = `You check Mo's spoken reasoning while he reviewed his own Anki flashcards for USMLE Step 2 CK (US guidelines). Mo is a learner sitting the exam on exam day. For each card you get its front and back, his rating (Again, Hard, Good or Easy), how long he took, and what he said aloud before the answer was shown (his recall) and after it (his reaction), transcribed by Whisper: expect misheard medical words. "(read the card)" marks where he read the card aloud, "(read the question)" where he read out something else's question (left out).
Decide for each card:
- gap: he did not know it, recalled it wrongly, or mixed it up with a look-alike.
- shaky: right in the end but unsure, slow, torn between options, or right for a wrong reason.
- sound: he knew it, with sound reasoning.
Judge from what he said, with the rating as support: Again with nothing useful said is a gap; Good with a clear right answer is sound even if slow, unless he hedged.
For gap and shaky give: error_type from the list (knowledge gap when he simply did not know it; faulty synthesis when he had the facts but put them together wrongly; premature closure only when his words show he knew the deciding fact and he still stopped at the first answer that fitted, never because the fact is basic (would knowing one more fact have saved him? then it is knowledge gap; when borderline, knowledge gap); misread when he misread the card; threshold or number for a wrong cut-off, dose or number); gap: one plain line in your own words naming exactly what he does not hold, for example "Mixes up first-line treatment of absence seizures (ethosuximide) with valproate", under ${GAP_MAX} characters; said: his own words that show it, shortened, under ${SAID_MAX} characters.
For gap and shaky also give:
- cause, cause_quote, cause_inferred, cause_detail: why he missed it, by the cause rules below (a card's words count as the case).
- mixed_with: the one look-alike he confused it with or could not tell it from, named as an AMBOSS article would name it (singular, no "vs"), only when the cause is confusion: his words show a real mix-up (for example he said exposure therapy for panic disorder: specific phobia); else null.
- step: the one step that broke, from recognise (did not know what it is from the findings), distinguish (could not tell it from a look-alike), test (wrong or missing workup or next test), treat (wrong or missing management), trap (a classic exception, threshold or contraindication).
For every card give topic: the one condition as an AMBOSS article would name it, under ${TOPIC_MAX} characters, and ${CONFIDENCE_RULE} (not_said where that says null). For sound cards, error_type, gap, said, mixed_with, step and cause are null (cause_quote and cause_detail empty, cause_inferred true).
Never copy the card's own text into gap or said: they must be your words and his words.

${CAUSE_RULES}

${coreRules({ skip: ['concept'] })}`;

const nul = schema => ({ anyOf: [schema, { type: 'null' }] });
// The answer forms' shared core (answer-core.js) beside the check's own fields; a card names no concept (one fact a card).
const ANKI_CORE = coreSchema({ skip: ['concept'] });
export const ANKI_SCHEMA = {
  type: 'object',
  properties: { cards: { type: 'array', items: { type: 'object', properties: {
    n: { type: 'integer' }, verdict: { type: 'string', enum: ['sound', 'shaky', 'gap'] }, error_type: nul({ type: 'string', enum: ERROR_TYPES }),
    gap: nul({ type: 'string' }), said: nul({ type: 'string' }), topic: nul({ type: 'string' }), mixed_with: nul({ type: 'string' }),
    ...ANKI_CORE.props,
  }, required: ['n', 'verdict', 'error_type', 'gap', 'said', 'topic', 'mixed_with', ...ANKI_CORE.fields], additionalProperties: false } } },
  required: ['cards'],
  additionalProperties: false,
};

const mss = t => `${Math.floor(t / 60000)}:${String(Math.floor((t % 60000) / 1000)).padStart(2, '0')}`;
const speech = list => (list.length ? list.map(p => `[${mss(p.t)}] ${p.text}`).join(' ') : '(nothing)');

export function cardMessage(row, text) {
  const took = row.answered_at && row.shown_at ? Math.round((row.answered_at - row.shown_at) / 1000) : null;
  const before = JSON.parse(row.before_json || '[]'), after = JSON.parse(row.after_json || '[]');
  return [`Card ${row.n}: rated ${EASE[row.ease] || 'not rated'}${took != null ? `, ${took} s` : ''}${row.revealed_at && row.shown_at ? `, answer shown after ${Math.round((row.revealed_at - row.shown_at) / 1000)} s` : ''}${row.deck ? `, deck ${row.deck}` : ''}.`,
    `Front: ${text ? text.front || '(empty)' : '(not available)'}`, `Back: ${text ? text.back || '(empty)' : '(not available)'}`,
    `Mo before the answer: ${speech(before)}`, `Mo after the answer: ${speech(after)}`].join('\n');
}

const fit = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null);

/**
 * A batch's spoken words through the spelling check: the rows again with before_json and after_json fixed (for the
 * check's message only; the stored words stay as heard) and each row's fixes. Returns {rows, usd}.
 */
export async function spelledBatch(env, batch, { reserved = false } = {}) {
  const lines = [];
  const parsed = batch.map(r => ({ before: JSON.parse(r.before_json || '[]'), after: JSON.parse(r.after_json || '[]') }));
  parsed.forEach((p, k) => ['before', 'after'].forEach(side => p[side].forEach((s, j) => {
    if (String(s.text || '').replace(/\(read the (?:card|question)\)/g, '').trim()) lines.push({ k, side, j, text: s.text });
  })));
  const r = await correctLines(env, lines, { reserved });
  const fixes = batch.map(() => []);
  for (const l of r.lines) {
    if (!l.fixes.length) continue;
    parsed[l.k][l.side][l.j] = { ...parsed[l.k][l.side][l.j], text: l.text };
    fixes[l.k].push(...l.fixes);
  }
  return { usd: r.usd, fixes: r.fixes.length, skipped: r.skipped || null, rows: batch.map((row, k) => fixes[k].length
    ? { ...row, before_json: JSON.stringify(parsed[k].before), after_json: JSON.stringify(parsed[k].after), fixes: fixes[k] } : { ...row, fixes: [] }) };
}

// The day's Anki-check spend, added in the same statement (two checks at once never lose a cent).
const spendStatement = (env, key, usd) => env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = CAST(COALESCE(CAST(settings.value AS REAL), 0) + CAST(excluded.value AS REAL) AS TEXT)`).bind(key, String(Number(usd) || 0));

export const checkSource = device => ({ mac: 'anki_mac', hub: 'anki_hub', phone: 'anki_phone', voice: 'anki_voice_check' })[device] || 'anki_mac';

export const VOICE_NOTE = 'These cards were reviewed by voice with the Anki Voice tutor, which read each card aloud and rated it from how he answered. His words are the voice app\'s transcript of his answer to each card (not Whisper); nothing after the answer is recorded.';

/** An Anki Voice session's review id per card showing (`card_id:shown` -> review id), from its stored events. */
export function reviewIdsOf(session) {
  const out = new Map();
  let events = [];
  try { events = JSON.parse((session && session.events_json) || '[]'); } catch { events = []; }
  for (const e of Array.isArray(events) ? events : []) if (e && e.review_id) out.set(`${e.card_id}:${e.shown}`, Number(e.review_id));
  return out;
}

// How far apart the Anki Voice server's note and the hub check's gap on the same rating can be (the rating's time and
// the card's answer time differ by the network and the page's clock).
export const VOICE_TWIN_MS = 120_000;

// The card's speech parts ({t, text}: ms from the session start), from its stored row or its aligned card.
const partsOf = r => { const p = v => { try { return Array.isArray(v) ? v : JSON.parse(v || '[]'); } catch { return []; } }; return [...p(r.before ?? r.before_json), ...p(r.after ?? r.after_json)]; };
export function saidFits(said, r, session) {
  if (isBoilerplate(said)) return false;
  if (!r || r.shown_at == null || !session || session.started_at == null) return true;
  return saidInWindow(said, windowText(partsOf(r), r, session.started_at));
}

/**
 * One batch of Claude's verdicts as statements: each card's check and, for shaky or missed cards, its gaps row.
 * Returns {statements, gaps (rows for the map), checked}.
 */
export function verdictStatements(env, id, session, batch, data, texts, { map = false, signals = false, review = false, forms = false } = {}) {
  const byN = new Map((data && Array.isArray(data.cards) ? data.cards : []).map(c => [c.n, c]));
  const rids = reviewIdsOf(session);
  const statements = [], gaps = [], beliefs = [];
  let checked = 0;
  for (const r of batch) {
    const c = byN.get(r.n);
    if (!c || !['sound', 'shaky', 'gap'].includes(c.verdict)) continue; // left pending for the next try
    const text = texts[r.card_id];
    const index = text ? buildLeakIndex({ stem: text.front, expl: text.back }) : new Set();
    const topic = fit(c.topic, TOPIC_MAX);
    if (c.verdict !== 'sound' && r.ease == null) {
      statements.push(env.DB.prepare(`UPDATE anki_cards SET verdict = 'no_speech', error_type = NULL, gap = NULL, said = NULL, topic = ?, checked_by = 'api' WHERE session_id = ? AND n = ?`)
        .bind(topic, id, r.n));
      checked++;
      continue;
    }
    const flagged = c.verdict !== 'sound';
    const safeText = v => (v && !leaks(index, v) ? v : null);
    const core = tidyCore(c, { flagged, own: [topic], safe: safeText });
    let said = flagged ? fit(c.said, SAID_MAX) : null;
    if (said && leaks(index, said)) said = null;
    if (said && !saidFits(said, r, session)) said = null;
    let gap = flagged ? fit(c.gap, GAP_MAX) : null;
    if (gap && leaks(index, gap)) gap = null;
    if (flagged && !gap) gap = topic ? `Did not hold ${topic} on this card.` : 'Did not hold this card.';
    const errorType = flagged ? normError(c.error_type) || 'knowledge gap' : null;
    statements.push(forms
      ? env.DB.prepare(`UPDATE anki_cards SET verdict = ?, error_type = ?, gap = ?, said = ?, topic = ?, cause = ?, heard = ?, form_version = ?, checked_by = 'api' WHERE session_id = ? AND n = ?`)
        .bind(c.verdict, errorType, gap, said, topic, core.cause, core.heard, FORM_VERSIONS.anki_check, id, r.n)
      : env.DB.prepare(`UPDATE anki_cards SET verdict = ?, error_type = ?, gap = ?, said = ?, topic = ?, checked_by = 'api' WHERE session_id = ? AND n = ?`)
        .bind(c.verdict, errorType, gap, said, topic, id, r.n));
    checked++;
    const at = r.answered_at || r.shown_at || session.started_at;
    if (map) core.other_conditions.forEach((o, i) => {
      if (o.kind === 'belief') { if (o.quote && saidFits(o.quote, r, session)) beliefs.push({ topic: o.topic, quote: o.quote, ref: `anki:${id}` }); return; }
      const g = gapStatement(env, { source: checkSource(session.device), gap: `Unsure about ${o.topic}, shown while answering a card${topic ? ` on ${topic}` : ''}.`.slice(0, GAP_MAX),
        said: o.quote && saidFits(o.quote, r, session) ? fit(o.quote, SAID_MAX) : null, topic: fit(o.topic, TOPIC_MAX), ref: `anki:${id}`, verdict: 'shaky',
        ...(forms ? { heard: core.heard, form_version: FORM_VERSIONS.anki_check } : {}) }, { id: `anki:${id}:${r.n}:o${i + 1}`, at, map, signals, forms });
      statements.push(g.statement);
      gaps.push(g.row);
    });
    if (flagged) {
      let mixedWith = fit(c.mixed_with, TOPIC_MAX);
      if (mixedWith && ((topic && mixedWith.toLowerCase() === topic.toLowerCase()) || leaks(index, mixedWith))) mixedWith = null;
      if (core.cause !== 'confusion') mixedWith = null;
      const signal = { mixed_with: mixedWith, step: GAP_STEPS.includes(core.step) ? core.step : null, confidence: GAP_CONFIDENCE.includes(core.confidence) ? core.confidence : null };
      const rid = review ? rids.get(`${r.card_id}:${r.shown_at}`) ?? null : null;
      const formCols = forms ? { cause: core.cause, cause_quote: core.cause_quote && saidFits(core.cause_quote, r, session) ? core.cause_quote : null, cause_inferred: core.cause_inferred,
        cause_detail: core.cause_detail, heard: core.heard, form_version: FORM_VERSIONS.anki_check } : {};
      const g = gapStatement(env, { source: checkSource(session.device), gap, said, topic, ref: `anki:${id}`, card_id: r.card_id, note_id: r.note_id, error_type: errorType, verdict: c.verdict, ...signal,
        ...formCols, ...(rid ? { review_id: rid } : {}) }, { id: `anki:${id}:${r.n}`, at, map, signals, review: !!rid, forms });
      statements.push(g.statement);
      gaps.push(g.row);
      // An Anki Voice rating (wave 2 F): the server's note on the same card and review id, wordless or with the tutor's
      // words, ends in this row: its topic fills an empty one, then it goes. Never its look-alike: a tutor's mixed_with is
      // often the card's Versus line, and a check's counts as a confusion (shared/cause.js gapShowsConfusion).
      if (rid) {
        const same = `SELECT o.topic FROM gaps o WHERE o.source = 'anki_voice' AND o.card_id = ?1 AND o.review_id = ?2 AND o.id <> ?3 AND nullif(o.topic, '') IS NOT NULL LIMIT 1`;
        statements.push(env.DB.prepare(`UPDATE gaps SET topic = coalesce(nullif(topic, ''), (${same})) WHERE id = ?3`).bind(r.card_id, rid, g.row.id));
        // Only a wordless note goes: a gap in the tutor's words stays (the check adds, never takes away; backend audit, 1 Nov 2026).
        statements.push(env.DB.prepare(`DELETE FROM gaps WHERE source = 'anki_voice' AND card_id = ?1 AND review_id = ?2 AND id <> ?3
          AND coalesce(gap, '') = '' AND coalesce(said, '') = ''`).bind(r.card_id, rid, g.row.id));
      }
      const when = Number(r.answered_at || r.shown_at);
      if (map && Number.isFinite(when)) statements.push(env.DB.prepare(`DELETE FROM gaps WHERE source = 'anki_voice' AND card_id = ? AND at BETWEEN ? AND ?
          AND coalesce(gap, '') = '' AND coalesce(said, '') = '' AND id <> ?`).bind(r.card_id, when - VOICE_TWIN_MS, when + VOICE_TWIN_MS, g.row.id));
    }
  }
  return { statements, gaps, checked, beliefs };
}

export async function settleCards(env, data) {
  const cards = (data && Array.isArray(data.cards) ? data.cards : []).filter(Boolean)
    .map(c => (c.verdict !== 'sound' ? consideredNotConfused(c, { words: c.said || '', mixed: [c.mixed_with] }).item : c));
  const others = c => (Array.isArray(c.other_conditions) ? c.other_conditions.filter(Boolean) : []);
  const items = cards.flatMap(c => [...others(c).map(o => ({ name: o.topic, quote: o.quote })), { name: c.mixed_with, quote: c.said }]);
  if (!items.some(i => i.name)) return { ...data, cards };
  const named = await namesToMap(env, 'mo', items);
  let i = 0;
  const next = v => { const n = named[i++]; return v && n && n.name ? n.name : v; };
  return { ...data, cards: cards.map(c => { const o = others(c).map(x => ({ ...x, topic: next(x.topic) })); return { ...c, other_conditions: o, mixed_with: next(c.mixed_with) }; }) };
}

export async function tutorJudged(env, cards) {
  const out = new Map();
  if (!cards.length) return out;
  const rows = await all(env, `SELECT card_id, at, gap, said, topic, error_type, verdict FROM gaps WHERE source = 'anki_voice'
    AND card_id IN (SELECT value FROM json_each(?)) AND coalesce(gap, '') <> ''`, JSON.stringify([...new Set(cards.map(r => r.card_id))]));
  for (const r of cards) {
    const when = Number(r.answered_at || r.shown_at);
    const g = rows.find(x => x.card_id === r.card_id && Number.isFinite(when) && Math.abs(Number(x.at) - when) <= VOICE_TWIN_MS);
    if (g) out.set(r.n, { verdict: g.verdict === 'shaky' ? 'shaky' : 'gap', error_type: g.error_type || 'knowledge gap', gap: g.gap, said: g.said || null, topic: g.topic || null });
  }
  return out;
}

/**
 * Check one session's pending cards. Each Claude batch's results are written in one D1 batch (the card checks,
 * the gaps rows and the day's spend), so a long session stays inside an invocation's query limit, and a failed
 * call's cost still counts toward the day's ANKI_DAILY_USD. Returns {checked, gaps, pending}; throws HttpError
 * 429 at the spend cap.
 */
export async function checkSession(env, id) {
  const t = now();
  const claim = await run(env, `UPDATE anki_sessions SET status = 'checking', updated_at = ? WHERE id = ? AND (status = 'aligned' OR (status = 'checking' AND updated_at < ?)
      OR (status = 'checked' AND cards_json IS NOT NULL AND last_error LIKE ? || '%'))`, t, id, t - STALE_MS, CARRY_NOTE);
  if (!claim.meta || !claim.meta.changes) {
    const s = await first(env, 'SELECT status FROM anki_sessions WHERE id = ?', id);
    if (!s) throw new HttpError(404, 'That review session is not on the hub.');
    return { checked: 0, gaps: 0, pending: 0, status: s.status };
  }
  const session = await first(env, 'SELECT id, device, started_at, cards_json, events_json FROM anki_sessions WHERE id = ?', id);
  const texts = JSON.parse(session.cards_json || '{}');
  let checked = 0, gaps = 0;
  const newGaps = [];
  try {
    let pending = await all(env, `SELECT c.*, (SELECT group_concat(ct.topic_id, ' ') FROM card_topics ct WHERE ct.user_id = 'mo' AND ct.card_id = c.card_id AND ct.removed_at IS NULL) AS map_topics
      FROM anki_cards c WHERE c.session_id = ? AND c.verdict = 'pending' ORDER BY COALESCE(c.ease, 5), c.n`, id);
    // Anki Voice: the cards the tutor already judged keep its verdict and its gap; the API checks only the others
    // (it may add a gap the tutor did not save, and never deletes the tutor's).
    const tutor = session.device === 'voice' ? await tutorJudged(env, pending) : new Map();
    if (tutor.size) {
      await env.DB.batch([...tutor].map(([n, v]) => env.DB.prepare(`UPDATE anki_cards SET verdict = ?, error_type = ?, gap = ?, said = ?, topic = ?, checked_by = 'tutor'
        WHERE session_id = ? AND n = ? AND verdict = 'pending'`).bind(v.verdict, v.error_type, v.gap, v.said, v.topic, id, n)));
      pending = pending.filter(r => !tutor.has(r.n));
    }
    const spentKey = `anki_usd:${londonDay()}`;
    let limited = false;
    let spelled = null, spellUsd = 0, waiting = null, system = null;
    const audit = { rows: [], reasked: 0 };
    for (let i = 0; i < pending.length; i += BATCH) {
      if ((Number(await getSetting(env, spentKey)) || 0) >= ANKI_DAILY_USD) { limited = true; break; }
      const batch = pending.slice(i, i + BATCH);
      const release = await reserveSpend(env, RESERVE_USD, await spendCap(env));
      if (!spelled) {
        try { spelled = await spelledBatch(env, pending, { reserved: true }); } catch (e) { await release(0); throw e; }
        spellUsd = spelled.usd;
      }
      const fixed = { rows: spelled.rows.slice(i, i + BATCH) };
      let data, usd = 0;
      const msg = `${batch.length} cards from one review session:${session.device === 'voice' ? ` ${VOICE_NOTE}` : ''}\n\n${fixed.rows.map(r => cardMessage(r, texts[r.card_id]) + fixesNote(r.fixes)).join('\n\n')}`;
      if (!system) {
        const near = [...new Set(pending.flatMap(r => String(r.map_topics || '').split(' ').filter(Boolean)))].slice(0, 40);
        system = withNames(ANKI_SYSTEM, near.length ? await nearNames(env, 'mo', [], { ids: near }).catch(() => []) : []);
      }
      const ask = extra => callJson(env, { role: 'checker', use: 'anki', system, schema: ANKI_SCHEMA, effort: 'high', maxTokens: 32000,
        messages: [{ role: 'user', content: extra ? [{ type: 'text', text: msg }, { type: 'text', text: extra }] : msg }] });
      try {
        ({ data, usd } = await ask());
        const words = new Map(fixed.rows.map(r => [r.n, [r.before_json, r.after_json].flatMap(j => JSON.parse(j || '[]')).map(p => p.text).join(' ')]));
        const raw = new Map(batch.map(r => [r.n, [r.before_json, r.after_json].flatMap(j => JSON.parse(j || '[]')).map(p => p.text).join(' ')]));
        const check = c => checkItem(c, { id: c.n, ...AUDIT_SPECS.anki_check(c), source: [words.get(c.n) || '', raw.get(c.n) || ''] });
        const cards = (data && Array.isArray(data.cards) ? data.cards : []).filter(c => c && words.has(c.n));
        const a = await auditAndReask(cards, { idOf: c => c.n, check, reask: async rows => {
          const r = await ask(reaskText(rows, id => `Card ${id}`));
          usd += Number(r.usd) || 0;
          return r.data && Array.isArray(r.data.cards) ? r.data.cards : [];
        } });
        data = { ...data, cards: a.items };
        audit.rows.push(...a.rows); audit.reasked += a.reasked;
      } catch (e) {
        // Waiting for its Message Batch: the other parts are queued too (one batch), then the session waits.
        if (isPending(e)) { await release(0); waiting = waiting || e; continue; }
        // A call that failed after Claude answered (refusal, cut off, bad JSON) still cost money: count it.
        const spent = (Number(e && e.usd) || 0) + spellUsd;
        await release(0);
        if (spent > 0) await spendStatement(env, spentKey, spent).run();
        throw e;
      }
      await release(0); // the call added its real cost
      if (waiting) continue;   // nothing is saved until every part has its answer, so each part is asked the same way again
      data = await settleCards(env, data);
      const v = verdictStatements(env, id, session, batch, data, texts, { map: await hasMapCols(env), signals: await hasSignalCols(env), forms: await hasFormCols(env), review: await hasReviewCol(env) });
      await env.DB.batch([...v.statements, spendStatement(env, spentKey, usd + spellUsd)]);
      if (v.beliefs.length) {
        const { misconceptionSave } = await import('./map/teach-memory.js');
        for (const b of v.beliefs) {
          await misconceptionSave(env, 'mo', { topic: b.topic, belief: b.quote, ref: b.ref, words: 'mo', source: 'voice' },
            { actor: 'code', surface: 'code', via: 'cron:anki_check' }).catch(e => console.error('anki check belief', e && e.message));
        }
      }
      spellUsd = 0;
      checked += v.checked;
      gaps += v.gaps.length;
      newGaps.push(...v.gaps);
    }
    if (waiting) throw waiting;
    const check = audit.rows.length ? await recordAudit(env, { job: 'anki_check', key: id, ref: session.device, rows: audit.rows, reasked: audit.reasked }) : null;
    // The first gaps go on the map now (the most telling cards came first); the minute sweep maps the rest, so a
    // long session stays inside one invocation's query limit.
    await mapGaps(env, newGaps.slice(0, MAP_NOW));
    if (gaps > 0) await (await import('./map/patterns.js')).enqueuePattern(env, 'mo', 'anki', id).catch(() => false);
    const left = await first(env, `SELECT count(*) AS n FROM anki_cards WHERE session_id = ? AND verdict = 'pending'`, id);
    if (left.n && !limited) throw new HttpError(502, `${left.n} cards came back without a check.`);
    // At the cap the rest wait, card text kept, for the next day with room (sweep); the session reads as checked so far.
    const carry = limited && left.n > 0;
    const note = carry ? `${CARRY_NOTE} ($${ANKI_DAILY_USD}) reached: ${left.n} cards wait for tomorrow's checks.` : null;
    await run(env, `UPDATE anki_sessions SET status = 'checked', cards_json = CASE WHEN ? THEN cards_json ELSE NULL END, last_error = ?, updated_at = ? WHERE id = ?`,
      carry ? 1 : 0, note, now(), id);
    await noteJob(env, { job: 'anki_check', key: `${id}:${carry ? 'held' : 'ok'}`, ref: session.device, state: carry ? 'held' : 'ok',
      counts: { cards: checked, ...(tutor.size ? { tutor: tutor.size } : {}), gaps: newGaps.filter(g => g.verdict !== 'shaky').length, shaky: newGaps.filter(g => g.verdict === 'shaky').length, pairs: newGaps.filter(g => g.mixed_with).length, left: Number(left.n) || 0,
        fixes: spelled ? spelled.fixes : 0, spell: !spelled ? 'none' : spelled.skipped || 'done', ...auditCounts(check) } });
    return { checked, gaps, pending: left.n, status: 'checked', limited };
  } catch (e) {
    // Waiting for its Message Batch (claude.js): no try used; the session goes back in line for the cron.
    if (isPending(e)) {
      await run(env, `UPDATE anki_sessions SET status = 'aligned', last_error = ?, updated_at = ? WHERE id = ?`, e.message, now(), id);
      await noteJob(env, { job: 'anki_check', key: `${id}:held`, ref: session.device, state: 'held', counts: { batch: 1 } });
      return { checked, gaps, pending: 0, status: 'waiting', waiting: 'batch' };
    }
    // A spend cap does not use up a try: the cron simply tries again once there is room.
    const capped = e instanceof HttpError && e.status === 429;
    await run(env, `UPDATE anki_sessions SET attempts = attempts + ?, status = CASE WHEN attempts + ? >= ? THEN 'failed' ELSE 'aligned' END,
      last_error = ?, updated_at = ? WHERE id = ?`, capped ? 0 : 1, capped ? 0 : 1, MAX_ATTEMPTS, String(e && e.message || e).slice(0, 300), now(), id);
    const after = await first(env, 'SELECT attempts FROM anki_sessions WHERE id = ?', id).catch(() => null);
    await noteJob(env, { job: 'anki_check', key: `${id}:${capped ? 'held' : 'failed'}`, ref: session.device, state: capped ? 'held' : 'failed',
      counts: { cards: checked, tries: Number(after && after.attempts) || 0, max: MAX_ATTEMPTS }, detail: detailOf(e) });
    throw e;
  }
}

// POST /api/anki-sessions/:id/check: the add-on asks for the check as soon as the session is saved.
export async function aliveRoute(request, env, ctx, { id }) {
  const r = await run(env, `UPDATE anki_sessions SET updated_at = ? WHERE id = ? AND status = 'open'`, now(), String(id));
  return json({ ok: true, alive: !!(r && r.meta && r.meta.changes) });
}

export async function checkRoute(request, env, ctx, { id }) {
  return json(await checkSession(env, String(id)));
}

/**
 * Cron: check sessions still waiting, then those carried over from a day that reached ANKI_DAILY_USD (only while
 * today's checks have room, so a capped day makes no calls), and clear card text over a week old whatever its state.
 */
export async function sweep(env) {
  const t = now();
  await run(env, 'UPDATE anki_sessions SET cards_json = NULL WHERE cards_json IS NOT NULL AND created_at < ?', t - KEEP_CARD_TEXT_MS);
  await run(env, `UPDATE anki_sessions SET status = 'aligned', updated_at = ? WHERE status = 'open' AND updated_at < ?`, t, t - OPEN_IDLE_MS);
  if ((Number(await getSetting(env, `anki_usd:${londonDay()}`)) || 0) >= ANKI_DAILY_USD) return;
  const rows = await all(env, `SELECT id FROM anki_sessions WHERE attempts < ? AND (status = 'aligned' OR (status = 'checking' AND updated_at < ?)
      OR (status = 'checked' AND cards_json IS NOT NULL AND last_error LIKE ? || '%'))
    ORDER BY status = 'checked', created_at LIMIT 3`, MAX_ATTEMPTS, t - STALE_MS, CARRY_NOTE);
  for (const r of rows) {
    try { await checkSession(env, r.id); } catch (e) {
      if (e instanceof HttpError && e.status === 429) break;
      console.error('anki session check failed', r.id, e && e.message);
    }
  }
}

// ---------- reading back (connector) ----------
export async function ankiWords(env, { session, date, card_id } = {}) {
  if (card_id != null) {
    const rows = await all(env, `SELECT c.*, s.day FROM anki_cards c JOIN anki_sessions s ON s.id = c.session_id WHERE c.card_id = ? ORDER BY c.shown_at DESC LIMIT 5`, Number(card_id));
    return { found: rows.length > 0, card_id: Number(card_id), cards: rows };
  }
  const s = session ? await first(env, 'SELECT * FROM anki_sessions WHERE id = ?', String(session))
    : typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? await first(env, 'SELECT * FROM anki_sessions WHERE day = ? ORDER BY started_at DESC LIMIT 1', date)
      : await first(env, 'SELECT * FROM anki_sessions ORDER BY started_at DESC LIMIT 1');
  if (!s) return { found: false };
  const cards = await all(env, 'SELECT * FROM anki_cards WHERE session_id = ? ORDER BY n', s.id);
  const count = v => cards.filter(c => c.verdict === v).length;
  return { found: true, session: s.id, date: s.day, status: s.status, minutes: s.ended_at ? Math.round((s.ended_at - s.started_at) / 60000) : null,
    words: s.words, cards_reviewed: cards.length, sound: count('sound'), shaky: count('shaky'), gap: count('gap'), no_speech: count('no_speech'),
    pending: count('pending'), cards };
}

function cardLine(c) {
  const took = c.answered_at && c.shown_at ? `${Math.round((c.answered_at - c.shown_at) / 1000)} s` : null;
  const head = `${c.day ? `${c.day} ` : ''}Card ${c.card_id} (${[EASE[c.ease] || 'not rated', took, c.deck].filter(Boolean).join(', ')}): ${c.verdict}${c.error_type ? `, ${c.error_type}` : ''}${c.topic ? ` [${c.topic}]` : ''}${c.gap ? ` — ${c.gap}` : ''}`;
  const before = JSON.parse(c.before_json || '[]'), after = JSON.parse(c.after_json || '[]');
  return [head, before.length ? `  before the answer: ${speech(before)}` : '', after.length ? `  after: ${speech(after)}` : ''].filter(Boolean).join('\n');
}

export function wordsText(r) {
  if (r.card_id != null) return r.found ? `What Mo said on card ${r.card_id}, newest first:\n${r.cards.map(cardLine).join('\n')}` : `Card ${r.card_id} has not come up in a recorded review.`;
  if (!r.found) return 'No Anki review has been recorded on the hub yet.';
  const shown = r.cards.filter(c => c.words > 0 || ['shaky', 'gap', 'pending'].includes(c.verdict));
  return [`Anki review ${r.session}, ${r.date}${r.minutes != null ? `, ${r.minutes} min` : ''}: ${r.cards_reviewed} cards, ${r.gap} gaps, ${r.shaky} shaky, ${r.sound} sound, ${r.no_speech} silent${r.pending ? `, ${r.pending} not checked yet` : ''}. Card text is not stored here; read a card with the Anki connector (find_cards "cid:<id>") if you need it.`,
    ...shown.map(cardLine)].join('\n');
}
