import { HttpError, now, londonDay } from '../util.js';
import { seal, open, keyHint } from './crypto.js';
import { bump, lockedFor } from './auth.js';

export const PROVIDERS = ['workers_ai', 'anthropic', 'openai', 'gemini'];
export const KEY_PROVIDERS = ['anthropic', 'openai', 'gemini'];
export const PROVIDER_NAMES = { workers_ai: 'Built-in AI', anthropic: 'Claude', openai: 'ChatGPT (OpenAI)', gemini: 'Gemini' };

// The models offered per provider, first = default. USD per million tokens (input, output); Workers AI is
// priced from Cloudflare's neuron rates, as an estimate. A model not listed here is refused.
export const MODELS = {
  workers_ai: {
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { in: 0.29, out: 2.25, label: 'Llama 3.3 70B (built in)' },
    '@cf/meta/llama-3.2-11b-vision-instruct': { in: 0.049, out: 0.68, label: 'Llama 3.2 Vision (built in)', vision: true },
  },
  anthropic: {
    'claude-sonnet-5-5': { in: 2, out: 10, label: 'Claude Sonnet 5.5', vision: true },
    'claude-haiku-5-5': { in: 0.10, out: 0.50, label: 'Claude Haiku 5.5 (cheapest)', vision: true },
    'claude-opus-5-5': { in: 4, out: 20, label: 'Claude Opus 5.5 (best, dearest)', vision: true },
  },
  openai: {
    'gpt-5-mini': { in: 0.25, out: 2, label: 'GPT-5 mini', vision: true },
    'gpt-5': { in: 1.25, out: 10, label: 'GPT-5', vision: true },
  },
  gemini: {
    'gemini-2.5-flash': { in: 0.30, out: 2.5, label: 'Gemini 2.5 Flash', vision: true },
    'gemini-2.5-pro': { in: 1.25, out: 10, label: 'Gemini 2.5 Pro', vision: true },
  },
};
export const VISION_DEFAULT = { workers_ai: '@cf/meta/llama-3.2-11b-vision-instruct' };
export const defaultModel = provider => Object.keys(MODELS[provider] || {})[0] || null;
export const HARD_CAP_USD = 100;   // no per-user cap goes above this, whoever sets it

// What a provider's key looks like (a typo check, not a validity check: checkKey asks the provider).
const KEY_SHAPES = { anthropic: /^sk-ant-[A-Za-z0-9_-]{20,200}$/, openai: /^sk-[A-Za-z0-9_-]{20,200}$/, gemini: /^[A-Za-z0-9_-]{30,60}$/ };

const aad = (user, provider) => `${user}|ai_key|${provider}`;
const secretOf = env => env.PLATFORM_SECRET;

// Swappable in tests: fetch for the three key providers, and the clock.
const io = { fetch: (...a) => fetch(...a), now: () => now() };
export function _setIo(over) {
  const prev = { ...io };
  Object.assign(io, over);
  return () => Object.assign(io, prev);
}

// ------------------------------------------------------------------ settings, keys, spend

const DEFAULT_SETTINGS = { provider: 'workers_ai', model: null, daily_cap_usd: 1, monthly_cap_usd: 10, admin_cap_usd: 30 };

export async function aiSettings(env, user) {
  const row = await env.DB.prepare('SELECT provider, model, daily_cap_usd, monthly_cap_usd, admin_cap_usd FROM ai_settings WHERE user_id = ?').bind(user).first();
  return { ...DEFAULT_SETTINGS, ...(row || {}) };
}

const monthStartDay = day => day.slice(0, 8) + '01';

export async function spend(env, user) {
  const day = londonDay(io.now());
  const r = await env.DB.prepare(
    'SELECT COALESCE(SUM(CASE WHEN day = ? THEN usd END), 0) AS today, COALESCE(SUM(usd), 0) AS month, COALESCE(SUM(CASE WHEN day = ? THEN calls END), 0) AS calls_today FROM ai_usage WHERE user_id = ? AND day >= ?')
    .bind(day, day, user, monthStartDay(day)).first();
  return { today: r ? r.today : 0, month: r ? r.month : 0, calls_today: r ? r.calls_today : 0 };
}

export function effectiveCaps(s) {
  const ceiling = Math.min(Number(s.admin_cap_usd) || 0, HARD_CAP_USD);
  return { daily: Math.min(Number(s.daily_cap_usd) || 0, ceiling), monthly: Math.min(Number(s.monthly_cap_usd) || 0, ceiling) };
}

// Plain words when a cap stops the call, else null.
export function capProblem(s, sp) {
  const caps = effectiveCaps(s);
  if (sp.today >= caps.daily) return `You have reached today's AI spending limit of $${caps.daily.toFixed(2)}. It resets at midnight, or you can raise it in Settings.`;
  if (sp.month >= caps.monthly) return `You have reached this month's AI spending limit of $${caps.monthly.toFixed(2)}. You can raise it in Settings, up to $${Math.min(Number(s.admin_cap_usd) || 0, HARD_CAP_USD).toFixed(2)}.`;
  return null;
}

// For the Settings page: never the key itself, only its hint and status.
export async function aiOverview(env, user) {
  const [s, sp, keys] = await Promise.all([
    aiSettings(env, user), spend(env, user),
    env.DB.prepare('SELECT provider, hint, status, checked_at FROM ai_keys WHERE user_id = ? ORDER BY provider').bind(user).all().then(r => r.results),
  ]);
  const caps = effectiveCaps(s);
  return {
    provider: s.provider, provider_name: PROVIDER_NAMES[s.provider], model: s.model || defaultModel(s.provider),
    caps: { daily_usd: caps.daily, monthly_usd: caps.monthly, ceiling_usd: Math.min(s.admin_cap_usd, HARD_CAP_USD) },
    spend: { today_usd: round(sp.today), month_usd: round(sp.month), calls_today: sp.calls_today },
    keys, providers: PROVIDERS.map(p => ({ id: p, name: PROVIDER_NAMES[p], needs_key: p !== 'workers_ai', models: Object.entries(MODELS[p]).map(([id, m]) => ({ id, label: m.label })) })),
  };
}

const round = n => Math.round(n * 10000) / 10000;

export async function setAiSettings(env, user, body = {}) {
  const s = await aiSettings(env, user);
  const next = { ...s };
  if ('provider' in body) {
    if (!PROVIDERS.includes(body.provider)) throw new HttpError(400, 'Please pick one of the listed AI providers.');
    if (body.provider !== 'workers_ai') {
      const k = await env.DB.prepare('SELECT status FROM ai_keys WHERE user_id = ? AND provider = ?').bind(user, body.provider).first();
      if (!k) throw new HttpError(400, `Add your ${PROVIDER_NAMES[body.provider]} key first.`);
    }
    if (body.provider !== s.provider) next.model = null;
    next.provider = body.provider;
  }
  if ('model' in body && body.model != null) {
    if (!MODELS[next.provider][body.model]) throw new HttpError(400, 'That model is not offered for this provider.');
    next.model = body.model;
  }
  for (const k of ['daily_cap_usd', 'monthly_cap_usd']) {
    if (!(k in body)) continue;
    const v = Number(body[k]);
    if (!(v >= 0)) throw new HttpError(400, 'A spending limit must be 0 dollars or more.');
    const ceiling = Math.min(s.admin_cap_usd, HARD_CAP_USD);
    if (v > ceiling) throw new HttpError(400, `The most you can set is $${ceiling.toFixed(2)}. Ask Mo to raise it.`);
    next[k] = v;
  }
  await env.DB.prepare(
    `INSERT INTO ai_settings (user_id, provider, model, daily_cap_usd, monthly_cap_usd, admin_cap_usd, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, daily_cap_usd = excluded.daily_cap_usd,
       monthly_cap_usd = excluded.monthly_cap_usd, updated_at = excluded.updated_at`)
    .bind(user, next.provider, next.model, next.daily_cap_usd, next.monthly_cap_usd, s.admin_cap_usd, io.now()).run();
  return aiOverview(env, user);
}

export async function setAdminCap(env, admin, user, usd) {
  const v = Number(usd);
  if (!(v >= 0) || v > HARD_CAP_USD) throw new HttpError(400, `The ceiling must be from $0 to $${HARD_CAP_USD}.`);
  await env.DB.prepare(
    `INSERT INTO ai_settings (user_id, admin_cap_usd, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET admin_cap_usd = excluded.admin_cap_usd, updated_at = excluded.updated_at`).bind(user, v, io.now()).run();
  return { user, admin_cap_usd: v };
}

export async function saveKey(env, user, provider, key) {
  if (!KEY_PROVIDERS.includes(provider)) throw new HttpError(400, 'Keys can be added for Claude, OpenAI or Gemini.');
  const k = String(key || '').trim();
  if (!KEY_SHAPES[provider].test(k)) throw new HttpError(400, `That does not look like a ${PROVIDER_NAMES[provider]} key. Copy it again from the provider's website.`);
  const t = io.now();
  const sealed = await seal(secretOf(env), k, aad(user, provider));
  await env.DB.prepare(
    `INSERT INTO ai_keys (user_id, provider, sealed, hint, status, checked_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'unchecked', NULL, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET sealed = excluded.sealed, hint = excluded.hint, status = 'unchecked', checked_at = NULL, updated_at = excluded.updated_at`)
    .bind(user, provider, sealed, keyHint(k), t, t).run();
  const status = await checkKey(env, user, provider);
  return { provider, hint: keyHint(k), status };
}

export async function deleteKey(env, user, provider) {
  if (!KEY_PROVIDERS.includes(provider)) throw new HttpError(400, 'Unknown provider.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ai_keys WHERE user_id = ? AND provider = ?').bind(user, provider),
    // Back to the built-in AI if that key was in use.
    env.DB.prepare("UPDATE ai_settings SET provider = 'workers_ai', model = NULL, updated_at = ? WHERE user_id = ? AND provider = ?").bind(io.now(), user, provider),
  ]);
  return { ok: true };
}

async function openKey(env, user, provider) {
  const row = await env.DB.prepare('SELECT sealed, status FROM ai_keys WHERE user_id = ? AND provider = ?').bind(user, provider).first();
  if (!row) return { key: null, status: 'missing' };
  const key = await open(secretOf(env), row.sealed, aad(user, provider));
  return { key, status: key ? row.status : 'unreadable' };
}

// Asks the provider whether the key works (a free model list call). Stores and returns ok | invalid | no_credit.
export async function checkKey(env, user, provider) {
  const { key } = await openKey(env, user, provider);
  if (!key) return 'invalid';
  let status;
  try {
    const res = await io.fetch(...ADAPTERS[provider].ping(key));
    status = res.ok ? 'ok' : res.status === 401 || res.status === 403 || res.status === 400 ? 'invalid' : res.status === 402 || res.status === 429 ? 'no_credit' : 'unchecked';
  } catch {
    status = 'unchecked';   // the provider could not be reached: say nothing about the key
  }
  await env.DB.prepare('UPDATE ai_keys SET status = ?, checked_at = ? WHERE user_id = ? AND provider = ?').bind(status, io.now(), user, provider).run();
  return status;
}

// Adds to the day's spend. calls is 1 when a call is settled, 0 for a reservation or its release.
async function recordSpend(env, user, provider, usd, usage, calls = 1, day = londonDay(io.now())) {
  await env.DB.prepare(
    `INSERT INTO ai_usage (user_id, day, provider, usd, calls, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, day, provider) DO UPDATE SET usd = MAX(0, ai_usage.usd + excluded.usd), calls = ai_usage.calls + excluded.calls,
       input_tokens = ai_usage.input_tokens + excluded.input_tokens, output_tokens = ai_usage.output_tokens + excluded.output_tokens`)
    .bind(user, day, provider, usd, calls, usage.input || 0, usage.output || 0).run();
}

// At most this many AI calls an hour per person, whoever pays (stops a stuck page or script spending in a loop).
export const AI_RATE = { limit: 60, windowMs: 3_600_000, lockMs: 15 * 60_000 };

// Workers AI work that does not go through aiCall (the library's image-to-text conversion): the same hourly
// limit and caps, and a fixed estimated cost recorded against the person. Throws HttpError(429) in plain words.
export async function meterFixed(env, user, { task, usd }) {
  const t = io.now();
  const s = await aiSettings(env, user);
  if (await lockedFor(env, user, 'ai', t) || !(await bump(env, user, 'ai', AI_RATE, t))) throw new HttpError(429, 'That is a lot of AI requests in one hour. Please wait a few minutes and try again.');
  const cap = capProblem(s, await spend(env, user));
  if (cap) throw new HttpError(429, cap);
  await recordSpend(env, user, 'workers_ai', Number(usd) || 0, {}, 1, londonDay(t));
  return { task, usd };
}

// ------------------------------------------------------------------ adapters

// Each adapter: build(key, model, req) -> [url, init]; parse(json) -> {text, usage: {input, output}}; ping(key) -> [url, init].
// req: {system, messages: [{role: 'user'|'assistant', content: string}], images: [{mime, base64}] (on the last
// user message), max_tokens, json: bool}.
const lastUserIdx = msgs => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return i; return -1; };

const ADAPTERS = {
  anthropic: {
    build(key, model, r) {
      const li = lastUserIdx(r.messages);
      const messages = r.messages.map((m, i) => ({
        role: m.role,
        content: i === li && r.images.length
          ? [...r.images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.base64 } })), { type: 'text', text: m.content }]
          : m.content,
      }));
      return ['https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: r.max_tokens, ...(r.system ? { system: r.system } : {}), messages }) }];
    },
    parse: j => ({ text: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), usage: { input: j.usage?.input_tokens || 0, output: j.usage?.output_tokens || 0 } }),
    ping: key => ['https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }],
  },
  openai: {
    build(key, model, r) {
      const li = lastUserIdx(r.messages);
      const messages = [...(r.system ? [{ role: 'system', content: r.system }] : []), ...r.messages.map((m, i) => ({
        role: m.role,
        content: i === li && r.images.length
          ? [{ type: 'text', text: m.content }, ...r.images.map(im => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.base64}` } }))]
          : m.content,
      }))];
      return ['https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_completion_tokens: r.max_tokens, messages, ...(r.json ? { response_format: { type: 'json_object' } } : {}) }) }];
    },
    parse: j => ({ text: j.choices?.[0]?.message?.content || '', usage: { input: j.usage?.prompt_tokens || 0, output: j.usage?.completion_tokens || 0 } }),
    ping: key => ['https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } }],
  },
  gemini: {
    build(key, model, r) {
      const li = lastUserIdx(r.messages);
      const contents = r.messages.map((m, i) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }, ...(i === li ? r.images.map(im => ({ inline_data: { mime_type: im.mime, data: im.base64 } })) : [])],
      }));
      return [`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ contents, ...(r.system ? { systemInstruction: { parts: [{ text: r.system }] } } : {}),
          generationConfig: { maxOutputTokens: r.max_tokens, ...(r.json ? { responseMimeType: 'application/json' } : {}) } }) }];
    },
    parse: j => ({ text: (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''), usage: { input: j.usageMetadata?.promptTokenCount || 0, output: j.usageMetadata?.candidatesTokenCount || 0 } }),
    ping: key => ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key } }],
  },
};

async function runWorkersAi(env, model, r) {
  if (!env.AI || typeof env.AI.run !== 'function') throw new HttpError(503, 'The built-in AI is not available right now. Please try again later.');
  const messages = [...(r.system ? [{ role: 'system', content: r.system }] : []), ...r.messages];
  const inputs = { messages, max_tokens: r.max_tokens };
  // The vision model takes one image as a byte list beside the messages.
  if (r.images.length) inputs.image = [...Uint8Array.from(atob(r.images[0].base64), c => c.charCodeAt(0))];
  const out = await env.AI.run(model, inputs);
  const text = typeof out === 'string' ? out : out && typeof out.response === 'string' ? out.response : out && out.response != null ? JSON.stringify(out.response) : '';
  const u = (out && out.usage) || {};
  return { text, usage: { input: u.prompt_tokens || estTokens(messages.map(m => m.content).join(' ')), output: u.completion_tokens || estTokens(text) } };
}

const estTokens = s => Math.ceil(String(s || '').length / 4);

// ------------------------------------------------------------------ the one entry point

const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 7_000_000;   // about 5 MB of image

function normalise(req) {
  const messages = Array.isArray(req.messages) ? req.messages : [{ role: 'user', content: String(req.prompt || '') }];
  if (!messages.length || messages.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) throw new HttpError(400, 'The AI request was not valid.');
  const images = Array.isArray(req.images) ? req.images : [];
  if (images.length > MAX_IMAGES) throw new HttpError(400, `At most ${MAX_IMAGES} pictures at once.`);
  for (const im of images) {
    if (!im || !/^image\/(png|jpeg|webp|gif)$/.test(im.mime) || typeof im.base64 !== 'string' || im.base64.length > MAX_IMAGE_B64) throw new HttpError(400, 'Pictures must be PNG, JPEG, WebP or GIF, up to about 5 MB.');
  }
  return { system: req.system ? String(req.system) : '', messages, images, max_tokens: Math.min(Math.max(Number(req.max_tokens) || 1024, 16), 8192), json: !!req.json };
}

// Pull the first JSON object or list out of a model's reply (models wrap JSON in prose or fences).
export function extractJson(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const open1 = s[start], close1 = open1 === '{' ? '}' : ']';
  for (let end = s.lastIndexOf(close1); end > start; end = s.lastIndexOf(close1, end - 1)) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* try a shorter span */ }
  }
  return null;
}


async function runProvider(env, user, provider, model, r, task) {
  if (provider === 'workers_ai') {
    try { return await runWorkersAi(env, model, r); } catch (e) {
      if (e instanceof HttpError) throw e;
      console.error('workers ai failed', task, e && e.message);
      throw new HttpError(502, 'The built-in AI could not answer just now. Please try again in a minute.');
    }
  } else {
    const { key, status } = await openKey(env, user, provider);
    if (!key) throw new HttpError(400, status === 'missing' ? `Add your ${PROVIDER_NAMES[provider]} key in Settings, or switch to the built-in AI.` : `Your ${PROVIDER_NAMES[provider]} key could not be read. Please add it again in Settings.`);
    let res;
    try { res = await io.fetch(...ADAPTERS[provider].build(key, model, r)); } catch {
      throw new HttpError(502, `${PROVIDER_NAMES[provider]} could not be reached. Please try again in a minute.`);
    }
    if (!res.ok) {
      const bad = res.status === 401 || res.status === 403 ? 'invalid' : res.status === 402 || (res.status === 429 && /quota|credit|billing/i.test(await res.clone().text().catch(() => ''))) ? 'no_credit' : null;
      if (bad) await env.DB.prepare('UPDATE ai_keys SET status = ?, checked_at = ? WHERE user_id = ? AND provider = ?').bind(bad, io.now(), user, provider).run();
      throw new HttpError(502, bad === 'invalid' ? `Your ${PROVIDER_NAMES[provider]} key was refused. Check it in Settings, or switch to the built-in AI.`
        : bad === 'no_credit' ? `Your ${PROVIDER_NAMES[provider]} account has run out of credit. Top it up, or switch to the built-in AI.`
          : `${PROVIDER_NAMES[provider]} could not answer just now (error ${res.status}). Please try again in a minute.`);
    }
    return ADAPTERS[provider].parse(await res.json());
  }
}

/**
 * aiCall(env, user, {task, system?, messages? | prompt, images?, max_tokens?, json?, provider?, model?})
 *   -> {text, json?, provider, model, usd, usage}
 * task names the feature for logs ('topics', 'screenshot', 'tutor', ...). provider/model override the user's
 * choice for one call (a feature that needs vision on Workers AI). Throws HttpError with plain words for a
 * missing or broken key, a reached cap or a provider failure; the key never appears in an error.
 */
export async function aiCall(env, user, req = {}) {
  const r = normalise(req);
  const s = await aiSettings(env, user);
  const provider = req.provider || s.provider;
  if (!PROVIDERS.includes(provider)) throw new HttpError(400, 'Unknown AI provider.');
  let model = req.model || (provider === s.provider ? s.model : null) || defaultModel(provider);
  if (r.images.length && provider === 'workers_ai' && !MODELS.workers_ai[model].vision) model = VISION_DEFAULT.workers_ai;
  const price = MODELS[provider][model];
  if (!price) throw new HttpError(400, 'That AI model is not offered.');
  const t = io.now();
  const wait = await lockedFor(env, user, 'ai', t);
  if (wait || !(await bump(env, user, 'ai', AI_RATE, t))) throw new HttpError(429, 'That is a lot of AI requests in one hour. Please wait a few minutes and try again.');
  const sp = await spend(env, user);
  const cap = capProblem(s, sp);
  if (cap) throw new HttpError(429, cap);
  // Reserve the most this call could cost, then check again: two calls at once cannot both slip under a
  // nearly full cap (each sees the other's reservation). Settled to the real cost afterwards.
  const day = londonDay(t);
  const reserve = (estTokens([r.system, ...r.messages.map(m => m.content)].join(' ')) * price.in + (r.images.length * 1600) * price.in + r.max_tokens * price.out) / 1e6;
  await recordSpend(env, user, provider, reserve, {}, 0, day);
  const after = await spend(env, user);
  const raced = capProblem(s, { today: after.today - reserve, month: after.month - reserve });
  if (raced) {
    await recordSpend(env, user, provider, -reserve, {}, 0, day);
    throw new HttpError(429, raced);
  }

  let out;
  try {
    out = await runProvider(env, user, provider, model, r, req.task);
  } catch (e) {
    await recordSpend(env, user, provider, -reserve, {}, 0, day).catch(() => {});
    throw e;
  }
  const usd = (out.usage.input * price.in + out.usage.output * price.out) / 1e6;
  await recordSpend(env, user, provider, usd - reserve, out.usage, 1, day);
  const result = { text: out.text, provider, model, usd: round(usd), usage: out.usage };
  if (r.json) result.json = extractJson(out.text);
  return result;
}
