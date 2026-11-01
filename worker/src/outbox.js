import { json, readJson, now, safeParse, londonDay } from './util.js';
import { all, run, getSetting, setSetting } from './db.js';
import { ankiCall, AnkiError } from './anki.js';
import { noteJob } from './job-log.js';

export const MAX_ATTEMPTS = 8;
/** A row a sender said to wait on is looked at again after this; one waiting longer than WAIT_MAX_MS is skipped. */
export const WAIT_RETRY_MS = 3600_000, WAIT_MAX_MS = 30 * 86_400_000;
export const MISS_UNLOGGED = 'That miss is not in the Anki mistake log yet.';
const SENDING_STALE_MS = 10 * 60_000;
const backoffMs = attempts => Math.min(6 * 3600_000, 60_000 * 2 ** attempts);

export const pageKey = sittingId => `onenote_page:${sittingId}`;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A debrief that may have reached the server already (timeout): look for its question label first, and its topic
// too, so another block's question with the same printed number is never taken for it (B3-3).
export async function alreadyLogged(env, label, args = {}) {
  try {
    const r = await ankiCall(env, 'list_mistakes', { since_days: 2 }, { timeoutMs: 15_000 });
    const norm2 = v => String(v || '').trim().toLowerCase();
    const hit = (r.mistakes || []).find(m => String(m.correct_reasoning || '').startsWith(`[${label}]`)
      && (!args.topic || norm2(m.topic) === norm2(args.topic)));
    return hit ? { ok: true, deduped: true, mistake_id: hit.id } : null;
  } catch {
    return null;
  }
}

async function sendDebrief(env, item, payload, prev) {
  // Any earlier try that may have reached the server (timeout, dropped reply, or a send cut off while
  // 'sending') is checked first, whatever the attempt count.
  if (prev.ambiguous) {
    const found = await alreadyLogged(env, payload.label, payload.args);
    if (found) return found;
  }
  const r = await ankiCall(env, 'debrief_question', payload.args, { timeoutMs: 45_000 });
  return { ok: true, debrief_id: r.debrief_id, mistake_id: r.mistake_id, anki_note_ids: r.anki_note_ids || [], skipped: r.skipped || [], summary: r.summary };
}

async function findPage(env, section, title) {
  const r = await ankiCall(env, 'onenote_topics', { section }, { timeoutMs: 20_000 });
  const t = (r.topics || []).find(p => norm(p.title) === norm(title));
  return t ? t.page_id : null;
}

async function sendOnenote(env, item, payload, prev) {
  let pageId = await getSetting(env, pageKey(payload.sitting_id));
  if (!pageId && prev.ambiguous) pageId = await findPage(env, payload.section, payload.title);
  if (pageId) {
    const r = await ankiCall(env, 'onenote_append', { page: pageId, items: payload.lines }, { timeoutMs: 45_000 });
    await setSetting(env, pageKey(payload.sitting_id), pageId);
    return { ok: true, action: 'append', page_id: pageId, item_ids: r.item_ids || [] };
  }
  const r = await ankiCall(env, 'onenote_create_page', { section: payload.section, title: payload.title, html: payload.html }, { timeoutMs: 45_000 });
  if (!r.page_id) throw new AnkiError('OneNote did not return the new page.');
  await setSetting(env, pageKey(payload.sitting_id), r.page_id);
  return { ok: true, action: 'create', page_id: r.page_id, url: r.url || null };
}

async function sendLinkCard(env, item, payload) {
  const row = await env.DB.prepare('SELECT anki_mistake_id FROM misses WHERE user_id = ? AND id = ?')
    .bind(payload.user || 'mo', String(payload.miss_id)).first();
  if (!row) return { ok: true, skipped: 'The miss is no longer on the hub.' };
  if (row.anki_mistake_id == null) {
    if (now() - Number(item.created_at || 0) >= WAIT_MAX_MS) return { ok: true, skipped: 'The miss never reached the Anki mistake log in 30 days.', gave_up_wait: true };
    return { wait: MISS_UNLOGGED };
  }
  const noteIds = (payload.anki_note_ids || []).map(Number).filter(Number.isInteger);
  if (!noteIds.length) return { ok: true, skipped: 'No card note id.' };
  const r = await ankiCall(env, 'update_mistake', { id: Number(row.anki_mistake_id), anki_note_ids: noteIds, remediation: payload.remediation || 'card' }, { timeoutMs: 20_000 });
  return { ok: true, mistake_id: Number(row.anki_mistake_id), result: r && r.ok !== undefined ? r.ok : true };
}

// A re-test result onto the miss's record in the Anki log (update_mistake retest_result). The server keeps one result
// per mistake a day, so a resend changes nothing; a miss no longer in the log is skipped.
async function sendRetest(env, item, payload) {
  const row = await env.DB.prepare('SELECT anki_mistake_id FROM misses WHERE user_id = ? AND id = ?').bind(payload.user || 'mo', String(payload.miss_id)).first();
  if (!row || row.anki_mistake_id == null) return { ok: true, skipped: 'The miss has no Anki log record.' };
  if (!['got_it', 'missed_again'].includes(payload.result)) return { ok: true, skipped: 'No result.' };
  const r = await ankiCall(env, 'update_mistake', { id: Number(row.anki_mistake_id), retest_result: payload.result }, { timeoutMs: 20_000 });
  return { ok: true, mistake_id: Number(row.anki_mistake_id), repeated: !!(r && r.repeated) };
}

const SENDERS = { debrief: sendDebrief, onenote: sendOnenote, anki_link_card: sendLinkCard, anki_retest: sendRetest };
/** Every outbox kind with a sender: the import accepts exactly these (LS4-3: a lesson's anki_link_card row too). */
export const OUTBOX_KINDS = Object.keys(SENDERS);

async function sendOne(env, item) {
  const prev = safeParse(item.result_json, {}) || {};
  // A row still 'sending' was cut off mid-send: the server may have it already.
  const wasAmbiguous = !!prev.ambiguous || item.status === 'sending';
  const claimedAt = now();
  const claim = await run(env,
    "UPDATE outbox SET status = 'sending', result_json = ? WHERE id = ? AND status = ? AND attempts = ?",
    JSON.stringify({ ...prev, claimed_at: claimedAt, ambiguous: wasAmbiguous }), item.id, item.status, item.attempts);
  if (!claim.meta || !claim.meta.changes) return 'skipped';
  const payload = safeParse(item.payload_json, {});
  const sender = SENDERS[item.kind];
  try {
    if (!sender) throw new AnkiError(`Unknown outbox kind ${item.kind}.`);
    const result = await sender(env, { ...item, attempts: item.attempts }, payload, { ...prev, ambiguous: wasAmbiguous });
    if (result && result.wait) {
      // Not yet: back to pending with its attempts as they were, looked at again in an hour.
      await run(env, "UPDATE outbox SET status = 'pending', last_error = NULL, result_json = ? WHERE id = ?",
        JSON.stringify({ wait: String(result.wait).slice(0, 200), waiting_since: prev.waiting_since || claimedAt, next_at: claimedAt + WAIT_RETRY_MS, ambiguous: wasAmbiguous }), item.id);
      return 'waiting';
    }
    if (result && result.gave_up_wait) {
      await noteJob(env, { job: 'outbox', key: `${item.kind}:skip:${londonDay()}`, ref: item.kind, state: 'ok', add: true, counts: { skipped: 1 } });
    }
    await run(env, "UPDATE outbox SET status = 'done', done_at = ?, result_json = ?, last_error = NULL WHERE id = ?", now(), JSON.stringify(result), item.id);
    return 'sent';
  } catch (e) {
    const attempts = item.attempts + 1;
    const ambiguous = !!(e && e.ambiguous) || wasAmbiguous; // once in doubt, always checked before resending
    const msg = (e && e.message) || 'Sending failed.';
    await run(env, "UPDATE outbox SET status = 'failed', attempts = ?, last_error = ?, result_json = ? WHERE id = ?",
      attempts, msg.slice(0, 500), JSON.stringify({ next_at: now() + backoffMs(attempts), ambiguous }), item.id);
    // Recent activity: the day's failed sends to each place on one line (the sent ones show from the outbox itself).
    await noteJob(env, { job: 'outbox', key: `${item.kind}:${londonDay()}`, ref: item.kind, state: 'failed', add: true,
      counts: { n: 1, gave_up: attempts >= MAX_ATTEMPTS ? 1 : 0 }, detail: msg });
    return 'failed';
  }
}

export async function flushOutbox(env, { force = false, limit = 25, kinds = null } = {}) {
  const t = now();
  const only = Array.isArray(kinds) && kinds.length ? JSON.stringify(kinds) : null;
  const rows = await all(env,
    `SELECT id, kind, status, attempts, result_json, payload_json, created_at FROM outbox
     WHERE status IN ('pending', 'failed', 'sending') AND attempts < ? AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))
       AND NOT (? = 0 AND status = 'pending' AND json_extract(result_json, '$.wait') IS NOT NULL AND coalesce(json_extract(result_json, '$.next_at'), 0) > ?)
     ORDER BY created_at, id LIMIT ?`, MAX_ATTEMPTS, only, only, force ? 1 : 0, t, limit);
  const out = { sent: 0, failed: 0, waiting: 0 };
  for (const item of rows) {
    const prev = safeParse(item.result_json, {}) || {};
    if (item.status === 'sending' && t - (prev.claimed_at || 0) < SENDING_STALE_MS) { out.waiting++; continue; }
    if ((item.status === 'failed' || prev.wait) && !force && prev.next_at && prev.next_at > t) { out.waiting++; continue; }
    const r = await sendOne(env, item);
    if (r === 'sent') out.sent++;
    else if (r === 'failed') out.failed++;
    else if (r === 'waiting') out.waiting++;
  }
  return out;
}

export async function flushRoute(request, env) {
  const body = await readJson(request).catch(() => ({}));
  return json(await flushOutbox(env, { force: body.force !== false }));
}

// Status only (no payloads): ids, kind, state and the question label for the "Where this block went" panel.
export async function list(request, env, ctx, params, url) {
  const sittingId = url.searchParams.get('sitting_id') || url.searchParams.get('sitting');
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const where = sittingId ? "WHERE idem_key LIKE ? OR idem_key LIKE ?" : '';
  const args = sittingId ? [`debrief:${sittingId}:%`, `onenote:${sittingId}:%`] : [];
  const rows = await all(env,
    `SELECT id, kind, idem_key, status, attempts, last_error, created_at, done_at, json_extract(payload_json, '$.label') AS label
     FROM outbox ${where} ORDER BY created_at DESC LIMIT ?`, ...args, limit);
  return json(rows.map(r => {
    const [, sid, a, b] = r.idem_key.split(':');
    const item = { id: r.id, kind: r.kind, status: r.status, attempts: r.attempts, last_error: r.last_error, created_at: r.created_at, done_at: r.done_at, label: r.label, sitting_id: sid };
    if (r.kind === 'debrief') { item.block_id = a; item.q_index = Number(b); }
    if (r.status !== 'done' && r.attempts >= MAX_ATTEMPTS) item.gave_up = true;
    return item;
  }));
}
