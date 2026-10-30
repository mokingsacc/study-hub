// This week's focus: hub stats for the last 7 days plus the Anki mistake summary when reachable.
import { json, londonDay, now } from './util.js';
import { all, first } from './db.js';
import { ankiCall } from './anki.js';
import { confFor } from '../../public/js/conf-words.js';

const WEEK = 7 * 86400_000;

const ERROR_TIPS = {
  'knowledge gap': 'Most misses were gaps in facts: turn each into a card and review them before new questions.',
  misread: 'Several misses were misreads: read the last line first, then the stem, and underline age, timing and any "not".',
  'premature closure': 'You often locked on early: before you click, name the one finding that rules out your runner-up.',
  'faulty synthesis': 'You had the facts but joined them wrongly: say the diagnosis, then the step the question asks for, as two separate thoughts.',
  'test-taking': 'Some misses were exam technique: keep your first answer unless you find a new fact in the stem.',
  'threshold or number': 'Numbers and cut-offs tripped you up: keep a short list of the guideline numbers you missed and say them aloud daily.',
  calculation: 'Calculation slips came up: write each formula out before you put the numbers in.',
};

export function suggestionsFrom({ topSystems, topErrors, confident, total }) {
  const out = [];
  if (!total) {
    out.push('No misses logged this week yet: a timed mixed block is a good way to start.');
    out.push('Use quick voice mode so each question gets a one-line reason you can review.');
    out.push('Review your due Anki cards before starting new questions.');
    return out;
  }
  if (topSystems[0]) out.push(`Do one extra mixed block weighted to ${topSystems[0].name}, where ${topSystems[0].misses} of this week's misses were.`);
  if (topErrors[0] && ERROR_TIPS[topErrors[0].name]) out.push(ERROR_TIPS[topErrors[0].name]);
  if (confident > 0) out.push(`You were sure on ${confident} miss${confident === 1 ? '' : 'es'}: re-read their rules aloud before your next block.`);
  if (out.length < 3) out.push('Clear your due Anki cards each day before new questions.');
  if (out.length < 3) out.push('Keep blocks timed and mixed so practice feels like exam day.');
  return out.slice(0, 3);
}

export async function get(request, env) {
  const since = now() - WEEK;
  // A sitting that has not ended shows nothing yet (CONTRACT hard rule).
  // (A subquery, not a join: a joined sittings.name would capture the queries' GROUP BY name.)
  const base = `FROM analyses a JOIN blocks b ON b.id = a.block_id
    WHERE b.sitting_id IN (SELECT id FROM sittings WHERE status = 'done') AND a.created_at >= ? AND a.status = 'done' AND a.verdict IN ('wrong', 'right_flawed') AND (a.verdict = 'wrong' OR a.mo_override IS NULL OR a.mo_override != 'sound')`;
  const anki = ankiCall(env, 'mistake_summary', { since_days: 7 }, { timeoutMs: 5000 }).catch(() => null);
  const [systems, errors, confident, total, summary] = await Promise.all([
    all(env, `SELECT a.system AS name, count(*) AS misses ${base} AND a.system IS NOT NULL GROUP BY a.system ORDER BY misses DESC, name LIMIT 5`, since),
    all(env, `SELECT COALESCE(a.error_confirmed, a.error_type) AS name, count(*) AS misses ${base} AND COALESCE(a.error_confirmed, a.error_type) IS NOT NULL
      GROUP BY name ORDER BY misses DESC, name LIMIT 7`, since),
    all(env, `SELECT json_extract(b.state_json, '$.conf."' || a.q_index || '"') AS tap,
      (SELECT t.text FROM transcripts t WHERE t.block_id = a.block_id AND t.q_index = a.q_index) AS said ${base} AND a.verdict = 'wrong'`, since),
    first(env, `SELECT count(*) AS n ${base}`, since),
    anki,
  ]);
  const confidentMisses = confident.filter(r => confFor(r.tap, r.said).conf === '1').length; // tapped or said "sure"
  return json({
    week_start: londonDay(since + 86400_000),
    top_systems: systems,
    top_errors: errors,
    confident_misses: confidentMisses,
    retests_due: (summary && Array.isArray(summary.retests_due)) ? summary.retests_due : [],
    anki_summary: summary || null,
    suggestions: suggestionsFrom({ topSystems: systems, topErrors: errors, confident: confidentMisses, total: total ? total.n : 0 }),
  });
}
