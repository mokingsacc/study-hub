// Results for graphs and the predictor, and the Health Hub score feed.
import { json, londonDay } from './util.js';
import { all } from './db.js';

export async function list(request, env) {
  const [sittings, totals, misses] = await Promise.all([
    all(env, 'SELECT id, name, kind, exam_type, timing, external_label, scheduled_date, finished_at, created_at, score_pct, official_score, status FROM sittings ORDER BY COALESCE(finished_at, created_at)'),
    all(env, 'SELECT sitting_id, sum(correct) AS correct, sum(scored) AS scored FROM blocks WHERE ended_at IS NOT NULL GROUP BY sitting_id'),
    all(env, `SELECT b.sitting_id, a.system, COALESCE(a.error_confirmed, a.error_type) AS err FROM analyses a JOIN blocks b ON b.id = a.block_id
      WHERE a.status = 'done' AND a.verdict IN ('wrong', 'right_flawed') AND (a.verdict = 'wrong' OR a.mo_override IS NULL OR a.mo_override != 'sound')`),
  ]);
  const tot = new Map(totals.map(t => [t.sitting_id, t]));
  const bySitting = new Map();
  for (const m of misses) {
    if (!bySitting.has(m.sitting_id)) bySitting.set(m.sitting_id, { by_system: {}, by_error: {} });
    const g = bySitting.get(m.sitting_id);
    if (m.system) g.by_system[m.system] = (g.by_system[m.system] || 0) + 1;
    if (m.err) g.by_error[m.err] = (g.by_error[m.err] || 0) + 1;
  }
  const out = [];
  for (const s of sittings) {
    const t = tot.get(s.id);
    if (s.score_pct == null && s.official_score == null && !(t && t.scored)) continue;
    if (s.kind === 'hub' && s.status !== 'done') continue; // no score until the sitting is over
    if (s.exam_type === 'uworld_avg') continue;
    const g = bySitting.get(s.id) || { by_system: {}, by_error: {} };
    out.push({
      sitting_id: s.id, name: s.name, kind: s.kind, exam_type: s.exam_type, timing: s.timing || 'strict', external_label: s.external_label,
      date: s.finished_at ? londonDay(s.finished_at) : s.scheduled_date || londonDay(s.created_at),
      score_pct: s.score_pct != null ? s.score_pct : t && t.scored ? Math.round((t.correct / t.scored) * 1000) / 10 : null,
      official_score: s.official_score, correct: t ? t.correct : null, scored: t ? t.scored : null,
      status: s.status, by_system: g.by_system, by_error: g.by_error,
    });
  }
  return json(out);
}

export async function healthhub(request, env) {
  const rows = await all(env, `SELECT s.name, s.score_pct, s.finished_at, s.scheduled_date, s.created_at,
      (SELECT sum(scored) FROM blocks b WHERE b.sitting_id = s.id) AS questions
    FROM sittings s WHERE s.status = 'done' AND s.score_pct IS NOT NULL AND COALESCE(s.exam_type, '') != 'uworld_avg' ORDER BY COALESCE(s.finished_at, s.created_at)`);
  return json(rows.map(r => ({
    date: r.finished_at ? londonDay(r.finished_at) : r.scheduled_date || londonDay(r.created_at),
    name: r.name, score_pct: r.score_pct, questions: r.questions || null,
  })));
}
