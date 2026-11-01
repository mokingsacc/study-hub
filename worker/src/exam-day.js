import { PROFILES, DEFAULT_PROFILE } from './profiles.js';

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The default profile's exam date: what a hub with no exam_date row uses. */
export const DEFAULT_EXAM_DAY = PROFILES[DEFAULT_PROFILE].exam_date || null;
/** One D1 read of the setting (its row, or none). */
export const EXAM_DATE_SQL = "SELECT value FROM settings WHERE key = 'exam_date'";

const isDay = v => typeof v === 'string' && ISO_DAY.test(v) && !Number.isNaN(Date.parse(v + 'T12:00:00Z'));

/**
 * The exam date from what is stored: undefined (no row) is the profile's date; a date string (raw or as JSON text) is that
 * date; anything else (empty, null, "none") is no exam (null).
 */
export function examDayOf(stored, profile = null) {
  if (stored === undefined) {
    const p = profile && profile.exam_date !== undefined ? profile.exam_date : DEFAULT_EXAM_DAY;
    return isDay(p) ? p : null;
  }
  let v = stored;
  if (typeof v === 'string' && v.startsWith('"')) { try { v = JSON.parse(v); } catch { v = null; } }
  return isDay(v) ? v : null;
}

export async function readExamDay(env) {
  try {
    const row = await env.DB.prepare(EXAM_DATE_SQL).first();
    return examDayOf(row ? row.value : undefined);
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return examDayOf(undefined);
    throw e;
  }
}

/** Whole days from today to the exam (London days at noon): negative after it, null with no exam. */
export function daysToExam(today, examDay) {
  if (!isDay(examDay) || !isDay(today)) return null;
  return Math.round((Date.parse(examDay + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86_400_000);
}
