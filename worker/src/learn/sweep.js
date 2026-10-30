// Learn's writer and its living updates (I29).
//
//   writeLearn(env, user, topicId, {trigger, call?})  one learner call writes the topic's summary and all its look-alike
//       cards: context, the citation drop, the leak guard (one retry with the breaches, then the breaking fields are
//       dropped), then one batch with the day's Learn spend. trigger: open | update | sweep | fill.
//   sweepLearn(env, user, {fill?, now?, call?})  the minute dispatcher's job (and POST /api/learn/sweep): up to 3 stale
//       topics, weakest first. Stale = fail-side evidence newer than the summary's ev_mark, the newest of it at
//       least 20 minutes old (a block's misses batch together), and the summary over 12 hours old unless 2 or more
//       new misses came. fill (go-live): weak and very weak topics with no summary yet, weakest first, on the fill
//       budget instead of the daily one.
// Spend: LEARN_DAILY_USD a London day (settings learn_usd:<day>, as the Anki checks keep anki_usd), the fill budget
// (settings learn_fill_usd), and every call through reserveSpend under the hub's daily and monthly caps.
import { HttpError, londonDay } from '../util.js';
import { reserveSpend, spendCap, getSetting } from '../db.js';
import { callJson, MODELS } from '../claude.js';
import { readTopic, gatherContext, FAIL_SQL } from './context.js';
import { LEARN_SYSTEM, LEARN_SCHEMA, learnPrompt } from './prompt.js';
import { shapeAnswer, checkAnswer, dropFields, saveStatements } from './store.js';

export const ROLE = 'learner';
export const LEARN_DAILY_USD = 5, FILL_USD = 25, RESERVE_USD = 0.3;
export const SETTLE_MS = 20 * 60_000, MIN_GAP_MS = 12 * 3600_000, SWEEP_MAX = 3, LOCK_MS = 10 * 60_000;
const FILL_KEY = 'learn_fill_usd';
const dayKey = (now = Date.now()) => `learn_usd:${londonDay(now)}`;
const TRIGGER_WORDS = { open: 'First summary', update: 'after you asked for an update', sweep: 'after new misses or gaps', fill: 'First summary' };

// The Learn budget (the day's, or the fill's) is reserved before every call, only while it stays under its ceiling,
// then settled to the call's real cost, so calls running side by side can never pass it together.
async function reserveLearn(env, key, cap) {
  const r = await env.DB.prepare(`INSERT INTO settings (key, value) SELECT ?1, CAST(?2 AS TEXT) WHERE ?2 <= ?3
    ON CONFLICT(key) DO UPDATE SET value = CAST(ROUND(CAST(settings.value AS REAL) + ?2, 6) AS TEXT) WHERE CAST(settings.value AS REAL) + ?2 <= ?3`)
    .bind(key, RESERVE_USD, cap).run();
  return !!(r.meta && r.meta.changes);
}
const settleLearn = (env, key, usd) => env.DB.prepare(`UPDATE settings SET value = CAST(ROUND(MAX(0, CAST(value AS REAL) + ?2), 6) AS TEXT) WHERE key = ?1`)
  .bind(key, (Number(usd) || 0) - RESERVE_USD).run();

/** Is there room under the day's Learn ceiling (or the fill budget)? */
export async function learnRoom(env, { fill = false, now = Date.now() } = {}) {
  const spent = Number(await getSetting(env, fill ? FILL_KEY : dayKey(now))) || 0;
  return spent + RESERVE_USD <= (fill ? FILL_USD : LEARN_DAILY_USD);
}

async function ask(env, call, messages, { fill, now }) {
  const key = fill ? FILL_KEY : dayKey(now);
  if (!(await reserveLearn(env, key, fill ? FILL_USD : LEARN_DAILY_USD))) {
    throw new HttpError(429, fill ? 'The first fill has spent its budget.' : "Today's Learn budget is spent. It starts again tomorrow.");
  }
  const req = { system: LEARN_SYSTEM, schema: LEARN_SCHEMA, effort: 'high', maxTokens: 32000, messages };
  let res;
  try {
    if (call) res = await call({ role: ROLE, ...req });
    else {
      const release = await reserveSpend(env, RESERVE_USD, await spendCap(env));   // 429 past the hub's day or month cap
      try { res = await callJson(env, { role: 'learner', ...req }); } finally { await release(0); }   // callJson counted the real cost
    }
  } catch (e) {
    await settleLearn(env, key, Number(e && e.usd) || 0);   // a call that failed after Claude answered still cost money
    throw e;
  }
  await settleLearn(env, key, res.usd);
  return res;
}

// One write per topic at a time (MAJOR, stage 1 check): in this isolate the second caller shares the first's
// promise; across isolates a sync_state lock 'learn.write:<topic>' makes it wait for the first to finish and then
// read what it wrote. Either way Claude is asked once.
const inflight = new Map();
export const WAIT_MS = 150_000, POLL_MS = 1_000;

export function writeLearn(env, user, topicId, opts = {}) {
  const key = `${user}|${topicId}`;
  if (inflight.has(key)) return inflight.get(key).then(r => (r ? { ...r, usd: 0, shared: true } : r));
  const p = writeLocked(env, user, topicId, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function writeLocked(env, user, topicId, opts) {
  const now = Date.now(), source = `learn.write:${topicId}`;
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [, claim] = await env.DB.batch([
    q('INSERT INTO sync_state (user_id, source, fails, lock_until) VALUES (?, ?, 0, 0) ON CONFLICT(user_id, source) DO NOTHING', user, source),
    q('UPDATE sync_state SET lock_until = ? WHERE user_id = ? AND source = ? AND lock_until < ? RETURNING source', now + WAIT_MS + 60_000, user, source, now),
  ]);
  if (!(claim.results || []).length) {
    // Another isolate is writing it: wait until its lock goes, then the caller reads the summary it wrote.
    const until = Date.now() + (opts.waitMs ?? WAIT_MS);
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, opts.pollMs ?? POLL_MS));
      const row = await q('SELECT lock_until FROM sync_state WHERE user_id = ? AND source = ?', user, source).first();
      if (!row || Number(row.lock_until) < Date.now()) return { topic_id: topicId, usd: 0, shared: true };
    }
    throw new HttpError(409, 'Learn is still writing this topic. Try again in a moment.');
  }
  try { return await writeOnce(env, user, topicId, opts); } finally {
    await q('DELETE FROM sync_state WHERE user_id = ? AND source = ?', user, source).run();
  }
}

async function writeOnce(env, user, topicId, { trigger = 'open', call = null, now = Date.now() } = {}) {
  const t = await readTopic(env, user, topicId);
  if (!t) return null;
  const { ctx, allowed, leakIndex } = await gatherContext(env, user, t);
  let usd = 0;
  const fill = trigger === 'fill', budget = { fill, now };
  const first = await ask(env, call, [{ role: 'user', content: learnPrompt(ctx) }], budget);
  usd += Number(first.usd) || 0;
  let answer = shapeAnswer(first.data, allowed);
  const errors = checkAnswer(answer, leakIndex);
  if (errors.length) {
    const again = await ask(env, call, [{ role: 'user', content: learnPrompt(ctx, errors.slice(0, 20)) }], budget);
    usd += Number(again.usd) || 0;
    answer = shapeAnswer(again.data, allowed);
  }
  answer = dropFields(answer, leakIndex);
  await env.DB.batch(saveStatements(env, user, t, answer, { evMark: t.ev, trigger, model: MODELS[ROLE], usd, now, cardNote: TRIGGER_WORDS[trigger] || null }));
  return { topic_id: topicId, usd, retried: errors.length > 0 };
}

/** Topics due an update, weakest first: [{topic_id}] (fill: weak and very weak topics with no summary). */
export async function staleTopics(env, user, { fill = false, now = Date.now(), limit = SWEEP_MAX } = {}) {
  if (fill) {
    return (await env.DB.prepare(`SELECT s.topic_id FROM topic_scores s JOIN topics t ON t.user_id = s.user_id AND t.id = s.topic_id
      WHERE s.user_id = ? AND s.band IN ('weak', 'very_weak') AND t.status IN ('proposed', 'confirmed')
        AND NOT EXISTS (SELECT 1 FROM learn_summaries l WHERE l.user_id = s.user_id AND l.topic_id = s.topic_id)
      ORDER BY s.t DESC LIMIT ?`).bind(user, limit).all()).results || [];
  }
  return (await env.DB.prepare(`SELECT l.topic_id FROM learn_summaries l
      JOIN evidence e ON e.user_id = l.user_id AND e.topic_id = l.topic_id AND e.at > l.ev_mark AND ${FAIL_SQL.replace(/\b(held|kind|result|verdict)\b/g, 'e.$1')}
      LEFT JOIN topic_scores s ON s.user_id = l.user_id AND s.topic_id = l.topic_id
    WHERE l.user_id = ?1
    GROUP BY l.topic_id
    HAVING max(e.at) <= ?2 AND (max(l.updated_at) <= ?3
      OR sum(CASE WHEN e.kind IN ('question', 'retest') AND e.result IN ('wrong', 'omitted', 'missed') THEN 1 ELSE 0 END) >= 2)
    ORDER BY max(coalesce(s.t, 0)) DESC LIMIT ?4`).bind(user, now - SETTLE_MS, now - MIN_GAP_MS, limit).all()).results || [];
}

export async function sweepLearn(env, user, { fill = false, now = Date.now(), call = null } = {}) {
  if (env.LEARN !== 'on' && !call) return { skipped: 'Learn is off' };
  const source = fill ? 'learn.fill' : 'learn.sweep';
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  // Single flight: one sweep at a time per user (sync_state bookkeeping).
  const [, claim] = await env.DB.batch([
    q('INSERT INTO sync_state (user_id, source, fails, lock_until) VALUES (?, ?, 0, 0) ON CONFLICT(user_id, source) DO NOTHING', user, source),
    q('UPDATE sync_state SET lock_until = ? WHERE user_id = ? AND source = ? AND lock_until < ? RETURNING source', now + LOCK_MS, user, source, now),
  ]);
  if (!(claim.results || []).length) return { skipped: 'already running' };
  const done = [], failed = [];
  try {
    if (!(await learnRoom(env, { fill, now }))) return { skipped: fill ? 'fill budget spent' : "today's Learn budget spent" };
    const topics = await staleTopics(env, user, { fill, now });
    const res = await Promise.allSettled(topics.map(x => writeLearn(env, user, x.topic_id, { trigger: fill ? 'fill' : 'sweep', call, now })));
    res.forEach((r, i) => (r.status === 'fulfilled' ? done : failed).push(topics[i].topic_id));
    for (const r of res) if (r.status === 'rejected') console.error('learn sweep: a topic failed', r.reason && r.reason.message);
    return { updated: done, failed };
  } finally {
    await q('UPDATE sync_state SET lock_until = 0, last_ok_at = ? WHERE user_id = ? AND source = ?', Date.now(), user, source).run();
  }
}

/** Throws a plain 429 when today's Learn budget is spent (a first open or "Update now"). */
export async function needRoom(env) {
  if (!(await learnRoom(env))) throw new HttpError(429, "Today's Learn budget is spent. It starts again tomorrow.");
}
