import { HttpError, json, readJson, now, londonDay, uuid } from './util.js';
import { all, first } from './db.js';
import { normError, leaks } from './checks.js';
import { MO } from './users.js';
import { gapOrigin, GAP_SOURCE_LABEL, CHECK_SOURCES, isBoilerplate } from './map/ingest/map-fields.js';
import { ingestGaps, retractReview } from './map/ingest/gaps.js';
import { hook } from './map/ingest/hub.js';
import { looksLikeQuestionText, gapSafe, cueOwnLooksLikeStem, cueFollowOk, leakIndexFor, scrubStemSentences, READ_QUESTION } from './map/guard.js';
import { leanPairs } from '../../public/js/conf-words.js';

export const SOURCES = ['chat', 'anki_voice', 'spoken_cue', ...CHECK_SOURCES];
// The sources list_gaps can filter by: its schema is frozen (tests/worker/mcp-registry.test.mjs), so 'anki_mac' there
// stands for the Anki check on any device, and each line names the device.
export const LIST_SOURCES = ['chat', 'anki_voice', 'spoken_cue', 'anki_mac'];
export const GAP_VERDICTS = ['gap', 'shaky'];
export const GAP_STEPS = ['recognise', 'distinguish', 'test', 'treat', 'trap'];
export const GAP_CONFIDENCE = ['sure', 'lean', 'guess'];
export const GAP_MAX = 200, SAID_MAX = 200, TOPIC_MAX = 80, REF_MAX = 80;

export function cleanGap(g) {
  const problems = [];
  const text = (k, max, required = false) => {
    const v = g && g[k];
    if (v == null || v === '') { if (required) problems.push(`${k} is needed: the gap in one line.`); return null; }
    if (typeof v !== 'string') { problems.push(`${k} must be text.`); return null; }
    const s = v.trim().replace(/\s+/g, ' ');
    if (s.length > max) { problems.push(`${k} must be under ${max} characters, in your own words (never question text).`); return null; }
    if ((k === 'gap' || k === 'said') && looksLikeQuestionText(s)) { problems.push(`${k} reads like question text: say it in your own words.`); return null; }
    return s || null;
  };
  const id = k => {
    const v = g && g[k];
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) { problems.push(`${k} must be the Anki id number.`); return null; }
    return n;
  };
  const source = g && g.source != null ? String(g.source) : 'chat';
  if (!SOURCES.includes(source)) problems.push(`source must be one of ${SOURCES.join(', ')}.`);
  const retract = g && g.retract === true;
  const wordless = retract || (source === 'anki_voice' && g && g.fallback === true && g.card_id != null && g.card_id !== '');
  const verdict = g && g.verdict != null ? String(g.verdict) : 'gap';
  if (!GAP_VERDICTS.includes(verdict)) problems.push('verdict must be gap or shaky.');
  const pick = (k, allowed) => {
    const v = g && g[k];
    if (v == null || v === '') return null;
    const s = String(v).trim().toLowerCase().replace(/^recognize$/, 'recognise');
    if (!allowed.includes(s)) { problems.push(`${k} must be one of ${allowed.join(', ')}.`); return null; }
    return s;
  };
  const gap = {
    gap: text('gap', GAP_MAX, !wordless), said: text('said', SAID_MAX), topic: text('topic', TOPIC_MAX), ref: text('ref', REF_MAX),
    card_id: id('card_id'), note_id: id('note_id'), error_type: normError(g && g.error_type), source, verdict,
    mixed_with: text('mixed_with', TOPIC_MAX), step: pick('step', GAP_STEPS), confidence: pick('confidence', GAP_CONFIDENCE),
    // at: when the rating happened (epoch ms, the Anki review id); review_id: that rating's Anki review-log id.
    at: id('at'), review_id: id('review_id'),
  };
  if (retract) {
    gap.retract = true;
    if (!gap.card_id || !gap.review_id) problems.push('A retract needs card_id and review_id.');
  }
  if (gap.mixed_with && gap.topic && gap.mixed_with.toLowerCase() === gap.topic.toLowerCase()) gap.mixed_with = null;
  if (gap.said && isBoilerplate(gap.said)) gap.said = null;
  if (gap.gap && source === 'anki_voice' && gap.card_id && isBoilerplate(gap.gap)) gap.gap = null;
  return { gap, problems };
}

export async function refLeakProblem(env, user, gap) {
  if (!gap || (!gap.ref && !gap.topic)) return null;
  let questions = [], topicIds = [];
  const soft = e => { if (!/no such (?:table|column)/i.test(String(e && e.message))) throw e; };
  const R = await import('./map/resolve.js');
  if (gap.ref) { try { questions = await R.hubQuestionsOfRef(env, user, gap.ref); } catch (e) { soft(e); } }
  if (gap.topic) {
    try { const t = await R.resolveTopic(env, user, { texts: [gap.topic] }); if (t && t.topic_id && (t.confidence ?? 0) >= R.ACCEPT) topicIds = [t.topic_id]; } catch (e) { soft(e); }
  }
  if (!questions.length && !topicIds.length) return null;
  const index = await leakIndexFor(env, user, { questions, topicIds });
  if (!index.size) return null;
  for (const k of ['gap', 'said']) {
    const run = gap[k] && leaks(index, gap[k]);
    if (run) return `${k} copies the question ("${run}"): say it in your own words.`;
  }
  return null;
}

// The map's gaps columns (migration 0010) and the step and confidence columns (0035): probed per database and kept
// once found, so a hub without them still saves gaps (a miss is checked again after a minute).
const probes = { map: new WeakMap(), signals: new WeakMap(), review: new WeakMap(), forms: new WeakMap() };
async function hasCols(env, kind, sql) {
  const c = probes[kind].get(env.DB);
  if (c && (c.ok || Date.now() - c.at < 60_000)) return c.ok;
  const ok = await env.DB.prepare(sql).all().then(() => true, () => false);
  probes[kind].set(env.DB, { ok, at: Date.now() });
  return ok;
}
export const hasMapCols = env => hasCols(env, 'map', 'SELECT held, map_state FROM gaps LIMIT 0');
export const hasSignalCols = env => hasCols(env, 'signals', 'SELECT step, confidence FROM gaps LIMIT 0');
export const hasFormCols = env => hasCols(env, 'forms', 'SELECT review_id, cause, heard, form_version FROM gaps LIMIT 0');
export const hasReviewCol = env => { const f = probes.forms.get(env.DB); return f && f.ok ? Promise.resolve(true) : hasCols(env, 'review', 'SELECT review_id FROM gaps LIMIT 0'); };
const FORM_COLS = ['cause', 'cause_quote', 'cause_inferred', 'cause_detail', 'heard', 'form_version'];

const COLS = ['id', 'at', 'day', 'source', 'card_id', 'note_id', 'ref', 'topic', 'gap', 'said', 'error_type', 'verdict', 'created_at'];
const UPDATE = ['at', 'day', 'card_id', 'note_id', 'ref', 'topic', 'gap', 'said', 'error_type', 'verdict'];
const COALESCE = ['card_id', 'note_id', 'ref', 'topic', 'gap', 'said', 'error_type', 'mixed_with', 'step', 'confidence', 'review_id'];
/**
 * The gaps row for one checked gap, as {row, statement}. A re-save of the same id replaces it and maps it again
 * (map_state back to NULL). hold: {sitting_id} writes the row held (a hub sitting not finished), with map: true
 * when the database has the map's columns. coalesce: a re-save fills empty fields and never empties a stored one
 * (with keep, it only fills them: the stored words win); keepAt: a stored row keeps its time (no event time came).
 */
export function gapStatement(env, g, { id = null, at = now(), hold = null, map = false, signals = false, keep = false, coalesce = false, keepAt = false, review = false, forms = false } = {}) {
  const row = { id: id || `${g.source}:${uuid()}`, at, day: londonDay(at), source: g.source, card_id: g.card_id ?? null, note_id: g.note_id ?? null,
    ref: g.ref ?? null, topic: g.topic ?? null, gap: g.gap ?? '', said: g.said ?? null, error_type: g.error_type ?? null, verdict: g.verdict || 'gap', created_at: now() };
  const cols = [...COLS], upd = [...UPDATE];
  if (map) {
    Object.assign(row, { origin: gapOrigin(g), held: hold ? 1 : 0, sitting_id: hold ? hold.sitting_id : null, map_state: null, topic_id: null });
    cols.push('origin', 'held', 'sitting_id', 'map_state', 'topic_id');
    upd.push('origin', 'held', 'sitting_id', 'map_state', 'topic_id');
    row.mixed_with = g.mixed_with ?? null;
    cols.push('mixed_with'); upd.push('mixed_with');
  }
  if (signals) {
    Object.assign(row, { step: g.step ?? null, confidence: g.confidence ?? null });
    cols.push('step', 'confidence'); upd.push('step', 'confidence');
  }
  if (review) { row.review_id = g.review_id ?? null; cols.push('review_id'); upd.push('review_id'); }
  // The answer forms (0067): written only by a form that gave them, so a note without them never empties a stored one.
  if (forms) for (const c of FORM_COLS) if (g[c] !== undefined) { row[c] = g[c] ?? null; cols.push(c); upd.push(c); }
  // Without coalesce, keep: a row already saved under this id stays as it is (the Anki Voice server's own note never
  // replaces Claude's).
  const set = c => {
    if (!coalesce) return `${c} = excluded.${c}`;
    if (c === 'at' || c === 'day') return keepAt ? `${c} = gaps.${c}` : `${c} = excluded.${c}`;
    if (c === 'verdict' || c === 'origin') return keep ? `${c} = coalesce(gaps.${c}, excluded.${c})` : `${c} = excluded.${c}`;
    if (!COALESCE.includes(c)) return `${c} = excluded.${c}`;
    return keep ? `${c} = coalesce(nullif(gaps.${c}, ''), excluded.${c})` : `${c} = coalesce(nullif(excluded.${c}, ''), gaps.${c})`;
  };
  const statement = env.DB.prepare(`INSERT INTO gaps (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
    ON CONFLICT(id) DO ${keep && !coalesce ? 'NOTHING' : `UPDATE SET ${upd.map(set).join(', ')}`}`).bind(...cols.map(c => row[c]));
  return { row, statement };
}

/** Map saved gaps rows (after their write): never throws, so a map failure never loses a gap. */
export async function mapGaps(env, rows, { user = MO } = {}) {
  if (!rows.length || !(await hasMapCols(env))) return null;
  return hook('gaps', () => ingestGaps(env, user, rows));
}

// One Anki Voice card's gap a day has one id, so Claude's log_gap and the Anki Voice server's own note on the same
// miss (rate_card forwards wrong or nudged parts itself) are one row, not two. The day is the rating's (the note's
// `at`), so a note sent after midnight still joins its card's review.
export const voiceGapId = (cardId, at) => `anki_voice:${cardId}:${londonDay(at)}`;
// The other note on the same rating lands within minutes (Claude's log_gap in the same turn as rate_card, the server's
// note as it rates); this window finds it even across midnight.
export const VOICE_NOTE_WINDOW_MS = 6 * 3600_000;
const SANE_PAST_MS = 7 * 86_400_000;

/** The note's event time (`at`, epoch ms) when it is sane: not ahead of now, not older than 7 days. Else null. */
export function noteAt(g, t = now()) {
  const a = Number(g && g.at);
  return Number.isSafeInteger(a) && a <= t + 60_000 && a >= t - SANE_PAST_MS ? Math.min(a, t) : null;
}

/**
 * Save one checked gap, then put it on the map. id: a fixed id makes a re-save replace the row instead of adding
 * another. keep: when a row with that id is already saved, only its empty fields are filled (its words win).
 * An Anki Voice note on a card joins the other note on the same rating; a later note never empties a stored field.
 */
export async function addGap(env, g, { id = null, at = now(), user = MO, keep = false } = {}) {
  const [map, signals, review] = await Promise.all([hasMapCols(env), hasSignalCols(env), hasReviewCol(env)]);
  const real = noteAt(g, at);
  const when = real ?? at;
  let gid = id;
  // One gap per card and rating (wave 2 B.4): a note naming the rating's review id joins the row already made for it.
  if (!gid && review && g.card_id && g.review_id) {
    const same = await first(env, 'SELECT id, source FROM gaps WHERE user_id = ? AND card_id = ? AND review_id = ? ORDER BY at LIMIT 1', user, g.card_id, g.review_id).catch(() => null);
    if (same) gid = same.id;
    // The hub's check of that Anki Voice rating came first (wave 2 F): its words win; a late note only fills its gaps.
    if (same && CHECK_SOURCES.includes(same.source)) keep = true;
  }
  if (!gid && g.source === 'anki_voice' && g.card_id) {
    const near = await first(env, `SELECT id FROM gaps WHERE user_id = ? AND source = 'anki_voice' AND card_id = ? AND at BETWEEN ? AND ?
        ORDER BY abs(at - ?) LIMIT 1`, user, g.card_id, when - VOICE_NOTE_WINDOW_MS, when + VOICE_NOTE_WINDOW_MS, when).catch(() => null);
    gid = near ? near.id : voiceGapId(g.card_id, when);
  }
  const { row, statement } = gapStatement(env, g, { id: gid, at: when, map, signals, keep, review, coalesce: true, keepAt: real == null });
  await statement.run();
  if (!map) return row.id;
  // The row as stored (the other note's fields kept), so the map places what is saved, not this note's empty fields;
  // a fresh id (no fixed id, not a card's) is new, so it is the row itself.
  const stored = gid ? await first(env, 'SELECT * FROM gaps WHERE id = ?', row.id).catch(() => null) : null;
  await mapGaps(env, [stored || row], { user });
  return row.id;
}

export async function post(request, env) {
  const body = await readJson(request, 20_000);
  const { gap, problems } = cleanGap(body);
  if (problems.length) throw new HttpError(400, problems[0]);
  if (gap.retract) {
    const r = await retractReview(env, MO, { card_id: gap.card_id, review_id: gap.review_id });
    return json({ retracted: true, ...r });
  }
  const leak = await refLeakProblem(env, MO, gap);
  if (leak) throw new HttpError(400, leak);
  if (body && ['stated', 'review'].includes(body.origin)) gap.origin = body.origin;
  if (body && body.fallback === true && gap.source === 'anki_voice' && gap.card_id) {
    const had = await first(env, `SELECT id FROM gaps WHERE user_id = ? AND card_id = ? AND day = ? AND source IN (${CHECK_SOURCES.map(() => '?').join(', ')}) LIMIT 1`,
      MO, gap.card_id, londonDay(noteAt(gap) ?? now()), ...CHECK_SOURCES).catch(() => null);
    if (had) return json({ saved: false, deduped: true, id: had.id });
  }
  const id = await addGap(env, gap, { keep: body && body.fallback === true });
  return json({ saved: true, id });
}

const CUE = /^\s*(?:knowledge\s+)?(gap|gab|gapp|gah)\b[\s,:;.\-–—]*(.*)$/i;
const NOT_KNOWING = "(?:don'?t|do not|didn'?t|did not|can'?t|cannot|can not|couldn'?t|still don'?t|never|forgot|forget|always forget|always mix|always confuse|always get|"
  + "keep|need to|have to|must|mix|mixed|confuse|confused|get confused|got confused|get mixed|got mixed|struggle|wasn'?t sure|was not sure|was unsure|was confused|"
  + "have no idea|had no idea|no idea|have no clue|had no clue|no clue|thought|should know|should have known|should'?ve known)";
const I_FORMS = `i\\s+${NOT_KNOWING}\\b|i'?m\\s+(?:not sure|confused|unsure|never sure|lost)\\b|im\\s+(?:not sure|confused|unsure)\\b|i am\\s+(?:not sure|confused|unsure)\\b`;
const OPENS = new RegExp(`^(?:${I_FORMS}|why\\b|how\\b|what\\b|when\\b|which\\b|don'?t\\b|do not\\b|not sure\\b|unsure\\b|no idea\\b|no clue\\b|never\\b|`
  + `need to\\b|need\\b|must\\b|have to\\b|look up\\b|confused\\b|forgot\\b)`, 'i');
const MID_CUE = /\b(?:(?:this|that|it)(?:'s|\s+is|\s+was|\s+'s)|(?:log|mark|put)\s+(?:this|that|it)\s+(?:down\s+)?as)\s+(?:a\s+|my\s+)?(?:knowledge\s+)?(gap|gapp)\b[\s,:;.!\-–—]*(.*)$/i;
const OPENS_GAH = new RegExp(`^(?:${I_FORMS}|don'?t\\b|do not\\b|not sure\\b|no idea\\b|no clue\\b|never\\b|confused\\b|forgot\\b)`, 'i');

const sentences = text => String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

/**
 * Spoken gap cues in a transcript: [{seg, text}] in order, seg the index of the segment the cue starts in.
 * A cue that is only "Gap." takes the next sentence (Whisper often ends the sentence after the word).
 */
export function findCues(segments) {
  const flat = [];
  (segments || []).forEach((s, i) => sentences(s && s.text).forEach(t => flat.push({ seg: i, t })));
  const out = [];
  for (let k = 0; k < flat.length; k++) {
    const m = CUE.exec(flat[k].t) || MID_CUE.exec(flat[k].t);
    if (!m) continue;
    let rest = m[2].trim();
    if (!rest && flat[k + 1]) { rest = flat[k + 1].t; k++; }
    if (!(/^gah$/i.test(m[1]) ? OPENS_GAH : OPENS).test(rest)) continue;
    if (cueOwnLooksLikeStem(rest)) continue;
    if (rest.split(/\s+/).length < 6 && flat[k + 1] && !CUE.test(flat[k + 1].t) && !MID_CUE.test(flat[k + 1].t) && cueFollowOk(flat[k + 1].t)) rest += ' ' + flat[k + 1].t;
    out.push({ seg: flat[k].seg, text: rest.slice(0, GAP_MAX).trim() });
  }
  for (const { seg, t } of flat) {
    for (const [a, b] of leanPairs(t)) {
      if (cueOwnLooksLikeStem(`${a} ${b}`)) continue;
      out.push({ seg, text: `Lean between ${a} and ${b}`.slice(0, GAP_MAX), topic: a.slice(0, TOPIC_MAX), mixed_with: b.slice(0, TOPIC_MAX), verdict: 'shaky', confidence: 'lean' });
    }
  }
  return out;
}

// A sentence the stem scrub never touches: a spoken cue or "lean between" (so cues found again in the stored words come
// out the same), or a marker already there.
const keepSentence = t => CUE.test(t) || MID_CUE.test(t) || leanPairs(t).length > 0 || /^\((?:read the card|read the question)\)$/.test(t);

export function scrubStems(segments) {
  const flat = [];
  (segments || []).forEach((s, i) => sentences(s && s.text).forEach(t => flat.push({ seg: i, text: t, kept: keepSentence(t) })));
  const out = scrubStemSentences(flat);
  const bySeg = new Map();
  flat.forEach((x, k) => {
    const list = bySeg.get(x.seg) || [];
    if (!(out[k] === READ_QUESTION && list[list.length - 1] === READ_QUESTION)) list.push(out[k]);
    bySeg.set(x.seg, list);
  });
  return (segments || []).map((s, i) => (bySeg.has(i) ? { ...s, text: bySeg.get(i).join(' ') } : s));
}

/**
 * Save every spoken cue in a recording as a gap, in one batch: the recording's earlier cues (ids
 * 'cue:<key>:<n>') are deleted by id range and the new ones inserted, so a re-saved recording never leaves a
 * stale cue behind. where(seg, index) gives {ref, card_id, note_id, at} for the segment a cue starts in.
 * opts: {leakIndex: a cue sharing a 6-word run with the question is dropped (it is question text read aloud),
 * hold: {sitting_id} while the cue's sitting is not finished, user}. Returns the number of cues saved.
 */
export async function saveCues(env, segments, key, where, { leakIndex = null, hold = null, user = MO, keep = null } = {}) {
  // keep(cue, where): false drops a cue before it is numbered (the Anki sessions' card-less cues), so ids stay stable.
  const cues = findCues(segments).filter(c => !(leakIndex && leaks(leakIndex, c.text)) && (!keep || keep(c, where(segments[c.seg], c.seg) || {})));
  const [map, signals] = await Promise.all([hasMapCols(env), hasSignalCols(env)]);
  const lo = `cue:${key}:`, hi = `cue:${key};`; // ';' sorts right after ':' (a range, since D1 caps LIKE patterns at 50 bytes)
  const before = map ? (await all(env, 'SELECT id FROM gaps WHERE id >= ? AND id < ?', lo, hi)).map(r => r.id) : [];
  const made = cues.map((c, i) => {
    const w = where(segments[c.seg], c.seg) || {};
    return gapStatement(env, { source: 'spoken_cue', gap: c.text, said: null, topic: c.topic || null, ref: w.ref ? String(w.ref).slice(0, REF_MAX) : null,
      card_id: w.card_id ?? null, note_id: w.note_id ?? null, error_type: null, verdict: c.verdict || 'gap',
      mixed_with: c.mixed_with || null, confidence: c.confidence || null }, { id: `${lo}${i}`, at: w.at || now(), hold, map, signals });
  });
  await env.DB.batch([env.DB.prepare('DELETE FROM gaps WHERE id >= ? AND id < ?').bind(lo, hi), ...made.map(m => m.statement)]);
  const stale = before.filter(id => !made.some(m => m.row.id === id));
  if (map && stale.length) await hook('stale cues', () => forgetGaps(env, user, stale));
  if (map) await mapGaps(env, made.map(m => m.row), { user });
  return cues.length;
}

// Cues a re-saved recording no longer has: their observations go too.
async function forgetGaps(env, user, ids) {
  const { commit } = await import('./map/ingest/hub.js');
  const rows = await all(env, `SELECT DISTINCT obs_key, topic_id FROM evidence WHERE user_id = ? AND gap_id IN (SELECT value FROM json_each(?))
    AND obs_key IN (SELECT 'gap:' || value FROM json_each(?))`, user, JSON.stringify(ids), JSON.stringify(ids));
  if (!rows.length) return null;
  return commit(env, user, { via: 'hook:cues', evidence: { remove: rows.map(r => r.obs_key) }, recompute: rows.map(r => r.topic_id) });
}

// ---------- reading them back (connector) ----------
export async function listGaps(env, { since_days, limit, source } = {}) {
  const days = Number.isInteger(since_days) && since_days > 0 ? Math.min(since_days, 120) : 14;
  const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 30;
  const since = now() - days * 86_400_000;
  // 'anki_mac' (list_gaps' frozen enum) is the Anki check on any device; any other source is itself.
  const srcs = source === 'anki_mac' ? CHECK_SOURCES : SOURCES.includes(source) ? [source] : null;
  // A gap from a hub sitting that has not ended stays hidden, like the sitting's results.
  const held = (await hasMapCols(env)) ? ' AND held = 0' : '';
  const where = `at >= ?${srcs ? ' AND source IN (SELECT value FROM json_each(?))' : ''}${held}`;
  const args = srcs ? [since, JSON.stringify(srcs)] : [since];
  const [rows, topics] = await Promise.all([
    all(env, `SELECT id, at, day, source, card_id, note_id, ref, topic, gap, said, error_type, verdict${(await hasSignalCols(env)) ? ', mixed_with, step, confidence' : ''}
      FROM gaps WHERE ${where} ORDER BY at DESC LIMIT ?`, ...args, n),
    // One map topic is one line, however the gaps spelled it ("Cat scratch disease", "Cat-scratch disease").
    all(env, `SELECT topic, count(*) AS n, max(day) AS last FROM gaps WHERE ${where} AND topic IS NOT NULL
      GROUP BY ${held ? 'coalesce(topic_id, lower(topic))' : 'lower(topic)'} ORDER BY n DESC, last DESC LIMIT 15`, ...args),
  ]);
  return { days, gaps: rows.map(gapSafe), topics };
}

export const SOURCE_LABEL = GAP_SOURCE_LABEL;
export { gapOrigin };

export function gapsText(r) {
  if (!r.gaps.length) return `No gaps logged in the last ${r.days} days.`;
  const line = g => `${g.day} (${SOURCE_LABEL[g.source] || g.source}${g.verdict === 'shaky' ? ', shaky' : ''}${g.card_id ? `, card ${g.card_id}` : ''}${g.ref ? `, ${g.ref}` : ''}): ${g.topic ? `[${g.topic}] ` : ''}${g.gap || '(no words)'}${g.said ? ` — he said: "${g.said}"` : ''}${g.step ? ` (broke at: ${g.step}${g.mixed_with ? `, mixed up with ${g.mixed_with}` : ''})` : g.mixed_with ? ` (mixed up with ${g.mixed_with})` : ''}`;
  return [`${r.gaps.length} gap${r.gaps.length === 1 ? '' : 's'} in the last ${r.days} days, newest first. Gaps Mo stated himself (said to Claude, said aloud) matter most.`,
    ...r.gaps.map(line),
    r.topics.length ? `\nTopics with more than one gap: ${r.topics.filter(t => t.n > 1).map(t => `${t.topic} (${t.n})`).join('; ') || 'none'}.` : ''].join('\n').trim();
}
