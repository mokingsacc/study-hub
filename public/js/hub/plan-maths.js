
export const CMS_QUESTIONS = 50;
export const UWORLD_BLOCK = 20;
export const PLAN_DEFAULTS = {
  plan_start: '2027-04-29', uworld_finish_date: '2027-06-08', phase2_end: '2027-06-25',
  cms_early_by: '2027-05-15',
  uworld_total_left: 2000, uworld_as_of: '2027-05-10', target_score: 250,
  rest_days: ['2027-06-28', '2027-06-29'], light_days: ['2027-06-26', '2027-06-27'],
  off_weekdays: [6, 0], // 6 Saturday: practice exam; 0 Sunday: day off
  cms_weak_pct: 75,
  plan_daily: { uworld: 80, cms: 37, incorrects: 40 },
};
const DEFAULT_OFF = PLAN_DEFAULTS.off_weekdays;
export const DECISIONS = [
  { date: '2027-05-15', text: 'is the last free day to move the exam. Move now only if NBME 10 and 11 are both under about 215; otherwise the real call is Sat 21 Nov.' },
  { date: '2027-05-30', text: 'is the real decision on the exam date, after NBME 14. Keep exam day unless your predicted score is under your target and still rising. Moving costs $35 until then, $100 after.' },
];
// The exam-day travel note shows this many days before the exam (from the exam_date setting).
export const EXAM_WEEK_DAYS = 7;
export const MIDWEEK_EXAMS = [{ date: '2027-06-24', line: 'NBME 16 today, your last practice test. Review it in the afternoon; Anki at 16:00.' }];

// The plan card's fixed lines (revised plan, 20 Oct 2026).
export const TEXT = {
  sunday: 'Day off: Anki reviews only, by voice, 30-45 minutes. No new cards and no questions.',
  saturday: 'Saturday: practice exam, then review it this afternoon (after a full day, review on Monday).',
  review: 'Review: longest reading on guesses and low-confidence misses; each confident error gets a one-line fix and a card.',
  day: 'Wake 06:30, start 07:30. Each block: 30 min questions, 5 min break, 30 min review, 5 min break. Do 4 blocks, take the long break, then the last block. Anki at 16:00.',
  day2: 'Wake 06:30, start 07:30, with a 5-minute break between doing and reviewing. Anki at 16:00.',
  light: 'Light: Anki and 1-2 timed blocks.',
  rest: 'Rest. Keep your 06:30 wake time.',
  examDay: 'Exam day: leave by 07:15 with a backup route, aim to arrive by 08:00 (after 08:30 you may be turned away). Time the trip once before then, and check your passport name matches your scheduling permit. On the day: 2-3 minute breaks between most blocks, about 15 minutes mid-day.',
  incorrects: 'redo all UWorld incorrects once (confident misses and weak systems first)',
};

export const CMS = [
  { subject: 'Internal Medicine', short: 'IM', forms: 8, note: 'IM1A and IM2A are not in the set' },
  { subject: 'Surgery', short: 'Surgery', forms: 8 },
  { subject: 'OBGYN', short: 'OBGYN', forms: 8, core: true },
  { subject: 'Pediatrics', short: 'Peds', forms: 8, core: true, same: { 2: 4, 4: 2 }, note: 'Peds 2 is the same as Peds 4' },
  { subject: 'Neurology', short: 'Neuro', forms: 8 },
  { subject: 'Psychiatry', short: 'Psych', forms: 7, note: 'Psych 2A is not in the set' },
  { subject: 'Family Medicine', short: 'FM', forms: 5 },
  { subject: 'Emergency Medicine', short: 'EM', forms: 3 },
];
const bySubject = Object.fromEntries(CMS.map(c => [c.subject, c]));

export const SYSTEM_SUBJECT = {
  Obstetrics: 'OBGYN', "Gynaecology and Men's Health": 'OBGYN', Paediatrics: 'Pediatrics', 'Neurology, Eye and ENT': 'Neurology',
  Psychiatry: 'Psychiatry', 'Emergency and Toxicology': 'Emergency Medicine', Surgery: 'Surgery', 'Prevention, Nutrition and Geriatrics': 'Family Medicine',
  Endocrine: 'Internal Medicine', Cardiology: 'Internal Medicine', Respiratory: 'Internal Medicine', 'Renal and Acid-Base': 'Internal Medicine',
  'GI and Hepatology': 'Internal Medicine', 'Haematology and Oncology': 'Internal Medicine', 'Infectious Disease': 'Internal Medicine',
  'Immunology and Allergy': 'Internal Medicine', 'Rheumatology and MSK': 'Internal Medicine', Dermatology: 'Internal Medicine',
};

// ---------- dates ----------
const toDate = iso => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const addDays = (iso, n) => { const d = toDate(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const weekday = iso => toDate(iso).getUTCDay(); // 0 Sunday ... 6 Saturday
/** A study day: not one of the off weekdays (Saturday and Sunday by default) and not a rest or light day. */
export const isStudyDay = (iso, off = [], offWeekdays = DEFAULT_OFF) => !offWeekdays.includes(weekday(iso)) && !off.includes(iso);
/** Study days from `from` (included) up to `until` (not included). */
export function studyDays(from, until, off = [], offWeekdays = DEFAULT_OFF) {
  let n = 0;
  for (let d = from; d < until; d = addDays(d, 1)) if (isStudyDay(d, off, offWeekdays)) n++;
  return n;
}
/** The first study day on or after `iso` (within a year). */
export function nextStudyDay(iso, off = [], offWeekdays = DEFAULT_OFF) {
  let d = iso;
  for (let i = 0; i < 366 && !isStudyDay(d, off, offWeekdays); i++) d = addDays(d, 1);
  return d;
}

// ---------- phases ----------
const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** The plan's dates from the settings (missing ones take the defaults; the exam date only from exam_date, null when unset). */
export function planDates(settings = {}) {
  const s = { ...PLAN_DEFAULTS, ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v != null && v !== '')) };
  const daily = { ...PLAN_DEFAULTS.plan_daily, ...(settings.plan_daily || {}) };
  const list = v => (Array.isArray(v) ? v : []);
  const rest = list(s.rest_days), light = list(s.light_days);
  const off = [...new Set([...rest, ...light, ...MIDWEEK_EXAMS.map(x => x.date)])].sort();
  const offWeekdays = list(s.off_weekdays).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  return {
    start: s.plan_start, uworldFinish: s.uworld_finish_date, phase2Start: nextStudyDay(addDays(s.uworld_finish_date, 1), off, offWeekdays), phase2End: s.phase2_end,
    exam: ISO.test(String(settings.exam_date || '')) ? settings.exam_date : null, decisions: DECISIONS, cmsEarlyBy: s.cms_early_by, weakPct: Number(s.cms_weak_pct),
    rest, light, off, offWeekdays, daily, midweek: MIDWEEK_EXAMS,
    totalLeft: Number(s.uworld_total_left), asOf: s.uworld_as_of, target: Number(s.target_score),
  };
}
/** 'before' | 1 | 2 | 'after' */
export function phaseOf(today, d) {
  if (today < d.start) return 'before';
  if (today <= d.uworldFinish) return 1;
  if (today <= d.phase2End) return 2;
  return 'after';
}

export function uworldStatus({ log = [], totalLeft = 2000, asOf = '2027-04-29', today, rest = [], offWeekdays = DEFAULT_OFF, until = '2027-06-01' }) {
  const rows = log.filter(r => r && (r.kind || 'first_pass') === 'first_pass' && r.day >= asOf && r.day <= today);
  const done = rows.reduce((t, r) => t + (Number(r.n) || 0), 0);
  const left = Math.max(0, totalLeft - done);
  // Before the count starts (the evening of 20 Oct), today is already done, so count from asOf.
  const daysLeft = studyDays(today < asOf ? asOf : today, until, rest, offWeekdays);
  const needed = left === 0 ? 0 : daysLeft ? Math.ceil(left / daysLeft) : left;
  const from = addDays(today, -6) > asOf ? addDays(today, -6) : asOf;
  const last7 = rows.filter(r => r.day >= from).reduce((t, r) => t + (Number(r.n) || 0), 0);
  const pace = Math.round(last7 / Math.max(1, studyDays(from, addDays(today, 1), rest, offWeekdays)));
  let status, behindBy = 0;
  if (left === 0) status = 'done';
  else if (!rows.length) status = 'no_data';
  else if (pace >= needed) status = 'on_track';
  else { status = 'behind'; behindBy = needed - pace; }
  let finish = null;
  if (left === 0) finish = rows.length ? rows.map(r => r.day).sort().pop() : null;
  else if (pace > 0) {
    let d = rows.some(r => r.day === today) ? addDays(today, 1) : today, still = left;
    for (let i = 0; i < 400; i++, d = addDays(d, 1)) {
      if (!isStudyDay(d, rest, offWeekdays)) continue;
      still -= pace;
      if (still <= 0) { finish = d; break; }
    }
  }
  return { done, left, daysLeft, needed, last7, pace, status, behindBy, finish };
}

export function anchoredTotal({ totalLeft, asOf, log = [], anchor = null }) {
  if (!anchor || !Number.isFinite(Number(anchor.unused)) || !Number.isFinite(Number(anchor.through)) || !anchor.day || anchor.day < asOf) {
    return { totalLeft, asOf, anchored: false };
  }
  const before = log.filter(r => r && (r.kind || 'first_pass') === 'first_pass' && r.day < asOf).reduce((t, r) => t + (Number(r.n) || 0), 0);
  return { totalLeft: Math.max(0, Number(anchor.unused) + Number(anchor.through) - before), asOf, anchored: true, anchorDay: anchor.day };
}

/** Forms of a subject counted once (Peds 2 and 4 are one paper, listed as 4). */
export function uniqueForms(subject) {
  const c = bySubject[subject];
  if (!c) return [];
  const out = [];
  for (let f = 1; f <= c.forms; f++) if (!(c.same && c.same[f] && c.same[f] > f)) out.push(String(f));
  return out;
}
/** Is this form done? A form that is the same paper as a done form counts as done. */
export function formDone(cms, subject, form) {
  const c = bySubject[subject] || {};
  const twin = c.same && c.same[form] ? String(c.same[form]) : null;
  return (cms || []).some(r => r.subject === subject && (String(r.form) === String(form) || (twin && String(r.form) === twin)));
}
export function subjectProgress(cms, subject) {
  const forms = uniqueForms(subject);
  const done = forms.filter(f => formDone(cms, subject, f));
  const scores = (cms || []).filter(r => r.subject === subject && r.score_pct != null && r.score_pct !== '').map(r => Number(r.score_pct));
  const avg = scores.length ? Math.round(scores.reduce((t, x) => t + x, 0) / scores.length) : null;
  const last = (cms || []).filter(r => r.subject === subject).map(r => r.day).sort().pop() || null;
  return { subject, short: (bySubject[subject] || {}).short || subject, total: forms.length, done: done.length, next: forms.find(f => !formDone(cms, subject, f)) || null, avg, n_scored: scores.length, last };
}

export function cmsPlan({ cms = [], today, rest = [], offWeekdays = DEFAULT_OFF, perDay = 37, from = today, until = '2027-06-26' }) {
  const core = CMS.filter(c => c.core).map(c => subjectProgress(cms, c.subject));
  const open = core.filter(p => p.next);
  open.sort((a, b) => (a.last || '').localeCompare(b.last || '') || a.done / a.total - b.done / b.total);
  const pick = open[0] || null;
  const formsLeft = core.reduce((t, p) => t + p.total - p.done, 0);
  const daysLeft = studyDays(today > from ? today : from, until, rest, offWeekdays);
  const daysPerForm = perDay > 0 ? Math.round((CMS_QUESTIONS / perDay) * 10) / 10 : Infinity;
  const onTrack = formsLeft === 0 || (perDay > 0 && (formsLeft * CMS_QUESTIONS) / perDay <= daysLeft); // unrounded
  const line = [...core].sort((a, b) => (a.subject === 'Pediatrics' ? -1 : b.subject === 'Pediatrics' ? 1 : 0)).map(p => `${p.short} ${p.done}/${p.total}`).join(', ');
  return { next: pick ? { subject: pick.subject, short: pick.short, form: pick.next } : null, progress: core, line, formsLeft, daysLeft, daysPerForm, onTrack };
}

export function missesBySubject(rows = []) {
  const out = {};
  for (const r of rows) { const s = SYSTEM_SUBJECT[r.system]; if (s) out[s] = (out[s] || 0) + (Number(r.misses) || 0); }
  return Object.entries(out).map(([subject, misses]) => ({ subject, misses })).sort((a, b) => b.misses - a.misses || a.subject.localeCompare(b.subject));
}

export function suggestOther({ cms = [], misses = [], weakPct = PLAN_DEFAULTS.cms_weak_pct }) {
  const bar = Number.isFinite(Number(weakPct)) ? Number(weakPct) : PLAN_DEFAULTS.cms_weak_pct;
  const others = CMS.filter(c => !c.core).map(c => subjectProgress(cms, c.subject)).filter(p => p.next);
  const low = others.filter(p => p.avg != null && p.avg < bar).sort((a, b) => a.avg - b.avg)[0];
  if (low) return { subject: low.subject, short: low.short, form: low.next, why: `your ${low.short} CMS average is ${low.avg}%` };
  const top = missesBySubject(misses)[0];
  const p = top && top.misses > 0 && others.find(o => o.subject === top.subject);
  if (p) return { subject: p.subject, short: p.short, form: p.next, why: `most of your wrong answers in the last 14 days were ${p.subject} (${top.misses})` };
  return null;
}

// ---------- the day ----------
const when = iso => toDate(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const inPlan = (today, d) => today >= d.start && (!d.exam || today < d.exam);

/** Plain notes for the day: the day's rhythm on study days, Saturdays, each reschedule check in the week before it,
 * and the exam-day travel note from EXAM_WEEK. */
export function phaseNotes(today, d) {
  const out = [];
  const off = d.off || d.rest || [];
  const ph = phaseOf(today, d);
  if ((ph === 1 || ph === 2) && isStudyDay(today, off, d.offWeekdays || DEFAULT_OFF)) out.push(ph === 1 ? TEXT.day : TEXT.day2);
  if (!off.includes(today) && weekday(today) === 6 && (d.offWeekdays || DEFAULT_OFF).includes(6)) out.push(TEXT.saturday);
  for (const c of d.decisions || []) if (today <= c.date && today >= addDays(c.date, -6)) out.push(`${today === c.date ? 'Today' : when(c.date)} ${c.text}`);
  if (d.exam && today >= addDays(d.exam, -EXAM_WEEK_DAYS) && today <= d.exam) out.push(TEXT.examDay);
  return out;
}

/** The review line, on any day of phase 1 or 2 except a Sunday off (whose line already says how to review). */
export function reviewTip(today, d) {
  const ph = phaseOf(today, d);
  if (ph !== 1 && ph !== 2) return null;
  if (weekday(today) === 0 && (d.offWeekdays || DEFAULT_OFF).includes(0)) return null;
  return TEXT.review;
}

export function earlyCms(today, d, cms = []) {
  if (!d.cmsEarlyBy || today >= d.cmsEarlyBy || phaseOf(today, d) !== 1) return null;
  const has = subject => (cms || []).some(r => r.subject === subject);
  if (has('Pediatrics') && has('OBGYN')) return null;
  return `Before ${when(d.cmsEarlyBy)}: do one Peds and one OBGYN CMS form to spot gaps early.`;
}

export function incorrectsDone(log = [], today) {
  const rows = log.filter(r => r && r.kind === 'incorrect' && r.day <= today);
  const sum = rs => rs.reduce((t, r) => t + (Number(r.n) || 0), 0);
  return { today: sum(rows.filter(r => r.day === today)), total: sum(rows), last7: sum(rows.filter(r => r.day >= addDays(today, -6))) };
}

const uworldBlocks = n => (n > 0 && n % UWORLD_BLOCK === 0 ? `${n / UWORLD_BLOCK} timed block${n === UWORLD_BLOCK ? '' : 's'} of ${UWORLD_BLOCK}` : `timed blocks of ${UWORLD_BLOCK}`);

export function dailyMix({ today, d, uworld, cms }) {
  if ((d.light || []).includes(today)) return TEXT.light;
  if ((d.rest || []).includes(today)) return TEXT.rest;
  const mid = (d.midweek || []).find(x => x.date === today);
  if (mid) return mid.line;
  if (!inPlan(today, d)) return null;
  if (weekday(today) === 0 && (d.offWeekdays || DEFAULT_OFF).includes(0)) return TEXT.sunday;
  const ph = phaseOf(today, d);
  if (!isStudyDay(today, d.off || d.rest || [], d.offWeekdays || DEFAULT_OFF) || ph === 'before' || ph === 'after') return null;
  if (ph === 1) return uworld && uworld.left === 0 ? 'UWorld first pass done: start on the incorrects early' : `${d.daily.uworld} UWorld (${uworldBlocks(d.daily.uworld)})`;
  const parts = [];
  if (uworld && uworld.left > 0) parts.push(`finish the UWorld first pass (${uworld.left} left)`);
  if (d.daily.cms) parts.push(`${d.daily.cms} CMS Peds/OBGYN alternating (${cms && cms.next ? `Next CMS: ${cms.next.short} form ${cms.next.form}` : 'OBGYN and Peds done: pick your weakest subject'})`);
  if (d.daily.incorrects) parts.push(`${TEXT.incorrects}, ${d.daily.incorrects} a day`);
  return parts.join(' + ');
}

/** Phase 2 as a heads-up while phase 1 runs: "Coming up from 23 Nov: ...". Null once it has started. */
export function comingUp(today, d) {
  if (today >= d.phase2Start) return null;
  const forms = CMS.filter(c => c.core).reduce((t, c) => t + uniqueForms(c.subject).length, 0);
  const every = d.daily.cms > 0 ? Math.round((CMS_QUESTIONS / d.daily.cms) * 10) / 10 : null;
  return `Coming up from ${when(d.phase2Start)}: CMS Peds and OBGYN alternating (${forms} forms, about ${d.daily.cms} questions a day${every ? `, one form every ${every} study days` : ''}), `
    + `and ${TEXT.incorrects}, about ${d.daily.incorrects} a day.`;
}

// ---------- the week ----------
/**
 * Sittings in the 7 days from today (or the next one after that), each date marked full_day when two or
 * more sittings share it. -> [{date, full_day, sittings: [...]}]
 */
export function weekExams(sittings = [], today) {
  const open = sittings.filter(s => s.status !== 'done' && s.scheduled_date && s.scheduled_date >= today)
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || (a.created_at || 0) - (b.created_at || 0));
  const end = addDays(today, 7);
  let pick = open.filter(s => s.scheduled_date < end);
  if (!pick.length && open.length) pick = open.filter(s => s.scheduled_date === open[0].scheduled_date);
  const days = [];
  for (const s of pick) {
    let d = days.find(x => x.date === s.scheduled_date);
    if (!d) days.push(d = { date: s.scheduled_date, sittings: [] });
    d.sittings.push(s);
  }
  const all = sittings.filter(s => s.scheduled_date);
  for (const d of days) d.full_day = all.filter(s => s.scheduled_date === d.date).length >= 2;
  return days;
}
/** True when another sitting shares this one's date (a full day). */
export const isFullDay = (s, sittings = []) => !!s.scheduled_date && sittings.filter(x => x.scheduled_date === s.scheduled_date).length >= 2;

// ---------- score ----------
export function forecastPoint(f, examDate = null) {
  if (!f || f.error || f.mid == null || f.low == null || f.high == null) return null;
  return { mid: Math.round(f.mid), low: Math.round(f.low), high: Math.round(f.high), at: f.exam_day || examDate };
}

/** The prediction against the target: {gap, text} (gap = target - predicted mid; + = still to gain). */
export function scoreGap(p, target = 260) {
  if (!p || p.mid == null) return { gap: null, text: `No prediction yet. Your target is ${target}.` };
  const gap = target - Math.round(p.mid);
  const where = gap > 0 ? `${gap} point${gap === 1 ? '' : 's'} below your ${target} target` : gap < 0 ? `${-gap} point${gap === -1 ? '' : 's'} above your ${target} target` : `right on your ${target} target`;
  // words: the gap alone, for Score vs target on Home; the prediction and its range are in the Predicted score card
  // just below, so they are not said twice (DES4-14).
  return { gap, text: `Predicted ${Math.round(p.mid)} (${Math.round(p.low)} to ${Math.round(p.high)}): ${where}.`, words: `${where[0].toUpperCase()}${where.slice(1)}.` };
}
