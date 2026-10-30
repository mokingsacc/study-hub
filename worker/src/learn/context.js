import { buildLeakIndex } from '../checks.js';
import { leakIndexFor, looksLikeStem } from '../map/guard.js';
import { topicObjectives } from '../map/uworld-objectives.js';
import { topicPassages, pageWords } from '../map/mehlman-summary.js';

export const LOOKALIKES_MAX = 6;
export const MISSES_MAX = 12, GAPS_MAX = 10, LESSONS_MAX = 5, BANK_MAX = 8, FAQ_CONTEXT = 10;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayLabel = d => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : null; };
const parse = (s, d) => { if (s == null || s === '') return d; try { return JSON.parse(s); } catch { return d; } };
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const noTable = e => /no such table|no such column/i.test(String(e && e.message));

// Fail-side evidence: a missed question or re-test, a card lapse, a gap or shaky check, a stated gap, any lesson.
export const FAIL_SQL = `held = 0 AND (
  (kind IN ('question', 'retest') AND result IN ('wrong', 'omitted', 'missed', 'flawed')) OR kind IN ('card_lapse', 'gap_stated', 'lesson_probe', 'lesson_final', 'lesson_check', 'pair_item')
  OR (kind = 'card_check' AND coalesce(verdict, 'gap') IN ('gap', 'shaky')))`;
const MISS_SQL = `kind IN ('question', 'retest') AND result IN ('wrong', 'omitted', 'missed')`;

/** The pair's key: a learn_cards row is stored once per pair, a_id < b_id. */
export const pairKey = (x, y) => (String(x) < String(y) ? [String(x), String(y)] : [String(y), String(x)]);

export async function readTopic(env, user, topicId, { allPairs = true } = {}) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const r = await env.DB.batch([
    q(`SELECT t.id, t.name, t.unit_id, t.status, t.merged_into, s.band, s.t, s.seen FROM topics t LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
      WHERE t.user_id = ? AND t.id = ?`, user, topicId),
    q(`SELECT o.id, o.name, k.a_vs_b, k.b_vs_a, k.from_id, k.confusion, s.band, s.t, s.seen
      FROM links k JOIN topics o ON o.user_id = k.user_id AND o.id = CASE WHEN k.from_id = ?2 THEN k.to_id ELSE k.from_id END
      LEFT JOIN topic_scores s ON s.user_id = o.user_id AND s.topic_id = o.id
      WHERE k.user_id = ?1 AND (k.from_id = ?2 OR k.to_id = ?2) AND k.type = 'versus' AND k.status IN ('active', 'proposed') AND o.status IN ('proposed', 'confirmed')
      ORDER BY k.confusion DESC, k.strength DESC LIMIT ${LOOKALIKES_MAX}`, user, topicId),
    q(`SELECT id, label, day, at, result, error_type, confidence, rule, my_reasoning, look_alikes, block_id, q_index FROM misses_live
      WHERE user_id = ? AND topic_id = ? ORDER BY at DESC LIMIT ${MISSES_MAX}`, user, topicId),
    q(`SELECT day, at, verdict, gap, said FROM gaps WHERE user_id = ? AND topic_id = ? AND held = 0 ORDER BY at DESC LIMIT ${GAPS_MAX}`, user, topicId),
    q(`SELECT day, outcome, what_clicked, mo_rating, kind FROM lessons WHERE user_id = ?1 AND (topic_id = ?2 OR pair_topic_id = ?2) AND ended_at IS NOT NULL
      ORDER BY ended_at DESC LIMIT ${LESSONS_MAX}`, user, topicId),
    q(`SELECT belief FROM misconceptions WHERE user_id = ? AND topic_id = ? AND status <> 'closed' ORDER BY coalesce(last_seen, first_seen) DESC LIMIT 5`, user, topicId),
    ...['nbme', 'cms'].map(coll => q(`SELECT x.cite, x.coll, x.task, x.clue, x.distractor, x.why_wrong, x.choices_json, x.stem, x.qs, x.expl
      FROM xq x JOIN topics t ON t.user_id = x.user_id AND t.unit_id = x.unit_id
      WHERE t.user_id = ? AND t.id = ? AND x.coll = ? AND x.clue IS NOT NULL ORDER BY x.ans = '', x.rid LIMIT ${BANK_MAX}`, user, topicId, coll)),
    q(`SELECT id, module, text, corrected FROM learn_points WHERE user_id = ? AND topic_id = ? ORDER BY corrected DESC, sort, id`, user, topicId),
    q(`SELECT id, topic_id, other_id, q, a, usd, created_at FROM learn_faq WHERE user_id = ? AND (topic_id = ?2 OR other_id = ?2) ORDER BY created_at DESC LIMIT 30`, user, topicId),
    q(`SELECT body_json, cites_json, ev_mark, version, change_note, trigger, model, usd, created_at, updated_at FROM learn_summaries WHERE user_id = ? AND topic_id = ?`, user, topicId),
    q(`SELECT a_id, b_id, body_json, version, change_note, updated_at FROM learn_cards WHERE user_id = ?1 AND (a_id = ?2 OR b_id = ?2)`, user, topicId),
    q(`SELECT max(at) AS ev, sum(CASE WHEN ${MISS_SQL} AND at > coalesce((SELECT ev_mark FROM learn_summaries WHERE user_id = ?1 AND topic_id = ?2), 0) THEN 1 ELSE 0 END) AS new_misses
      FROM evidence WHERE user_id = ?1 AND topic_id = ?2 AND ${FAIL_SQL}`, user, topicId),
  ]);
  const [topic, links, misses, gaps, lessons, beliefs, nbmeBank, cmsBank, points, faq, summary, cards, ev] = r.map(x => x.results || []);
  const bank = [...nbmeBank, ...cmsBank];
  const t = topic[0];
  if (!t) return null;
  const others = links.map(l => ({ id: l.id, name: l.name, band: l.band || null, seen: !!l.seen, t1000: l.t == null ? null : Math.round(Number(l.t) * 1000),
    // the link's own separating fact, written from this topic's side
    vs: (l.from_id === topicId ? l.a_vs_b : l.b_vs_a) || null }));
  const ids = new Set(others.map(o => o.id));
  return {
    topic: { id: t.id, name: t.name, unit_id: t.unit_id, status: t.status, merged_into: t.merged_into, band: t.band || null, seen: !!t.seen,
      t1000: t.t == null ? null : Math.round(Number(t.t) * 1000) },
    others, misses, gaps, lessons, beliefs: beliefs.map(b => b.belief), bank, points,
    faq: faq.map(f => ({ ...f, usd: Number(f.usd) || 0 })),
    summary: summary[0] || null,
    cards: allPairs ? cards : cards.filter(c => ids.has(c.a_id === topicId ? c.b_id : c.a_id)),
    ev: Number(ev[0] && ev[0].ev) || 0, newMisses: Number(ev[0] && ev[0].new_misses) || 0,
  };
}

/** The exam bank's rows as the model sees them: label and study fields only (a tempting answer is its option text). */
export function bankFields(row) {
  const ch = parse(row.choices_json, []);
  const opt = l => { const c = (Array.isArray(ch) ? ch : []).find(x => x && x[0] === l); return c ? cut(c[1], 60) : null; };
  return { cite: row.cite, task: row.task || null, key_clue: cut(row.clue, 160) || null, tempting: row.distractor ? opt(row.distractor) : null,
    why_wrong: cut(row.why_wrong, 220) || null };
}

/** A miss as the model sees it (whitelisted keys; free text that reads like question text is dropped). */
export function missFields(m) {
  const keep = s => (s && !looksLikeStem(s) ? cut(s, 300) : null);
  return { cite: m.label, day: dayLabel(m.day), result: m.result, error_type: m.error_type || null, confidence: m.confidence || null,
    rule: keep(m.rule), you_thought: keep(m.my_reasoning), look_alikes: keep(m.look_alikes) };
}
export const gapCite = g => `Gap ${dayLabel(g.day) || ''}`.trim();
export const lessonCite = l => `Lesson ${dayLabel(l.day) || ''}`.trim();

export async function gatherContext(env, user, t) {
  const [objectives, mel] = await Promise.all([
    topicObjectives(env, user, t.topic.id, { limit: 8 }).catch(e => { if (noTable(e)) return []; throw e; }),
    topicPassages(env, user, t.topic.id).catch(e => { if (noTable(e)) return null; throw e; }),
  ]);
  const by = coll => t.bank.filter(x => x.coll === coll).slice(0, BANK_MAX);
  const nbme = by('nbme'), cms = by('cms');
  const misses = t.misses.map(missFields);
  const gaps = t.gaps.map(g => ({ cite: gapCite(g), verdict: g.verdict || null, gap: cut(g.gap, 300), said: g.said && !looksLikeStem(g.said) ? cut(g.said, 200) : null }));
  const lessons = t.lessons.map(l => ({ cite: lessonCite(l), kind: l.kind, outcome: l.outcome || null, what_clicked: l.what_clicked ? cut(l.what_clicked, 240) : null,
    his_rating: l.mo_rating ?? null }));
  const uworld = objectives.map(o => ({ cite: `UW ${o.qid}`, day: dayLabel(o.day), outcome: o.outcome, objective: o.objective ? cut(o.objective, 400) : null }));
  const mehlman = mel ? mel.items.map(p => ({ cite: pageWords(p) || null, book: p.title, heading: p.heading, text: cut(p.text, 1600) })).filter(p => p.cite) : [];
  const low = s => String(s || '').toLowerCase();
  const lookalikes = t.others.map(o => ({
    id: o.id, name: o.name, band: o.band, link_fact: o.vs ? cut(o.vs, 300) : null,
    your_misses_naming_it: misses.filter(m => low(m.look_alikes).includes(low(o.name))).map(m => m.cite),
  }));
  const ctx = {
    topic: { id: t.topic.id, name: t.topic.name, band: t.topic.band },
    lookalikes,
    nbme_questions: nbme.map(bankFields), cms_questions: cms.map(bankFields), uworld_objectives: uworld,
    your_misses: misses, your_gaps: gaps, your_lessons: lessons, wrong_beliefs: t.beliefs,
    mehlman, ajmonics: t.points.map(p => p.text),
    questions_you_asked: t.faq.slice(0, FAQ_CONTEXT).map(f => f.q),
    previous_summary: t.summary ? { version: Number(t.summary.version) || 1, written: dayLabel(new Date(Number(t.summary.updated_at)).toISOString()), ...parse(t.summary.body_json, {}) } : null,
  };
  const allowed = {
    nbme: new Set(nbme.map(x => x.cite)), cms: new Set(cms.map(x => x.cite)), uworld: new Set(uworld.map(x => x.cite)),
    mine: new Set([...misses.map(m => m.cite), ...gaps.map(g => g.cite), ...lessons.map(l => l.cite)]),
    pages: new Set(mehlman.map(p => p.cite)),
    others: new Set(t.others.map(o => o.id)),
  };
  const leakIndex = await leakIndexFor(env, user, { topicIds: [t.topic.id, ...t.others.map(o => o.id)], missIds: t.misses.filter(m => m.block_id).map(m => m.id) })
    .catch(e => { if (noTable(e)) return new Set(); throw e; });
  for (const x of t.bank) {
    const ch = parse(x.choices_json, []);
    for (const run of buildLeakIndex({ stem: x.stem, lead: x.qs, expl: x.expl, opts: (Array.isArray(ch) ? ch : []).map(c => ({ t: c && c[1] })) })) leakIndex.add(run);
  }
  return { ctx, allowed, leakIndex };
}
