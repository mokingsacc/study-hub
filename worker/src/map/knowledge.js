import { json } from '../util.js';
import { leaks } from '../checks.js';
import { leakIndexFor, stemSafe, questionSafe } from './guard.js';
import { tablesPresent, laneOf, yieldOf } from './teach-priority.js';
import { rankJoin, RANK_COLS, examRankText } from '../exam-ranks.js';

export const CAPS = { words: 5, clicked: 5, lessons: 20, cards: 10, mehlman: 5, related: 8, misconceptions: 10 };
export const TEXT = { words: 600, clicked: 200, short: 200, front: 240 };
export const BRIEF_MAX = 1500;
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const cap = (s, n) => { if (s == null) return null; const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t || null; };
const num = v => (v == null || v === '' ? null : Number(v));

/** Every read the page needs, in one D1 batch. */
export async function knowledgeReads(env, user, topicId) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const has = await tablesPresent(env, user, ['misconceptions', 'card_cache', 'resource_links', 'resources', 'topic_embeddings']);
  const none = () => q(`SELECT NULL AS id WHERE 0 AND ? = ?`, user, topicId);
  const res = await env.DB.batch([
    q(`SELECT t.id, t.name, t.kind, t.status, t.merged_into, t.category_id, c.name AS category, t.yield, u.num AS unit_num, u.name AS unit_name, u.lane,
         u.mehlman_rank, ${RANK_COLS}, coalesce(s.seen, 0) AS seen, s.band, s.t
       FROM topics t LEFT JOIN categories c ON c.user_id = t.user_id AND c.id = t.category_id LEFT JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id
       ${rankJoin('u')}
       LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id WHERE t.user_id = ? AND t.id = ?`, user, topicId),
    q(`SELECT id, day, kind, status, abandon_reason, outcome, mo_rating, mo_rating_why, what_clicked, teach_back_text, teach_back_json, final_result, minutes, goal,
         weak_spot, card_id, card_note_id, card_action, started_at, ended_at, topic_id, pair_topic_id, tactics_json,
         (coalesce(probe_json, '[]') NOT IN ('[]', '') OR coalesce(steps_json, '[]') NOT IN ('[]', '')) AS kept
       FROM lessons WHERE user_id = ?1 AND (topic_id = ?2 OR pair_topic_id = ?2)
         AND (status = 'done' OR (status = 'abandoned' AND started_at IS NOT NULL AND coalesce(abandon_reason, '') <> 'undone'))
       ORDER BY coalesce(ended_at, started_at) DESC LIMIT 40`, user, topicId),
    has.has('misconceptions') ? q(`SELECT id, belief, words, status, ref, first_seen, last_seen, seen_n, targeted_at, closed_at, closed_by FROM misconceptions
       WHERE user_id = ? AND topic_id = ? ORDER BY status = 'closed', last_seen DESC LIMIT 30`, user, topicId) : none(),
    has.has('card_cache') ? q(`SELECT l.id AS lesson_id, l.day, l.card_id, l.card_note_id, l.card_action, c.question AS front FROM lessons l
       LEFT JOIN card_cache c ON c.user_id = l.user_id AND c.card_id = l.card_id
       WHERE l.user_id = ? AND l.topic_id = ? AND l.card_id IS NOT NULL AND l.card_action IN ('added','edited_existing')
       ORDER BY l.ended_at DESC LIMIT 20`, user, topicId)
      : q(`SELECT id AS lesson_id, day, card_id, card_note_id, card_action, NULL AS front FROM lessons WHERE user_id = ? AND topic_id = ? AND card_id IS NOT NULL
       AND card_action IN ('added','edited_existing') ORDER BY ended_at DESC LIMIT 20`, user, topicId),
    has.has('resource_links') && has.has('resources') ? q(`SELECT r.resource_id, coalesce(x.title, r.label, r.resource_id) AS title, r.page, r.page_to, r.section FROM resource_links r
       LEFT JOIN resources x ON x.user_id = r.user_id AND x.id = r.resource_id
       WHERE r.user_id = ? AND r.topic_id = ? AND r.kind = 'mehlman' AND r.status = 'live' ORDER BY r.rank DESC LIMIT 8`, user, topicId) : none(),
    q(`SELECT k.id, k.type, k.from_id, k.to_id, k.confusion, k.strength, o.id AS other_id, o.name, s.band FROM links k
       JOIN topics o ON o.user_id = k.user_id AND o.id = CASE WHEN k.from_id = ?2 THEN k.to_id ELSE k.from_id END AND o.status IN ('proposed','confirmed')
       LEFT JOIN topic_scores s ON s.user_id = o.user_id AND s.topic_id = o.id
       WHERE k.user_id = ?1 AND (k.from_id = ?2 OR k.to_id = ?2) AND k.status IN ('active','proposed')
       ORDER BY k.confusion DESC, k.strength DESC LIMIT 12`, user, topicId),
    has.has('topic_embeddings') ? q(`SELECT o.id, o.name, CAST(json_extract(j.value, '$[1]') AS INTEGER) AS s100, s.band
       FROM topic_embeddings e JOIN json_each(e.neighbours) j
       JOIN topics o ON o.user_id = e.user_id AND o.id = json_extract(j.value, '$[0]') AND o.status IN ('proposed','confirmed')
       LEFT JOIN topic_scores s ON s.user_id = o.user_id AND s.topic_id = o.id
       WHERE e.user_id = ? AND e.topic_id = ? ORDER BY j.key LIMIT 8`, user, topicId) : none(),
    q(`SELECT coalesce(max(seq), 0) AS seq FROM map_events WHERE user_id = ?`, user),
  ]);
  const [topic, lessons, miscs, cards, mehlman, links, similar, seq] = res.map(r => r.results || []);
  return { topic: topic[0] || null, lessons, misconceptions: miscs, cards, mehlman, links, similar, seq: (seq[0] || {}).seq || 0 };
}

export function safeText(text, max, index, { stem = true } = {}) {
  const t = cap(text, max);
  if (!t) return null;
  if (stem ? !stemSafe(t) : !questionSafe(t)) return null;
  if (index && index.size && leaks(index, t)) return null;
  return t;
}

export function knowledgePage(r, { index = null, now = Date.now() } = {}) {
  const t = r.topic;
  if (!t) return null;
  if (t.status === 'merged' && t.merged_into) return { redirect: t.merged_into };
  const own = l => l.topic_id === t.id;
  const lessons = r.lessons || [];
  const done = lessons.filter(l => l.status === 'done' && l.kind !== 'pair_test');
  const words = [], clicked = [];
  for (const l of lessons) {
    if (own(l) && words.length < CAPS.words) {
      const w = safeText(l.teach_back_text, TEXT.words, index);
      if (w) words.push({ lesson_id: l.id, day: l.day, text: w, judgement: (parse(l.teach_back_json, null) || {}).judgement || null });
    }
    if (clicked.length < CAPS.clicked) {
      const c = safeText(l.what_clicked, TEXT.clicked, index);
      if (c) clicked.push({ lesson_id: l.id, day: l.day, text: c });
    }
  }
  const misc = (r.misconceptions || []).map(m => ({ id: m.id, belief: safeText(m.belief, TEXT.short, index, { stem: false }), words: m.words, status: m.status,
    first_seen: m.first_seen, ...(m.status === 'closed' ? { closed_at: m.closed_at, closed_by: m.closed_by } : {}) })).filter(m => m.belief);
  const seenCards = new Set();
  const cards = [];
  for (const c of r.cards || []) {
    if (seenCards.has(c.card_id) || cards.length >= CAPS.cards) continue;
    seenCards.add(c.card_id);
    cards.push({ card_id: c.card_id, note_id: c.card_note_id ?? null, front: safeText(c.front, TEXT.front, index, { stem: false }), lesson_id: c.lesson_id, day: c.day, action: c.card_action });
  }
  const related = [];
  const seen = new Set([t.id]);
  for (const k of r.links || []) {
    if (seen.has(k.other_id) || related.length >= CAPS.related) continue;
    seen.add(k.other_id);
    related.push({ id: k.other_id, name: k.name, via: k.type, band: k.band || 'unseen', ...(k.type === 'versus' && k.confusion != null ? { confusion: Math.round(Number(k.confusion) * 100) / 100 } : {}) });
  }
  for (const s of r.similar || []) {
    if (seen.has(s.id) || related.length >= CAPS.related) continue;
    seen.add(s.id);
    related.push({ id: s.id, name: s.name, via: 'similar', band: s.band || 'unseen', s100: num(s.s100) });
  }
  const ratings = done.map(l => l.mo_rating).filter(x => Number.isInteger(x));
  return {
    topic: { id: t.id, name: t.name, kind: t.kind, category: { id: t.category_id, name: t.category || null }, band: t.band || 'unseen',
      t100: t.seen && t.t != null ? Math.round(t.t * 100) : null, lane: t.lane || laneOf(yieldOf(t)), yield: num(t.yield),
      unit: t.unit_num != null || t.unit_name ? { num: num(t.unit_num), name: t.unit_name || null, mehlman_rank: num(t.mehlman_rank),
        exam_rank: examRankText(t.nbme_rank ?? null, t.cms_rank ?? null) || null } : null },
    as_of_seq: r.seq, as_of: now,
    summary: {
      lessons: done.length, landed: done.filter(l => l.outcome === 'landed').length, stopped: lessons.filter(l => l.status === 'abandoned').length,
      last_day: (lessons[0] || {}).day || null, mean_rating: ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length * 10) / 10 : null,
      cards: cards.length, misconceptions: { open: misc.filter(m => m.status !== 'closed').length, closed: misc.filter(m => m.status === 'closed').length },
    },
    in_his_words: words,
    clicked,
    misconceptions: { met: misc.filter(m => m.status !== 'closed').slice(0, CAPS.misconceptions), closed: misc.filter(m => m.status === 'closed').slice(0, CAPS.misconceptions) },
    cards,
    mehlman: (r.mehlman || []).slice(0, CAPS.mehlman).map(m => ({ resource_id: m.resource_id, title: cap(m.title, 120), page: num(m.page), page_to: num(m.page_to), section: cap(m.section, 120) })),
    lessons: lessons.slice(0, CAPS.lessons).map(l => ({ id: l.id, day: l.day, kind: l.kind, ...(own(l) ? {} : { as_pair: true }),
      outcome: l.status === 'abandoned' ? (l.abandon_reason === 'timeout' && !l.kept ? 'not_saved' : 'stopped_early') : l.outcome,
      mo_rating: l.mo_rating ?? null, why: safeText(l.mo_rating_why, TEXT.short, index), minutes: l.minutes ?? null, final_result: l.final_result || null,
      goal: safeText(l.goal, TEXT.short, index), weak_spot: safeText(l.weak_spot, TEXT.short, index), tactics: parse(l.tactics_json, []) })),
    related,
  };
}

/** The compact summary Claude reads before teaching (pure, at most BRIEF_MAX characters of JSON). */
export function knowledgeBrief(page) {
  if (!page || !page.summary) return null;
  const s = page.summary;
  const out = {
    lessons: s.lessons, landed: s.landed, ...(s.stopped ? { stopped: s.stopped } : {}), ...(s.last_day ? { last_day: s.last_day } : {}),
    ratings: page.lessons.filter(l => l.mo_rating != null).slice(0, 5).map(l => l.mo_rating),
    his_words: page.in_his_words.slice(0, 2).map(w => ({ day: w.day, text: cap(w.text, 300) })),
    clicked: page.clicked.slice(0, 2).map(c => cap(c.text, 160)),
    closed: page.misconceptions.closed.slice(0, 2).map(m => cap(m.belief, 120)),
    cards: page.cards.slice(0, 4).map(c => c.card_id),
    mehlman: page.mehlman.slice(0, 2).map(m => `${m.title}${m.page != null ? ` p.${m.page}` : ''}`),
    related: page.related.slice(0, 4).map(r => r.name),
  };
  for (const k of Object.keys(out)) if (Array.isArray(out[k]) && !out[k].length) delete out[k];
  const order = ['related', 'mehlman', 'cards', 'closed', 'clicked', 'his_words', 'ratings'];
  for (const k of order) {
    if (JSON.stringify(out).length <= BRIEF_MAX) break;
    if (Array.isArray(out[k]) && out[k].length > 1) out[k] = out[k].slice(0, 1);
  }
  for (const k of order) { if (JSON.stringify(out).length <= BRIEF_MAX) break; delete out[k]; }
  return out;
}

/** The page for a topic, merged names followed once; null when it is not on the map; {ready: false} before 0015. */
export async function topicKnowledge(env, user, topicId, { now = Date.now() } = {}) {
  try {
    let reads = await knowledgeReads(env, user, topicId);
    if (reads.topic && reads.topic.status === 'merged' && reads.topic.merged_into) reads = await knowledgeReads(env, user, reads.topic.merged_into);
    if (!reads.topic) return null;
    const index = await leakIndexFor(env, user, { topicIds: [reads.topic.id] }).catch(() => null);
    return knowledgePage(reads, { index, now });
  } catch (e) {
    if (noTable(e)) return { ready: false, note: 'The "What you know" page arrives with migration 0015.' };
    throw e;
  }
}

/** The compact summary for a topic (teach_next's brief, map_topic), or null. */
export async function knowledgeBriefFor(env, user, topicId) {
  if (!topicId) return null;
  const page = await topicKnowledge(env, user, topicId);
  return page && page.summary ? knowledgeBrief(page) : null;
}

// GET /api/map/topic/:id/knowledge -> the page (404 when the topic is not on the map).
export async function knowledgeRoute(request, env, ctx, params, url, user) {
  const id = decodeURIComponent(params.id || '');
  if (!id || id.length > 120) return json({ error: 'Which topic?' }, 400);
  const page = await topicKnowledge(env, user, id);
  if (!page) return json({ error: 'That topic is not on the map.' }, 404);
  return json(page);
}
