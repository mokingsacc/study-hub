import { londonDay } from '../util.js';
import { addDays, daysLeft } from './teach-priority.js';
import { stemSafe, questionSafe } from './guard.js';

export const TRAPS = {
  anchored_first_clue: { label: 'anchored on the first clue', hint: 'locked onto one early clue (the age, a drug, a recent infection, how the scan looks) and read the rest to fit it' },
  stopped_at_first_fit: { label: 'stopped at the first diagnosis that fit', hint: 'took the first answer that fitted and never weighed the one the other findings pointed to' },
  missed_drug_cause: { label: 'missed a drug as the cause', hint: 'did not check the drug list: a new or hidden drug (eye drops, an antipsychotic, an antibiotic) explained it' },
  ruled_out_on_absent_finding: { label: 'ruled out because a finding was absent', hint: 'struck an answer out because a finding he expected (fever, an exam sign, a lab change) was missing or normal' },
  normal_read_as_disease: { label: 'read a normal finding as disease', hint: 'treated a normal or physiological finding (a pregnancy change, a normal variant) as disease' },
  ignored_key_finding: { label: 'ignored a striking clue', hint: 'a vital sign, the pupils, a history detail or a lab the case gave was never used' },
  unsure_normal_value: { label: 'unsure of a normal value or cut-off', hint: 'did not know the normal range or threshold, so could not tell whether a number mattered' },
  look_alike_swap: { label: 'mixed up two look-alikes', hint: 'narrowed to two look-alikes and took the wrong one, or called one by the other\'s name (stenosis for regurgitation)' },
  side_detail_overrode_rule: { label: 'let a side detail override the rule', hint: 'knew the deciding rule but let a minor detail (he smokes, a recent sore throat) pull him to the other answer' },
  reasoned_from_wrong_belief: { label: 'reasoned from a wrong belief', hint: 'built a careful chain on a false premise (metastases are never lytic; cephalexin failing means Pseudomonas)' },
  treats_before_confirming: { label: 'treats or images before confirming', hint: 'jumped to treatment, imaging or a procedure before the confirming test or the safety-first step' },
  wrong_timing: { label: 'right action at the wrong time', hint: 'the step was right but its timing or order was wrong (fix the valve before pregnancy, not during it)' },
  familiar_answer_fallback: { label: 'fell back on a familiar answer', hint: 'when unsure, picked a drug or test he knows well instead of reasoning from the findings' },
  misread_question_asked: { label: 'misread the question asked', hint: 'answered a different question (the cause, not the next step; a risk factor, not prevention) or picked before reading the options' },
  changed_right_answer: { label: 'switched away from a right first answer', hint: 'his first pick was right and he changed it' },
  picks_uk_answer: { label: 'picks the UK answer', hint: 'chose what UK practice or NICE would do where US guidelines differ' },
  slow_doubt_guess: { label: 'slow from doubt, then guessed', hint: 'went back and forth for over two minutes, then guessed' },
};
export const TRAP_KEYS = Object.keys(TRAPS);
export const trapLabel = k => (TRAPS[k] ? TRAPS[k].label : null);
export const TRAPS_PER_ITEM = 2;

// A habit is active with at least ACTIVE_N items on ACTIVE_TOPICS topics, the last within ACTIVE_DAYS; counted over
// WINDOW_DAYS. map_weakest's lesson list lifts a topic where an active habit recurs by HABIT_BOOST (a tie-breaker
// between close topics, never a reorder of the map's evidence: no weight changes, WEIGHTS_VERSION stays).
export const ACTIVE_N = 3, ACTIVE_TOPICS = 2, ACTIVE_DAYS = 21, WINDOW_DAYS = 60, HABIT_BOOST = 1.1;
export const EXAMPLES = 3, NOTE_MAX = 200, PROFILE_MAX = 1200, INSIGHT_MAX = 500;

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const cap = (s, n) => { if (s == null) return null; const t = String(s).replace(/\s+/g, ' ').trim(); return !t ? null : t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDay = d => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '')); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : null; };
/** Claude's text as it may be stored: one line, capped, and never anything that reads like question text. */
export const safeLine = (s, n) => { const t = cap(s, n); return t && stemSafe(t) && questionSafe(t) ? t : null; };

/** Traps from the vocabulary only, unique, at most TRAPS_PER_ITEM (pure). */
export function cleanTraps(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter(k => typeof k === 'string' && TRAPS[k]))].slice(0, TRAPS_PER_ITEM);
}

// ---------------------------------------------------------------- habits (pure, then the table)

/**
 * One habit per trap from pattern_items rows [{traps_json, topic_id, category_id, system, day, label}] in the window
 * (pure). Returns [{trap, n, topics_n, systems_n, first_seen, last_seen, examples, systems: [{name, n}], status}],
 * the most frequent first.
 */
export function aggregateHabits(rows, { today = londonDay() } = {}) {
  const from = addDays(today, -WINDOW_DAYS), recent = addDays(today, -ACTIVE_DAYS);
  const by = new Map();
  const sorted = (rows || []).filter(r => r && r.day && r.day >= from).sort((a, b) => String(b.day).localeCompare(String(a.day)));
  for (const r of sorted) {
    for (const trap of cleanTraps(parse(r.traps_json, []))) {
      const h = by.get(trap) || { trap, n: 0, topics: new Set(), systems: new Map(), first_seen: r.day, last_seen: r.day, examples: [] };
      h.n++;
      if (r.topic_id) h.topics.add(r.topic_id);
      const sys = r.system || r.category_id;
      if (sys) h.systems.set(sys, (h.systems.get(sys) || 0) + 1);
      if (r.day < h.first_seen) h.first_seen = r.day;
      if (r.day > h.last_seen) h.last_seen = r.day;
      if (r.label && h.examples.length < EXAMPLES && !h.examples.includes(r.label)) h.examples.push(r.label);
      by.set(trap, h);
    }
  }
  return [...by.values()].map(h => ({
    trap: h.trap, n: h.n, topics_n: h.topics.size, systems_n: h.systems.size, first_seen: h.first_seen, last_seen: h.last_seen, examples: h.examples,
    systems: [...h.systems.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => ({ name, n })),
    status: h.n >= ACTIVE_N && h.topics.size >= ACTIVE_TOPICS && h.last_seen >= recent ? 'active' : 'quiet',
  })).sort((a, b) => b.n - a.n || String(b.last_seen).localeCompare(String(a.last_seen)));
}

/**
 * The habits table rebuilt from pattern_items, in one read and one write batch. notes: {trap: Claude's line} from the
 * review just made (a trap without one keeps its note). A habit that has dropped out of the window is set quiet with
 * n 0. Returns {updated: n rows whose counts or status changed, newly: [traps that just became active], active: n}.
 */
export async function recomputeHabits(env, user, { notes = {}, now = Date.now() } = {}) {
  const today = londonDay(now);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  let items, existing;
  try {
    [items, existing] = (await env.DB.batch([
      q(`SELECT p.traps_json, p.topic_id, p.category_id, coalesce(c.name, p.category_id) AS system, p.day, p.label FROM pattern_items p
           LEFT JOIN categories c ON c.user_id = p.user_id AND c.id = p.category_id
         WHERE p.user_id = ? AND p.day >= ? AND p.traps_json <> '[]'`, user, addDays(today, -WINDOW_DAYS)),
      q('SELECT * FROM habits WHERE user_id = ?', user),
    ])).map(r => r.results || []);
  } catch (e) { if (noTable(e)) return { updated: 0, newly: [], active: 0 }; throw e; }
  const agg = aggregateHabits(items, { today });
  const old = new Map(existing.map(h => [h.trap, h]));
  const rows = [], newly = [];
  for (const h of agg) {
    const prev = old.get(h.trap);
    old.delete(h.trap);
    const note = safeLine(notes[h.trap], NOTE_MAX) || (prev && prev.note) || null;
    const becameActive = h.status === 'active' && (!prev || prev.status !== 'active');
    if (becameActive) newly.push(h.trap);
    const row = { trap: h.trap, status: h.status, n: h.n, topics_n: h.topics_n, systems_n: h.systems_n, first_seen: h.first_seen, last_seen: h.last_seen,
      examples_json: JSON.stringify(h.examples), systems_json: JSON.stringify(h.systems), note,
      active_at: becameActive ? now : prev ? prev.active_at ?? null : null };
    const same = prev && ['status', 'n', 'topics_n', 'systems_n', 'last_seen', 'examples_json', 'systems_json', 'note'].every(k => String(prev[k] ?? '') === String(row[k] ?? ''));
    if (!same) rows.push(row);
  }
  for (const prev of old.values()) if (prev.n > 0 || prev.status !== 'quiet') rows.push({ ...prev, status: 'quiet', n: 0, topics_n: 0, systems_n: 0 });
  if (rows.length) {
    const cols = ['trap', 'status', 'n', 'topics_n', 'systems_n', 'first_seen', 'last_seen', 'examples_json', 'systems_json', 'note', 'active_at'];
    await env.DB.prepare(`INSERT INTO habits (user_id, ${cols.join(', ')}, created_at, updated_at)
        SELECT ?1, ${cols.map(c => `json_extract(value, '$.${c}')`).join(', ')}, ?3, ?3 FROM json_each(?2) WHERE true
        ON CONFLICT (user_id, trap) DO UPDATE SET ${cols.filter(c => c !== 'trap').map(c => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at`)
      .bind(user, JSON.stringify(rows.map(r => Object.fromEntries(cols.map(c => [c, r[c] ?? null])))), now).run();
  }
  return { updated: rows.length, newly, active: agg.filter(h => h.status === 'active').length };
}

/** A habit row as the readers give it (pure). */
export function shapeHabit(h) {
  return { trap: h.trap, label: trapLabel(h.trap), n: Number(h.n) || 0, topics: Number(h.topics_n) || 0, last_seen: h.last_seen || null,
    examples: parse(h.examples_json, []).slice(0, EXAMPLES), systems: parse(h.systems_json, []).slice(0, 3).map(s => s.name), ...(h.note ? { note: h.note } : {}) };
}

// ---------------------------------------------------------------- map_topic

export function topicHabitStatements(env, user, topicId) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  return {
    habitItems: q(`SELECT traps_json, label, day FROM pattern_items WHERE user_id = ? AND topic_id = ? AND traps_json <> '[]' ORDER BY day DESC LIMIT 30`, user, topicId),
    habits: q(`SELECT trap, status, n, topics_n, last_seen, examples_json, systems_json, note FROM habits WHERE user_id = ? AND status = 'active' ORDER BY n DESC, last_seen DESC LIMIT 5`, user),
  };
}

export function shapeTopicHabits(itemRows, habitRows) {
  const by = new Map();
  for (const r of itemRows || []) {
    for (const trap of cleanTraps(parse(r.traps_json, []))) {
      const h = by.get(trap) || { trap, label: trapLabel(trap), n: 0, refs: [], last: r.day };
      h.n++;
      if (r.label && h.refs.length < 2 && !h.refs.includes(r.label)) h.refs.push(r.label);
      if (r.day > h.last) h.last = r.day;
      by.set(trap, h);
    }
  }
  const active = new Map((habitRows || []).map(h => [h.trap, h]));
  const here = [...by.values()].sort((a, b) => b.n - a.n || String(b.last).localeCompare(String(a.last))).slice(0, 3)
    .map(h => ({ ...h, ...(active.has(h.trap) ? { habit_n: Number(active.get(h.trap).n) || 0 } : {}) }));
  const elsewhere = (habitRows || []).filter(h => !by.has(h.trap)).slice(0, 2).map(h => ({ trap: h.trap, label: trapLabel(h.trap), n: Number(h.n) || 0, last: h.last_seen }));
  return here.length || elsewhere.length ? { here, elsewhere } : null;
}

export function forExplaining(d) {
  const name = (d.topic && d.topic.name) || 'this topic';
  const m = d.misses, g = d.gaps;
  const miscs = (d.lessons && d.lessons.misconceptions) || [];
  const bits = [];
  if (m && m.total) {
    const top = (m.items || []).find(x => !x.slip) || (m.items || [])[0];
    const sure = m.by_confidence && m.by_confidence.sure ? `, ${m.by_confidence.sure} when sure` : '';
    let line = `${plural(m.total, 'miss', 'misses')} on ${name}${sure}`;
    if (top) line += `; newest ${top.label} (${shortDay(top.day) || top.day})${top.my_reasoning ? `: he thought ${cap(top.my_reasoning, 110)}` : top.look_alike ? `, took it for ${cap(top.look_alike, 50)}` : ''}`;
    bits.push(line);
  }
  if (g && g.total) { const x = (g.items || [])[0]; bits.push(`${plural(g.total, 'gap')}${x && (x.text || x.gap) ? `, latest "${cap(x.text || x.gap, 80)}"` : ''}`); }
  if (miscs.length) bits.push(`open misconception "${cap(miscs[0].belief, 90)}"`);
  const first = bits.length ? `${cap(bits.join('; '), 330)}.` : `No misses, gaps or misconceptions on ${name} yet.`;
  const h = d.habits && d.habits.here && d.habits.here[0];
  const other = d.habits && d.habits.elsewhere && d.habits.elsewhere[0];
  const second = h ? `His trap here: ${h.label} (${plural(h.n, 'time')}${h.habit_n ? `, ${h.habit_n} across topics` : ''}); say in a line what he got wrong before, then explain it so that trap is named.`
    : other ? `No trap seen here yet; his active habit is ${other.label} (${plural(other.n, 'miss', 'misses')}), so point out where it could catch him.`
      : bits.length ? 'Say in a line what he got wrong before, then explain.' : 'Explain it as new, then check one point with a short question.';
  return `${first} ${second}`;
}

// ---------------------------------------------------------------- the profile

/**
 * The code facts for the profile, in one read batch plus calibration and the look-alike pairs: weakest systems and
 * topics, the overconfident system, active habits, open misconceptions, re-tests due, what teaching worked, days left.
 */
export async function profileFacts(env, user, { now = Date.now() } = {}) {
  const today = londonDay(now);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const soft = async stmts => {
    try { return (await env.DB.batch(stmts)).map(r => r.results || []); } catch (e) {
      if (!noTable(e)) throw e;
      return Promise.all(stmts.map(s => s.all().then(r => r.results || [], err => { if (!noTable(err)) throw err; return []; })));
    }
  };
  const { DUE_COUNT_SQL } = await import('./retests.js');
  const [cats, topics, habits, miscN, miscs, retests, tactics, clicked] = await soft([
    q(`SELECT c.name, avg(s.t) AS t FROM topic_scores s JOIN categories c ON c.user_id = s.user_id AND c.id = s.category_id
       WHERE s.user_id = ? AND s.seen = 1 AND s.t IS NOT NULL GROUP BY s.category_id HAVING count(*) >= 3 ORDER BY avg(s.t) DESC LIMIT 3`, user),
    q(`SELECT t.name FROM topic_scores s JOIN topics t ON t.user_id = s.user_id AND t.id = s.topic_id
       WHERE s.user_id = ? AND s.seen = 1 AND s.band IN ('very_weak', 'weak') AND t.status IN ('proposed', 'confirmed') ORDER BY s.t DESC LIMIT 4`, user),
    q(`SELECT trap, n, topics_n, last_seen, examples_json, systems_json, note, status FROM habits WHERE user_id = ? AND status = 'active' ORDER BY n DESC LIMIT 3`, user),
    q(`SELECT count(*) AS n FROM misconceptions WHERE user_id = ? AND status <> 'closed'`, user),
    q(`SELECT belief, coalesce(topic_name, topic_id) AS topic FROM misconceptions WHERE user_id = ? AND status <> 'closed' ORDER BY seen_n DESC, last_seen DESC LIMIT 2`, user),
    q(DUE_COUNT_SQL, user, today),
    q(`SELECT tactic, sum(wins) AS w, sum(losses) AS l, sum(uses) AS uses FROM tactic_scores WHERE user_id = ? GROUP BY tactic HAVING sum(uses) > 0
       ORDER BY (1 + sum(wins)) / (2 + sum(wins) + sum(losses)) DESC LIMIT 2`, user),
    q(`SELECT what_clicked FROM lessons WHERE user_id = ? AND status = 'done' AND what_clicked IS NOT NULL AND what_clicked <> '' ORDER BY ended_at DESC LIMIT 1`, user),
  ]);
  const [{ overconfident }, { topPairs }] = await Promise.all([import('./calibration.js'), import('./links-store.js')]);
  const over = await overconfident(env, user, { today }).catch(() => null);
  const pairs = await topPairs(env, user, 2, { mixedOnly: true }).catch(() => []);
  const r = retests[0] || {};
  return {
    day: today, days_left: daysLeft(today),
    weakest_systems: cats.map(c => c.name), weakest_topics: topics.map(t => t.name),
    overconfident: over ? { system: over.system, sure_wrong: over.sure_wrong, sure: over.sure } : null,
    habits: habits.map(shapeHabit),
    misconceptions: { open: Number((miscN[0] || {}).n) || 0, top: miscs.map(m => ({ topic: m.topic, belief: cap(m.belief, 90) })) },
    pairs: pairs.map(p => `${p.a.name} vs ${p.b.name}`),
    retests_due: Number(r.n) || 0,
    worked: tactics.map(t => String(t.tactic).replace(/_/g, ' ')), clicked: clicked[0] ? cap(clicked[0].what_clicked, 80) : null,
  };
}

/** The profile text from the review's insight and the code facts (pure), under PROFILE_MAX characters, plain words. */
export function composeProfile({ insight = null, facts = {} } = {}) {
  const f = facts || {};
  const lines = [];
  if (insight) lines.push(cap(insight, INSIGHT_MAX));
  if (f.habits && f.habits.length) lines.push(`Habits: ${f.habits.map(h => `${h.label} (${h.n}${h.examples && h.examples[0] ? `, e.g. ${h.examples[0]}` : ''})`).join('; ')}.`);
  if (f.overconfident) lines.push(`Overconfident in ${f.overconfident.system}: ${f.overconfident.sure_wrong} of ${f.overconfident.sure} sure answers wrong lately.`);
  if (f.weakest_systems && f.weakest_systems.length) lines.push(`Weakest systems: ${f.weakest_systems.join(', ')}.`);
  if (f.weakest_topics && f.weakest_topics.length) lines.push(`Weakest topics: ${f.weakest_topics.join(', ')}.`);
  if (f.misconceptions && f.misconceptions.open) lines.push(`${plural(f.misconceptions.open, 'open misconception')}${f.misconceptions.top[0] ? `, e.g. "${f.misconceptions.top[0].belief}" (${f.misconceptions.top[0].topic})` : ''}.`);
  if (f.pairs && f.pairs.length) lines.push(`Mixes up: ${f.pairs.join('; ')}.`);
  if (f.retests_due) lines.push(`${plural(f.retests_due, 're-test')} due.`);
  if ((f.worked && f.worked.length) || f.clicked) lines.push(`Teaching that works: ${[f.worked && f.worked.length ? f.worked.join(', ') : null, f.clicked ? `last clicked "${f.clicked}"` : null].filter(Boolean).join('; ')}.`);
  if (f.days_left != null) lines.push(`${f.days_left} days to the exam.`);
  let text = lines.join(' ');
  // Too long: the code lines go from the end first (the insight and the habits are kept longest).
  while (text.length > PROFILE_MAX && lines.length > 2) { lines.splice(lines.length - 2, 1); text = lines.join(' '); }
  return cap(text, PROFILE_MAX) || 'No profile yet: the pattern review has not run.';
}

/** The profile's one-line short form for voice (pure): the top habit and the overconfident system, at most 200. */
export function profileShort(facts) {
  const f = facts || {};
  const bits = [];
  if (f.habits && f.habits[0]) bits.push(`top habit: ${f.habits[0].label}`);
  if (f.overconfident) bits.push(`overconfident in ${f.overconfident.system}`);
  return bits.length ? cap(`${bits.join('; ')}.`.replace(/^./, c => c.toUpperCase()), 200) : null;
}

/** The stored profile row, or null (before 0040 or before the first refresh). */
export async function readProfile(env, user) {
  try { return await env.DB.prepare('SELECT * FROM learner_profile WHERE user_id = ?').bind(user).first(); } catch (e) { if (noTable(e)) return null; throw e; }
}

/**
 * The profile rebuilt: the code facts now, beside the review's insight (a new one when given, else the stored one).
 * Returns {text, changed, facts} or null before 0040. One write when the text changed.
 */
export async function refreshProfile(env, user, { now = Date.now(), insight = undefined, runId = null } = {}) {
  const cur = await readProfile(env, user).catch(() => null);
  let facts;
  try { facts = await profileFacts(env, user, { now }); } catch (e) { if (noTable(e)) return null; throw e; }
  const nextInsight = insight !== undefined ? safeLine(insight, INSIGHT_MAX) || (cur && cur.insight) || null : (cur && cur.insight) || null;
  const text = composeProfile({ insight: nextInsight, facts });
  const changed = !cur || cur.text !== text;
  try {
    await env.DB.prepare(`INSERT INTO learner_profile (user_id, text, insight, insight_at, facts_json, run_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT (user_id) DO UPDATE SET text = excluded.text, insight = excluded.insight, insight_at = coalesce(excluded.insight_at, learner_profile.insight_at),
          facts_json = excluded.facts_json, run_id = coalesce(excluded.run_id, learner_profile.run_id), updated_at = excluded.updated_at`)
      .bind(user, text, nextInsight, insight !== undefined && nextInsight ? now : null, JSON.stringify(facts), runId, now).run();
  } catch (e) { if (noTable(e)) return null; throw e; }
  return { text, changed, facts };
}

// ---------------------------------------------------------------- map_overview and map_weakest

export function newPatternLine(habit, { since = 0, now = Date.now() } = {}) {
  if (!habit || habit.status !== 'active' || !habit.active_at) return null;
  if (Number(habit.active_at) <= Math.max(Number(since) || 0, now - 7 * 86_400_000)) return null;
  const h = shapeHabit(habit);
  return cap(`New pattern: ${h.label}, ${plural(h.n, 'miss', 'misses')} on ${plural(h.topics, 'topic')}${h.examples[0] ? ` (e.g. ${h.examples.slice(0, 2).join(', ')})` : ''}.`, 160);
}

/** Topics whose misses or gaps in the window carry an active habit: Map(topic_id -> trap label). [] before 0040. */
export async function habitTopics(env, user, { now = Date.now() } = {}) {
  try {
    const rows = (await env.DB.prepare(`SELECT p.topic_id, h.trap, count(*) AS n FROM pattern_items p, json_each(p.traps_json) j
        JOIN habits h ON h.user_id = p.user_id AND h.trap = j.value AND h.status = 'active'
      WHERE p.user_id = ? AND p.topic_id IS NOT NULL AND p.day >= ? GROUP BY p.topic_id, h.trap ORDER BY n DESC LIMIT 400`)
      .bind(user, addDays(londonDay(now), -WINDOW_DAYS)).all()).results || [];
    const out = new Map();
    for (const r of rows) if (!out.has(r.topic_id)) out.set(r.topic_id, trapLabel(r.trap));
    return out;
  } catch (e) { if (noTable(e)) return new Map(); throw e; }
}

// ---------------------------------------------------------------- teach_next

export const PATTERN_TABLES = ['pattern_items', 'habits', 'learner_profile'];

export function briefPatternStatements(env, user, topicId) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  return [
    q(`SELECT traps_json, label, day FROM pattern_items WHERE user_id = ? AND topic_id = ? AND traps_json <> '[]' ORDER BY day DESC LIMIT 30`, user, topicId || ''),
    q(`SELECT trap, status, n, topics_n, last_seen, examples_json, systems_json, note FROM habits WHERE user_id = ? AND status = 'active' ORDER BY n DESC, last_seen DESC LIMIT 3`, user),
    q(`SELECT id, belief, note FROM misconceptions WHERE user_id = ? AND topic_id = ? AND status <> 'closed' AND note LIKE 'Re-check%' LIMIT 3`, user, topicId || ''),
    q('SELECT text FROM learner_profile WHERE user_id = ?', user),
  ];
}

/**
 * The patterns field and the profile from those rows (pure): {patterns: {here?, habits, recheck?, use?} | null,
 * about_mo: text | null}. use tells the lesson to aim at the habit and plant it in the final case.
 */
export function shapeBriefPatterns([items = [], habits = [], rechecks = [], profile = []] = []) {
  const t = shapeTopicHabits(items, habits);
  const top = (t && t.here[0]) || (habits[0] ? { trap: habits[0].trap, label: trapLabel(habits[0].trap) } : null);
  const out = {
    ...(t && t.here.length ? { here: t.here } : {}),
    habits: habits.map(shapeHabit),
    ...(rechecks.length ? { recheck: rechecks.map(r => ({ id: r.id, belief: cap(r.belief, 160), why: cap(String(r.note).replace(/^Re-check[^:]*:\s*/, ''), 160) })) } : {}),
    ...(top ? { use: `Aim the lesson at "${top.label}": plant it as the final case's distractor, and when he falls for it name the habit in one line.` } : {}),
  };
  return { patterns: out.here || out.habits.length || out.recheck ? out : null, about_mo: profile[0] ? profile[0].text : null };
}
