import { HttpError, json, readJson, londonDay, londonDayStart, now, uuid, safeParse, int, hubQuestionLabel } from './util.js';
import { all, first, getSettings, getSitting, getQuestions } from './db.js';
import { buildLeakIndex, leaks, payloadLeak, normError, NO_CARD_ERRORS, HUB_CARDS, cardTexts } from './checks.js';
import { SERVER_ERROR } from './anki.js';
import { flushOutbox } from './outbox.js';
import { confFor } from '../../public/js/conf-words.js';

const CONFIDENCE = { 1: 3, 2: 2, 3: 1 }; // tap 1 Sure = high (3), 2 Lean = mid, 3 Guess = low (1)
const NO_MEHLMAN = 'Nothing specific in your Mehlman notes.';
const letter = v => (v == null ? null : String(v).trim().toUpperCase() || null);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function outcomeFor(m, key, conf = null) {
  const k = letter(key), first1 = letter(m.first_letter), spoken = letter(m.spoken_answer);
  if (m.verdict === 'wrong') return (first1 && first1 === k) || (spoken && spoken === k) ? 'wrong_changed_from_right' : 'wrong';
  if ((first1 && first1 !== k) || (spoken && spoken !== k)) return 'right_changed_from_wrong';
  return m.flaw_kind === 'lucky_guess' || conf === 1 ? 'right_guess' : 'right_flawed';
}

export function debriefArgs(m, q, label) {
  const errorType = normError(m.error_confirmed || m.error_type) || 'knowledge gap';
  const said = confFor(m.conf_tap, m.tr_text); // a tap, or sure, lean or guess said aloud
  const conf = CONFIDENCE[said.conf];
  const args = {
    error_type: SERVER_ERROR[errorType],
    outcome: outcomeFor(m, q.answer, conf),
    block_mode: 'timed',
  };
  if (conf) { args.confidence = conf; args.confidence_source = said.hedge ? 'assumed' : 'reported'; }
  const secs = Math.round(Number(m.time_on_q));
  if (Number.isFinite(secs) && secs > 0) { args.time_s = Math.min(secs, 3600); args.time_source = 'recorder'; }
  if (m.paraphrase) {
    args.my_reasoning = m.paraphrase;
    args.reasoning_source = m.cleaned_transcript || m.mo_quote ? 'mo' : 'inferred';
  }
  args.correct_reasoning = `[${label}]${m.gap ? ' ' + m.gap : ''}`;
  if (m.topic) args.topic = m.topic;
  if (m.system) args.system = m.system;
  if (m.rule) args.rule = m.rule;
  if (m.look_alike) args.look_alikes = m.look_alike;
  const card = safeParse(m.card_json, null);
  // "My reasoning was sound" on a wrong answer: still logged (the answer was wrong), but with no card.
  if (HUB_CARDS && card && ['yes', 'edited'].includes(m.card_decision) && !NO_CARD_ERRORS.includes(errorType) && m.mo_override !== 'sound') {
    args.card = { stem: card.stem || '', questions: card.questions || [], answer: card.answer || '', vs: card.vs || '', why: card.why || '', notes: card.notes || '' };
  }
  return { errorType, args };
}

// Last net before anything is queued: drop any field that shares a 6-word run with the question.
export function guardArgs(index, args) {
  const dropped = [];
  for (const k of Object.keys(args)) {
    if (k === 'card') continue;
    if (typeof args[k] === 'string' && leaks(index, args[k])) { delete args[k]; dropped.push(k); }
  }
  if (args.card && cardTexts(args.card).some(([, t]) => leaks(index, t))) { delete args.card; dropped.push('card'); }
  if (args.my_reasoning === undefined) delete args.reasoning_source;
  return dropped;
}

function mistakeLine(m, num, index) {
  const errorType = normError(m.error_confirmed || m.error_type) || 'knowledge gap';
  const para = m.paraphrase && !leaks(index, m.paraphrase) ? m.paraphrase : 'reasoning not recorded';
  const gap = m.gap && !leaks(index, m.gap) ? m.gap : 'see review';
  let line = `Q${num} · ${errorType} · ${para} · gap: ${gap}`;
  if (m.mehlman_src && !leaks(index, m.mehlman_src)) line += ` · Mehlman: ${m.mehlman_src}${m.mehlman_note === NO_MEHLMAN ? ' (closest)' : ''}`;
  // The whole line once more, since a run could straddle two fields.
  return leaks(index, line) ? `Q${num} · ${errorType}` : line;
}

export function cardUndecided(m) {
  if (!HUB_CARDS || m.mo_override === 'sound') return false;
  if (m.card_decision && m.card_decision !== 'pending') return false;
  if (NO_CARD_ERRORS.includes(normError(m.error_confirmed || m.error_type) || 'knowledge gap')) return false;
  return !!(m.card_json || m.existing_card_json);
}

export async function finishReview(request, env, ctx, { id }) {
  const sitting = await getSitting(env, id);
  if (!sitting.exam_id) throw new HttpError(400, 'This sitting has no questions in the hub to review.');
  // Smart review opened with &block=<idx> sends only that block (review.html posts {block}).
  const body = await readJson(request).catch(() => ({}));
  const onlyBlock = body.block == null || body.block === '' ? null : int(body.block, 'Block', { min: 0, max: 100 });
  const settings = await getSettings(env);
  const mistakes = await all(env,
    `SELECT a.*, b.idx AS block_idx,
       json_extract(b.state_json, '$.conf."' || a.q_index || '"') AS conf_tap,
       json_extract(b.state_json, '$.time_on_q."' || a.q_index || '"') AS time_on_q,
       (SELECT t.text FROM transcripts t WHERE t.block_id = a.block_id AND t.q_index = a.q_index) AS tr_text,
       (SELECT json_extract(e.value, '$.v') FROM json_each(b.state_json, '$.events') e
         WHERE json_extract(e.value, '$.type') = 'choose' AND CAST(json_extract(e.value, '$.q') AS INTEGER) = a.q_index
         ORDER BY CAST(e.key AS INTEGER) LIMIT 1) AS first_letter
     FROM analyses a JOIN blocks b ON b.id = a.block_id
     WHERE b.sitting_id = ? AND a.status = 'done' AND a.verdict IN ('wrong', 'right_flawed')
       AND (a.verdict = 'wrong' OR a.mo_override IS NULL OR a.mo_override != 'sound')
       AND (? IS NULL OR b.idx = ?)
     ORDER BY b.idx, a.q_index`, id, onlyBlock, onlyBlock);
  const questions = await getQuestions(env, sitting.exam_id, [...new Set(mistakes.map(m => m.q_index))]);

  const existing = await all(env, "SELECT idem_key, status, attempts, payload_json FROM outbox WHERE idem_key LIKE ? OR idem_key LIKE ?", `debrief:${id}:%`, `onenote:${id}:%`);
  const existingKeys = new Map(existing.map(r => [r.idem_key, r]));
  const dayStart = londonDayStart();
  const today = await first(env,
    "SELECT count(*) AS n FROM outbox WHERE kind = 'debrief' AND created_at >= ? AND json_extract(payload_json, '$.args.card') IS NOT NULL", dayStart);
  let cardsLeft = Math.max(0, Number(settings.cards_per_day_cap) - (today ? today.n : 0));

  const stmts = [];
  let queued = 0, cardsHeld = 0, waiting = 0;
  const t = now();
  const lines = [];
  for (const m of mistakes) {
    const q = questions[m.q_index];
    if (!q) continue;
    const index = buildLeakIndex(q);
    const num = q.num ?? m.q_index + 1;
    const label = hubQuestionLabel(sitting.name, num, m.q_index, m.block_idx);   // unique in the sitting (B3-3)
    const key = `debrief:${id}:${m.block_id}:${m.q_index}`;
    lines.push({ key, block_idx: m.block_idx, text: mistakeLine(m, num, index) });
    const prior = existingKeys.get(key);
    if (prior && !(prior.status === 'pending' && prior.attempts === 0)) continue; // already sent or in flight
    if (!prior && cardUndecided(m)) { waiting++; continue; }
    const { args } = debriefArgs(m, q, label);
    const dropped = guardArgs(index, args);
    if (dropped.length) console.log(JSON.stringify({ leak_guard_dropped: dropped, key }));
    const hadCard = prior ? !!safeParse(prior.payload_json, {})?.args?.card : false;
    if (args.card && !hadCard && m.decided_at == null) {
      if (cardsLeft > 0) cardsLeft--;
      else { delete args.card; cardsHeld++; }
    }
    const payload = { label, sitting_id: id, block_id: m.block_id, q_index: m.q_index, args };
    if (payloadLeak(index, payload)) throw new HttpError(500, 'The leak guard stopped a debrief; nothing was sent.');
    stmts.push(env.DB.prepare(
      `INSERT INTO outbox (id, kind, idem_key, payload_json, status, attempts, created_at) VALUES (?, 'debrief', ?, ?, 'pending', 0, ?)
       ON CONFLICT(idem_key) DO UPDATE SET payload_json = excluded.payload_json WHERE outbox.status = 'pending' AND outbox.attempts = 0`)
      .bind(uuid(), key, JSON.stringify(payload), t));
    if (!prior) queued++;
  }

  const onenoteRows = existing.filter(r => r.idem_key.startsWith(`onenote:${id}:`));
  const covered = new Set(onenoteRows.flatMap(r => (safeParse(r.payload_json, {}) || {}).covers || []));
  const fresh = lines.filter(l => !covered.has(l.key));
  if (!onenoteRows.length || fresh.length) {
    const tot = await first(env, 'SELECT sum(correct) AS c, sum(scored) AS s FROM blocks WHERE sitting_id = ?', id);
    const pct = sitting.score_pct != null ? sitting.score_pct : tot && tot.s ? Math.round((tot.c / tot.s) * 1000) / 10 : null;
    const scoreText = pct != null ? `${pct}%${tot && tot.s ? ` (${tot.c} of ${tot.s})` : ''}` : 'not scored yet';
    const date = londonDay(sitting.finished_at || t);
    const byBlock = new Map();
    for (const l of fresh) { if (!byBlock.has(l.block_idx)) byBlock.set(l.block_idx, []); byBlock.get(l.block_idx).push(l.text); }
    let html = `<p><b>Score:</b> ${esc(scoreText)}</p><p><b>Date:</b> ${esc(date)}</p>`;
    const textLines = [`Score: ${scoreText} · ${date}`];
    if (!byBlock.size) { html += '<p>No mistakes to log from this sitting.</p>'; }
    for (const [bi, items] of [...byBlock.entries()].sort((a, b) => a[0] - b[0])) {
      html += `<h2>Block ${bi + 1}</h2><ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
      textLines.push(`Block ${bi + 1}`, ...items);
    }
    const payload = { label: sitting.name, sitting_id: id, section: settings.onenote_section || 'Review', title: sitting.name, html, lines: textLines, covers: fresh.map(l => l.key) };
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO outbox (id, kind, idem_key, payload_json, status, attempts, created_at) VALUES (?, 'onenote', ?, ?, 'pending', 0, ?)")
      .bind(uuid(), `onenote:${id}:${onenoteRows.length + 1}`, JSON.stringify(payload), t + 1));
    queued++;
  }
  if (stmts.length) await env.DB.batch(stmts);
  const flushed = await flushOutbox(env, { force: false });
  return json({ queued, sent: flushed.sent, failed: flushed.failed, cards_held: cardsHeld, waiting });
}
