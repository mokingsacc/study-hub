import { HttpError, readJson, now } from './util.js';
import { run, assertUnderCap, reserveSpend, hardCap } from './db.js';
import { streamText } from './claude.js';
import { contentWords, ftsExpr } from './library/search.js';
import { addGap, cleanGap, refLeakProblem } from './gaps.js';
import { MO } from './users.js';

export const ASK_GAP_MS = 1500;                  // one question at a time (a follow-up comes seconds later)
export const MEHLMAN_MS = 400, MEHLMAN_N = 2, MEHLMAN_CHARS = 500;
export const TTS_MODEL = '@cf/deepgram/aura-2-en', TTS_VOICE = 'thalia', TTS_USD_PER_CHAR = 0.030 / 1000, TTS_MAX = 1500;
const Q_MAX = 600, FIELD_MAX = 6000, THREAD_MAX = 6;

export const ASK_SYSTEM = `You are helping Mo, a US medical student, review his own Anki flashcards for USMLE Step 2 CK. He asked a question out loud about the card on screen, and your answer appears in a small panel (it may be read aloud).

How to answer:
- 2 to 4 short sentences, spoken style, plain words. No lists, headings, bullet points, symbols, abbreviations he would have to decode, or markdown.
- Put the deciding reason first: the one fact or mechanism that settles his question. Then, if it helps, the look-alike and how to tell it apart.
- Follow current US guidelines and US practice.
- Base the answer on the card and on the Mehlman passages given, where Mehlman covers the point. Do not mention Mehlman or your sources unless he asks where it comes from; then, if the passages do not cover it, say "Mehlman doesn't cover this". If the card and Mehlman disagree, say so in one sentence and give the US-guideline answer.
- If he has not seen the card's answer yet, do not give it away unless he asks for it.
- Never quote or rebuild question-bank text (UWorld, NBME); explain in your own words.
- If his question is unclear, answer the most likely reading in one sentence and ask nothing back.`;

const clip = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const cut = (s, max) => { const t = clip(s, 10_000); return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…`; };

export function keyTerms(card) {
  const ans = String((card && card.answer) || '');
  const bold = [...ans.matchAll(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>|\*\*([^*]+)\*\*/gi)].map(m => m[1] || m[2]).join(' ');
  const first = ans.replace(/<[^>]+>/g, ' ').split(/\n+/).map(l => l.trim()).find(Boolean) || '';
  const words = [...new Set([...contentWords(bold), ...contentWords(first), ...contentWords(String((card && card.question) || '').replace(/<[^>]+>/g, ' '))])];
  return words.slice(0, 10);
}

export async function mehlmanFor(env, card, { user = MO, limit = MEHLMAN_N } = {}) {
  const terms = keyTerms(card);
  const expr = terms.length ? ftsExpr(terms.join(' ')) : null;
  if (!expr) return [];
  const match = expr.any || expr.all;
  try {
    const rows = (await env.DB.prepare(`SELECT p.pid, p.page, p.heading, p.text, d.title FROM library_fts f
        JOIN library_passages p ON p.pid = f.rowid JOIN library_docs d ON d.user_id = p.user_id AND d.id = p.doc_id
        WHERE library_fts MATCH ?2 AND p.user_id = ?1 AND d.collection = 'mehlman' ORDER BY bm25(library_fts, 2.0, 1.0) LIMIT ?3`)
      .bind(user, match, limit).all()).results || [];
    return rows.map(r => ({ title: clip(r.title, 120), page: r.page, heading: r.heading ? clip(r.heading, 120) : null, text: cut(r.text, MEHLMAN_CHARS) }));
  } catch (e) {
    if (/no such (?:table|column|module)|fts5: syntax/i.test(String(e && e.message))) return [];
    throw e;
  }
}

export async function mehlmanInTime(env, card, ms = MEHLMAN_MS) {
  const t0 = Date.now();
  let timer;
  const late = new Promise(res => { timer = setTimeout(() => res(null), ms); });
  const got = await Promise.race([mehlmanFor(env, card).catch(e => { console.error('cards ask: Mehlman search failed', e && e.message); return []; }), late]);
  clearTimeout(timer);
  if (got === null) console.log(JSON.stringify({ cards_ask: 'mehlman_timeout', ms }));
  return { passages: got || [], ms: Date.now() - t0, timedOut: got === null };
}

export function askMessages({ card, revealed, passages, thread, question }) {
  const lines = [`The card (front):\n${clip(card.question, FIELD_MAX)}`];
  if (revealed) {
    lines.push(`The card's answer:\n${String(card.answer || '').replace(/<[^>]+>/g, ' ').slice(0, FIELD_MAX).trim()}`);
    if (card.notes) lines.push(`The card's notes:\n${clip(card.notes, FIELD_MAX)}`);
  } else {
    lines.push(`He has not seen the answer yet. For you only, the answer is: ${clip(card.answer, FIELD_MAX)}`);
  }
  lines.push(passages.length
    ? `Mehlman passages that match this card:\n${passages.map((p, i) => `[${i + 1}] ${p.title}, page ${p.page}${p.heading ? ` (${p.heading})` : ''}: ${p.text}`).join('\n')}`
    : 'Mehlman passages that match this card: none found.');
  const context = lines.join('\n\n');
  const msgs = [];
  (thread || []).forEach((t, i) => {
    msgs.push({ role: 'user', content: i === 0 ? `${context}\n\nHis question: ${t.q}` : t.q });
    msgs.push({ role: 'assistant', content: t.a });
  });
  msgs.push({ role: 'user', content: msgs.length ? question : `${context}\n\nHis question: ${question}` });
  return msgs;
}

const cardOf = b => {
  const c = b && b.card && typeof b.card === 'object' ? b.card : null;
  if (!c || !clip(c.question, 10)) throw new HttpError(400, 'Send the card on screen with the question.');
  return { question: String(c.question).slice(0, FIELD_MAX), answer: String(c.answer || '').slice(0, FIELD_MAX), notes: String(c.notes || '').slice(0, FIELD_MAX) };
};
const threadOf = b => (Array.isArray(b && b.thread) ? b.thread : []).slice(-THREAD_MAX)
  .map(t => ({ q: clip(t && t.q, Q_MAX), a: clip(t && t.a, 2000) })).filter(t => t.q && t.a);

/** One question at a time across the hub (a claim in one statement, like the mic test's). */
async function claimTurn(env, key, gapMs) {
  const t = now();
  const r = await run(env, `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(settings.value AS INTEGER) <= ?`, key, String(t), t - gapMs);
  if (!r.meta || !r.meta.changes) throw new HttpError(429, 'One question at a time: ask again in a moment.');
}

// POST /api/cards/:id/ask
export async function ask(request, env, ctx, params) {
  const cardId = Number(params.id);
  if (!Number.isSafeInteger(cardId) || cardId <= 0) throw new HttpError(400, 'That is not an Anki card id.');
  const b = await readJson(request, 40_000);
  const question = clip(b.question, Q_MAX);
  if (!question) throw new HttpError(400, 'Ask a question about the card.');
  const card = cardOf(b);
  const thread = threadOf(b);
  const t0 = Date.now();
  const mehlman = mehlmanInTime(env, card);
  await Promise.all([claimTurn(env, 'cards_ask_at', ASK_GAP_MS), assertUnderCap(env)]);
  if (b.gap) {
    const g = cleanGap({ gap: question.slice(0, 200), source: 'spoken_cue', card_id: cardId, ref: `cards:${cardId}` });
    const save = (async () => {
      if (g.problems.length || (await refLeakProblem(env, MO, g.gap))) return;
      await addGap(env, g.gap);
    })().catch(e => console.error('cards ask: gap not saved', e && e.message));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(save);
  }
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const put = obj => w.write(enc.encode(`${JSON.stringify(obj)}\n`)).catch(() => {});
  const work = (async () => {
    try {
      const m = await mehlman;
      put({ t: 'meta', mehlman: m.passages.length, mehlman_ms: m.ms, ...(m.timedOut ? { mehlman_timeout: true } : {}), ms: Date.now() - t0 });
      const r = await streamText(env, { role: 'explainer', system: ASK_SYSTEM, maxTokens: 600,
        messages: askMessages({ card, revealed: !!b.revealed, passages: m.passages, thread, question }), onText: d => { put({ t: 'text', d }); } });
      put({ t: 'done', usd: Math.round(r.usd * 1e5) / 1e5, stop: r.stop, ms: Date.now() - t0 });
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('cards ask failed', e && (e.stack || e.message));
      put({ t: 'error', message: e instanceof HttpError ? e.message : 'Claude did not answer. Try again in a moment.' });
    } finally { w.close().catch(() => {}); }
  })();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
  return new Response(readable, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/** Aura's answer as bytes, whatever shape the binding hands back (a stream, bytes, base64 or {audio}). */
async function audioBytes(out) {
  if (!out) return null;
  if (out instanceof Response) return new Uint8Array(await out.arrayBuffer());
  if (typeof ReadableStream !== 'undefined' && out instanceof ReadableStream) return new Uint8Array(await new Response(out).arrayBuffer());
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (ArrayBuffer.isView(out)) return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  const b64 = typeof out === 'string' ? out : typeof out.audio === 'string' ? out.audio : null;
  if (b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  return null;
}

// POST /api/cards/speak {text}: Claude's answer read aloud (Aura-2), $0.030 per 1,000 characters against the hard cap.
export async function speak(request, env) {
  if (!env.AI) throw new HttpError(503, 'Reading aloud is not set up on this hub.');
  const b = await readJson(request, 8000);
  const text = clip(b.text, TTS_MAX + 1);
  if (!text) throw new HttpError(400, 'Nothing to read.');
  if (text.length > TTS_MAX) throw new HttpError(413, 'That answer is too long to read aloud.');
  await claimTurn(env, 'cards_speak_at', 500);
  const usd = text.length * TTS_USD_PER_CHAR;
  const release = await reserveSpend(env, usd, hardCap(env), { monthly: false });
  let bytes;
  try { bytes = await audioBytes(await env.AI.run(TTS_MODEL, { text, speaker: TTS_VOICE, encoding: 'mp3' })); } catch (e) {
    await release(0);
    console.error('cards speak failed', e && e.message);
    throw new HttpError(502, 'The voice did not answer; the text is on screen.');
  }
  if (!bytes || !bytes.length) { await release(0); throw new HttpError(502, 'The voice sent nothing back; the text is on screen.'); }
  await release(usd);
  return new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
}
