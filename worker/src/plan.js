import { HttpError, json, readJson, str, int, uuid, now, londonDay, safeParse } from './util.js';
import { all, first, run, getSettings, setSetting, defaultSettings } from './db.js';
import { trackHook, isAutoId, SETTINGS_KEY as TRACK_KEY } from './uworld-track.js';
import { addDays as addDaysIso } from '../../public/js/hub/plan-maths.js';

export const CMS_FORMS = {
  'Internal Medicine': 8, Surgery: 8, OBGYN: 8, Pediatrics: 8, Neurology: 8, Psychiatry: 7, 'Family Medicine': 5, 'Emergency Medicine': 3,
};
export const CMS_SUBJECTS = Object.keys(CMS_FORMS);
export const UWORLD_KINDS = ['first_pass', 'incorrect'];

const ext = (name, scheduled_date, exam_type, more = {}) => ({
  name, kind: 'external', exam_type, scheduled_date, external_label: exam_type === 'uwsa' ? 'On UWorld' : 'On nbme.org', ...more,
});
const free120 = (year, scheduled_date, notes) => ({
  name: `Free 120 (${year})`, kind: 'hub', exam_type: 'free120', scheduled_date, preset: 'free120', block_size: 20, block_minutes: 30, break_minutes: 25, notes,
});
export const NOTE_21_NOV = 'Decision day: keep exam day unless your predicted score is under your target and still rising ($35 to move until today, $100 after).';
export const NOTE_28_NOV = 'Real 30-minute rhythm. Rehearse the 55-minute break plan: 2-3 min between most blocks, about 15 min mid-day. Review it on Monday.';
export const NOTE_12_DEC = 'Full day on 30-minute blocks: UWSA 3, then Free 120 (2023). 2-3 min between most blocks, about 15 min mid-day. Review it on Monday.';
export const NOTE_16_DEC = 'Last practice test, 6 days out (when NBME 16 predicts best). Review it in the afternoon.';
const ON_UWORLD = 'On UWorld (8 blocks of 20, 30 min each)';

export const SEED = [
  ext('UWSA 1', '2027-03-29', 'uwsa', { status: 'done', official_score: 238, timing: 'loose' }),
  ext('NBME 10', '2027-05-02', 'nbme'),
  ext('NBME 11', '2027-05-16', 'nbme'),
  ext('NBME 12', '2027-05-30', 'nbme', { notes: NOTE_21_NOV }),
  ext('NBME 13', '2027-06-10', 'nbme'),
  ext('NBME 14', '2027-06-13', 'nbme'),
  ext('UWSA 2', '2027-06-06', 'uwsa', { external_label: ON_UWORLD, block_size: 20, block_minutes: 30, notes: NOTE_28_NOV }),
  free120(2021, '2027-06-06', NOTE_28_NOV),
  ext('NBME 15', '2027-06-17', 'nbme'),
  ext('UWSA 3', '2027-06-20', 'uwsa', { external_label: ON_UWORLD, block_size: 20, block_minutes: 30, notes: NOTE_12_DEC }),
  free120(2023, '2027-06-20', NOTE_12_DEC),
  ext('NBME 16', '2027-06-24', 'nbme', { notes: NOTE_16_DEC }),
];
// The v1 plan (seeded before 20 Oct 2026 evening), by name and date: only used to find its rows.
export const SEED_V1 = [
  ['UWSA 1', '2027-03-29'], ['NBME 9', '2027-05-02'], ['NBME 10', '2027-05-09'], ['NBME 11', '2027-05-16'], ['NBME 12', '2027-05-23'],
  ['Free 120 (2019)', '2027-05-23'], ['NBME 13', '2027-05-30'], ['NBME 14', '2027-06-06'], ['Free 120 (2021)', '2027-06-06'],
  ['UWSA 2', '2027-06-13'], ['NBME 15', '2027-06-20'], ['Free 120 (2023)', '2027-06-20'], ['NBME 16', '2027-06-24'],
].map(([name, scheduled_date]) => ({ name, scheduled_date }));
export const PLAN_VERSION = 4;

export const V4_DATES = {
  'NBME 11': '2027-05-16', 'NBME 12': '2027-05-30', 'UWSA 2': '2027-06-06', 'Free 120 (2021)': '2027-06-06',
  'NBME 13': '2027-06-10', 'NBME 14': '2027-06-13', 'NBME 15': '2027-06-17', 'UWSA 3': '2027-06-20', 'Free 120 (2023)': '2027-06-20',
  'NBME 16': '2027-06-24',
};
export const V4_UWORLD_FINISH = '2027-06-08';
const SILENT_FROM = '2027-06-06'; // full practice exams from here suggest confidence only (as hub/util.js)

export const sameName = (a, b) => String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '') === String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Started, done or scored: such a sitting is never moved, changed or removed by the plan. */
export const isFixed = (x, started = new Set()) => x.status !== 'scheduled' || x.score_pct != null || x.official_score != null || started.has(x.id);
/** A seed entry is there when a sitting of that name is on its date, or that form was already started or done. */
export const seedPresent = (e, sittings, started = new Set()) =>
  sittings.some(h => sameName(h.name, e.name) && (h.scheduled_date === e.scheduled_date || isFixed(h, started)));
const startedSet = async env => new Set((await all(env, 'SELECT DISTINCT sitting_id FROM blocks')).map(b => b.sitting_id));

export async function seedPlan(env, { again = false } = {}) {
  if (!again) {
    const claim = await run(env, "INSERT OR IGNORE INTO settings (key, value) VALUES ('plan_seeded', ?)", JSON.stringify(now()));
    if (!claim.meta || !claim.meta.changes) return { added: 0, already: true };
  }
  const [settings, exams, have, started] = await Promise.all([
    getSettings(env),
    all(env, 'SELECT id, name FROM exams ORDER BY created_at DESC'),
    all(env, 'SELECT id, name, scheduled_date, status, score_pct, official_score FROM sittings'),
    startedSet(env),
  ]);
  const t = now();
  let added = 0;
  for (let i = 0; i < SEED.length; i++) {
    const s = SEED[i];
    if (seedPresent(s, have, started)) continue;
    const row = { ...seedRow(s, settings, exams), id: uuid(), created_at: t + i };
    const keys = Object.keys(row);
    const r = await run(env, `INSERT INTO sittings (${keys.join(', ')}) SELECT ${keys.map(() => '?').join(', ')}
      WHERE NOT EXISTS (SELECT 1 FROM sittings WHERE scheduled_date = ? AND lower(name) = lower(?))`, ...keys.map(k => row[k]), row.scheduled_date, row.name);
    if (r.meta && r.meta.changes) added++;
  }
  if (again) await run(env, "INSERT OR IGNORE INTO settings (key, value) VALUES ('plan_seeded', ?)", JSON.stringify(t));
  return { added };
}

// The columns a seed entry sets (status and score only for UWSA 1, which is seeded done).
const SEED_COLS = ['name', 'kind', 'exam_type', 'scheduled_date', 'external_label', 'preset', 'block_size', 'block_minutes', 'break_minutes', 'notes', 'timing'];
function seedRow(s, settings, exams) {
  const row = { status: 'scheduled', timing: 'strict', external_label: null, preset: null, block_size: null, block_minutes: null, break_minutes: null, notes: null, ...s };
  if (row.kind === 'hub') {
    const exam = exams.find(e => sameName(e.name, row.name));
    row.exam_id = exam ? exam.id : null;
    row.voice_mode = row.scheduled_date >= SILENT_FROM ? 'silent' : settings.default_voice_mode || 'quick';
  }
  return row;
}

const V1_SETTINGS = {
  uworld_finish_date: ['2027-05-26', '2027-05-29'],
  rest_days: [['2027-06-24', '2027-06-26', '2027-06-27', '2027-06-28', '2027-06-29'], ['2027-06-28', '2027-06-29']],
};

export async function reseedV2(env) {
  const [settings, exams, sittings, started] = await Promise.all([
    getSettings(env),
    all(env, 'SELECT id, name FROM exams ORDER BY created_at DESC'),
    all(env, 'SELECT * FROM sittings ORDER BY created_at'),
    startedSet(env),
  ]);
  const fixed = x => isFixed(x, started);
  const isV1 = x => SEED_V1.some(v => v.name !== 'UWSA 1' && v.scheduled_date === x.scheduled_date && sameName(v.name, x.name));
  const v1Rows = sittings.filter(isV1);
  const anchor = sittings.find(x => sameName(x.name, 'UWSA 1') && x.scheduled_date === '2027-03-29');
  const base = anchor ? anchor.created_at : Date.UTC(2026, 9, 20, 12);
  const NOT_STARTED = "status = 'scheduled' AND score_pct IS NULL AND official_score IS NULL AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.sitting_id = sittings.id)";
  const used = new Set();
  const out = { updated: 0, removed: 0, settings: 0 };
  for (let i = 0; i < SEED.length; i++) {
    const e = SEED[i];
    if (sameName(e.name, 'UWSA 1')) continue;
    const same = sittings.filter(x => sameName(x.name, e.name));
    same.forEach(x => used.add(x.id));
    if (same.some(fixed)) continue; // already started or done: leave it
    const twin = same.find(x => isV1(x) && x.scheduled_date === e.scheduled_date) || same.find(isV1);
    if (!twin) continue;
    const want = seedRow(e, settings, exams);
    const set = {};
    for (const k of SEED_COLS) if (want[k] !== twin[k]) set[k] = want[k];
    if (e.kind === 'hub') {
      if (want.voice_mode !== twin.voice_mode) set.voice_mode = want.voice_mode;
      if (!twin.exam_id && want.exam_id) set.exam_id = want.exam_id;
    }
    if (twin.created_at !== base + i) set.created_at = base + i; // keeps the v2 order on a full day
    if (!Object.keys(set).length) continue;
    const keys = Object.keys(set);
    const r = await run(env, `UPDATE sittings SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ? AND ${NOT_STARTED}`, ...keys.map(k => set[k]), twin.id);
    if (r.meta && r.meta.changes) out.updated++;
  }
  for (const x of v1Rows) {
    if (used.has(x.id) || fixed(x)) continue;
    const r = await run(env, `DELETE FROM sittings WHERE id = ? AND ${NOT_STARTED}`, x.id);
    if (r.meta && r.meta.changes) out.removed++;
  }
  const stored = await all(env, `SELECT key, value FROM settings WHERE key IN (${Object.keys(V1_SETTINGS).map(() => '?').join(', ')})`, ...Object.keys(V1_SETTINGS));
  for (const row of stored) {
    const [was, becomes] = V1_SETTINGS[row.key];
    if (JSON.stringify(safeParse(row.value, row.value)) !== JSON.stringify(was)) continue;
    await run(env, 'UPDATE settings SET value = ? WHERE key = ? AND value = ?', JSON.stringify(becomes), row.key, row.value);
    out.settings++;
  }
  return out;
}

const V2_DAILY = { was: { uworld: 100, cms: 36, incorrects: 40 }, becomes: { uworld: 100, cms: 37, incorrects: 40 } };

export async function reseedV3(env) {
  const [settings, exams, sittings, started, seeded] = await Promise.all([
    getSettings(env),
    all(env, 'SELECT id, name FROM exams ORDER BY created_at DESC'),
    all(env, 'SELECT * FROM sittings ORDER BY created_at'),
    startedSet(env),
    first(env, "SELECT value FROM settings WHERE key = 'plan_seeded'"),
  ]);
  const fixed = x => isFixed(x, started);
  const NOT_STARTED = "status = 'scheduled' AND score_pct IS NULL AND official_score IS NULL AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.sitting_id = sittings.id)";
  const entry = name => SEED.find(e => sameName(e.name, name));
  const out = { updated: 0, added: 0, settings: 0 };
  const update = async (x, set) => {
    const keys = Object.keys(set).filter(k => set[k] !== x[k]);
    if (!keys.length) return;
    const r = await run(env, `UPDATE sittings SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ? AND ${NOT_STARTED}`, ...keys.map(k => set[k]), x.id);
    if (r.meta && r.meta.changes) out.updated++;
  };
  const nbme16 = sittings.filter(x => sameName(x.name, 'NBME 16'));
  const old16 = nbme16.find(x => x.scheduled_date === '2027-06-20');
  if (old16 && !nbme16.some(fixed)) {
    const e = entry('NBME 16');
    await update(old16, { scheduled_date: e.scheduled_date, notes: e.notes });
  }
  const f23 = sittings.find(x => sameName(x.name, 'Free 120 (2023)') && x.scheduled_date === '2027-06-20');
  if (f23 && !fixed(f23)) await update(f23, { notes: entry('Free 120 (2023)').notes });
  if (seeded && !sittings.some(x => sameName(x.name, 'UWSA 3'))) {
    const e = entry('UWSA 3');
    const row = { ...seedRow(e, settings, exams), id: uuid(), created_at: f23 ? f23.created_at - 1 : now() };
    const keys = Object.keys(row);
    const r = await run(env, `INSERT INTO sittings (${keys.join(', ')}) SELECT ${keys.map(() => '?').join(', ')}
      WHERE NOT EXISTS (SELECT 1 FROM sittings WHERE lower(name) = lower(?))`, ...keys.map(k => row[k]), row.name);
    if (r.meta && r.meta.changes) out.added++;
  }
  const daily = await first(env, "SELECT value FROM settings WHERE key = 'plan_daily'");
  if (daily && JSON.stringify(safeParse(daily.value, null)) === JSON.stringify(V2_DAILY.was)) {
    await run(env, 'UPDATE settings SET value = ? WHERE key = ? AND value = ?', JSON.stringify(V2_DAILY.becomes), 'plan_daily', daily.value);
    out.settings++;
  }
  return out;
}

export async function reseedV4(env) {
  const [sittings, started] = await Promise.all([all(env, 'SELECT * FROM sittings ORDER BY created_at'), startedSet(env)]);
  const NOT_STARTED = "status = 'scheduled' AND score_pct IS NULL AND official_score IS NULL AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocks.sitting_id = sittings.id)";
  const out = { updated: 0, settings: 0 };
  for (const x of sittings) {
    const name = Object.keys(V4_DATES).find(n => sameName(n, x.name));
    if (!name || isFixed(x, started) || x.scheduled_date === V4_DATES[name]) continue;
    const notes = name === 'NBME 12' ? NOTE_21_NOV : (x.notes === NOTE_21_NOV ? null : x.notes);
    const r = await run(env, `UPDATE sittings SET scheduled_date = ?, notes = ? WHERE id = ? AND ${NOT_STARTED}`, V4_DATES[name], notes, x.id);
    if (r.meta && r.meta.changes) out.updated++;
  }
  await setSetting(env, 'uworld_finish_date', V4_UWORLD_FINISH);
  const daily = await first(env, "SELECT value FROM settings WHERE key = 'plan_daily'");
  const d = daily ? safeParse(daily.value, {}) || {} : {};
  if (Number(d.uworld) !== 80) await setSetting(env, 'plan_daily', { ...defaultSettings().plan_daily, ...d, uworld: 80 });
  out.settings++;
  return out;
}

/**
 * Bring the database to PLAN_VERSION once: reseedV2 from v1, reseedV3 from v2, then reseedV4; skipped when settings.plan_version
 * is already current. The version is recorded after the work, so a run cut off half way is finished by the next
 * one. Never throws (the hub must still load).
 */
export async function ensurePlan(env) {
  try {
    const row = await first(env, "SELECT value FROM settings WHERE key = 'plan_version'");
    const v = row ? Number(safeParse(row.value, row.value)) || 1 : 1;
    if (v >= PLAN_VERSION) return null;
    const r = {};
    if (v < 2) r.v2 = await reseedV2(env);
    if (v < 3) r.v3 = await reseedV3(env);
    r.v4 = await reseedV4(env);
    await setSetting(env, 'plan_version', PLAN_VERSION);
    console.log('plan reseed', JSON.stringify(r));
    return r;
  } catch (e) {
    console.error('plan reseed failed', e && e.stack || e);
    return null;
  }
}

/** Link scheduled hub sittings with no exam to a newly added exam of the same name (exams.create). */
export async function linkExam(env, examId, name) {
  const open = await all(env, "SELECT id, name FROM sittings WHERE kind = 'hub' AND exam_id IS NULL AND status = 'scheduled'");
  for (const s of open) if (sameName(s.name, name)) await run(env, 'UPDATE sittings SET exam_id = ? WHERE id = ? AND exam_id IS NULL', examId, s.id);
}

const MISSES_DAYS = 14;
const UNSURE_DAYS = 7;
const QJ = "CASE WHEN json_valid(b.questions_json) THEN b.questions_json ELSE '[]' END";
const UNSURE_SQL = `SELECT count(*) AS n FROM (SELECT b.id, (SELECT count(*) FROM json_each(${QJ})) AS nq,
    (SELECT max(CAST(json_extract(j.value, '$.q') AS INTEGER)) FROM json_each(${QJ}) j) AS maxq
  FROM uworld_blocks b WHERE b.day >= ? AND b.id NOT LIKE 'shot-%' AND b.count IS NULL) WHERE nq = 0 OR nq < maxq`;

export async function get(request, env) {
  await ensurePlan(env);
  const since = now() - MISSES_DAYS * 86400_000;
  const [seeded, sittings, uworld, cms, misses, version, started, track, unsure] = await Promise.all([
    first(env, "SELECT value FROM settings WHERE key = 'plan_seeded'"),
    all(env, 'SELECT id, name, scheduled_date, status, score_pct, official_score FROM sittings'),
    all(env, 'SELECT id, day, n, kind, created_at FROM uworld_log ORDER BY day, created_at'),
    all(env, 'SELECT id, subject, form, score_pct, day, created_at FROM cms_log ORDER BY subject, form'),
    all(env, `SELECT a.system AS system, count(*) AS misses FROM analyses a
      WHERE a.created_at >= ? AND a.status = 'done' AND a.verdict = 'wrong' AND a.system IS NOT NULL GROUP BY a.system ORDER BY misses DESC, a.system`, since),
    first(env, "SELECT value FROM settings WHERE key = 'plan_version'"),
    startedSet(env),
    first(env, 'SELECT value FROM settings WHERE key = ?', TRACK_KEY),
    first(env, UNSURE_SQL, addDaysIso(londonDay(), -(UNSURE_DAYS - 1))).catch(() => null),
  ]);
  const missing = SEED.filter(s => !seedPresent(s, sittings, started)).length;
  return json({ seeded: !!seeded, seed_missing: missing, plan_version: version ? Number(safeParse(version.value, 1)) : 1, today: londonDay(), uworld, cms, misses_14d: misses, uworld_track: track ? safeParse(track.value, null) : null,
    uworld_unsure: unsure ? Number(unsure.n) || 0 : 0 });
}

export async function seed(request, env) {
  const body = await readJson(request);
  await ensurePlan(env); // never seed the current plan next to an unmoved older one
  return json(await seedPlan(env, { again: !!body.again }));
}

function day(v) {
  const d = v == null || v === '' ? londonDay() : str(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) throw new HttpError(400, 'Dates must look like 2027-06-30.');
  return d;
}

export async function addUworld(request, env) {
  const body = await readJson(request);
  const n = int(body.n, 'The number of UWorld questions', { min: 1, max: 2400, optional: false });
  const kind = body.kind == null || body.kind === '' ? 'first_pass' : String(body.kind);
  if (!UWORLD_KINDS.includes(kind)) throw new HttpError(400, 'kind must be first_pass or incorrect.');
  const row = { id: uuid(), day: day(body.day), n, kind, created_at: now() };
  await run(env, 'INSERT INTO uworld_log (id, day, n, kind, created_at) VALUES (?, ?, ?, ?, ?)', row.id, row.day, row.n, row.kind, row.created_at);
  await trackHook(env); // a typed count is one more source for its day, never on top of the same blocks
  return json(row);
}

export async function removeUworld(request, env, ctx, { id }) {
  if (isAutoId(id)) throw new HttpError(409, 'That count comes from your recorded blocks and UWorld screenshots. Use Adjust to change it.');
  const r = await run(env, 'DELETE FROM uworld_log WHERE id = ?', id);
  if (!r.meta || !r.meta.changes) throw new HttpError(404, 'That UWorld entry was not found.');
  await trackHook(env);
  return json({ ok: true });
}

export async function putCms(request, env) {
  const body = await readJson(request);
  const subject = String(body.subject || '');
  if (!CMS_FORMS[subject]) throw new HttpError(400, `Subject must be one of: ${CMS_SUBJECTS.join(', ')}.`);
  const form = String(int(body.form, 'The form number', { min: 1, max: CMS_FORMS[subject], optional: false }));
  let score = body.score_pct == null || body.score_pct === '' ? null : Number(body.score_pct);
  if (score != null && !(score >= 0 && score <= 100)) throw new HttpError(400, 'The score must be a percentage from 0 to 100.');
  if (score != null) score = Math.round(score * 10) / 10;
  const d = day(body.day);
  await run(env, `INSERT INTO cms_log (id, subject, form, score_pct, day, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(subject, form) DO UPDATE SET score_pct = excluded.score_pct, day = excluded.day`, uuid(), subject, form, score, d, now());
  return json(await first(env, 'SELECT id, subject, form, score_pct, day, created_at FROM cms_log WHERE subject = ? AND form = ?', subject, form));
}

export async function removeCms(request, env, ctx, { id }) {
  const r = await run(env, 'DELETE FROM cms_log WHERE id = ?', id);
  if (!r.meta || !r.meta.changes) throw new HttpError(404, 'That CMS form was not found.');
  return json({ ok: true });
}
