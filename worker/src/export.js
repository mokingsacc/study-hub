// Export everything as one JSON download; import the same shape back (upsert). Rows are column-faithful
// (JSON columns stay JSON text), so neither direction parses the big question arrays. Pictures (exam_images)
// are left out: they would not fit in one Worker's memory, and they come back by uploading the PDFs again.
// The hub's own tables are listed here; the map's come from the area registries (EXPORT), read per call.
// Both directions stay within Workers Free's 50 queries: the export reads every table in one batch, and
// the import writes up to 150 rows per statement (json_each) and 50 statements per batch.
import { HttpError, json, readJson, now, safeParse } from './util.js';
import { exportTables } from './map/registry/index.js';
import { checkQuestions } from './exams.js';
import { EXAM_TYPES, VOICE_MODES, TIMINGS } from './sittings.js';
import { CMS_SUBJECTS } from './plan.js';
import { MODES as UW_MODES } from './uworld.js';
import { SOURCES as GAP_SOURCES, GAP_VERDICTS } from './gaps.js';
import { DEVICES, STATUSES, CARD_VERDICTS } from './spoken.js';
import { OUTBOX_KINDS } from './outbox.js';

export const TABLES = {
  exams: ['id', 'name', 'created_at', 'question_count', 'questions_json'],
  sittings: ['id', 'name', 'kind', 'exam_id', 'external_label', 'scheduled_date', 'preset', 'block_size', 'block_minutes', 'break_minutes', 'voice_mode', 'status', 'score_pct', 'official_score', 'notes', 'created_at', 'finished_at', 'exam_type', 'timing'],
  blocks: ['id', 'sitting_id', 'idx', 'q_from', 'q_to', 'state_json', 'started_at', 'ended_at', 'correct', 'scored'],
  transcripts: ['block_id', 'q_index', 'segments_json', 'text', 'flags_json'],
  analyses: ['block_id', 'q_index', 'status', 'verdict', 'flaw_kind', 'error_type', 'error_confirmed', 'paraphrase', 'gap', 'mo_quote', 'cleaned_transcript', 'spoken_answer', 'topic', 'system', 'rule', 'look_alike', 'mehlman_note', 'mehlman_src', 'card_json', 'card_decision', 'existing_card_json', 'agreement', 'checker_json', 'decided_by', 'mo_override', 'error', 'created_at', 'decided_at', 'attempts'],
  outbox: ['id', 'kind', 'idem_key', 'payload_json', 'status', 'attempts', 'last_error', 'result_json', 'created_at', 'done_at'],
  usage: ['day', 'usd', 'calls', 'input_tokens', 'output_tokens', 'whisper_seconds'],
  settings: ['key', 'value'],
  uworld_log: ['id', 'day', 'n', 'kind', 'created_at'],
  cms_log: ['id', 'subject', 'form', 'score_pct', 'day', 'created_at'],
  uworld_blocks: ['id', 'day', 'mode', 'minutes', 'count', 'segments_json', 'manual_json', 'results_json', 'questions_json', 'words', 'created_at', 'updated_at'],
  // The columns after created_at come with 0010_map.sql (the map's view of each gap); step and confidence with 0035.
  gaps: ['id', 'at', 'day', 'source', 'card_id', 'note_id', 'ref', 'topic', 'gap', 'said', 'error_type', 'verdict', 'created_at',
    'user_id', 'origin', 'topic_id', 'sitting_id', 'held', 'map_state', 'mapped_at', 'mixed_with', 'step', 'confidence'],
  // cards_json (card text kept only until a session is checked) is never exported.
  anki_sessions: ['id', 'device', 'day', 'started_at', 'ended_at', 'segments_json', 'events_json', 'words', 'status', 'attempts', 'last_error', 'created_at', 'updated_at'],
  anki_cards: ['session_id', 'n', 'card_id', 'note_id', 'deck', 'tags', 'shown_at', 'revealed_at', 'answered_at', 'ease', 'before_json', 'after_json', 'words', 'verdict', 'error_type', 'gap', 'said', 'topic', 'checked_by'],
};
const REQUIRED = { exams: ['id', 'name', 'created_at', 'question_count', 'questions_json'], sittings: ['id', 'name', 'kind', 'created_at'], blocks: ['id', 'sitting_id', 'idx', 'q_from', 'q_to'], transcripts: ['block_id', 'q_index', 'segments_json', 'text'], analyses: ['block_id', 'q_index'], outbox: ['id', 'kind', 'idem_key', 'payload_json', 'created_at'], usage: ['day'], settings: ['key', 'value'],
  uworld_log: ['id', 'day', 'n', 'created_at'], cms_log: ['id', 'subject', 'form', 'day', 'created_at'],
  uworld_blocks: ['id', 'day', 'mode', 'segments_json', 'manual_json', 'results_json', 'words', 'created_at', 'updated_at'],
  gaps: ['id', 'at', 'day', 'source', 'gap', 'verdict', 'created_at'], anki_sessions: ['id', 'device', 'day', 'started_at', 'segments_json', 'events_json', 'status', 'created_at', 'updated_at'],
  anki_cards: ['session_id', 'n', 'card_id'] };

// Column types for import: t text, i whole number, r number, d a day (YYYY-MM-DD), j JSON text (any),
// ja JSON list, jo JSON object, or a list of allowed values. Anything else in a row is refused before a single row is written.
const T = 't', I = 'i', R = 'r';
const TYPES = {
  exams: { id: T, name: T, created_at: I, question_count: I, questions_json: 'ja' },
  sittings: { id: T, name: T, kind: ['hub', 'external'], exam_id: T, external_label: T, scheduled_date: T, preset: ['exam_day', 'nbme', 'free120', 'custom'],
    block_size: I, block_minutes: I, break_minutes: I, voice_mode: VOICE_MODES, status: ['scheduled', 'in_progress', 'done'], score_pct: R,
    official_score: I, notes: T, created_at: I, finished_at: I, exam_type: EXAM_TYPES, timing: TIMINGS },
  blocks: { id: T, sitting_id: T, idx: I, q_from: I, q_to: I, state_json: 'jo', started_at: I, ended_at: I, correct: I, scored: I },
  transcripts: { block_id: T, q_index: I, segments_json: 'ja', text: T, flags_json: 'ja' },
  analyses: { block_id: T, q_index: I, status: ['pending', 'running', 'done', 'error'], verdict: ['wrong', 'right_flawed', 'sound', 'no_reasoning_heard'],
    card_decision: ['pending', 'yes', 'no', 'edited', 'existing'], card_json: 'j', existing_card_json: 'j', checker_json: 'j',
    mo_override: ['sound'], created_at: I, decided_at: I, attempts: I },
  outbox: { id: T, kind: OUTBOX_KINDS, idem_key: T, payload_json: 'jo', status: ['pending', 'sending', 'done', 'failed'], attempts: I,
    last_error: T, result_json: 'j', created_at: I, done_at: I },
  usage: { day: T, usd: R, calls: I, input_tokens: I, output_tokens: I, whisper_seconds: R },
  settings: { key: T, value: 'j' },
  uworld_log: { id: T, day: T, n: I, kind: ['first_pass', 'incorrect'], created_at: I },
  cms_log: { id: T, subject: CMS_SUBJECTS, form: T, score_pct: R, day: T, created_at: I },
  uworld_blocks: { id: T, day: T, mode: UW_MODES, minutes: I, count: I, segments_json: 'ja', manual_json: 'ja', results_json: 'jo', questions_json: 'ja', words: I, created_at: I, updated_at: I },
  gaps: { id: T, at: I, day: T, source: GAP_SOURCES, card_id: I, note_id: I, ref: T, topic: T, gap: T, said: T, error_type: T, verdict: GAP_VERDICTS, created_at: I,
    user_id: T, origin: ['stated', 'review'], topic_id: T, sitting_id: T, held: [0, 1], map_state: ['placed', 'queued'], mapped_at: I, mixed_with: T,
    step: ['recognise', 'distinguish', 'test', 'treat', 'trap'], confidence: ['sure', 'lean', 'guess'] },
  anki_sessions: { id: T, device: DEVICES, day: T, started_at: I, ended_at: I, segments_json: 'ja', events_json: 'ja', words: I, status: STATUSES, attempts: I, last_error: T, created_at: I, updated_at: I },
  anki_cards: { session_id: T, n: I, card_id: I, note_id: I, deck: T, tags: 'ja', shown_at: I, revealed_at: I, answered_at: I, ease: I, before_json: 'ja', after_json: 'ja', words: I, verdict: CARD_VERDICTS, error_type: T, gap: T, said: T, topic: T, checked_by: T },
};

function checkValue(t, col, v, type) {
  if (v == null) return;
  const bad = () => { throw new HttpError(400, `A row in ${t} has an invalid ${col}.`); };
  if (Array.isArray(type)) { if (!type.includes(v)) bad(); return; }
  if (type === T) { if (typeof v !== 'string') bad(); return; }
  if (type === I) { if (!Number.isInteger(v)) bad(); return; }
  if (type === R) { if (typeof v !== 'number' || !Number.isFinite(v)) bad(); return; }
  if (type === 'd') { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad(); return; }
  const parsed = typeof v === 'string' ? safeParse(v, undefined) : undefined;
  if (parsed === undefined) bad();
  if (type === 'ja' && !Array.isArray(parsed)) bad();
  if (type === 'jo' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) bad();
}

// Every exported table as {table: {cols, required, types, check?}}: the hub's own first, then the map's.
export function allTables() {
  const out = {};
  for (const [t, cols] of Object.entries(TABLES)) out[t] = { cols, required: REQUIRED[t] || [], types: TYPES[t] || {} };
  for (const [t, spec] of Object.entries(exportTables())) {
    if (t in out || !spec || !Array.isArray(spec.cols)) continue;
    out[t] = { cols: spec.cols, required: spec.required || [], types: spec.types || {}, check: spec.check };
  }
  return out;
}

export function checkRow(t, row, spec = allTables()[t]) {
  if (!spec) throw new HttpError(400, `The file has an unknown table ${t}.`);
  for (const c of spec.cols) if (c in row) checkValue(t, c, row[c], spec.types[c] || T);
  if (spec.check) spec.check(row);
  if (t === 'exams') {
    checkQuestions(JSON.parse(row.questions_json));
    if (row.question_count !== JSON.parse(row.questions_json).length) throw new HttpError(400, 'An exam in the file has the wrong question count.');
  }
  if (['usage', 'uworld_log', 'cms_log', 'uworld_blocks', 'gaps', 'anki_sessions'].includes(t) && !/^\d{4}-\d{2}-\d{2}$/.test(row.day)) throw new HttpError(400, `A ${t} row has an invalid day.`);
  if (t === 'uworld_log' && !(row.n >= 1 && row.n <= 2400)) throw new HttpError(400, 'A uworld_log row has an invalid count.');
  if (t === 'cms_log' && row.score_pct != null && !(row.score_pct >= 0 && row.score_pct <= 100)) throw new HttpError(400, 'A cms_log row has an invalid score.');
  if (t === 'blocks' && row.q_to < row.q_from) throw new HttpError(400, 'A block in the file ends before it starts.');
}

// Each table's rows with only its listed columns (SELECT * so a column a migration has not added yet is
// simply absent). One batch for all tables; if it fails (a table not created yet), table by table, and a
// missing table is named in the file instead of failing the backup.
export async function exportAll(request, env) {
  const specs = allTables();
  const names = Object.keys(specs);
  const select = t => env.DB.prepare(`SELECT * FROM ${t}`);
  let results = null;
  try { results = await env.DB.batch(names.map(select)); } catch (e) { console.error('export batch failed, reading table by table', e && e.message); }
  // A table not created yet: ask which tables exist (one query), then read those in one batch, so an older database
  // still exports within the free plan's 50 queries however many tables the registries add.
  let present = null;
  if (!results) {
    try {
      const have = new Set(((await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).results || []).map(r => r.name));
      const list = names.filter(t => have.has(t));
      const res = list.length ? await env.DB.batch(list.map(select)) : [];
      present = new Map(list.map((t, i) => [t, res[i].results || []]));
    } catch (e) { console.error('export by present tables failed, reading table by table', e && e.message); }
  }
  const tables = {};
  const missing = [];
  for (let i = 0; i < names.length; i++) {
    const t = names[i];
    let rows;
    if (results) rows = results[i].results || [];
    else if (present) {
      if (!present.has(t)) { missing.push(t); continue; }
      rows = present.get(t);
    }
    else {
      try { rows = (await select(t).all()).results || []; } catch (e) {
        if (/no such table/i.test(String(e && e.message))) { missing.push(t); continue; }
        throw e;
      }
    }
    const cols = specs[t].cols;
    tables[t] = rows.map(r => { const o = {}; for (const c of cols) if (c in r) o[c] = r[c]; return o; });
  }
  const name = `practice-hub-${new Date().toISOString().slice(0, 10)}.json`;
  // AUD-022: the records only. Library PDFs and their page text live in R2 and the library tables' files, not here.
  const body = { version: 1, exported_at: now(), note: 'The hub\'s records. Library PDFs and their pages are not in this file: add the original files to the Library again after a restore.', tables };
  if (missing.length) body.missing_tables = missing;
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
  });
}

export const BULK_ROWS = 150;
export const BULK_CHARS = 400_000;
export const BATCH_SIZE = 50;

// Spend is never lowered by an import (an old file must not reset today's cap): keep the larger figure.
function conflictClause(t, cols) {
  if (t !== 'usage') return '';
  const upd = cols.filter(c => c !== 'day').map(c => `${c} = max(usage.${c}, excluded.${c})`);
  return ` ON CONFLICT(day) DO ${upd.length ? 'UPDATE SET ' + upd.join(', ') : 'NOTHING'}`;
}

// The insert statements for one table's checked rows: rows with the same columns go together, up to
// BULK_ROWS rows or BULK_CHARS characters per statement through json_each; a row bigger than that on its
// own (an exam's questions) is bound directly, so its text is never escaped twice.
export function insertStatements(env, t, rows) {
  const verb = t === 'usage' ? 'INSERT' : 'INSERT OR REPLACE';
  const groups = new Map();
  for (const row of rows) {
    const cols = Object.keys(row);
    const key = cols.join(',');
    if (!groups.has(key)) groups.set(key, { cols, rows: [] });
    groups.get(key).rows.push(row);
  }
  const stmts = [];
  for (const { cols, rows: grp } of groups.values()) {
    const list = cols.join(', ');
    const single = row => env.DB.prepare(`${verb} INTO ${t} (${list}) VALUES (${cols.map(() => '?').join(', ')})${conflictClause(t, cols)}`)
      .bind(...cols.map(c => row[c]));
    const bulkSql = `${verb} INTO ${t} (${list}) SELECT ${cols.map(c => `json_extract(value, '$."${c}"')`).join(', ')} FROM json_each(?) WHERE true${conflictClause(t, cols)}`;
    let chunk = [], size = 0;
    const flush = () => {
      if (chunk.length === 1) stmts.push(single(chunk[0].row));
      else if (chunk.length) stmts.push(env.DB.prepare(bulkSql).bind('[' + chunk.map(x => x.text).join(',') + ']'));
      chunk = []; size = 0;
    };
    for (const row of grp) {
      const text = JSON.stringify(row);
      if (chunk.length && (chunk.length >= BULK_ROWS || size + text.length > BULK_CHARS)) flush();
      chunk.push({ row, text });
      size += text.length;
    }
    flush();
  }
  return stmts;
}

export async function importAll(request, env) {
  const body = await readJson(request, 30_000_000);
  if (body.version !== 1 || !body.tables || typeof body.tables !== 'object') throw new HttpError(400, 'That file is not a Practice Hub export.');
  const specs = allTables();
  const counts = {};
  const stmts = [];
  // Every row of every table is checked before a single row is written.
  for (const [t, spec] of Object.entries(specs)) {
    const rows = body.tables[t];
    if (rows == null) continue;
    if (!Array.isArray(rows)) throw new HttpError(400, `The ${t} part of the file is not a list.`);
    const clean = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw new HttpError(400, `A row in ${t} is not valid.`);
      for (const r of spec.required) if (row[r] == null) throw new HttpError(400, `A row in ${t} is missing ${r}.`);
      const out = {};
      for (const c of spec.cols) if (c in row) out[c] = row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c];
      checkRow(t, out, spec);
      clean.push(out);
    }
    stmts.push(...insertStatements(env, t, clean));
    counts[t] = rows.length;
  }
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) await env.DB.batch(stmts.slice(i, i + BATCH_SIZE));
  return json({ ok: true, imported: counts });
}
