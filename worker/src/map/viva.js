import { londonDay } from '../util.js';
import { stemSafe, questionSafe } from './guard.js';
import { noteJob } from '../job-log.js';
import { readScore, stateOf } from './weakness.js';
import { yieldOf } from './teach-priority.js';
import { nEffOfScore, EVIDENCE } from '../../../public/js/shared/evidence.js';
import { bandWord } from '../../../public/js/map/scale.js';
import { CONCEPT_RULES, CONCEPT_SCHEMA_PROPS, CONCEPT_FIELDS, tidyConcept } from '../../../public/js/shared/concept.js';
import { coreRules, coreSchema, tidyCore, FORM_VERSIONS } from '../answer-core.js';
import { CAUSES } from '../../../public/js/shared/cause.js';
import { readCluster } from './clusters.js';

export const VIVA = {
  points_min: 6, points_max: 18, point_max: 160, quote_max: 160, transcript_max: 8000,
  yield_w: { high: 2, normal: 1 },          // high-yield points weigh double in the coverage
  tested_w: 0.5, tested_max: 2,
  // The lesson viva's wait (lesson_save {phase}): the connector waits up to wait_ms for the marker, checking every
  // poll_ms, then answers {pending: true, call_again_in: again_s}; a call with no words waits poll_wait_ms.
  wait_ms: 45_000, poll_wait_ms: 30_000, poll_ms: 2500, again_s: 15, plan_max: 6, teach_max: 6,
  good: 0.8, hard: 0.5,                     // coverage -> right (Good) / partial (Hard) / wrong (Again)
  surprise: 0.25,                           // |coverage - the map's chance| under this: matched
  misconceptions_max: 2, gaps_max: 3,
  audit_max: 3, audit_recent_days: 14, awaiting_ms: 6 * 3600_000,
  max_tries: 3, lease_ms: 5 * 60_000, reserve_usd: 0.6, rebuild_after_ms: 86_400_000, last_days: 60,
};
export const STEPS = ['recognise', 'distinguish', 'test', 'treat', 'trap'];
export const HEADINGS6 = ['understand', 'recognise', 'test', 'distinguish', 'treat', 'trap'];
export const RUBRIC_STEPS = ['understand', ...STEPS];
export const HEADING_WORDS = { understand: 'the underlying idea (why it happens)', recognise: 'recognising it', test: 'testing',
  distinguish: 'telling it apart', treat: 'managing it', trap: 'traps and complications' };
// The short names in the one-line results ("Manage: missing to held").
export const HEADING_SHORT = { understand: 'Why', recognise: 'Recognise', test: 'Test', distinguish: 'Tell apart', treat: 'Manage', trap: 'Traps' };
export const HEADING_RESULTS = ['held', 'partial', 'missing'];
export const RUBRIC_FORMAT = 'f2';
export const rubricCurrent = r => !!(r && typeof r.sources_hash === 'string' && r.sources_hash.startsWith(RUBRIC_FORMAT));
// The exam's two competencies (wave 3): the same rule as facets.js facetOfStep.
export const STEP_FACET = { recognise: 'diagnose', distinguish: 'diagnose', test: 'diagnose', treat: 'manage', trap: 'manage' };
export const FACETS = ['diagnose', 'manage'];
export const RESULT_OF = { good: 'right', hard: 'partial', again: 'wrong' };
const DAY_MS = 86_400_000;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const cut = (s, n) => { if (s == null) return null; const t = String(s).replace(/\s+/g, ' ').trim(); return !t ? null : t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t; };
const r3 = x => Math.round(x * 1000) / 1000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const newId = prefix => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 20);

// ---------------------------------------------------------------- the prompt (pure)

export const HEADINGS = {
  condition: 'why it happens, who gets it, how it presents and the exam findings, the tests, what it looks like and how you tell them apart, and the management',
  drug: 'how it works, what it is used for, the side effects, the interactions and what you monitor',
  approach: 'the steps in order, and what each step decides',
  organism: 'who gets it and how, what it causes, how you confirm it, and the treatment',
  finding: 'what it means, what causes it, what you do next, and what it is easily mistaken for',
  procedure: 'when it is done and when it is not, the complications, and what you do after',
  concept: 'what it is, how it shows up in a patient, and how it changes what you do',
};
export const vivaPrompt = topic => `Tell me everything you know about ${(topic && topic.name) || 'this topic'}: ${HEADINGS[topic && topic.kind] || HEADINGS.condition}.`;

export const lessonVivaPrompt = topic => `${(topic && topic.name) || 'This topic'}: a quick viva first. Tell me what you know under six headings: `
  + `${HEADINGS6.slice(0, -1).map(h => HEADING_WORDS[h]).join(', ')}, and ${HEADING_WORDS.trap}. Just start talking, or say "don't know it".`;

export const CLUSTER_PREFIX = 'cluster:';
export const clusterKeyOf = id => `${CLUSTER_PREFIX}${id}`;
export const isClusterKey = k => typeof k === 'string' && k.startsWith(CLUSTER_PREFIX);
export const clusterIdOfKey = k => (isClusterKey(k) ? k.slice(CLUSTER_PREFIX.length) : null);
export const PAIR_PREFIX = 'pair:';
export const pairKeyOf = (linkId, a = null, b = null) => (linkId ? `${PAIR_PREFIX}${linkId}` : a && b ? `${PAIR_PREFIX}${[a, b].sort().join('~')}` : null);
export const isPairKey = k => typeof k === 'string' && k.startsWith(PAIR_PREFIX);
/** A viva keyed by a group of topics (a cluster or a pair), not one topic: no map prediction, evidence on each member. */
export const isGroupKey = k => isClusterKey(k) || isPairKey(k);
/** The key a lesson's vivas are marked under (pure): its cluster's, a pair lesson's pair, else its topic's. */
export const vivaKeyOf = lesson => (lesson && lesson.cluster_id ? clusterKeyOf(lesson.cluster_id)
  : lesson && lesson.kind === 'pair' && lesson.topic_id && lesson.pair_topic_id ? pairKeyOf(lesson.link_id, lesson.topic_id, lesson.pair_topic_id)
    : (lesson && lesson.topic_id) || null);
/** The pair lesson's opening and closing viva (pure): both topics under the six headings, the separating finding named. */
export const pairVivaPrompt = (a, b) => `${a || 'This topic'} against ${b || 'its look-alike'}: a quick viva first. Tell me how you tell them apart: `
  + 'why each happens, recognising each, the finding that separates them, testing, managing each, and traps. Just start talking, or say "don\'t know it".';
export async function readPairGroup(env, user, key) {
  if (!isPairKey(key)) return null;
  const ref = key.slice(PAIR_PREFIX.length);
  let ids, link = null;
  try {
    if (ref.includes('~')) ids = ref.split('~');
    else {
      link = await env.DB.prepare(`SELECT id, from_id, to_id, a_vs_b, b_vs_a FROM links WHERE user_id = ? AND id = ?`).bind(user, ref).first();
      if (!link) return null;
      ids = [link.from_id, link.to_id];
    }
    const rows = (await env.DB.prepare(`SELECT id, name, kind FROM topics WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(ids)).all()).results || [];
    const byId = new Map(rows.map(r => [r.id, r]));
    if (ids.some(id => !byId.has(id))) return null;
    const [a, b] = ids.map(id => byId.get(id));
    return { id: key, kind: 'pair', name: `${a.name} against ${b.name}`, root: { id: a.id, name: a.name, kind: a.kind },
      members: [{ id: a.id, name: a.name, kind: a.kind, role: 'root' }, { id: b.id, name: b.name, kind: b.kind, role: 'member' }],
      pairs: [{ a: a.id, b: b.id }], a_vs_b: link ? link.a_vs_b || null : null, b_vs_a: link ? link.b_vs_a || null : null };
  } catch (e) { if (noTable(e)) return null; throw e; }
}
/** The group a cluster or pair key names (clusters.js readCluster, or readPairGroup), or null. */
export async function readVivaGroup(env, user, key) {
  if (isClusterKey(key)) return readCluster(env, user, clusterIdOfKey(key));
  if (isPairKey(key)) return readPairGroup(env, user, key);
  return null;
}
/**
 * A pair lesson's outcome (pure): the vivas' outcome, then its minimal pairs (items, each {case_for, said, right?}): under
 * two in three right caps landed at partial, and none right (two or more asked) is not landed.
 */
export function withPairItems(outcome, items) {
  const marked = (Array.isArray(items) ? items : []).filter(it => it && (it.right !== undefined || it.said));
  if (!outcome || !marked.length) return outcome;
  const right = marked.filter(it => (it.right !== undefined ? !!it.right : it.said === it.case_for)).length;
  if (marked.length >= 2 && right === 0) return 'not_landed';
  if (outcome === 'landed' && right / marked.length < 2 / 3) return 'partial';
  return outcome;
}
const andList = list => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list.join(''));
/** The cluster lesson's opening and closing viva (pure): the whole group under the six headings, its members named. */
export function clusterVivaPrompt(cluster) {
  const names = ((cluster && cluster.members) || []).filter(m => m.kind !== 'concept').map(m => m.name).slice(0, 5);
  return `${(cluster && cluster.name) || 'This group'}: a quick viva on the whole group first. Tell me what you know: why it happens, recognising each, `
    + `how you tell ${andList(names) || 'them'} apart, testing, managing them, and traps. Just start talking, or say "don't know it".`;
}

// What Claude does with the brief's viva (teach_next) and with an audit: the one place these words live.
export const VIVA_HOW = 'Your first message: the prompt word for word. He talks freely; no hints, no corrections. Then lesson_save {lesson_id, phase: "before", '
  + 'viva: his words verbatim}, or {lesson_id, phase: "before", skip_viva: true} for "don\'t know it". The hub marks it (up to 45 s); pending: call lesson_save '
  + '{lesson_id, phase} again after call_again_in seconds. Say the plan in one line from its plan (held headings skipped) and teach those. At the end the same '
  + 'prompt, lesson_save {lesson_id, phase: "after", viva}, then its change line in one sentence, then only "want a flashcard?".';
// A pair lesson's flow after its opening viva (the brief's pair.how): the same steps as a lesson, aimed at the pair.
export const PAIR_HOW = 'A pair lesson, viva first: viva.prompt covers both. Plan in one line from its partial and missing headings. Big picture: why they look alike, '
  + 'then the separating finding with the contrast picture. Then quick hard questions as minimal pairs: the same mini-case with one finding changed, "which one now?" '
  + '(items {case_for, said}). Closing viva, same prompt, then its change line, then only "want a flashcard?". lesson_save as for any lesson.';
export const AUDIT_HOW ='A 5-minute audit, one topic at a time: say its prompt word for word and let him talk; no hints, corrections or teaching. '
  + 'After each, lesson_save {lesson_id: its audit_id, viva: his words as he said them}, then the next. At the end, one line: the hub grades them in a '
  + 'minute or two (Recent activity, the topic panel).';

// ---------------------------------------------------------------- the rubric (prompt, schema, cleaning)

const nul = schema => ({ anyOf: [schema, { type: 'null' }] });

export const RUBRIC_SYSTEM = `You write the marking rubric for a viva (a structured oral exam) on one USMLE Step 2 CK topic, for Mo, a learner sitting the exam on exam day. The examiner will listen to Mo talk about the topic under six headings and tick each key point he states correctly.

Write 10 to 18 key points: what a Step 2 CK examiner most expects a candidate to know, as US guidelines teach it. Ground them in Mo's own sources when given (his Mehlman passages first, then the points his NBME and CMS forms and UWorld tested, his flashcards, the foundation concepts under the topic); fill the rest from standard US knowledge (AMBOSS-style). Each point:
- one short, specific, checkable statement (under 25 words): a fact he either said or did not say ("Ultrasound first in children and pregnancy; CT in adults"), never a vague theme ("knows the imaging");
- step: its heading: understand (the underlying idea: the mechanism or physiology that explains why it happens and why the tests and treatment work; for an approach or procedure, the reasoning behind it), recognise (who gets it, the presentation, the findings), test (the tests and what they show), distinguish (how it differs from its look-alikes), treat (the management, the next step), trap (the complications, exceptions, contraindications and pitfalls);
- yield: high when Step 2 CK tests it often or it decides management, else normal;
- tested: the ids of his exam points it covers (e.g. ["x1", "x3"]), or [] when none.
Give every heading at least one point, and two or more to the headings Step 2 CK tests most on this topic. Never copy or describe a question-bank question, its options or explanation: write the rule in your own words.`;

export const RUBRIC_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['points'],
  properties: { points: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'step', 'yield', 'tested'],
    properties: { text: { type: 'string' }, step: { type: 'string', enum: RUBRIC_STEPS }, yield: { type: 'string', enum: ['high', 'normal'] },
      tested: { type: 'array', items: { type: 'string' } } } } } },
};

// A cluster's rubric (one viva over the whole group): the same rules, plus every point names its member topic.
export const CLUSTER_RUBRIC_RULES = `This viva covers a cluster: a group of related topics Mo keeps getting wrong together, and its root (the shared idea or mechanism underneath them). He talks about the group as one picture. Write 12 to 18 points across the six headings: the shared mechanism under understand first; for every pair of members he mixes up, at least one distinguish point naming the finding that separates them; then recognising, testing, managing and the traps of the members that matter most. Each point also names its topic: the id of the member topic it is about, or "root" for the shared idea.`;
export const PAIR_RUBRIC_RULES = `This viva covers a pair: two look-alike topics Mo mixes up. He talks about how he tells them apart. Write 12 to 18 points across the six headings, weighted toward what separates them: at least four distinguish points, each naming one finding (history, examination, test result or course) that tells them apart, and the management of each (at least two treat points for each topic, and what you would do wrongly if you mixed them up); then why each happens, recognising each, testing and the traps. Distinguish and treat points are high yield. Each point also names its topic: the id of the topic it is about, or "both" for a point about telling them apart.`;
export const CLUSTER_RUBRIC_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['points'],
  properties: { points: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'step', 'yield', 'tested', 'topic'],
    properties: { text: { type: 'string' }, step: { type: 'string', enum: RUBRIC_STEPS }, yield: { type: 'string', enum: ['high', 'normal'] },
      tested: { type: 'array', items: { type: 'string' } }, topic: { type: 'string' } } } } },
};

export function examPoints(src = {}) {
  const out = [];
  for (const o of (src.objectives || []).filter(o => o && o.objective)) out.push({ id: `x${out.length + 1}`, text: cut(o.objective, 260), from: 'UWorld', outcome: o.outcome || 'seen' });
  for (const e of (src.exams || []).filter(e => e && e.text)) out.push({ id: `x${out.length + 1}`, text: cut(e.text, 260), from: e.label || 'NBME', outcome: e.outcome || 'missed' });
  return out.slice(0, 16);
}

/** The rubric call's user turn from the topic and its sources (pure). */
export function rubricMessage(topic, src = {}) {
  const c = topic && topic.cluster;
  const pairOf = id => (c.members.find(m => m.id === id) || {}).name || id;
  const lines = c && c.kind === 'pair' ? [`Pair: ${topic.name}.`, 'The two topics (topic id: name):', ...c.members.map(m => `- ${m.id}: ${m.name}`),
    ...(c.a_vs_b || c.b_vs_a ? ['What his map says tells them apart:', ...[c.a_vs_b && `- ${pairOf(c.members[0].id)}: ${cut(c.a_vs_b, 300)}`, c.b_vs_a && `- ${pairOf(c.members[1].id)}: ${cut(c.b_vs_a, 300)}`].filter(Boolean)] : [])]
    : c ? [`Cluster: ${topic.name}.`, `Root (the shared idea): ${c.root.name || c.root.id}${c.root.kind === 'concept' ? ', a foundation concept' : ''}.`,
    'Member topics (topic id: name):', ...c.members.filter(m => m.id !== c.root.id || m.kind !== 'concept').map(m => `- ${m.id}: ${m.name}`),
    ...((c.pairs || []).length ? [`Pairs he mixes up: ${c.pairs.slice(0, 6).map(p => `${(c.members.find(m => m.id === p.a) || {}).name || p.a} versus ${(c.members.find(m => m.id === p.b) || {}).name || p.b}`).join('; ')}.`] : [])]
    : [`Topic: ${topic.name} (${topic.kind || 'condition'}${topic.category ? `, ${topic.category}` : ''}).`];
  const pass = (src.mehlman || []).filter(p => p && p.text);
  if (pass.length) lines.push('', 'His Mehlman notes on it:', ...pass.map(p => `- ${cut(p.text, 700)}`));
  const ex = examPoints(src);
  if (ex.length) lines.push('', 'His exam points on it (what each question he answered tested, in his notes or the judge\'s words; whether he held it):',
    ...ex.map(x => `- ${x.id} (${x.from}, ${x.outcome}): ${x.text}`));
  const cards = (src.cards || []).filter(c => c && (c.question || c.answer));
  if (cards.length) lines.push('', 'His flashcards on it:', ...cards.map(c => `- ${cut(c.question, 200) || ''} -> ${cut(c.answer, 240) || ''}`));
  const concepts = (src.concepts || []).filter(Boolean);
  if (concepts.length) lines.push('', `The foundation concepts under it (for the understand heading): ${concepts.slice(0, 4).join('; ')}.`);
  if (lines.length === 1) lines.push('', 'No notes of his on this topic yet: write the rubric from standard US knowledge.');
  return lines.join('\n');
}

export function cleanRubric(data, examIds = null, members = null, { both = false } = {}) {
  const out = [], seen = new Set();
  // A pair's rubric (both): a point about telling the two apart names "both", and counts on each of them.
  const known = examIds ? new Set(examIds) : null;
  // A cluster's rubric: each point's member topic (an id it was given, or root); a point naming neither goes to the root.
  const byId = members ? new Map(members.map(m => [m.id, m])) : null;
  const rootId = members ? ((members.find(m => m.role === 'root') || members[0] || {}).id || null) : null;
  for (const p of (isObj(data) && Array.isArray(data.points) ? data.points : [])) {
    const text = cut(p && p.text, VIVA.point_max);
    if (!text || !questionSafe(text) || !stemSafe(text)) continue;
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const tested = Array.isArray(p.tested) ? new Set(p.tested.filter(x => typeof x === 'string' && (!known || known.has(x)))).size : 0;
    const topic = byId ? (byId.has(p.topic) ? p.topic : both && p.topic === 'both' ? 'both' : rootId) : null;
    out.push({ id: `p${out.length + 1}`, text, step: RUBRIC_STEPS.includes(p.step) ? p.step : 'recognise', yield: p.yield === 'high' ? 'high' : 'normal',
      ...(tested ? { tested } : {}), ...(topic ? { topic, topic_name: topic === 'both' ? 'both' : (byId.get(topic) || {}).name || null } : {}) });
    if (out.length >= VIVA.points_max) break;
  }
  return out;
}

// ---------------------------------------------------------------- the grade (prompt, schema, scoring)

export const GRADE_SYSTEM = `You are the examiner in a viva (a structured oral exam) for Mo, a learner preparing for USMLE Step 2 CK. He was asked to say what he knows about one topic, freely (cold before any teaching, or straight after a lesson). You get the marking rubric (key points with ids) and his words as he said them (speech recognition: forgive spelling and odd words that sound right).

For EVERY rubric point give its status:
- said: he stated it correctly, in any words or order (the substance must be there and right);
- wrong: he stated it, or its subject, incorrectly (a wrong drug, test, threshold or order) - quote his words;
- missing: he did not mention it, or only named the subject without the fact.
quote: his own words that show it (a short exact stretch, under 25 words), or null for missing.

misconceptions: up to 2 clear wrong beliefs he stated (on a rubric point or not), each as the belief in one line, with his words quoted. Not a slip of the tongue he corrected himself. For each, concept, concept_discipline and concept_quote by the concept rules below (the principle the wrong belief rests on), or empty strings.
other_topics: up to 3 things he said about OTHER topics that show a gap there (e.g. "I never know how it differs from X"): the other topic as an AMBOSS article names it, the gap in one line, his words, and its checklist step (recognise, distinguish, test, treat, trap).
Judge only what he said; never add facts he did not say; never quote or describe any question-bank question.

The grade's core, once for the whole viva: cause (${CAUSES.join(', ')}): the main reason for the points he got wrong, from his words (confusion: he took one thing for another; missing_fact: he did not know it; reasoning or ignored_clue: he had the facts and put them together wrongly; misread: a slip of the tongue he did not correct; guess: he guessed), null when no point was wrong; cause_quote his words that show it (or empty), cause_inferred false only when he said why himself, cause_detail the fact in a few words (or empty); step: the step most of his wrong or missing points sit in, or null; confidence, its words and heard by the core rules below (other conditions are other_topics and misconceptions above).

${coreRules({ skip: ['concept', 'other_conditions'] })}

${CONCEPT_RULES.replace('(wrong and right_flawed only)', '(misconceptions only)').replace('the miss rests on', 'the wrong belief rests on')}`;

// The answer forms' shared core, once for the grade (answer-core.js): no concept at the top (each wrong belief names
// its own) and no other conditions (other_topics and misconceptions carry them).
const VIVA_CORE = coreSchema({ skip: ['concept', 'other_conditions'] });
export const GRADE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['points', 'misconceptions', 'other_topics', ...VIVA_CORE.fields],
  properties: {
    ...VIVA_CORE.props,
    points: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'status', 'quote'],
      properties: { id: { type: 'string' }, status: { type: 'string', enum: ['said', 'wrong', 'missing'] }, quote: nul({ type: 'string' }) } } },
    misconceptions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['belief', 'quote', ...CONCEPT_FIELDS],
      properties: { belief: { type: 'string' }, quote: nul({ type: 'string' }), ...CONCEPT_SCHEMA_PROPS } } },
    other_topics: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['topic', 'gap', 'quote', 'step'],
      properties: { topic: { type: 'string' }, gap: { type: 'string' }, quote: nul({ type: 'string' }), step: { type: 'string', enum: STEPS } } } },
  },
};

/** The grading call's user turn (pure). */
export function gradeMessage(topic, points, transcript) {
  return [`Topic: ${topic.name}.`, '', 'Rubric:', ...points.map(p => `- ${p.id} [${p.step}, ${p.yield}]: ${p.text}`), '', 'His words:', String(transcript || '').slice(0, VIVA.transcript_max)].join('\n');
}

export const gradeWord = coverage => (coverage >= VIVA.good ? 'good' : coverage >= VIVA.hard ? 'hard' : 'again');

export function scoreGrade(rubric, data) {
  const given = new Map((isObj(data) && Array.isArray(data.points) ? data.points : []).filter(p => p && typeof p.id === 'string').map(p => [p.id, p]));
  const quote = q => { const t = cut(q, VIVA.quote_max); return t && stemSafe(t) ? t : null; };
  const points = rubric.map(p => {
    const g = given.get(p.id) || {};
    const status = ['said', 'wrong', 'missing'].includes(g.status) ? g.status : 'missing';
    return { ...p, status, quote: status === 'missing' ? null : quote(g.quote) };
  });
  const w = pointWeight;
  const total = points.reduce((t, p) => t + w(p), 0);
  const saidW = ps => ps.filter(p => p.status === 'said').reduce((t, p) => t + w(p), 0);
  const coverage = total ? saidW(points) / total : 0;
  const facets = {};
  // The facet rows share one viva between them: their shares are over the facet points' weight (an understand point
  // is in no facet).
  const facetTotal = points.filter(p => STEP_FACET[p.step]).reduce((t, p) => t + w(p), 0);
  for (const f of FACETS) {
    const ps = points.filter(p => STEP_FACET[p.step] === f);
    if (!ps.length) continue;
    const fw = ps.reduce((t, p) => t + w(p), 0);
    const counts = STEPS.map(s => [s, ps.filter(p => p.step === s).length]).filter(([, n]) => n);
    const step = counts.sort((a, b) => b[1] - a[1])[0][0];
    facets[f] = { coverage: r3(saidW(ps) / fw), share: r3(fw / facetTotal), step, of: ps.length,
      said: ps.filter(p => p.status === 'said').length, wrong: ps.filter(p => p.status === 'wrong').length };
  }
  const misconceptions = [];
  for (const m of (isObj(data) && Array.isArray(data.misconceptions) ? data.misconceptions : [])) {
    const belief = cut(m && m.belief, 200);
    if (!belief || !questionSafe(belief) || !stemSafe(belief)) continue;
    const k = tidyConcept(m);   // the principle the belief rests on (foundations, concepts.js), only when named
    misconceptions.push({ belief, quote: quote(m.quote), ...(k.concept && questionSafe(k.concept) ? { concept: k.concept, concept_discipline: k.concept_discipline } : {}) });
    if (misconceptions.length >= VIVA.misconceptions_max) break;
  }
  const others = [];
  for (const o of (isObj(data) && Array.isArray(data.other_topics) ? data.other_topics : [])) {
    const topic = cut(o && o.topic, 80), gap = cut(o && o.gap, 200);
    if (!topic || !gap || !questionSafe(gap) || !stemSafe(gap)) continue;
    others.push({ topic, gap, quote: quote(o.quote), step: STEPS.includes(o.step) ? o.step : null });
    if (others.length >= VIVA.gaps_max) break;
  }
  const n = s => points.filter(p => p.status === s).length;
  const c = tidyCore(isObj(data) ? data : {}, { flagged: n('wrong') > 0, safe: v => (v && questionSafe(v) && stemSafe(v) ? v : null) });
  const core = { cause: c.cause, cause_quote: c.cause_quote, cause_inferred: c.cause_inferred, cause_detail: c.cause_detail, step: c.step,
    confidence: c.confidence, confidence_words: c.confidence_words, confidence_inferred: c.confidence_inferred, heard: c.heard };
  const { headings, plan } = headingsOf(points);
  return { points, of: points.length, said_n: n('said'), wrong_n: n('wrong'), missing_n: n('missing'), coverage: r3(coverage), grade: gradeWord(coverage),
    facets, headings, plan, misconceptions, others, core, form_version: FORM_VERSIONS.viva };
}

export const pointWeight = p => (VIVA.yield_w[p && p.yield] || 1) + VIVA.tested_w * Math.min(VIVA.tested_max, Math.max(0, Number(p && p.tested) || 0));

/** One heading's result from its points (pure): held (coverage 0.8 or more, nothing said wrongly), missing (nothing right), else partial. */
export function headingResult(ps) {
  const said = ps.filter(p => p.status === 'said'), wrong = ps.filter(p => p.status === 'wrong');
  if (!said.length) return 'missing';
  const all = ps.reduce((t, p) => t + pointWeight(p), 0);
  const cov = all ? said.reduce((t, p) => t + pointWeight(p), 0) / all : 0;
  return cov >= VIVA.good && !wrong.length ? 'held' : 'partial';
}

export function headingsOf(points) {
  const headings = {}, gaps = [];
  for (const h of HEADINGS6) {
    const ps = (points || []).filter(p => p.step === h);
    if (!ps.length) continue;
    const result = headingResult(ps);
    headings[h] = { result, said: ps.filter(p => p.status === 'said').length, wrong: ps.filter(p => p.status === 'wrong').length, of: ps.length };
    if (result !== 'held') gaps.push({ h, result, w: ps.filter(p => p.status !== 'said').reduce((t, p) => t + pointWeight(p), 0) });
  }
  const plan = gaps.sort((a, b) => b.w - a.w || (a.result === 'missing' ? -1 : 1) - (b.result === 'missing' ? -1 : 1)).map(g => g.h);
  return { headings, plan };
}

/** Every heading missing (pure): "don't know it", recorded with no marking call. */
export function allMissing(rubricPoints = []) {
  const steps = new Set((rubricPoints || []).map(p => p.step));
  const hs = steps.size ? HEADINGS6.filter(h => steps.has(h)) : HEADINGS6;
  return { headings: Object.fromEntries(hs.map(h => [h, { result: 'missing', said: 0, wrong: 0, of: (rubricPoints || []).filter(p => p.step === h).length }])), plan: hs.slice() };
}

/** "Test: partial to held; Manage: missing to held" (pure): each heading whose result moved, in the six headings' order. */
export function changeLine(before = {}, after = {}) {
  const res = x => (x && typeof x === 'object' ? x.result : x) || null;
  const moved = HEADINGS6.filter(h => res(after[h]) && res(before[h]) && res(after[h]) !== res(before[h]))
    .map(h => `${HEADING_SHORT[h]}: ${res(before[h])} to ${res(after[h])}`);
  if (moved.length) return moved.join('; ');
  const held = HEADINGS6.filter(h => res(after[h]) === 'held').length;
  return held && held === HEADINGS6.filter(h => res(after[h])).length ? 'Every heading held, as before' : 'No heading changed';
}

/** The self-audit's surprise (pure): coverage minus the map's chance, and its word. */
export function surpriseOf(coverage, predP) {
  if (coverage == null || predP == null || !Number.isFinite(Number(predP))) return { surprise: null, word: null };
  const s = r3(Number(coverage) - Number(predP));
  return { surprise: s, word: s >= VIVA.surprise ? 'too_red' : s <= -VIVA.surprise ? 'too_green' : 'matched' };
}

/**
 * The evidence rows of a graded viva (pure): one recall_audit row per facet asked about (amount: its share of the
 * whole weight, so the facet rows together weigh one viva) and one per wrong belief. Each carries its checklist step.
 */
export function vivaEvidence(v, res) {
  if (!v || !v.topic_id || !res || !isObj(res.facets)) return [];
  const at = Number(v.said_at) || Number(v.updated_at) || Date.now();
  const base = { topic_id: v.topic_id, at, day: londonDay(at), source: 'viva', source_ref: `viva:${v.id}`, lesson_id: v.lesson_id || null, created_by: 'code' };
  // A lesson's viva says which end it is: the closing one ('after', straight after the teaching) weighs half
  // (weights.js CLOSING_VIVA, read by fsrs.js, facets.js and the gate credit).
  const phase = v.phase === 'before' || v.phase === 'after' ? { phase: v.phase } : {};
  const heard = res.core && ['partial', 'unclear'].includes(res.core.heard) ? { heard: res.core.heard } : {};
  const rows = [];
  for (const f of FACETS) {
    const x = res.facets[f];
    if (!x) continue;
    rows.push({ ...base, obs_key: `viva:${v.id}:${f}`, slot: 0, kind: 'recall_audit', result: RESULT_OF[gradeWord(x.coverage)], amount: x.share,
      detail_json: JSON.stringify({ label: 'viva', facet: f, step: x.step, cov: x.coverage, said: x.said, wrong: x.wrong, of: x.of, ...phase, ...heard }) });
  }
  (res.misconceptions || []).forEach((m, i) => {
    const step = (res.points || []).find(p => p.status === 'wrong' && STEP_FACET[p.step])?.step || 'recognise';
    rows.push({ ...base, obs_key: `viva:${v.id}:belief:${i + 1}`, slot: 0, kind: 'recall_audit', result: 'wrong', amount: 1,
      detail_json: JSON.stringify({ label: 'viva', part: 'belief', step, ...phase, ...heard }) });
  });
  return rows;
}

export function clusterVivaEvidence(v, res, members = []) {
  if (!v || !res || !Array.isArray(res.points)) return [];
  const known = new Set((members || []).map(m => m.id));
  const rootId = ((members || []).find(m => m.role === 'root') || {}).id || null;
  const by = new Map();
  for (const p of res.points) {
    // A pair's "both" point (what tells them apart) counts on each of the two.
    const ts = p.topic === 'both' ? (members || []).map(m => m.id) : [known.has(p.topic) ? p.topic : rootId];
    for (const t of ts) {
      if (!t) continue;
      if (!by.has(t)) by.set(t, []);
      by.get(t).push(p);
    }
  }
  const rows = [];
  for (const [t, ps] of by) {
    const sub = scoreGrade(ps.map(({ status, quote, ...p }) => p), { points: ps.map(p => ({ id: p.id, status: p.status, quote: p.quote })) });
    const part = vivaEvidence({ ...v, id: `${v.id}:${t}`, topic_id: t }, { ...sub, misconceptions: t === rootId ? res.misconceptions || [] : [], core: res.core });
    // A member asked only about the underlying idea (the root concept, mostly): one row of its own, in no facet, so the
    // lesson still counts on it (FSRS reads it; the Diagnose / Manage parts do not).
    if (!part.some(r => !JSON.parse(r.detail_json).part) && ps.length) {
      const at = Number(v.said_at) || Number(v.updated_at) || Date.now();
      const said = ps.filter(p => p.status === 'said').length, wrong = ps.filter(p => p.status === 'wrong').length;
      part.push({ topic_id: t, at, day: londonDay(at), source: 'viva', lesson_id: v.lesson_id || null, created_by: 'code', obs_key: `viva:${v.id}:${t}:understand`, slot: 0,
        kind: 'recall_audit', result: RESULT_OF[gradeWord(sub.coverage)], amount: 1,
        detail_json: JSON.stringify({ label: 'viva', step: 'understand', cov: sub.coverage, said, wrong, of: ps.length, ...(v.phase === 'before' || v.phase === 'after' ? { phase: v.phase } : {}) }) });
    }
    for (const r of part) rows.push({ ...r, source_ref: `viva:${v.id}` });
  }
  return rows;
}

// ---------------------------------------------------------------- reads

export async function readViva(env, user, id) {
  try { return await env.DB.prepare('SELECT * FROM viva_results WHERE user_id = ? AND id = ?').bind(user, id).first(); } catch (e) { if (noTable(e)) return null; throw e; }
}

/** The topic's rubric row with its points parsed, or null. */
export async function readRubric(env, user, topicId) {
  try {
    const r = await env.DB.prepare('SELECT * FROM viva_rubrics WHERE user_id = ? AND topic_id = ?').bind(user, topicId).first();
    return r ? { ...r, points: parse(r.points_json, []) } : null;
  } catch (e) { if (noTable(e)) return null; throw e; }
}

/** Ask for a topic's rubric (teach_next, an audit pick): a pending row the minute job builds; a failed one is asked again. Never throws. */
export async function requestRubric(env, user, topicId, { now = Date.now() } = {}) {
  if (!topicId) return false;
  try {
    await env.DB.prepare(`INSERT INTO viva_rubrics (user_id, topic_id, status, requested_at, created_at, updated_at) VALUES (?1, ?2, 'pending', ?3, ?3, ?3)
      ON CONFLICT (user_id, topic_id) DO UPDATE SET status = CASE WHEN viva_rubrics.status = 'failed' THEN 'pending' ELSE viva_rubrics.status END,
        attempts = CASE WHEN viva_rubrics.status = 'failed' THEN 0 ELSE viva_rubrics.attempts END, requested_at = ?3`).bind(user, topicId, now).run();
    return true;
  } catch (e) {
    if (!noTable(e)) console.error('viva rubric request failed', e && e.message);
    return false;
  }
}

/** The newest graded viva on a topic within VIVA.last_days, shaped for the brief and the panel, or null. */
export async function lastViva(env, user, topicId, { now = Date.now() } = {}) {
  if (!topicId) return null;
  try {
    const v = await env.DB.prepare(`SELECT * FROM viva_results WHERE user_id = ? AND topic_id = ? AND status = 'graded' AND graded_at >= ?
      ORDER BY graded_at DESC LIMIT 1`).bind(user, topicId, now - VIVA.last_days * DAY_MS).first();
    return v ? shapeViva(v) : null;
  } catch (e) { if (noTable(e)) return null; throw e; }
}

export function shapeViva(v) {
  const res = parse(v.result_json, {}) || {};
  const points = (res.points || []).map(p => ({ text: p.text, status: p.status, step: p.step, yield: p.yield, ...(p.quote ? { quote: p.quote } : {}) }));
  return { id: v.id, kind: v.kind, ...(v.phase ? { phase: v.phase } : {}), day: v.said_at ? londonDay(Number(v.said_at)) : null, at: Number(v.said_at) || null,
    said: v.said_n ?? null, wrong: v.wrong_n ?? null,
    missing: v.missing_n ?? null, of: points.length, coverage: v.coverage ?? null, grade: v.grade || null, surprise: v.surprise_word || null,
    ...(isObj(res.headings) ? { headings: Object.fromEntries(Object.entries(res.headings).map(([h, x]) => [h, x.result])) } : {}),
    ...(res.skipped ? { skipped: true } : {}),
    map_before: v.pred_band ? { band: bandWord(v.pred_band), p: v.pred_p != null ? Math.round(Number(v.pred_p) * 100) : null } : null,
    points, misconceptions: (res.misconceptions || []).map(m => m.belief), other_topics: (res.others || []).map(o => ({ topic: o.topic, gap: o.gap })) };
}

/** The map's prediction for a topic just before grading: {p, band, basis}. p is the "N% next time" chance (ungated). */
export async function predictionFor(env, user, topicId, now = Date.now()) {
  const [s, cw] = await Promise.all([
    env.DB.prepare('SELECT * FROM topic_scores WHERE user_id = ? AND topic_id = ?').bind(user, topicId).first().catch(() => null),
    env.DB.prepare(`SELECT count(*) AS n FROM evidence WHERE user_id = ? AND topic_id = ? AND kind = 'confused_with' AND held = 0`).bind(user, topicId).first().catch(() => null),
  ]);
  const lookalike = Number(cw && cw.n) || 0;
  if (!s || !Number(s.seen)) {
    const m0 = s && Number.isFinite(Number(s.prior_mastery)) ? Number(s.prior_mastery) : 0.62;
    return { p: r3(m0), band: 'unseen', basis: { answers: 0, cards: 0, gaps: 0, lessons: 0, lookalike, n_eff: 0 } };
  }
  const m0 = Number.isFinite(Number(s.prior_mastery)) ? Number(s.prior_mastery) : 0.62;
  const sc = readScore(stateOf(s), now, m0);
  const p = sc.weakness_raw != null ? 1 - sc.weakness_raw : m0;
  return { p: r3(p), band: sc.band || s.band, basis: { answers: (Number(s.questions_n) || 0) + (Number(s.retests_n) || 0), cards: Number(s.cards_n) || 0,
    gaps: Number(s.gaps_n) || 0, lessons: Number(s.lessons_n) || 0, lookalike, n_eff: r3(nEffOfScore(s, now)) } };
}

/** The kind of evidence a colour rested on (pure): answers | look-alikes | gaps | cards | nothing. */
export function basisOf(b) {
  if (!b) return 'nothing';
  if (Number(b.answers) > 0) return 'answers';
  if (Number(b.lookalike) > 0) return 'look-alikes';
  if (Number(b.gaps) > 0) return 'gaps';
  if (Number(b.cards) > 0 || Number(b.lessons) > 0) return 'cards';
  return 'nothing';
}


/** A lesson's or an audit's viva status for lesson_save's reply (pure on the row). */
export function vivaReply(v) {
  if (!v) return null;
  if (v.status === 'graded') {
    const s = shapeViva(v);
    return { id: v.id, status: 'graded', said: s.said, wrong: s.wrong, missing: s.missing, of: s.of,
      teach_first: s.points.filter(p => p.status !== 'said').sort((a, b) => (a.status === 'wrong' ? 0 : 1) - (b.status === 'wrong' ? 0 : 1)).slice(0, 6)
        .map(p => `${p.status === 'wrong' ? 'wrong' : 'missed'}: ${p.text}`),
      held: s.points.filter(p => p.status === 'said').length };
  }
  return { id: v.id, status: v.status === 'failed' ? 'failed' : 'grading', ...(v.status === 'failed' ? { note: 'The hub could not grade it; teach from what you heard.' } : { note: 'The hub grades it within a couple of minutes.' }) };
}

// A lesson's viva row of one phase (0065), or its newest row on a database without the phase column.
const noPhase = e => /no such column: phase/i.test(String(e && e.message));
async function lessonVivaRow(env, user, lessonId, phase = 'before') {
  try {
    return await env.DB.prepare(`SELECT * FROM viva_results WHERE user_id = ? AND lesson_id = ? AND coalesce(phase, 'before') = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(user, lessonId, phase).first();
  } catch (e) {
    if (!noPhase(e)) throw e;
    return phase === 'before' ? env.DB.prepare('SELECT * FROM viva_results WHERE user_id = ? AND lesson_id = ? ORDER BY created_at DESC LIMIT 1').bind(user, lessonId).first() : null;
  }
}

async function storeLessonViva(env, user, { lesson, phase, v, words, surface, now }) {
  // A cluster or pair lesson's viva is keyed by its group (no one topic's chance to keep: it joins no self-audit).
  const key = vivaKeyOf(lesson);
  const pred = phase === 'before' && !isGroupKey(key) ? await predictionFor(env, user, lesson.topic_id, now) : { p: null, band: null, basis: null };
  const basis = pred.basis ? JSON.stringify(pred.basis) : null;
  if (v) {
    await env.DB.prepare(`UPDATE viva_results SET transcript = ?3, said_at = ?4, status = 'pending', attempts = 0, error = NULL, pred_p = ?5, pred_band = ?6, pred_json = ?7,
        surface = coalesce(?8, surface), updated_at = ?4 WHERE user_id = ?1 AND id = ?2`)
      .bind(user, v.id, words, now, pred.p, pred.band, basis, surface).run();
    await requestRubric(env, user, key, { now });
    return v.id;
  }
  const id = newId('V');
  const binds = [user, id, key, lesson.topic_name, lesson.id, surface, words, now, pred.p, pred.band, basis];
  try {
    await env.DB.prepare(`INSERT INTO viva_results (user_id, id, kind, topic_id, topic_name, lesson_id, surface, status, transcript, said_at, pred_p, pred_band, pred_json,
        created_at, updated_at, phase) VALUES (?1, ?2, 'lesson', ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, ?10, ?11, ?8, ?8, ?12)`).bind(...binds, phase).run();
  } catch (e) {
    if (!noPhase(e)) throw e;
    await env.DB.prepare(`INSERT INTO viva_results (user_id, id, kind, topic_id, topic_name, lesson_id, surface, status, transcript, said_at, pred_p, pred_band, pred_json,
        created_at, updated_at) VALUES (?1, ?2, 'lesson', ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, ?10, ?11, ?8, ?8)`).bind(...binds).run();
  }
  await requestRubric(env, user, key, { now });
  return id;
}

export async function vivaReceive(env, user, { id, text, surface = null, now = Date.now() } = {}) {
  const words = typeof text === 'string' ? text.trim().slice(0, VIVA.transcript_max) : '';
  if (!words) return { refused: true, reason: 'viva is his words as he said them.', field: 'viva' };
  let v = null, topic = null, audit = false;
  try {
    if (/^A[0-9a-f]{20}$/.test(String(id))) {
      audit = true;
      v = await readViva(env, user, id);
      if (!v || v.kind !== 'audit') return { refused: true, reason: 'No audit pick has that id: use the audit_id teach_next gave.', field: 'lesson_id' };
      if (v.status === 'graded') return { audit, viva: vivaReply(v) };
      topic = { id: v.topic_id, name: v.topic_name };
      const pred = await predictionFor(env, user, topic.id, now);
      await env.DB.prepare(`UPDATE viva_results SET transcript = ?3, said_at = ?4, status = 'pending', attempts = 0, error = NULL, pred_p = ?5, pred_band = ?6, pred_json = ?7,
          surface = coalesce(?8, surface), updated_at = ?4 WHERE user_id = ?1 AND id = ?2`)
        .bind(user, v.id, words, now, pred.p, pred.band, JSON.stringify(pred.basis), surface).run();
      await requestRubric(env, user, topic.id, { now });
      return { audit, viva: { id: v.id, status: 'grading', note: 'The hub grades it within a couple of minutes; teach from what you heard meanwhile.' } };
    }
    const lesson = await env.DB.prepare('SELECT * FROM lessons WHERE user_id = ? AND id = ?').bind(user, id).first();
    if (!lesson) return { refused: true, reason: 'No lesson has that id: use the lesson_id teach_next gave.', field: 'lesson_id' };
    if (!lesson.topic_id) return { viva: { status: 'not_graded', note: 'This topic is not on the map yet, so the viva cannot be graded: teach from what you heard.' } };
    v = await lessonVivaRow(env, user, id, 'before');
    if (v && v.status === 'graded') return { viva: vivaReply(v) };
    const vid = await storeLessonViva(env, user, { lesson, phase: 'before', v, words, surface, now });
    return { audit, viva: { id: vid, status: 'grading', note: 'The hub grades it within a couple of minutes; teach from what you heard meanwhile.' } };
  } catch (e) {
    if (noTable(e)) return { viva: { status: 'not_graded', note: 'The hub has no viva tables yet: teach from what you heard.' } };
    await noteJob(env, { job: 'viva', user, key: `viva:${id}`, ref: 'received', state: 'failed', detail: e, at: now });
    throw e;
  }
}

export function lessonVivaReply(v, before = null) {
  if (!v) return null;
  const phase = v.phase || 'before';
  if (v.status === 'failed') return { phase, status: 'failed', note: 'The hub could not mark it: teach from what you heard.' };
  if (v.status !== 'graded') return { phase, status: 'marking', pending: true, call_again_in: VIVA.again_s, note: `Still marking: call lesson_save {lesson_id, phase: "${phase}"} again in ${VIVA.again_s} seconds.` };
  const res = parse(v.result_json, {}) || {};
  const hs = isObj(res.headings) ? res.headings : {};
  const headings = Object.fromEntries(HEADINGS6.filter(h => hs[h]).map(h => [h, hs[h].result]));
  const points = (res.points || []).filter(p => p.status !== 'said').sort((a, b) => (a.status === 'wrong' ? 0 : 1) - (b.status === 'wrong' ? 0 : 1) || pointWeight(b) - pointWeight(a));
  const out = { phase, status: 'marked', score: v.coverage != null ? Math.round(Number(v.coverage) * 100) : null, headings,
    plan: (res.plan || []).slice(0, VIVA.plan_max).map(h => HEADING_SHORT[h] || h),
    ...(res.skipped ? { skipped: true } : { teach: points.slice(0, VIVA.teach_max).map(p => `${HEADING_SHORT[p.step] || p.step}${p.topic_name ? ` (${p.topic_name})` : ''}, ${p.status === 'wrong' ? 'wrong' : 'missed'}: ${p.text}`) }),
    wrong_beliefs: (res.misconceptions || []).map(m => m.belief) };
  if (phase === 'after') {
    const b = before && before.status === 'graded' ? parse(before.result_json, {}) || {} : null;
    const bh = b && isObj(b.headings) ? Object.fromEntries(Object.entries(b.headings).map(([h, x]) => [h, x.result])) : null;
    delete out.plan;
    if (bh) Object.assign(out, { before: bh, score_before: before.coverage != null ? Math.round(Number(before.coverage) * 100) : null, change: changeLine(bh, headings) });
  }
  return out;
}

const sleepMs = ms => new Promise(r => setTimeout(r, ms));

export async function lessonVivaCall(env, user, { lessonId, phase = 'before', text, skip = false, surface = null, now = Date.now(), grade = null,
  waitMs = VIVA.wait_ms, pollWaitMs = VIVA.poll_wait_ms, pollMs = VIVA.poll_ms, sleep = sleepMs } = {}) {
  if (!['before', 'after'].includes(phase)) return { refused: true, reason: 'phase is before (the opening viva) or after (the closing one).', field: 'phase' };
  const words = typeof text === 'string' ? text.trim().slice(0, VIVA.transcript_max) : '';
  if (typeof text === 'string' && !words && !skip) return { refused: true, reason: 'viva is his words as he said them (skip_viva: true for "don\'t know it").', field: 'viva' };
  try {
    const lesson = await env.DB.prepare('SELECT * FROM lessons WHERE user_id = ? AND id = ?').bind(user, lessonId).first();
    if (!lesson) return { refused: true, reason: 'No lesson has that id: use the lesson_id teach_next gave.', field: 'lesson_id' };
    if (!lesson.topic_id) return { phase, status: 'not_marked', note: 'This topic is not on the map yet, so the viva cannot be marked: teach from what you heard.' };
    let v = await lessonVivaRow(env, user, lessonId, phase);
    const beforeRow = phase === 'after' ? await lessonVivaRow(env, user, lessonId, 'before') : null;
    if (v && v.status === 'graded') return lessonVivaReply(v, beforeRow);
    if (skip) {
      const rubric = await readRubric(env, user, vivaKeyOf(lesson));
      const res = { points: [], of: 0, said_n: 0, wrong_n: 0, missing_n: 0, coverage: 0, grade: 'again', facets: {}, ...allMissing(rubric && rubric.points), misconceptions: [], others: [], skipped: true };
      const id = v ? v.id : await storeLessonViva(env, user, { lesson, phase, v: null, words: "Don't know it.", surface, now });
      await env.DB.prepare(`UPDATE viva_results SET status = 'graded', transcript = coalesce(transcript, ?3), coverage = 0, grade = 'again', said_n = 0, wrong_n = 0, missing_n = 0,
          result_json = ?4, pred_p = NULL, pred_band = NULL, pred_json = NULL, graded_at = ?5, said_at = coalesce(said_at, ?5), updated_at = ?5 WHERE user_id = ?1 AND id = ?2`)
        .bind(user, id, "Don't know it.", JSON.stringify(res), now).run();
      // The lesson's scores (lessons.viva_before), through the same undoable op as a marked viva (no evidence: nothing was examined).
      const { applyChange } = await import('./change.js');
      await applyChange(env, user, { actor: 'code', surface: 'cron', op: 'viva.grade', args: { id }, via: 'lesson_save:skip_viva' }).catch(e => console.error('skipped viva not kept on the lesson', e && e.message));
      await noteJob(env, { job: 'viva', user, key: `viva:${id}`, ref: 'lesson', state: 'ok', at: now, detail: lesson.topic_name || null, counts: { kind: 'skipped', phase } });
      return lessonVivaReply(await readViva(env, user, id), beforeRow);
    }
    let id = v ? v.id : null;
    if (words) id = await storeLessonViva(env, user, { lesson, phase, v, words, surface, now });
    else if (!v) return { refused: true, reason: `No ${phase === 'before' ? 'opening' : 'closing'} viva yet: send his words in viva.`, field: 'viva' };
    // The hub's examiner marks it now when the connector can start it (never twice: gradeNow claims the row).
    let started = false;
    if (typeof grade === 'function' && (words || (v && v.status === 'pending' && !Number(v.attempts)))) {
      started = true;
      Promise.resolve().then(() => grade(user, id)).catch(e => console.error('lesson viva grade failed', e && e.message));
    }
    const limit = words ? waitMs : pollWaitMs;
    const t0 = Date.now();
    let row = await readViva(env, user, id);
    while (row && row.status === 'pending' && (started || !words) && Date.now() - t0 < limit) {
      await sleep(Math.min(pollMs, Math.max(0, limit - (Date.now() - t0))));
      row = await readViva(env, user, id);
    }
    const reply = lessonVivaReply(row, beforeRow);
    return reply && reply.pending && !started && words ? { ...reply, call_again_in: 30 } : reply;
  } catch (e) {
    if (noTable(e)) return { phase, status: 'not_marked', note: 'The hub has no viva tables yet: teach from what you heard.' };
    await noteJob(env, { job: 'viva', user, key: `viva:${lessonId}:${phase}`, ref: 'received', state: 'failed', detail: e, at: now });
    throw e;
  }
}

export async function startPanelViva(env, user, topic, text, { now = Date.now() } = {}) {
  const words = typeof text === 'string' ? text.trim().slice(0, VIVA.transcript_max) : '';
  if (!words) return { refused: true, reason: 'Nothing was heard in the recording.' };
  if (!topic || !topic.id) return { refused: true, reason: 'That topic is not on the map.' };
  const pred = await predictionFor(env, user, topic.id, now);
  const id = newId('A');
  await env.DB.prepare(`INSERT INTO viva_results (user_id, id, kind, topic_id, topic_name, surface, status, prompt, transcript, said_at, pred_p, pred_band, pred_json,
      created_at, updated_at) VALUES (?1, ?2, 'audit', ?3, ?4, 'panel', 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?7, ?7)`)
    .bind(user, id, topic.id, topic.name, vivaPrompt(topic), words, now, pred.p, pred.band, JSON.stringify(pred.basis)).run();
  await requestRubric(env, user, topic.id, { now });
  return { id };
}

/** One viva's state for the panel's poll (pure on the row): grading, graded (with the shaped grade) or failed. */
export function panelVivaState(v) {
  if (!v) return { status: 'missing' };
  if (v.status === 'graded') return { id: v.id, status: 'graded', viva: shapeViva(v) };
  if (v.status === 'failed') return { id: v.id, status: 'failed', note: 'The hub could not grade it. Try again, or Show answers.' };
  return { id: v.id, status: 'grading', tries: Number(v.attempts) || 0 };
}

/** A lesson's two vivas for lesson_save (never throws): {before, after}, each {status, coverage} or null. */
export async function lessonVivaStates(env, user, lessonId) {
  const out = { before: null, after: null };
  try {
    const rows = (await env.DB.prepare(`SELECT coalesce(phase, 'before') AS phase, status, coverage FROM viva_results WHERE user_id = ? AND lesson_id = ? ORDER BY created_at`)
      .bind(user, lessonId).all()).results || [];
    for (const r of rows) out[r.phase === 'after' ? 'after' : 'before'] = { status: r.status, coverage: r.coverage == null ? null : Number(r.coverage) };
  } catch (e) {
    if (!noTable(e)) console.error('lesson vivas not read', e && e.message);
  }
  return out;
}

/** The opening viva of a lesson, for lesson_save's replies (null when none). */
export async function lessonViva(env, user, lessonId) {
  try {
    return vivaReply(await lessonVivaRow(env, user, lessonId, 'before'));
  } catch (e) { if (noTable(e)) return null; throw e; }
}

// ---------------------------------------------------------------- choosing what to audit (teach_next mode audit)

/**
 * Active sampling (pure): yield x uncertainty, so each minute buys the most information. Uncertainty is the prior's
 * share of the colour (k / (n_eff + k): 1 for a topic never answered); a colour resting on look-alike penalties or
 * stated gaps with no real answer counts 1.5 times, and a high-yield topic never tested is the third kind of pick.
 * Returns {score, why, cls}.
 */
export function auditScore(r, now = Date.now()) {
  const Y = yieldOf(r);
  const seen = Number(r.seen) === 1;
  const n = seen ? nEffOfScore(r, now) : 0;
  const U = EVIDENCE.k / (n + EVIDENCE.k);
  const answers = (Number(r.questions_n) || 0) + (Number(r.retests_n) || 0);
  const resting = seen && answers === 0 && (Number(r.cw_n) > 0 || Number(r.gaps_n) > 0);
  const cls = !seen ? 'unseen' : resting ? 'resting' : 'thin';
  const why = cls === 'unseen' ? 'high-yield, never tested'
    : cls === 'resting' ? `its colour rests on ${Number(r.cw_n) > 0 ? 'look-alike penalties' : 'gaps'}, not answers`
      : `thin evidence (${plural(answers, 'answer')})`;
  return { score: Y * U * (resting ? 1.5 : 1), why, cls };
}

/** The picks (pure): the best of each kind first (resting, thin, unseen), then the rest by score, at most n. */
export function auditPick(rows, { n = VIVA.audit_max, now = Date.now() } = {}) {
  const scored = rows.map(r => ({ r, ...auditScore(r, now) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  const out = [];
  for (const cls of ['resting', 'thin', 'unseen']) { const x = scored.find(s => s.cls === cls); if (x && out.length < n) out.push(x); }
  for (const x of scored) if (out.length < n && !out.includes(x)) out.push(x);
  return out.sort((a, b) => b.score - a.score);
}

export async function auditNext(env, user, args = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const surface = args.surface || 'chat';
  let picks;
  try {
    if (args.ids && args.ids.length) {
      const rows = (await env.DB.prepare(`SELECT t.id, t.name, t.kind, t.yield, s.band FROM topics t LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
        WHERE t.user_id = ? AND t.id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(args.ids.slice(0, VIVA.audit_max))).all()).results || [];
      picks = rows.map(r => ({ r, why: 'you asked for it' }));
    } else {
      const rows = (await env.DB.prepare(`SELECT t.id, t.name, t.kind, t.yield, s.seen, s.band, s.fsrs_real_n, s.fsrs_at, s.last_question_at, s.questions_n, s.retests_n,
          s.gaps_n, s.cards_n,
          (SELECT count(*) FROM evidence e WHERE e.user_id = t.user_id AND e.topic_id = t.id AND e.kind = 'confused_with' AND e.held = 0) AS cw_n
        FROM topics t LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
        WHERE t.user_id = ?1 AND t.status IN ('proposed', 'confirmed')
          AND NOT EXISTS (SELECT 1 FROM viva_results v WHERE v.user_id = t.user_id AND v.topic_id = t.id AND v.status IN ('pending', 'graded', 'awaiting') AND v.updated_at >= ?2)
        ORDER BY t.yield DESC LIMIT 400`).bind(user, now - VIVA.audit_recent_days * DAY_MS).all()).results || [];
      picks = auditPick(rows, { now });
    }
  } catch (e) {
    if (noTable(e)) return { refused: true, reason: 'The audit arrives with the hub update (migration 0059): use a normal "teach me" for now.' };
    await noteJob(env, { job: 'viva', user, key: `audit:${londonDay(now)}`, ref: 'audit', state: 'failed', detail: e, at: now });
    throw e;
  }
  if (!picks.length) return { audit: { topics: [] }, say: 'Nothing on the map needs auditing right now.' };
  const topics = picks.map(x => ({ audit_id: args.peek ? null : newId('A'), topic: { id: x.r.id, name: x.r.name, kind: x.r.kind, band: x.r.band || 'unseen' },
    why: x.why, prompt: vivaPrompt(x.r) }));
  if (!args.peek) {
    try {
      await env.DB.batch(topics.map(t => env.DB.prepare(`INSERT INTO viva_results (user_id, id, kind, topic_id, topic_name, surface, status, prompt, created_at, updated_at)
        VALUES (?1, ?2, 'audit', ?3, ?4, ?5, 'awaiting', ?6, ?7, ?7)`).bind(user, t.audit_id, t.topic.id, t.topic.name, surface, t.prompt, now)));
      for (const t of topics) await requestRubric(env, user, t.topic.id, { now });
      await noteJob(env, { job: 'viva', user, key: `audit:${topics[0].audit_id}`, ref: 'audit', state: 'ok', at: now,
        counts: { kind: 'audit', picked: topics.length }, detail: topics.map(t => `${t.topic.name} (${t.why})`).join('; ') });
    } catch (e) {
      await noteJob(env, { job: 'viva', user, key: `audit:${londonDay(now)}`, ref: 'audit', state: 'failed', detail: e, at: now });
      throw e;
    }
  }
  const names = topics.map(t => t.topic.name);
  return { mode: 'audit', audit: { topics, how: AUDIT_HOW }, say: cut(`A ${topics.length}-topic audit: ${names.join(', ')}. First: ${topics[0].prompt}`, 400) };
}

// ---------------------------------------------------------------- the brief's viva (teach_next, lesson mode)

/**
 * The brief's reads, for teach_next's one read batch (briefReads): the topic's rubric, its newest graded viva, and (not
 * for a peek) the rubric asked for, a no-op beside a ready one. Statements only; briefVivaOf shapes what they return.
 */
export function briefVivaStatements(env, user, topicId, { now = Date.now(), request = false } = {}) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  return [
    q('SELECT * FROM viva_rubrics WHERE user_id = ? AND topic_id = ?', user, topicId),
    q(`SELECT * FROM viva_results WHERE user_id = ? AND topic_id = ? AND status = 'graded' AND graded_at >= ? ORDER BY graded_at DESC LIMIT 1`, user, topicId, now - VIVA.last_days * DAY_MS),
    request ? q(`INSERT INTO viva_rubrics (user_id, topic_id, status, requested_at, created_at, updated_at) VALUES (?1, ?2, 'pending', ?3, ?3, ?3)
      ON CONFLICT (user_id, topic_id) DO UPDATE SET status = CASE WHEN viva_rubrics.status = 'failed' THEN 'pending' ELSE viva_rubrics.status END,
        attempts = CASE WHEN viva_rubrics.status = 'failed' THEN 0 ELSE viva_rubrics.attempts END, requested_at = ?3`, user, topicId, now)
      : q('SELECT NULL AS topic_id FROM viva_rubrics WHERE 0 AND user_id = ? AND topic_id = ?', user, topicId),
  ];
}

export function briefVivaOf(topic, rubricRow = null, lastRow = null) {
  if (!topic || !topic.id) return null;
  const rubric = rubricRow ? { ...rubricRow, points: parse(rubricRow.points_json, []) } : null;
  const last = lastRow ? shapeViva(lastRow) : null;
  return {
    prompt: lessonVivaPrompt(topic), headings: HEADINGS6.map(h => HEADING_SHORT[h]), how: VIVA_HOW,
    ...(rubric && rubric.status === 'ready' && rubric.points.length ? { points: rubric.points.map(p => ({ id: p.id, text: p.text, step: p.step, yield: p.yield, ...(p.tested ? { tested: p.tested } : {}) })) } : {}),
    ...(last ? { last: { day: last.day, said: last.said, of: last.of, missed: last.points.filter(p => p.status !== 'said').slice(0, 5).map(p => `${p.status}: ${p.text}`) } } : {}),
  };
}

// ---------------------------------------------------------------- op viva.grade (code only)

/** Planner for op viva.grade {id}: the graded viva's recall_audit rows (vivaEvidence), one event, the topic recomputed. */
export async function planVivaGrade(env, user, args, ctx) {
  if (!isObj(args) || typeof args.id !== 'string' || Object.keys(args).some(k => k !== 'id')) return { refuse: 'viva.grade takes {id}.' };
  const v = await readViva(env, user, args.id);
  const res = v && parse(v.result_json, null);
  if (!v || !v.topic_id || !res) return { refuse: 'That viva has no grade to write.' };
  // A cluster or pair viva (keyed cluster:<id> or pair:<link>): each member's points on that member.
  const cluster = isGroupKey(v.topic_id) ? await readVivaGroup(env, user, v.topic_id).catch(() => null) : null;
  const evidence = res.skipped ? [] : cluster ? clusterVivaEvidence(v, res, cluster.members) : isGroupKey(v.topic_id) ? [] : vivaEvidence(v, res);
  const touched = cluster ? [...new Set(evidence.map(e => e.topic_id))] : isGroupKey(v.topic_id) ? [] : [v.topic_id];
  // A lesson's viva (0065): its score and headings on the lesson, and the change once both ends are in.
  const lessonPart = v.kind === 'lesson' && v.lesson_id ? await lessonVivaRows(env, user, v, res, ctx.now || Date.now()) : null;
  if (!evidence.length && !lessonPart) return { noop: true, summary: 'The viva had no key points to write.' };
  const what = v.phase === 'after' ? 'Closing viva marked' : v.phase === 'before' ? 'Opening viva marked' : 'Viva graded';
  const summary = cut(res.skipped ? `${what}: ${v.topic_name || 'a topic'}, "don't know it"` : `${what}: ${v.topic_name || 'a topic'}, ${res.said_n} of ${res.of} key points said`, 160);
  return { rows: lessonPart ? [lessonPart.row] : [], events: [{ target_type: 'viva', target_id: v.id, topic_id: cluster ? cluster.root.id || null : v.topic_id, summary }, ...(lessonPart ? [lessonPart.event] : [])],
    ...(evidence.length ? { evidence: { upsert: evidence } } : {}),
    touched_topics: touched, count: 1, summary, reply: { evidence: evidence.length, ...(lessonPart ? { lesson: lessonPart.after } : {}) } };
}

/** The outcome of a lesson from its two vivas (pure): landed (closing coverage 0.8 or more), partial (0.5 or more, or a gain
 * of 0.3 or more), else not_landed; null without a closing viva. */
export function vivaOutcome(before, after) {
  if (after == null || !Number.isFinite(Number(after))) return null;
  const a = Number(after), b = Number.isFinite(Number(before)) && before != null ? Number(before) : null;
  if (a >= VIVA.good) return 'landed';
  if (a >= VIVA.hard || (b != null && a - b >= 0.3)) return 'partial';
  return 'not_landed';
}

// The lessons row a lesson viva's grade writes (0065): viva_before or viva_after, viva_json {before, after, change}, and
// a finished lesson's outcome from the two when it had none. Null on a database without the columns.
async function lessonVivaRows(env, user, v, res, now) {
  const lesson = await env.DB.prepare('SELECT * FROM lessons WHERE user_id = ? AND id = ?').bind(user, v.lesson_id).first();
  if (!lesson || !('viva_json' in lesson)) return null;
  const phase = v.phase === 'after' ? 'after' : 'before';
  const heads = isObj(res.headings) ? Object.fromEntries(Object.entries(res.headings).map(([h, x]) => [h, x.result])) : {};
  const kept = parse(lesson.viva_json, {}) || {};
  const vj = { ...kept, [phase]: heads };
  if (vj.before && vj.after) vj.change = changeLine(vj.before, vj.after);
  const after = { [phase === 'after' ? 'viva_after' : 'viva_before']: Number(res.coverage) || 0, viva_json: JSON.stringify(vj), updated_at: now };
  const b = phase === 'before' ? after.viva_before : lesson.viva_before, a = phase === 'after' ? after.viva_after : lesson.viva_after;
  // A pair lesson's minimal pairs (items_json) still count (withPairItems).
  if (lesson.status === 'done' && lesson.outcome == null && vivaOutcome(b, a)) after.outcome = lesson.kind === 'pair' ? withPairItems(vivaOutcome(b, a), parse(lesson.items_json, [])) : vivaOutcome(b, a);
  const before = Object.fromEntries(Object.keys(after).map(k => [k, lesson[k] ?? null]));
  const row = { table: 'lessons', op: 'update', key: { id: lesson.id }, before, after };
  const summary = cut(`Lesson on ${lesson.topic_name || 'a topic'}: ${phase === 'after' ? 'closing' : 'opening'} viva ${Math.round(after[phase === 'after' ? 'viva_after' : 'viva_before'] * 100)}%${vj.change ? ` (${vj.change})` : ''}`, 160);
  return { row, after: { viva_before: b ?? null, viva_after: a ?? null, ...(vj.change ? { change: vj.change } : {}) },
    event: { kind: 'lesson.saved', target_type: 'lesson', target_id: lesson.id, topic_id: lesson.topic_id || null, summary, before: { id: lesson.id, ...before }, after: { id: lesson.id, ...after } } };
}

// ---------------------------------------------------------------- the self-audit summary (honesty report, map_overview)

/**
 * The week's self-audit: {n, matched, too_red, too_green, by_basis, line}. by_basis: what each graded topic's colour
 * rested on (answers, look-alikes, gaps, cards, nothing) with the mean surprise, for the overseer's weight refit.
 * line: "Map audit this week: 12 checked, 9 matched, 3 too red, 0 too green (all 3 coloured by look-alike penalties)."
 */
export function auditSummaryOf(rows) {
  const g = rows.filter(r => r && r.surprise_word);
  if (!g.length) return null;
  const count = w => g.filter(r => r.surprise_word === w).length;
  const by = {};
  for (const r of g) {
    const b = basisOf(parse(r.pred_json, null));
    by[b] = by[b] || { n: 0, sum: 0 };
    by[b].n++; by[b].sum += Number(r.surprise) || 0;
  }
  const by_basis = Object.fromEntries(Object.entries(by).map(([k, x]) => [k, { n: x.n, mean_surprise: r3(x.sum / x.n) }]));
  const out = { n: g.length, matched: count('matched'), too_red: count('too_red'), too_green: count('too_green'), by_basis };
  const red = g.filter(r => r.surprise_word === 'too_red').map(r => basisOf(parse(r.pred_json, null)));
  const top = ['look-alikes', 'gaps'].map(b => [b, red.filter(x => x === b).length]).sort((a, b) => b[1] - a[1])[0];
  const why = out.too_red && top[1] ? ` (${top[1] === out.too_red ? (out.too_red === 1 ? 'it was' : `all ${out.too_red}`) : top[1]} coloured by ${top[0] === 'look-alikes' ? 'look-alike penalties' : 'stated gaps'})` : '';
  out.line = `Map audit this week: ${out.n} checked, ${out.matched} matched, ${out.too_red} too red, ${out.too_green} too green${why}.`;
  return out;
}

/** auditSummaryOf over the last 7 days' graded vivas (null when none, or before 0059). */
export async function auditSummary(env, user, { now = Date.now() } = {}) {
  try {
    const rows = (await env.DB.prepare(`SELECT surprise, surprise_word, pred_json FROM viva_results WHERE user_id = ? AND status = 'graded' AND graded_at >= ?`)
      .bind(user, now - 7 * DAY_MS).all()).results || [];
    return auditSummaryOf(rows);
  } catch (e) { if (noTable(e)) return null; throw e; }
}
