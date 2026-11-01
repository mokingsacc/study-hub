import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlatformCron } from '../../worker/src/platform/cron.js';
import { BUDGET_USED } from '../../worker/src/map/d1-count.js';
import { createD1 } from './d1-fake.mjs';

test('every job of the minute shares one budget: the minute stops at D1_QUERY_BUDGET, never past it', async () => {
  const d = createD1({ migrations: false });
  let queries = 0, refused = 0;
  const greedy = async env => { for (let i = 0; i < 100; i++) { try { await env.DB.prepare('SELECT 1').first(); queries++; } catch (e) { assert.equal(e.message, BUDGET_USED); refused++; return; } } };
  const waits = [];
  // minute 7: map, housekeeping, purge and library all run
  const names = runPlatformCron({ scheduledTime: Date.UTC(2026, 10, 1, 10, 7) }, { ...d.env, D1_QUERY_BUDGET: '45' }, { waitUntil: p => waits.push(p) },
    { map: greedy, housekeeping: greedy, purge: greedy, library: greedy });
  await Promise.all(waits);
  assert.equal(names.length, 4);
  assert.equal(queries, 45, 'the four jobs together stop at the budget');
  assert.equal(refused, 4, 'each job is told the budget is used up');
  d.close();
});
