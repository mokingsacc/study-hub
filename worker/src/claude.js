// Claude calls (official SDK), structured JSON output, spend cap and per-call cost logging.
import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './util.js';
import { addUsage } from './db.js';

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
};
// The role that streams plain text instead of answering JSON (streamText), with its fixed effort.
export const STREAM_ROLES = { explainer: 'low' };

export function assertBackground(env, role) {
  if (env && env.CONVERSATION) throw new HttpError(403, "Conversation work runs on Mo's subscription, not the API key.");
  if (!Object.prototype.hasOwnProperty.call(MODELS, role)) throw new HttpError(500, 'Unknown Claude role');
}

// USD per million tokens (claude-api skill, cached 2026-10-06). Cache writes are 1.25x input (5-minute TTL).
// Possible server-side fallback models are listed too, so a fallback is priced at its own rate.
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

export function priceFor(model, fallbackModel) {
  const key = Object.keys(PRICES).find(k => model === k || String(model || '').startsWith(k + '-')) ||
    Object.keys(PRICES).find(k => fallbackModel === k);
  return PRICES[key] || PRICES['claude-opus-5-5'];
}

const priced = (u, p) => ((u.input_tokens || 0) * p.in + (u.cache_creation_input_tokens || 0) * p.in * 1.25 +
  (u.cache_read_input_tokens || 0) * p.read + (u.output_tokens || 0) * p.out) / 1e6;

// When a server-side fallback runs, top-level usage covers only the attempt that produced the message;
// usage.iterations lists every attempt (declined ones as 'message', the serving one as 'fallback_message'),
// each at its own model's rates. Without iterations, top-level usage is the whole call.
export function costUsd(usage, model, requested) {
  const u = usage || {};
  const its = Array.isArray(u.iterations) ? u.iterations.filter(i => i && (i.type === 'message' || i.type === 'fallback_message')) : [];
  if (its.length) return its.reduce((t, i) => t + priced(i, priceFor(i.model || requested, requested)), 0);
  return priced(u, priceFor(model, requested));
}

// Token totals for the usage table, summed over iterations when there are any.
export function tokenTotals(usage) {
  const u = usage || {};
  const its = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u];
  const sum = k => its.reduce((t, i) => t + (Number(i[k]) || 0), 0);
  return { input: sum('input_tokens'), read: sum('cache_read_input_tokens'), write: sum('cache_creation_input_tokens'), output: sum('output_tokens') };
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

async function finish(env, role, model, message) {
  const usd = costUsd(message.usage, message.model, model);
  const tk = tokenTotals(message.usage);
  await addUsage(env, { usd, calls: 1, input: tk.input + tk.read + tk.write, output: tk.output });
  // Per-call cost log: ids and numbers only, never question text.
  console.log(JSON.stringify({ claude_call: role, model: message.model, stop: message.stop_reason, usd: Math.round(usd * 1e5) / 1e5,
    input: tk.input, cache_read: tk.read, cache_write: tk.write, output: tk.output }));
  // A call Claude answered but that still fails carries its cost, so spoken.js can count it toward ANKI_DAILY_USD.
  if (message.stop_reason === 'refusal') throw Object.assign(new HttpError(422, 'Claude declined to review this question.'), { usd });
  if (message.stop_reason === 'max_tokens') throw Object.assign(new HttpError(422, 'Claude ran out of room before finishing.'), { usd });
  const text = (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let data;
  try { data = JSON.parse(text); } catch { throw Object.assign(new HttpError(422, 'Claude sent back something that was not valid JSON.'), { usd }); }
  return { data, message, usd };
}

const head = (role, { system, schema, effort, maxTokens }) => ({
  model: MODELS[role] || (() => { throw new HttpError(500, 'Unknown Claude role'); })(),
  max_tokens: maxTokens,
  thinking: { type: 'adaptive' },
  output_config: { effort, format: { type: 'json_schema', schema } },
  system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
});

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
  const usd = costUsd(message.usage, message.model, model);
  const tk = tokenTotals(message.usage);
  await addUsage(env, { usd, calls: 1, input: tk.input + tk.read + tk.write, output: tk.output });
  console.log(JSON.stringify({ claude_call: role, model: message.model, stop: message.stop_reason, usd: Math.round(usd * 1e5) / 1e5,
    input: tk.input, cache_read: tk.read, cache_write: tk.write, output: tk.output }));
  const text = (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, usd, stop: message.stop_reason };
}

/**
 * One structured-output call. system: fixed text (cached with cache_control). messages: the turn(s).
 * Returns {data, message, usd}. Every call goes through the beta endpoint with server-side fallbacks.
 * The spend cap is checked once per analysis by the caller (reserveSpend), so a call that has started
 * always finishes. Refusal, max_tokens and invalid JSON answer 422: trying again would spend the same
 * again for nothing.
 */
export async function callJson(env, { role, system, messages, schema, effort, maxTokens = 64000 }) {
  assertBackground(env, role);
  const params = { ...head(role, { system, schema, effort, maxTokens }), messages };
  let message;
  try {
    message = await client(env).beta.messages.create({ ...params, betas: BETAS, fallbacks: 'default' }, { timeout: CALL_TIMEOUT_MS });
  } catch (e) { throw apiError(e, role); }
  return finish(env, role, params.model, message);
}

/**
 * callJson for a large user turn sent as JSON text (the PDF reader's page pictures). contentJson must be a
 * JSON array of content blocks that the caller has already checked; it goes into the request body as it is,
 * so the Worker never re-encodes megabytes of pictures.
 */
export async function callJsonRaw(env, { role, system, schema, effort, maxTokens = 64000, contentJson }) {
  assertBackground(env, role);
  const params = head(role, { system, schema, effort, maxTokens });
  const body = JSON.stringify({ ...params, fallbacks: 'default' }).slice(0, -1) + `,"messages":[{"role":"user","content":${contentJson}}]}`;
  let message;
  try {
    message = await client(env).post('/v1/messages?beta=true', {
      body, timeout: CALL_TIMEOUT_MS, headers: { 'content-type': 'application/json', 'anthropic-beta': BETAS.join(',') },
    });
  } catch (e) { throw apiError(e, role); }
  return finish(env, role, params.model, message);
}
