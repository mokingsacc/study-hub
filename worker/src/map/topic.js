import { json, londonDay, HttpError } from '../util.js';
import { leaks } from '../checks.js';
import { leakIndexFor, stemSafe, questionSafe, gapSafe } from './guard.js';
import { whyLine } from './weakness.js';
import { HALF_LIFE } from './weights.js';
import { errorWords, gapOrigin, GAP_SOURCE_LABEL, SLOW_S } from './ingest/map-fields.js';
import { lookAlikeHead, decayed, isMixedUp } from './links.js';
import { LINK_TYPES, importance, colourW } from '../../../public/js/shared/link-rank.js';
import { bandOf, bandWord } from '../../../public/js/map/scale.js';
import { ambossSearch } from '../../../public/js/shared/amboss.js';
import { refreshSources, staleKinds, cardDetail, MY_DECK } from './sources.js';
import { DISCIPLINES } from './systems.js';
import { TREND_WORDS } from './fsrs.js';
import { topicHabitStatements, shapeTopicHabits, forExplaining } from './habits.js';
import { rankJoin, RANK_COLS, examRankText } from '../exam-ranks.js';
import { lastChangeSql, lastChangeOf } from './recent.js';
import { photoStatement, shapePhotos } from './photos.js';
import { pictureStatement, shapePictures, attachOnOpen } from './pictures.js';

export const AUDIENCES = ['page', 'claude'];
export const SECTIONS = ['misses', 'gaps', 'cards', 'links', 'read', 'lessons'];
// map_topic's include words, mapped onto the sections they need.
const INCLUDE_ALIASES = { mehlman: 'read', notes: 'lessons', memory: 'lessons', amboss: 'read' };
export const CAPS = { misses: 20, gaps: 10, cards: 20, links: 24, mehlman: 4, lessons: 5, memory: 3, misconceptions: 5, aliases: 12 };
export const TEXT = { reasoning_page: 160, reasoning_claude: 300, rule: 300, snippet: 400, preview: 140, claude_text: 5000, gap: 200 };
export const SIZE = { page: 40_000, claude: 12_000 };   // claude = map_topic's cap (plan §10.3), so these trims run before the connector's
export const SLIP_ERRORS = ['misread', 'test_taking'];
export const AWAIT_MS = 2500;

// The only miss columns read (and so the only ones that can ever leave): plan §9's whitelist. block_id is read
// for the leak check and never sent.
export const MISS_COLS = ['id', 'label', 'day', 'at', 'result', 'outcome', 'flaw_kind', 'confidence', 'error_type', 'time_s', 'slow', 'rule',
  'my_reasoning', 'look_alikes', 'retests_json', 'next_retest_day', 'block_id', 'uw_qid'];
export const MISS_ITEM_KEYS = ['id', 'label', 'day', 'result', 'outcome', 'flaw_kind', 'confidence', 'error_type', 'error_words', 'time_s', 'slow',
  'rule', 'my_reasoning', 'look_alike', 'retest', 'slip', 'uw_qid'];
// Never in any reply, at any depth.
export const FORBIDDEN_KEYS = ['correct_reasoning', 'why_wrong_options', 'right_reasoning', 'other_options', 'stem', 'question_text', 'explanation'];

const CERT_WORDS = { low: 'not settled yet', medium: 'fairly sure', high: 'sure' };
const ORIGIN_WORDS = { stated: 'You said', review: 'Anki review' };
const RESULT_WORDS = { wrong: 'wrong', flawed: 'right but shaky' };
const LESSON_OUTCOME_WORDS = { landed: 'landed', partial: 'partly', not_landed: 'did not land' };
const REQUEST_MS = 24 * 3600_000, TEACHING_MS = 3 * 3600_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (s, d) => { if (s == null || s === '') return d; if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return d; } };
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export const cut = (s, n) => {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '').replace(/[\s,;:]+$/, '') + '…' : t;
};
const dayOf = at => (at ? londonDay(at) : null);
export const shortDay = d => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '')); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : null; };

// ---------------------------------------------------------------- options (pure)

/** {audience, sections: Set, missesLimit} from the caller's options, defaults filled and bad values refused. */
export function readOptions(opts = {}) {
  const audience = AUDIENCES.includes(opts.audience) ? opts.audience : 'page';
  let sections = new Set(SECTIONS);
  if (Array.isArray(opts.include) && opts.include.length) {
    sections = new Set(opts.include.map(x => INCLUDE_ALIASES[x] || x).filter(x => SECTIONS.includes(x)));
  }
  const ml = Number(opts.missesLimit);
  const missesLimit = Number.isInteger(ml) && ml >= 1 ? Math.min(ml, CAPS.misses) : CAPS.misses;
  return { audience, sections, missesLimit };
}

// ---------------------------------------------------------------- reads

/**
 * The statements of the one read batch, by name. Sections not asked for are left out, and so is any optional
 * table in `skip` (one that does not exist yet). Every statement names user_id.
 */
export function detailStatements(env, user, topicId, { audience = 'page', sections, missesLimit, skip = new Set() }) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const s = {};
  s.seq = q(`SELECT coalesce(max(seq), 0) AS seq FROM map_events WHERE user_id = ?`, user);
  s.last = lastChangeSql(env, user, topicId);   // "Updated <when> · <what>" under the name (Recents)
  s.topic = q(`SELECT t.id, t.name, t.short_name, t.kind, t.status, t.merged_into, t.category_id, t.category2_id, t.unit_id, t.amboss_url, t.amboss_src,
      t.amboss_checked_at, t.yield, t.updated_at, t.oncology, t.disciplines, u.num AS unit_num, u.name AS unit_name, u.lane, u.mehlman_rank, u.nbme_images, u.onenote_link,
      c.name AS cat_name, c2.name AS cat2_name, ${RANK_COLS}
    FROM topics t LEFT JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id
    ${rankJoin('u')}
    LEFT JOIN categories c ON c.user_id = t.user_id AND c.id = t.category_id
    LEFT JOIN categories c2 ON c2.user_id = t.user_id AND c2.id = t.category2_id
    WHERE t.user_id = ? AND t.id = ?`, user, topicId);
  s.aliases = q(`SELECT alias, kind FROM topic_aliases WHERE user_id = ? AND topic_id = ? AND status = 'active' AND kind NOT IN ('typo','truncated')
    ORDER BY kind = 'abbrev' DESC, length(alias) LIMIT ${CAPS.aliases}`, user, topicId);
  s.score = q(`SELECT seen, t, band, certainty, certainty_level, why_json, n_seen, questions_n, right_n, misses_n, sure_wrong_n, slow_n, cards_n,
      lapses_n, lessons_n, gaps_n, last_question_at, last_miss_at, computed_at, refreshed_at, weakness_raw, trend
    FROM topic_scores WHERE user_id = ? AND topic_id = ?`, user, topicId);
  s.fetches = q(`SELECT kind, fetched_at, n, status FROM source_fetches WHERE user_id = ? AND topic_id = ?`, user, topicId);
  if (audience === 'page' && !skip.has('topic_photos')) s.photos = photoStatement(env, user, topicId);
  if (audience === 'page' && !skip.has('topic_pictures')) s.pictures = pictureStatement(env, user, topicId);
  if (sections.has('misses')) {
    s.missCounts = q(`SELECT result, error_type, confidence, count(*) AS n, sum(slow) AS slow FROM misses_live WHERE user_id = ? AND topic_id = ?
      GROUP BY 1, 2, 3`, user, topicId);
    s.misses = q(`SELECT ${MISS_COLS.join(', ')} FROM misses_live WHERE user_id = ? AND topic_id = ? ORDER BY at DESC LIMIT ?`, user, topicId, missesLimit);
  }
  if (sections.has('gaps')) {
    s.gaps = q(`SELECT id, at, day, source, origin, verdict, gap, said, card_id, ref, count(*) OVER () AS total FROM gaps
      WHERE user_id = ? AND topic_id = ? AND held = 0 ORDER BY at DESC LIMIT ${CAPS.gaps}`, user, topicId);
  }
  if (sections.has('cards')) {
    s.cards = q(`SELECT c.card_id, c.note_id, c.deck, c.question, c.answer, c.schedule, c.lapses, c.image_count, c.fetched_at, ct.match, ct.strong,
        (SELECT m.label FROM misses_live m, json_each(m.anki_note_ids_json) j WHERE m.user_id = ct.user_id AND m.topic_id = ct.topic_id
           AND (j.value = c.note_id OR (c.card_id - j.value) BETWEEN 1 AND 50) ORDER BY m.at DESC LIMIT 1) AS made_after
      FROM card_topics ct JOIN card_cache c ON c.user_id = ct.user_id AND c.card_id = ct.card_id
      WHERE ct.user_id = ? AND ct.topic_id = ? AND ct.removed_at IS NULL AND c.deleted_at IS NULL
      ORDER BY (ct.match = 'miss') DESC, ct.strong DESC, coalesce(c.lapses, 0) DESC, c.card_id DESC LIMIT ${CAPS.cards + 1}`, user, topicId);
  }
  if (sections.has('links')) {
    s.links = q(`SELECT k.id, k.type, k.from_id, k.to_id, k.directed, k.how, k.a_vs_b, k.b_vs_a, k.picture, k.strength, k.confusion, k.confusion_at,
        k.confused_n, k.last_confused_at, k.last_truth_id, k.status, o.name AS other_name, o.short_name AS other_short, o.yield AS other_yield,
        so.seen AS other_seen, so.t AS other_t
      FROM links k JOIN topics o ON o.user_id = k.user_id AND o.id = CASE WHEN k.from_id = ?2 THEN k.to_id ELSE k.from_id END
      LEFT JOIN topic_scores so ON so.user_id = k.user_id AND so.topic_id = o.id
      WHERE k.user_id = ?1 AND (k.from_id = ?2 OR k.to_id = ?2) AND k.status IN ('active','proposed') AND o.status IN ('proposed','confirmed')
      ORDER BY k.type = 'versus' DESC, k.confusion DESC, k.strength DESC LIMIT 40`, user, topicId);
  }
  if (sections.has('read')) {
    s.mehlman = q(`SELECT r.resource_id, coalesce(x.title, r.label, r.resource_id) AS title, r.page, r.page_to, r.section, r.snippet, r.kind
      FROM resource_links r LEFT JOIN resources x ON x.user_id = r.user_id AND x.id = r.resource_id
      WHERE r.user_id = ? AND r.topic_id = ? AND r.status = 'live' ORDER BY r.kind = 'mehlman' DESC, r.rank DESC LIMIT 8`, user, topicId);
  }
  if (!skip.has('pattern_items') && !skip.has('habits')) Object.assign(s, topicHabitStatements(env, user, topicId));
  if (sections.has('lessons')) {
    s.lessons = q(`SELECT id, kind, status, surface, minutes, outcome, day, requested_at, started_at, ended_at, card_id, card_note_id, card_action,
        topic_id, pair_topic_id, mo_rating, what_clicked FROM lessons WHERE user_id = ?1 AND (topic_id = ?2 OR pair_topic_id = ?2)
      ORDER BY coalesce(ended_at, started_at, requested_at) DESC LIMIT 8`, user, topicId);
    s.memory = q(`SELECT id, tactic, note, status FROM teach_memory WHERE user_id = ? AND scope = 'topic' AND scope_ref = ? AND status IN ('active','pinned')
      ORDER BY status = 'pinned' DESC, score DESC, updated_at DESC LIMIT ${CAPS.memory}`, user, topicId);
    if (!skip.has('misconceptions')) {
      s.misconceptions = q(`SELECT * FROM misconceptions WHERE user_id = ? AND topic_id = ? AND status <> 'closed'
        ORDER BY coalesce(last_seen, first_seen) DESC LIMIT ${CAPS.misconceptions}`, user, topicId);
    }
  }
  return s;
}

// Tables a later area adds; a database without one still answers (the section is left empty).
const OPTIONAL = ['misconceptions', 'topic_photos', 'topic_pictures', 'pattern_items', 'habits'];
const missingOptional = e => { const m = /no such table:?\s*(?:main\.)?(\w+)/i.exec(String(e && e.message)); return m && OPTIONAL.includes(m[1]) ? m[1] : null; };

// Optional tables found missing in this isolate, so later reads skip them without a failed batch.
const MISSING = new Set();
export const _resetMissing = () => MISSING.clear();

/** The read batch as {name: rows}. One query; an optional table that does not exist yet costs one retry, once. */
export async function readDetail(env, user, topicId, opts) {
  const skip = new Set(MISSING);
  for (let i = 0; i <= OPTIONAL.length; i++) {
    const named = detailStatements(env, user, topicId, { ...opts, skip });
    const names = Object.keys(named);
    try {
      const res = await env.DB.batch(names.map(n => named[n]));
      return Object.fromEntries(names.map((n, k) => [n, (res[k] && res[k].results) || []]));
    } catch (e) {
      const t = missingOptional(e);
      if (!t || skip.has(t)) throw e;
      skip.add(t);
      MISSING.add(t);
    }
  }
  throw new Error('topicDetail: the read batch could not run');
}

// Did anything touch this topic since seq? One indexed read (map_events by topic, or by target).
export async function changedSince(env, user, topicId, since) {
  const r = await env.DB.prepare(`SELECT coalesce(max(seq), 0) AS seq,
      (SELECT count(*) FROM map_events x WHERE x.user_id = ?1 AND x.seq > ?3 AND (x.topic_id = ?2 OR (x.target_type = 'topic' AND x.target_id = ?2))) AS n
    FROM map_events WHERE user_id = ?1`).bind(user, topicId, since).first();
  return { seq: (r && r.seq) || 0, changed: !r || r.n > 0 };
}

// ---------------------------------------------------------------- shaping (pure)

export function shapeTopic(t, aliases) {
  const unit = t.unit_id ? {
    id: t.unit_id, num: num(t.unit_num), name: t.unit_name || null, lane: t.lane || null, mehlman_rank: num(t.mehlman_rank),
    nbme_rank: num(t.nbme_rank), cms_rank: num(t.cms_rank),
    nbme_images: num(t.nbme_images) || 0, onenote_link: t.onenote_link || null,
  } : null;
  return {
    id: t.id, name: t.name, short_name: t.short_name || null, kind: t.kind, status: t.status,
    aliases: [...new Set(aliases.map(a => a.alias))].filter(a => a !== t.name).slice(0, CAPS.aliases),
    category: t.category_id ? { id: t.category_id, name: t.cat_name || t.category_id } : null,
    category2: t.category2_id ? { id: t.category2_id, name: t.cat2_name || t.category2_id } : null,
    unit, yield100: Math.round((Number(t.yield) || 0) * 100),
    // Taxonomy v2's tags (the map's Oncology and discipline filters), as words for the panel.
    tags: tagsOf(t),
  };
}

/** {oncology, disciplines: [{key, word}]} from the topic's stored tags. */
export function tagsOf(t) {
  const bits = Number(t && t.disciplines) || 0;
  return { oncology: Number(t && t.oncology) === 1, disciplines: DISCIPLINES.filter(([, , bit]) => bits & bit).map(([key, word]) => ({ key, word })) };
}

export function unitLine(unit) {
  if (!unit) return 'Not on the checklist';
  const parts = [];
  if (unit.num != null) parts.push(`Unit ${unit.num}`);
  if (unit.lane) parts.push(`Lane ${unit.lane}`);
  if (unit.mehlman_rank != null) parts.push(`Mehlman #${unit.mehlman_rank}`);
  const exams = examRankText(unit.nbme_rank ?? null, unit.cms_rank ?? null);
  if (exams) parts.push(exams);
  if (unit.nbme_images) parts.push(`${unit.nbme_images} NBME picture${unit.nbme_images === 1 ? '' : 's'}`);
  return parts.join(' · ') || unit.name || 'On the checklist';
}

/** The stored score in words. The browser never computes a score: t1000 is only mapped to a colour there. */
export function shapeWeakness(s, now) {
  if (!s || !Number(s.seen)) {
    return { seen: false, t1000: null, band: 'unseen', band_words: bandWord('unseen'), cert100: 0, certainty_words: CERT_WORDS.low, signs: 0,
      why: 'Not seen yet.', counts: countsOf(s) };
  }
  const t1000 = s.t == null ? null : Math.round(Number(s.t) * 1000);
  const band = s.band && s.band !== 'unseen' ? s.band : bandOf(t1000);
  return {
    seen: true, t1000, band, band_words: bandWord(band), cert100: Math.round((Number(s.certainty) || 0) * 100),
    certainty_words: CERT_WORDS[s.certainty_level] || CERT_WORDS.low, signs: Number(s.n_seen) || 0,
    why: whyLine({ ...s, band, t1000 }, s.why_json, now), counts: countsOf(s), ...memoryOf(s),
  };
}

export function memoryOf(s) {
  const trend = s && s.trend != null && Number.isFinite(Number(s.trend)) ? Number(s.trend) : null;
  const raw = s && s.weakness_raw != null && Number.isFinite(Number(s.weakness_raw)) ? Number(s.weakness_raw) : null;
  return { trend, trend_words: trend == null ? null : TREND_WORDS[trend], next_right100: raw == null ? null : Math.round(100 * (1 - raw)) };
}

function countsOf(s) {
  const out = {};
  for (const k of ['questions_n', 'right_n', 'misses_n', 'sure_wrong_n', 'slow_n', 'cards_n', 'lapses_n', 'lessons_n', 'gaps_n']) out[k.replace(/_n$/, '')] = s ? Number(s[k]) || 0 : 0;
  return out;
}

/**
 * A miss's re-test badge: the next one due (next_retest_day, the hub's own re-tests since 0036), else the last result
 * the Anki log's list holds.
 */
export function retestOf(retestsJson, nextDay) {
  if (nextDay) return { due: nextDay, result: null };
  const list = (parse(retestsJson, []) || []).filter(r => r && r.due);
  const open = list.filter(r => r.result == null).sort((a, b) => String(a.due).localeCompare(String(b.due)))[0];
  if (open) return { due: open.due, result: null };
  if (list.length) { const last = list.slice().sort((a, b) => String(a.due).localeCompare(String(b.due))).pop(); return { due: last.due, result: last.result }; }
  return nextDay ? { due: nextDay, result: null } : null;
}

/** One miss through the whitelist. Only MISS_ITEM_KEYS come out. */
export function shapeMiss(m, audience = 'page') {
  const error_type = m.error_type || null;
  return {
    id: m.id, label: m.label, day: m.day, result: m.result, outcome: m.outcome || null, flaw_kind: m.flaw_kind || null,
    confidence: m.confidence || null, error_type, error_words: errorWords(error_type), time_s: num(m.time_s),
    slow: !!Number(m.slow) || (num(m.time_s) != null && num(m.time_s) > SLOW_S),
    rule: cut(m.rule, TEXT.rule), my_reasoning: cut(m.my_reasoning, audience === 'claude' ? TEXT.reasoning_claude : TEXT.reasoning_page),
    look_alike: lookAlikeHead(m.look_alikes) || null, retest: retestOf(m.retests_json, m.next_retest_day), slip: SLIP_ERRORS.includes(error_type),
    uw_qid: m.uw_qid != null && m.uw_qid !== '' ? String(m.uw_qid) : null,
  };
}

/** The misses summary from the grouped counts. */
export function missSummary(rows) {
  const out = { total: 0, by_result: {}, by_error: {}, by_confidence: {}, slow: 0, slips: 0 };
  for (const r of rows) {
    const n = Number(r.n) || 0;
    out.total += n;
    out.by_result[r.result] = (out.by_result[r.result] || 0) + n;
    if (r.error_type) out.by_error[r.error_type] = (out.by_error[r.error_type] || 0) + n;
    const c = r.confidence || 'unknown';
    out.by_confidence[c] = (out.by_confidence[c] || 0) + n;
    out.slow += Number(r.slow) || 0;
    if (SLIP_ERRORS.includes(r.error_type)) out.slips += n;
  }
  return out;
}

/** "5 misses · 3 wrong, 2 right but shaky · 4 knowledge gap, 1 premature closure · 2 when sure · 2 slow". */
export function missLine(sum) {
  if (!sum.total) return 'No misses yet';
  const parts = [`${sum.total} miss${sum.total === 1 ? '' : 'es'}`];
  const res = Object.entries(sum.by_result).filter(([, n]) => n).map(([k, n]) => `${n} ${RESULT_WORDS[k] || k}`);
  if (res.length) parts.push(res.join(', '));
  const err = Object.entries(sum.by_error).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${errorWords(k) || k.replace(/_/g, ' ')}`);
  if (err.length) parts.push(err.join(', '));
  if (sum.by_confidence.sure) parts.push(`${sum.by_confidence.sure} when sure`);
  if (sum.slow) parts.push(`${sum.slow} slow`);
  return parts.join(' · ');
}

export function shapeGap(g, audience = 'page') {
  g = gapSafe(g);
  const origin = gapOrigin(g);
  const words = origin === 'stated' ? cut(g.gap, TEXT.gap) : cut(g.said, TEXT.gap);
  const item = { id: g.id, day: g.day || dayOf(g.at), origin, origin_words: ORIGIN_WORDS[origin], source: g.source,
    source_words: GAP_SOURCE_LABEL[g.source] || String(g.source || '').replace(/_/g, ' '), text: words, card_id: num(g.card_id) };
  if (audience === 'claude') { item.gap = cut(g.gap, TEXT.gap); item.said = cut(g.said, TEXT.gap); item.verdict = g.verdict || null; }
  return item;
}

/** A card's schedule in words: 'new', 'due in 62 days', 'suspended' (check_deck's own text, tidied). */
export const scheduleWords = s => cut(String(s || '').replace(/,?\s*forgotten\s+\S+\s+times?/i, '').trim(), 60) || null;

export function shapeCard(c, audience = 'page') {
  const item = { card_id: Number(c.card_id), preview: cut(c.question, TEXT.preview), schedule: scheduleWords(c.schedule), lapses: Number(c.lapses) || 0,
    image_count: Number(c.image_count) || 0, match: c.match, strong: !!Number(c.strong), made_after: c.made_after || null };
  if (audience === 'claude') item.answer = cut(c.answer, 200);
  return item;
}

// Labels for other links, from this topic's side (plan §9 panel section 6).
export function linkLabel(type, how, dir) {
  const out = dir === 'out';
  if (type === 'treated_by') return out ? 'Treated with' : 'Treats';
  if (type === 'adverse_effect') return out ? 'Side effects' : 'Side effect of';
  if (type === 'causes') {
    if (how === 'risk_factor') return out ? 'Risk factor for' : 'Risk factors';
    if (how === 'complication') return out ? 'Can lead to' : 'Complication of';
    return out ? 'Causes' : 'Caused by';
  }
  return (LINK_TYPES[type] || {}).label || type;
}

/**
 * Links in two lists: look-alikes (versus) first, then the others grouped by label; ranked by links' importance()
 * with mixed-up pairs first; 24 chips at most in all. Confusion is decayed to now, as links-store does.
 */
export function shapeLinks(rows, topic, { now = Date.now(), score = null, hlDays = HALF_LIFE.q, limit = CAPS.links } = {}) {
  const myT = score && Number(score.seen) && score.t != null ? Math.round(score.t * 1000) : null;
  const myY = Number(topic.yield) || 0;
  const items = rows.map(l => {
    const mine = l.from_id === topic.id;
    const otherId = mine ? l.to_id : l.from_id;
    const c = decayed(Number(l.confusion) || 0, l.confusion_at, now, hlDays);
    const otherT = Number(l.other_seen) && l.other_t != null ? Math.round(Number(l.other_t) * 1000) : null;
    const spec = LINK_TYPES[l.type] || { typeW: 0.5 };
    const imp = importance({ strength: Number(l.strength) || 0, typeW: spec.typeW, wA: colourW(myT), wB: colourW(otherT), yA: myY, yB: Number(l.other_yield) || 0, c });
    const other = { id: otherId, name: l.other_name || otherId, t1000: otherT, seen: otherT != null };
    if (l.type === 'versus') {
      let you_took = null;
      if (c > 0 && l.last_truth_id) {
        const truthIsMe = l.last_truth_id === topic.id;
        you_took = truthIsMe ? `You took ${topic.name} for ${other.name}` : `You took ${other.name} for ${topic.name}`;
      }
      // The Versus line from this topic's side (a_vs_b reads from the link's from-topic); when only the other side has
      // one, it comes as vs_theirs, so the panel can still say how they differ and whose side it is written from.
      const own = (mine ? l.a_vs_b : l.b_vs_a) || null;
      return { group: 'versus', imp, mixed: isMixedUp(c), item: {
        id: l.id, other, a_vs_b: own, vs_theirs: own ? null : (mine ? l.b_vs_a : l.a_vs_b) || null, confused: isMixedUp(c), confusion: Math.round(c * 100) / 100,
        confused_n: Number(l.confused_n) || 0, last_confused: dayOf(l.last_confused_at), you_took, picture: l.picture || null, proposed: l.status === 'proposed' } };
    }
    const dir = !Number(l.directed) ? 'both' : mine ? 'out' : 'in';
    return { group: 'other', imp, mixed: false, item: { id: l.id, type: l.type, how: l.how || null, dir, label: linkLabel(l.type, l.how, dir), other, proposed: l.status === 'proposed' } };
  });
  items.sort((a, b) => (a.group === b.group ? 0 : a.group === 'versus' ? -1 : 1) || (b.mixed - a.mixed) || (b.imp - a.imp));
  const kept = items.slice(0, limit);
  return { versus: kept.filter(x => x.group === 'versus').map(x => x.item), other: kept.filter(x => x.group === 'other').map(x => x.item), more: Math.max(0, items.length - kept.length) };
}

export function shapeLessons(rows, topicId, now) {
  const items = [];
  let open_request = null, in_progress = null, last = null;
  for (const l of rows) {
    if (l.status === 'requested') {
      if (!open_request && l.requested_at && now - l.requested_at < REQUEST_MS && l.topic_id === topicId) open_request = { lesson_id: l.id, kind: l.kind, requested_at: l.requested_at };
      continue;
    }
    if (l.status === 'in_progress') {
      if (!in_progress && l.started_at && now - l.started_at < TEACHING_MS) in_progress = { lesson_id: l.id, kind: l.kind, started_at: l.started_at };
      continue;
    }
    if (l.status !== 'done') continue;
    if (!last) last = { day: l.day || dayOf(l.ended_at), outcome: l.outcome || null, outcome_words: LESSON_OUTCOME_WORDS[l.outcome] || null };
    if (items.length < CAPS.lessons) {
      items.push({ id: l.id, day: l.day || dayOf(l.ended_at), kind: l.kind, surface: l.surface || null, minutes: l.minutes == null ? null : Math.round(Number(l.minutes)),
        outcome: l.outcome || null, outcome_words: LESSON_OUTCOME_WORDS[l.outcome] || null,
        card: l.card_action === 'added' || l.card_action === 'edited_existing' || l.card_id != null || l.card_note_id != null,
        pair: l.pair_topic_id ? (l.topic_id === topicId ? l.pair_topic_id : l.topic_id) : null,
        mo_rating: Number.isInteger(Number(l.mo_rating)) && l.mo_rating != null ? Number(l.mo_rating) : null, what_clicked: cut(l.what_clicked, 200) || null });
    }
  }
  return { items, open_request, in_progress, last };
}

const MISCONCEPTION_KEYS = ['id', 'belief', 'status', 'ref', 'first_seen', 'last_seen'];
export function shapeMisconception(m) {
  const out = {};
  for (const k of MISCONCEPTION_KEYS) if (m[k] !== undefined) out[k] = k === 'belief' ? cut(m[k], 200) : m[k];
  if (String(m.note || '').startsWith('Re-check')) out.recheck = cut(m.note, 160);
  return out;
}

export function shapeRead(t, mehlmanRows, fetches, audience) {
  const f = fetches.find(x => x.kind === 'mehlman');
  const items = mehlmanRows.filter(r => r.kind === 'mehlman').slice(0, CAPS.mehlman).map(r => ({
    resource_id: r.resource_id, title: r.title, page: num(r.page), page_to: num(r.page_to), section: r.section || null, snippet: cut(r.snippet, TEXT.snippet),
  }));
  const match = f ? (f.status === 'weak' ? 'weak' : f.status === 'error' ? null : 'strong') : null;
  const amboss = { url: t.amboss_url || null, src: t.amboss_src || null, checked: t.amboss_checked_at != null };
  const read = { mehlman: { match: items.length ? match || 'strong' : match, items }, amboss };
  if (audience === 'page') {
    amboss.search_url = ambossSearch(t.name);
    const unitLabel = [t.unit_num != null ? `${t.unit_num}.` : null, t.unit_name].filter(Boolean).join(' ');
    read.onenote = t.onenote_link ? { link: t.onenote_link, label: [t.cat_name, unitLabel].filter(Boolean).join(' › ') || 'Your OneNote page' } : null;
    read.mine = [];
  }
  return read;
}

// ---------------------------------------------------------------- the leak guard

export function scrubLeaks(items, index) {
  for (const it of items) {
    // Every row, hub or not: text that reads like question text never reaches the panel or Claude.
    for (const [k, safe] of [['rule', questionSafe], ['look_alike', questionSafe], ['my_reasoning', stemSafe]]) if (it[k] && !safe(it[k])) it[k] = null;
    if (index && index.size) for (const k of ['rule', 'my_reasoning', 'look_alike']) if (it[k] && leaks(index, it[k])) it[k] = null;
  }
  return items;
}

// ---------------------------------------------------------------- Claude's text

/** A plain rendering for Claude, at most 5,000 characters. */
export function claudeText(d) {
  const t = d.topic;
  const u = t.unit;
  const unitWords = u ? [u.num != null ? `unit ${u.num}` : null, u.lane ? `lane ${u.lane}` : null, u.mehlman_rank != null ? `Mehlman #${u.mehlman_rank}` : null,
    examRankText(u.nbme_rank ?? null, u.cms_rank ?? null) || null].filter(Boolean).join(', ') : 'not on the checklist';
  const head = [t.category && t.category.name, unitWords].filter(Boolean).join('; ');
  const lines = [`${t.name} (${head}).`];
  if (d.weakness) lines.push(`${d.weakness.band_words}, ${d.weakness.certainty_words}${d.weakness.trend_words ? `, ${d.weakness.trend_words}` : ''}: ${d.weakness.why}`);
  const tags = d.topic && d.topic.tags;
  if (tags && (tags.oncology || tags.disciplines.length)) lines.push(`Tags: ${[...(tags.oncology ? ['Oncology'] : []), ...tags.disciplines.map(x => x.word)].join(', ')}.`);
  if (d.misses) {
    lines.push(`Misses (${d.misses.total}): ${missLine(d.misses)}.`);
    for (const m of d.misses.items.slice(0, 5)) {
      lines.push(`- ${m.day} ${m.label}: ${m.result}${m.error_words ? `, ${m.error_words}` : ''}${m.confidence ? `, ${m.confidence}` : ''}${m.slip ? ' (slip)' : ''}.`
        + (m.rule ? ` Rule: ${m.rule}` : '') + (m.my_reasoning ? ` He thought: ${m.my_reasoning}` : '') + (m.look_alike ? ` Look-alike: ${m.look_alike}.` : ''));
    }
  }
  if (d.gaps && d.gaps.total) {
    lines.push(`Gaps (${d.gaps.total}):`);
    for (const g of d.gaps.items.slice(0, 3)) lines.push(`- ${g.day} ${g.origin}: ${g.text || g.gap || 'a card did not hold'}`);
  }
  if (d.cards && d.cards.count) lines.push(`Cards (${d.cards.count}${d.cards.capped ? '+' : ''}): ${d.cards.items.slice(0, 4).map(c => `${c.card_id} "${c.preview}"`).join('; ')}`);
  if (d.links && d.links.versus.length) lines.push(`Look-alikes: ${d.links.versus.slice(0, 5).map(v => `${v.other.name}${v.confused ? ' (mixed up)' : ''}${v.a_vs_b ? `: ${v.a_vs_b}` : ''}`).join('; ')}`);
  if (d.read) {
    const m = d.read.mehlman;
    if (m.items.length) lines.push(`Mehlman: ${m.items.map(i => `${i.title} p. ${i.page}${i.page_to ? `-${i.page_to}` : ''}`).join('; ')}.`);
    else if (m.match === 'weak') lines.push('Mehlman: nothing named on this.');
    if (d.read.amboss.url) lines.push(`AMBOSS article to send Mo to: ${t.name}, ${d.read.amboss.url}`);
  }
  if (d.lessons && d.lessons.items.length) lines.push(`Lessons: ${d.lessons.items.slice(0, 3).map(l => `${l.day} ${l.kind} ${l.outcome_words || ''}`.trim()).join('; ')}.`);
  if (d.lessons && d.lessons.misconceptions && d.lessons.misconceptions.length) lines.push(`Open misconceptions: ${d.lessons.misconceptions.map(m => m.belief).join('; ')}`);
  if (d.habits && d.habits.here.length) lines.push(`His traps here: ${d.habits.here.map(h => `${h.label} (${h.n}${h.refs.length ? `, ${h.refs.join(', ')}` : ''})`).join('; ')}.`);
  const text = lines.join('\n');
  return text.length > TEXT.claude_text ? text.slice(0, TEXT.claude_text - 1) + '…' : text;
}

// ---------------------------------------------------------------- size cap

// Lists cut down in this order until the reply fits; the header, weakness and Teach me are never cut.
const TRIMS = [
  d => d.misses && d.misses.items.length > 10 && (d.misses.items = d.misses.items.slice(0, 10)),
  d => d.cards && d.cards.items.length > 10 && (d.cards.items = d.cards.items.slice(0, 10), d.cards.capped = true),
  d => d.links && d.links.other.length > 6 && (d.links.more += d.links.other.length - 6, d.links.other = d.links.other.slice(0, 6)),
  d => d.gaps && d.gaps.items.length > 5 && (d.gaps.items = d.gaps.items.slice(0, 5)),
  d => d.misses && d.misses.items.length > 5 && (d.misses.items = d.misses.items.slice(0, 5)),
  d => d.read && d.read.mehlman.items.length > 2 && (d.read.mehlman.items = d.read.mehlman.items.slice(0, 2)),
  d => d.lessons && d.lessons.items.length > 3 && (d.lessons.items = d.lessons.items.slice(0, 3)),
  d => d.links && d.links.versus.length > 8 && (d.links.more += d.links.versus.length - 8, d.links.versus = d.links.versus.slice(0, 8)),
  d => d.cards && d.cards.items.length > 4 && (d.cards.items = d.cards.items.slice(0, 4), d.cards.capped = true),
  d => d.misses && d.misses.items.length > 3 && (d.misses.items = d.misses.items.slice(0, 3)),
  d => typeof d.text === 'string' && d.text.length > 2000 && (d.text = d.text.slice(0, 1999) + '…'),
];
export function fitSize(d, max) {
  for (const trim of TRIMS) {
    if (JSON.stringify(d).length <= max) break;
    trim(d);
  }
  return d;
}

// ---------------------------------------------------------------- topicDetail

/** The reply from the read batch (pure apart from `now`). */
export function shapeDetail(r, { audience, sections, now, anki = true, leakIndex = null }) {
  const t = r.topic[0];
  const topic = shapeTopic(t, r.aliases);
  topic.unit_line = unitLine(topic.unit);
  const score = r.score[0] || null;
  const d = { seq: (r.seq[0] || {}).seq || 0, topic, weakness: shapeWeakness(score, now) };
  const lessons = sections.has('lessons') ? shapeLessons(r.lessons, t.id, now) : null;
  d.teach = { open_request: lessons ? lessons.open_request : null, in_progress: lessons ? lessons.in_progress : null, last: lessons ? lessons.last : null };
  if (audience === 'page') d.teach.prompt = `Teach me ${t.name} (map: ${t.id})`;
  if (sections.has('misses')) {
    const sum = missSummary(r.missCounts);
    d.misses = { ...sum, line: missLine(sum), items: scrubLeaks(r.misses.map(m => shapeMiss(m, audience)), leakIndex) };
  }
  if (sections.has('gaps')) d.gaps = { total: r.gaps.length ? Number(r.gaps[0].total) || r.gaps.length : 0, items: r.gaps.map(g => shapeGap(g, audience)) };
  if (sections.has('cards')) {
    const rows = r.cards.slice(0, CAPS.cards);
    const fetchedAt = Math.max(0, ...rows.map(c => Number(c.fetched_at) || 0)) || null;
    d.cards = { deck: (rows[0] && rows[0].deck) || MY_DECK, count: rows.length, capped: r.cards.length > CAPS.cards, fetched_at: fetchedAt, items: rows.map(c => shapeCard(c, audience)) };
    if (audience === 'claude') d.cards.card_ids = rows.map(c => Number(c.card_id));
  }
  if (r.photos) d.photos = [...shapePhotos(r.photos), ...shapePictures(r.pictures)];
  if (sections.has('links')) d.links = shapeLinks(r.links, { id: t.id, name: t.name, yield: t.yield }, { now, score });
  if (sections.has('read')) d.read = shapeRead(t, r.mehlman, r.fetches, audience);
  if (lessons) {
    d.lessons = { items: lessons.items, memory: r.memory.map(m => ({ id: m.id, tactic: m.tactic, note: cut(m.note, 300), pinned: m.status === 'pinned' })),
      misconceptions: (r.misconceptions || []).map(shapeMisconception) };
  }
  const refreshing = anki ? staleKinds(r.fetches, now).filter(k => (k === 'cards' ? sections.has('cards') : sections.has('read'))) : [];
  const status = k => { const f = r.fetches.find(x => x.kind === k); return !anki ? 'off' : !f ? 'never' : f.status; };
  d.meta = { refreshing, updated_at: Math.max(Number(t.updated_at) || 0, Number(score && score.computed_at) || 0) || null, last: lastChangeOf(r.last),
    sources_status: { cards: status('cards'), mehlman: status('mehlman') } };
  const habits = shapeTopicHabits(r.habitItems, r.habits);
  if (habits) d.habits = habits;
  if (audience === 'claude') {
    d.as_of_seq = d.seq;
    d.text = claudeText(d);
    const { seq, topic, weakness, ...rest } = d;
    return { seq, topic, weakness, for_explaining: forExplaining(d), ...rest };
  }
  return d;
}

export async function topicDetail(env, user, topicId, opts = {}) {
  const o = readOptions(opts);
  const now = opts.now ?? Date.now();
  const id = String(topicId || '').trim();
  if (!id || id.length > 120) return null;
  if (opts.since != null && Number.isInteger(Number(opts.since)) && Number(opts.since) > 0) {
    const c = await changedSince(env, user, id, Number(opts.since));
    if (!c.changed) return { unchanged: true, seq: c.seq };
  }
  let r = await readDetail(env, user, id, o);
  const t = r.topic[0];
  if (!t) return null;
  if (t.status === 'merged' && t.merged_into && t.merged_into !== id) return { redirect: t.merged_into };
  const anki = !!env.ANKI_MCP_URL;
  const hubMisses = rows => (rows.misses || []).filter(m => m.block_id).map(m => m.id);
  const indexFor = async rows => (hubMisses(rows).length ? leakIndexFor(env, user, { missIds: hubMisses(rows) }).catch(() => null) : null);
  let leakIndex = await indexFor(r);
  let d = shapeDetail(r, { ...o, now, anki, leakIndex });
  let notReached = false;
  if (d.meta.refreshing.length && !opts.prefetch) {
    const run = refreshSources(env, user, id, { kinds: d.meta.refreshing, now }).catch(e => { console.error('refreshSources failed', e && e.message); return null; });
    if (opts.awaitSourcesMs > 0) {
      const ms = Math.min(Number(opts.awaitSourcesMs), AWAIT_MS * 2);
      const done = await Promise.race([run.then(() => true), new Promise(res => setTimeout(() => res(false), ms))]);
      if (done) {
        const before = hubMisses(r).join('|');
        r = await readDetail(env, user, id, o);
        if (hubMisses(r).join('|') !== before) leakIndex = await indexFor(r);
        d = shapeDetail(r, { ...o, now: opts.now ?? Date.now(), anki, leakIndex });
        d.meta.refreshing = [];
      } else notReached = true;
    }
    waitFor(opts.ctx, run);
  }
  if (anki && !opts.prefetch && o.audience === 'page' && r.pictures && !r.fetches.some(f => f.kind === 'pictures')) waitFor(opts.ctx, attachOnOpen(env, user, id));
  if (notReached) for (const k of d.meta.refreshing) d.meta.sources_status[k] = 'not reached';
  return fitSize(d, SIZE[o.audience]);
}

function waitFor(ctx, p) {
  const wu = ctx && typeof ctx.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : null;
  if (wu) wu(p);
}

// ---------------------------------------------------------------- routes

const notReady = e => { if (noTable(e)) throw new HttpError(503, "The map isn't set up yet."); throw e; };

// GET /api/map/topic/:id[?since=<seq>&include=a,b&misses=<n>&prefetch=1] (prefetch: a hover's read, no source look-ups)
export async function topicRoute(request, env, ctx, params, url, user) {
  const include = url.searchParams.get('include');
  const d = await topicDetail(env, user, params.id, {
    audience: 'page', since: url.searchParams.get('since'), ctx, prefetch: url.searchParams.get('prefetch') === '1',
    include: include ? include.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    missesLimit: url.searchParams.get('misses') != null ? Number(url.searchParams.get('misses')) : undefined,
  }).catch(notReady);
  if (!d) return json({ error: 'There is no topic with that id on the map.' }, 404);
  return json(d);
}

export async function cardRoute(request, env, ctx, params, url, user) {
  const id = Number(params.card_id);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'A card id is a whole number.' }, 400);
  const c = await cardDetail(env, user, id, { topicId: url.searchParams.get('topic') || null }).catch(notReady);
  if (!c) return json({ error: "That card isn't in the hub's copy of your cards yet." }, 404);
  return json(c);
}

// POST /api/map/topic/:id/refresh — "Refresh from Anki": answers at once and refreshes in the background.
export async function refreshRoute(request, env, ctx, params, url, user) {
  const id = String(params.id || '');
  const t = await env.DB.prepare(`SELECT id, status, merged_into FROM topics WHERE user_id = ? AND id = ?`).bind(user, id).first().catch(notReady);
  if (!t) return json({ error: 'There is no topic with that id on the map.' }, 404);
  if (!env.ANKI_MCP_URL) return json({ error: 'Anki is not connected, so there is nothing to refresh from.' }, 503);
  const run = refreshSources(env, user, id, { force: true, minAgeMs: 30_000 }).catch(e => { console.error('refresh failed', e && e.message); return null; });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(run);
  else await run;
  return json({ ok: true, refreshing: ['cards', 'mehlman'] }, 202);
}
