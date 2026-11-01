// Settings and the hub's start-up state. validateSettings is the one validator for hub settings: PUT
// /api/settings and the map's change op setting.set (Claude's hub_settings) both use it, with the same messages.
import { HttpError, json, readJson, str } from './util.js';
import { CHECK_MODES, BLOCK_JUDGES, PUBLIC_SETTINGS, all, cardsToday, getSettings, usageToday, usageMonth, hardCap } from './db.js';
import { VOICE_MODES } from './sittings.js';
import { ensurePlan } from './plan.js';
import { MO, currentUser, userRow, meOf, getPrefs } from './users.js';
import { isInternalSetting } from './map/guard.js';
import { prefsSchema } from './map/prefs.js';
import { jobsNow } from './map/recent.js';
import { costWeek } from './ai-cost.js';
import { _resetSwitch } from './debug/trace.js';

export async function state(request, env) {
  await ensurePlan(env); // once: a database on an older Saturday plan moves to the current one before anything is shown
  const user = await currentUser(env, request);
  const [exams, sittings, usage, settings, cards, month, me, jobs, week] = await Promise.all([
    all(env, 'SELECT id, name, question_count, created_at FROM exams ORDER BY created_at DESC'),
    all(env, 'SELECT * FROM sittings ORDER BY COALESCE(scheduled_date, \'9999\'), created_at'),
    usageToday(env),
    getSettings(env),
    cardsToday(env),
    usageMonth(env),
    userRow(env, user).catch(e => { console.error('state: user row', e && e.message); return null; }),
    // The bar's background-job chip (Recents, 27 Oct): one batch; never blocks the hub.
    jobsNow(env, user).then(j => j.summary, e => { console.error('state: jobs', e && e.message); return null; }),
    // The spend sheet's last 7 days per role, with the cache hit ratio (ai-cost.js); never blocks the hub.
    costWeek(env).catch(e => { console.error('state: ai week', e && e.message); return null; }),
  ]);
  // prefs: the user's ui_prefs over every registered default; me: who is using the hub (plan §14, §15).
  const prefs = await getPrefs(env, user, me || { prefs_json: {} }).catch(() => ({}));
  const features = { learn: env.LEARN === 'on', notes: env.NOTES === 'on', uk: env.UK === 'on', mnemonics: env.MNEMONICS === 'on', anking: env.ANKING === 'on' };
  return json({ features, exams, sittings, usage_today: { usd: Math.round(usage.usd * 10000) / 10000, calls: usage.calls },
    usage_month: { usd: Math.round(month.usd * 10000) / 10000, since: month.since }, settings, cards_today: cards,
    usage_week: week ? { usd: week.usd, calls: week.calls, hit: week.hit, batch_calls: week.batch_calls, batch_usd: week.batch_usd,
      roles: week.roles.slice(0, 6).map(r => ({ words: r.words, usd: r.usd, calls: r.calls, hit: r.hit })) } : null,
    prefs, jobs, map_features: { orbits: env.MAP_ORBITS === 'on', due_orbs: env.DUE_ORBS === 'on', mnemonics: env.MNEMONICS === 'on', anking: env.ANKING === 'on' }, me: meOf(me) || { id: user, name: user === MO ? 'Mo' : user, role: user === MO ? 'admin' : 'student', profile: 'step2' } });
}

export async function get(request, env) {
  return json(await getSettings(env));
}

/**
 * The hub settings a body asks for, checked: [[key, value], ...] in body order, with values cleaned
 * (the daily cap clamped to the hard cap, lists sorted and de-duplicated). Throws HttpError(400) with the
 * same plain message the Settings page has always shown. Pure apart from reading env's hard cap.
 */
export function validateSettings(body, env) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Nothing to change.');
  const writes = [];
  if ('daily_cap_usd' in body) {
    const v = Number(body.daily_cap_usd);
    if (!(v >= 0)) throw new HttpError(400, 'The daily spend cap must be 0 dollars or more.');
    writes.push(['daily_cap_usd', Math.min(v, hardCap(env))]); // never above the hub's hard cap
  }
  if ('monthly_cap_usd' in body) {
    const v = Number(body.monthly_cap_usd);
    if (!(v >= 0 && v <= 1000)) throw new HttpError(400, 'The monthly limit must be from 0 to 1000 dollars.');
    writes.push(['monthly_cap_usd', v]);
  }
  if ('check_mode' in body) {
    if (!CHECK_MODES.includes(body.check_mode)) throw new HttpError(400, 'Checks run in the desktop app or through the API.');
    writes.push(['check_mode', body.check_mode]);
  }
  if ('block_judge' in body) {
    if (!BLOCK_JUDGES.includes(body.block_judge)) throw new HttpError(400, 'UWorld blocks are judged in the chat (chat) or by the hub (hub).');
    writes.push(['block_judge', body.block_judge]);
  }
  if ('default_voice_mode' in body) {
    if (!VOICE_MODES.includes(body.default_voice_mode)) throw new HttpError(400, 'Voice mode must be quick, full or silent.');
    writes.push(['default_voice_mode', body.default_voice_mode]);
  }
  if ('onenote_section' in body) {
    const v = str(body.onenote_section, 100);
    if (!v) throw new HttpError(400, 'Please give the OneNote section name.');
    writes.push(['onenote_section', v]);
  }
  if ('cards_per_day_cap' in body) {
    const v = Number(body.cards_per_day_cap);
    if (!Number.isInteger(v) || v < 0 || v > 100) throw new HttpError(400, 'Cards per day must be a whole number from 0 to 100.');
    writes.push(['cards_per_day_cap', v]);
  }
  if ('deck' in body) {
    const v = str(body.deck, 100);
    if (!v) throw new HttpError(400, 'Please give the deck name.');
    writes.push(['deck', v]);
  }
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const whole = (k, label, min, max) => {
    const v = Number(body[k]);
    if (!Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}.`);
    return v;
  };
  if ('target_score' in body) writes.push(['target_score', whole('target_score', 'The target score', 200, 300)]);
  if ('uworld_total_left' in body) writes.push(['uworld_total_left', whole('uworld_total_left', 'UWorld questions left', 0, 5000)]);
  const noExam = 'exam_date' in body && (body.exam_date === '' || body.exam_date === null);
  for (const k of ['uworld_as_of', 'exam_date', 'plan_start', 'uworld_finish_date', 'phase2_end', 'cms_early_by']) {
    if (!(k in body)) continue;
    if (k === 'exam_date' && noExam) { writes.push(['exam_date', '']); continue; }
    if (!ISO.test(String(body[k] || ''))) throw new HttpError(400, 'Dates must look like 2027-06-30.');
    writes.push([k, body[k]]);
  }
  for (const [k, label] of [['rest_days', 'Rest days'], ['light_days', 'Light days']]) {
    if (!(k in body)) continue;
    const v = body[k];
    if (!Array.isArray(v) || v.length > 60 || !v.every(d => ISO.test(String(d)))) throw new HttpError(400, `${label} must be a list of dates like 2026-12-18.`);
    writes.push([k, [...new Set(v)].sort()]);
  }
  if ('off_weekdays' in body) {
    const v = body.off_weekdays;
    if (!Array.isArray(v) || !v.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) throw new HttpError(400, 'Days off each week must be a list of weekday numbers from 0 (Sunday) to 6 (Saturday).');
    writes.push(['off_weekdays', [...new Set(v)].sort((a, b) => ((a + 1) % 7) - ((b + 1) % 7))]);
  }
  if ('cms_weak_pct' in body) writes.push(['cms_weak_pct', whole('cms_weak_pct', 'The CMS weak bar', 0, 100)]);
  if ('cards_minutes' in body) writes.push(['cards_minutes', whole('cards_minutes', 'The Cards time box', 5, 120)]);
  if ('scoring_auto_switch' in body) {
    if (typeof body.scoring_auto_switch !== 'boolean') throw new HttpError(400, 'Switching to a better scoring rule by itself is on (true) or off (false).');
    writes.push(['scoring_auto_switch', body.scoring_auto_switch]);
  }
  if ('debug_capture' in body) {
    if (typeof body.debug_capture !== 'boolean') throw new HttpError(400, 'Capturing what went wrong for problem reports is on (true) or off (false).');
    writes.push(['debug_capture', body.debug_capture]);
  }
  if ('plan_daily' in body) {
    const v = body.plan_daily || {};
    const u = Number(v.uworld), c = Number(v.cms), i = Number(v.incorrects ?? 40);
    const ok = (x, max) => Number.isInteger(x) && x >= 0 && x <= max;
    if (!ok(u, 400) || !ok(c, 200) || !ok(i, 400)) throw new HttpError(400, 'The daily numbers must be whole numbers: UWorld 0 to 400, CMS 0 to 200, incorrects 0 to 400.');
    writes.push(['plan_daily', { uworld: u, cms: c, incorrects: i }]);
  }
  if (!writes.length) throw new HttpError(400, 'Nothing to change.');
  return writes;
}

export async function catchup(request, env) {
  const b = await readJson(request);
  const name = String(b.name || ''), version = String(b.version ?? '');
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(name) || !/^[\w.-]{1,40}$/.test(version)) throw new HttpError(400, 'Say which catch-up: a name and a version.');
  const key = `catchup_done:${name}:${version}`;
  if (b.done === true) await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind(key, JSON.stringify(Date.now())).run();
  const row = await env.DB.prepare('SELECT 1 AS done FROM settings WHERE key = ?').bind(key).first();
  return json({ name, version, done: !!row });
}

const UPSERT = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

export async function put(request, env) {
  const writes = validateSettings(await readJson(request), env);
  await env.DB.batch(writes.map(([k, v]) => env.DB.prepare(UPSERT).bind(k, JSON.stringify(v)))); // one query, all or none
  if (writes.some(([k]) => k === 'debug_capture')) _resetSwitch();   // this isolate reads the switch again at once
  return json(await getSettings(env));
}

// ---------------------------------------------------------------- setting.set (applyChange) and hub_settings

// How each public setting reads in a change line ("Daily spend cap: $30 → $20").
export const SETTING_LABELS = {
  daily_cap_usd: 'Daily spend cap', monthly_cap_usd: 'Monthly spend limit', default_voice_mode: 'Voice mode', onenote_section: 'OneNote section',
  cards_per_day_cap: 'Cards per day', deck: 'Deck', check_mode: 'Who checks reasoning', target_score: 'Target score',
  uworld_total_left: 'UWorld questions left', uworld_as_of: 'UWorld count date', exam_date: 'Exam date', rest_days: 'Rest days',
  light_days: 'Light days', off_weekdays: 'Days off each week', plan_daily: 'Daily numbers', plan_start: 'Plan start',
  uworld_finish_date: 'UWorld finish date', phase2_end: 'Phase 2 end', cms_early_by: 'Early CMS forms by', cms_weak_pct: 'CMS weak bar',
  cards_minutes: 'Cards time box (minutes)', scoring_auto_switch: 'Switch to a better scoring rule by itself',
  debug_capture: 'Capture for problem reports',
  block_judge: 'Who judges UWorld blocks',
};
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function settingText(key, v) {
  if (key === 'exam_date') return v || 'no exam set';
  if (v == null) return 'default';
  if (key.endsWith('_usd')) return `$${v}`;
  if (key === 'off_weekdays') return v.map(d => WEEKDAYS[d]).join(', ') || 'none';
  if (Array.isArray(v)) return v.length > 3 ? `${v.length} dates` : v.join(', ') || 'none';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (key === 'block_judge') return v === 'hub' ? 'the hub (API)' : 'Claude in the chat';
  if (key === 'plan_daily') return `UWorld ${v.uworld}, CMS ${v.cms}, incorrects ${v.incorrects}`;
  return String(v);
}
// A change line, never over the 160 characters map_events allows.
export function settingSummary(key, before, after) {
  const line = `${SETTING_LABELS[key] || key}: ${settingText(key, before)} → ${settingText(key, after)}`;
  return line.length <= 160 ? line : `${SETTING_LABELS[key] || key} changed`;
}

export async function planSetting(env, user, args) {
  if (user !== MO) return { refuse: "The hub's settings are Mo's." };
  for (const k of Object.keys(args)) if (!['key', 'value', 'values'].includes(k)) return { refuse: `Unknown argument ${k}.` };
  const body = args.values != null ? args.values : (args.key != null ? { [args.key]: args.value } : null);
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) return { refuse: 'Say which setting to change: key and value.' };
  if (Object.keys(body).length > 10) return { refuse: 'At most 10 settings in one call.' };
  for (const k of Object.keys(body)) {
    if (isInternalSetting(k)) return { refuse: 'That setting is kept by the hub itself.', field: k };
    if (!PUBLIC_SETTINGS.includes(k)) return { refuse: `There is no setting called ${k}. Ask for hub_settings get to see them.`, field: k };
  }
  const writes = validateSettings(body, env);
  const stored = new Map((await all(env, 'SELECT key, value FROM settings WHERE key IN (SELECT value FROM json_each(?))', JSON.stringify(writes.map(w => w[0]))))
    .map(r => [r.key, r.value]));
  const current = await getSettings(env);
  const rows = [], events = [], before = {};
  for (const [k, v] of writes) {
    const text = JSON.stringify(v);
    if (stored.get(k) === text || (!stored.has(k) && JSON.stringify(current[k]) === text)) continue;
    before[k] = current[k];
    rows.push(stored.has(k)
      ? { table: 'settings', op: 'update', key: { key: k }, before: { key: k, value: stored.get(k) }, after: { value: text } }
      : { table: 'settings', op: 'insert', key: { key: k }, before: null, after: { key: k, value: text } });
    events.push({ kind: 'setting.changed', target_type: 'setting', target_id: k, summary: settingSummary(k, current[k], v) });
  }
  if (!rows.length) return { noop: true, summary: 'Those settings are already set.' };
  return { rows, events, count: rows.length, before, reply: { changed: rows.map(r => r.key.key) } };
}

// Confirm when Claude raises a spend cap or changes who checks reasoning or the exam date.
export function settingTier(args, plan) {
  const b = plan.before || {};
  for (const r of plan.rows || []) {
    const k = r.key.key;
    const v = JSON.parse(r.after.value);
    if ((k === 'daily_cap_usd' || k === 'monthly_cap_usd') && !(Number(v) <= Number(b[k]))) return 'confirm';
    if (k === 'check_mode' || k === 'exam_date') return 'confirm';
  }
  return 'free';
}

// Settings Claude can see but never set, and why (for hub_settings get).
export const NOT_SETTABLE = { hard_cap_usd: 'the hub hard cap, set where the hub is deployed' };
const SETTINGS_CAP = 4000;

/**
 * hub_settings for Claude (MCP registers the tool; this is its one area function).
 *   get: {settings, ui: {values, schema}, not_settable}, within 4,000 characters.
 *   set: {key, value} or {values}, through applyChange as setting.set, or pref.set for keys 'ui.<path>'.
 * ctx: {surface?, via?}. Returns applyChange's answer (ok, needs_confirm or refused).
 */
export async function hubSettings(env, user, args = {}, ctx = {}) {
  const { applyChange } = await import('./map/change.js');
  if (args.action === 'get') {
    const [settings, prefs] = await Promise.all([getSettings(env), getPrefs(env, user).catch(() => ({}))]);
    const out = { settings, ui: { values: prefs, schema: prefsSchema() }, not_settable: NOT_SETTABLE };
    if (JSON.stringify(out).length > SETTINGS_CAP) out.ui.schema = out.ui.schema.map(({ path, type, values, min, max }) => ({ path, type, values, min, max }));
    if (JSON.stringify(out).length > SETTINGS_CAP) out.ui.schema = out.ui.schema.map(s => s.path);
    return out;
  }
  if (args.action !== 'set') return { refused: true, reason: 'action is get or set.' };
  const values = args.values != null ? args.values : (typeof args.key === 'string' ? { [args.key]: args.value } : null);
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) return { refused: true, reason: 'Say which setting: key and value, or values.' };
  const keys = Object.keys(values);
  const ui = keys.filter(k => k.startsWith('ui.'));
  if (ui.length && ui.length !== keys.length) return { refused: true, reason: 'Set hub settings and page looks (ui.*) in two calls.' };
  const op = ui.length ? 'pref.set' : 'setting.set';
  const opArgs = ui.length ? { values: Object.fromEntries(keys.map(k => [k.slice(3), values[k]])) } : { values };
  return applyChange(env, user, { actor: 'claude', surface: args.surface || ctx.surface || 'chat', op, args: opArgs,
    mo_said: args.mo_said || null, confirm_token: args.confirm_token || null, via: ctx.via || 'mcp:hub_settings' });
}
