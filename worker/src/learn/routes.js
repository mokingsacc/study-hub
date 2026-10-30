// Learn's routes (I29; registry learn.js). Every one answers 404 unless the hub has LEARN = "on".
//   GET  /api/learn/:topic             the view in one batch: summary, cards facing this topic, AJmonics, FAQ, staleness
//   POST /api/learn/:topic/update      "Update now" (and the first open when there is no summary): held open while it writes
//   POST /api/learn/:topic/ask         {q, other_id?} -> {answer, usd, faq}: Ask Claude, saved to "Questions you've asked"
//   POST /api/learn/seed/ajmonics      {topics: {id: [{module, text, corrected}]}} (scripts/seed/ajmonics-points.json), idempotent
//   POST /api/learn/sweep              {fill?} the minute job by hand (dev) and the go-live fill
import { json, readJson, HttpError } from '../util.js';
import { reserveSpend, spendCap } from '../db.js';
import { callJson } from '../claude.js';
import { rand } from '../map/events.js';
import { looksLikeStem } from '../map/guard.js';
import { leaks } from '../checks.js';
import { readTopic, gatherContext, missFields, gapCite, pairKey } from './context.js';
import { facing } from './store.js';
import { writeLearn, sweepLearn, needRoom, SETTLE_MS, MIN_GAP_MS } from './sweep.js';
import { ASK_SYSTEM, askPrompt } from './prompt.js';

export const Q_MAX = 1000, ANSWER_MAX = 2000, ASK_RESERVE_USD = 0.15;
const ASK_SCHEMA = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const notReady = e => { if (noTable(e)) throw new HttpError(503, 'Learn needs its database update (migration 0025).'); throw e; };
const on = env => env.LEARN === 'on';
const off = () => json({ error: 'Not found' }, 404);
const round = usd => Math.round((Number(usd) || 0) * 1e4) / 1e4;

export function staleness(summary, ev, newMisses, now = Date.now()) {
  if (!summary) return { stale: true, new_misses: newMisses };
  return { stale: ev > Number(summary.ev_mark || 0), new_misses: newMisses,
    due_auto: ev > Number(summary.ev_mark || 0) && now - ev >= SETTLE_MS && (now - Number(summary.updated_at) >= MIN_GAP_MS || newMisses >= 2) };
}

/** The page's view of one topic (pure, from readTopic). */
export function shapeView(t, now = Date.now()) {
  const s = t.summary;
  const cards = new Map(t.cards.map(c => [c.a_id === t.topic.id ? c.b_id : c.a_id, c]));
  const faq = f => ({ id: f.id, q: f.q, a: f.a, usd: round(f.usd), at: Number(f.created_at), other_id: f.other_id || null });
  return {
    topic: t.topic,
    ajmonics: t.points.map(p => ({ text: p.text, module: p.module, corrected: !!p.corrected })),
    summary: s ? { ...parse(s.body_json, {}), version: Number(s.version) || 1, change_note: s.change_note || null, updated_at: Number(s.updated_at), trigger: s.trigger || null } : null,
    lookalikes: t.others.map(o => ({ ...o, card: cards.has(o.id) ? facing(t.topic.id, cards.get(o.id)) : null,
      faq: t.faq.filter(f => f.other_id && pairKey(f.topic_id, f.other_id).join('|') === pairKey(t.topic.id, o.id).join('|')).map(faq) })),
    faq: t.faq.filter(f => !f.other_id && f.topic_id === t.topic.id).map(faq),
    ...staleness(s, t.ev, t.newMisses, now),
    update_usd: 0.12,
  };
}

async function topicOr404(env, user, id) {
  const t = await readTopic(env, user, id).catch(notReady);
  if (!t) throw new HttpError(404, 'There is no topic with that id on the map.');
  return t;
}

// GET /api/learn/:topic
export async function viewRoute(request, env, ctx, params, url, user) {
  if (!on(env)) return off();
  return json(shapeView(await topicOr404(env, user, String(params.topic || ''))));
}

// POST /api/learn/:topic/update   (opts.call: the tests' stand-in for callJson)
export async function updateRoute(request, env, ctx, params, url, user, { call = null } = {}) {
  if (!on(env)) return off();
  const id = String(params.topic || '');
  const t = await topicOr404(env, user, id);
  await needRoom(env);
  const r = await writeLearn(env, user, id, { trigger: t.summary ? 'update' : 'open', call });
  return json({ ok: true, usd: round(r.usd), view: shapeView(await readTopic(env, user, id)) });
}

// POST /api/learn/:topic/ask {q, other_id?}
export async function askRoute(request, env, ctx, params, url, user, { call = null } = {}) {
  if (!on(env)) return off();
  const id = String(params.topic || '');
  const body = await readJson(request, 20_000);
  const q = String(body.q || '').replace(/\s+/g, ' ').trim();
  if (!q) return json({ error: 'Type a question first.' }, 400);
  if (q.length > Q_MAX) return json({ error: `Keep the question under ${Q_MAX} characters.` }, 400);
  const t = await topicOr404(env, user, id);
  const otherId = body.other_id ? String(body.other_id) : null;
  const other = otherId ? t.others.find(o => o.id === otherId) : null;
  if (otherId && !other) return json({ error: 'That is not one of the look-alikes.' }, 400);
  const view = shapeView(t);
  const { leakIndex } = await gatherContext(env, user, t);
  const actx = {
    topic: t.topic.name, summary: view.summary ? { tested: view.summary.tested, traps: view.summary.traps, mehlman: view.summary.mehlman } : null,
    ajmonics: view.ajmonics.map(p => p.text),
    ...(other ? { look_alike: other.name, card: (view.lookalikes.find(o => o.id === otherId) || {}).card || null } : {}),
    your_misses: t.misses.map(missFields), your_gaps: t.gaps.map(g => ({ cite: gapCite(g), gap: g.gap })),
  };
  const req = { system: ASK_SYSTEM, schema: ASK_SCHEMA, effort: 'high', maxTokens: 16000, messages: [{ role: 'user', content: askPrompt(q, actx) }] };
  let data, usd = 0;
  if (call) ({ data, usd = 0 } = await call({ role: 'asker', ...req }));
  else {
    const release = await reserveSpend(env, ASK_RESERVE_USD, await spendCap(env));
    try { ({ data, usd } = await callJson(env, { role: 'asker', ...req })); } finally { await release(0); }
  }
  const answer = String((data && data.answer) || '').replace(/[ \t]+/g, ' ').trim().slice(0, ANSWER_MAX);
  if (!answer) throw new HttpError(502, 'Claude sent back no answer. Try again in a moment.');
  if (looksLikeStem(answer) || (leakIndex.size && leaks(leakIndex, answer))) {
    return json({ error: 'The answer quoted question-bank text, so it was not kept. Ask again in other words.', usd: round(usd) }, 422);
  }
  const row = { id: `fq_${rand().slice(0, 20)}`, topic_id: id, other_id: other ? other.id : null, q, a: answer, usd, created_at: Date.now() };
  await env.DB.prepare('INSERT INTO learn_faq (user_id, id, topic_id, other_id, q, a, usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(user, row.id, row.topic_id, row.other_id, row.q, row.a, row.usd, row.created_at).run();
  return json({ answer, usd: round(usd), faq: { id: row.id, q, a: answer, usd: round(usd), at: row.created_at, other_id: row.other_id } });
}

// POST /api/learn/seed/ajmonics {topics: {topic_id: [{module, text, corrected}]}}: replaces each listed topic's points.
export async function seedAjmonicsRoute(request, env, ctx, params, url, user) {
  if (!on(env)) return off();
  const body = await readJson(request, 2_000_000);
  const topics = body && body.topics && typeof body.topics === 'object' ? body.topics : null;
  if (!topics) return json({ error: 'Send {topics} from scripts/seed/ajmonics-points.json.' }, 400);
  const ids = Object.keys(topics).filter(id => /^[a-z0-9-]{1,120}$/.test(id));
  const known = new Set(((await env.DB.prepare(`SELECT id FROM topics WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(ids)).all()).results || []).map(r => r.id));
  const now = Date.now();
  const rows = [];
  for (const id of ids.filter(x => known.has(x))) {
    (Array.isArray(topics[id]) ? topics[id] : []).forEach((p, i) => {
      const text = String((p && p.text) || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
      if (text) rows.push({ topic_id: id, id: `aj${i + 1}`, module: String(p.module || '').slice(0, 120) || null, text, corrected: p.corrected ? 1 : 0, sort: i, created_at: now });
    });
  }
  const statements = [env.DB.prepare(`DELETE FROM learn_points WHERE user_id = ? AND source = 'ajmonics' AND topic_id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify([...known]))];
  for (let i = 0; i < rows.length; i += 50) {
    statements.push(env.DB.prepare(`INSERT INTO learn_points (user_id, topic_id, id, source, module, text, corrected, sort, created_at)
      SELECT ?, json_extract(value, '$.topic_id'), json_extract(value, '$.id'), 'ajmonics', json_extract(value, '$.module'), json_extract(value, '$.text'),
        json_extract(value, '$.corrected'), json_extract(value, '$.sort'), json_extract(value, '$.created_at') FROM json_each(?)`).bind(user, JSON.stringify(rows.slice(i, i + 50))));
  }
  await env.DB.batch(statements).catch(notReady);
  return json({ ok: true, topics: known.size, points: rows.length, unknown: ids.filter(x => !known.has(x)) });
}

// POST /api/learn/sweep {fill?}
export async function sweepRoute(request, env, ctx, params, url, user) {
  if (!on(env)) return off();
  const body = await readJson(request, 2_000).catch(() => ({}));
  return json(await sweepLearn(env, user, { fill: body && body.fill === true }).catch(notReady));
}

