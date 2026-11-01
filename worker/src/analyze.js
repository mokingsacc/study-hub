import { HttpError, json, readJson, int, now, safeParse } from './util.js';
import { first, all, run, getBlock, getSitting, getQuestion, getSettings, cardsToday, reserveSpend, spendCap } from './db.js';
import { callJson, isPending } from './claude.js';
import { AUDIT_SPECS, checkItem, recordAudit, auditCounts } from './ai-audit.js';
import { noteJob } from './job-log.js';
import { imageData } from './images.js';
import { ankiCall } from './anki.js';
import { confFor } from '../../public/js/conf-words.js';
import {
  JUDGE_SYSTEM, CHECKER_SYSTEM, MEHLMAN_SYSTEM, JUDGE_SCHEMA, CHECKER_SCHEMA, MEHLMAN_SCHEMA, FIVE_STEPS,
  questionMessage, judgeTask, tieBreakTask, retryTask, mehlmanMessage,
} from './prompts.js';
import { tidyCause } from '../../public/js/shared/cause.js';
import { tidyCore, causeAgreement, consideredNotConfused, FORM_VERSIONS } from './answer-core.js';
import { nameOthers } from './map/name-map.js';
import { gapStatement, hasMapCols, hasSignalCols, hasFormCols, mapGaps } from './gaps.js';
import { releasable } from './map/ingest/map-fields.js';
import { noteConcepts } from './map/concepts.js';
import { buildLeakIndex, leakFailures, checkCard, tidyCard, normError, NO_CARD_ERRORS, HUB_CARDS, OUTGOING_FIELDS, cardTexts, leaks } from './checks.js';
import { MO } from './users.js';
import { ingestAnalysis, hook } from './map/ingest/hub.js';

const FLAGGED = ['wrong', 'right_flawed'];
const STALE_MS = 10 * 60_000;
export const ANALYSIS_RESERVE_USD = 1.0; // all three roles on Opus 5.5 at high effort
export const MAX_RUNNING = 8;
export const MAX_ATTEMPTS = 2;
const NO_MEHLMAN = 'Nothing specific in your Mehlman notes.';

export const letterOf = v => (v == null ? null : String(v).trim().toUpperCase() || null);

// Events on this question, with "changed from" marked on a choose that replaces an earlier answer.
export function questionEvents(state, qIndex) {
  const evs = Array.isArray(state.events) ? state.events : [];
  const out = [];
  let lastChoice = null;
  for (const e of evs) {
    if (!e) continue;
    // 'nav' has q = the item arrived at and v = the item left (null when the block opens).
    if (e.type === 'nav' && Number(e.q) !== qIndex && e.v != null && Number(e.v) === qIndex) {
      out.push({ t: Number(e.t) || 0, type: 'left', v: null });
      continue;
    }
    if (Number(e.q) !== qIndex) continue;
    const o = { t: Number(e.t) || 0, type: e.type === 'nav' ? 'arrived' : e.type, v: e.type === 'nav' ? null : e.v };
    if (e.type === 'choose') {
      const l = letterOf(e.v);
      if (lastChoice && l && l !== lastChoice) o.changed = lastChoice;
      if (l) lastChoice = l;
    }
    out.push(o);
  }
  return out;
}

const median = xs => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
const unmark = html => String(html || '').replace(/<(?!\/?mark\b)[^>]*>/gi, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

export async function answerContext(env, ctx, state) {
  const { block, sitting, qIndex, events, segments } = ctx;
  const pick = (m, k) => (m ? m[k] ?? m[String(k)] : undefined);
  const [blocks, history] = await Promise.all([
    all(env, 'SELECT idx, q_from, q_to, correct, scored, started_at, ended_at FROM blocks WHERE sitting_id = ? ORDER BY idx', sitting.id),
    all(env, `SELECT COALESCE(a.error_confirmed, a.error_type) AS err, a.system, a.verdict, a.flaw_kind FROM analyses a JOIN blocks b ON b.id = a.block_id
      WHERE b.sitting_id != ? AND a.status = 'done' AND a.verdict IN ('wrong', 'right_flawed') AND a.created_at >= ?`, sitting.id, now() - 60 * 86_400_000),
  ]);
  const times = [];
  for (let i = block.q_from; i <= block.q_to; i++) times.push(Number(pick(state.time_on_q, i)));
  const med = median(times);
  const mine = Number(pick(state.time_on_q, qIndex));
  const slower = Number.isFinite(mine) ? times.filter(t => Number.isFinite(t) && t > mine).length : null;
  const hlHtml = pick(state.hl, qIndex);
  const highlighted = hlHtml ? [...String(hlHtml).matchAll(/<mark\b[^>]*>([\s\S]*?)<\/mark>/gi)].map(m => unmark(m[1]).replace(/<[^>]*>/g, '').trim()).filter(Boolean) : [];
  const firstChoose = events.find(e => e.type === 'choose');
  const firstSpeech = segments[0];
  const t0 = block.started_at || 0;
  const rel = v => (v > 1e11 ? v - t0 : v * 1000);
  const count = (k) => Object.entries(history.reduce((o, r) => { const v = k === 'err' ? normError(r.err) : r[k]; if (v) o[v] = (o[v] || 0) + 1; return o; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    item: qIndex - block.q_from + 1, items: block.q_to - block.q_from + 1, block: block.idx + 1, blocks: blocks.length,
    exam_number: qIndex + 1, block_minutes: sitting.block_minutes || null,
    secs: Number.isFinite(mine) ? mine : null, block_median_secs: med, slower_in_block: slower,
    visits: events.filter(e => e.type === 'arrived').length,
    struck: pick(state.strike, qIndex) || [], flagged: !!pick(state.mark, qIndex), highlighted,
    spoke_before_choosing: firstChoose && firstSpeech ? rel(firstSpeech.start) < rel(firstChoose.t) : null,
    block_score: (() => { const b = blocks.find(x => x.idx === block.idx); return b && b.scored ? `${b.correct} of ${b.scored}` : null; })(),
    secs_left_at_end: state.secs_left != null ? Math.round(Number(state.secs_left)) : null,
    earlier_errors: count('err'), earlier_systems: count('system'),
    earlier_lucky_guesses: history.filter(r => r.flaw_kind === 'lucky_guess').length, earlier_mistakes: history.length,
  };
}

export async function loadContext(env, blockId, qIndex) {
  const block = await getBlock(env, blockId);
  if (qIndex < block.q_from || qIndex > block.q_to) throw new HttpError(400, 'That question is not in this block.');
  const sitting = await getSitting(env, block.sitting_id);
  if (!sitting.exam_id) throw new HttpError(400, 'This sitting has no questions in the hub to analyse.');
  const [q, tr] = await Promise.all([
    getQuestion(env, sitting.exam_id, qIndex),
    first(env, 'SELECT segments_json, flags_json FROM transcripts WHERE block_id = ? AND q_index = ?', blockId, qIndex),
  ]);
  if (!q.answer) throw new HttpError(400, 'This question has no answer key, so it cannot be marked.');
  const figList = Array.isArray(q.figs) ? q.figs : [];
  const data = figList.length ? await imageData(env, figList.map(f => f.id)) : {};
  const figs = figList.filter(f => data[f.id]).map(f => ({ label: f.label, where: f.where, mime: data[f.id].mime, data: data[f.id].data }));
  const state = safeParse(block.state_json, {}) || {};
  const pick = (m, k) => (m ? m[k] ?? m[String(k)] : undefined);
  const finalLetter = letterOf(pick(state.ans, qIndex));
  const secs = pick(state.time_on_q, qIndex);
  const segments = (safeParse(tr && tr.segments_json, []) || []).filter(s => s && String(s.text || '').trim());
  const said = confFor(pick(state.conf, qIndex), { segments }); // a tap wins; otherwise sure, lean or guess said aloud
  const ctx = {
    block, sitting, q, qIndex, finalLetter, figs,
    correct: finalLetter != null && finalLetter === letterOf(q.answer), // the only place right/wrong is decided
    conf: said.conf, confFrom: said.from,
    secs: secs != null ? Number(secs) : null,
    voiceMode: sitting.voice_mode,
    segments,
    events: questionEvents(state, qIndex),
    flags: (safeParse(tr && tr.flags_json, []) || []).filter(f => f && (f.type === 'answer_change' || f.type === 'override_out_of_range')),
    blockStart: block.started_at,
  };
  ctx.more = await answerContext(env, ctx, state);
  return ctx;
}

// Code checks on one judge-shaped result. Returns plain failures for the retry message.
export function resultFailures(r, ctx, index) {
  const f = [];
  if (!ctx.correct && r.verdict !== 'wrong') f.push('Mo was WRONG (decided by code): the verdict must be "wrong".');
  if (ctx.correct && r.verdict === 'wrong') f.push('Mo was RIGHT (decided by code): the verdict cannot be "wrong".');
  if (FLAGGED.includes(r.verdict) && !normError(r.error_type)) f.push('A wrong or right_flawed verdict needs one error type from the list.');
  if (r.verdict === 'right_flawed' && (!r.flaw_kind || r.flaw_kind === 'none')) f.push('right_flawed needs a flaw_kind other than none.');
  if (r.paraphrase && /^\s*why:/i.test(r.paraphrase)) f.push('paraphrase should be Mo\'s reasoning, not a Why line.');
  if (r.rule && !/^if\b/i.test(String(r.rule).trim())) f.push('rule must read "If <finding>, then <conclusion or action>."');
  const et = normError(r.error_type);
  if (r.card) {
    if (!FLAGGED.includes(r.verdict)) f.push('No card for a sound or no_reasoning_heard verdict: set card to null.');
    else f.push(...checkCard(tidyCard(r.card), et));
  }
  for (const l of leakFailures(index, r)) {
    f.push(`${l.field === 'card' ? `The card ${l.part}` : `The field ${l.field}`} copies "${l.run}" from the question; rewrite it in your own words.`);
  }
  const a = auditRow(r, ctx);
  for (const p of a.missing) if (p !== 'error_type') f.push(`A wrong or right_flawed verdict needs ${p}: it is empty.`);
  for (const p of a.fake) f.push(`${p} must be Mo's own words copied exactly from his transcript (or empty when he said nothing usable).`);
  return f;
}

export function auditRow(r, ctx) {
  const source = (ctx.segments || []).map(s => s.text).join(' ');
  return checkItem(r || {}, { id: `Q${(ctx.qIndex ?? 0) + 1}`, ...AUDIT_SPECS.nbme_judge(r || {}), source });
}

// After the one retry: drop whatever still fails rather than let it through.
export function dropFailing(r, ctx, index) {
  const out = { ...r };
  for (const k of OUTGOING_FIELDS) if (leaks(index, out[k])) out[k] = null;
  for (const k of auditRow(out, ctx).fake) out[k] = k === 'cause_quote' ? '' : null;
  const et = normError(out.error_type);
  if (out.card) {
    const card = tidyCard(out.card);
    const bad = !FLAGGED.includes(out.verdict) || checkCard(card, et).length || cardTexts(card).some(([, t]) => leaks(index, t));
    out.card = bad ? null : card;
  }
  fixVerdict(out, ctx);
  if (NO_CARD_ERRORS.includes(normError(out.error_type))) out.card = null;
  return out;
}

// Code decides right or wrong. When a pass still disagrees after its retry, move it to the nearest verdict
// the code allows and fill what that verdict needs: a wrong needs an error type; a right answer judged
// wrong becomes right_flawed (a Guess tap reads as a lucky guess, anything else as a wrong reason).
export function fixVerdict(r, ctx) {
  if (!ctx.correct && r.verdict !== 'wrong') {
    r.verdict = 'wrong';
    r.flaw_kind = 'none';
    r.error_type = normError(r.error_type) || 'knowledge gap';
  } else if (ctx.correct && r.verdict === 'wrong') {
    r.verdict = 'right_flawed';
    r.flaw_kind = ctx.conf === '3' ? 'lucky_guess' : 'right_wrong_reason';
    r.error_type = normError(r.error_type) || 'knowledge gap';
  }
  return r;
}

// The question's pictures (an ECG, an X-ray...) go first, each with a line saying what it is, then the
// question text, cached as one block for the retry and the tie-break.
export function questionContent(ctx) {
  const out = [];
  (ctx.figs || []).forEach((f, i) => {
    out.push({ type: 'text', text: `Picture ${i + 1}, ${f.where === 'explanation' ? 'part of the explanation' : 'part of the question'}: ${f.label}` });
    out.push({ type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data } });
  });
  out.push({ type: 'text', text: questionMessage(ctx), cache_control: { type: 'ephemeral' } });
  return out;
}

async function judgeLike(env, ctx, index, firstUserText, label) {
  const messages = [{ role: 'user', content: [...questionContent(ctx), { type: 'text', text: firstUserText }] }];
  const first1 = await callJson(env, { role: 'judge', system: JUDGE_SYSTEM, messages, schema: JUDGE_SCHEMA, effort: 'high' });
  let r = first1.data;
  const failures = resultFailures(r, ctx, index);
  let retried = false;
  if (failures.length) {
    retried = true;
    console.log(JSON.stringify({ analysis_retry: label, failures: failures.length }));
    const again = await callJson(env, {
      role: 'judge', system: JUDGE_SYSTEM, schema: JUDGE_SCHEMA, effort: 'high',
      messages: [...messages, { role: 'assistant', content: first1.message.content }, { role: 'user', content: retryTask(failures) }],
    });
    r = again.data;
  }
  return { result: dropFailing(r, ctx, index), retried, failures };
}

async function checker(env, ctx) {
  const messages = [{ role: 'user', content: [...questionContent(ctx), { type: 'text', text: 'Review this question by the rules and write the JSON.' }] }];
  const { data } = await callJson(env, { role: 'checker', system: CHECKER_SYSTEM, messages, schema: CHECKER_SCHEMA, effort: 'high' });
  const c = fixVerdict(data, ctx);
  const row = checkItem(c, { id: `Q${(ctx.qIndex ?? 0) + 1} second judge`, ...AUDIT_SPECS.nbme_checker(c), source: (ctx.segments || []).map(x => x.text).join(' ') });
  for (const k of row.fake) c[k] = '';
  c.audit = row;
  return c;
}

/**
 * Who settles the cause (pure): the judge and the blind checker on one flagged verdict. 'agreed' when both name the
 * same cause or either names none; 'cause' when they name different ones (the tie-break settles it before anything
 * counts). A verdict disagreement already goes to the tie-break.
 */
export function causeQuestion(judge, check) {
  if (!FLAGGED.includes(judge && judge.verdict) || !check || check.verdict !== judge.verdict) return 'agreed';
  return causeAgreement(judge, check) === 'disputed' ? 'cause' : 'agreed';
}

function sourceLabel(p) {
  if (!p) return null;
  const name = String(p.source || '').replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
  return name ? `${name}, p. ${p.page}` : null;
}

async function mehlman(env, topic, rule) {
  let found;
  try {
    found = await ankiCall(env, 'high_yield_notes', { query: topic, limit: 3 }, { timeoutMs: 15_000 });
  } catch (e) {
    return { note: null, src: null, error: e.message };
  }
  const passages = (found && Array.isArray(found.passages) ? found.passages : []).slice(0, 3);
  if (!passages.length) return { note: NO_MEHLMAN, src: null };
  try {
    const { data } = await callJson(env, {
      role: 'mehlman', system: MEHLMAN_SYSTEM, schema: MEHLMAN_SCHEMA, effort: 'high', maxTokens: 16000,
      messages: [{ role: 'user', content: mehlmanMessage(topic, rule, passages) }],
    });
    if (!data.fits || !String(data.mehlman_note || '').trim()) return { note: NO_MEHLMAN, src: String(data.mehlman_src || '').trim() || sourceLabel(passages[0]) };
    return { note: String(data.mehlman_note).trim(), src: String(data.mehlman_src || '').trim() || sourceLabel(passages[0]) };
  } catch (e) {
    if (isPending(e)) throw e;   // waiting for its Message Batch: the analysis waits with it
    // A note is a nice-to-have: whatever went wrong, the analysis still finishes.
    return { note: NO_MEHLMAN, src: sourceLabel(passages[0]), error: e.message };
  }
}

const termsOf = (r) => {
  const t = (Array.isArray(r.card_search_terms) ? r.card_search_terms : []).map(s => String(s).trim()).filter(Boolean).slice(0, 3);
  return t.length ? t.join(' ') : (r.topic || '');
};

async function existingCard(env, r) {
  const text = termsOf(r);
  if (!text) return null;
  try {
    const s = await getSettings(env);
    let found;
    try {
      found = await ankiCall(env, 'find_cards', { text, deck: s.deck }, { timeoutMs: 15_000 });
    } catch (e) {
      found = await ankiCall(env, 'find_cards', { text, all_decks: true }, { timeoutMs: 15_000 });
    }
    const cards = (found && Array.isArray(found.cards)) ? found.cards : [];
    if (!found || !found.exact || !cards.length) return null; // only a card holding every key word counts as close
    const c = cards[0];
    return { card_id: c.card_id, deck: c.deck, question: c.question, answer: c.answer, notes: c.notes, fact: c.fact, extra: c.extra, schedule: c.schedule, query: text };
  } catch {
    return null;
  }
}

const STORE_COLS = ['verdict', 'flaw_kind', 'error_type', 'paraphrase', 'gap', 'mo_quote', 'cleaned_transcript', 'spoken_answer', 'topic', 'system', 'rule',
  'look_alike', 'mehlman_note', 'mehlman_src', 'card_json', 'card_decision', 'existing_card_json', 'agreement', 'checker_json', 'decided_by', 'error',
  'cause', 'cause_quote', 'cause_inferred', 'cause_detail',
  // The step that broke (wave 3, 0058): its facet places the miss on the topic's Diagnose or Manage part.
  'step',
  // The answer forms' core and the second judge on the cause (0067): written only by a check that gives them.
  'heard', 'confidence', 'confidence_words', 'confidence_inferred', 'other_json', 'cause_check', 'form_version'];
const FORM_STORE = ['heard', 'confidence', 'confidence_words', 'confidence_inferred', 'other_json', 'cause_check', 'form_version'];

export async function saveDone(env, blockId, qIndex, row) {
  const cols = STORE_COLS.filter(k => (k === 'cause_check' || FORM_STORE.includes(k) ? row.form_version != null
    : k.startsWith('cause') ? row.cause != null : k === 'step' ? row.step != null : true));
  const vals = cols.map(k => (k === 'card_decision' ? row[k] || 'pending' : row[k] ?? null));
  await run(env, `UPDATE analyses SET status = 'done', ${cols.map(k => `${k} = ?`).join(', ')}, created_at = ?, attempts = 0 WHERE block_id = ? AND q_index = ?`,
    ...vals, now(), blockId, qIndex);
  // The map (held until the sitting ends); a failure there never fails the check.
  await hook('analysis', () => ingestAnalysis(env, MO, blockId, qIndex));
}

async function saveOthers(env, ctx, core, ref) {
  const [map, signals, forms] = await Promise.all([hasMapCols(env), hasSignalCols(env), hasFormCols(env)]);
  if (!map) return 0;
  const hold = releasable(ctx.sitting) ? null : { sitting_id: ctx.sitting.id };
  const made = core.other_conditions.filter(o => o.kind === 'gap').map((o, i) => gapStatement(env, { source: 'spoken_cue',
    gap: `Unsure about ${o.topic}, shown while answering an exam question on ${ctx.q && ctx.q.num ? `item ${ctx.q.num}` : 'another topic'}.`.slice(0, 200),
    said: o.quote, topic: o.topic, ref, verdict: 'shaky', ...(forms ? { heard: core.heard, form_version: FORM_VERSIONS.nbme_judge } : {}) },
    { id: `hub:${ctx.block.id}:${ctx.qIndex}:o${i + 1}`, at: now(), hold, map, signals, forms }));
  if (!made.length) return 0;
  await env.DB.batch(made.map(m => m.statement));
  await mapGaps(env, made.map(m => m.row));
  return made.length;
}

async function readRow(env, blockId, qIndex) {
  return first(env, 'SELECT * FROM analyses WHERE block_id = ? AND q_index = ?', blockId, qIndex);
}

// The words on an analysis row waiting for its Message Batch (the sitting page shows them; sweepBatched looks for them).
export const BATCH_WAIT = 'Waiting for its batch: checked within the hour.';

export async function analyze(env, blockId, qIndex, { force = false, background = false } = {}) {
  const existing = await readRow(env, blockId, qIndex);
  if (existing && existing.status === 'done' && !force) return existing;
  if (existing && existing.status === 'running' && now() - (existing.created_at || 0) < STALE_MS) return existing;

  const ctx = await loadContext(env, blockId, qIndex);
  const hasSpeech = ctx.segments.length > 0;

  // Right, nothing said, no Guess tap: nothing to judge and nothing to spend.
  if (ctx.correct && !hasSpeech && ctx.conf !== '3') {
    await claim(env, blockId, qIndex, existing);
    await saveDone(env, blockId, qIndex, { verdict: 'no_reasoning_heard', flaw_kind: 'none', agreement: 'agreed', decided_by: 'both' });
    return readRow(env, blockId, qIndex);
  }

  if ((await getSettings(env)).check_mode === 'desktop') {
    if (existing && existing.status === 'pending' && !force) return existing;
    await run(env, `INSERT INTO analyses (block_id, q_index, status, created_at, attempts) VALUES (?, ?, 'pending', ?, 0)
      ON CONFLICT(block_id, q_index) DO UPDATE SET status = 'pending', error = NULL, created_at = excluded.created_at, attempts = 0`, blockId, qIndex, now());
    return readRow(env, blockId, qIndex);
  }

  if (!force && existing && existing.status === 'error' && (existing.attempts || 0) >= MAX_ATTEMPTS) {
    throw new HttpError(422, `This question could not be checked after ${MAX_ATTEMPTS} tries. Use Try again on the sitting page to run it once more.`);
  }
  // The cap is checked once, here: inner calls of a started analysis always finish.
  const release = await reserveSpend(env, ANALYSIS_RESERVE_USD, await spendCap(env));
  try {
    await claim(env, blockId, qIndex, existing);
  } catch (e) {
    await release(0);
    throw e;
  }
  try {
    const index = buildLeakIndex(ctx.q);
    const [j, c] = await Promise.all([judgeLike(env, ctx, index, judgeTask(), 'judge'), checker(env, ctx)]);
    let final = j.result;
    let agreement = 'agreed', decidedBy = 'both', causeCheck = null;
    const { audit: checkRow, ...cPass } = c;
    const passes = { judge: { verdict: j.result.verdict, flaw_kind: j.result.flaw_kind, error_type: j.result.error_type, cause: j.result.cause ?? null, step: j.result.step ?? null,
      retried: j.retried }, checker: cPass, form_version: FORM_VERSIONS.nbme_judge, checker_form_version: FORM_VERSIONS.nbme_checker };
    if (causeQuestion(j.result, c) === 'cause') {
      decidedBy = 'tie-break';
      const t = await judgeLike(env, ctx, index, tieBreakTask(j.result, c, 'cause'), 'tie-break');
      passes.tie_break = { on: 'cause', verdict: t.result.verdict, cause: t.result.cause ?? null, step: t.result.step ?? null, retried: t.retried };
      if (t.result.cause) {
        final = { ...j.result, cause: t.result.cause, cause_quote: t.result.cause_quote, cause_inferred: t.result.cause_inferred, cause_detail: t.result.cause_detail,
          ...(FIVE_STEPS.includes(t.result.step) ? { step: t.result.step } : {}) };
        causeCheck = 'tie-break';
      } else causeCheck = 'disputed';
    } else if (c.verdict !== j.result.verdict) {
      agreement = 'disputed';
      decidedBy = 'tie-break';
      const t = await judgeLike(env, ctx, index, tieBreakTask(j.result, c), 'tie-break');
      final = t.result;
      causeCheck = 'tie-break';   // the third look saw both causes too
      passes.tie_break = { verdict: t.result.verdict, flaw_kind: t.result.flaw_kind, error_type: t.result.error_type, cause: t.result.cause ?? null, retried: t.retried };
      if (!FLAGGED.includes(final.verdict)) {
        const flagger = [j.result, c].find(p => FLAGGED.includes(p.verdict));
        if (flagger) {
          passes.fail_safe = true;
          final = { ...final, verdict: flagger.verdict, flaw_kind: flagger.flaw_kind, error_type: flagger.error_type || final.error_type };
          if (!final.card && j.result.card && FLAGGED.includes(j.result.verdict)) final.card = j.result.card;
        }
      }
    }
    // The completeness record of this question's check (ai-audit.js): the final answer, after the judge's one retry.
    const check = await recordAudit(env, { job: 'nbme_judge', key: `${blockId}:${qIndex}`, ref: blockId, rows: [auditRow(final, ctx), checkRow].filter(Boolean), reasked: j.retried ? 1 : 0 });
    const errorType = FLAGGED.includes(final.verdict) ? normError(final.error_type) : null;
    if (NO_CARD_ERRORS.includes(errorType) || !FLAGGED.includes(final.verdict)) final.card = null;

    const flagged = FLAGGED.includes(final.verdict);
    if (flagged && !causeCheck) causeCheck = 'agreed';
    if (flagged && hasSpeech) {
      const picked = ((ctx.q && ctx.q.opts) || []).find(o => o && o.l === ctx.finalLetter);
      const chk = consideredNotConfused(final, { words: final.mo_quote || '', mixed: [final.look_alike], picked: picked ? picked.t : null, fallback: c.cause });
      if (chk.changed) { final = chk.item; passes.considered = chk.why; }
    }
    const core = tidyCore({ ...final, ...(hasSpeech ? {} : { confidence_words: '', cause_quote: '', concept_quote: '', other_conditions: [] }) },
      { flagged, sound: final.verdict === 'sound', own: [final.topic], safe: v => (v && !leaks(index, v) ? v : null) });
    if (core.other_conditions.length) core.other_conditions = (await nameOthers(env, MO, core.other_conditions, { own: [final.topic] })).filter(o => !leaks(index, o.topic));
    const [hy, dup] = await Promise.all([
      flagged && final.topic ? mehlman(env, final.topic, final.rule) : Promise.resolve({ note: null, src: null }),
      flagged && final.card && HUB_CARDS ? existingCard(env, final) : Promise.resolve(null),
    ]);
    await saveDone(env, blockId, qIndex, {
      verdict: final.verdict,
      flaw_kind: final.flaw_kind || 'none',
      error_type: errorType,
      paraphrase: final.paraphrase, gap: final.gap, mo_quote: hasSpeech ? final.mo_quote : null,
      cleaned_transcript: hasSpeech ? final.cleaned_transcript : null,
      spoken_answer: letterOf(final.spoken_answer),
      topic: final.topic, system: final.system, rule: final.rule, look_alike: final.look_alike || null,
      ...(flagged ? tidyCause({ ...final, cause_quote: hasSpeech ? final.cause_quote : null }) : {}),
      ...(flagged && FIVE_STEPS.includes(final.step) ? { step: final.step } : {}),
      heard: hasSpeech ? core.heard : 'not_said', confidence: core.confidence, confidence_words: core.confidence_words, confidence_inferred: core.confidence_inferred,
      other_json: core.other_conditions.length ? JSON.stringify(core.other_conditions) : null, cause_check: causeCheck, form_version: FORM_VERSIONS.nbme_judge,
      mehlman_note: hy.note, mehlman_src: hy.src,
      card_json: final.card ? JSON.stringify(final.card) : null,
      existing_card_json: dup ? JSON.stringify(dup) : null,
      agreement, decided_by: decidedBy, checker_json: JSON.stringify(passes), error: null,
    });
    // The foundation concept the miss rests on (concepts.js): a pending tag the hourly run places; never fails the check.
    // A sound answer whose words showed the concept understood is a right tag (it waits for the sitting to end).
    if (core.concept) {
      const c = tidyCause({ ...final, cause_quote: null });
      await noteConcepts(env, MO, [{ id: `hub:${blockId}:${qIndex}`, source: 'nbme_judge', block_id: blockId, q_index: qIndex, concept: core.concept,
        concept_discipline: core.concept_discipline, concept_quote: hasSpeech ? core.concept_quote : null, cause: flagged ? c.cause : null, clinical_name: final.topic, at: now(),
        polarity: core.concept_polarity, heard: core.heard }]);
    }
    if (core.other_conditions.length) await saveOthers(env, ctx, core, `exam ${blockId} Q${qIndex + 1} (other topic)`).catch(e => console.error('nbme other conditions', e && e.message));
    // One line a block for the checks that came back from their batch, added up (never one a question).
    if (background) await noteJob(env, { job: 'nbme_check', key: `${blockId}:ok`, ref: blockId, state: 'ok', add: true, counts: { checked: 1, ...auditCounts(check), chk_part: (check && check.part) || 'none' } });
    return readRow(env, blockId, qIndex);
  } catch (e) {
    // Waiting for its Message Batch (claude.js): the row waits as pending, no try used; the minute cron finishes it
    // (sweepBatched) and the sitting page shows it once it is done.
    if (isPending(e)) {
      await run(env, "UPDATE analyses SET status = 'pending', error = ?, attempts = max(0, attempts - 1) WHERE block_id = ? AND q_index = ?", BATCH_WAIT, blockId, qIndex);
      if (!background) await noteJob(env, { job: 'nbme_check', key: `${blockId}:held`, ref: blockId, state: 'held', add: true, counts: { batch: 1, n: 1 } });
      return readRow(env, blockId, qIndex);
    }
    const msg = e instanceof HttpError ? e.message : 'The analysis failed. Try again.';
    if (!(e instanceof HttpError)) console.error('analysis failed', e && e.stack || e);
    await run(env, "UPDATE analyses SET status = 'error', error = ? WHERE block_id = ? AND q_index = ?", msg, blockId, qIndex);
    throw e;
  } finally {
    await release(0); // the calls added their real cost as they went
  }
}

// Mark the row running, at most MAX_RUNNING at once across the hub (checked in the same statement).
// Over the limit answers 503, which jobs.js retries later (a 429 would stop its queue for the day).
async function claim(env, blockId, qIndex, existing) {
  const t = now();
  const room = `(SELECT count(*) FROM analyses WHERE status = 'running' AND created_at >= ${t - STALE_MS}) < ${MAX_RUNNING}`;
  if (!existing) {
    const r = await run(env, `INSERT OR IGNORE INTO analyses (block_id, q_index, status, created_at, attempts) SELECT ?, ?, 'running', ?, 1 WHERE ${room}`, blockId, qIndex, t);
    if (r.meta && r.meta.changes) return;
    if (!(await readRow(env, blockId, qIndex))) throw new HttpError(503, 'The hub is checking other questions right now. This one will be tried again shortly.');
  }
  const r = await run(env, `UPDATE analyses SET status = 'running', error = NULL, created_at = ?, attempts = attempts + 1
    WHERE block_id = ? AND q_index = ? AND (status != 'running' OR created_at < ?) AND ${room}`, t, blockId, qIndex, t - STALE_MS);
  if (!r.meta || !r.meta.changes) {
    const row = await readRow(env, blockId, qIndex);
    if (row && row.status === 'running' && row.created_at >= t - STALE_MS) throw new HttpError(409, 'This question is already being analysed.');
    throw new HttpError(503, 'The hub is checking other questions right now. This one will be tried again shortly.');
  }
}

export async function sweepBatched(env) {
  let rows;
  try { rows = await all(env, "SELECT block_id, q_index FROM analyses WHERE status = 'pending' AND error = ? ORDER BY created_at LIMIT 4", BATCH_WAIT); } catch { return; }
  for (const r of rows) {
    try { await analyze(env, r.block_id, r.q_index, { background: true }); } catch (e) {
      console.error('nbme batched check failed', r.block_id, r.q_index, e && e.message);
      await noteJob(env, { job: 'nbme_check', key: `${r.block_id}:failed`, ref: r.block_id, state: 'failed', add: true, counts: { n: 1 }, detail: e });
      if (e instanceof HttpError && e.status === 429) break;
    }
  }
}

export async function analyzeRoute(request, env) {
  const body = await readJson(request);
  const blockId = String(body.block_id || '');
  if (!blockId) throw new HttpError(400, 'Please give the block to analyse.');
  const qIndex = int(body.q_index, 'Question index', { min: 0, optional: false });
  const row = await analyze(env, blockId, qIndex, { force: !!body.force });
  return json(row); // column-faithful: card_json, checker_json, existing_card_json stay JSON text
}

const DECISIONS = ['pending', 'yes', 'no', 'edited', 'existing'];

export async function patchAnalysis(request, env) {
  const body = await readJson(request);
  const blockId = String(body.block_id || '');
  if (!blockId) throw new HttpError(400, 'Please give the block.');
  const qIndex = int(body.q_index, 'Question index', { min: 0, optional: false });
  const row = await readRow(env, blockId, qIndex);
  if (!row) throw new HttpError(404, 'That question has not been analysed yet.');
  const set = {};
  if ('error_confirmed' in body) {
    if (body.error_confirmed == null || body.error_confirmed === '') set.error_confirmed = null;
    else {
      set.error_confirmed = normError(body.error_confirmed);
      if (!set.error_confirmed) throw new HttpError(400, 'That is not one of the error types.');
    }
  }
  if ('card_decision' in body) {
    if (!DECISIONS.includes(body.card_decision)) throw new HttpError(400, 'Card choice must be yes, no, edited, existing or pending.');
    set.card_decision = body.card_decision;
    if (body.card_decision === 'existing' && !row.existing_card_json) throw new HttpError(400, 'There is no existing card to bring forward.');
  }
  if ('card_json' in body) {
    const card = typeof body.card_json === 'string' ? safeParse(body.card_json, undefined) : body.card_json;
    if (card === undefined) throw new HttpError(400, 'The card was not valid.');
    if (card !== null) {
      if (typeof card !== 'object' || !Array.isArray(card.questions) || !card.questions.length || card.questions.length > 2 || !String(card.answer || '').trim()) {
        throw new HttpError(400, 'A card needs one or two questions and an answer.');
      }
    }
    set.card_json = card === null ? null : JSON.stringify(tidyCard(card));
    if (!('card_decision' in body) && card) set.card_decision = 'edited';
  }
  if ('mo_override' in body) {
    if (body.mo_override != null && body.mo_override !== 'sound') throw new HttpError(400, "mo_override can only be 'sound' or empty.");
    set.mo_override = body.mo_override || null;
  }
  // Card cap (cards_per_day_cap, London day): counted when a card first becomes yes/edited. Moving
  // between yes and edited keeps the first decision time, so an edit after yes is not a new card.
  if ('card_decision' in set && set.card_decision !== (row.card_decision || 'pending')) {
    const accepted = d => d === 'yes' || d === 'edited';
    if (!(accepted(set.card_decision) && accepted(row.card_decision))) {
      if (accepted(set.card_decision)) {
        const cap = Number((await getSettings(env)).cards_per_day_cap);
        if (Number.isFinite(cap) && (await cardsToday(env, { block_id: blockId, q_index: qIndex })) >= cap) {
          throw new HttpError(409, 'Card limit for today reached');
        }
      }
      set.decided_at = now();
    }
  }
  const keys = Object.keys(set);
  if (!keys.length) throw new HttpError(400, 'Nothing to change.');
  await run(env, `UPDATE analyses SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE block_id = ? AND q_index = ?`, ...keys.map(k => set[k]), blockId, qIndex);
  if ('error_confirmed' in set || 'mo_override' in set) await hook('analysis', () => ingestAnalysis(env, MO, blockId, qIndex));
  const updated = await readRow(env, blockId, qIndex);
  const warnings = updated.card_json ? checkCard(safeParse(updated.card_json), normError(updated.error_confirmed || updated.error_type)) : [];
  return json({ analysis: updated, card_warnings: warnings });
}

