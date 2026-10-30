// Exams: question sets parsed in the browser (parser.js). Question text lives only here and in the browser.
import { HttpError, json, rawJson, readJson, rowJson, str, uuid, now } from './util.js';
import { first, run } from './db.js';
import { linkExam } from './plan.js';
import { figIds, attachStatements } from './images.js';

const MAX_BODY = 8_000_000;
const MAX_ROW = 1_950_000; // bytes of questions_json (D1's row limit is 2,000,000)

const LETTER = /^[A-Z]$/;

// The shape parser.js makes: {num, group, section, stem, lead, opts:[{l, t}], answer, expl}, optionally
// with oexpl {A: text, ...} (the source's explanation of each choice) and obj (the educational objective),
// CONTRACT I20. The key is one letter (or empty when the text had none); each option is a letter with its text.
export function checkQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) throw new HttpError(400, 'Please add at least one question.');
  if (questions.length > 2000) throw new HttpError(400, 'An exam can hold at most 2000 questions.');
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q !== 'object' || typeof q.stem !== 'string' || !Array.isArray(q.opts)) {
      throw new HttpError(400, `Question ${i + 1} is missing its text or options. Check the pasted questions and try again.`);
    }
    if (q.opts.some(o => !o || typeof o !== 'object' || typeof o.l !== 'string' || !LETTER.test(o.l) || typeof o.t !== 'string')) {
      throw new HttpError(400, `Question ${i + 1} has an answer choice that is not a letter A to Z with its text.`);
    }
    if (q.answer != null && q.answer !== '' && !(typeof q.answer === 'string' && LETTER.test(q.answer))) {
      throw new HttpError(400, `Question ${i + 1} has an answer key that is not one letter A to Z.`);
    }
    for (const k of ['lead', 'expl']) if (q[k] != null && typeof q[k] !== 'string') throw new HttpError(400, `Question ${i + 1} has a ${k} that is not text.`);
    if (q.obj != null && typeof q.obj !== 'string') throw new HttpError(400, `Question ${i + 1} has an educational objective that is not text.`);
    if (q.oexpl != null && (typeof q.oexpl !== 'object' || Array.isArray(q.oexpl) ||
      Object.entries(q.oexpl).some(([l, t]) => !LETTER.test(l) || typeof t !== 'string'))) {
      throw new HttpError(400, `Question ${i + 1} has choice explanations the hub cannot read (each must be a letter A to Z with its text).`);
    }
    if (q.figs != null && (!Array.isArray(q.figs) || q.figs.length > 12 || q.figs.some(f => !f || typeof f.id !== 'string' || !/^[0-9a-f-]{36}$/.test(f.id) ||
      typeof f.label !== 'string' || !['question', 'explanation'].includes(f.where)))) {
      throw new HttpError(400, `Question ${i + 1} has a picture list the hub cannot read.`);
    }
  }
}

export async function create(request, env) {
  const body = await readJson(request, MAX_BODY);
  const name = str(body.name, 200);
  if (!name) throw new HttpError(400, 'Please give the exam a name.');
  checkQuestions(body.questions);
  const text = JSON.stringify(body.questions);
  // D1 keeps at most 2 MB in one row; say so plainly instead of failing on the insert.
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_ROW) {
    throw new HttpError(413, `This exam is too large to save in one piece (${(bytes / 1e6).toFixed(1)} MB with its explanations; the limit is about 2 MB). Save it as two exams, for example blocks 1-2 and blocks 3-4.`);
  }
  const id = uuid();
  const attach = await attachStatements(env, id, figIds(body.questions));
  await env.DB.batch([
    env.DB.prepare('INSERT INTO exams (id, name, created_at, question_count, questions_json) VALUES (?, ?, ?, ?, ?)')
      .bind(id, name, now(), body.questions.length, text),
    ...attach,
  ]);
  await linkExam(env, id, name);
  return json({ id });
}

// The answer fields "Add answers" may change on a saved exam (CONTRACT I21); everything else stays as stored.
const ANSWER_FIELDS = ['answer', 'expl', 'oexpl', 'obj'];
const sameOpts = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((o, i) => o.l === b[i].l && o.t === b[i].t);

// PUT /api/exams/:id {questions}: answers, explanations, per-choice explanations and objectives added to a
// saved exam (Library "Add answers"). Checked like POST /api/exams; the questions themselves (count, numbers,
// stems, lead-ins, choices) must be the saved ones, and the saved pictures, id and sittings are kept.
export async function putAnswers(request, env, ctx, { id }) {
  const body = await readJson(request, MAX_BODY);
  checkQuestions(body.questions);
  const row = await first(env, 'SELECT questions_json FROM exams WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'That exam was not found.');
  const saved = JSON.parse(row.questions_json);
  const sent = body.questions;
  if (sent.length !== saved.length) {
    throw new HttpError(409, `This exam has ${saved.length} questions but ${sent.length} were sent. Only answers can be added to a saved exam.`);
  }
  const merged = saved.map((q, i) => {
    const n = sent[i];
    if (n.num !== q.num || n.stem !== q.stem || (n.lead || '') !== (q.lead || '') || !sameOpts(n.opts, q.opts)) {
      throw new HttpError(409, `Question ${q.num ?? i + 1} is not the same as in the saved exam. Only answers and explanations can be added to a saved exam.`);
    }
    const out = { ...q };
    for (const k of ANSWER_FIELDS) {
      if (n[k] == null || n[k] === '' || (k === 'oexpl' && !Object.keys(n[k]).length)) delete out[k];
      else out[k] = n[k];
    }
    if (out.answer === undefined) out.answer = null;
    if (out.expl === undefined) out.expl = '';
    return out;
  });
  const text = JSON.stringify(merged);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_ROW) {
    throw new HttpError(413, `With these explanations the exam is too large to save in one piece (${(bytes / 1e6).toFixed(1)} MB; the limit is about 2 MB). Save the answers to fewer questions, or add the exam again as two exams.`);
  }
  await run(env, 'UPDATE exams SET questions_json = ? WHERE id = ?', text, id);
  return json({ id, answered: merged.filter(q => q.answer).length, explained: merged.filter(q => q.oexpl && Object.keys(q.oexpl).length).length, question_count: merged.length });
}

export async function get(request, env, ctx, { id }) {
  const row = await first(env, 'SELECT id, name, created_at, question_count, questions_json FROM exams WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'That exam was not found.');
  return rawJson(rowJson(row, { questions_json: 'questions' }));
}

export async function remove(request, env, ctx, { id }) {
  const used = await first(env, 'SELECT count(*) AS n FROM sittings WHERE exam_id = ?', id);
  if (used && used.n > 0) {
    throw new HttpError(409, `This exam is used by ${used.n} sitting${used.n === 1 ? '' : 's'}. Delete ${used.n === 1 ? 'it' : 'them'} first.`);
  }
  const [r] = await env.DB.batch([
    env.DB.prepare('DELETE FROM exams WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM exam_images WHERE exam_id = ?').bind(id),
  ]);
  if (!r.meta || !r.meta.changes) throw new HttpError(404, 'That exam was not found.');
  return json({ ok: true });
}
