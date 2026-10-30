// How it works, the live part (docs/platform/v2-plan.md 2.5): GET /api/p/guide gives the page their track, subjects
// (board, tier, weakest topic), counts, the countdown, their Claude's connection and what is left to set up; the tool
// hub_guide gives their Claude the same guide as text (public/js/platform/guide.js, one source for both).
import { HttpError, json, safeParse } from '../util.js';
import { buildProfile } from '../profiles.js';
import { requireModule, modulesFor } from './modules.js';
import { boardName } from './catalogue.js';
import { daysToExam, chipOf } from './subjects.js';
import { dueCount } from './cards.js';
import { guideFor, guideText } from '../../../public/js/platform/guide.js';
import { norm } from '../../../public/js/shared/names.js';

const LIVE = "('proposed','confirmed')";
const st = (env, sql, ...b) => env.DB.prepare(sql).bind(...b);
const n = r => Number(r && r.n) || 0;

export async function guideData(env, user) {
  const [u, subs, weak, gal, docs, papers, conn] = await env.DB.batch([
    st(env, 'SELECT name, profile, profile_json, prefs_json FROM users WHERE id = ?1', user),
    st(env, `SELECT s.id, s.subject, s.name, s.board, s.tier, COUNT(t.id) AS topics_n,
      SUM(CASE WHEN sc.band IN ('weak', 'very_weak') THEN 1 ELSE 0 END) AS weak_n
      FROM subjects s LEFT JOIN topics t ON t.user_id = s.user_id AND t.category_id = s.id AND t.status IN ${LIVE}
      LEFT JOIN topic_scores sc ON sc.user_id = t.user_id AND sc.topic_id = t.id
      WHERE s.user_id = ?1 AND s.status = 'active' GROUP BY s.id ORDER BY s.sort, s.id`, user),
    // Each subject's weakest seen topic (for the guide's {topic}).
    st(env, `SELECT t.category_id AS subject_id, t.name, sc.t FROM topic_scores sc JOIN topics t ON t.user_id = sc.user_id AND t.id = sc.topic_id AND t.status IN ${LIVE}
      WHERE sc.user_id = ?1 AND sc.seen = 1 ORDER BY sc.t DESC LIMIT 200`, user),
    st(env, "SELECT COUNT(*) AS n FROM galaxies WHERE user_id = ?1 AND status = 'active'", user),
    st(env, "SELECT COUNT(*) AS n FROM library_docs WHERE user_id = ?1 AND status NOT IN ('uploading', 'refused', 'failed')", user),
    st(env, "SELECT SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready, SUM(CASE WHEN status = 'marked' THEN 1 ELSE 0 END) AS marked FROM papers WHERE user_id = ?1", user),
    st(env, "SELECT COUNT(*) AS n, MAX(last_used_at) AS used FROM connector_keys WHERE user_id = ?1 AND revoked_at IS NULL AND coalesce(label, '') != 'anki'", user),
  ]);
  const row = (u.results || [])[0];
  if (!row) throw new HttpError(404, 'There is no such account.');
  const profile = buildProfile(row.profile, safeParse(row.profile_json, {}) || {});
  const mods = modulesFor(row.profile, safeParse(row.prefs_json, {}), env);
  const weakest = new Map();
  for (const w of weak.results || []) if (!weakest.has(w.subject_id)) weakest.set(w.subject_id, w.name);
  const subjects = (subs.results || []).map(s => ({ id: s.id, subject: s.subject, name: s.name, board: s.board, board_name: boardName(s.board), tier: s.tier || null,
    topics_n: n({ n: s.topics_n }), weak_n: n({ n: s.weak_n }), weakest: weakest.get(s.id) || null }));
  const p = (papers.results || [])[0] || {}, c = (conn.results || [])[0] || {};
  const cardsDue = mods.cards ? await dueCount(env, user).catch(() => 0) : 0;
  return {
    track: row.profile, track_label: profile.label || row.profile, name: String(row.name || '').split(/\s+/)[0] || null, subjects,
    counts: { topics: subjects.reduce((a, s) => a + s.topics_n, 0), galaxies: n((gal.results || [])[0]), docs: n((docs.results || [])[0]), cards_due: Number(cardsDue) || 0,
      papers_to_sit: Number(p.ready) || 0, papers_marked: Number(p.marked) || 0 },
    days_to_exam: daysToExam(profile.exam_date), exam_date: profile.exam_date || null,
    claude: { links: Number(c.n) || 0, last_used_at: c.used || null },
    setup: {
      claude: !!c.used,
      boards_missing: subjects.filter(s => !s.board || s.board === 'other').map(s => s.name),
      no_topics: subjects.filter(s => !s.topics_n).map(s => s.name),
      exam_date: !!profile.exam_date,
    },
    modules: mods,
  };
}

async function guideRoute(request, env, ctx, params, url, user, session) {
  requireModule(session, 'map', env);
  return json(await guideData(env, user));
}

export const ROUTES = [['GET', '/api/p/guide', guideRoute]];

// The parts of the hub a new student could use, and when each is worth suggesting (setup_guide).
const IDEAS = [
  ['cards', 'Flashcards that come back just before they would forget: "make me 10 flashcards on <topic>".'],
  ['mnemonics', 'Mnemonics with a letter-by-letter test, for lists: "make me a mnemonic for <list>".'],
  ['exams', 'Past papers on screen with a clock, and practice papers you write and mark with them.'],
  ['library', 'Their notes and past papers in the Library, so you can quote the page.'],
  ['map', 'Galaxies of their own on the map, such as one per mock or paper: galaxy_edit.'],
  ['map', 'Teach me on any topic, ending in an exam-style question; chat notes so the next lesson starts from this one.'],
  ['map', 'Make it theirs: colours, Today\'s tiles, a page of their own (a checklist or a countdown): my_hub_change.'],
  ['results', 'Their scores from apps or past papers onto the map: log_results.'],
];

export const TOOLS = [{
  name: 'setup_guide',
  module: 'map',
  description: 'First-time setup, or "set up my Study Hub": what is set up so far, and the interview. Ask one thing at a time, in plain words for their age: their level and year (primary SATs to university), '
    + 'their subjects (with exam board, tier or modules), exam dates, latest results or grades, and how they like to study. Save each answer as you go (subject_edit, add_topics, log_results, my_hub_change teach notes). '
    + 'For a course the hub has no list for, research it with them and add its topics. Then suggest 3 to 5 parts that fit them (ideas).',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  annotations: { readOnlyHint: true },
  async run(env, user) {
    const d = await guideData(env, user);
    const results = await env.DB.prepare('SELECT COUNT(*) AS n FROM result_logs WHERE user_id = ? AND deleted_at IS NULL').bind(user).first().catch(() => null);
    return {
      level: { track: d.track, label: d.track_label, change_with: 'subject_edit {action: "level", level: primary|gcse|alevel|university|other}' },
      subjects: d.subjects.map(s => ({ name: s.name, board: s.board_name, tier: s.tier, topics: s.topics_n })),
      exam_date: d.exam_date, results_logged: Number(results && results.n) || 0, claude_connected: !!d.setup.claude,
      still_to_do: [d.subjects.length ? null : 'their subjects', d.setup.boards_missing.length ? `exam boards for ${d.setup.boards_missing.join(', ')}` : null,
        d.setup.no_topics.length ? `topics for ${d.setup.no_topics.join(', ')}` : null, d.setup.exam_date ? null : 'their first exam date', (results && results.n) ? null : 'their latest results'].filter(Boolean),
      ideas: IDEAS.filter(([m]) => d.modules[m] !== false).map(([, line]) => line),
      note: 'One question at a time; save as you go; say in one line what you saved. Finish by suggesting what to try first and offering to teach their weakest topic.',
    };
  },
}, {
  name: 'hub_guide',
  module: 'map',
  description: 'How this student can get the most from their Study Hub with you, for their track and their actual subjects: what each exam rewards, the moves that work (with the words to say), the traps, a simple week and, where it applies, the required practicals. '
    + 'subject narrows it to one. Use it when they ask how to use the hub or how to revise a subject; advise from it in your own words.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { subject: { type: 'string', description: 'One of their subjects, by name (optional).' } } },
  annotations: { readOnlyHint: true },
  async run(env, user, args) {
    const d = await guideData(env, user);
    let subjects = d.subjects;
    if (args.subject) {
      const want = norm(String(args.subject));
      subjects = d.subjects.filter(s => norm(s.name) === want || s.subject === String(args.subject).toLowerCase().replace(/\s+/g, '_'));
      if (!subjects.length) return { note: `They have no subject called ${String(args.subject).slice(0, 60)}. Their subjects: ${d.subjects.map(s => s.name).join(', ') || 'none yet'}.` };
    }
    const gd = guideFor({ track: d.track, subjects, label: d.track_label });
    const left = [d.setup.claude ? null : 'connect their Claude', d.setup.boards_missing.length ? `pick exam boards for ${d.setup.boards_missing.join(', ')}` : null,
      d.setup.exam_date ? null : 'add their first exam date', d.setup.no_topics.length ? `add topics to ${d.setup.no_topics.join(', ')}` : null].filter(Boolean);
    return { guide: guideText(gd, 7600), still_to_set_up: left, days_to_exam: d.days_to_exam, counts: d.counts,
      note: 'Advise in your own words, one or two moves at a time. In the app: More, How it works.' };
  },
}];
