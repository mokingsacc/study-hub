import { HttpError, json, readJson, now } from './util.js';
import { all, first, run, reserveSpend, spendCap } from './db.js';
import { callJson } from './claude.js';
import { RESULTS, cleanQuestions, mergeQuestions, tidyShot, timing } from './uworld.js';
import { buildLeakIndex, leaks } from './checks.js';
import { noteJob } from './job-log.js';

export const MAX_PAGES = 60, PAGE_CHARS = 20_000, PAGES_TTL_MS = 24 * 3600_000;
const MAX_MARKS = 600, READ_RESERVE_USD = 1.5;

export const PAGES_SYSTEM = `You read Mo's UWorld review pages: the text of each question's page as UWorld shows it after a block (the question, the answer choices with the share of users who picked each, his answer, the correct answer, the explanation, and the page's header and footer). Mo is preparing for USMLE Step 2 CK.
For each page return one row: q (the question's number in the block, from "Item 3 of 40" or the page's own number), uworld_id (the Question Id), result (right, wrong or omitted: wrong when his answer is not the correct one, omitted when he gave none), picked (the letter he chose, from the page's marks of his answer, or null), answer (the correct letter), subject, system and topic exactly as the page labels them (short labels only), others_pct (the % of users who answered correctly), time_s (his time spent, in seconds: "1 min 35 sec" or "01:35" is 95) and others_time_s only if the page shows other users' average time.
Leave out anything you cannot read clearly (null) rather than guessing it. Never copy question text into any field. If the pages are not UWorld review pages, return no rows and say so in problem.`;

const nul = schema => ({ anyOf: [schema, { type: 'null' }] });
export const PAGES_SCHEMA = {
  type: 'object',
  properties: {
    questions: { type: 'array', items: { type: 'object', properties: {
      page: { type: 'integer' }, q: { type: 'integer' }, uworld_id: nul({ type: 'string' }), result: nul({ type: 'string', enum: RESULTS }),
      picked: nul({ type: 'string' }), answer: nul({ type: 'string' }),
      subject: nul({ type: 'string' }), system: nul({ type: 'string' }), topic: nul({ type: 'string' }),
      others_pct: nul({ type: 'integer' }), time_s: nul({ type: 'integer' }), others_time_s: nul({ type: 'integer' }),
    }, required: ['page', 'q', 'uworld_id', 'result', 'picked', 'answer', 'subject', 'system', 'topic', 'others_pct', 'time_s', 'others_time_s'], additionalProperties: false } },
    problem: nul({ type: 'string' }),
  },
  required: ['questions', 'problem'],
  additionalProperties: false,
};

const str = (v, n) => (typeof v === 'string' ? v.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, n) : '');

/** The pages as sent by the recorder page, checked: [{n, id, text, marks}], in order, 1 to 60 of them. */
export function cleanPages(list) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_PAGES) throw new HttpError(400, `Send 1 to ${MAX_PAGES} question pages.`);
  const out = list.map((p, i) => {
    const text = str(p && p.text, PAGE_CHARS);
    if (!text) throw new HttpError(400, `Page ${i + 1} has no text.`);
    const n = Number.isInteger(p.n) && p.n >= 1 && p.n <= 60 ? p.n : i + 1;
    const id = typeof p.id === 'string' && /^\d{2,8}$/.test(p.id.trim()) ? p.id.trim() : null;
    return { page: i + 1, n, id, text, marks: str(p.marks, MAX_MARKS) || null };
  });
  return out;
}

/** The reader's user turn: each page in its own fenced part. */
export function pagesMessage(pages) {
  return [`${pages.length} UWorld review page${pages.length === 1 ? '' : 's'} from one block. Read one row per page.`,
    ...pages.map(p => `\n=== Page ${p.page}${p.id ? ` (Question Id ${p.id})` : ''}, item ${p.n} ===\n${p.text}${p.marks ? `\n[Marks on the answer choices: ${p.marks}]` : ''}`)].join('\n');
}

export function tidyPageRows(rows, pages) {
  const byPage = new Map(pages.map(p => [p.page, p]));
  const fixed = (Array.isArray(rows) ? rows : []).map(r => {
    const p = byPage.get(r && r.page) || null;
    return { ...r, q: Number.isInteger(r && r.q) ? r.q : p ? p.n : null, uworld_id: (r && r.uworld_id) || (p && p.id) || null };
  });
  const letters = new Map(fixed.filter(r => Number.isInteger(r.q)).map(r => [r.q, r]));
  const L = v => (typeof v === 'string' && /^[A-Za-z]$/.test(v.trim()) ? v.trim().toUpperCase() : null);
  return tidyShot(fixed).map(r => {
    const x = letters.get(r.q) || {};
    return { ...r, picked: L(x.picked), answer: L(x.answer) };
  });
}

export async function pagesRoute(request, env, ctx, { id }) {
  const b = await readJson(request, MAX_PAGES * (PAGE_CHARS + MAX_MARKS) * 2 + 20_000);
  const pages = cleanPages(b.pages);
  const row = await first(env, 'SELECT id, day FROM uworld_blocks WHERE id = ?', String(id));
  if (!row) throw new HttpError(404, 'This block is not saved on the hub yet. Wait for it to save, then try again.');
  try {
    const release = await reserveSpend(env, READ_RESERVE_USD, await spendCap(env));
    let data, usd = 0;
    try {
      ({ data, usd } = await callJson(env, { role: 'reader', system: PAGES_SYSTEM, schema: PAGES_SCHEMA, effort: 'high', maxTokens: 16000,
        messages: [{ role: 'user', content: pagesMessage(pages) }] }));
    } finally {
      await release(0);
    }
    const rows = tidyPageRows(data && data.questions, pages);
    if (!rows.length) throw new HttpError(422, (data && data.problem) || 'No question could be read from those pages.');
    const { questions, problems } = cleanQuestions(rows);
    if (problems.length) throw new HttpError(422, `The pages could not be saved: ${problems[0]}`);
    // Each page kept under its question's number (the reader's, else the page's), for the judge only.
    const qOf = new Map();
    for (const r of rows) if (r.uworld_id) qOf.set(r.uworld_id, r.q);
    const t = now();
    const keep = new Map();
    for (const p of pages) {
      const q = (p.id && qOf.get(p.id)) || p.n;
      if (!keep.has(q)) keep.set(q, { q, uworld_id: p.id || (rows.find(r => r.q === q) || {}).uworld_id || null, text: p.text + (p.marks ? `\n[Marks on the answer choices: ${p.marks}]` : '') });
    }
    await env.DB.batch([env.DB.prepare('DELETE FROM uworld_pages WHERE block_id = ?').bind(row.id),
      ...[...keep.values()].map(k => env.DB.prepare('INSERT INTO uworld_pages (block_id, q, uworld_id, text, created_at) VALUES (?, ?, ?, ?, ?)').bind(row.id, k.q, k.uworld_id, k.text, t))]);
    const merged = await mergeQuestions(env, row.id, questions, ctx);
    const wrong = questions.filter(q => q.result === 'wrong' || q.result === 'omitted').length;
    await noteJob(env, { job: 'uworld_pages', key: row.id, ref: row.id, counts: { day: row.day || null, pages: pages.length, read: questions.length, wrong } });
    return json({ saved: true, pages: pages.length, read: questions.length, saved_in_block: merged.length, ...timing(merged), usd: Math.round(usd * 1e4) / 1e4 });
  } catch (e) {
    await noteJob(env, { job: 'uworld_pages', key: row.id, ref: row.id, state: e instanceof HttpError && e.status === 429 ? 'held' : 'failed',
      counts: { day: row.day || null, pages: pages.length }, detail: e });
    throw e;
  }
}

export async function pagesFor(env, blockId, t = now()) {
  const rows = await all(env, 'SELECT q, uworld_id, text FROM uworld_pages WHERE block_id = ? AND created_at > ?', blockId, t - PAGES_TTL_MS)
    .catch(e => { if (/no such table/i.test(String(e && e.message))) return []; throw e; });
  return new Map(rows.map(r => [r.q, { uworld_id: r.uworld_id, text: r.text }]));
}

/** The block's pages gone (the judge has read them). */
export async function dropPages(env, blockId) {
  await run(env, 'DELETE FROM uworld_pages WHERE block_id = ?', blockId).catch(e => { if (!/no such table/i.test(String(e && e.message))) throw e; });
}

/** The minute sweep: any page older than a day goes, judged or not. */
export async function sweepPages(env, t = now()) {
  await run(env, 'DELETE FROM uworld_pages WHERE created_at <= ?', t - PAGES_TTL_MS).catch(e => { if (!/no such table/i.test(String(e && e.message))) throw e; });
}

export function unleak(verdict, pageText) {
  if (!pageText) return { verdict, dropped: 0 };
  const index = buildLeakIndex({ stem: pageText });
  let dropped = 0;
  const v = { ...verdict };
  for (const k of ['why', 'cause_detail', 'concept']) if (v[k] && leaks(index, v[k])) { v[k] = null; dropped++; }
  // The shared core's other conditions (answer-core.js): one that copies the page goes whole.
  if (Array.isArray(v.other_conditions)) {
    const kept = v.other_conditions.filter(o => !(leaks(index, o.topic) || (o.quote && leaks(index, o.quote))));
    dropped += v.other_conditions.length - kept.length;
    v.other_conditions = kept;
  }
  if (v.teach) {
    const t = { ...v.teach };
    for (const k of ['rule', 'decision_point', 'separator', 'misconception', 'fell_for', 'say']) if (t[k] && leaks(index, t[k])) { t[k] = null; dropped++; }
    v.teach = t;
  }
  return { verdict: v, dropped };
}
