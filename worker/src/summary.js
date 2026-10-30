import { HttpError, json, londonDay, safeParse, hubQuestionLabel, questionLink } from './util.js';
import { all, getSitting, getQuestions } from './db.js';
import { buildLeakIndex, leaks, normError, NO_CARD_ERRORS } from './checks.js';
import { confFor } from '../../public/js/conf-words.js';

const CONF = { 1: 'sure', 2: 'leaning', 3: 'guessed' };
const NO_MEHLMAN = 'Nothing specific in your Mehlman notes.';
const pick = (m, k) => (m ? m[k] ?? m[String(k)] : undefined);
const letter = v => (v == null ? null : String(v).trim().toUpperCase() || null);

// Most useful first: wrong while sure, then a topic missed before, then wrong, then right for a flawed reason.
function rank(m) {
  return (m.verdict === 'wrong' ? 0 : 4) + (m.conf === 'sure' ? 0 : 1) + (m.seen_before.length ? 0 : 1);
}

export async function buildSummary(env, sittingId) {
  const sitting = await getSitting(env, sittingId);
  if (!sitting.exam_id) throw new HttpError(400, 'This sitting has no questions in the hub.');
  const rows = await all(env,
    `SELECT a.*, b.state_json, b.idx AS block_idx, t.text AS tr_text, t.segments_json AS tr_segments FROM analyses a JOIN blocks b ON b.id = a.block_id
     LEFT JOIN transcripts t ON t.block_id = a.block_id AND t.q_index = a.q_index
     WHERE b.sitting_id = ? AND a.status = 'done' AND a.verdict IN ('wrong', 'right_flawed')
       AND (a.verdict = 'wrong' OR a.mo_override IS NULL OR a.mo_override != 'sound')
     ORDER BY b.idx, a.q_index`, sittingId);
  const [totals, earlier, questions] = await Promise.all([
    all(env, 'SELECT sum(correct) AS correct, sum(scored) AS scored, count(*) AS blocks FROM blocks WHERE sitting_id = ? AND ended_at IS NOT NULL', sittingId),
    all(env, `SELECT lower(a.topic) AS topic, s.name FROM analyses a JOIN blocks b ON b.id = a.block_id JOIN sittings s ON s.id = b.sitting_id
      WHERE b.sitting_id != ? AND a.status = 'done' AND a.verdict IN ('wrong', 'right_flawed') AND a.topic IS NOT NULL`, sittingId),
    getQuestions(env, sitting.exam_id, [...new Set(rows.map(r => r.q_index))]),
  ]);
  const before = new Map();
  for (const e of earlier) {
    if (!before.has(e.topic)) before.set(e.topic, new Set());
    before.get(e.topic).add(e.name);
  }
  const mistakes = [];
  for (const r of rows) {
    const q = questions[r.q_index];
    if (!q) continue;
    const index = buildLeakIndex(q);
    const safe = t => (t && !leaks(index, t) ? String(t).trim() : null);
    const state = safeParse(r.state_json, {}) || {};
    const errorType = normError(r.error_confirmed || r.error_type) || 'knowledge gap';
    const topic = safe(r.topic);
    mistakes.push({
      label: hubQuestionLabel(sitting.name, q.num, r.q_index, r.block_idx),   // unique in the sitting (B3-3)
      link: questionLink(env.HUB_ORIGIN, sittingId, r.q_index),
      verdict: r.verdict, flaw: r.verdict === 'right_flawed' ? r.flaw_kind : null,
      error_type: errorType, card_worthy: !NO_CARD_ERRORS.includes(errorType),
      picked: letter(pick(state.ans, r.q_index)), answer: letter(q.answer),
      conf: CONF[confFor(pick(state.conf, r.q_index), { text: r.tr_text, segments_json: r.tr_segments }).conf] || null, flagged: !!pick(state.mark, r.q_index),
      topic, system: safe(r.system), rule: safe(r.rule), gap: safe(r.gap), look_alike: safe(r.look_alike),
      your_reasoning: safe(r.paraphrase),
      mehlman: r.mehlman_note && r.mehlman_note !== NO_MEHLMAN ? safe(r.mehlman_note) : null, mehlman_src: safe(r.mehlman_src),
      seen_before: topic && before.has(topic.toLowerCase()) ? [...before.get(topic.toLowerCase())] : [],
    });
  }
  mistakes.sort((a, b) => rank(a) - rank(b));
  const count = (list, k) => Object.entries(list.reduce((o, m) => { if (m[k]) o[m[k]] = (o[m[k]] || 0) + 1; return o; }, {})).sort((a, b) => b[1] - a[1]);
  const t = totals[0] || {};
  const date = sitting.finished_at ? londonDay(sitting.finished_at) : sitting.scheduled_date || londonDay(sitting.created_at);
  return {
    sitting: sitting.name, date,
    score: t.scored ? { correct: t.correct, scored: t.scored, pct: Math.round((t.correct / t.scored) * 1000) / 10 } : null,
    wrong: mistakes.filter(m => m.verdict === 'wrong').length,
    flawed: mistakes.filter(m => m.verdict === 'right_flawed').length,
    lucky_guesses: mistakes.filter(m => m.flaw === 'lucky_guess').length,
    by_system: count(mistakes, 'system'), by_error: count(mistakes, 'error_type'),
    mistakes,
  };
}

const VERDICT = m => (m.verdict === 'wrong'
  ? `wrong${m.conf ? `, you were ${m.conf}` : ''}${m.picked ? ` (picked ${m.picked}, answer ${m.answer})` : ' (not answered)'}`
  : `right but ${m.flaw === 'lucky_guess' ? 'a lucky guess' : m.flaw === 'misread_detail' ? 'a detail misread' : m.flaw === 'shaky_elimination' ? 'an option ruled out for a wrong reason' : 'for a wrong reason'}`);

export function summaryText(s) {
  const out = [`Step 2 Practice Hub: ${s.sitting} (${s.date}).${s.score ? ` Score ${s.score.correct} of ${s.score.scored} (${s.score.pct}%).` : ''}`];
  out.push(`Mistakes: ${s.wrong} wrong, ${s.flawed} right with flawed reasoning${s.lucky_guesses ? ` (${s.lucky_guesses} lucky ${s.lucky_guesses === 1 ? 'guess' : 'guesses'})` : ''}.`);
  if (s.by_system.length) out.push(`Weakest systems: ${s.by_system.map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  if (s.by_error.length) out.push(`Error types: ${s.by_error.map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  const cards = s.mistakes.filter(m => m.card_worthy), habits = s.mistakes.filter(m => !m.card_worthy);
  if (cards.length) {
    out.push('', 'Mistakes, most useful first:');
    cards.forEach((m, i) => {
      out.push('', `${i + 1}. ${m.label} · ${[m.system, m.error_type].filter(Boolean).join(' · ')} · ${VERDICT(m)}${m.flagged ? ' · flagged' : ''}`);
      if (m.link) out.push(`   Open it: ${m.link}`);
      if (m.topic) out.push(`   Topic: ${m.topic}`);
      if (m.your_reasoning) out.push(`   My reasoning: ${m.your_reasoning}`);
      if (m.gap) out.push(`   The gap: ${m.gap}`);
      if (m.rule) out.push(`   Rule: ${m.rule}`);
      if (m.look_alike) out.push(`   Look-alike: ${m.look_alike}`);
      if (m.mehlman) out.push(`   Mehlman: ${m.mehlman}${m.mehlman_src ? ` (${m.mehlman_src})` : ''}`);
      if (m.seen_before.length) out.push(`   Missed before in: ${m.seen_before.join(', ')}`);
    });
  }
  if (habits.length) {
    out.push('', 'Misreads and test-taking slips (no cards, just habits to watch):');
    for (const m of habits) out.push(`- ${m.label} · ${m.error_type}${m.gap ? `: ${m.gap}` : ''}`);
  }
  out.push('', 'Make flashcards: suggest at most 15 cards from these, ranked by what will most raise my Step 2 score, in my usual card style. I will choose how many to keep.');
  return out.join('\n');
}

export async function summaryRoute(request, env, ctx, { id }) {
  const s = await buildSummary(env, id);
  return json({ ...s, text: summaryText(s) });
}
