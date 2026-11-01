import { rowEffects, safeRef, rowWords } from './weakness.js';
import { reviewOf, GRADE, MODEL, cardDayKey } from './fsrs.js';
import { reviewList } from './cards.js';
import { detailOf } from './weights.js';
import { rowFacetObs, facetTag, partSourceOf, emptyPartCount, FACETS } from './facets.js';
import { stemSafe } from './guard.js';
import { isBoilerplate } from '../../../public/js/shared/evidence.js';

export const TIMELINE = { max: 30, rows: 600, words: 200, disagree: 3 };
export const RECORDED_GAP_SOURCES = ['anki_mac', 'anki_hub', 'anki_phone', 'spoken_cue'];
const CARD_KINDS = new Set(['card_review', 'card_lapse', 'card_check', 'card_weak_part', 'card_mature']);
const LESSON_KINDS = new Set(['lesson_final', 'lesson_probe']);

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return !t ? null : t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t; };
const hm = ms => {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)); }
  catch { return new Date(ms).toISOString().slice(11, 16); }
};

export function sourceOf(row) {
  const ref = safeRef(detailOf(row).label) || safeRef(row.source_ref);
  if (row.kind === 'question' || row.kind === 'confused_with') return ref || (row.source === 'uworld' ? 'UWorld' : 'question');
  if (row.kind === 'retest') return ref ? `card from ${ref}` : 'card from a miss';   // no "re-test" words since 1 Nov 2026
  if (CARD_KINDS.has(row.kind)) return 'card';
  if (row.kind === 'gap_stated') return 'gap';
  if (LESSON_KINDS.has(row.kind)) return 'lesson';
  if (row.kind === 'pair_item') return 'look-alike drill';
  if (row.kind === 'recall_audit') return 'viva';
  if (row.kind === 'self_rating') return row.source === 'mnemonics' ? 'mnemonic test' : 'you rated';
  if (row.kind === 'concept_miss') return ref ? `${ref} (root cause)` : 'root cause';   // foundations: a clinical miss resting on this concept
  if (row.kind === 'concept_right') return ref ? `${ref} (understood)` : 'understood';   // a right answer that showed the concept
  return String(row.kind || 'evidence').replace(/_/g, ' ');
}

/** right | shaky | wrong from the model's grade for the row (null when the model does not score it). */
export function resultOf(row) {
  const rv = reviewOf(row);
  if (!rv) return null;
  return rv.grade === GRADE.again ? 'wrong' : rv.grade === GRADE.hard ? 'shaky' : 'right';
}

export function hisWordsOf(row) {
  const pick = (text, at) => {
    const t = cut(text, TIMELINE.words);
    return t && !isBoilerplate(t) && stemSafe(t) ? { text: t, at: Number.isFinite(Number(at)) && at != null ? Number(at) : null } : null;
  };
  if (row.his_words) return pick(row.his_words, row.his_words_at);
  if (row.gap_said && RECORDED_GAP_SOURCES.includes(row.gap_source)) return pick(row.gap_said, row.gap_at);
  return null;
}

const SELF_LEVEL = { again: 'guess', hard: 'lean', good: 'sure', easy: 'sure' };
const SELF_WORD = { guess: 'Guess', lean: 'Lean', sure: 'Sure' };
/** A self-rating row in words: {level, word, part?, other_name?, aspect?, shown} (null for one with no level). */
export function selfOf(row) {
  const d = detailOf(row);
  const level = d.level && SELF_WORD[d.level] ? d.level : SELF_LEVEL[String(row.rating || '').toLowerCase()];
  if (!level) return null;
  const out = { level, word: SELF_WORD[level], shown: !!d.shown };
  if (d.part === 'diagnose' || d.part === 'manage') out.part = d.part;
  if (d.other) { out.other_name = cut(d.other_name, 80) || null; out.aspect = d.aspect === 'manage' ? 'manage' : 'apart'; }
  return out;
}

const effectOf = (dt, dp) => (dt < 0 || (dt === 0 && dp > 0.005) ? 'up' : dt > 0 || (dt === 0 && dp < -0.005) ? 'down' : 'none');

export function disagreements(items) {
  const out = [];
  const byCardDay = new Map();
  for (const it of items) {
    if (it.card_id == null || !['card_review', 'card_check', 'card_weak_part'].includes(it.kind)) continue;
    const k = `${it.card_id}|${it.day}`;
    if (!byCardDay.has(k)) byCardDay.set(k, []);
    byCardDay.get(k).push(it);
  }
  for (const list of byCardDay.values()) {
    const check = list.find(x => x.kind !== 'card_review' && x.result && x.result !== 'right');
    const rated = list.find(x => x.kind === 'card_review' && x.result === 'right');
    if (check && rated) out.push({ at: Math.max(check.at, rated.at), text: `Spoken check: ${check.result === 'wrong' ? 'gap' : 'shaky'} · rating: ${rated.rating || 'right'} (card, ${rated.time}); the map counted the worse` });
  }
  const byDay = new Map();
  for (const it of items) if (it.result && !it.picked) { if (!byDay.has(it.day)) byDay.set(it.day, []); byDay.get(it.day).push(it); }
  for (const list of byDay.values()) {
    const sorted = [...list].sort((a, b) => a.at - b.at);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i];
      const kindA = CARD_KINDS.has(a.kind) ? 'card' : a.kind, kindB = CARD_KINDS.has(b.kind) ? 'card' : b.kind;
      if (kindA === kindB || (a.result === 'right') === (b.result === 'right')) continue;
      out.push({ at: b.at, text: `${b.source} ${b.result} ${b.time} after ${a.source} ${a.result} ${a.time}` });
    }
  }
  return out.sort((x, y) => y.at - x.at).slice(0, TIMELINE.disagree).map(x => ({ text: x.text }));
}

// Results from worst to best, to name an event by its worst part (the model takes the worse of a card's check and rating).
const RANK = { wrong: 0, shaky: 1, right: 2 };
const worst = list => list.filter(Boolean).sort((a, b) => RANK[a] - RANK[b])[0] || null;
const yWord = y => (y >= 1 ? 'right' : y > 0 ? 'shaky' : 'wrong');

/**
 * The topic's events (pure): each a list of rows, first row first. A card's rows of one London day (its rating, and the
 * check, gap, lapse or weak part on it) are one event, led by the rating, as FSRS hears them; every other row is its own.
 */
export function eventGroups(rows) {
  const out = [], byKey = new Map();
  for (const r of rows || []) {
    const k = cardDayKey(r);
    if (!k) { out.push([r]); continue; }
    if (!byKey.has(k)) { const g = []; byKey.set(k, g); out.push(g); }
    byKey.get(k).push(r);
  }
  for (const g of out) {
    g.sort((a, b) => (a.kind === 'card_review' ? 0 : 1) - (b.kind === 'card_review' ? 0 : 1) || Number(a.at) - Number(b.at));
  }
  return out;
}

/** A card's later rating the same day after its first Again: {at, result} (relearned), or null. */
export function thenAfterMiss(row) {
  if (!row || row.kind !== 'card_review') return null;
  const list = reviewList(row);
  const miss = list.findIndex(x => x[1] === GRADE.again);
  if (miss < 0) return null;
  const later = list.slice(miss + 1).find(x => x[1] >= GRADE.hard);
  return later ? { at: later[0], result: later[1] === GRADE.hard ? 'shaky' : 'right' } : null;
}

/**
 * Each part's answers among the rows (pure): {diagnose, manage}, each {n, right, shaky, wrong, rows, last_at, by: {question,
 * card_part, gap, lesson, viva}}. rows: how many events count for that part. obsOf: rowFacetObs's map.
 */
export function partCounts(groups, obsOf) {
  const out = Object.fromEntries(FACETS.map(f => [f, emptyPartCount()]));
  for (const g of groups || []) {
    const hit = new Set();
    for (const r of g) {
      for (const o of obsOf.get(r) || []) {
        const c = out[o.facet];
        if (!c) continue;
        hit.add(o.facet);
        c.n += 1;
        c[yWord(o.y)] += 1;
        const src = partSourceOf(r.kind);
        if (src) c.by[src] += 1;
        c.last_at = c.last_at == null ? o.at : Math.max(c.last_at, o.at);
      }
    }
    for (const f of hit) out[f].rows += 1;
  }
  return out;
}

/**
 * The timeline from a topic's live evidence rows (with his_words, his_words_at, gap_said, gap_at, gap_source, miss_step,
 * gap_step and card_question joined), its prior m0 and the model the colour uses. Returns {items, disagree, more, parts}.
 * items: one per event, newest first, at most TIMELINE.max, each {at, day, time, kind, source, what, result, his_words,
 * his_words_at, effect, picked, facet ('diagnose' | 'manage' | 'both' | null), part_result ({diagnose?, manage?}: the
 * event's result for that part), card_id?, rating?, then? ({at, result}: a card's rating after its miss that day),
 * joined? (rows folded into it), note? ('relearned' | 'fade_clock': why a wrong raised the chance)}. parts: partCounts.
 * effect is null for a row older than the newest TIMELINE.max (not worked out), never guessed.
 */
export function timeline(rows, { m0 = 0.6, now = Date.now(), model = MODEL } = {}) {
  const all = (rows || []).filter(r => r && Number(r.held) !== 1 && Number.isFinite(Number(r.at)) && Number(r.at) <= now);
  const live = all.filter(r => reviewOf(r));
  if (!live.length) return { items: [], disagree: [], more: 0, parts: null };
  const groups = eventGroups(live);
  const obsOf = rowFacetObs(live);
  // The effects from every row the score reads (the same set the stored colour came from); only scored rows are listed.
  const { items: eff } = rowEffects(all, m0, now, model, { max: TIMELINE.max, groups: groups.filter(g => g.length > 1) });
  const byRow = new Map(eff.map(x => [x.row, x]));
  const rowItem = r => {
    const at = Number(r.at);
    const it = { at, day: r.day || null, time: hm(at), kind: r.kind, source: sourceOf(r), what: rowWords(r), result: resultOf(r), picked: r.kind === 'confused_with' };
    if (r.card_id != null) it.card_id = Number(r.card_id);
    if (r.kind === 'card_review' && r.rating) it.rating = String(r.rating).replace(/^./, c => c.toUpperCase());
    if (r.kind === 'self_rating') { const s = selfOf(r); if (s) it.self = s; }
    return it;
  };
  const events = [...groups].sort((a, b) => Number(b[0].at) - Number(a[0].at));
  const items = events.slice(0, TIMELINE.max).map(g => {
    const r = g[0];
    const it = rowItem(r);
    const e = byRow.get(r);
    const words = g.map(hisWordsOf).find(Boolean) || null;
    it.result = worst(g.map(resultOf)) || it.result;
    it.his_words = words ? words.text : null;
    it.his_words_at = words ? words.at : null;
    it.effect = e ? effectOf(e.dt, e.dp) : null;
    const obs = g.flatMap(x => obsOf.get(x) || []);
    it.facet = facetTag(obs);
    it.part_result = Object.fromEntries(FACETS.map(f => [f, worst(obs.filter(o => o.facet === f).map(o => yWord(o.y)))]).filter(([, v]) => v));
    if (g.length > 1) it.joined = g.length - 1;
    // The miss and the gaps behind the event, so the panel can open the row to everything it knows about them.
    const missId = (g.find(x => x.miss_id) || {}).miss_id;
    if (missId) it.miss_id = String(missId);
    const gapIds = [...new Set(g.map(x => x.gap_id).filter(Boolean).map(String))];
    if (gapIds.length) it.gap_ids = gapIds;
    const then = it.result === 'wrong' ? thenAfterMiss(r) : null;
    if (then) it.then = then;
    if (it.result === 'wrong' && it.effect === 'up') it.note = then ? 'relearned' : 'fade_clock';
    return it;
  });
  // Disagreements read the rows one by one (a spoken check against its own rating), before they are joined.
  const flat = [...live].sort((a, b) => Number(b.at) - Number(a.at)).slice(0, TIMELINE.max * 2).map(rowItem);
  return { items, disagree: disagreements(flat), more: Math.max(0, events.length - items.length), parts: partCounts(groups, obsOf) };
}
