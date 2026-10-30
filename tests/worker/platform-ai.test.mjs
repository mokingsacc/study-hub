// Platform AI: one interface, four providers (fakes only), sealed keys never returned, per-user caps and spend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './d1-fake.mjs';
import * as ai from '../../worker/src/platform/ai.js';
import { createAccount } from '../../worker/src/platform/auth.js';

const SECRET = 'test-platform-secret-0123456789abcdef-xyz';
const KEYS = { anthropic: 'sk-ant-api03-' + 'a'.repeat(40) + 'WXYZ', openai: 'sk-proj-' + 'b'.repeat(40) + 'OPQR', gemini: 'AIza' + 'c'.repeat(35) };

// A fake for each provider's HTTP API, recording what was sent.
function fakeFetch({ status = 200, failPing = false } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init.headers || {}, body });
    const ping = !body;
    const st = ping && failPing ? 401 : ping ? 200 : status;
    if (st !== 200) return new Response(JSON.stringify({ error: { message: 'credit balance too low' } }), { status: st });
    if (ping) return new Response('{"data":[]}', { status: 200 });
    if (url.includes('anthropic')) return Response.json({ content: [{ type: 'text', text: 'claude says {"a":1}' }], usage: { input_tokens: 1000, output_tokens: 100 } });
    if (url.includes('openai')) return Response.json({ choices: [{ message: { content: '{"a":2}' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
    if (url.includes('googleapis')) return Response.json({ candidates: [{ content: { parts: [{ text: '{"a":3}' }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } });
    return new Response('nope', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

function setup(fetchOpts) {
  const d = createD1();
  const aiRuns = [];
  const env = { ...d.env, PLATFORM_SECRET: SECRET, AI: { run: async (model, inputs) => { aiRuns.push({ model, inputs }); return { response: 'built-in answer', usage: { prompt_tokens: 1000, completion_tokens: 100 } }; } } };
  const f = fakeFetch(fetchOpts);
  const restore = ai._setIo({ fetch: f, now: () => Date.UTC(2026, 9, 25, 12) });
  return { d, env, f, aiRuns, done: () => { restore(); d.close(); } };
}

test('Workers AI is the default: no key, no setup, spend recorded per user', async () => {
  const s = setup();
  const a = await createAccount(s.env, 'mo', { name: 'Adam' });
  const r = await ai.aiCall(s.env, a.id, { task: 'test', system: 'Be brief.', prompt: 'Hello' });
  assert.equal(r.provider, 'workers_ai');
  assert.equal(r.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(r.text, 'built-in answer');
  assert.equal(s.aiRuns[0].inputs.messages[0].role, 'system');
  assert.equal(s.f.calls.length, 0, 'no outside provider was called');
  const ov = await ai.aiOverview(s.env, a.id);
  assert.equal(ov.spend.calls_today, 1);
  assert.ok(ov.spend.today_usd > 0);
  s.done();
});

test('a picture on Workers AI goes to the vision model', async () => {
  const s = setup();
  const a = await createAccount(s.env, 'mo', { name: 'Adam' });
  const r = await ai.aiCall(s.env, a.id, { task: 'screenshot', prompt: 'Read this', images: [{ mime: 'image/png', base64: btoa('png-bytes') }] });
  assert.equal(r.model, '@cf/meta/llama-3.2-11b-vision-instruct');
  assert.ok(Array.isArray(s.aiRuns[0].inputs.image));
  await assert.rejects(ai.aiCall(s.env, a.id, { prompt: 'x', images: [{ mime: 'application/pdf', base64: 'x' }] }), /PNG, JPEG/);
  s.done();
});

test('provider switch: the same call runs on Claude, OpenAI and Gemini with the user key, priced per model', async () => {
  const s = setup();
  const a = await createAccount(s.env, 'mo', { name: 'Adam' });
  for (const [provider, want] of [['anthropic', 1], ['openai', 2], ['gemini', 3]]) {
    const saved = await ai.saveKey(s.env, a.id, provider, KEYS[provider]);
    assert.equal(saved.status, 'ok');
    assert.ok(!JSON.stringify(saved).includes(KEYS[provider]), 'the key is never sent back');
    await ai.setAiSettings(s.env, a.id, { provider });
    const r = await ai.aiCall(s.env, a.id, { task: 'test', system: 'sys', prompt: 'Give JSON', json: true, images: [{ mime: 'image/jpeg', base64: 'AAAA' }] });
    assert.equal(r.provider, provider);
    assert.deepEqual(r.json, { a: want });
    assert.equal(r.model, ai.defaultModel(provider));
    const p = ai.MODELS[provider][r.model];
    assert.equal(r.usd, Math.round((1000 * p.in + 100 * p.out) / 1e6 * 10000) / 10000);
  }
  const sent = s.f.calls.filter(c => c.body);
  assert.equal(sent[0].headers['x-api-key'], KEYS.anthropic);
  assert.equal(sent[0].body.system, 'sys');
  assert.equal(sent[0].body.messages[0].content[0].type, 'image');
  assert.equal(sent[1].headers.authorization, `Bearer ${KEYS.openai}`);
  assert.equal(sent[1].body.messages[0].role, 'system');
  assert.match(sent[1].body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(sent[2].headers['x-goog-api-key'], KEYS.gemini);
  assert.equal(sent[2].body.systemInstruction.parts[0].text, 'sys');
  // Model choice
  await ai.setAiSettings(s.env, a.id, { provider: 'anthropic', model: 'claude-haiku-5-5' });
  assert.equal((await ai.aiCall(s.env, a.id, { prompt: 'x' })).model, 'claude-haiku-5-5');
  await assert.rejects(ai.setAiSettings(s.env, a.id, { model: 'gpt-5' }), /not offered/);
  s.done();
});

test('keys: sealed at rest, bound to the user, never in overview, refused when misshapen', async () => {
  const s = setup();
  const a = await createAccount(s.env, 'mo', { name: 'Adam' });
  const b = await createAccount(s.env, 'mo', { name: 'Sara' });
  await ai.saveKey(s.env, a.id, 'anthropic', KEYS.anthropic);
  const row = s.d.row('SELECT * FROM ai_keys WHERE user_id = ?', a.id);
  assert.ok(row.sealed.startsWith('v1.') && !row.sealed.includes('sk-ant'));
  assert.equal(row.hint, '…WXYZ');
  const ov = await ai.aiOverview(s.env, a.id);
  assert.ok(!JSON.stringify(ov).includes(KEYS.anthropic) && !JSON.stringify(ov).includes('v1.'));
  // A sealed key copied onto Sara's row does not open for her.
  s.d.run("INSERT INTO ai_keys (user_id, provider, sealed, hint, status, created_at, updated_at) VALUES (?, 'anthropic', ?, '…WXYZ', 'ok', 1, 1)", b.id, row.sealed);
  await ai.setAiSettings(s.env, b.id, { provider: 'anthropic' });
  await assert.rejects(ai.aiCall(s.env, b.id, { prompt: 'x' }), /could not be read/);
  await assert.rejects(ai.saveKey(s.env, a.id, 'openai', 'not a key'), /does not look like/);
  await assert.rejects(ai.setAiSettings(s.env, a.id, { provider: 'gemini' }), /Add your Gemini key first/);
  await ai.setAiSettings(s.env, a.id, { provider: 'anthropic' });
  await ai.deleteKey(s.env, a.id, 'anthropic');
  assert.equal((await ai.aiOverview(s.env, a.id)).provider, 'workers_ai', 'deleting the key in use falls back to the built-in AI');
  s.done();
});

test('a refused key is marked invalid and said plainly; a key out of credit says so', async () => {
  const s = setup({ failPing: true });
  const a = await createAccount(s.env, 'mo', { name: 'Adam' });
  assert.equal((await ai.saveKey(s.env, a.id, 'openai', KEYS.openai)).status, 'invalid');
  s.done();
  const s2 = setup({ status: 402 });
  const b = await createAccount(s2.env, 'mo', { name: 'Sara' });
  await ai.saveKey(s2.env, b.id, 'anthropic', KEYS.anthropic);
  await ai.setAiSettings(s2.env, b.id, { provider: 'anthropic' });
  const e = await ai.aiCall(s2.env, b.id, { prompt: 'x' }).catch(x => x);
  assert.match(e.message, /run out of credit/);
  assert.ok(!e.message.includes(KEYS.anthropic));
  assert.equal(s2.d.row('SELECT status FROM ai_keys WHERE user_id = ?', b.id).status, 'no_credit');
  s2.done();
});

test('spend caps: per user, daily and monthly, never above Mo\'s ceiling; one user\'s spend never stops another', async () => {
  const s = setup();
  const a = await createAccount(s.env, 'mo', { name: 'Adam' });
  const b = await createAccount(s.env, 'mo', { name: 'Sara' });
  await assert.rejects(ai.setAiSettings(s.env, a.id, { daily_cap_usd: 31 }), /most you can set is \$30/);
  await ai.setAiSettings(s.env, a.id, { daily_cap_usd: 0.001 });
  await ai.aiCall(s.env, a.id, { prompt: 'x' });   // costs about $0.0005
  await ai.aiCall(s.env, a.id, { prompt: 'x' });
  const e = await ai.aiCall(s.env, a.id, { prompt: 'x' }).catch(x => x);
  assert.equal(e.status, 429);
  assert.match(e.message, /today's AI spending limit/);
  assert.ok(await ai.aiCall(s.env, b.id, { prompt: 'x' }), "Sara is unaffected by Adam's cap");
  await ai.setAdminCap(s.env, 'mo', b.id, 0);
  assert.match((await ai.aiCall(s.env, b.id, { prompt: 'x' }).catch(x => x)).message, /spending limit/, "Mo's ceiling of 0 stops Sara at once");
  await assert.rejects(ai.setAdminCap(s.env, 'mo', b.id, 1000), /ceiling/);
  s.done();
});

test('two calls at once cannot both slip under a nearly full cap; a failed call releases its reservation', async () => {
  const s = setup();
  const a = await createAccount(s.env, 'mo', { name: 'Adam' });
  await ai.setAiSettings(s.env, a.id, { daily_cap_usd: 0.001 });
  s.d.run("INSERT INTO ai_usage (user_id, day, provider, usd, calls) VALUES (?, '2026-10-25', 'workers_ai', 0.0008, 1)", a.id);
  const both = await Promise.allSettled([ai.aiCall(s.env, a.id, { prompt: 'x' }), ai.aiCall(s.env, a.id, { prompt: 'y' })]);
  assert.ok(both.filter(r => r.status === 'fulfilled').length <= 1, 'at most one passes');
  const total = s.d.row('SELECT usd FROM ai_usage WHERE user_id = ?', a.id).usd;
  assert.ok(total < 0.0008 + 0.0011, `refused calls leave no reservation behind (${total})`);
  // A provider failure releases the reservation too.
  await ai.setAiSettings(s.env, a.id, { daily_cap_usd: 1 });
  const before = s.d.row('SELECT usd FROM ai_usage WHERE user_id = ?', a.id).usd;
  const broken = { ...s.env, AI: { run: async () => { throw new Error('down'); } } };
  await assert.rejects(ai.aiCall(broken, a.id, { prompt: 'x' }), /could not answer/);
  assert.equal(s.d.row('SELECT usd FROM ai_usage WHERE user_id = ?', a.id).usd, before);
  s.done();
});

test('at most 60 AI calls an hour per person', async () => {
  const s = setup();
  const a = await createAccount(s.env, 'mo', { name: 'Adam' });
  await ai.setAiSettings(s.env, a.id, { daily_cap_usd: 30, monthly_cap_usd: 30 });
  for (let i = 0; i < 60; i++) await ai.aiCall(s.env, a.id, { prompt: 'x', max_tokens: 16 });
  await assert.rejects(ai.aiCall(s.env, a.id, { prompt: 'x' }), /a lot of AI requests/);
  s.done();
});

test('extractJson finds JSON inside prose and fences', () => {
  assert.deepEqual(ai.extractJson('Sure! ```json\n{"x": [1,2]}\n``` hope that helps'), { x: [1, 2] });
  assert.deepEqual(ai.extractJson('[{"a":1}] trailing } brace'), [{ a: 1 }]);
  assert.equal(ai.extractJson('no json here'), null);
});

test('review fix: AI work outside aiCall (library pictures) is metered against the caps', async () => {
  const s = setup();
  const a = await createAccount(s.env, 'mo', { name: 'Adam' });
  await ai.meterFixed(s.env, a.id, { task: 'library_image', usd: 0.002 });
  assert.equal(s.d.row('SELECT usd FROM ai_usage WHERE user_id = ?', a.id).usd, 0.002);
  await ai.setAiSettings(s.env, a.id, { daily_cap_usd: 0.002 });
  await assert.rejects(ai.meterFixed(s.env, a.id, { task: 'library_image', usd: 0.002 }), e => e.status === 429);
  s.done();
});
