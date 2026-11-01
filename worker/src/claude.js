// Claude calls (official SDK), structured JSON output, spend cap and per-call cost logging.
import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './util.js';
import { addClaudeUsage } from './db.js';
import { noteTrace } from './debug/trace.js';

export const MODELS = {
  judge: 'claude-opus-5-5',
  checker: 'claude-opus-5-5',
  mehlman: 'claude-opus-5-5',
  reader: 'claude-opus-5-5', // copies questions out of uploaded PDF pages
  labeller: 'claude-opus-5-5',
  explainer: 'claude-opus-5-5',
  summariser: 'claude-opus-5-5',
  analyst: 'claude-opus-5-5',
  reviewer: 'claude-opus-5-5',
  learner: 'claude-opus-5-5',
  asker: 'claude-opus-5-5',
  corrector: 'claude-opus-5-5',
  retester: 'claude-opus-5-5',
  patterner: 'claude-opus-5-5',
  tabler: 'claude-opus-5-5',
  examiner: 'claude-opus-5-5',
  // A picture on every topic (31 Oct 2026): when a library picture's caption only half names a topic, one short check
  // a topic says whether it shows that topic (map/auto-pictures.js). Effort low: a yes or no per caption.
  picturer: 'claude-opus-5-5',
};
// The role that streams plain text instead of answering JSON (streamText), with its fixed effort.
export const STREAM_ROLES = { explainer: 'low' };

export function assertBackground(env, role) {
  if (env && env.CONVERSATION) throw new HttpError(403, "Conversation work runs on Mo's subscription, not the API key.");
  if (!Object.prototype.hasOwnProperty.call(MODELS, role)) throw new HttpError(500, 'Unknown Claude role');
}

export const CALL_MODES = {
  judge: 'batch',
  checker: 'batch',
  mehlman: 'batch',
  reader: 'direct',
  labeller: 'batch',
  explainer: 'direct',
  summariser: 'direct',
  analyst: 'direct',       // the Library's Ask the data, answered on screen
  reviewer: 'batch',
  'reviewer:backfill': 'direct', // the root-cause back-fill (map/concept-backfill.js): the deploy script waits on each run
  learner: 'direct',
  asker: 'direct',         // Learn's Ask Claude, answered on screen
  corrector: 'batch',      // the spelling check before a batched judge or Anki check
  retester: 'batch',       // the re-test cards, written ahead of their due day
  patterner: 'batch',      // the pattern review and the profile, after each new batch of misses
  tabler: 'direct',
  examiner: 'batch',       // viva rubrics built ahead of time and the map audit's grades
  'examiner:now': 'direct',
  picturer: 'batch',       // the picture check, 3 topics a minute in the background
};
/** How one call goes: 'direct' or 'batch'. use: the caller's entry in CALL_MODES (role:use), when it has one. */
export function modeFor(env, role, use = null) {
  if (!env || env.CLAUDE_BATCH !== 'on') return 'direct';
  return (use && CALL_MODES[`${role}:${use}`]) || CALL_MODES[role] || 'direct';
}

export const LONG_CACHE = new Set(['corrector', 'patterner', 'examiner']);
export const ttlFor = (role, mode) => (mode === 'batch' || LONG_CACHE.has(role) ? '1h' : '5m');
const marker = ttl => (ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' });

/**
 * A user turn whose stable part is cached: [{text: stable, cache_control}, {text: volatile}]. callJson gives the marker
 * the request's time to live (a 1-hour entry may never follow a 5-minute one).
 */
export const cachedTurn = (stable, volatile = '') => [{ type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
  ...(volatile ? [{ type: 'text', text: volatile }] : [])];

// Every cache_control in the messages takes the request's time to live (pure; the messages are copied, never changed).
function withTtl(messages, ttl) {
  return (messages || []).map(m => (Array.isArray(m.content) && m.content.some(b => b && b.cache_control)
    ? { ...m, content: m.content.map(b => (b && b.cache_control ? { ...b, cache_control: marker(ttl) } : b)) } : m));
}

// USD per million tokens (claude-api skill, cached 2026-10-06). Cache writes are 1.25x input for the 5-minute cache and
// 2x for the 1-hour one; a Message Batch is half price on every token. Possible server-side fallback models are listed
// too, so a fallback is priced at its own rate.
const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, read: 0.20 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.20 },
  'claude-haiku-5-5': { in: 0.10, out: 0.50, read: 0.01 },
  'claude-opus-5': { in: 5, out: 25, read: 0.50 },
  'claude-opus-4-8': { in: 5, out: 25, read: 0.50 },
  'claude-sonnet-5': { in: 2, out: 10, read: 0.20 },
  'claude-sonnet-4-6': { in: 3, out: 15, read: 0.30 },
  'claude-haiku-4-5': { in: 1, out: 5, read: 0.10 },
};
export const BATCH_DISCOUNT = 0.5;

export function priceFor(model, fallbackModel) {
  const key = Object.keys(PRICES).find(k => model === k || String(model || '').startsWith(k + '-')) ||
    Object.keys(PRICES).find(k => fallbackModel === k);
  return PRICES[key] || PRICES['claude-opus-5-5'];
}

// Cache writes split by time to live when the answer says (usage.cache_creation), else all at the 5-minute rate.
const writes = u => {
  const all = Number(u.cache_creation_input_tokens) || 0;
  const h1 = Math.min(all, Number(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0);
  return { m5: all - h1, h1 };
};
const priced = (u, p) => {
  const w = writes(u);
  return ((u.input_tokens || 0) * p.in + w.m5 * p.in * 1.25 + w.h1 * p.in * 2 +
    (u.cache_read_input_tokens || 0) * p.read + (u.output_tokens || 0) * p.out) / 1e6;
};

// When a server-side fallback runs, top-level usage covers only the attempt that produced the message;
// usage.iterations lists every attempt (declined ones as 'message', the serving one as 'fallback_message'),
// each at its own model's rates. Without iterations, top-level usage is the whole call. batch: half price.
export function costUsd(usage, model, requested, { batch = false } = {}) {
  const u = usage || {};
  const its = Array.isArray(u.iterations) ? u.iterations.filter(i => i && (i.type === 'message' || i.type === 'fallback_message')) : [];
  const full = its.length ? its.reduce((t, i) => t + priced(i, priceFor(i.model || requested, requested)), 0) : priced(u, priceFor(model, requested));
  return batch ? full * BATCH_DISCOUNT : full;
}

// Token totals for the usage table, summed over iterations when there are any; write1h is the part of write on the
// 1-hour cache.
export function tokenTotals(usage) {
  const u = usage || {};
  const its = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u];
  const sum = k => its.reduce((t, i) => t + (Number(i[k]) || 0), 0);
  return { input: sum('input_tokens'), read: sum('cache_read_input_tokens'), write: sum('cache_creation_input_tokens'), output: sum('output_tokens'),
    write1h: its.reduce((t, i) => t + writes(i).h1, 0) };
}

let cached;
function client(env) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'The hub has no Anthropic key yet, so analysis cannot run.');
  const baseURL = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  if (!cached || cached.key !== env.ANTHROPIC_API_KEY || cached.baseURL !== baseURL) {
    cached = { key: env.ANTHROPIC_API_KEY, baseURL, c: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL, maxRetries: 2, timeout: 300_000 }) };
  }
  return cached.c;
}

const BETAS = ['server-side-fallback-2026-07-01'];
// Calls are not streamed: on Cloudflare the CPU spent reading thousands of stream events ran past the
// Worker's limit (error 1102, 20 Oct 2026), while waiting for one reply costs none. Ten minutes is far
// more than a call takes; the explicit timeout is also what lets the SDK send a long call unstreamed.
const CALL_TIMEOUT_MS = 600_000;

function apiError(e, role) {
  if (e instanceof Anthropic.RateLimitError) return new HttpError(503, 'Claude is busy right now. The analysis will be tried again.');
  if (e instanceof Anthropic.AuthenticationError) return new HttpError(503, 'The Anthropic key was not accepted. Check the ANTHROPIC_API_KEY secret.');
  if (e instanceof Anthropic.BadRequestError) { console.error('claude 400', role, e.message); return new HttpError(502, 'Claude could not take this request.'); }
  if (e instanceof Anthropic.APIError) { console.error('claude error', role, e.status, e.message); return new HttpError(502, 'Claude did not answer properly. Try again in a moment.'); }
  return e;
}

// One call's cost on the day's usage and its role's row, and the per-call log line (ids and numbers only, never text).
async function record(env, role, mode, message, requested) {
  const usd = costUsd(message.usage, message.model, requested, { batch: mode === 'batch' });
  const tk = tokenTotals(message.usage);
  await addClaudeUsage(env, { usd, role, mode, input: tk.input, read: tk.read, write: tk.write, write1h: tk.write1h, output: tk.output });
  noteTrace(t => t.noteClaude({ role, mode, usd, stop: message.stop_reason }));   // the request's trace (debug/trace.js): role, mode, cost
  console.log(JSON.stringify({ claude_call: role, mode, model: message.model, stop: message.stop_reason, usd: Math.round(usd * 1e5) / 1e5,
    input: tk.input, cache_read: tk.read, cache_write: tk.write, cache_write_1h: tk.write1h, output: tk.output }));
  return usd;
}

// The answer as JSON, or 422 carrying its cost (spoken.js counts it toward ANKI_DAILY_USD): trying again would spend
// the same again for nothing.
function parseAnswer(message, usd) {
  if (message.stop_reason === 'refusal') throw Object.assign(new HttpError(422, 'Claude declined to review this question.'), { usd });
  if (message.stop_reason === 'max_tokens') throw Object.assign(new HttpError(422, 'Claude ran out of room before finishing.'), { usd });
  const text = (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let data;
  try { data = JSON.parse(text); } catch { throw Object.assign(new HttpError(422, 'Claude sent back something that was not valid JSON.'), { usd }); }
  return { data, message, usd };
}

async function finish(env, role, model, message, mode = 'direct') {
  return parseAnswer(message, await record(env, role, mode, message, model));
}

/**
 * The request body of one structured-output call (pure, for the tests and the eval): the model, adaptive thinking,
 * the effort and schema, the system prompt cached (a list of texts is several blocks, stable first, each cached), and
 * every cache marker at the call's time to live (ttlFor). No fallbacks here: the direct call adds them, a batch cannot.
 */
export function jsonParams(role, { system, schema, effort, maxTokens = 64000, messages, mode = 'direct' }) {
  const model = MODELS[role];
  if (!model) throw new HttpError(500, 'Unknown Claude role');
  const ttl = ttlFor(role, mode);
  const parts = (Array.isArray(system) ? system : [system]).filter(t => t != null && t !== '');
  return {
    model, max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema } },
    system: parts.map(text => ({ type: 'text', text, cache_control: marker(ttl) })),
    ...(messages ? { messages: withTtl(messages, ttl) } : {}),
  };
}

export async function streamText(env, { role, system, messages, maxTokens = 600, onText = () => {}, signal } = {}) {
  assertBackground(env, role);
  if (!Object.prototype.hasOwnProperty.call(STREAM_ROLES, role)) throw new HttpError(500, 'Unknown Claude role');
  const model = MODELS[role];
  let message;
  try {
    const stream = client(env).beta.messages.stream({
      model, max_tokens: maxTokens, output_config: { effort: STREAM_ROLES[role] },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages, betas: BETAS, fallbacks: 'default',
    }, { timeout: 60_000, ...(signal ? { signal } : {}) });
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) onText(ev.delta.text);
    }
    message = await stream.finalMessage();
  } catch (e) { throw apiError(e, role); }
  const usd = await record(env, role, 'direct', message, model);
  const text = (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, usd, stop: message.stop_reason };
}

/**
 * One structured-output call. system: fixed text (cached with cache_control), or a list of texts, stable first.
 * messages: the turn(s). use: the caller's CALL_MODES entry (role:use) when its role is shared. Returns
 * {data, message, usd}. A direct call goes through the beta endpoint with server-side fallbacks. A batch call
 * (modeFor) is queued for the next Message Batch and throws BatchPending: the job runs again later and the same
 * request then returns the answer (isPending tells a job to wait, not to count a failure). The spend cap is checked
 * once per analysis by the caller (reserveSpend), so a call that has started always finishes. Refusal, max_tokens and
 * invalid JSON answer 422: trying again would spend the same again for nothing.
 */
export async function callJson(env, { role, system, messages, schema, effort, maxTokens = 64000, use = null }) {
  assertBackground(env, role);
  if (modeFor(env, role, use) === 'batch') {
    const got = await viaBatch(env, role, jsonParams(role, { system, schema, effort, maxTokens, messages, mode: 'batch' }));
    if (got) return got;
  }
  const params = jsonParams(role, { system, schema, effort, maxTokens, messages });
  let message;
  try {
    message = await client(env).beta.messages.create({ ...params, betas: BETAS, fallbacks: 'default' }, { timeout: CALL_TIMEOUT_MS });
  } catch (e) { throw apiError(e, role); }
  return finish(env, role, params.model, message);
}

export async function callJsonRaw(env, { role, system, schema, effort, maxTokens = 64000, contentJson }) {
  assertBackground(env, role);
  const params = jsonParams(role, { system, schema, effort, maxTokens });
  const body = JSON.stringify({ ...params, fallbacks: 'default' }).slice(0, -1) + `,"messages":[{"role":"user","content":${contentJson}}]}`;
  let message;
  try {
    message = await client(env).post('/v1/messages?beta=true', {
      body, timeout: CALL_TIMEOUT_MS, headers: { 'content-type': 'application/json', 'anthropic-beta': BETAS.join(',') },
    });
  } catch (e) { throw apiError(e, role); }
  return finish(env, role, params.model, message);
}

// ---------------------------------------------------------------- the Message Batches API (0064 claude_calls)

/** Thrown by a batch call whose answer has not come back yet: the job waits for its batch (no failure, no try used). */
export class BatchPending extends HttpError {
  constructor(id) { super(202, 'Waiting for its batch.'); this.pending = true; this.batch = true; this.call_id = id; this.usd = 0; }
}
export const isPending = e => !!(e && e.pending === true && e.batch === true);

export const BATCH = { max_requests: 200, max_bytes: 100 * 1024 * 1024, keep_ms: 7 * 86_400_000, poll_ms: 60_000 };
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const dayOf = t => new Date(t).toISOString().slice(0, 10);

/** The id of one request: the role and the SHA-256 of its body, so the same request asked again finds its answer. */
export async function callId(role, params) {
  const bytes = new TextEncoder().encode(JSON.stringify(params));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${role}-${hash}`;
}

/**
 * The batch side of callJson: the answer when it is back, BatchPending while it waits (queued now when new), or null
 * for a direct call instead (no claude_calls table yet, the batch could not be sent, errored or expired, or a refusal:
 * the direct call has the server-side fallbacks a batch cannot have). The answer's cost was counted when the batch was
 * read; the job is handed it the first time only, so its own daily counters add it once.
 */
async function viaBatch(env, role, params, now = Date.now()) {
  const id = await callId(role, params);
  let row;
  try {
    row = await env.DB.prepare(`SELECT status, result_json, usd, read_at FROM claude_calls WHERE user_id = 'mo' AND id = ?`).bind(id).first();
  } catch (e) { if (noTable(e)) return null; throw e; }
  if (!row) {
    await env.DB.prepare(`INSERT INTO claude_calls (user_id, id, role, status, params_json, created_at) VALUES ('mo', ?1, ?2, 'queued', ?3, ?4)
      ON CONFLICT (user_id, id) DO NOTHING`).bind(id, role, JSON.stringify(params), now).run();
    throw new BatchPending(id);
  }
  if (row.status === 'queued' || row.status === 'submitted') throw new BatchPending(id);
  if (row.status === 'failed') {
    await env.DB.prepare(`DELETE FROM claude_calls WHERE user_id = 'mo' AND id = ? AND status = 'failed'`).bind(id).run();
    return null;
  }
  let message;
  try { message = JSON.parse(row.result_json); } catch { message = null; }
  if (!message || message.stop_reason === 'refusal') return null;
  const usd = row.read_at ? 0 : Number(row.usd) || 0;
  if (!row.read_at) await env.DB.prepare(`UPDATE claude_calls SET read_at = ? WHERE user_id = 'mo' AND id = ?`).bind(now, id).run();
  return parseAnswer(message, usd);
}

/** The Batches API request for one queued call (pure): its body as it was queued, without fallbacks (a batch refuses them). */
export const batchRequest = (id, params) => ({ custom_id: id, params });

/**
 * The minute cron's batch step: sends the queued calls as one Message Batch, reads every batch that has ended (each
 * answer's cost at batch price on its role's row), and clears calls a week old. A batch that cannot be sent marks its
 * calls failed, so each job makes its call directly next time. One Recent activity line a day (job 'ai_batch'), and its
 * own line when sending fails. Never throws. Returns {sent, done, failed, waiting, usd}.
 */
export async function batchTick(env, { now = Date.now() } = {}) {
  const out = { sent: 0, done: 0, failed: 0, waiting: 0, usd: 0 };
  if (!env || !env.DB || !env.ANTHROPIC_API_KEY) return out;
  const { noteJob } = await import('./job-log.js');
  try {
    const queued = (await env.DB.prepare(`SELECT id, role, params_json FROM claude_calls WHERE user_id = 'mo' AND status = 'queued' ORDER BY created_at LIMIT ?`)
      .bind(BATCH.max_requests).all()).results || [];
    if (queued.length) {
      const requests = [];
      let bytes = 0;
      for (const q of queued) {
        bytes += String(q.params_json || '').length;
        if (requests.length && bytes > BATCH.max_bytes) break;
        requests.push(batchRequest(q.id, JSON.parse(q.params_json)));
      }
      const ids = requests.map(r => r.custom_id);
      try {
        const b = await client(env).messages.batches.create({ requests }, { timeout: CALL_TIMEOUT_MS });
        await env.DB.prepare(`UPDATE claude_calls SET status = 'submitted', batch_id = ?1, params_json = NULL, submitted_at = ?2
          WHERE user_id = 'mo' AND id IN (SELECT value FROM json_each(?3))`).bind(b.id, now, JSON.stringify(ids)).run();
        out.sent = ids.length;
      } catch (e) {
        const err = apiError(e, 'batch');
        await env.DB.prepare(`UPDATE claude_calls SET status = 'failed', error = ?1, params_json = NULL WHERE user_id = 'mo' AND id IN (SELECT value FROM json_each(?2))`)
          .bind(String((err && err.message) || err).slice(0, 200), JSON.stringify(ids)).run();
        out.failed += ids.length;
        await noteJob(env, { job: 'ai_batch', key: `unsent:${dayOf(now)}`, ref: 'unsent', state: 'fallback', add: true, at: now, counts: { n: ids.length }, detail: err });
      }
    }
    const open = (await env.DB.prepare(`SELECT batch_id, min(submitted_at) AS at, count(*) AS n FROM claude_calls WHERE user_id = 'mo' AND status = 'submitted'
      GROUP BY batch_id`).all()).results || [];
    for (const o of open) {
      const b = now - (Number(o.at) || 0) < BATCH.poll_ms / 2 ? null
        : await client(env).messages.batches.retrieve(o.batch_id).catch(e => { console.error('batch retrieve', o.batch_id, e && e.message); return null; });
      if (!b || b.processing_status !== 'ended') { out.waiting += Number(o.n) || 0; continue; }
      const got = await readBatch(env, o.batch_id, now);
      out.done += got.done; out.failed += got.failed; out.usd += got.usd;
    }
    await env.DB.prepare(`DELETE FROM claude_calls WHERE user_id = 'mo' AND created_at < ?`).bind(now - BATCH.keep_ms).run();
    if (out.sent || out.done || out.failed) {
      // usd is what the answers cost at batch price; the same calls direct would have cost twice that.
      await noteJob(env, { job: 'ai_batch', key: `run:${dayOf(now)}`, ref: 'run', state: 'ok', add: true, at: now,
        counts: { sent: out.sent, done: out.done, failed: out.failed, cents: Math.round(out.usd * 100) } });
    }
  } catch (e) {
    if (noTable(e)) return out;
    console.error('batch tick failed', e && e.message);
    await noteJob(env, { job: 'ai_batch', key: `error:${dayOf(now)}`, ref: 'error', state: 'failed', at: now, counts: {}, detail: e });
  }
  return out;
}

// One ended batch's results onto its calls: done with the answer (its cost recorded now, at batch price), or failed.
async function readBatch(env, batchId, now) {
  const out = { done: 0, failed: 0, usd: 0 };
  const roles = new Map(((await env.DB.prepare(`SELECT id, role FROM claude_calls WHERE user_id = 'mo' AND batch_id = ? AND status = 'submitted'`).bind(batchId).all()).results || [])
    .map(r => [r.id, r.role]));
  const stmts = [];
  for await (const r of await client(env).messages.batches.results(batchId)) {
    const role = roles.get(r.custom_id);
    if (!role) continue;
    roles.delete(r.custom_id);
    if (r.result && r.result.type === 'succeeded') {
      const m = r.result.message;
      const usd = await record(env, role, 'batch', m, MODELS[role]);
      out.usd += usd; out.done++;
      // The answer kept whole, thinking blocks too: a retry hands it back unchanged as the assistant's turn.
      const keep = { model: m.model, stop_reason: m.stop_reason, content: m.content || [], usage: m.usage };
      stmts.push(env.DB.prepare(`UPDATE claude_calls SET status = 'done', result_json = ?1, usd = ?2, done_at = ?3 WHERE user_id = 'mo' AND id = ?4`)
        .bind(JSON.stringify(keep), usd, now, r.custom_id));
    } else {
      out.failed++;
      stmts.push(env.DB.prepare(`UPDATE claude_calls SET status = 'failed', error = ?1, done_at = ?2 WHERE user_id = 'mo' AND id = ?3`)
        .bind(String((r.result && r.result.type) || 'missing'), now, r.custom_id));
    }
  }
  // A call the results left out is failed too, so its job calls directly instead of waiting for ever.
  for (const id of roles.keys()) {
    out.failed++;
    stmts.push(env.DB.prepare(`UPDATE claude_calls SET status = 'failed', error = 'missing', done_at = ?1 WHERE user_id = 'mo' AND id = ?2`).bind(now, id));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return out;
}
