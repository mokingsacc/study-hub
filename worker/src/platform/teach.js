import { vivaBrief, lastVivaFor } from './viva.js';
import { HttpError, json, readJson, londonDay, safeParse } from '../util.js';
import { teachNext, parseTopic } from '../map/teach-brief.js';
import { getCustom } from './custom.js';
import { lessonSave, checkSave, CHECKS as STEP_CHECKS, PROBE_RESULTS, PROBE_FROM, CLAUDE_VIEWS, EFFECTS } from '../map/teach-save.js';
import { TACTIC_VOCAB, SCOPES, TACTICS, NOTE_MAX } from '../map/teach-memory.js';
import { applyChange } from '../map/change.js';
import { topicKnowledge, knowledgeBrief, safeText } from '../map/knowledge.js';
import { todayOffer, shapeToday, avoidanceFromRows, AVOID_SQL, AVOID_RULES } from '../map/morning.js';
import { fnv1a } from '../map/teach-priority.js';
import { looksLikeStem } from '../map/guard.js';
import { buildProfile, ERROR_TYPE_SETS, ERROR_LABELS } from '../profiles.js';
import { norm } from '../../../public/js/shared/names.js';
import { bandOf, bandWord } from '../../../public/js/map/scale.js';
import { requireModule, modulesFor, LEARNER } from './modules.js';
import { boardName } from './catalogue.js';
import { TOOLS as CARD_TOOLS } from './cards.js';

// ------------------------------------------------------------------ the school method

export const SCHOOL_METHOD_TEXT = [
  'Teach one idea so the student understands it, not just remembers it, in about lesson_minutes (around ten turns). They are 16 to 19 and at school or college in the UK: use plain words, their exam board and tier from topic.subject, and never talk down to them.',
  '1. Viva first: when the brief has viva, open with viva.prompt word for word and follow viva.how (they talk freely, you mark it with viva_mark, and the plan it returns replaces the probe: teach only those headings). Without viva, probe one short question at a time (one to three). If the brief has misconceptions, gaps or lost_marks, ask one new mini-question that puts their own words to work and makes them commit. Otherwise ask two or three across what it is, how it works and how to use it. A right answer moves you up a level; a wrong one gets one nearby question to tell a slip from a gap. A wrong belief that shows up goes in lesson_save misconceptions.add.',
  '2. Plan: the goal and two or three steps in one sentence, then start. "I know that bit" drops a step.',
  '3. Steps: at most turn_words words before a check (by voice, three short sentences). Ask them to predict before you tell them anything they can work out. Each check uses a tiny new example; feedback in one sentence. Lead with tactics.try. A missed check: repair with a smaller step or another angle (an analogy, a picture, a mnemonic, a side-by-side contrast, a worked example), then check once more; if it fails twice, say so kindly, note it as weak_spot and move on. Count the questions they ask you.',
  '4. The ending, in this order. (a) Final question: one new exam-style question in your own words, never copied from a past paper, mark scheme, textbook or revision site, with a command word (state, describe, explain, compare, calculate, evaluate, suggest) and marks that fit it (usually 2 to 6). Write your mark scheme first, one point per mark, and keep it hidden. Before marking they say how sure they are: sure, think so or guess. Then mark it with them point by point: each point got or not, and for each lost mark the reason (didn\'t know it, misread the question, calculation or unit slip, exam technique, knew it but couldn\'t apply it). Calculate questions earn method marks; evaluate needs both sides and a judgement. Show the points they missed. (b) Teach-back: "Explain it back to me in about 30 seconds, as if to a friend in the year below." If the lesson opened with a viva, the teach-back is the same viva prompt again, marked with viva_mark {phase: "after"} on the same points. Judge it complete, partial or wrong against the key points, name what is missing in one sentence, and keep their words. (c) "How do you feel about this topic now, 1 to 10?" Never argue with it; then one short "Why?". (d) "What made the most sense, or what did you like most?" Keep their words. (e) "Want a flashcard for this?" Draft one on the point that mattered most (usually a lost mark), show it, and only on yes send it as card {action: "added", front, back}. If cards already covers it, say so instead. No card when the only lost marks were misreads.',
  '5. lesson_save once, also when they say "done" early, with everything: steps, final_question with each point marked, teach_back (judgement, missing, their words in text), rating and rating_why, what_clicked, claude_view, questions_asked, tactics_used, misconceptions (add new ones; worked: the ids you probed; closed: only those they beat in this teach-back or final question), card and a summary in your own words. Never send outcome or minutes: the hub works them out and never changes their rating. "Next" or "teach me" again: call teach_next again.',
  'Rules: never put past-paper, mark-scheme, textbook or question-bank text in any field or reply; write everything in your own words. A misread gets no card. By voice: one question at a time, no lists or symbols, numbers said aloud.',
].join('\n');
export const SCHOOL_METHOD_VERSION = fnv1a(SCHOOL_METHOD_TEXT);
export const schoolMethod = () => ({ version: SCHOOL_METHOD_VERSION, style: 'school', text: SCHOOL_METHOD_TEXT });

export const COMMAND_WORDS = ['state', 'name', 'identify', 'describe', 'explain', 'compare', 'calculate', 'evaluate', 'suggest', 'discuss', 'analyse', 'justify', 'other'];
export const CONFIDENCE = { sure: 'sure', think_so: 'lean', guess: 'guess' };
export const LOST_REASONS = ERROR_TYPE_SETS.school;
export const SCHOOL_TYPES = { how_it_works: 'physiology', method: 'management', recall: 'pattern' };
const TYPE_NAME = Object.fromEntries(Object.entries(SCHOOL_TYPES).map(([k, v]) => [v, k]));
export const LIMITS = { brief_chars: 14_000, points: 12, marks: 20, point_chars: 120, lost_marks: 5, cards: 4 };
const RIGHT_AT = 0.8;
const DAY_MS = 86_400_000;   // the final question counts as right at 80% of its marks (4/5, 5/6); any mark is partial

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const cap = (s, n) => { if (s == null) return null; const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t || null; };
const LIVE = "('proposed','confirmed')";
const statement = (env, sql, ...binds) => env.DB.prepare(sql).bind(...binds);
const claudeUrl = prompt => `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;
const claudeAppUrl = prompt => `claude://claude.ai/new?q=${encodeURIComponent(prompt)}`;
const promptFor = (name, id) => `Teach me ${name} (map: ${id})`;

export function forStudent(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/^Off the checklist(?:: |\.\s*)/, '').replace(/^Lane [ABC](?:, Mehlman #\d+)?(?:: |\.\s*)/, '').replace(/\bweakest systems\b/g, 'weakest subjects')
    .replace(/\bfinal case\b/g, 'final question').replace(/\bMo rated it\b/g, 'They rated it').replace(/\bMo's\b/g, 'their').replace(/\bto Mo\b/g, 'to them')
    .replace(/\bask him\b/g, 'ask them').replace(/\bMo\b/g, 'they').replace(/^./, c => c.toUpperCase()) || null;
}

// ------------------------------------------------------------------ the student

async function student(env, user) {
  const row = await statement(env, 'SELECT profile, profile_json, prefs_json FROM users WHERE id = ?', user).first();
  if (!row) throw new HttpError(404, 'There is no such account.');
  const profile = buildProfile(row.profile, safeParse(row.profile_json, {}));
  if (!profile.platform) throw new HttpError(400, 'Teach me is not set up for this account.');
  return { profile, mods: modulesFor(profile, safeParse(row.prefs_json, {}), env) };
}

const TOPIC_SQL = `SELECT t.id, t.name, t.category_id AS subject_id, s.name AS subject_name, s.board, s.tier, u.name AS section, sc.seen, sc.t, sc.band
  FROM topics t
  JOIN subjects s ON s.user_id = t.user_id AND s.id = t.category_id AND s.status = 'active'
  LEFT JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id
  LEFT JOIN topic_scores sc ON sc.user_id = t.user_id AND sc.topic_id = t.id
  WHERE t.user_id = ?1 AND t.id = ?2 AND t.status IN ${LIVE}`;

/** One of the student's own live topics (in an active subject), or null. */
export async function ownTopic(env, user, id) {
  if (typeof id !== 'string' || !id || id.length > 120) return null;
  return statement(env, TOPIC_SQL, user, id).first();
}

/**
 * The student's topic for what they said: "(map: id)", an id, or a name (their aliases). Returns {topic} or
 * {ambiguous, choices} or {not_found, choices}.
 */
export async function findTopic(env, user, text) {
  const p = parseTopic(text);
  if (p.ids.length) {
    const t = await ownTopic(env, user, p.ids[0]);
    return t ? { topic: t } : { not_found: true, choices: [] };
  }
  const direct = await ownTopic(env, user, p.text);
  if (direct) return { topic: direct };
  const key = norm(p.text);
  if (!key) return { not_found: true, choices: [] };
  const hits = (await statement(env, `SELECT DISTINCT t.id, t.name, s.name AS subject FROM topic_aliases a
    JOIN topics t ON t.user_id = a.user_id AND t.id = a.topic_id AND t.status IN ${LIVE}
    JOIN subjects s ON s.user_id = t.user_id AND s.id = t.category_id AND s.status = 'active'
    WHERE a.user_id = ?1 AND a.alias_key = ?2 AND a.status = 'active' LIMIT 6`, user, key).all()).results || [];
  if (hits.length === 1) return { topic: await ownTopic(env, user, hits[0].id) };
  if (hits.length > 1) return { ambiguous: true, choices: hits.map(h => ({ id: h.id, name: h.name, subject: h.subject })) };
  // Nothing by name: up to three of their topics whose names share a word with it.
  const words = key.split(' ').filter(w => w.length >= 4).slice(0, 4);
  let choices = [];
  if (words.length) {
    choices = ((await statement(env, `SELECT t.id, t.name, s.name AS subject FROM topics t
      JOIN subjects s ON s.user_id = t.user_id AND s.id = t.category_id AND s.status = 'active'
      WHERE t.user_id = ?1 AND t.status IN ${LIVE} AND EXISTS (SELECT 1 FROM json_each(?2) w WHERE lower(t.name) LIKE '%' || w.value || '%')
      ORDER BY (SELECT count(*) FROM json_each(?2) w WHERE lower(t.name) LIKE '%' || w.value || '%') DESC, t.name LIMIT 3`, user, JSON.stringify(words)).all()).results || []).map(h => ({ id: h.id, name: h.name, subject: h.subject }));
  }
  return { not_found: true, choices };
}

// ------------------------------------------------------------------ what the brief adds (reads)

/** Their own flashcards on the topic, and the marks they lost on it (results, papers, lessons), in one batch. */
async function topicExtras(env, user, topicId) {
  const [cards, ev, lessons] = await env.DB.batch([
    statement(env, `SELECT id, front, back, source, created_at FROM cards WHERE user_id = ?1 AND topic_id = ?2 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 10`, user, topicId),
    statement(env, `SELECT day, at, kind, result, source, error_type, detail_json FROM evidence_live WHERE user_id = ?1 AND topic_id = ?2 AND slot = 0
      AND kind = 'question' AND result IN ('wrong','partial','flawed','omitted') ORDER BY at DESC LIMIT 8`, user, topicId),
    statement(env, `SELECT id, day, ended_at, final_result, final_explain_json, card_id, card_action FROM lessons WHERE user_id = ?1 AND topic_id = ?2
      AND status = 'done' AND final_result IN ('partial','wrong','right') ORDER BY ended_at DESC LIMIT 5`, user, topicId),
  ]);
  return { cards: cards.results || [], evidence: ev.results || [], lessons: lessons.results || [] };
}

/** Lost marks, newest first (pure): results and papers rows, then the points a lesson's final question lost. */
export function lostMarks({ evidence = [], lessons = [] } = {}, max = LIMITS.lost_marks) {
  const out = [];
  for (const e of evidence) {
    const label = (safeParse(e.detail_json, {}) || {}).label || e.source || null;
    out.push({ at: e.at || 0, day: e.day, from: 'results', label: cap(label, 80), result: e.result,
      ...(e.error_type ? { reason: e.error_type, reason_words: (ERROR_LABELS.school || {})[e.error_type] || null } : {}) });
  }
  for (const l of lessons) {
    const missing = ((safeParse(l.final_explain_json, null) || {}).missing || []).filter(x => typeof x === 'string');
    if (!missing.length) continue;
    out.push({ at: l.ended_at || 0, day: l.day, from: 'lesson', lesson_id: l.id, result: l.final_result, points: missing.slice(0, 4) });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max).map(({ at, ...x }) => x);
}

// ------------------------------------------------------------------ "What you know"

export async function schoolKnowledge(env, user, topicId) {
  const t = await ownTopic(env, user, topicId);
  if (!t) return null;
  const [page, extra] = await Promise.all([topicKnowledge(env, user, t.id), topicExtras(env, user, t.id)]);
  if (!page) return null;
  if (page.ready === false) return page;
  const byCard = new Map();
  for (const l of extra.lessons) if (l.card_id != null && !byCard.has(Number(l.card_id))) byCard.set(Number(l.card_id), l);
  const cards = extra.cards.map(c => {
    const l = byCard.get(Number(c.id));
    return { card_id: c.id, note_id: null, front: safeText(c.front, 240, null, { stem: false }), lesson_id: l ? l.id : null, day: londonDay(c.created_at),
      action: l ? l.card_action : null, source: c.source };
  });
  const out = {
    ...page,
    topic: { ...page.topic, lane: null, yield: null, unit: t.section ? { num: null, name: t.section, mehlman_rank: null } : null,
      subject: { id: t.subject_id, name: t.subject_name, board: t.board, board_name: boardName(t.board), tier: t.tier ?? null } },
    summary: { ...page.summary, cards: cards.length },
    cards,
    mehlman: [],
    lost_marks: lostMarks(extra, 8),
  };
  return out;
}

export async function schoolKnowledgeBrief(env, user, topicId) {
  const page = await schoolKnowledge(env, user, topicId);
  if (!page || page.ready === false) return null;
  const b = knowledgeBrief(page) || {};
  delete b.mehlman;
  const lost = page.lost_marks.slice(0, 2).map(x => (x.points ? `lesson: ${x.points.slice(0, 2).join('; ')}` : `${x.label || 'question'}: ${x.result}${x.reason_words ? ` (${x.reason_words})` : ''}`));
  return lost.length ? { ...b, lost_marks: lost } : b;
}

// ------------------------------------------------------------------ teach_next

const NEXT_KEYS = ['topic', 'group', 'skip', 'lesson_id', 'peek', 'voice'];

function checkNext(a) {
  if (!isObj(a)) return 'teach_next takes an object.';
  for (const k of Object.keys(a)) if (!NEXT_KEYS.includes(k)) return `Unknown argument ${k}.`;
  if (a.topic != null && (typeof a.topic !== 'string' || !a.topic.trim() || a.topic.length > 120)) return 'topic is text of at most 120 characters.';
  if (a.lesson_id != null && (typeof a.lesson_id !== 'string' || !/^[\w-]{1,40}$/.test(a.lesson_id))) return 'lesson_id is the id teach_next gave.';
  if (a.skip != null && (!Array.isArray(a.skip) || a.skip.length > 10 || a.skip.some(x => typeof x !== 'string' || !x || x.length > 120))) return 'skip is a list of at most 10 topic ids.';
  for (const k of ['peek', 'voice']) if (a[k] != null && typeof a[k] !== 'boolean') return `${k} is true or false.`;
  if (a.group != null && (!Array.isArray(a.group) || a.group.length < GROUP.min || a.group.length > GROUP.max || a.group.some(x => typeof x !== 'string' || !x.trim() || x.length > 120))) return `group is ${GROUP.min} to ${GROUP.max} of their topics (names or ids).`;
  if (a.group != null && a.topic != null) return 'Give topic or group, not both.';
  return null;
}

export const GROUP = { min: 2, max: 6, weak_t: 0.6, suggest: 3 };   // weak: t 600 and over (scale.js BANDS)
export const GROUP_HOW = 'A group lesson: teach the forest, not the trees. Viva first on the whole group (what they know about each, and how they connect). '
  + 'Then the one idea, process or skill under all of them, taught first; then each member in a sentence or two as a case of it, and what tells look-alike members apart. '
  + 'Check with one question that needs two members at once. lesson_save once for the lesson (its topic is the first member); viva_mark each member that the viva covered.';

/** Sections where 2 or more topics are weak now, weakest first: [{section, subject, topics: [{id, name, band}]}]. */
export async function weakGroups(env, user, { limit = GROUP.suggest } = {}) {
  const { results } = await statement(env, `SELECT t.id, t.name, u.name AS section, s.name AS subject, sc.band, sc.t
    FROM topics t JOIN subjects s ON s.user_id = t.user_id AND s.id = t.category_id AND s.status = 'active'
    JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id
    JOIN topic_scores sc ON sc.user_id = t.user_id AND sc.topic_id = t.id
    WHERE t.user_id = ?1 AND t.status IN ${LIVE} AND sc.seen = 1 AND sc.t >= ?2
    ORDER BY sc.t DESC LIMIT 200`, user, GROUP.weak_t).all().catch(() => ({ results: [] }));
  const by = new Map();
  for (const r of results || []) {
    const k = `${r.subject}\u0000${r.section}`;
    if (!by.has(k)) by.set(k, { section: r.section, subject: r.subject, topics: [] });
    if (by.get(k).topics.length < GROUP.max) by.get(k).topics.push({ id: r.id, name: r.name, band: bandWord(bandOf(Math.round(Number(r.t) * 1000))) });
  }
  return [...by.values()].filter(g => g.topics.length >= GROUP.min).slice(0, limit);
}

const shapeCard = c => ({ id: c.id, front: cap(c.front, 160), back: cap(c.back, 200) });
const chip = r => { const seen = Number(r.seen) === 1; const t1000 = seen && r.t != null ? Math.round(Number(r.t) * 1000) : null; const code = seen ? (r.band && r.band !== 'unseen' ? r.band : bandOf(t1000)) : 'unseen'; return { band: code === 'unseen' ? null : bandWord(code), t1000 }; };

const TRIM = [
  b => { if (b.queue && b.queue.length > 2) { b.queue = b.queue.slice(0, 2); return true; } return false; },
  b => { if (b.past_lessons && b.past_lessons.length > 1) { b.past_lessons = b.past_lessons.slice(0, 1); return true; } return false; },
  b => { const l = b.library; if (!l || !l.candidates || l.candidates.length <= 2) return false; l.candidates = l.candidates.slice(0, 2); return true; },
  b => { const l = b.library; if (!l || !l.passages || l.passages.length <= 2) return false; l.passages = l.passages.slice(0, 2).map(p => ({ ...p, text: cap(p.text, 300) })); return true; },
  b => { if (b.cards && b.cards.length > 2) { b.cards = b.cards.slice(0, 2); return true; } return false; },
  b => { if (b.memory && b.memory.length > 3) { b.memory = b.memory.slice(0, 3); return true; } return false; },
  b => { if (b.lost_marks && b.lost_marks.length > 2) { b.lost_marks = b.lost_marks.slice(0, 2); return true; } return false; },
  b => { if (b.knowledge) { delete b.knowledge; return true; } return false; },
  b => { if (b.library) { delete b.library; return true; } return false; },
];
function fitBrief(b, max = LIMITS.brief_chars) {
  for (const step of TRIM) { if (JSON.stringify(b).length <= max) break; step(b); }
  return b;
}

export const SCHOOL_LIBRARY_USE = 'A shortlist from their own library: the first passages in full and candidates with their opening line, best first. Choose what will help them most for this lesson; to read a candidate in full, library_search its opening words for the doc_id, then library_read at the page in its cite. Name the document you teach from, and put it in your own words. If two of their sources disagree, say so at the start, naming both, then teach what their exam board expects.';
export function schoolLibrary(l) {
  if (!isObj(l)) return l;
  const { use, next_step, ...rest } = l;
  return { ...rest, ...(l.passages && l.passages.length ? { use: SCHOOL_LIBRARY_USE } : {}),
    ...(next_step ? { next_step: l.status === 'pending' ? 'Search it with library_search.' : 'More in their library: library_search, then library_read.' } : {}) };
}

/** The final the profile asks for (profiles.js teach.final): an exam-style question with a mark scheme for school. */
function finalSpec(profile, t) {
  const style = (profile.teach && profile.teach.final) || 'exam_question';
  return {
    style, command_words: COMMAND_WORDS.filter(w => w !== 'other'), marks: '2 to 6, one mark scheme point per mark',
    ...(t ? { board: boardName(t.board), tier: t.tier ?? null } : {}),
    confidence: Object.keys(CONFIDENCE), lost_reasons: Object.fromEntries(LOST_REASONS.map(k => [k, (ERROR_LABELS.school || {})[k] || k])),
    right_at: `${Math.round(RIGHT_AT * 100)}% of the marks`,
  };
}

export function schoolBrief(r, { profile, mods, topic = null, extras = null, knowledge = null, lastViva = null } = {}) {
  if (!isObj(r)) return r;
  if (r.refused) return { refused: true, reason: forStudent(r.reason) };
  const base = { lesson_id: r.lesson_id ?? null, method: schoolMethod() };
  if (r.offer) {
    return { ...base, offer: { day: r.offer.day, options: (r.offer.options || []).map(o => ({ ...o, claude_url: claudeUrl(o.prompt) })), line: r.offer.line || null },
      say: r.say,
      next_step: 'Offer them both, one short line each, and ask which. Then call teach_next once with topic set to their pick\'s prompt. "You choose": the first one. Something else: teach_next with that topic.' };
  }
  if (r.map_ready === false) return { ...base, map_ready: false, next_step: 'They have no topics yet: add a subject\'s topics with add_topics (study_overview lists their subjects), then teach_next again.' };
  if (r.nothing_due || r.rest) return { ...base, nothing_due: true, say: 'Nothing needs a lesson right now: name a topic to learn.' };
  const t = topic;
  const brief = {
    lesson_id: r.lesson_id ?? null, ...(r.lesson_id ? {} : { peek: true }), mode: r.mode, served_by: r.served_by, surface: r.surface, days_left: r.days_left ?? null,
    lesson_minutes: r.lesson_minutes, turn_words: r.turn_words, as_of_seq: r.as_of_seq,
    topic: r.topic ? {
      id: r.topic.id, name: r.topic.name,
      subject: t ? { id: t.subject_id, name: t.subject_name, board: t.board, board_name: boardName(t.board), tier: t.tier ?? null } : null,
      section: t ? t.section ?? null : null, ...(t ? chip(t) : {}), why: r.topic.why, why_chosen: forStudent(r.topic.why_chosen),
    } : null,
    runner_ups: (r.runner_ups || []).map(x => ({ ...x, why: forStudent(x.why) })),
    ...(r.requested_by ? { requested_by: r.requested_by } : {}),
    ...(r.carries_on ? { carries_on: r.carries_on } : {}),
    gaps: r.gaps || [],
    misconceptions: (r.misconceptions || []).map(m => ({ ...m, words: m.words === 'mo' ? 'student' : m.words })),
    tactics: r.tactics ? { ...r.tactics, content_type: TYPE_NAME[r.tactics.content_type] || r.tactics.content_type } : null,
    edge_from_log: r.edge_from_log,
    lost_marks: extras ? lostMarks(extras) : [],
    ...(r.look_alikes && r.look_alikes.length ? { look_alikes: r.look_alikes } : {}),
    cards: extras ? extras.cards.slice(0, LIMITS.cards).map(shapeCard) : [],
    card_ok: !!(mods && mods.cards),
    ...(r.library && mods && mods.library ? { library: schoolLibrary(r.library) } : {}),
    past_lessons: (r.past_lessons || []).map(p => {
      const { mo_rating, note, ...rest } = p;
      return { ...rest, ...(mo_rating !== undefined ? { rating: mo_rating } : {}), ...(note ? { note: forStudent(note) } : {}) };
    }),
    memory: r.memory || [],
    ...(knowledge ? { knowledge } : {}),
    final: finalSpec(profile, t),
    method: schoolMethod(),
    queue: (r.queue || []).map(x => ({ ...x, why: forStudent(x.why) })),
    ...(r.lesson_id && r.topic && r.mode === 'lesson' && !r.carries_on ? { viva: vivaBrief(r.topic, lastViva) } : {}),
    ...(r.say ? { say: forStudent(r.say) } : {}),
    ...(r.answers && r.answers.ready && r.answers.ready.length ? { ready_questions: r.ready_questions, answers: r.answers } : {}),
  };
  return fitBrief(brief);
}

/** teach_next for a student (the connector tool). ctx: the tool context ({waitUntil, origin}). */
export async function teachNextFor(env, user, args = {}, ctx = {}) {
  const bad = checkNext(args);
  if (bad) throw new HttpError(400, bad);
  const info = await student(env, user);
  const call = {};
  let topic = null;
  if (args.topic) {
    const f = await findTopic(env, user, args.topic);
    if (!f.topic) {
      return { lesson_id: null, ...(f.ambiguous ? { ambiguous: true } : { not_found: true }), asked: cap(args.topic, 120), choices: f.choices || [],
        next_step: f.ambiguous ? 'Several of their topics have that name: ask which subject, then call teach_next with that topic id.'
          : 'That is not one of their topics. Ask if they meant one of choices, or add it with add_topics first, then call teach_next again.' };
    }
    topic = f.topic;
    call.topic = `${topic.name} (map: ${topic.id})`;
  }
  let members = null;
  if (args.group) {
    members = [];
    for (const g of args.group) {
      const f = await findTopic(env, user, g);
      if (!f.topic) return { lesson_id: null, not_found: true, asked: cap(g, 120), choices: f.choices || [], next_step: 'One of the group is not their topic: ask which they meant, then call teach_next with the group again.' };
      if (!members.some(m => m.id === f.topic.id)) members.push(f.topic);
    }
    topic = members[0];
    call.topic = `${topic.name} (map: ${topic.id})`;
  }
  if (args.skip && args.skip.length) call.skip = args.skip;
  if (args.lesson_id) call.lesson_id = args.lesson_id;
  if (args.peek) call.peek = true;
  if (args.voice) call.voice = true;
  const r = await teachNext(env, user, call, { ...ctx, actor: 'claude', via: 'platform:teach_next' });
  if (r && r.refused) throw new HttpError(400, forStudent(r.reason));
  const id = r && r.topic && r.topic.id;
  if (id && (!topic || topic.id !== id)) topic = await ownTopic(env, user, id);
  const [extras, knowledge, lastViva] = id ? await Promise.all([topicExtras(env, user, id).catch(e => { if (noTable(e)) return null; throw e; }),
    schoolKnowledgeBrief(env, user, id).catch(() => null), lastVivaFor(env, user, id).catch(() => null)]) : [null, null, null];
  const brief = schoolBrief(r, { profile: info.profile, mods: info.mods, topic, extras, knowledge, lastViva });
  // How they asked to be taught (Make it mine, custom.js teach.notes): Claude follows it within the school method.
  const notes = await getCustom(env, user).then(c => c && c.teach && c.teach.notes, () => null);
  let out = notes && isObj(brief) && !brief.refused ? { ...brief, their_preferences: notes } : brief;
  if (members && isObj(out) && !out.refused) {
    out = { ...out, group: { members: members.map(m => ({ id: m.id, name: m.name, section: m.section ?? null, ...chip(m) })), how: GROUP_HOW },
      ...(out.viva ? { viva: { ...out.viva, prompt: `${members.map(m => m.name).join(', ')}: tell me what you know about each, and how they connect.` } } : {}) };
  } else if (!args.topic && isObj(out) && !out.refused && !args.peek) {
    // Today's own pick, with the forest beside it: a section where several topics are weak.
    const groups = await weakGroups(env, user, { limit: 1 }).catch(() => []);
    if (groups.length) out = { ...out, forest_option: { ...groups[0], say: `${groups[0].topics.length} topics in ${groups[0].section} are weak. Offer to teach them together (teach_next {group}).` } };
  }
  return out;
}

// ------------------------------------------------------------------ lesson_save

const SAVE_KEYS = ['lesson_id', 'status', 'goal', 'probe', 'steps', 'final_question', 'teach_back', 'rating', 'rating_why', 'what_clicked', 'claude_view',
  'questions_asked', 'tactics_used', 'content_type', 'misconceptions', 'card', 'summary', 'weak_spot', 'memory', 'surface'];
const RENAMED = { mo_rating: 'rating', mo_rating_why: 'rating_why', final_case: 'final_question' };
const MO_ONLY = ['five_step', 'items', 'links', 'new_topic', 'media_shown', 'kind', 'link_id', 'miss_ids', 'mo_feedback'];

// A refusal, as every platform tool gives one (mcp.js: {refused: true, reason} with isError). field is named in the words.
const refuse = (reason, field = null) => { throw new HttpError(400, field && !String(reason).includes(field) ? `${reason} (${field})` : reason); };
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function markFinal(f) {
  if (!isObj(f)) return { fix: 'final_question is an object: {command_word, marks, points: [{point, got, lost_reason?}], confidence}.' };
  for (const k of Object.keys(f)) if (!['command_word', 'marks', 'points', 'confidence', 'skipped'].includes(k)) return { fix: `final_question has no field ${k}.` };
  if (f.skipped === true) return { final_case: { result: 'skipped' }, marked: { skipped: true }, lost: [] };
  if (f.command_word != null && !COMMAND_WORDS.includes(f.command_word)) return { fix: `final_question.command_word is one of ${COMMAND_WORDS.join(', ')}.` };
  if (!Number.isInteger(f.marks) || f.marks < 1 || f.marks > LIMITS.marks) return { fix: `final_question.marks is a whole number from 1 to ${LIMITS.marks}.` };
  if (!Array.isArray(f.points) || !f.points.length || f.points.length > LIMITS.points) return { fix: `final_question.points lists the mark scheme points (1 to ${LIMITS.points}), each marked got or not.` };
  for (const [i, p] of f.points.entries()) {
    if (!isObj(p) || typeof p.got !== 'boolean') return { fix: `final_question.points[${i}] is {point, got: true or false, lost_reason?}.` };
    for (const k of Object.keys(p)) if (!['point', 'got', 'lost_reason'].includes(k)) return { fix: `final_question.points[${i}] has no field ${k}.` };
    if (!str(p.point, LIMITS.point_chars)) return { fix: `final_question.points[${i}].point is the mark scheme point in your own words, at most ${LIMITS.point_chars} characters.` };
    if (looksLikeStem(p.point)) return { fix: `final_question.points[${i}].point reads like copied question text: write the point in your own words.` };
    if (p.lost_reason != null && (p.got || !LOST_REASONS.includes(p.lost_reason))) return { fix: `final_question.points[${i}].lost_reason is one of ${LOST_REASONS.join(', ')}, only for a point they lost.` };
  }
  if (f.confidence != null && !(f.confidence in CONFIDENCE)) return { fix: 'final_question.confidence is sure, think_so or guess.' };
  const scored = Math.min(f.marks, f.points.filter(p => p.got).length);
  const lost = f.points.filter(p => !p.got).map(p => ({ point: p.point.trim(), reason: p.lost_reason || null }));
  const result = scored / f.marks >= RIGHT_AT ? 'right' : scored > 0 ? 'partial' : 'wrong';
  // Their written answer is their explanation, marked against the mark scheme: complete, partial or wrong, and the missed points.
  const verdict = scored >= f.marks ? 'complete' : scored > 0 ? 'partial' : 'wrong';
  const missing = lost.slice(0, 4).map(l => cap(l.point, 80));
  return {
    final_case: { result, ...(f.confidence ? { confidence: CONFIDENCE[f.confidence] } : {}), explanation_judgement: { verdict, ...(missing.length ? { missing } : {}) } },
    marked: { command_word: f.command_word || null, marks: f.marks, scored, result, confidence: f.confidence || null, lost },
    lost,
  };
}

export function toMoSave(a) {
  if (!isObj(a)) return { fix: 'lesson_save takes an object.', field: null };
  for (const k of Object.keys(a)) {
    if (RENAMED[k]) return { fix: `Use ${RENAMED[k]} instead of ${k}.`, field: k };
    if (['outcome', 'minutes', 'blend'].includes(k)) return { fix: `Leave out ${k}: the hub works it out from what you record.`, field: k };
    if (MO_ONLY.includes(k) || !SAVE_KEYS.includes(k)) return { fix: `Unknown argument ${k}.`, field: k };
  }
  const out = {};
  for (const k of ['lesson_id', 'status', 'goal', 'probe', 'steps', 'teach_back', 'what_clicked', 'claude_view', 'questions_asked', 'tactics_used', 'misconceptions', 'weak_spot', 'memory', 'surface']) {
    if (a[k] !== undefined) out[k] = a[k];
  }
  if (a.rating !== undefined) out.mo_rating = a.rating;
  if (a.rating_why !== undefined) out.mo_rating_why = a.rating_why;
  if (a.content_type !== undefined) {
    if (!(a.content_type in SCHOOL_TYPES)) return { fix: `content_type is one of ${Object.keys(SCHOOL_TYPES).join(', ')}.`, field: 'content_type' };
    out.content_type = SCHOOL_TYPES[a.content_type];
  }
  let marked = null, lost = [];
  if (a.final_question !== undefined) {
    const m = markFinal(a.final_question);
    if (m.fix) return { fix: m.fix, field: 'final_question' };
    out.final_case = m.final_case;
    marked = m.marked;
    lost = m.lost;
    if (!out.weak_spot && lost.length) {
      out.weak_spot = cap(`Lost: ${lost.map(l => `${l.point}${l.reason ? ` (${(ERROR_LABELS.school || {})[l.reason] || l.reason})` : ''}`).join('; ')}`, 200);
    }
  }
  const line = marked && !marked.skipped ? `Final question${marked.command_word ? ` (${marked.command_word})` : ''}: ${marked.scored}/${marked.marks}.` : null;
  if (a.summary !== undefined || line) {
    const s = typeof a.summary === 'string' ? a.summary.trim() : '';
    out.summary = s && line ? `${s.slice(0, 1199 - line.length)} ${line}` : s || line;
    if (a.summary !== undefined && typeof a.summary !== 'string') out.summary = a.summary;
  }
  return { args: out, marked, lost };
}

const CARD_KEYS = ['action', 'front', 'back', 'card_id'];
const cardsAddTool = () => CARD_TOOLS.find(t => t.name === 'cards_add');

/** lesson_save for a student (the connector tool). */
export async function lessonSaveFor(env, user, args = {}, ctx = {}) {
  const info = await student(env, user);
  const mapped = toMoSave(args);
  if (mapped.fix) return refuse(mapped.fix, mapped.field);
  const moArgs = mapped.args;
  const lesson = typeof moArgs.lesson_id === 'string' && moArgs.lesson_id.length <= 40
    ? await statement(env, 'SELECT id, status, topic_id, card_id FROM lessons WHERE user_id = ?1 AND id = ?2', user, moArgs.lesson_id).first() : null;
  if (!lesson) return refuse('No lesson has that id: use the lesson_id teach_next gave.', 'lesson_id');
  if (lesson.status === 'requested') return refuse('That lesson was only requested: start it with teach_next first.', 'lesson_id');

  // The card, only on their yes: the platform's own deck (cards.js cards_add), never Anki. A lesson whose lost marks
  // were all misreads (profile.rules.no_card_for) gets none.
  const c = args.card;
  let cardReply = null, toCreate = null;
  if (c !== undefined) {
    if (!isObj(c) || Object.keys(c).some(k => !CARD_KEYS.includes(k)) || !['added', 'declined', 'none'].includes(c.action)) {
      return refuse('card is {action: "added", front, back} on their yes (or {action: "added", card_id} for a card you already added), {action: "declined"} or {action: "none"}.', 'card');
    }
    if (c.action !== 'added') moArgs.card = { action: c.action };
    else {
      const noCard = (info.profile.rules && info.profile.rules.no_card_for) || ['misread'];
      const lost = mapped.lost || [];
      if (lost.length && lost.every(l => l.reason && noCard.includes(l.reason))) {
        cardReply = { added: false, reason: 'Every mark lost was a misread: no card for that. Say so in a sentence.' };
        moArgs.card = { action: 'none' };
      } else if (c.card_id != null) {
        const own = Number.isInteger(c.card_id) ? await statement(env, 'SELECT id FROM cards WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL', user, c.card_id).first() : null;
        if (!own) return refuse('That card is not one of theirs: add it with card {action: "added", front, back}.', 'card.card_id');
        moArgs.card = { action: 'added', card_id: own.id };
        cardReply = { added: true, id: own.id };
      } else if (!str(c.front, 599) || !str(c.back, 599)) {
        return refuse('card needs front and back (each under 600 characters, in your own words) when action is added.', 'card');
      } else if (!info.mods.cards) {
        cardReply = { added: false, reason: 'Flashcards are switched off in their Settings, so no card was made.', card_suggestion: { front: c.front, back: c.back, topic_id: lesson.topic_id } };
        moArgs.card = { action: 'none' };
      } else toCreate = { front: c.front.trim(), back: c.back.trim() };
    }
  }
  if (toCreate) {
    const pre = checkSave({ ...moArgs, card: { action: 'added' } });
    if (pre) return refuse(forStudent(pre.fix), pre.field);
    const made = await cardsAddTool().run(env, user, { cards: [{ ...toCreate, ...(lesson.topic_id ? { topic_id: lesson.topic_id } : {}) }] });
    let id = made && made.cards && made.cards[0] ? made.cards[0].id : null;
    let action = 'added';
    if (id == null) {   // the same front was already in their deck: the lesson points at that card
      const dup = await statement(env, 'SELECT id FROM cards WHERE user_id = ?1 AND front = ?2 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', user, toCreate.front).first();
      id = dup ? dup.id : null;
      action = 'edited_existing';
    }
    moArgs.card = id != null ? { action, card_id: id } : { action: 'none' };
    cardReply = id != null ? { added: action === 'added', id, ...(action === 'added' ? {} : { note: 'They already had a card with that front.' }) } : { added: false };
  }

  const r = await lessonSave(env, user, moArgs, { ...ctx, actor: 'claude', via: 'platform:lesson_save' });
  if (r.refused) refuse(forStudent(r.reason), r.field);
  if (r.needs_confirm) refuse('That is a lot of changes at once: try again in a few minutes.');
  return {
    saved: true, outcome: r.outcome, minutes: r.minutes, ...(r.stopped_early ? { stopped_early: true } : {}), blend: r.blend,
    ...(mapped.marked ? { final: mapped.marked } : {}),
    views: r.views ? { student: r.views.mo, claude: r.views.claude } : null,
    facts: r.facts, ...(r.gates ? { gates: r.gates.map(forStudent) } : {}),
    misconceptions: r.misconceptions,
    tactics: r.tactics ? { ...r.tactics, content_type: TYPE_NAME[r.tactics.content_type] || r.tactics.content_type } : null,
    tidy: r.tidy, topic: r.topic || null,
    ...(r.next ? { next: r.next.topic ? { topic: r.next.topic, why: forStudent(r.next.why) } : r.next } : {}),
    ...(cardReply ? { card: cardReply } : {}),
    ...(r.note ? { note: forStudent(r.note) } : {}),
    undo: { batch_id: r.batch_id, say: 'They can undo it in the app.' },
  };
}

// ------------------------------------------------------------------ the morning choice

// Each option's subject, strength and claude.ai link (pure). rows: [{id, subject_id, subject_name, seen, t, band}].
function withTopics(c, rows) {
  if (!c || !Array.isArray(c.options) || !c.options.length) return c;
  const by = new Map((rows || []).map(r => [r.id, r]));
  return {
    ...c,
    options: c.options.map(o => {
      const r = by.get(o.topic.id);
      const seen = r && Number(r.seen) === 1;
      return { ...o, topic: { ...o.topic, subject_id: r ? r.subject_id : o.topic.category_id, subject_name: r ? r.subject_name : null, ...(r ? chip(r) : {}),
        band_code: seen ? (r.band && r.band !== 'unseen' ? r.band : bandOf(Math.round(Number(r.t) * 1000))) : null }, claude_url: claudeUrl(o.prompt) };
    }),
    ...(c.push ? { push: { ...c.push, open: '#today' } } : {}),
  };
}

const OPTION_TOPICS_SQL = `SELECT t.id, t.category_id AS subject_id, s.name AS subject_name, sc.seen, sc.t, sc.band FROM topics t
  JOIN subjects s ON s.user_id = t.user_id AND s.id = t.category_id
  LEFT JOIN topic_scores sc ON sc.user_id = t.user_id AND sc.topic_id = t.id
  WHERE t.user_id = ?1 AND t.id IN (SELECT value FROM json_each(?2))`;

export async function schoolChoice(env, user, { build = true, replace = false, via = 'platform:today' } = {}) {
  const c = await todayOffer(env, user, { build, replace, via });
  if (!c || !Array.isArray(c.options) || !c.options.length) return c;
  const ids = c.options.map(o => o.topic && o.topic.id).filter(Boolean);
  return withTopics(c, (await statement(env, OPTION_TOPICS_SQL, user, JSON.stringify(ids)).all()).results || []);
}

const OFFER_SQL = `SELECT o.day, o.slot, o.topic_id, o.topic_name, o.category_id, o.pick, o.reason, o.why_json, o.state, o.offered_at, o.decided_at, o.via,
    o.lesson_id, o.updated_at, t.category_id AS t_subject_id, s.name AS t_subject_name, sc.seen AS t_seen, sc.t AS t_t, sc.band AS t_band
  FROM teach_offers o
  LEFT JOIN topics t ON t.user_id = o.user_id AND t.id = o.topic_id
  LEFT JOIN subjects s ON s.user_id = t.user_id AND s.id = t.category_id
  LEFT JOIN topic_scores sc ON sc.user_id = o.user_id AND sc.topic_id = o.topic_id
  WHERE o.user_id = ?1 AND o.day = ?2 ORDER BY o.slot`;

export function todayChoiceStatements(env, user, now = Date.now()) {
  const day = londonDay(now);
  return [
    statement(env, OFFER_SQL, user, day),
    statement(env, AVOID_SQL, user, now - AVOID_RULES.passed.days * DAY_MS, now - AVOID_RULES.unstudied.days * DAY_MS, day),
  ];
}

/** Today's `choice` from todayChoiceStatements' results; builds the day's offer only when there is none yet. Never fails Today. */
export async function todayChoiceFrom(env, user, mods, [offers, avoid], { topics = 0, now = Date.now() } = {}) {
  if (!mods || !mods.connector) return null;
  const day = londonDay(now);
  const rows = (offers && offers.results) || [];
  try {
    if (!rows.length) return topics > 0 ? await schoolChoice(env, user, { build: true }) : { ready: true, ...shapeToday([], { day, now }) };
    const c = { ready: true, ...shapeToday(rows, { day, avoid: avoidanceFromRows((avoid && avoid.results) || [], now), now }) };
    return withTopics(c, rows.map(r => ({ id: r.topic_id, subject_id: r.t_subject_id, subject_name: r.t_subject_name, seen: r.t_seen, t: r.t_t, band: r.t_band })));
  } catch (e) {
    console.error('today choice failed', e && e.message);
    return null;
  }
}

async function choiceGet(request, env, ctx, params, url, user, session) {
  requireModule(session, 'connector', env);
  return json(await schoolChoice(env, user, { build: url.searchParams.get('build') !== '0' }));
}

async function choiceChoose(request, env, ctx, params, url, user, session) {
  requireModule(session, 'connector', env);
  const body = await readJson(request, 10_000);
  if (!isObj(body) || typeof body.topic_id !== 'string' || !body.topic_id) throw new HttpError(400, 'Say which topic: topic_id.');
  const args = { topic_id: body.topic_id, ...(['ipad', 'phone', 'mac', 'other'].includes(body.device) ? { device: body.device } : {}) };
  const r = await applyChange(env, user, { actor: LEARNER, surface: 'web', op: 'today.pick', args, via: 'platform:today.choose' });
  if (!r.ok) throw new HttpError(/not one of today|no offer/i.test(r.reason || '') ? 404 : 400, forStudent(r.reason || 'That did not work.'));
  return json({ lesson_id: r.lesson_id, prompt: r.prompt, reused: !!r.reused, day: r.day, chosen: r.chosen, claude_url: claudeUrl(r.prompt), claude_app_url: claudeAppUrl(r.prompt),
    today: await schoolChoice(env, user, { build: false }) });
}

async function choiceRefresh(request, env, ctx, params, url, user, session) {
  requireModule(session, 'connector', env);
  return json(await schoolChoice(env, user, { build: true, replace: true, via: 'platform:today.refresh' }));
}

// ------------------------------------------------------------------ Teach me tap and "What you know"

async function teachRequest(request, env, ctx, params, url, user, session) {
  requireModule(session, 'connector', env);
  const body = await readJson(request, 10_000);
  if (!isObj(body)) throw new HttpError(400, 'Say which topic: topic_id.');
  const t = await ownTopic(env, user, body.topic_id);
  if (!t) throw new HttpError(404, 'There is no such topic.');
  const args = { topic_id: t.id, from: 'map', ...(['ipad', 'phone', 'mac', 'other'].includes(body.device) ? { device: body.device } : {}) };
  const r = await applyChange(env, user, { actor: LEARNER, surface: 'web', op: 'lesson.request', args, via: 'platform:teach.request' });
  if (!r.ok) throw new HttpError(400, forStudent(r.reason || 'That did not work.'));
  const prompt = r.prompt || promptFor(t.name, t.id);
  return json({ lesson_id: r.lesson_id, prompt, reused: !!r.reused, claude_url: claudeUrl(prompt), claude_app_url: claudeAppUrl(prompt) });
}

async function knowledgeGet(request, env, ctx, params, url, user, session) {
  requireModule(session, 'map', env);
  const page = await schoolKnowledge(env, user, params.id);
  if (!page) throw new HttpError(404, 'There is no such topic.');
  return json(page);
}

export const ROUTES = [
  ['GET', '/api/p/topics/:id/knowledge', knowledgeGet],
  ['GET', '/api/p/today/choice', choiceGet],
  ['POST', '/api/p/today/choice/choose', choiceChoose],
  ['POST', '/api/p/today/choice/refresh', choiceRefresh],
  ['POST', '/api/p/teach/request', teachRequest],
];

// ------------------------------------------------------------------ connector tools

const s = (max, extra = {}) => ({ type: 'string', maxLength: max, ...extra });
const e = list => ({ type: 'string', enum: list });
const obj = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const arr = (items, max) => ({ type: 'array', maxItems: max, items });
const JUDGED = ['complete', 'partial', 'wrong'];

export const TOOLS = [
  {
    name: 'teach_next', module: 'map',
    description: 'For "teach me", "teach me X" or a Teach me tap (the prompt "Teach me X (map: id)"): call first, once. Picks the topic (or offers today\'s two) and holds the lesson: their gaps, lost marks, misconceptions, cards, past lessons, what they already know, the tactics to lead with and the school method. Teach with method, end with an exam-style question marked point by point, then lesson_save. group: 2 to 6 topics taught together (the big picture). "Next": call again with skip. peek writes nothing.',
    inputSchema: obj({ topic: s(120), group: arr(s(120), 6), skip: arr(s(120), 10), lesson_id: s(40), peek: { type: 'boolean' }, voice: { type: 'boolean' } }),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (env, user, args, ctx) => teachNextFor(env, user, args, ctx),
  },
  {
    name: 'lesson_save', module: 'map',
    description: 'End every lesson once (also on "done"): checks, the final exam-style question marked point by point with their confidence, the 30 s teach-back (their words in text), their 1-10 and why, what clicked, your view, questions, tactics, misconceptions, and card {action: "added", front, back} only on their yes. Never send outcome or minutes.',
    inputSchema: obj({
      lesson_id: s(40), status: e(['done', 'abandoned']), goal: s(200),
      probe: arr(obj({ summary: s(120), result: e(PROBE_RESULTS), from: e(PROBE_FROM), ref: s(60) }, ['result']), 4),
      steps: arr(obj({ title: s(80), check: e(STEP_CHECKS), repair_angle: s(80) }, ['check']), 5),
      final_question: obj({
        command_word: e(COMMAND_WORDS), marks: { type: 'integer', minimum: 1, maximum: LIMITS.marks },
        points: arr(obj({ point: s(LIMITS.point_chars), got: { type: 'boolean' }, lost_reason: e(LOST_REASONS) }, ['point', 'got']), LIMITS.points),
        confidence: e(Object.keys(CONFIDENCE)), skipped: { type: 'boolean' },
      }),
      teach_back: obj({ judgement: e(JUDGED), missing: arr(s(80), 4), text: s(600) }, ['judgement']),
      rating: { type: 'integer', minimum: 1, maximum: 10 }, rating_why: s(200), what_clicked: s(200),
      claude_view: obj({ verdict: e(CLAUDE_VIEWS), reasons: s(300) }, ['verdict']),
      questions_asked: { type: 'integer', minimum: 0, maximum: 50 }, tactics_used: arr(e(TACTIC_VOCAB), 4), content_type: e(Object.keys(SCHOOL_TYPES)),
      weak_spot: s(200),
      misconceptions: obj({ add: arr(obj({ belief: s(200), ref: s(60) }, ['belief']), 2), closed: arr(s(40), 4), worked: arr(s(40), 3) }),
      card: obj({ action: e(['added', 'declined', 'none']), front: s(599), back: s(599), card_id: { type: 'integer', minimum: 1 } }, ['action']),
      summary: s(1200),
      memory: obj({
        used: arr(obj({ id: s(40), effect: e(EFFECTS) }, ['id', 'effect']), 6),
        new: arr(obj({ scope: e(SCOPES), scope_ref: s(80), tactic: e(TACTICS), note: s(NOTE_MAX) }, ['scope', 'tactic', 'note']), 2),
      }),
      surface: e(['voice', 'chat', 'code']),
    }, ['lesson_id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: (env, user, args, ctx) => lessonSaveFor(env, user, args, ctx),
  },
];
