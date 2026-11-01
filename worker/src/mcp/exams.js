import { all, first, run } from '../db.js';
import { londonDay, now, hubQuestionLabel, questionLink } from '../util.js';
import { buildSummary, summaryText } from '../summary.js';
import { loadContext, resultFailures, dropFailing, saveDone, letterOf } from '../analyze.js';
import { DESKTOP_RULES, questionMessage, SYSTEMS, VERDICTS, FLAW_KINDS } from '../prompts.js';
import { buildLeakIndex, leaks, normError, ERROR_TYPES } from '../checks.js';
import { listBlocks, saveQuestions, blockWords, blockTimes, timesText, RESULTS, UW_VERDICTS } from '../uworld.js';
import { progress as uworldProgress, progressText } from '../uworld-track.js';
import { cleanGap, addGap, listGaps, gapsText, refLeakProblem, SOURCES, LIST_SOURCES, GAP_MAX, SAID_MAX, TOPIC_MAX, GAP_STEPS, GAP_CONFIDENCE } from '../gaps.js';
import { ankiWords, wordsText } from '../spoken.js';
import { listQueue } from '../map/topics.js';
import { legacy } from './reply.js';
import { readOnly, additive, ALWAYS_LOAD } from './annotations.js';

// Sources Claude itself logs from; spoken_cue and the Anki check's (anki_mac, anki_hub, anki_phone, anki_voice_check) are written by the hub's own code.
const CODE_SOURCES = ['spoken_cue', 'anki_mac', 'anki_hub', 'anki_phone', 'anki_voice_check'];
export const CLAUDE_GAP_SOURCES = SOURCES.filter(s => !CODE_SOURCES.includes(s));
export const GAP_ORIGINS = ['stated', 'review'];
export const ANKI_WORDS_MAX = 60;
const CARD_STYLE = 'in his card style: a NEW short case under 30 words (never the exam\'s own question), one or two questions, one full sentence per answer, then "Versus <look-alike>: <finding that tells them apart>, so <what you do differently>.", notes starting "Why: "';
export const FLASHCARD_STEP = `Suggest at most 15 cards, ranked by marks at stake: map_weakest {purpose: "cards", since_day: the sitting's day} gives each miss its marks (the planner's value of the topic; lane, then exam yield, when it has none). Cards only for the top ones; say in one line which you skipped and why. Write each one ${CARD_STYLE}. Mo keeps any number; add only the ones he keeps, with his Anki connector, to the deck "Step 2 — My Cards". Misreads and test-taking slips get no card.`;

// Only sittings that have ended (CONTRACT hard rule): a sitting still running shows Claude no score, mistakes or
// questions to check, as Smart review stays closed until then.
async function sittings(env, limit = 10) {
  return all(env, `SELECT s.id, s.name, s.finished_at, s.scheduled_date, s.created_at, s.status,
      (SELECT sum(correct) FROM blocks b WHERE b.sitting_id = s.id) AS correct, (SELECT sum(scored) FROM blocks b WHERE b.sitting_id = s.id) AS scored,
      (SELECT count(*) FROM analyses a JOIN blocks b ON b.id = a.block_id WHERE b.sitting_id = s.id AND a.status = 'done' AND a.verdict IN ('wrong', 'right_flawed')) AS mistakes,
      (SELECT count(*) FROM analyses a JOIN blocks b ON b.id = a.block_id WHERE b.sitting_id = s.id AND a.status IN ('pending', 'running')) AS checking
    FROM sittings s WHERE s.exam_id IS NOT NULL AND s.status = 'done' AND EXISTS (SELECT 1 FROM blocks b WHERE b.sitting_id = s.id AND b.ended_at IS NOT NULL)
    ORDER BY COALESCE(s.finished_at, s.created_at) DESC LIMIT ?`, Math.max(1, Math.min(50, Number(limit) || 10)));
}

async function findSitting(env, ref) {
  const list = await sittings(env, 50);
  if (!list.length) return null;
  const r = String(ref || '').trim().toLowerCase();
  if (!r) return list[0];
  return list.find(s => s.id === ref) || list.find(s => s.name.toLowerCase() === r) || list.find(s => s.name.toLowerCase().includes(r)) || null;
}

const NO_MEHLMAN = 'Nothing specific in your Mehlman notes.';
const WAITING = `SELECT a.block_id, a.q_index, b.sitting_id FROM analyses a JOIN blocks b ON b.id = a.block_id JOIN sittings s ON s.id = b.sitting_id
  WHERE a.status = 'pending' AND s.status = 'done'`;

// The map's open queue, for next_to_check's done reply; null when there is none (or no map yet).
async function queuePointer(env, user) {
  try {
    const q = await listQueue(env, user, { limit: 1 });
    if (!q.open) return null;
    const kind = Object.entries(q.by_kind).sort((a, b) => b[1] - a[1])[0][0];
    return { open: q.open, by_kind: q.by_kind, next_step: `Place them: map_queue {kind: "${kind}"} then map_resolve, 25 at a time.` };
  } catch (e) {
    console.error('queue pointer failed', e && e.message);
    return null;
  }
}

async function nextToCheck(env, user, args) {
  let s = null;
  if (args.sitting) {
    s = await findSitting(env, args.sitting);
    if (!s) return legacy({ error: `No finished hub sitting called "${args.sitting}".` }, null, true);
  }
  const where = s ? ' AND b.sitting_id = ?' : '';
  const order = ' ORDER BY COALESCE(s.finished_at, s.created_at), b.idx, a.q_index LIMIT 1';
  const row = await first(env, WAITING + where + order, ...(s ? [s.id] : []));
  if (!row) {
    const queue = await queuePointer(env, user);
    const done = s ? `Nothing left to check in ${s.name}.` : 'Nothing is waiting to be checked.';
    return legacy({ done: true, ...(queue ? { queue } : {}) }, queue ? `${done} ${queue.open === 1 ? '1 item is' : `${queue.open} items are`} waiting to be placed on the map. ${queue.next_step}` : done);
  }
  const left = await first(env, `SELECT count(*) AS n FROM analyses a JOIN blocks b ON b.id = a.block_id WHERE a.status = 'pending' AND b.sitting_id = ?`, row.sitting_id);
  const ctx = await loadContext(env, row.block_id, row.q_index);
  const label = hubQuestionLabel(ctx.sitting.name, ctx.q.num ?? row.q_index + 1, row.q_index, ctx.block && ctx.block.idx);
  const link = questionLink(env.HUB_ORIGIN, row.sitting_id, row.q_index);
  const content = [{ type: 'text', text: `${label}: ${left.n} waiting in this sitting, including this one. Call it "${label}" as a ref (log_gap, a misconception). When you save, use block_id "${row.block_id}" and q_index ${row.q_index}.${link ? ` Mo can open it in the hub's review: ${link}` : ''}` }];
  ctx.figs.forEach((f, i) => {
    content.push({ type: 'text', text: `Picture ${i + 1}, ${f.where === 'explanation' ? 'part of the explanation' : 'part of the question'}: ${f.label}` });
    content.push({ type: 'image', data: f.data, mimeType: f.mime });
  });
  content.push({ type: 'text', text: questionMessage(ctx) });
  return { content, isError: false };
}

const text = v => (v == null ? '' : String(v).trim());

async function saveCheck(env, args) {
  const blockId = text(args.block_id), qIndex = Number(args.q_index);
  const row = await first(env, 'SELECT status, attempts FROM analyses WHERE block_id = ? AND q_index = ?', blockId, qIndex);
  if (!row) return legacy({ error: 'That question is not waiting to be checked. Call next_to_check.' }, null, true);
  const replacing = row.status === 'done';
  if (replacing && args.overwrite !== true) return legacy({ saved: true, already: true }, 'Already saved. Call next_to_check for the next one, or send overwrite true to correct this one.');
  const ctx = await loadContext(env, blockId, qIndex);
  const hasSpeech = ctx.segments.length > 0;
  const r = {
    verdict: args.verdict, flaw_kind: args.flaw_kind || 'none', error_type: args.error_type ?? null,
    paraphrase: text(args.paraphrase), gap: text(args.gap), topic: text(args.topic), system: SYSTEMS.includes(args.system) ? args.system : null,
    rule: text(args.rule), look_alike: text(args.look_alike), mo_quote: text(args.mo_quote), cleaned_transcript: text(args.cleaned_transcript),
    spoken_answer: text(args.spoken_answer), card: null,
  };
  const index = buildLeakIndex(ctx.q);
  const failures = resultFailures(r, ctx, index);
  const note = text(args.mehlman_note);
  if (note && leaks(index, note)) failures.push('The field mehlman_note copies words from the question; rewrite it in your own words.');
  const src = text(args.mehlman_src);
  if (src && leaks(index, src)) failures.push('The field mehlman_src copies words from the question; give only the PDF name and page, like "HY Pediatrics, p. 16".');
  // One round of fixes; after that, whatever still fails is dropped or corrected by code, as in the API pipeline.
  if (failures.length && !(row.attempts >= 1)) {
    await run(env, 'UPDATE analyses SET attempts = attempts + 1 WHERE block_id = ? AND q_index = ?', blockId, qIndex);
    return legacy({ saved: false, problems: failures }, `Not saved yet. Fix these and call save_check again:\n- ${failures.join('\n- ')}`, true);
  }
  const final = dropFailing(r, ctx, index);
  const flagged = ['wrong', 'right_flawed'].includes(final.verdict);
  await saveDone(env, blockId, qIndex, {
    verdict: final.verdict, flaw_kind: flagged ? final.flaw_kind || 'none' : 'none',
    error_type: flagged ? normError(final.error_type) || 'knowledge gap' : null,
    paraphrase: final.paraphrase || null, gap: final.gap || null,
    mo_quote: hasSpeech ? final.mo_quote || null : null, cleaned_transcript: hasSpeech ? final.cleaned_transcript || null : null,
    spoken_answer: letterOf(final.spoken_answer), topic: final.topic || null, system: final.system, rule: final.rule || null, look_alike: final.look_alike || null,
    mehlman_note: flagged ? (note && !leaks(index, note) ? note : NO_MEHLMAN) : null,
    mehlman_src: flagged && note && note !== NO_MEHLMAN && src && !leaks(index, src) ? src : null,
    card_json: null, existing_card_json: null, agreement: 'single', decided_by: 'desktop',
    checker_json: JSON.stringify({ desktop: { verdict: final.verdict, at: now(), fixed_by_code: failures.length > 0 } }), error: null,
  });
  if (replacing) return legacy({ saved: true, replaced: true, verdict: final.verdict }, `Corrected (${final.verdict}). If Mo already finished Smart review for this sitting, what went to Anki and OneNote stays as it was.`);
  return legacy({ saved: true, verdict: final.verdict }, `Saved (${final.verdict}). Call next_to_check for the next one.`);
}

const CARD_FIELDS = ['n', 'card_id', 'note_id', 'deck', 'day', 'ease', 'shown_at', 'answered_at', 'verdict', 'error_type', 'topic', 'gap', 'said', 'words', 'before_json', 'after_json'];
export function trimWords(r, max = ANKI_WORDS_MAX) {
  if (!r || !Array.isArray(r.cards)) return r;
  const pick = c => Object.fromEntries(CARD_FIELDS.filter(k => c[k] !== undefined).map(k => [k, c[k]]));
  const telling = c => c.words > 0 || ['shaky', 'gap', 'pending'].includes(c.verdict);
  const order = [...r.cards.filter(telling), ...r.cards.filter(c => !telling(c))];
  const kept = new Set(order.slice(0, max));
  const cards = r.cards.filter(c => kept.has(c)).map(pick);
  const left = r.cards.length - cards.length;
  return { ...r, cards, ...(left > 0 ? { more: { left, call: 'anki_words with card_id for one card\'s history; the cards left out were silent and sound.' } } : {}) };
}

async function logGap(env, user, args) {
  const { gap, problems } = cleanGap(args);
  if (!(typeof args.topic === 'string' && args.topic.trim())) problems.push(`topic is needed: the one condition as an AMBOSS article names it, under ${TOPIC_MAX} characters.`);
  if (args.source != null && !CLAUDE_GAP_SOURCES.includes(args.source)) problems.push(`source must be one of ${CLAUDE_GAP_SOURCES.join(', ')}.`);
  if (args.origin != null && !GAP_ORIGINS.includes(args.origin)) problems.push('origin must be stated or review.');
  if (!problems.length) { const leak = await refLeakProblem(env, user, gap); if (leak) problems.push(leak); }
  if (problems.length) return legacy({ saved: false, problems }, `Not logged:\n${problems.join('\n')}`, true);
  if (args.origin) gap.origin = args.origin;
  const id = await addGap(env, gap, { user });
  return legacy({ saved: true, id }, 'Logged.');
}

export const EXAM_TOOLS = [
  {
    name: 'list_sittings', title: 'Hub sittings', legacy: true, annotations: readOnly('Hub sittings'),
    description: 'Mo\'s recent hub sittings (practice exams in the hub), newest first: name, date, score, mistakes the checks found.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many, default 10' } }, additionalProperties: false },
    run: async (env, user, args) => {
      const rows = await sittings(env, args.limit);
      const out = rows.map(s => ({ id: s.id, name: s.name, date: s.finished_at ? londonDay(s.finished_at) : s.scheduled_date || londonDay(s.created_at),
        score: s.scored ? `${s.correct} of ${s.scored}` : null, mistakes: s.mistakes, still_checking: s.checking }));
      return legacy({ sittings: out });
    },
  },
  {
    name: 'exam_mistakes', title: 'Mistakes in one exam', legacy: true, annotations: readOnly('Mistakes in one exam'),
    // The card rules ride in the reply's next_step (FLASHCARD_STEP, in full), so the description names them only.
    description: 'For "make flashcards from <exam>" (a hub sitting, e.g. "NBME 10"; default the latest): his wrong and flawed-right answers, most useful first: system, error type, his words, gap, rule, look-alike, Mehlman note, earlier misses. Then follow its next_step: at most 15 cards in his style for "Step 2 — My Cards"; none for misreads or test-taking slips. The day\'s UWorld and Anki misses: map_weakest {purpose: "cards"}.',
    inputSchema: { type: 'object', properties: { sitting: { type: 'string', description: 'Sitting id or name' } }, additionalProperties: false },
    run: async (env, user, args) => {
      const s = await findSitting(env, args.sitting);
      if (!s) return legacy({ error: args.sitting ? `No finished hub sitting called "${args.sitting}".` : 'No finished hub sittings yet.' }, null, true);
      const sum = await buildSummary(env, s.id);
      return legacy({ ...sum, still_checking: s.checking, next_step: FLASHCARD_STEP }, summaryText(sum) + (s.checking ? `\n\n(${s.checking} questions are still being checked.)` : ''));
    },
  },
  {
    name: 'check_rules', title: 'Rules for checking', legacy: true, annotations: readOnly('Rules for checking'),
    description: '"check <exam>" or "carry on checking": call once, then follow it: next_to_check, judge, save_check, next, until none are left. The rules for checking his answers and what he said aloud (his thinking, not yours).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => legacy({ rules: DESKTOP_RULES }, DESKTOP_RULES),
  },
  {
    name: 'next_to_check', title: 'Next question to check', legacy: true, annotations: readOnly('Next question to check'),
    description: 'The next question to check: pictures, question, his answer (marked by code), confidence, time, clicks, highlights, earlier mistakes, transcript. A sitting id or name stays in one exam; else the oldest anywhere. done with a queue: place its topics (map_queue, map_resolve).',
    inputSchema: { type: 'object', properties: { sitting: { type: 'string', description: 'Sitting id or name' } }, additionalProperties: false },
    run: (env, user, args) => nextToCheck(env, user, args),
  },
  {
    name: 'uworld_blocks', title: 'UWorld recordings', legacy: true, annotations: readOnly('UWorld recordings'),
    description: 'His UWorld recorder blocks, newest first: date, mode, minutes, transcript (his timed words, per question when saved). 20 a call; page with before = the oldest date. Habits: read every page for repeats (anchoring, first fit, another question answered, right answers changed, hesitation, by system); top 3 with examples and a fix.',
    inputSchema: { type: 'object', properties: {
      since: { type: 'string', description: 'Only blocks on or after this day, YYYY-MM-DD' },
      before: { type: 'string', description: 'Only blocks before this day, YYYY-MM-DD (for paging)' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many, default 5' } }, additionalProperties: false },
    run: async (env, user, args) => {
      const r = await listBlocks(env, args);
      const t = r.total ? [`${r.total} saved UWorld block${r.total === 1 ? '' : 's'}${args.since || args.before ? ' in that range' : ''} (${r.total_words} words). Showing ${r.blocks.length}, newest first.`,
        ...r.blocks.map(b => `\n=== ${b.date}, ${b.mode}${b.minutes != null ? `, ${b.minutes} min` : ''}${b.count ? `, ${b.count} questions` : ''} (block ${b.id}${b.split_saved ? '' : ', split not saved'}) ===\n${b.marks ? `Marks:\n${b.marks}\n` : ''}${b.transcript}`)].join('\n')
        : 'No UWorld blocks saved yet.';
      return legacy(r, t);
    },
  },
  {
    name: 'uworld_words', title: 'His words on a UWorld question', legacy: true, annotations: readOnly('His words on a UWorld question'),
    description: 'What he said aloud in a recorded UWorld block, with times; the latest, or a block or date. With a question: its part when its start is saved, else the whole block.',
    inputSchema: { type: 'object', properties: {
      question: { type: 'integer', minimum: 1, maximum: 60, description: 'The question\'s number in the block (shown on the UWorld screen)' },
      block: { type: 'string', description: 'A block id, if you have one' },
      date: { type: 'string', description: 'The block\'s day, YYYY-MM-DD (latest block that day)' } }, additionalProperties: false },
    run: async (env, user, args) => {
      const r = await blockWords(env, args);
      if (!r.found) return legacy(r, 'No UWorld block is recorded on the hub yet. Carry on without his words.');
      const head = `Block ${r.block}, ${r.date}, ${r.mode}${r.minutes != null ? `, ${r.minutes} min` : ''}${r.count ? `, ${r.count} questions` : ''}.${r.saved_questions.length ? ` Questions already saved: ${r.saved_questions.join(', ')}.` : ''}`;
      const what = r.whole_block ? (r.question ? `Q${r.question} has no saved start yet, so here is the whole block: find his words for Q${r.question}.` : 'The whole block:')
        : `Q${r.question} only:`;
      const details = r.details ? `\nResults screen: ${r.details}.` : '';
      const rv = r.review;
      const review = !rv ? '' : rv.transcript ? `\n\nHis review afterwards${rv.cause ? ` (cause in his words: ${rv.cause})` : ''}:\n${rv.transcript}`
        : rv.said ? `\n\nHis review afterwards (${rv.at || '?'}): "${rv.said}"` : `\n\nHis review: ${rv.note || rv.line || rv.status}`;
      return legacy(r, `${head}${details}\n${what}\n${r.transcript}${review}`);
    },
  },
  {
    name: 'uworld_times', title: 'UWorld timing', legacy: true, annotations: readOnly('UWorld timing'),
    description: 'His UWorld timing: average, how many over the 90 s pace, those over 2 min (right ones too, slowest first), slowest systems; default the last 7 days. A slow topic is weak even when right. Also his UWorld progress: first pass left, pace, finish, incorrects.',
    inputSchema: { type: 'object', properties: {
      since: { type: 'string', description: 'Only blocks on or after this day, YYYY-MM-DD' },
      before: { type: 'string', description: 'Only blocks before this day, YYYY-MM-DD' } }, additionalProperties: false },
    run: async (env, user, args) => {
      const r = await blockTimes(env, args);
      const progress = await uworldProgress(env).catch(() => null);
      return legacy(progress ? { ...r, progress } : r, progress ? `${timesText(r)}\n${progressText(progress)}` : timesText(r));
    },
  },
  {
    // Unlisted (the Claude audit, 1 Nov 2026): teach_debrief {judge: true, block, items} saves the same rows; still callable.
    name: 'save_uworld_questions', title: 'Save UWorld questions', legacy: true, unlisted: true, annotations: additive('Save UWorld questions', { idempotent: true }),
    description: 'Save questions onto a recorded UWorld block: start time, results screen, your check. Labels and numbers only, never question text. Not for a block review.',
    inputSchema: { type: 'object', properties: {
      block: { type: 'string', description: 'The block id from the paste' },
      questions: { type: 'array', minItems: 1, maxItems: 60, items: { type: 'object', properties: {
        q: { type: 'integer', minimum: 1, maximum: 60, description: 'Question number in the block' },
        start: { type: 'string', description: 'Where this question starts in the transcript, like "12:05"' },
        uworld_id: { type: 'string', description: 'UWorld question ID' },
        result: { type: 'string', enum: RESULTS },
        picked: { type: 'string', description: 'Mo\'s letter' }, answer: { type: 'string', description: 'Correct letter' },
        subject: { type: 'string', description: 'Short label, for example Medicine' }, system: { type: 'string', description: 'Short label, for example Cardiovascular' },
        topic: { type: 'string', description: 'Short topic label from the results screen, under 80 characters' },
        time_s: { type: 'integer', minimum: 0, description: 'Seconds Mo spent' }, others_time_s: { type: 'integer', minimum: 0, description: 'Other users\' average seconds, if shown' }, others_pct: { type: 'integer', minimum: 0, maximum: 100, description: '% of other users who got it right' },
        verdict: { type: 'string', enum: UW_VERDICTS, description: 'Your check: wrong, right_flawed (lucky guess or wrong fact), sound, or no_speech' },
        error_type: { type: 'string', enum: ERROR_TYPES }, note: { type: 'string', description: 'One sentence in your own words, under 300 characters' },
      }, required: ['q'], additionalProperties: false } },
    }, required: ['block', 'questions'], additionalProperties: false },
    run: async (env, user, args, ctx) => {
      const r = await saveQuestions(env, args.block, args.questions, ctx);
      return legacy(r, r.saved ? `Saved ${r.questions} questions on block ${args.block}.` : `Not saved:\n${r.problems.join('\n')}`, !r.saved);
    },
  },
  {
    name: 'log_gap', title: 'Log a gap', legacy: true, annotations: additive('Log a gap'), _meta: ALWAYS_LOAD,
    // No Anki Voice clause (audit, 31 Oct 2026): rate_card's gap reaches the hub from the Anki server itself.
    description: '"gap: ..." (or "gap, why ...") from Mo, anywhere: call with his words and the topic, reply only "Logged." and carry on; don\'t teach unless he asks. Never question-bank or card text. Missed cards in an Anki Voice review need no call: rate_card sends them.',
    inputSchema: { type: 'object', properties: {
      gap: { type: 'string', description: `What he doesn't get, one plain line, his words, ≤${GAP_MAX} chars` },
      topic: { type: 'string', description: `One condition or approach as an AMBOSS article names it, singular, no "vs" ("Rh alloimmunization"), ≤${TOPIC_MAX} chars` },
      said: { type: 'string', description: `His own words, shortened, ≤${SAID_MAX} chars (not when gap is his words)` },
      card_id: { type: 'integer', description: 'The Anki card on screen, if any' },
      note_id: { type: 'integer' },
      ref: { type: 'string', description: 'Context: "UW 12345", or "NBME 10 Q22" / "NBME 10 B2 Q22" as next_to_check names it' },
      source: { type: 'string', enum: CLAUDE_GAP_SOURCES, description: 'chat (default), or anki_voice in a voice review' },
      origin: { type: 'string', enum: GAP_ORIGINS },
      error_type: { type: 'string', enum: ERROR_TYPES },
      mixed_with: { type: 'string', description: 'The look-alike he mixed it up with (AMBOSS name)' },
      step: { type: 'string', enum: GAP_STEPS },
      confidence: { type: 'string', enum: GAP_CONFIDENCE } }, required: ['gap', 'topic'], additionalProperties: false },
    run: (env, user, args) => logGap(env, user, args),
  },
  {
    name: 'list_gaps', title: 'His logged gaps', legacy: true, annotations: readOnly('His logged gaps'),
    description: 'His logged gaps, newest first: stated ("gap: ..."), said aloud while recording, shaky or missed cards from Anki reviews, each with topic, his words, card or question; plus repeated topics. For "what are my gaps".',
    inputSchema: { type: 'object', properties: {
      since_days: { type: 'integer', minimum: 1, maximum: 120, description: 'How many days back, default 14' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many, default 30' },
      source: { type: 'string', enum: LIST_SOURCES, description: 'Only one source' } }, additionalProperties: false },
    run: async (env, user, args) => { const r = await listGaps(env, args); return legacy(r, gapsText(r)); },
  },
  {
    name: 'anki_words', title: 'His words in Anki reviews', legacy: true, annotations: readOnly('His words in Anki reviews'),
    description: `What he said aloud reviewing Anki, card by card, before and after the answer, with rating, time and the hub's check (sound, shaky, gap). Latest review, or a session or day; card_id: one card's history. At most ${ANKI_WORDS_MAX} cards, spoken and flagged first. Card text: the Anki connector.`,
    inputSchema: { type: 'object', properties: {
      session: { type: 'string', description: 'A review session id' },
      date: { type: 'string', description: 'A day, YYYY-MM-DD (its latest review)' },
      card_id: { type: 'integer', description: 'One Anki card id' } }, additionalProperties: false },
    run: async (env, user, args) => {
      const r = trimWords(await ankiWords(env, args));
      const t = wordsText(r);
      return legacy(r, r.more ? `${t}\n(${r.more.left} silent sound cards left out.)` : t);
    },
  },
  {
    name: 'save_check', title: 'Save a check', legacy: true, annotations: additive('Save a check', { idempotent: true }),
    description: 'Save your check of the next_to_check question. Code checks it (verdict vs code marking, the If/then rule, nothing copied); fix the problems it lists and call again. Correcting a saved check (only when Mo asks): the whole check, overwrite true.',
    inputSchema: {
      type: 'object',
      properties: {
        block_id: { type: 'string' }, q_index: { type: 'integer', minimum: 0 },
        verdict: { type: 'string', enum: VERDICTS }, flaw_kind: { type: 'string', enum: FLAW_KINDS },
        error_type: { type: ['string', 'null'], enum: [...ERROR_TYPES, null] },
        cleaned_transcript: { type: 'string' }, spoken_answer: { type: 'string' }, mo_quote: { type: 'string' },
        paraphrase: { type: 'string' }, gap: { type: 'string' }, topic: { type: 'string' }, system: { type: 'string', enum: SYSTEMS },
        rule: { type: 'string' }, look_alike: { type: 'string' }, mehlman_note: { type: 'string' }, mehlman_src: { type: 'string' },
        overwrite: { type: 'boolean', description: 'true replaces a check that is already saved' },
      },
      required: ['block_id', 'q_index', 'verdict', 'flaw_kind', 'error_type', 'paraphrase', 'gap', 'topic', 'system', 'rule', 'look_alike'],
      additionalProperties: false,
    },
    run: (env, user, args) => saveCheck(env, args),
  },
];
