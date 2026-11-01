import { HttpError, readJson } from '../util.js';
import { applyChange, changeResponse, UNDO_HINT } from './change.js';
import { rawKey, withCause, MO_FIX_COLS, moFixed } from './ingest/map-fields.js';
import { stemSafe } from './guard.js';
import { summaryOf } from './events.js';
import { CAUSES, CAUSE_VERSION } from '../../../public/js/shared/cause.js';

export const CORRECT = { words_max: 300 };
export const FIX_CAUSE_WORDS = { confusion: 'mixed up', missing_fact: "didn't know", reasoning: 'reasoning', ignored_clue: 'passed over a clue', misread: 'misread', guess: 'guessed' };
const CONFIDENCES = ['sure', 'lean', 'guess'];
const KEYS = ['miss_id', 'gap_id', 'id', 'kind', 'cause', 'confidence', 'his_words', 'reason'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const parse = s => { try { const o = s ? JSON.parse(s) : {}; return isObj(o) ? o : {}; } catch { return {}; } };
const words = v => String(v ?? '').replace(/\s+/g, ' ').trim();

// The columns this op writes (guard.js WRITABLE gives misses and gaps only placement columns; this op adds its own).
export const CORRECT_WRITES = {
  misses: { actions: 'u', cols: [...MO_FIX_COLS.cause, ...MO_FIX_COLS.confidence, ...MO_FIX_COLS.his_words, 'mo_corrected_json'] },
  gaps: { actions: 'u', cols: ['said', 'confidence', 'mo_corrected_json'] },
};

/** The fields a request corrects, checked (pure): {fix: {cause?, confidence?, his_words?}} or {refuse, field}. */
export function readFix(a, kind) {
  const fix = {};
  if (a.cause != null && a.cause !== '') {
    if (kind !== 'miss') return { refuse: 'A gap has no cause to correct; say what he did not know instead.', field: 'cause' };
    if (!CAUSES.includes(a.cause)) return { refuse: `cause is one of ${CAUSES.join(', ')}.`, field: 'cause' };
    fix.cause = a.cause;
  }
  if (a.confidence != null && a.confidence !== '') {
    if (!CONFIDENCES.includes(a.confidence)) return { refuse: 'confidence is sure, lean or guess.', field: 'confidence' };
    fix.confidence = a.confidence;
  }
  if (a.his_words != null) {
    if (typeof a.his_words !== 'string') return { refuse: 'his_words is his own words, as text.', field: 'his_words' };
    const w = words(a.his_words);
    if (w.length > CORRECT.words_max) return { refuse: `his_words is at most ${CORRECT.words_max} characters.`, field: 'his_words' };
    if (w && !stemSafe(w)) return { refuse: 'Those words read like question text; put them in his own words.', field: 'his_words' };
    fix.his_words = w;
  }
  if (!Object.keys(fix).length) return { refuse: 'Say what was not right: cause, confidence or his_words.' };
  return { fix };
}

const pick = (row, cols) => Object.fromEntries(cols.map(c => [c, row[c] ?? null]));

/** The miss's columns after the correction (pure): {after, changed: [groups]}. */
export function missAfter(m, fix, now) {
  const after = {};
  const changed = [];
  if (fix.cause) {
    Object.assign(after, { cause: fix.cause, cause_inferred: 0, cause_version: CAUSE_VERSION,
      cause_quote: fix.his_words || (m.cause === fix.cause ? m.cause_quote ?? null : null),
      cause_detail: m.cause === fix.cause ? m.cause_detail ?? null : null });
    changed.push('cause');
  }
  if (fix.confidence) { Object.assign(after, { confidence: fix.confidence, confidence_source: 'mo' }); changed.push('confidence'); }
  if (fix.his_words != null) {
    Object.assign(after, fix.his_words ? { his_words: fix.his_words, his_words_at: null, his_words_src: 'mo' } : { his_words: null, his_words_at: null, his_words_src: null });
    changed.push('his_words');
  }
  const was = parse(m.mo_corrected_json);
  for (const g of changed) was[g] = now;
  after.mo_corrected_json = JSON.stringify(was);
  return { after, changed };
}

const WHAT = { cause: 'cause', confidence: 'confidence', his_words: 'your words' };
export function fixSummary(label, fix, changed) {
  const bits = changed.map(g => (g === 'cause' ? `cause: ${FIX_CAUSE_WORDS[fix.cause]}` : g === 'confidence' ? `confidence: ${fix.confidence}` : WHAT[g]));
  return summaryOf(`${label || 'A miss'}: your correction (${bits.join('; ')})`);
}

/**
 * Planner for miss.correct. A miss: its cause, confidence and words (the answer's evidence and look-alikes are added by
 * applyCorrect). A gap: its said and confidence. Refuses an unknown, held or deleted row and an empty correction.
 */
export async function planCorrect(env, user, args, ctx = {}) {
  const a = isObj(args) ? args : {};
  for (const k of Object.keys(a)) if (!KEYS.includes(k)) return { refuse: `Unknown field ${k}.`, field: k };
  const kind = a.gap_id != null || a.kind === 'gap' ? 'gap' : 'miss';
  const id = String(a.gap_id ?? a.miss_id ?? a.id ?? '').trim();
  if (!id || id.length > 160) return { refuse: kind === 'gap' ? 'Which gap? (gap_id is missing)' : 'Which miss? (miss_id is missing)', field: kind === 'gap' ? 'gap_id' : 'miss_id' };
  const f = readFix(a, kind);
  if (f.refuse) return f;
  const fix = f.fix;
  const now = ctx.now || Date.now();
  if (kind === 'gap') {
    const g = await env.DB.prepare('SELECT * FROM gaps WHERE user_id = ? AND id = ?').bind(user, id).first();
    if (!g) return { refuse: 'There is no gap with that id.', field: 'gap_id' };
    if (Number(g.held) === 1) return { refuse: 'That gap is from a sitting that is not finished, so it is not on the map yet.', field: 'gap_id' };
    const after = {}, changed = [];
    if (fix.confidence) { after.confidence = fix.confidence; changed.push('confidence'); }
    if (fix.his_words != null) { after.said = fix.his_words || null; changed.push('his_words'); }
    const was = parse(g.mo_corrected_json);
    for (const c of changed) was[c] = now;
    after.mo_corrected_json = JSON.stringify(was);
    const before = pick(g, Object.keys(after));
    const summary = fixSummary(g.ref && /\d/.test(String(g.ref)) && String(g.ref).length <= 24 ? `Gap ${g.ref}` : 'A gap', fix, changed);
    return {
      rows: [{ table: 'gaps', op: 'update', key: { id: g.id }, before, after }],
      events: [{ kind: 'gap.corrected', target_type: 'gap', target_id: g.id, topic_id: g.topic_id || null, summary, before: { id: g.id, ...before }, after: { id: g.id, ...after } }],
      touched_topics: g.topic_id ? [g.topic_id] : [], count: 1, summary,
      reply: { gap_id: g.id, corrected: changed },
      fix: { kind, changed },
    };
  }
  const m = await env.DB.prepare('SELECT * FROM misses WHERE user_id = ? AND id = ?').bind(user, id).first();
  if (!m || m.deleted_at != null) return { refuse: 'There is no miss with that id.', field: 'miss_id' };
  if (Number(m.held) === 1) return { refuse: 'That miss is from a sitting that is not finished, so it is not on the map yet.', field: 'miss_id' };
  const { after, changed } = missAfter(m, fix, now);
  const before = pick(m, Object.keys(after));
  const summary = fixSummary(m.label, fix, changed);
  return {
    rows: [{ table: 'misses', op: 'update', key: { id: m.id }, before, after }],
    events: [{ kind: 'miss.corrected', target_type: 'miss', target_id: m.id, topic_id: m.topic_id || null, summary, before: { id: m.id, ...before }, after: { id: m.id, ...after } }],
    touched_topics: m.topic_id ? [m.topic_id] : [], count: 1, summary,
    reply: { miss_id: m.id, corrected: changed },
    fix: { kind, miss: m, next: { ...m, ...after }, changed },
  };
}

// Other areas' code, behind one object so tests can swap it (_setDeps).
const deps = {
  writeBatch: async (...a) => (await import('./events.js')).writeBatch(...a),
  lookAlikeParts: async (...a) => (await import('./ingest/hub.js')).lookAlikeParts(...a),
};
export function _setDeps(over) {
  const prev = { ...deps };
  Object.assign(deps, over);
  return () => Object.assign(deps, prev);
}

const strip = r => { const o = {}; for (const [k, v] of Object.entries(r)) if (!['id', 'user_id', 'created_at', 'created_by', 'updated_at', 'gen'].includes(k)) o[k] = v; return o; };

export async function applyCorrect(env, user, plan, ctx) {
  const now = ctx.now || Date.now();
  const rows = [...plan.rows], events = [...plan.events.map(e => ({ undoable: true, ...e }))];
  const evidence = { upsert: [], remove: [] };
  const recompute = new Set(plan.touched_topics || []);
  const f = plan.fix || {};
  if (f.kind === 'miss' && f.miss) {
    const evs = (await env.DB.prepare('SELECT * FROM evidence WHERE user_id = ? AND obs_key = ? AND slot = 0').bind(user, rawKey(user, f.miss.id)).all()).results || [];
    for (const e of evs) {
      const o = strip(e), was = JSON.stringify([o.detail_json, o.confidence]);
      if (f.changed.includes('cause')) withCause(o, f.next);
      if (f.changed.includes('confidence')) o.confidence = f.next.confidence;
      if (JSON.stringify([o.detail_json, o.confidence]) !== was) evidence.upsert.push(o);
    }
    if (f.changed.includes('cause')) {
      const la = await deps.lookAlikeParts(env, user, [f.next], now);
      rows.unshift(...la.rows);
      events.unshift(...la.events.map(e => ({ ...e, undoable: true })));
      evidence.upsert.push(...la.upsert);
      evidence.remove.push(...la.remove);
      for (const r of la.upsert) if (r.topic_id) recompute.add(r.topic_id);
      // A penalty row the miss held on another topic: that topic is rescored too when the row goes.
      const pen = (await env.DB.prepare("SELECT DISTINCT topic_id FROM evidence WHERE user_id = ? AND obs_key = ? AND kind = 'confused_with'")
        .bind(user, rawKey(user, f.miss.id)).all()).results || [];
      for (const p of pen) if (p.topic_id) recompute.add(p.topic_id);
    }
  }
  const w = await deps.writeBatch(env, user, {
    batch_id: ctx.batch_id, actor: ctx.actor, surface: ctx.surface, via: ctx.via, mo_said: ctx.mo_said, request_id: ctx.request_id,
    rows, events, evidence: evidence.upsert.length || evidence.remove.length ? evidence : undefined, recompute: [...recompute], undoable: true,
  });
  return { ok: true, batch_id: (w && w.batch_id) || ctx.batch_id, seq: w && w.seq, undo_hint: UNDO_HINT, ...(w && w.scores ? { scores: w.scores } : {}), ...(plan.reply || {}) };
}

export async function correctRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  if (!isObj(body)) throw new HttpError(400, 'Send {kind, id, cause?, confidence?, his_words?}.');
  for (const k of Object.keys(body)) if (!['kind', 'id', 'cause', 'confidence', 'his_words'].includes(k)) throw new HttpError(400, `Unknown field ${k}.`);
  if (!['miss', 'gap'].includes(body.kind)) throw new HttpError(400, 'kind is miss or gap.');
  const args = { [body.kind === 'gap' ? 'gap_id' : 'miss_id']: body.id };
  for (const k of ['cause', 'confidence', 'his_words']) if (body[k] !== undefined) args[k] = body[k];
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'miss.correct', args, via: 'api:POST /api/map/correct' }));
}

export { moFixed };
