import { now } from './util.js';
import { all, first, run } from './db.js';
import { REVIEW_SYSTEM, SEEN_RULES, HISTORY_RULES, REVIEW_SCHEMA, FIVE_STEPS, CONFIDENCES, FLAWS, tidyReview, withMarks, prepareVerdicts, saveVerdicts,
  finishJudged, judgeMode, judgeCounts, slimPack, packFor, packSearch, pickMehlman, anking, CHAT_WAIT_MS } from './uworld-review.js';
import { mehlmanFor } from './map/mehlman.js';
import { TALK_SYSTEM, TALK_SCHEMA, TALK_RULES, tidyTalk, talkRows, nameTalk, applyTalk, talkLine, mergeTalk, chatCovered } from './uworld-review-talk.js';
import { AUDIT_SPECS, checkItem, recordAudit, auditCounts } from './ai-audit.js';
import { cleanQuestions, mergeQuestions, RESULTS } from './uworld.js';
import { ERROR_TYPES, buildLeakIndex } from './checks.js';
import { objectivesFor } from './library/objectives.js';
import { historyFor, historyLines } from './uworld-history.js';
import { nearNames, namesPrompt } from './map/name-map.js';
import { looksLikeQuestionText } from './map/guard.js';
import { scrubStems } from './gaps.js';
import { pagesFor } from './uworld-pages.js';
import { readScript, ambossScript } from './uworld-capture.js';
import { noteJob, stampFailed } from './job-log.js';
import { FORM_VERSIONS, HEARD, STEPS, CONFIDENCE_VALUES } from './answer-core.js';
import { CAUSES, CAUSE_RULES } from '../../public/js/shared/cause.js';
import { MO } from './users.js';
import { addRuleParts } from './map/rules.js';
import { PACE } from './map/weights.js';

export const CHAT_CHUNK = 10;
export const ROW_FIELDS = ['uworld_id', 'result', 'picked', 'answer', 'subject', 'system', 'topic', 'time_s', 'others_pct', 'others_time_s'];
const ROW_KEYS = [...ROW_FIELDS, 'start'];
const TEXT_MAX = 1200, WORDS_MAX = 6000, CHAT_WORDS_MAX = 40_000;

const parse = (t, d) => { try { return t ? JSON.parse(t) : d; } catch { return d; } };
const mss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const resulted = qs => qs.filter(q => q && Number.isInteger(q.q) && RESULTS.includes(q.result));
const lines = s => String(s).split('\n');

// ---------------------------------------------------------------- the rules, from the judges' own text
// The API judge's system prompt is its own steps, then the shared cause, concept and core rules: served in two parts,
// word for word, so the chat follows exactly what the API judge follows (each part under map_rules' 8,000 characters).
const CUT = REVIEW_SYSTEM.indexOf(CAUSE_RULES);
const JUDGE_OWN = REVIEW_SYSTEM.slice(0, CUT).replace(/\n+$/, '');
const SHARED_RULES = REVIEW_SYSTEM.slice(CUT);
const TALK_OWN = TALK_SYSTEM.slice(0, TALK_SYSTEM.indexOf(CAUSE_RULES)).replace(/\n+$/, '');

export const CHAT_JUDGE_LINES = [
  `Block judge in the chat (form version ${FORM_VERSIONS.uworld_judge}). Follow map_rules block_judge, then answer_core, then the page and history rules below, exactly as the hub's own judge does. You read every question's page yourself, so the page rules always apply. "His words" are uworld_words {block}: the whole block, with times.`,
  `Send at most ${CHAT_CHUNK} questions a call: teach_debrief {block, items}. Each item is the judge's item (form.item from teach_debrief {judge: true}) plus the page's row when it is not saved yet (${ROW_FIELDS.join(', ')}: labels and numbers only).`,
  'The hub checks each item as it checks its own judge: a wrong or shaky question needs why, error_type, the teaching note (rule, condition, say), a cause, and flaw_kind when right_flawed; every quote must be his words copied from uworld_words. Rejected items come back with plain reasons: fix only those and send them again. Sending a question again replaces it.',
  'Never put question text (stem, choices, explanation) in any field: your own words, and quote only Mo.',
];
export const CHAT_REVIEW_LINES = [
  `The review in the chat (rules version ${TALK_RULES}; Mo, 1 Nov 2026: the review is no longer recorded, so it is saved as it happens).`,
  'After each of his messages that adds anything (his reasoning, a cause, a gap, a wrong belief, an answer-choice fact, a link), make one silent save in the same turn as your reply: teach_debrief {block, review: {questions, gaps, misconceptions, links, options, words}}, only the questions that message was about. A message with nothing new needs no call. Never wait until the end.',
  'words: his own messages this save rests on, copied exactly. Every said and quote must come from them or from his block words.',
  'Saves add up per question: a later one refines or adds, never wipes. To correct a point he takes back, send it again with the same topic (a gap or a belief on that question) or the same letter (a choice): it replaces the earlier one.',
  'The order (Mo, 1 Nov 2026): the curated list from the last judge submit (curated.list: wrong, then unsure, then slow; right and sure skipped unless he asks), starting with the first question\'s explanation, one account reconciled from UWorld\'s explanation, AnKing and Mehlman (each entry\'s sources, or your lookups for curated.look_up) and his words, every point checked against AMBOSS (agreeing points said once; AMBOSS wins a clash, except on the answer UWorld marked correct: teach that, the AMBOSS difference in a clause; about 150 words); "next" moves on. With each explanation, in the same turn, open that question in the UWorld tab (window.__hubCapture.go(q)) so its pictures and tables show, and show its best picture as the UWorld review does: the Anki connector\'s show_picture {names: pictures}, or get_card_images {card_id: card_picture, max_images: 1} when it has only card_picture (a look_up entry: the fitting high_yield_notes or anking_cards pictures), with one sentence on what it shows; skip one that does not fit, never one you have not looked at (Mo, 1 Nov 2026: "I want both of them to show me a photo"). UWorld and AMBOSS text stays in the chat: never in a save.',
  'When he says he is done, or moves on, one closing save with review {done: true} marks the block reviewed in the chat. If the chat just stops, what was saved stays.',
  'The fields and rules are the review recording analysis\'s (below), with answer_core except other_conditions (his gaps and beliefs lists hold those). start may be null. form.review in teach_debrief {judge: true} is its shape.',
];

/** map_rules parts for the chat (map/rules.js): each a list of lines. */
export const CHAT_RULE_PARTS = {
  block_judge: () => lines(JUDGE_OWN),
  block_judge_page: () => [...CHAT_JUDGE_LINES, '', ...lines(SEEN_RULES.trim()), '', ...lines(HISTORY_RULES.trim())],
  answer_core: () => lines(SHARED_RULES),
  block_review: () => [...CHAT_REVIEW_LINES, '', ...lines(TALK_OWN)],
};

addRuleParts(CHAT_RULE_PARTS);

// The forms the chat fills: the API judge's item (REVIEW_SCHEMA) with the page's row beside it, and the review's lists.
const ITEM = REVIEW_SCHEMA.properties.questions.items;
export const CHAT_FORM = {
  item: { judge: ITEM.properties, required: ITEM.required, row: ROW_FIELDS },
  review: { questions: TALK_SCHEMA.properties.questions.items.required, gaps: TALK_SCHEMA.properties.gaps.items.required,
    misconceptions: TALK_SCHEMA.properties.misconceptions.items.required, links: TALK_SCHEMA.properties.links.items.required,
    options: TALK_SCHEMA.properties.options.items.required, extra: ['words (his messages, copied)', 'done (true on the closing save)'] },
};

const JUDGE_STEPS = `Judge the block in this chat (Mo's subscription; the hub's own judge waits):
1. Run script once with javascript_tool on the UWorld tab, at item 1 of this block's review. It reads every page by itself and keeps them in the tab (nothing is sent). In the same turn, while it reads: uworld_words {block} and map_rules block_judge, answer_core and block_judge_page (once a chat).
2. When window.__hubCapture.status() says kept, read the pages with window.__hubCapture.read(1, 5), read(6, 10) and so on.
3. teach_debrief {judge: true, block, items: one row per question (labels and numbers from the pages)} saves the rows and returns the questions, objectives, his history and his map's names.
4. Judge ${CHAT_CHUNK} questions at a time by those rules: teach_debrief {block, items}. Fix any rejected ones and send them again.
5. The last submit returns curated: the review list (wrong, then unsure, then slow), each with AnKing and Mehlman (sources), and its AMBOSS pages with amboss_script. In one turn: a tab for every AMBOSS page (all tiers), with anking_cards and high_yield_notes only for curated.look_up; next turn, amboss_script on every tab, side by side. Draft each question as one account from UWorld's explanation, AnKing, Mehlman and his words, checked against AMBOSS. Then a 2 to 3 line summary, and the first explanation, opening each question in the UWorld tab with window.__hubCapture.go(q) and showing its pictures (show_picture, or get_card_images for card_picture) beside it (map_rules block_review: save after each of his messages).
Every independent call goes side by side in one turn.`;

// ---------------------------------------------------------------- shared checks
const block_ = (env, id) => (id ? first(env, 'SELECT * FROM uworld_blocks WHERE id = ?', String(id)) : first(env, 'SELECT * FROM uworld_blocks ORDER BY day DESC, created_at DESC LIMIT 1'));

/** Every string inside v that reads like question-bank text, or is too long, as plain problems (pure). */
export function textProblems(v, where, out = [], skip = new Set()) {
  if (typeof v === 'string') {
    if (v.length > TEXT_MAX) out.push(`${where} is ${v.length} characters; keep it under ${TEXT_MAX}, in your own words.`);
    else if (looksLikeQuestionText(v)) out.push(`${where} reads like question text: use your own words, and quote only Mo.`);
  } else if (Array.isArray(v)) v.forEach((x, i) => textProblems(x, `${where}.${i}`, out, skip));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) if (!skip.has(k)) textProblems(x, `${where}.${k}`, out, skip);
  return out;
}

const ENUMS = { verdict: ['sound', 'right_flawed', 'wrong', 'no_speech'], flaw_kind: FLAWS, error_type: ERROR_TYPES, step: FIVE_STEPS, cause: CAUSES,
  confidence: CONFIDENCE_VALUES, heard: HEARD };
void CONFIDENCES; void STEPS;

export function auditReasons(row) {
  return [...row.missing.map(p => `give ${p}`), ...row.fake.map(p => `${p} is not his words: copy it exactly from his words, or leave it empty`)];
}

// ---------------------------------------------------------------- the read
/**
 * teach_debrief {judge: true, block?, items?}: what the chat needs to judge the block. items: the pages' rows (labels
 * and numbers), saved first where the block has none (the results screenshot wins), so the map has the results at once.
 */
export async function chatJudgeRead(env, args = {}, ctx = {}) {
  let block = await block_(env, args.block);
  if (!block) return { block: null, note: 'No UWorld block is saved on the hub yet: Mo presses Stop on the recorder first.' };
  let saved = null;
  if (Array.isArray(args.items) && args.items.length) {
    const r = await saveRows(env, block, args.items, ctx);
    if (r.problems.length) return { block: block.id, saved: false, problems: r.problems, next_step: 'Fix the rows and call teach_debrief {judge: true, block, items} again.' };
    saved = r.saved;
    block = await block_(env, block.id);
  }
  const mode = await judgeMode(env);
  const qs = withMarks(block);
  const job = await first(env, 'SELECT judged_json FROM uworld_judging WHERE block_id = ?', block.id).catch(() => null);
  const judged = parse(job && job.judged_json, []);
  const count = Number(block.count) || Math.max(0, ...qs.map(q => q.q));
  const left = Array.from({ length: count }, (_, i) => i + 1).filter(q => !judged.includes(q));
  const objectives = qs.length ? await objectivesFor(env, MO, qs.map(q => q.uworld_id).filter(Boolean)).catch(() => ({})) : {};
  const named = qs.length ? await nearNames(env, MO, qs.flatMap(q => [q.topic, q.condition])).catch(() => []) : [];
  const history = qs.length ? await historyFor(env, qs, { before: block.created_at || now() }).catch(() => null) : null;
  const hist = history ? historyLines(history, qs.filter(q => left.includes(q.q))) : [];
  const questions = qs.map(q => ({ q: q.q, uworld_id: q.uworld_id || null, result: q.result || null, picked: q.picked || null, answer: q.answer || null,
    labels: [q.subject, q.system, q.topic].filter(Boolean).join(' / ') || null, time_s: q.time_s ?? null, others_time_s: q.others_time_s ?? null,
    others_pct: q.others_pct ?? null, start: q.start_ms != null ? mss(q.start_ms) : null, ...(q.uworld_id && objectives[q.uworld_id] ? { objective: objectives[q.uworld_id].text } : {}) }));
  const review = await chatReviewState(env, block);
  return {
    block: block.id, day: block.day, mode: block.mode, count, judge: mode, ...(saved != null ? { rows_saved: saved } : {}),
    judged, left, next: left.slice(0, CHAT_CHUNK),
    rules: { parts: ['block_judge', 'answer_core', 'block_judge_page'], review_part: 'block_review', form_version: FORM_VERSIONS.uworld_judge, talk_rules: TALK_RULES },
    words: { call: 'uworld_words', block: block.id },
    questions, ...(hist.length ? { history: hist.filter(Boolean) } : {}), ...(named.length ? { names: namesPrompt(named) } : {}),
    form: CHAT_FORM, ...(review ? { review } : {}),
    // Every question judged (a chat that dropped after judging): the curated review list again.
    ...(!left.length && judged.length ? { curated: await curatedReview(env, block, ctx) } : {}),
    ...((saved == null && (left.length || !qs.length)) || args.script === true ? { script: readScript(env && env.HUB_ORIGIN) } : {}),
    steps: JUDGE_STEPS,
  };
}

async function saveRows(env, block, items, ctx) {
  const problems = [];
  const stored = new Map(parse(block.questions_json, []).map(q => [q.q, q]));
  const rows = [];
  for (const x of items.slice(0, 60)) {
    const { questions, problems: p } = cleanQuestions([{ q: x && x.q, ...Object.fromEntries(ROW_KEYS.filter(k => x && x[k] != null).map(k => [k, x[k]])) }]);
    if (p.length) { problems.push(...p.map(s => s.replace(/^Question entry 1/, `Q${x && x.q}`))); continue; }
    const r = questions[0], st = stored.get(r.q) || {};
    const fill = Object.fromEntries(Object.entries(r).filter(([k, v]) => v != null && (k === 'q' || (ROW_KEYS.includes(k) && st[k] == null))));
    if (Object.keys(fill).length > 1) rows.push(fill);
  }
  if (!problems.length && rows.length) await mergeQuestions(env, block.id, rows, ctx);
  return { saved: rows.length, problems };
}

// ---------------------------------------------------------------- the submit
export function checkJudged(x, stored = {}, count = 60) {
  const problems = [];
  if (!isObj(x)) return { q: null, problems: ['Each item must be an object.'] };
  const q = x.q;
  if (!Number.isInteger(q) || q < 1 || q > Math.max(count, 1)) return { q: Number.isInteger(q) ? q : null, problems: [`q must be the question's number in the block (1 to ${count}).`] };
  const at = `Q${q}`;
  for (const [k, list] of Object.entries(ENUMS)) if (x[k] != null && !list.includes(x[k])) problems.push(`${at}: ${k} must be one of ${list.join(', ')}.`);
  if (x.verdict == null) problems.push(`${at}: give verdict (sound, right_flawed, wrong or no_speech).`);
  if (typeof x.why !== 'string' || !x.why.trim()) problems.push(`${at}: give why, one plain line in your own words.`);
  if (x.teach != null && !isObj(x.teach)) problems.push(`${at}: teach must be an object or null.`);
  if (x.other_conditions != null && !Array.isArray(x.other_conditions)) problems.push(`${at}: other_conditions must be a list.`);
  problems.push(...textProblems(x, at));
  const rowIn = Object.fromEntries(ROW_FIELDS.filter(k => x[k] != null).map(k => [k, x[k]]));
  const { questions, problems: rp } = cleanQuestions([{ q, ...rowIn }]);
  problems.push(...rp.map(s => s.replace(/^Question entry 1/, at)));
  const row = questions[0] || { q };
  const result = stored.result || row.result;
  if (!RESULTS.includes(result)) problems.push(`${at}: give result (right, wrong or omitted) from its page.`);
  else if ((result === 'wrong' || result === 'omitted') && x.verdict && x.verdict !== 'wrong') problems.push(`${at}: UWorld marked it ${result}, so verdict is wrong.`);
  else if (result === 'right' && x.verdict === 'wrong') problems.push(`${at}: UWorld marked it right, so verdict is sound, right_flawed or no_speech.`);
  return { q, problems, row };
}

/**
 * teach_debrief {block, items}: up to CHAT_CHUNK judged questions. Each is checked as the API judge's answer is (its
 * shape, tidyReview, the completeness and quote checks) and accepted or rejected with plain reasons; the accepted ones
 * go through the API judge's own settle path. Idempotent: a question sent again replaces its rows.
 */
export async function chatJudgeSubmit(env, args = {}, ctx = {}, t = now()) {
  const items = Array.isArray(args.items) ? args.items : [];
  if (!items.length || items.length > CHAT_CHUNK) return { problems: [`Send 1 to ${CHAT_CHUNK} judged questions in items.`] };
  let block = await block_(env, args.block);
  if (!block) return { problems: ['No UWorld block is saved on the hub yet: Mo presses Stop on the recorder first.'] };
  const stored = new Map(withMarks(block).map(q => [q.q, q]));
  const count = Number(block.count) || 60;
  const rejected = [], ok = [], seenQ = new Set();
  for (const x of items) {
    const c = checkJudged(x, stored.get(x && x.q) || {}, count);
    if (c.q != null && seenQ.has(c.q)) { rejected.push({ q: c.q, reasons: [`Q${c.q} is sent twice in this call.`] }); continue; }
    if (c.q != null) seenQ.add(c.q);
    if (c.problems.length) rejected.push({ q: c.q, reasons: c.problems });
    else ok.push({ x, row: c.row });
  }
  const rows = ok.map(({ row }) => {
    const st = stored.get(row.q) || {};
    return Object.fromEntries(Object.entries(row).filter(([k, v]) => v != null && (k === 'q' || (ROW_FIELDS.includes(k) && st[k] == null))));
  }).filter(r => Object.keys(r).length > 1);
  if (rows.length) { await mergeQuestions(env, block.id, rows, ctx); block = await block_(env, block.id); }
  const qsNow = new Map(withMarks(block).map(q => [q.q, q]));
  // The API judge's tidying and its checks, item by item (ai-audit.js): a failing item is rejected, never saved half done.
  const source = [parse(block.segments_json, []).map(s => s.text).join(' ')];
  const accepted = [], auditRows = [];
  for (const { x } of ok) {
    const q = qsNow.get(x.q);
    const [v] = tidyReview({ questions: [x] }, [q]);
    const r = checkItem(v, { id: v.q, ...AUDIT_SPECS.uworld_judge(v), source });
    auditRows.push(r);
    if (r.ok) accepted.push(v);
    else rejected.push({ q: v.q, reasons: auditReasons(r).map(s => `Q${v.q}: ${s}`) });
  }
  const job = await first(env, 'SELECT judged_json, seen_json, chat_json FROM uworld_judging WHERE block_id = ?', block.id).catch(() => null);
  const judgedBefore = new Set(parse(job && job.judged_json, []));
  let judged = [...judgedBefore];
  if (accepted.length) {
    await run(env, `INSERT INTO uworld_judging (block_id, status, attempts, started_at, updated_at) VALUES (?1, 'running', 0, ?2, ?2) ON CONFLICT (user_id, block_id) DO NOTHING`, block.id, t);
    const todo = accepted.map(v => qsNow.get(v.q));
    const had = new Set((await all(env, 'SELECT q FROM uworld_reviews WHERE block_id = ?', block.id)).map(r => r.q));
    const redo = new Set(accepted.map(v => v.q).filter(q => judgedBefore.has(q) || had.has(q)));
    const pages = await pagesFor(env, block.id, t).catch(() => new Map());
    const { verdicts } = await prepareVerdicts(env, block, todo, accepted, { pages, seen: true });
    await saveVerdicts(env, block, todo, verdicts, ctx, redo);
    await finishJudged(env, block, verdicts, { judgedBefore, seenBefore: new Set(parse(job && job.seen_json, [])), pages, ctx, t, background: true });
    judged = [...new Set([...judgedBefore, ...verdicts.map(v => v.q)])].sort((a, b) => a - b);
    // What the chat judged, for resuming and for its Recent activity line (one line a block, the latest of each question).
    const chat = parse(job && job.chat_json, {}) || {};
    const by = { ...(chat.by || {}) };
    for (const v of verdicts) by[v.q] = { verdict: v.verdict, step: v.step || null, confidence: v.confidence || null, look_alike: !!(v.teach && v.teach.look_alike), heard: v.heard || null,
      others: (v.other_conditions || []).length, seen: !!v.seen };
    const next = { by, first_at: chat.first_at || t, at: t, saves: (Number(chat.saves) || 0) + 1, rules: FORM_VERSIONS.uworld_judge };
    await run(env, 'UPDATE uworld_judging SET chat_json = ? WHERE block_id = ?', JSON.stringify(next), block.id).catch(e => console.error('uworld chat_json', e && e.message));
    const check = await recordAudit(env, { job: 'uworld_judge', key: `${block.id}:chat:${Math.min(...accepted.map(v => v.q))}`, ref: block.day, rows: auditRows, reasked: 0, at: t });
    const all2 = Object.entries(by).map(([q, x]) => ({ q: Number(q), ...x, teach: x.look_alike ? { look_alike: true } : null, other_conditions: Array.from({ length: x.others || 0 }) }));
    await noteJob(env, { job: 'uworld_judge', key: `${block.id}:chat`, ref: block.id, state: 'ok',
      counts: { ...judgeCounts(all2, new Set(), null, true), spell: 'none', seen: all2.filter(x => x.seen).length, by: 'chat', day: block.day || null, count: Number(block.count) || 0, ...auditCounts(check) } });
  }
  const left = Array.from({ length: Number(block.count) || Math.max(0, ...[...qsNow.keys()]) }, (_, i) => i + 1).filter(q => !judged.includes(q));
  return {
    block: block.id, accepted: accepted.map(v => v.q), rejected, judged, left,
    next_step: rejected.length ? 'Fix the rejected questions and send only those again.' : left.length ? `Next: ${left.slice(0, CHAT_CHUNK).map(q => `Q${q}`).join(', ')}.`
      : 'Every question is judged. Each curated.list entry carries sources (AnKing and Mehlman); only for a q in curated.look_up (usually none), anking_cards and high_yield_notes (four wordings). In one turn, side by side: those lookups and a background tab for every AMBOSS page in curated.amboss (wrong, unsure and slow alike, none skipped; no url: AMBOSS search). Next turn, side by side: curated.amboss_script on every tab, its end list holding the entry\'s terms plus your points\' key words. Draft each question as one account from UWorld\'s explanation, AnKing, Mehlman and his words, check every point against AMBOSS and correct any point that disagrees (AMBOSS wins, except on the answer UWorld marked correct: teach that, the AMBOSS difference in a clause). Then a 2 to 3 line summary and the first explanation, opening it in the UWorld tab with window.__hubCapture.go(q) and, in the same turn, its entry\'s pictures with show_picture {names: pictures} (only card_picture: get_card_images {card_id, max_images: 1}), one sentence on what it shows, skipped when it does not fit (map_rules block_review; save after each of his messages).',
    ...(!left.length ? { curated: await curatedReview(env, block, ctx) } : {}),
  };
}

export const CURATED_TIERS = Object.freeze(['wrong', 'unsure', 'slow']);
const CURATED_MAX = 60;

export function curatedOrder(rows, questions, urls = null) {
  const qs = new Map((questions || []).map(q => [q.q, q]));
  const tiers = { wrong: [], unsure: [], slow: [] }, skip = [];
  const seen = new Set();
  for (const r of [...(rows || [])].filter(r => r && Number.isInteger(r.q)).sort((a, b) => a.q - b.q)) {
    if (seen.has(r.q)) continue;
    seen.add(r.q);
    const q = qs.get(r.q) || {};
    const slow = Number.isInteger(q.time_s) && q.time_s > PACE.slow_s;
    const tier = r.pile === 'wrong' ? 'wrong' : r.pile === 'shaky' ? 'unsure' : slow ? 'slow' : null;
    if (!tier) { skip.push(r.q); continue; }
    const teach = parse(r.teach_json, null) || {}, pack = parse(r.pack_json, null);
    const topic = r.topic_name || teach.condition || q.topic || null;
    tiers[tier].push({ q: r.q, uworld_id: r.uworld_id || q.uworld_id || null, tier, topic, time_s: Number.isInteger(q.time_s) ? q.time_s : null,
      ...(slow ? { slow: true } : {}), why: r.why ? String(r.why).slice(0, 200) : null, reviewed: !!r.reviewed_at, sources: packSources(pack), ...packPictures(pack),
      _url: r.amboss_url || null });
  }
  const all2 = CURATED_TIERS.flatMap(t => tiers[t]).slice(0, CURATED_MAX);
  const amboss = [];
  for (const x of all2) {
    const key = x.topic ? x.topic.toLowerCase() : null;
    const url = x._url || (key && urls && urls.get(key)) || null;
    const a = key && amboss.find(y => y.topic && y.topic.toLowerCase() === key);
    if (a) { a.qs.push(x.q); if (!a.url && url) a.url = url; } else amboss.push({ topic: x.topic || null, url, qs: [x.q] });
  }
  const list = all2.map(({ _url, ...x }) => x);
  const look_up = list.filter(x => !x.sources || x.sources.incomplete).map(x => x.q);
  return { list, skip, amboss, look_up, counts: Object.fromEntries(CURATED_TIERS.map(t => [t, tiers[t].length])) };
}

export function packPictures(p) {
  const s = (p && p.sources) || {};
  return { pictures: (Array.isArray(s.pictures) ? s.pictures : []).map(x => x && x.library).filter(n => typeof n === 'string' && n), card_picture: s.card_picture || null };
}

export function packSources(p) {
  if (!p || !p.sources || !p.glance || !p.why_listed || !p.tested) return null;
  const s = slimPack(p);
  const failed = ['unreachable', 'failed'].includes(p.sources.anking_status) || ['unreachable', 'not searched'].includes(p.sources.mehlman_status);
  return { anking: s.anking, mehlman: s.mehlman, ...(failed ? { incomplete: true } : {}) };
}

export const LOOKUP_MAX = 12, LOOKUP_MS = 8000;
export async function fillSources(env, block, curated, rows, ctx = null) {
  const want = curated.list.filter(x => curated.look_up.includes(x.q)).slice(0, LOOKUP_MAX);
  if (!want.length) return curated;
  const rowOf = new Map();
  for (const r of rows) if (!rowOf.has(r.q)) rowOf.set(r.q, r);
  const qs = new Map(withMarks(block).map(q => [q.q, q]));
  await Promise.all(want.map(async x => {
    try {
      const row = rowOf.get(x.q) || { q: x.q }, q = qs.get(x.q) || { q: x.q }, teach = parse(row.teach_json, null);
      const topic = row.topic_name ? { name: row.topic_name } : null;
      const [found, anki] = await Promise.all([
        mehlmanFor(env, MO, packSearch(teach, q, topic), { timeoutMs: LOOKUP_MS, ctx, keep: 8 }).catch(() => null),
        anking(env, x.uworld_id, teach, LOOKUP_MS),
      ]);
      const mehlman = found && pickMehlman(found, teach, q, topic);
      const pack = packFor({ block, q, row, teach, objective: null, topic, mehlman, anki, reads: null });
      x.sources = packSources(pack);
      const pics = packPictures(pack);
      if (pics.pictures.length || pics.card_picture) Object.assign(x, pics);
    } catch (e) { console.error('uworld curated sources', x.q, e && e.message); }
  }));
  return { ...curated, look_up: curated.list.filter(x => !x.sources || x.sources.incomplete).map(x => x.q) };
}

export async function curatedReview(env, block, ctx = null) {
  const rows = await all(env, `SELECT r.q, r.uworld_id, r.pile, r.why, r.teach_json, r.reviewed_at, r.pack_json, t.name AS topic_name, t.amboss_url
      FROM uworld_reviews r
      LEFT JOIN misses m ON m.user_id = r.user_id AND m.uworld_block_id = r.block_id AND m.uworld_q = r.q AND m.deleted_at IS NULL
      LEFT JOIN topics t ON t.user_id = m.user_id AND t.id = m.topic_id
      WHERE r.block_id = ? ORDER BY r.q, m.at DESC`, block.id).catch(e => { console.error('uworld curated', e && e.message); return []; });
  const qs = withMarks(block);
  const names = [...new Set(curatedOrder(rows, qs).amboss.filter(a => a.topic && !a.url).map(a => a.topic.toLowerCase()))].slice(0, 60);
  const urls = new Map();
  if (names.length) {
    const found = await all(env, `SELECT name, amboss_url FROM topics WHERE user_id = ? AND amboss_url IS NOT NULL AND lower(name) IN (${names.map(() => '?').join(', ')})`,
      MO, ...names).catch(e => { console.error('uworld curated urls', e && e.message); return []; });
    for (const t of found) if (t.amboss_url) urls.set(String(t.name).toLowerCase(), t.amboss_url);
  }
  const c = await fillSources(env, block, curatedOrder(rows, qs, urls), rows, ctx);
  return { ...c, amboss: c.amboss.map(a => ({ ...a, terms: ambossTerms(a, rows, qs) })), amboss_script: ambossScript() };
}

export function ambossTerms(entry, rows, qs) {
  const out = [];
  const add = v => { const t = typeof v === 'string' ? v.trim() : ''; if (t.length > 2 && t.length <= 60 && !out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t); };
  add(entry.topic);
  for (const n of entry.qs) {
    const r = rows.find(x => x.q === n) || {}, teach = parse(r.teach_json, null) || {}, q = (qs.find ? qs.find(x => x.q === n) : null) || {};
    add(teach.condition); add(teach.look_alike); add(q.topic);
  }
  return out.slice(0, 8);
}

async function chatReviewState(env, block) {
  const talk = await first(env, 'SELECT status, analysis_json FROM uworld_review_talks WHERE user_id = ? AND block_id = ?', MO, block.id).catch(() => null);
  const c = talk && (parse(talk.analysis_json, null) || {}).chat;
  return c ? { saved: c.saves || 0, questions: c.questions || [], done: !!c.done } : null;
}

export async function chatReviewSubmit(env, args = {}, ctx = {}, t = now()) {
  const r = isObj(args.review) ? args.review : null;
  if (!r) return { problems: ['review must be an object: {questions, gaps, misconceptions, links, options, words, done}.'] };
  const block = await block_(env, args.block);
  if (!block) return { problems: ['No UWorld block is saved on the hub yet.'] };
  const questions = resulted(withMarks(block));
  if (!questions.length) return { problems: ['Judge the block first: the review is read against its questions.'] };
  const qset = new Set(questions.map(q => q.q));
  const problems = [];
  const raw = {};
  for (const k of ['questions', 'gaps', 'misconceptions', 'links', 'options']) {
    if (r[k] != null && !Array.isArray(r[k])) problems.push(`review.${k} must be a list.`);
    raw[k] = Array.isArray(r[k]) ? r[k] : [];
  }
  const said = Array.isArray(r.words) ? r.words.filter(w => typeof w === 'string').join('\n') : typeof r.words === 'string' ? r.words : '';
  if (said.length > WORDS_MAX) problems.push(`review.words is ${said.length} characters; send at most ${WORDS_MAX} (only the messages this save rests on).`);
  const rejected = [];
  // Question text is refused, not dropped quietly, so Claude rewrites it in its own words.
  for (const k of Object.keys(raw)) raw[k] = raw[k].filter((x, i) => {
    const p = textProblems(x, `${k}.${i}`);
    if (isObj(x) && x.q != null && !qset.has(x.q)) p.push(`${k}.${i}: Q${x.q} is not a question of this block with a result.`);
    if (p.length) rejected.push({ item: `${k}.${i}`, reasons: p });
    return !p.length;
  });
  if (problems.length) return { saved: false, problems };
  const talk = await first(env, 'SELECT * FROM uworld_review_talks WHERE user_id = ? AND block_id = ?', MO, block.id);
  const prev = parse(talk && talk.analysis_json, null);
  const words = scrubStems([{ start: 0, end: 0, text: said }])[0].text;
  const chatWords = [...((prev && prev.chat && prev.chat.words) || []), ...(words.trim() ? [words.trim()] : [])];
  while (chatWords.join('\n').length > CHAT_WORDS_MAX && chatWords.length > 1) chatWords.shift();
  const objectives = await objectivesFor(env, MO, questions.map(q => q.uworld_id).filter(Boolean)).catch(() => ({}));
  const leakIndex = new Set(Object.values(objectives).flatMap(o => [...buildLeakIndex({ obj: o && o.text })]));
  let part = tidyTalk({ ...raw, heard: HEARD.includes(r.heard) ? r.heard : 'clear' }, questions, leakIndex);
  const source = [chatWords.join(' '), parse(block.segments_json, []).map(s => s.text).join(' '), parse(talk && talk.segments_json, []).map(s => s.text).join(' ')];
  const rows = talkRows(part, source);
  let i = 0;
  const keep = {};
  for (const k of ['questions', 'gaps', 'misconceptions', 'links']) keep[k] = (part[k] || []).filter(x => {
    const row = rows[i++];
    if (row.ok) return true;
    rejected.push({ item: row.id, reasons: auditReasons(row) });
    return false;
  });
  part = { ...part, ...keep };
  const covered = [...new Set([...part.questions.map(x => x.q), ...part.options.map(o => o.q), ...[...part.gaps, ...part.misconceptions, ...part.links].map(x => x.q).filter(q => q != null)])];
  const nothing = !covered.length && !part.gaps.length && !part.misconceptions.length && !part.links.length;
  if (nothing && r.done !== true) return { saved: false, block: block.id, rejected, next_step: rejected.length ? 'Fix these and send them again.' : 'Nothing to save in that message.' };
  part = await nameTalk(env, part, questions);
  const merged = nothing ? { ...(prev || { questions: [], gaps: [], misconceptions: [], links: [], options: [], heard: 'clear' }) } : mergeTalk(prev, part);
  const pc = (prev && prev.chat) || {};
  merged.rules = TALK_RULES;
  merged.form_version = FORM_VERSIONS.review_talk;
  merged.chat = { words: chatWords, questions: [...new Set([...(pc.questions || []), ...covered])].sort((a, b) => a - b), done: !!(pc.done || r.done === true),
    saves: (Number(pc.saves) || 0) + 1, first_at: pc.first_at || t, at: t };
  if (!talk) {
    await run(env, `INSERT INTO uworld_review_talks (user_id, block_id, segments_json, words, status, attempts, next_at, created_at, updated_at)
      VALUES (?1, ?2, '[]', 0, 'chat', 0, 0, ?3, ?3) ON CONFLICT (user_id, block_id) DO NOTHING`, MO, block.id, t);
  }
  const row = talk || { block_id: block.id, analysis_json: null, t0: null };
  const counts = nothing ? parse(talk && talk.counts_json, {}) || {} : await applyTalk(env, block, row, merged, ctx, t);
  await run(env, `UPDATE uworld_review_talks SET analysis_json = ?, counts_json = ?, done_at = COALESCE(done_at, ?), updated_at = ? WHERE user_id = ? AND block_id = ?`,
    JSON.stringify(merged), JSON.stringify(counts), t, t, MO, block.id);
  await run(env, 'UPDATE uworld_review_talks SET form_version = ? WHERE user_id = ? AND block_id = ?', FORM_VERSIONS.review_talk, MO, block.id).catch(stampFailed(env, 'uworld_review_talks'));
  if (covered.length) {
    await env.DB.batch([
      env.DB.prepare('UPDATE uworld_reviews SET reviewed_at = ?1, updated_at = ?1 WHERE block_id = ?2 AND reviewed_at IS NULL AND q IN (SELECT value FROM json_each(?3))').bind(t, block.id, JSON.stringify(covered)),
      env.DB.prepare(`UPDATE misses SET reviewed_at = ?1, reviewed_by = 'claude' WHERE user_id = ?2 AND deleted_at IS NULL AND reviewed_at IS NULL AND uworld_block_id = ?3
        AND uworld_q IN (SELECT value FROM json_each(?4))`).bind(t, MO, block.id, JSON.stringify(covered)),
    ]).catch(e => console.error('uworld chat review marks', e && e.message));
  }
  await noteJob(env, { job: 'uworld_review_talk', key: `${block.id}:chat`, ref: block.id, state: 'ok',
    counts: { ...counts, questions: merged.chat.questions.length, chat: 1, done: merged.chat.done ? 1 : 0, day: block.day || null } });
  return { saved: true, block: block.id, covered, reviewed: merged.chat.questions, done: merged.chat.done, line: talkLine({ ...counts, questions: merged.chat.questions.length }), ...(rejected.length ? { rejected } : {}),
    next_step: rejected.length ? 'Some items were not saved: fix those and send them again (silently).' : undefined };
}

export { CHAT_WAIT_MS, mergeTalk, chatCovered };
