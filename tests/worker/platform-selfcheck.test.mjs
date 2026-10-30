// The self-check: plain words for what is wrong (AI key invalid, cap reached, nothing linked), per user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformEnv, signedIn } from './platform-helpers.mjs';
import * as ai from '../../worker/src/platform/ai.js';

test('self-check: all well on the built-in AI; then a bad key and a reached cap are said plainly', async () => {
  const { d, env } = platformEnv();
  const { c, id } = await signedIn(env, 'Adam');
  let r = await c.call('GET', '/api/p/self-check');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.summary, 'Everything is working.');
  assert.ok(r.data.items.some(i => i.id === 'ai' && /built-in AI/.test(i.says)));
  assert.ok(r.data.items.some(i => i.id === 'connector' && i.level === 'info'));

  // A key the provider refuses.
  const restore = ai._setIo({ fetch: async () => new Response('{}', { status: 401 }) });
  await ai.saveKey(env, id, 'anthropic', 'sk-ant-api03-' + 'a'.repeat(40));
  await ai.setAiSettings(env, id, { provider: 'anthropic' });
  restore();
  r = await c.call('GET', '/api/p/self-check');
  assert.equal(r.data.ok, false);
  assert.match(r.data.items[0].says, /Claude key is not valid/);
  assert.match(r.data.items[0].fix, /switch to the built-in AI/);
  assert.ok(!JSON.stringify(r.data).includes('aaaaaaaaaaaa'), 'never the key');

  // Back on the built-in AI, with today's cap spent.
  await ai.deleteKey(env, id, 'anthropic');
  await ai.setAiSettings(env, id, { daily_cap_usd: 0 });
  r = await c.call('GET', '/api/p/self-check');
  assert.equal(r.data.ok, false);
  assert.ok(r.data.items.some(i => i.id === 'spend' && i.level === 'stop' && /today's AI spending limit/.test(i.says)));

  // Another user is unaffected.
  const other = await signedIn(env, 'Sara');
  assert.equal((await other.c.call('GET', '/api/p/self-check')).data.ok, true);
  d.close();
});
