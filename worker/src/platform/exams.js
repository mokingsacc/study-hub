import { HttpError, json, readJson, now, uuid, safeParse } from '../util.js';
import { requireModule } from './modules.js';
import { meterFixed } from './ai.js';
import { randomToken, sha256Hex } from './crypto.js';
import { findUserSubject } from './subjects.js';
import { labelOf } from './results.js';
import { loadPaper, mutatePaper, shapePaper, parsePaper, PARTS, MAX_PAPERS, MAX_QUESTIONS } from './papers.js';
import { addPdf, KIND_COLLECTION } from './library.js';
import * as store from '../library/store.js';
import { WHISPER_MODEL, toBase64 } from '../transcribe.js';
import { norm } from '../../../public/js/shared/names.js';

export const UPLOAD_LINK_MS = 60 * 60_000;
export const UPLOAD_LINK_FILES = 30;
export const KINDS = Object.keys(KIND_COLLECTION);
export const KIND_WORD = { exam_paper: 'an exam paper', mark_scheme: 'a mark scheme', notes: 'notes', other: 'a file' };
export const MAX_AUDIO = 8_000_000;            // about half an hour of speech at 32 kbps
export const MAX_THINKING = 200;               // recordings kept per paper
const WHISPER_USD_PER_MIN = 0.000513;
const LINK_MAX_BYTES = 50 * 1024 * 1024;
const ok = (data, status = 200) => json(data, status);
const clean = (s, n) => String(s ?? '').replace(/\r\n?/g, '\n').trim().slice(0, n);
const oneLine = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ one-time upload links

export async function createUploadLink(env, user, { kind = 'exam_paper', title = null, subject = null } = {}) {
  if (!KINDS.includes(kind)) throw new HttpError(400, `kind is one of ${KINDS.join(', ')}.`);
  const sub = subject ? await findUserSubject(env, user, String(subject)) : null;
  const token = 'up_' + randomToken(24);
  const t = now();
  await env.DB.prepare(`INSERT INTO upload_links (user_id, id, kind, title, subject_id, created_at, expires_at, max_files)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).bind(user, await sha256Hex('upload:' + token), kind, title ? oneLine(title, 120) : null,
    sub ? sub.id : null, t, t + UPLOAD_LINK_MS, UPLOAD_LINK_FILES).run();
  return { token, expires_at: t + UPLOAD_LINK_MS };
}

/** The link behind a token, or null (unknown, used up, expired, or the person is paused). */
export async function uploadLinkFor(env, token) {
  if (typeof token !== 'string' || !/^up_[A-Za-z0-9_-]{30,40}$/.test(token)) return null;
  const row = await env.DB.prepare(`SELECT l.user_id, l.id, l.kind, l.title, l.subject_id, l.expires_at, l.files, l.max_files, u.name, u.profile, u.prefs_json
    FROM upload_links l JOIN users u ON u.id = l.user_id WHERE l.id = ?1 AND u.status = 'active' AND l.user_id != 'mo'`).bind(await sha256Hex('upload:' + token)).first();
  if (!row || row.expires_at < now() || row.files >= row.max_files) return null;
  return row;
}

// GET /api/p/up/:token (no sign-in): what the upload screen shows.
async function uploadInfo(request, env, ctx, params) {
  const link = await uploadLinkFor(env, params.token);
  if (!link) throw new HttpError(404, 'This upload link has run out. Ask your Claude for a new one.');
  const first = String(link.name || '').split(/\s+/)[0] || '';
  return ok({ kind: link.kind, kind_word: KIND_WORD[link.kind], title: link.title, name: first,
    minutes_left: Math.max(1, Math.round((link.expires_at - now()) / 60_000)), files_left: link.max_files - link.files });
}

// ------------------------------------------------------------------ add a PDF from a link

const PDF_LINK = /href\s*=\s*["']([^"'#]+?\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;

/** PDF links on a web page: [{url, text}], at most 40, absolute https only. */
export function pdfLinks(html, base) {
  const out = [], seen = new Set();
  for (const m of String(html).matchAll(PDF_LINK)) {
    let u;
    try { u = new URL(m[1].replace(/&amp;/g, '&'), base); } catch { continue; }
    if (u.protocol !== 'https:' || seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ url: u.href, text: oneLine(m[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' '), 120) || u.pathname.split('/').pop() });
    if (out.length >= 40) break;
  }
  return out;
}

function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new HttpError(400, 'That is not a web address.'); }
  if (u.protocol !== 'https:') throw new HttpError(400, 'Only https:// links can be added.');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(u.hostname) || !u.hostname.includes('.')) throw new HttpError(400, 'That address cannot be reached from the hub.');
  return u;
}

// Reads a response body up to max bytes (a PDF larger than that is refused before it fills memory).
async function readCapped(res, max) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) throw new HttpError(413, `That file is too big (${Math.round(max / 1048576)} MB at most).`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (got > max) { try { await reader.cancel(); } catch { /* stop */ } throw new HttpError(413, `That file is too big (${Math.round(max / 1048576)} MB at most).`); }
    parts.push(value);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

export async function addFromLink(env, user, { url, kind = 'exam_paper', title = null }, ctx) {
  if (!KINDS.includes(kind)) throw new HttpError(400, `kind is one of ${KINDS.join(', ')}.`);
  const u = checkUrl(url);
  let res;
  try {
    res = await fetch(u.href, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (StudyHub; personal revision library)', Accept: 'application/pdf,text/html;q=0.8,*/*;q=0.5' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(25_000) : undefined });
  } catch {
    throw new HttpError(502, 'That site did not answer. Try again, or download the PDF and send it with an upload link.');
  }
  if (!res.ok) throw new HttpError(502, `That site said no (${res.status}). Some exam boards block downloads; try the same paper from another site, or download it and send it with an upload link.`);
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/html')) {
    const links = pdfLinks(new TextDecoder().decode(await readCapped(res, 3_000_000)), res.url || u.href);
    return { added: false, page_not_pdf: true, pdf_links: links,
      note: links.length ? 'That link is a web page, not a PDF. Pick the right PDF from pdf_links (the question paper, or the mark scheme) and call library_add_link with its url.'
        : 'That link is a web page with no PDF links on it. Find the PDF itself (search for the board, paper and year with "question paper pdf").' };
  }
  const bytes = await readCapped(res, LINK_MAX_BYTES);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(1024, bytes.length)));
  if (!head.includes('%PDF-')) throw new HttpError(400, 'That link is not a PDF.');
  const name = decodeURIComponent((new URL(res.url || u.href).pathname.split('/').pop() || 'paper.pdf')).replace(/[^\w .()-]+/g, ' ').trim() || 'paper.pdf';
  const doc = await addPdf(env, user, { bytes, file_name: /\.pdf$/i.test(name) ? name : `${name}.pdf`, title: title || name.replace(/\.pdf$/i, ''), kind }, ctx);
  return { added: !doc.duplicate, duplicate: !!doc.duplicate, doc_id: doc.id, title: doc.title, kind, status: doc.status,
    note: doc.duplicate ? 'That PDF is already in their library.' : 'Added to their library. Its text is being read now (a minute or two); then library_read can open it.' };
}

// ------------------------------------------------------------------ exams from their own past papers

const LABEL_RE = /^[\w().\s-]{1,16}$/;

/** exam_make's input checked: questions [{n, label, marks, page, text, topic}] and scheme [{n, points}]. */
export function validExam(args, pageCount = null) {
  const list = Array.isArray(args.questions) ? args.questions : [];
  if (!list.length) throw new HttpError(400, 'Give the questions: label, marks and page for each.');
  if (list.length > MAX_QUESTIONS) throw new HttpError(400, `At most ${MAX_QUESTIONS} questions in one exam (split a longer paper in two).`);
  const questions = [], byLabel = new Map();
  for (const [i, q] of list.entries()) {
    if (!isObj(q)) throw new HttpError(400, `Question ${i + 1} should be an object.`);
    const marks = Math.round(Number(q.marks));
    if (!(marks >= 1 && marks <= 40)) throw new HttpError(400, `Question ${q.label || i + 1} needs its marks (1 to 40).`);
    const label = q.label == null ? String(i + 1) : oneLine(q.label, 16);
    if (!LABEL_RE.test(label)) throw new HttpError(400, `"${label.slice(0, 20)}" is not a question label like 3(b)(ii).`);
    const page = q.page == null ? null : Math.round(Number(q.page));
    if (page != null && !(page >= 1 && page <= (pageCount || 400))) throw new HttpError(400, `Question ${label}: page ${q.page} is not in the PDF.`);
    const n = questions.length + 1;
    const topic = typeof q.topic === 'string' ? labelOf(q.topic) : null;
    questions.push({ n, label, marks, ...(page ? { page } : {}), text: clean(q.text || `Question ${label}`, 1000), topic });
    byLabel.set(label.toLowerCase(), n);
  }
  const scheme = [];
  for (const s of Array.isArray(args.scheme) ? args.scheme : []) {
    if (!isObj(s)) continue;
    const n = s.n != null ? Number(s.n) : byLabel.get(String(s.label || '').toLowerCase().trim());
    if (!questions.some(q => q.n === n)) throw new HttpError(400, `The mark scheme names a question that is not in the list (${String(s.label ?? s.n).slice(0, 16)}).`);
    const points = (Array.isArray(s.points) ? s.points : []).filter(p => typeof p === 'string' && p.trim()).map(p => clean(p, 300)).slice(0, 20);
    if (points.length) scheme.push({ n, points });
  }
  return { questions, scheme };
}

async function topicIds(env, user, subjectId, questions) {
  const { results } = await env.DB.prepare(`SELECT a.alias_key, a.topic_id, t.name FROM topic_aliases a JOIN topics t ON t.user_id = a.user_id AND t.id = a.topic_id
    WHERE a.user_id = ?1 AND a.status = 'active' AND t.status IN ('proposed', 'confirmed') AND t.category_id = ?2`).bind(user, subjectId).all();
  const by = new Map((results || []).map(r => [r.alias_key, r]));
  for (const q of questions) {
    const hit = q.topic ? by.get(norm(q.topic)) : null;
    if (hit) { q.topic = hit.name; q.topic_id = hit.topic_id; }
  }
}

export async function makeExam(env, user, args) {
  const doc = await store.getDoc(env, user, String(args.doc_id || ''));
  if (!doc) throw new HttpError(404, 'That document is not in their library. library_read with no doc_id lists it.');
  // Its pages arrive a little after the file (read on their device); until then the page numbers cannot be checked.
  if (['uploading', 'uploaded', 'extracting'].includes(doc.status)) throw new HttpError(409, 'That PDF is still being read into their library. Wait a minute, then try again.');
  const subject = await findUserSubject(env, user, String(args.subject || ''));
  let schemeDoc = null;
  if (args.scheme_doc_id) {
    schemeDoc = await store.getDoc(env, user, String(args.scheme_doc_id));
    if (!schemeDoc) throw new HttpError(404, 'The mark scheme document is not in their library.');
  }
  const { questions, scheme } = validExam(args, doc.page_count);
  await topicIds(env, user, subject.id, questions);
  const minutes = args.minutes == null ? null : Math.round(Number(args.minutes));
  if (minutes != null && !(minutes >= 5 && minutes <= 240)) throw new HttpError(400, 'minutes is the time allowed, 5 to 240.');
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM papers WHERE user_id = ?').bind(user).first();
  if (n >= MAX_PAPERS + 50) throw new HttpError(409, 'There are a lot of papers already. Delete some old ones first.');
  const id = 'ex_' + uuid().replace(/-/g, '').slice(0, 16);
  const title = oneLine(args.title || doc.title, 120);
  const t = now();
  const source = { kind: 'document', doc_id: doc.id, ...(schemeDoc ? { scheme_doc_id: schemeDoc.id } : {}) };
  await env.DB.prepare(`INSERT INTO papers (user_id, id, subject_id, title, spec_json, paper_json, marks_json, status, provider, model, usd, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ready', 'claude_subscription', NULL, 0, ?8, ?8)`)
    .bind(user, id, subject.id, title, JSON.stringify({ from: 'document' }), JSON.stringify({ questions, source, ...(minutes ? { minutes } : {}) }),
      JSON.stringify({ scheme }), t).run();
  return { paper_id: id, title, subject: subject.name, questions: questions.length, out_of: questions.reduce((s, q) => s + q.marks, 0),
    minutes, with_mark_scheme: scheme.length, on_topics: questions.filter(q => q.topic_id).length };
}

// GET /api/p/exams: exams made from her papers, other papers, and exam PDFs in her library not made into exams yet.
async function examsRoute(request, env, ctx, params, url, user, session) {
  requireModule(session, PARTS, env);
  const [p, d] = await env.DB.batch([
    env.DB.prepare('SELECT id, subject_id, title, paper_json, marks_json, status, provider, created_at FROM papers WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 100').bind(user),
    env.DB.prepare(`SELECT id, title, collection, page_count, status, created_at FROM library_docs WHERE user_id = ?1 AND collection IN ('exam-paper', 'mark-scheme')
      AND status NOT IN ('uploading', 'refused', 'failed') ORDER BY created_at DESC LIMIT 100`).bind(user),
  ]);
  const used = new Set();
  const papers = (p.results || []).map(r => {
    const { paper, marks } = parsePaper(r);
    if (paper.source) { used.add(paper.source.doc_id); if (paper.source.scheme_doc_id) used.add(paper.source.scheme_doc_id); }
    return { id: r.id, subject_id: r.subject_id, title: r.title, status: r.status, created_at: r.created_at, from_document: !!paper.source,
      kind: paper.source ? 'exam' : 'practice', made_by: r.provider === 'claude_subscription' ? 'claude' : 'key',
      minutes: paper.minutes || null, questions: (paper.questions || []).length, out_of: (paper.questions || []).reduce((s, q) => s + q.marks, 0),
      total: r.status === 'marked' ? (marks.total ?? null) : null, recordings: Array.isArray(marks.thinking) ? marks.thinking.length : 0 };
  });
  const docs = (d.results || []).map(x => ({ id: x.id, title: x.title, kind: x.collection === 'mark-scheme' ? 'mark_scheme' : 'exam_paper', pages: x.page_count, status: x.status, made: used.has(x.id) }));
  return ok({ papers, waiting: docs.filter(x => !x.made && x.kind === 'exam_paper'), schemes: docs.filter(x => x.kind === 'mark_scheme') });
}

// ------------------------------------------------------------------ recordings of their thinking

// POST /api/p/papers/:id/thinking (form: audio, n?, secs?): transcribed, words kept with the question, audio dropped.
async function thinkingRoute(request, env, ctx, params, url, user, session) {
  requireModule(session, PARTS, env);
  let form;
  try { form = await request.formData(); } catch { throw new HttpError(400, 'Please send the recording as a form upload.'); }
  const audio = form.get('audio');
  if (!audio || typeof audio === 'string') throw new HttpError(400, 'The recording is missing.');
  if (audio.size > MAX_AUDIO) throw new HttpError(413, 'That recording is too long. Record each question on its own.');
  const row = await loadPaper(env, user, params.id);
  const { paper } = parsePaper(row);
  const nRaw = form.get('n');
  const n = nRaw == null || nRaw === '' ? null : Number(nRaw);
  if (n != null && !(paper.questions || []).some(q => q.n === n)) throw new HttpError(400, 'That question is not on this paper.');
  if (audio.size < 800) return ok({ saved: false, message: 'That was too short to hear anything. Press Record and talk through your thinking.' });
  const secsEst = Math.min(3600, Math.max(1, Number(form.get('secs')) || audio.size / 4000));
  await meterFixed(env, user, { task: 'thinking', usd: Math.max(0.0005, (secsEst / 60) * WHISPER_USD_PER_MIN) });
  let out;
  try {
    // A short hint of what is being talked about helps Whisper with subject words (enzyme, alkene, Milgram).
    const q = n != null ? paper.questions.find(x => x.n === n) : null;
    const vocab = ((await env.DB.prepare("SELECT name FROM topics WHERE user_id = ?1 AND category_id = ?2 AND status IN ('proposed','confirmed') LIMIT 60").bind(user, row.subject_id).all().catch(() => ({}))).results || []).map(t => t.name);
    const hint = oneLine(`A student thinking out loud about ${row.title}${q ? `, question ${q.label || q.n}${q.topic ? ` on ${q.topic}` : ''}: ${q.text}` : ''}.${vocab.length ? ` Words: ${vocab.join(', ')}.` : ''}`, 900);
    out = await env.AI.run(WHISPER_MODEL, { audio: toBase64(new Uint8Array(await audio.arrayBuffer())), task: 'transcribe', language: 'en', vad_filter: true, initial_prompt: hint });
  } catch (e) {
    console.error('thinking whisper failed', e && e.message);
    throw new HttpError(502, 'The recording could not be turned into words just now. Please try again.');
  }
  const text = clean(out && out.text, 6000);
  if (!text) return ok({ saved: false, message: 'No words could be heard in that recording. Check the microphone and try again.' });
  const secs = Math.round(Number(out && out.transcription_info && out.transcription_info.duration) || secsEst);
  const item = { id: 'r' + uuid().replace(/-/g, '').slice(0, 10), n, at: now(), secs, text };
  await mutatePaper(env, user, row.id, ({ marks }) => {
    const list = Array.isArray(marks.thinking) ? marks.thinking : (marks.thinking = []);
    list.push(item);
    if (list.length > MAX_THINKING) list.splice(0, list.length - MAX_THINKING);
  });
  return ok({ saved: true, recording: item }, 201);
}

// DELETE /api/p/papers/:id/thinking/:rid
async function thinkingDelete(request, env, ctx, params, url, user, session) {
  requireModule(session, PARTS, env);
  let found = false;
  await mutatePaper(env, user, params.id, ({ marks }) => {
    const list = Array.isArray(marks.thinking) ? marks.thinking : [];
    const i = list.findIndex(t => t.id === params.rid);
    if (i >= 0) { list.splice(i, 1); found = true; }
  });
  if (!found) throw new HttpError(404, 'There is no such recording.');
  return ok({ ok: true });
}

/** thinking_get's payload: recordings with the question, her answer, confidence and marks, newest papers first. */
export async function thinkingFor(env, user, { paper_id = null, limit = 30 } = {}) {
  const rows = paper_id
    ? [await loadPaper(env, user, paper_id)]
    : ((await env.DB.prepare("SELECT * FROM papers WHERE user_id = ?1 AND marks_json LIKE '%\"thinking\":[{%' ORDER BY updated_at DESC LIMIT 10").bind(user).all()).results || []);
  const out = [];
  for (const row of rows) {
    const s = shapePaper(row);
    const byN = new Map(s.questions.map(q => [q.n, q]));
    const res = new Map((s.results || []).map(r => [r.n, r]));
    for (const t of (s.thinking || []).slice().reverse()) {
      if (out.length >= limit) break;
      const q = t.n != null ? byN.get(t.n) : null;
      const r = q ? res.get(q.n) : null;
      out.push({ paper_id: s.id, paper: s.title, recording_id: t.id, recorded_at: new Date(t.at).toISOString(), seconds: t.secs,
        question: q ? { n: q.n, label: q.label || String(q.n), marks: q.marks, topic: q.topic || undefined, page: q.page || undefined } : 'the whole paper',
        her_answer: q && q.answer ? q.answer : undefined, confidence: q && q.confidence ? q.confidence : undefined,
        marked: r ? { awarded: r.awarded, out_of: r.out_of, reason: r.reason || undefined } : undefined,
        what_she_said: t.text, earlier_feedback: (s.thinking_notes || {})[q ? q.n : 'all'] || undefined });
    }
  }
  return out;
}

async function saveThinkingNote(env, user, { paper_id, n = null, feedback }) {
  const text = clean(feedback, 1500);
  if (!text) throw new HttpError(400, 'Write the feedback to keep.');
  const row = await loadPaper(env, user, paper_id);
  const key = n == null ? 'all' : String(Number(n));
  if (key !== 'all' && !parsePaper(row).paper.questions.some(q => q.n === Number(n))) throw new HttpError(400, 'That question is not on this paper.');
  await mutatePaper(env, user, row.id, ({ marks }) => {
    const notes = isObj(marks.thinking_notes) ? marks.thinking_notes : (marks.thinking_notes = {});
    notes[key] = { text, at: now() };
  });
  return { saved: true, paper_id: row.id, question: key };
}

export const ROUTES = [
  ['GET', '/api/p/exams', examsRoute],
  ['POST', '/api/p/papers/:id/thinking', thinkingRoute],
  ['DELETE', '/api/p/papers/:id/thinking/:rid', thinkingDelete],
];

// No sign-in: the upload screen reads its link (routes.js PUBLIC table).
export const PUBLIC_ROUTES = [
  ['GET', '/api/p/up/:token', uploadInfo],
];

// ------------------------------------------------------------------ connector tools (her own Claude)

const KIND_PROP = { type: 'string', enum: KINDS, description: 'exam_paper (a question paper), mark_scheme, notes or other.' };

export const TOOLS = [
  {
    name: 'library_upload_link',
    module: 'library',
    description: 'Makes a one-time link for adding photos or files to the student\'s own Study Hub library, when they want to add photos they took (of an exam paper, a mark scheme or notes) or files on their device. '
      + 'You cannot pass photos into the hub yourself: give them this link to tap; it opens an upload screen (no sign-in) where they take or choose the photos. The link works for an hour, up to 30 files. '
      + 'Then, for an exam paper, offer to make it into an exam they can sit on screen (library_read it, then exam_make).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      kind: KIND_PROP, title: { type: 'string', maxLength: 120, description: 'A name, e.g. "AQA Biology Paper 1 June 2023".' },
      subject: { type: 'string', description: 'Their subject (name), optional.' } } },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(env, user, args, ctx) {
      const kind = args.kind || 'exam_paper';
      const { token } = await createUploadLink(env, user, { kind, title: args.title, subject: args.subject });
      const origin = (ctx && ctx.origin) || env.HUB_ORIGIN || '';
      return { url: `${origin}/#up/${token}`, works_for_minutes: UPLOAD_LINK_MS / 60_000, files: UPLOAD_LINK_FILES, kind,
        say: `Tap this link to add ${KIND_WORD[kind]}: ${origin}/#up/${token} . Take a photo of each page (or choose them), in order. It works for an hour.` };
    },
  },
  {
    name: 'library_add_link',
    module: 'library',
    description: 'Adds a PDF from the web to the student\'s own library (an exam paper, a mark scheme, notes). Give the PDF\'s https link. If the link is a web page, the hub lists the PDF links on it (pdf_links): pick the right one and call again. '
      + 'Use your own web search to find past papers when they ask (the exam board\'s site, or a revision site), and add the question paper and its mark scheme as two documents. '
      + 'Then offer to make it into an exam (library_read, then exam_make).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['url'], properties: {
      url: { type: 'string', description: 'An https link to the PDF (or to a page that lists PDFs).' },
      kind: KIND_PROP, title: { type: 'string', maxLength: 120, description: 'A clear name, e.g. "AQA Biology Paper 1 June 2023 mark scheme".' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (env, user, args, ctx) => addFromLink(env, user, { url: args.url, kind: args.kind || 'exam_paper', title: args.title }, ctx),
  },
  {
    name: 'exam_make',
    module: 'exams',
    description: 'Turns an exam paper PDF in the student\'s library into an exam they sit on screen in their Study Hub (Exams): the PDF pages, a timer and an answer box for every question. '
      + 'First library_read the paper (and its mark scheme if they have it) to list every question part that earns marks: its label as printed (e.g. 1(a), 3(b)(ii)), its marks and its page. '
      + 'text is a few words saying what the part asks (the PDF shows the real question). topic is the topic it tests, in their topic names when you can. '
      + 'When there is a mark scheme, add scheme: the marking points for each part in short, one point per mark where the scheme allows. Then tell them it is ready under Exams.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['doc_id', 'subject', 'questions'], properties: {
      doc_id: { type: 'string', description: 'The exam paper in their library (library_read lists documents).' },
      subject: { type: 'string', description: 'Their subject, by name.' },
      title: { type: 'string', maxLength: 120 },
      minutes: { type: 'integer', description: 'Time allowed, from the front cover (e.g. 120).' },
      scheme_doc_id: { type: 'string', description: 'The mark scheme document, if they have one.' },
      questions: { type: 'array', minItems: 1, maxItems: MAX_QUESTIONS, items: { type: 'object', additionalProperties: false, required: ['label', 'marks'], properties: {
        label: { type: 'string', maxLength: 16 }, marks: { type: 'integer' }, page: { type: 'integer', description: 'The PDF page the part is on.' },
        text: { type: 'string', maxLength: 300 }, topic: { type: 'string', maxLength: 80 } } } },
      scheme: { type: 'array', maxItems: MAX_QUESTIONS, items: { type: 'object', additionalProperties: false, required: ['label', 'points'], properties: {
        label: { type: 'string' }, points: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 20 } } } },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false },
    async run(env, user, args, ctx) {
      const r = await makeExam(env, user, args);
      const origin = (ctx && ctx.origin) || env.HUB_ORIGIN || '';
      return { ...r, open: `${origin}/#papers/${r.paper_id}`, say: `It is ready: open Exams in your Study Hub, or tap ${origin}/#papers/${r.paper_id} .` };
    },
  },
  {
    name: 'thinking_get',
    module: 'exams',
    description: 'Reads the student\'s recordings of their own thinking (what they said out loud while answering exam and practice paper questions), with the question, their answer, how sure they were and the marks. '
      + 'Use it when they say "analyse my thinking" or similar. Look for how they reason: do they read the command word, plan before writing, link to the marks available, check units, change their mind, guess, run out of time? '
      + 'Be kind and specific, quote their words briefly, give two or three things to keep and two or three to change. Then offer to save your feedback with thinking_note.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      paper_id: { type: 'string', description: 'One paper; leave out for the most recent recordings.' },
      limit: { type: 'integer', minimum: 1, maximum: 60 } } },
    annotations: { readOnlyHint: true },
    async run(env, user, args) {
      const items = await thinkingFor(env, user, { paper_id: args.paper_id || null, limit: Math.min(60, Math.max(1, Number(args.limit) || 30)) });
      return { recordings: items, note: items.length ? 'Their own words, transcribed. Analyse the reasoning, not the spelling.'
        : 'No recordings yet. On a paper in the hub, they press Record and talk through their thinking while they answer.' };
    },
  },
  {
    name: 'thinking_note',
    module: 'exams',
    description: 'Saves your feedback on the student\'s thinking beside the question (or the whole paper) in their Study Hub, so they can read it again later. Short, kind, specific.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['paper_id', 'feedback'], properties: {
      paper_id: { type: 'string' }, n: { type: 'integer', description: 'The question number (n from thinking_get); leave out for the whole paper.' },
      feedback: { type: 'string', maxLength: 1500 } } },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (env, user, args) => saveThinkingNote(env, user, args),
  },
];
