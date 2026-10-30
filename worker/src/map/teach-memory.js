import { json, readJson, londonDay } from '../util.js';
import { applyChange, changeResponse } from './change.js';
import { EVENT_KINDS } from './events.js';
import { restoreRow } from './undo.js';
import { norm } from '../../../public/js/shared/names.js';
import { getPrefs } from '../users.js';
import { phaseFor, daysLeft } from './teach-priority.js';

export const SCOPES = ['global', 'category', 'topic', 'kind', 'surface'];
export const TACTIC_VOCAB = ['analogy', 'picture', 'mnemonic', 'contrast_pair', 'mechanism_first', 'worked_example', 'socratic', 'rule_then_cases'];
export const FAVOURITES = ['analogy', 'picture', 'mnemonic', 'contrast_pair'];
// A teaching note names one tactic, or pacing, or other.
export const TACTICS = [...TACTIC_VOCAB, 'pacing', 'other'];
export const CONTENT_TYPES = ['physiology', 'management', 'pattern'];
export const STATUSES = ['active', 'pinned', 'retired'];
export const KINDS = ['lesson', 'pair', 'pair_test', 'patch'];
export const SURFACES = ['voice', 'chat', 'code'];
export const MEMORY_MAX = { notes: 6, chars: 1600, pinned: 3 };
export const NOTE_MAX = 200, REASON_MAX = 200, REF_MAX = 80;
// Beta priors [a, b]: a favourite starts at a mean of 0.75 worth 8 lessons; the others at 0.5 worth 4.
export const PRIOR = { favourite: [6, 2], other: [2, 2] };
export const CLICK_BONUS = 0.5;      // "what clicked" names the tactic: an extra half win
export const STICK_WEIGHT = 1;       // later evidence (did it stick) counts as much as the lesson itself
export const SUGGEST_SECOND = 0.8;   // a second tactic is suggested when its draw is at least 0.8 of the first's
export const MISC_STATUSES = ['open', 'targeted', 'closed'];
export const MISC_WORDS = ['mo', 'claude'];
export const MISC_SOURCES = ['lesson', 'log_this', 'gap', 'chat', 'voice', 'mo'];
export const BELIEF_MAX = 200, MISC_REF_MAX = 60, BRIEF_MISCONCEPTIONS = 3;
export const JUDGEMENTS = ['complete', 'partial', 'wrong', 'none'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const newId = () => 'tm_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const newMiscId = () => 'mc_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const round3 = x => Math.round(x * 1000) / 1000;
const DAY_MS = 86_400_000;
const cap = (s, n) => { if (s == null) return null; const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t || null; };
export const quotesMo = text => /["“‘'][^"”’']{3,}["”’']/.test(String(text || ''));
// The event kind for misconception rows: realtime's own once it lists one, else the teaching-memory kind.
export const miscKind = () => (EVENT_KINDS.includes('misconception.saved') ? 'misconception.saved' : 'teach_memory.saved');

const byScore = (a, b) => (b.score ?? 0.5) - (a.score ?? 0.5) || (b.updated_at || 0) - (a.updated_at || 0);
export const scoreOf = (wins, losses) => round3((1 + wins) / (2 + wins + losses));

// ================================================================ 1. teaching notes

/**
 * The notes for one brief (pure): pinned first (at most 3), then notes scoped to the topic, the category, the
 * kind (pair lessons), the surface (voice), then global; each group by score, then the newest. At most 6 notes
 * and 1,600 characters of note text. at: {topic_id, category_id, kind, surface}.
 */
export function selectMemory(rows, at = {}) {
  const live = rows.filter(r => r.status === 'active' || r.status === 'pinned');
  const groups = [
    live.filter(r => r.status === 'pinned').sort(byScore).slice(0, MEMORY_MAX.pinned),
    live.filter(r => r.status !== 'pinned' && r.scope === 'topic' && at.topic_id && r.scope_ref === at.topic_id),
    live.filter(r => r.status !== 'pinned' && r.scope === 'category' && at.category_id && r.scope_ref === at.category_id),
    live.filter(r => r.status !== 'pinned' && r.scope === 'kind' && at.kind && r.scope_ref === at.kind),
    live.filter(r => r.status !== 'pinned' && r.scope === 'surface' && at.surface && r.scope_ref === at.surface),
    live.filter(r => r.status !== 'pinned' && r.scope === 'global'),
  ];
  const out = [];
  let chars = 0;
  const seen = new Set();
  for (const g of groups) {
    for (const r of g.slice().sort(byScore)) {
      if (out.length >= MEMORY_MAX.notes || seen.has(r.id)) continue;
      if (chars + r.note.length > MEMORY_MAX.chars) continue;
      seen.add(r.id);
      chars += r.note.length;
      out.push({ id: r.id, scope: r.scope, scope_ref: r.scope_ref ?? null, tactic: r.tactic, note: r.note, pinned: r.status === 'pinned' });
    }
  }
  return out;
}

// Every live note (active or pinned), for selectMemory. One query; [] before the table exists.
export async function memoryRows(env, user) {
  try {
    return (await env.DB.prepare(`SELECT id, scope, scope_ref, tactic, note, status, uses, wins, losses, score, evidence_json, created_at, updated_at
      FROM teach_memory WHERE user_id = ? AND status IN ('active','pinned') LIMIT 500`).bind(user).all()).results || [];
  } catch (e) {
    if (noTable(e)) return [];
    throw e;
  }
}

/**
 * teach_memory_list and GET /api/teach/memory: {scope?: one of SCOPES or 'all', topic?, include_retired?, limit 1-30}.
 * Returns {notes: [{id, scope, scope_ref, tactic, note, status, uses, wins, losses, score, created_by, updated_day}], total}.
 */
export async function memoryList(env, user, args = {}) {
  const a = isObj(args) ? args : {};
  for (const k of Object.keys(a)) if (!['scope', 'topic', 'include_retired', 'limit', 'scope_ref', 'surface'].includes(k)) return { refused: true, reason: `Unknown argument ${k}.` };
  const scope = a.scope == null || a.scope === 'all' ? null : a.scope;
  if (scope && !SCOPES.includes(scope)) return { refused: true, reason: `scope is one of ${SCOPES.join(', ')} or all.` };
  const limit = Number.isInteger(a.limit) ? Math.max(1, Math.min(30, a.limit)) : 15;
  const ref = a.topic != null ? String(a.topic).slice(0, 120) : a.scope_ref != null ? String(a.scope_ref).slice(0, REF_MAX) : null;
  let rows;
  try {
    rows = (await env.DB.prepare(`SELECT id, scope, scope_ref, tactic, note, status, uses, wins, losses, score, created_by, updated_at
      FROM teach_memory WHERE user_id = ?1 AND (?2 IS NULL OR scope = ?2) AND (?3 IS NULL OR scope_ref = ?3 OR scope = 'global')
        AND (?4 = 1 OR status != 'retired')
      ORDER BY status = 'pinned' DESC, score DESC, updated_at DESC LIMIT 200`).bind(user, scope, ref, a.include_retired ? 1 : 0).all()).results || [];
  } catch (e) {
    if (noTable(e)) return { notes: [], total: 0 };
    throw e;
  }
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  return { notes: rows.slice(0, limit).map(r => ({ ...r, updated_day: day(r.updated_at), updated_at: undefined })), total: rows.length };
}

// One new or edited note's fields, checked; {fix} names the one thing to change.
export function checkNote(n, { partial = false } = {}) {
  if (!isObj(n)) return { fix: 'A note is an object.' };
  if (!partial || n.scope != null) {
    if (!SCOPES.includes(n.scope)) return { fix: `scope is one of ${SCOPES.join(', ')}.` };
    if (n.scope !== 'global') {
      if (typeof n.scope_ref !== 'string' || !n.scope_ref.trim() || n.scope_ref.length > REF_MAX) return { fix: `A ${n.scope} note needs scope_ref (at most ${REF_MAX} characters).` };
      if (n.scope === 'kind' && !KINDS.includes(n.scope_ref)) return { fix: `A kind note's scope_ref is one of ${KINDS.join(', ')}.` };
      if (n.scope === 'surface' && !SURFACES.includes(n.scope_ref)) return { fix: `A surface note's scope_ref is one of ${SURFACES.join(', ')}.` };
    }
  }
  if ((!partial || n.tactic != null) && !TACTICS.includes(n.tactic)) return { fix: `tactic is one of ${TACTICS.join(', ')}.` };
  if (!partial || n.note != null) {
    if (typeof n.note !== 'string' || !n.note.trim()) return { fix: 'note is the teaching note in one line.' };
    if (n.note.length > NOTE_MAX) return { fix: `note is ${n.note.length} characters; the limit is ${NOTE_MAX}. Say it shorter.` };
  }
  return null;
}

export function newNoteRows(notes, { now, lessonId = null }) {
  return notes.map(n => {
    const id = newId();
    const pinned = n.from_mo === true;
    return {
      table: 'teach_memory', op: 'insert', key: { id },
      after: { scope: n.scope, scope_ref: n.scope === 'global' ? null : n.scope_ref, tactic: n.tactic, note: n.note.trim(),
        status: pinned ? 'pinned' : 'active', uses: 0, wins: 0, losses: 0,
        evidence_json: JSON.stringify(lessonId ? [{ at: now, lesson_id: lessonId, by: pinned ? 'mo' : 'claude' }] : []),
        source: lessonId ? 'lesson' : 'claude', source_ref: lessonId ? `lesson:${lessonId}` : null, created_by: pinned ? 'mo' : 'claude', created_at: now, updated_at: now },
    };
  });
}

// ---------------------------------------------------------------- duplicates (the tidy)

// The words of a note or belief, for telling duplicates apart (norm() is taxonomy's matching key).
const STOP = new Set(['the', 'a', 'an', 'is', 'it', 'of', 'to', 'and', 'in', 'on', 'for', 'that', 'he', 'mo', 'his', 'with', 'be', 'are', 'was', 'i', 'you', 'so', 'then', 'when']);
export const textKey = s => norm(s).split(' ').filter(w => w && !STOP.has(w)).join(' ');
export function similar(a, b) {
  const ka = textKey(a), kb = textKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const A = new Set(ka.split(' ')), B = new Set(kb.split(' '));
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both) >= 0.8;
}

export function noteMerges(notes) {
  const live = notes.filter(n => n.status === 'active' || n.status === 'pinned');
  const rank = (a, b) => (b.status === 'pinned') - (a.status === 'pinned') || (b.uses || 0) - (a.uses || 0) || (a.created_at || 0) - (b.created_at || 0) || String(a.id).localeCompare(String(b.id));
  const sorted = live.slice().sort(rank);
  const used = new Set(), out = [];
  for (const keep of sorted) {
    if (used.has(keep.id)) continue;
    const drop = sorted.filter(n => n.id !== keep.id && !used.has(n.id) && n.status !== 'pinned' && n.scope === keep.scope
      && (n.scope_ref ?? null) === (keep.scope_ref ?? null) && similar(n.note, keep.note));
    used.add(keep.id);
    if (!drop.length) continue;
    for (const d of drop) used.add(d.id);
    out.push({ keep, drop });
  }
  return out;
}

// ---------------------------------------------------------------- teach_memory_save

const SAVE_KEYS = ['id', 'scope', 'scope_ref', 'tactic', 'note', 'status', 'reason'];

export async function planMemorySave(env, user, args, ctx) {
  for (const k of Object.keys(args)) if (!SAVE_KEYS.includes(k)) return { refuse: `Unknown argument ${k}.`, field: k };
  if (args.reason != null && (typeof args.reason !== 'string' || args.reason.length > REASON_MAX)) return { refuse: `reason is at most ${REASON_MAX} characters.`, field: 'reason' };
  if (args.status != null && !STATUSES.includes(args.status)) return { refuse: `status is one of ${STATUSES.join(', ')}.`, field: 'status' };
  const byClaude = ctx.actor === 'claude';
  if (byClaude && !(typeof args.reason === 'string' && args.reason.trim())) return { refuse: 'Give a reason in one line.', field: 'reason' };
  const moWords = !byClaude || quotesMo(args.reason) || !!ctx.mo_said;
  const now = ctx.now || Date.now();
  const audit = { at: now, by: ctx.actor, reason: args.reason ? args.reason.trim() : null };

  if (args.id == null) {
    const bad = checkNote(args);
    if (bad) return { refuse: bad.fix };
    const status = args.status || 'active';
    if (status === 'retired') return { refuse: 'A new note cannot start retired.', field: 'status' };
    if (status === 'pinned' && !moWords) return { refuse: "Pin a note only with Mo's own words: quote them in reason.", field: 'reason' };
    const ref = args.scope === 'global' ? null : args.scope_ref.trim();
    const twin = (await memoryRows(env, user)).find(n => n.scope === args.scope && (n.scope_ref ?? null) === ref && similar(n.note, args.note));
    if (twin && !(status === 'pinned' && twin.status !== 'pinned')) return { noop: true, summary: `That note is already there (${twin.id}).` };
    const id = newId();
    const after = { scope: args.scope, scope_ref: ref, tactic: args.tactic, note: args.note.trim(), status,
      uses: 0, wins: 0, losses: 0, evidence_json: JSON.stringify([audit]), source: ctx.actor, created_by: status === 'pinned' ? 'mo' : ctx.actor, created_at: now, updated_at: now };
    return { rows: [{ table: 'teach_memory', op: 'insert', key: { id }, after }],
      events: [{ target_type: 'teach_memory', target_id: id, summary: `Saved a teaching note (${args.tactic.replace(/_/g, ' ')})` }],
      reply: { id, status }, summary: 'Saved a teaching note' };
  }

  if (typeof args.id !== 'string' || args.id.length > 40) return { refuse: 'id is a note id from teach_memory_list.', field: 'id' };
  let cur;
  try {
    cur = await env.DB.prepare(`SELECT id, scope, scope_ref, tactic, note, status, evidence_json, retired_reason, created_by FROM teach_memory WHERE user_id = ? AND id = ?`)
      .bind(user, args.id).first();
  } catch (e) {
    if (noTable(e)) return { refuse: 'Teaching memory is not set up yet.' };
    throw e;
  }
  if (!cur) return { refuse: 'No teaching note has that id.', field: 'id' };
  const bad = checkNote(args, { partial: true });
  if (bad) return { refuse: bad.fix };
  const status = args.status || cur.status;
  if (cur.status === 'pinned' && !moWords) return { refuse: "Only Mo changes a pinned note: quote his instruction in reason.", field: 'reason' };
  if (status === 'pinned' && cur.status !== 'pinned' && !moWords) return { refuse: "Pin a note only with Mo's own words: quote them in reason.", field: 'reason' };
  const after = {};
  for (const k of ['scope', 'tactic']) if (args[k] != null && args[k] !== cur[k]) after[k] = args[k];
  if (args.scope != null || args.scope_ref != null) {
    const scope = args.scope ?? cur.scope;
    const ref = scope === 'global' ? null : (args.scope_ref ?? cur.scope_ref);
    if (scope !== 'global' && !ref) return { refuse: `A ${scope} note needs scope_ref.`, field: 'scope_ref' };
    if (ref !== cur.scope_ref) after.scope_ref = ref;
  }
  if (args.note != null && args.note.trim() !== cur.note) after.note = args.note.trim();
  if (status !== cur.status) {
    after.status = status;
    if (status === 'retired') after.retired_reason = (args.reason || '').trim() || null;
    if (status === 'pinned') after.created_by = 'mo';
  }
  if (!Object.keys(after).length) return { noop: true, summary: 'That note already says so.' };
  after.evidence_json = JSON.stringify([...parse(cur.evidence_json, []), audit].slice(-20));
  after.updated_at = now;
  const before = Object.fromEntries(Object.keys(after).map(k => [k, cur[k] ?? null]));
  const verb = after.status === 'retired' ? 'Retired' : after.status === 'pinned' ? 'Pinned' : 'Edited';
  return { rows: [{ table: 'teach_memory', op: 'update', key: { id: cur.id }, before, after }],
    events: [{ target_type: 'teach_memory', target_id: cur.id, summary: `${verb} a teaching note (${(after.tactic || cur.tactic).replace(/_/g, ' ')})` }],
    reply: { id: cur.id, status }, summary: `${verb} a teaching note`, pinned_before: cur.status === 'pinned' };
}

// Retiring or unpinning a pinned note is confirmed when Claude does it; everything else is free.
export function memoryTier(args, plan, ctx) {
  return ctx.actor === 'claude' && plan.pinned_before && args.status && args.status !== 'pinned' ? 'confirm' : 'free';
}

/**
 * teach_memory_save (MCP): applyChange op teach_memory.save, or, with `misconception`, one of the misconception
 * ops (see misconceptionSave). ctx: {surface?, via?, mo_said?, confirm_token?, request_id?}; a confirm_token or
 * surface inside args is taken out first. Returns {id, status, batch_id, undo} or applyChange's needs_confirm / refused.
 */
export async function memorySave(env, user, args = {}, ctx = {}) {
  const { confirm_token, surface, misconception, ...rest } = isObj(args) ? args : {};
  if (misconception != null) {
    if (Object.keys(rest).some(k => k !== 'reason')) return { refused: true, reason: 'Send a misconception on its own: {misconception, reason?}.' };
    return misconceptionSave(env, user, { ...(isObj(misconception) ? misconception : { belief: misconception }), ...(rest.reason ? { reason: rest.reason } : {}) },
      { ...ctx, surface: ctx.surface || surface, confirm_token: ctx.confirm_token || confirm_token });
  }
  const r = await applyChange(env, user, { actor: ctx.actor || 'claude', surface: ctx.surface || surface || 'chat', op: 'teach_memory.save', args: rest,
    mo_said: ctx.mo_said, confirm_token: ctx.confirm_token || confirm_token, request_id: ctx.request_id, via: ctx.via || 'mcp:teach_memory_save' });
  if (!r.ok || r.nothing) return r;
  return { id: r.id, status: r.status, batch_id: r.batch_id, seq: r.seq, summary: r.summary, undo: { batch_id: r.batch_id, say: "Say 'undo that' to reverse it." } };
}

// GET /api/teach/memory?scope=&topic=&include_retired=1&limit=
export async function memoryRoute(request, env, ctx, params, url, user) {
  const q = url.searchParams;
  const r = await memoryList(env, user, {
    ...(q.get('scope') ? { scope: q.get('scope') } : {}), ...(q.get('topic') ? { topic: q.get('topic') } : {}),
    include_retired: q.get('include_retired') === '1', limit: Number(q.get('limit')) || 30,
  });
  return r.refused ? json({ error: r.reason }, 400) : json(r);
}

export async function memoryPatchRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'teach_memory.save', args: { ...body, id: params.id },
    via: 'api:PATCH /api/teach/memory' }));
}

// ================================================================ 2. tactics

// A small, fast PRNG (mulberry32) and a seed from any text (FNV-1a), so a lesson's draws never change.
export function seedOf(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
// Gamma(k, 1) by Marsaglia and Tsang (k < 1 boosted), then Beta(a, b) = X / (X + Y).
export function gamma(k, r) {
  if (k < 1) return gamma(k + 1, r) * Math.pow(r() || 1e-12, 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(r);
    const v0 = 1 + c * x;
    if (v0 <= 0) continue;
    const v = v0 * v0 * v0, u = r();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export function betaSample(a, b, r) {
  const x = gamma(a, r), y = gamma(b, r);
  return x / (x + y);
}

export const priorOf = (tactic, favourites = FAVOURITES) => (favourites.includes(tactic) ? PRIOR.favourite : PRIOR.other);

/** Each tactic's posterior for one content type: [{tactic, a, b, mean, lessons, clicked, favourite}], best mean first. */
export function posteriors(rows, contentType, favourites = FAVOURITES) {
  const mine = new Map((rows || []).filter(r => r.content_type === contentType).map(r => [r.tactic, r]));
  return TACTIC_VOCAB.map(t => {
    const r = mine.get(t) || {};
    const [pa, pb] = priorOf(t, favourites);
    const a = pa + Math.max(0, Number(r.wins) || 0), b = pb + Math.max(0, Number(r.losses) || 0);
    return { tactic: t, a: round3(a), b: round3(b), mean: round3(a / (a + b)), lessons: Number(r.uses) || 0, clicked: Number(r.clicked_n) || 0, favourite: favourites.includes(t) };
  }).sort((x, y) => y.mean - x.mean || TACTIC_VOCAB.indexOf(x.tactic) - TACTIC_VOCAB.indexOf(y.tactic));
}

/**
 * Thompson sampling (pure, deterministic): one draw from each tactic's Beta posterior with a PRNG seeded by the
 * lesson id and content type; the best draw is suggested, and the second too when its draw is at least 0.8 of
 * the first's. Returns {content_type, suggest: [{tactic, mean, draw}], draws: [...all, best first]}.
 */
export function thompsonPick(rows, { contentType, seed, favourites = FAVOURITES, avoid = [] }) {
  const r = rng(seedOf(`${seed}|${contentType}`));
  // Every tactic is drawn (the random sequence stays the same), then the ones to avoid (the angle that just failed)
  // are left out of the suggestion, unless that would leave nothing.
  const skip = new Set((avoid || []).filter(t => TACTIC_VOCAB.includes(t)));
  const all = posteriors(rows, contentType, favourites).map(p => ({ tactic: p.tactic, mean: p.mean, draw: round3(betaSample(p.a, p.b, r)) }));
  const draws = (skip.size && skip.size < all.length ? all.filter(d => !skip.has(d.tactic)) : all)
    .sort((x, y) => y.draw - x.draw || TACTIC_VOCAB.indexOf(x.tactic) - TACTIC_VOCAB.indexOf(y.tactic));
  const suggest = [draws[0]];
  if (draws[1] && draws[1].draw >= SUGGEST_SECOND * draws[0].draw) suggest.push(draws[1]);
  return { content_type: contentType, suggest, draws };
}

/**
 * The content type of a lesson (pure): pair lessons and recognise / distinguish goals are pattern recognition;
 * concept topics are physiology; test, treat and trap goals are management. Claude can correct it at lesson_save.
 */
export function contentTypeOf({ mode, topicKind, goalHint } = {}) {
  if (mode === 'pair' || mode === 'pair_test') return 'pattern';
  if (topicKind === 'concept') return 'physiology';
  if (goalHint === 'recognise' || goalHint === 'distinguish') return 'pattern';
  return 'management';
}

const CLICK_WORDS = {
  analogy: /\b(analog\w*|metaphor|it'?s like|gauge|imagin\w*)\b/,
  picture: /\b(picture\w*|image\w*|diagram\w*|drawing|drew|draw|flow ?chart\w*|visual\w*|photo\w*)\b/,
  mnemonic: /\b(mnemonic\w*|acronym\w*|rhyme\w*|memory aid|memory hook)\b/,
  contrast_pair: /\b(versus|vs|contrast\w*|compar\w*|side by side|look-? ?alike\w*|minimal pair\w*|tell(ing)? (them )?apart|the difference)\b/,
  mechanism_first: /\b(mechanism\w*|physiolog\w*|pathophysiolog\w*|why it happens|first principles|the why)\b/,
  worked_example: /\b(worked example\w*|the example|an example|walk(ed)? (me )?through|real numbers)\b/,
  socratic: /\b(socratic|asking me|made me think|work(ed|ing)? (it )?out (for )?myself|figur(ed|ing) it out|questions first)\b/,
  rule_then_cases: /\b(rule then|rules? first|the rule and then|algorithm\w*|step[- ]by[- ]step|framework\w*|checklist\w*)\b/,
};
export function clickedTactics(text) {
  const s = String(text || '').toLowerCase();
  return s ? TACTIC_VOCAB.filter(t => CLICK_WORDS[t].test(s)) : [];
}

export function lessonDeltas({ contentType, used = [], clicked = [], blend }) {
  if (blend == null || !CONTENT_TYPES.includes(contentType)) return [];
  const all = [...new Set(used)].filter(t => TACTIC_VOCAB.includes(t));
  const hit = t => clicked.includes(t);
  return all.map(t => ({ content_type: contentType, tactic: t, wins: round3(blend + (hit(t) ? CLICK_BONUS : 0)), losses: round3(1 - blend), uses: 1, clicked: hit(t) ? 1 : 0 }));
}
// What later evidence adds to a past lesson's tactics: a lesson's worth (STICK_WEIGHT), split by how well it stuck.
export function stickDeltas({ contentType, used = [], stick }) {
  if (stick == null || !CONTENT_TYPES.includes(contentType)) return [];
  return used.filter(t => TACTIC_VOCAB.includes(t)).map(t => ({ content_type: contentType, tactic: t, wins: round3(STICK_WEIGHT * stick), losses: round3(STICK_WEIGHT * (1 - stick)), uses: 0, clicked: 0 }));
}
const dkey = d => `${d.content_type}|${d.tactic}`;
// a - b, per key (a re-save applies only the difference from what the lesson added before).
export function subtractDeltas(a, b) {
  const out = new Map(a.map(d => [dkey(d), { ...d }]));
  for (const d of b || []) {
    const cur = out.get(dkey(d)) || { content_type: d.content_type, tactic: d.tactic, wins: 0, losses: 0, uses: 0, clicked: 0 };
    out.set(dkey(d), { ...cur, wins: round3(cur.wins - d.wins), losses: round3(cur.losses - d.losses), uses: cur.uses - d.uses, clicked: cur.clicked - d.clicked });
  }
  return [...out.values()].filter(d => d.wins || d.losses || d.uses || d.clicked);
}
export function sumDeltas(lists) {
  const out = new Map();
  for (const d of lists.flat()) {
    const cur = out.get(dkey(d)) || { content_type: d.content_type, tactic: d.tactic, wins: 0, losses: 0, uses: 0, clicked: 0 };
    out.set(dkey(d), { ...cur, wins: round3(cur.wins + d.wins), losses: round3(cur.losses + d.losses), uses: cur.uses + d.uses, clicked: cur.clicked + d.clicked });
  }
  return [...out.values()];
}

/**
 * Row diffs for tactic_scores from deltas (pure): an insert for a pair not seen yet, else an update of the sums
 * (never below zero). current: Map 'type|tactic' -> row. Each row has its own event, so undo takes the
 * difference back out (undoTacticScore), whatever other lessons added since.
 */
export function tacticRows(current, deltas, { now, sourceRef }) {
  const rows = [], events = [];
  for (const d of deltas) {
    const key = { content_type: d.content_type, tactic: d.tactic };
    const cur = current.get(dkey(d));
    const next = { wins: round3(Math.max(0, (cur ? Number(cur.wins) : 0) + d.wins)), losses: round3(Math.max(0, (cur ? Number(cur.losses) : 0) + d.losses)),
      uses: Math.max(0, (cur ? Number(cur.uses) : 0) + d.uses), clicked_n: Math.max(0, (cur ? Number(cur.clicked_n) : 0) + d.clicked) };
    if (d.uses > 0) next.last_used_at = now;
    const event = { kind: 'teach_memory.saved', target_type: 'tactic_score', target_id: dkey(d).replace('|', ':'),
      summary: `Tactic score: ${d.tactic.replace(/_/g, ' ')} for ${d.content_type}`.slice(0, 160) };
    if (!cur) {
      const after = { ...next, source: 'lesson', source_ref: sourceRef, created_by: 'code', created_at: now, updated_at: now };
      rows.push({ table: 'tactic_scores', op: 'insert', key, after });
      events.push({ ...event, before: null, after: { ...key, ...after } });
    } else {
      const after = { ...next, updated_at: now };
      const before = Object.fromEntries(Object.keys(after).map(k => [k, cur[k] ?? null]));
      rows.push({ table: 'tactic_scores', op: 'update', key, before, after });
      events.push({ ...event, before: { ...key, ...before }, after: { ...key, ...after } });
    }
    current.set(dkey(d), { ...(cur || {}), ...key, ...next });
  }
  return { rows, events };
}

// realtime's undo for a tactic_scores event: take back what the change added (after − before), from the row as
// it is now, so a later lesson's additions stay.
export async function undoTacticScore(env, user, event, ctx = {}) {
  const before = parse(event.before_json, null) || {}, after = parse(event.after_json, null) || {};
  const key = { content_type: after.content_type || before.content_type, tactic: after.tactic || before.tactic };
  if (!key.content_type || !key.tactic) return { conflict: "That tactic change can't be undone automatically." };
  const cur = await env.DB.prepare(`SELECT wins, losses, uses, clicked_n, updated_at FROM tactic_scores WHERE user_id = ? AND content_type = ? AND tactic = ?`)
    .bind(user, key.content_type, key.tactic).first();
  if (!cur) return { rows: [] };
  const d = c => (Number(after[c]) || 0) - (Number(before[c]) || 0);
  const next = { wins: round3(Math.max(0, cur.wins - d('wins'))), losses: round3(Math.max(0, cur.losses - d('losses'))),
    uses: Math.max(0, cur.uses - d('uses')), clicked_n: Math.max(0, cur.clicked_n - d('clicked_n')), updated_at: ctx.now || Date.now() };
  return { rows: [{ table: 'tactic_scores', op: 'update', key, before: { wins: cur.wins, losses: cur.losses, uses: cur.uses, clicked_n: cur.clicked_n, updated_at: cur.updated_at }, after: next }] };
}

/**
 * UNDO['target:note_use'] (a lesson's use of a teaching note): this lesson's uses, wins and losses come back out of
 * the note as it is now, and its evidence entries go, so a later lesson's use of the same note stays.
 */
export async function undoNoteUse(env, user, event, ctx = {}) {
  const before = parse(event.before_json, null) || {}, after = parse(event.after_json, null) || {};
  const id = after.id || before.id || event.target_id;
  const cur = id ? await env.DB.prepare(`SELECT uses, wins, losses, score, evidence_json, updated_at FROM teach_memory WHERE user_id = ? AND id = ?`).bind(user, id).first() : null;
  if (!cur) return { rows: [] };
  const d = c => (Number(after[c]) || 0) - (Number(before[c]) || 0);
  const wins = round3(Math.max(0, (Number(cur.wins) || 0) - d('wins'))), losses = round3(Math.max(0, (Number(cur.losses) || 0) - d('losses')));
  const had = new Set(parse(before.evidence_json, []).map(x => JSON.stringify(x)));
  const mine = new Set(parse(after.evidence_json, []).map(x => JSON.stringify(x)).filter(x => !had.has(x)));
  const next = { uses: Math.max(0, (Number(cur.uses) || 0) - d('uses')), wins, losses, score: scoreOf(wins, losses),
    evidence_json: JSON.stringify(parse(cur.evidence_json, []).filter(x => !mine.has(JSON.stringify(x)))), updated_at: ctx.now || Date.now() };
  return { rows: [{ table: 'teach_memory', op: 'update', key: { id }, before: Object.fromEntries(Object.keys(next).map(k => [k, cur[k] ?? null])), after: next }] };
}

// All of a user's tactic rows (at most 24). [] before the table exists.
export async function tacticScoreRows(env, user) {
  try {
    return (await env.DB.prepare(`SELECT content_type, tactic, wins, losses, uses, clicked_n, last_used_at FROM tactic_scores WHERE user_id = ? LIMIT 100`).bind(user).all()).results || [];
  } catch (e) {
    if (noTable(e)) return [];
    throw e;
  }
}

/** The brief's `tactics` (pure): the content type, the Thompson picks for this lesson, and the best three by mean. */
export function tacticBrief(rows, { contentType, lessonId, favourites = FAVOURITES, avoid = [] }) {
  const pick = thompsonPick(rows, { contentType, seed: lessonId || 'peek', favourites, avoid });
  return {
    content_type: contentType, try: pick.suggest.map(s => s.tactic),
    best: posteriors(rows, contentType, favourites).slice(0, 3).map(p => ({ tactic: p.tactic, mean100: Math.round(p.mean * 100), lessons: p.lessons })),
    favourites,
  };
}

// ================================================================ 3. misconceptions

export const beliefKey = s => textKey(s).slice(0, 200);
export const beatsIt = a => !!(a && ((a.teach_back && a.teach_back.judgement === 'complete')
  || (a.final_case && a.final_case.result === 'right' && a.final_case.explanation_judgement && a.final_case.explanation_judgement.verdict === 'complete')));

// The brief's misconceptions (pure): open and targeted beliefs on the topic, newest first, at most 3.
export function briefMisconceptions(rows, now = Date.now()) {
  return (rows || []).filter(m => m.status !== 'closed').sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0)).slice(0, BRIEF_MISCONCEPTIONS)
    .map(m => ({ id: m.id, belief: cap(m.belief, BELIEF_MAX), status: m.status, words: m.words, ref: m.ref || null, seen_n: m.seen_n || 1,
      first_seen: londonDay(m.first_seen || now) }));
}

// One misconception to add, checked (pure); {fix} names the one thing to change.
export function checkBelief(m, where = 'misconception') {
  if (!isObj(m)) return { fix: `${where} is an object: {belief, ref?}.` };
  if (typeof m.belief !== 'string' || !m.belief.trim()) return { fix: `${where}.belief is the wrong belief in one line.` };
  if (m.belief.length > BELIEF_MAX) return { fix: `${where}.belief is ${m.belief.length} characters; the limit is ${BELIEF_MAX}.` };
  if (m.ref != null && (typeof m.ref !== 'string' || m.ref.length > MISC_REF_MAX)) return { fix: `${where}.ref is a label of at most ${MISC_REF_MAX} characters, such as UW 4757.` };
  if (m.words != null && !MISC_WORDS.includes(m.words)) return { fix: `${where}.words is mo (his own words) or claude.` };
  if (!textKey(m.belief)) return { fix: `${where}.belief needs some words.` };
  return null;
}

// Summaries name the topic, never the belief (I23: summaries are built from labels and names; LS3-2).
const miscSummary = (verb, r) => {
  const t = r && (r.topic_name || r.topic_id);
  return (t ? `${verb}: ${t}` : verb).slice(0, 160);
};
const miscEvent = (row, verb) => ({ kind: miscKind(), target_type: 'misconception', target_id: row.key.id,
  summary: miscSummary(verb, { ...(row.before || {}), ...(row.after || {}) }) });
async function refQuestions(env, user, refs) {
  const { hubQuestionsOfRef } = await import('./resolve.js');
  const out = [];
  for (const r of [...new Set((refs || []).filter(x => typeof x === 'string' && x.trim()))].slice(0, 4)) {
    try { out.push(...await hubQuestionsOfRef(env, user, r)); } catch (e) { if (!noTable(e)) throw e; }
  }
  return out.slice(0, 20);
}
const pinEv = (e, r) => ({ ...e, before: r.before == null ? null : { ...r.key, ...r.before }, after: { ...r.key, ...r.after } });

export function wordsOf(m) {
  const t = String((m && m.belief) || '').trim();
  const q = /^["“‘'](.+)["”’']$/.exec(t);
  return { belief: q ? q[1].trim() : t, words: (m && m.words) || (q ? 'mo' : 'claude') };
}

/**
 * A new belief as rows (pure): an insert, or, when the same belief (same topic, same or nearly the same words)
 * is already there and not closed, an update that counts it again. A closed one seen again opens again.
 * existing: the topic's misconception rows. lessonId: the lesson it showed in (it is then targeted at once).
 */
export function addBeliefRows(existing, given, { topicId, topicName, now, actor, lessonId = null, source = 'chat', sourceRef = null }) {
  const m = { ...given, ...wordsOf(given) };
  const twin = (existing || []).find(x => (x.topic_id ?? null) === (topicId ?? null) && similar(x.belief, m.belief));
  const status = lessonId ? 'targeted' : 'open';
  if (twin) {
    const lessons = parse(twin.lesson_ids_json, []);
    const again = (lessonId && lessons.includes(lessonId)) || (m.ref && twin.ref && String(m.ref).trim().toLowerCase() === String(twin.ref).trim().toLowerCase());
    const after = { last_seen: again ? twin.last_seen : now, seen_n: again ? twin.seen_n : (twin.seen_n || 1) + 1, updated_at: now };
    if (m.ref && m.ref !== twin.ref) after.ref = m.ref.trim();
    if (lessonId && !lessons.includes(lessonId)) after.lesson_ids_json = JSON.stringify([...lessons, lessonId].slice(-20));
    if (twin.status === 'closed') { after.status = status; after.closed_at = null; after.closed_by = null; }
    if (status === 'targeted' && twin.status === 'open') { after.status = 'targeted'; after.targeted_at = now; }
    const before = Object.fromEntries(Object.keys(after).map(k => [k, twin[k] ?? null]));
    const row = { table: 'misconceptions', op: 'update', key: { id: twin.id }, before, after };
    const ev = pinEv(miscEvent({ key: row.key, after: { belief: twin.belief, topic_name: twin.topic_name, topic_id: twin.topic_id } }, twin.status === 'closed' ? 'Misconception back' : 'Misconception seen again'), row);
    return { row, event: ev, id: twin.id, merged: true, status: after.status || twin.status };
  }
  const id = newMiscId();
  const after = { topic_id: topicId || null, topic_name: topicName ? String(topicName).slice(0, 120) : null, belief: m.belief.trim(), belief_key: beliefKey(m.belief),
    words: m.words, ref: m.ref ? m.ref.trim() : null, status, first_seen: now, last_seen: now, seen_n: 1, targeted_at: lessonId ? now : null,
    first_lesson_id: lessonId, lesson_ids_json: JSON.stringify(lessonId ? [lessonId] : []), source, source_ref: sourceRef, created_by: actor === 'mo' ? 'mo' : 'claude',
    created_at: now, updated_at: now };
  const row = { table: 'misconceptions', op: 'insert', key: { id }, after };
  return { row, event: pinEv(miscEvent(row, 'Misconception logged'), row), id, merged: false, status };
}

/** A status move as a row (pure): open -> targeted, anything -> closed (closed_by), closed -> open again. */
export function statusRow(cur, status, { now, by = null, lessonId = null, note } = {}) {
  const after = { status, updated_at: now };
  if (status === 'targeted' && cur.status !== 'targeted') after.targeted_at = now;
  if (status === 'closed') { after.closed_at = now; after.closed_by = by; }
  if (status !== 'closed' && cur.status === 'closed') { after.closed_at = null; after.closed_by = null; }
  if (lessonId) {
    const lessons = parse(cur.lesson_ids_json, []);
    if (!lessons.includes(lessonId)) after.lesson_ids_json = JSON.stringify([...lessons, lessonId].slice(-20));
  }
  if (note !== undefined) after.note = note;
  const before = Object.fromEntries(Object.keys(after).map(k => [k, cur[k] ?? null]));
  const row = { table: 'misconceptions', op: 'update', key: { id: cur.id }, before, after };
  const verb = status === 'closed' ? 'Misconception closed' : status === 'targeted' ? 'Misconception being worked on' : 'Misconception open again';
  return { row, event: pinEv(miscEvent({ key: row.key, after: { belief: cur.belief, topic_name: cur.topic_name, topic_id: cur.topic_id } }, verb), row) };
}

export function lessonMisconceptions({ existing, served = [], add = [], closed = [], worked = null, lesson, args, topicId, topicName, now, done }) {
  const out = { rows: [], events: [], added: [], closed: [], kept: [] };
  if (!done) return out;
  const byId = new Map((existing || []).map(m => [m.id, m]));
  const touched = new Set();
  const push = (r, id) => { out.rows.push(r.row); out.events.push(r.event); touched.add(id); };
  const beat = beatsIt(args);
  for (const id of closed) {
    const m = byId.get(id);
    if (!m) { out.kept.push({ id, why: 'No misconception has that id.' }); continue; }
    if (m.status === 'closed') continue;
    // Closing is earned in a LATER lesson: the belief must have been worked on in an earlier one (refuted, then
    // left to return). One logged minutes before this lesson ("log this", gap) and refuted here waits (LRN2-3).
    const earlier = parse(m.lesson_ids_json, []).some(x => x !== lesson.id);
    if (m.first_lesson_id === lesson.id || (m.first_seen || 0) >= (lesson.started_at || now) || !earlier) { out.kept.push({ id, why: 'It showed in this lesson: it closes when he beats it in a later lesson or on later questions.' }); continue; }
    if (!beat) { out.kept.push({ id, why: 'Kept as targeted: he has not beaten it in a teach-back or an explained final case yet.' }); continue; }
    const r = statusRow(m, 'closed', { now, by: `lesson:${lesson.id}`, lessonId: lesson.id });
    push(r, id);
    out.closed.push(id);
  }
  const workedOn = Array.isArray(worked) ? worked.filter(id => served.includes(id) || byId.has(id)) : served.slice(0, 1);
  for (const id of [...workedOn, ...out.kept.map(k => k.id)]) {
    const m = byId.get(id);
    if (!m || touched.has(id) || m.status === 'closed') continue;
    const lessons = parse(m.lesson_ids_json, []);
    if (m.status === 'targeted' && lessons.includes(lesson.id)) continue;
    push(statusRow(m, 'targeted', { now, lessonId: lesson.id }), id);
  }
  const pool = [...(existing || [])];
  for (const a of add) {
    const r = addBeliefRows(pool, a, { topicId, topicName, now, actor: 'claude', lessonId: lesson.id, source: 'lesson', sourceRef: `lesson:${lesson.id}` });
    if (touched.has(r.id)) {
      const i = out.rows.findIndex(x => x.key.id === r.id);
      const cur = byId.get(r.id);
      if (i < 0 || !r.merged || !cur || parse(cur.lesson_ids_json, []).includes(lesson.id)) continue;
      const row = out.rows[i];
      const sight = { status: 'targeted', targeted_at: now, last_seen: now, seen_n: (cur.seen_n || 1) + 1 };
      if (r.row.after.ref) sight.ref = r.row.after.ref;
      if (row.after.status === 'closed') {
        Object.assign(sight, { closed_at: cur.closed_at ?? null, closed_by: cur.closed_by ?? null });
        out.closed = out.closed.filter(x => x !== r.id);
        out.kept.push({ id: r.id, why: 'He said it again in this lesson: kept as targeted.' });
      }
      for (const [k, v] of Object.entries(sight)) { if (!(k in row.before)) row.before[k] = cur[k] ?? null; row.after[k] = v; }
      out.events[i] = pinEv(miscEvent({ key: row.key, after: { belief: cur.belief, topic_name: cur.topic_name, topic_id: cur.topic_id } }, 'Misconception seen again'), row);
      out.added.push({ id: r.id, merged: true });
      continue;
    }
    push(r, r.id);
    out.added.push({ id: r.id, merged: r.merged });
    if (!r.merged) pool.push({ id: r.id, ...r.row.after });
  }
  return out;
}

/**
 * The tidy's "later questions" rule (pure): a targeted misconception closes when its topic has had at least three
 * right answers at least 2 days after it was targeted (teach-save's MISC_CLOSE_AFTER_MS) and nothing wrong since it
 * was targeted. Topic-level answers may test another aspect of the topic, so two were too few (LRN3-4).
 * rows: [{...misconception, right_n, wrong_n}].
 */
export const MISC_CLOSE_RIGHTS = 3;
export function autoCloseRows(rows, { now }) {
  const out = { rows: [], events: [], closed: [] };
  for (const m of rows || []) {
    if (m.status !== 'targeted' || (Number(m.wrong_n) || 0) > 0 || (Number(m.right_n) || 0) < MISC_CLOSE_RIGHTS) continue;
    const r = statusRow(m, 'closed', { now, by: 'questions' });
    out.rows.push(r.row);
    out.events.push(r.event);
    out.closed.push(m.id);
  }
  return out;
}

const MISC_KEYS = ['id', 'topic', 'belief', 'ref', 'words', 'status', 'note', 'source', 'lesson_id', 'reason'];

async function readMisc(env, user, id) {
  try { return await env.DB.prepare(`SELECT * FROM misconceptions WHERE user_id = ? AND id = ?`).bind(user, id).first(); } catch (e) { if (noTable(e)) return null; throw e; }
}

// The topic named for a new misconception: '(map: id)', an id, or a name; null when it is not on the map.
async function topicFor(env, user, text) {
  if (!text) return null;
  const { resolveTopic, liveTopic } = await import('./resolve.js');
  const m = /\(map:\s*([a-z0-9._-]+)\s*\)/i.exec(text);
  const bare = String(text).replace(/\(map:[^)]*\)/i, '').trim();
  try {
    const direct = await liveTopic(env, user, (m ? m[1] : bare).toLowerCase());
    if (direct) return { id: direct.id, name: direct.name };
    const r = await resolveTopic(env, user, { texts: [bare], source: 'teach', source_ref: 'misconception' });
    if (r.topic_id && (r.confidence ?? 0) >= 0.85) {
      const t = await liveTopic(env, user, r.topic_id);
      if (t) return { id: t.id, name: t.name };
    }
  } catch (e) { if (!noTable(e)) throw e; }
  return null;
}

export async function planMisconceptionAdd(env, user, args, ctx) {
  for (const k of Object.keys(args)) if (!MISC_KEYS.includes(k) || ['id', 'status', 'note'].includes(k)) return { refuse: `Unknown argument ${k}.`, field: k };
  const bad = checkBelief(args);
  if (bad) return { refuse: bad.fix, field: 'belief' };
  if (args.topic != null && (typeof args.topic !== 'string' || args.topic.length > 120)) return { refuse: 'topic is the topic as AMBOSS names it, at most 120 characters.', field: 'topic' };
  if (args.source != null && !MISC_SOURCES.includes(args.source)) return { refuse: `source is one of ${MISC_SOURCES.join(', ')}.`, field: 'source' };
  const now = ctx.now || Date.now();
  const topic = await topicFor(env, user, args.topic);
  let existing = [];
  try {
    existing = (await env.DB.prepare(`SELECT * FROM misconceptions WHERE user_id = ?1 AND coalesce(topic_id, '') = ?2 ORDER BY last_seen DESC LIMIT 100`)
      .bind(user, topic ? topic.id : '').all()).results || [];
  } catch (e) { if (noTable(e)) return { refuse: 'Misconceptions arrive with the map update (migration 0010).' }; throw e; }
  const source = args.source || (ctx.actor === 'mo' ? 'mo' : ctx.surface === 'voice' ? 'voice' : 'chat');
  const r = addBeliefRows(existing, args, { topicId: topic ? topic.id : null, topicName: topic ? topic.name : args.topic || null, now, actor: ctx.actor,
    lessonId: null, source, sourceRef: args.ref ? String(args.ref).slice(0, MISC_REF_MAX) : null });
  // The hub question the ref names is in the guard's leak index even before its miss is on the map (LS3-2).
  const questions = await refQuestions(env, user, [args.ref]);
  return { rows: [r.row], events: [r.event], touched_topics: topic ? [topic.id] : [], refs: { questions }, summary: r.event.summary,
    reply: { id: r.id, status: r.status, merged: r.merged, topic: topic ? { id: topic.id, name: topic.name } : null,
      ...(topic ? {} : { note: args.topic ? 'That topic is not on the map yet: the belief is kept by its name and joins the topic once it is added.' : 'No topic: say which topic it is about when you can.' }) } };
}

// Planner for ops misconception.target, misconception.close and misconception.update.
async function planMiscStatus(env, user, args, ctx, op) {
  for (const k of Object.keys(args)) if (!MISC_KEYS.includes(k) || ['topic', 'words', 'source'].includes(k)) return { refuse: `Unknown argument ${k}.`, field: k };
  if (typeof args.id !== 'string' || !args.id || args.id.length > 40) return { refuse: 'id is a misconception id (mc_…) from the brief or the Teaching page.', field: 'id' };
  if (args.reason != null && (typeof args.reason !== 'string' || args.reason.length > REASON_MAX)) return { refuse: `reason is at most ${REASON_MAX} characters.`, field: 'reason' };
  if (args.note != null && (typeof args.note !== 'string' || args.note.length > 200)) return { refuse: 'note is at most 200 characters.', field: 'note' };
  const cur = await readMisc(env, user, args.id);
  if (!cur) return { refuse: 'No misconception has that id.', field: 'id' };
  const now = ctx.now || Date.now();
  const status = op === 'misconception.target' ? 'targeted' : op === 'misconception.close' ? 'closed' : args.status ?? cur.status;
  if (!MISC_STATUSES.includes(status)) return { refuse: `status is one of ${MISC_STATUSES.join(', ')}.`, field: 'status' };
  const by = status === 'closed' ? (ctx.actor === 'mo' ? 'mo' : args.lesson_id ? `lesson:${args.lesson_id}` : 'claude') : null;
  const r = statusRow(cur, status, { now, by, lessonId: args.lesson_id || null, ...(args.note !== undefined ? { note: args.note.trim() || null } : {}) });
  if (op === 'misconception.update') {
    if (args.belief != null) {
      const bad = checkBelief({ belief: args.belief });
      if (bad) return { refuse: bad.fix, field: 'belief' };
      if (args.belief.trim() !== cur.belief) { r.row.after.belief = args.belief.trim(); r.row.after.belief_key = beliefKey(args.belief); r.row.before.belief = cur.belief; r.row.before.belief_key = cur.belief_key; }
    }
    if (args.ref != null) {
      if (typeof args.ref !== 'string' || args.ref.length > MISC_REF_MAX) return { refuse: `ref is at most ${MISC_REF_MAX} characters.`, field: 'ref' };
      if (args.ref.trim() !== (cur.ref || '')) { r.row.after.ref = args.ref.trim() || null; r.row.before.ref = cur.ref ?? null; }
    }
  }
  const changed = Object.keys(r.row.after).filter(k => k !== 'updated_at' && JSON.stringify(r.row.after[k] ?? null) !== JSON.stringify(cur[k] ?? null));
  if (!changed.length) return { noop: true, summary: `That misconception is already ${cur.status}.` };
  r.event = pinEv({ ...r.event, summary: status === cur.status ? miscSummary('Misconception edited', cur) : r.event.summary }, r.row);
  const questions = await refQuestions(env, user, [r.row.after.ref ?? cur.ref]);
  return { rows: [r.row], events: [r.event], touched_topics: cur.topic_id ? [cur.topic_id] : [], refs: { questions }, summary: r.event.summary, reply: { id: cur.id, status },
    closing_by_claude: status === 'closed' && cur.status !== 'closed' && ctx.actor === 'claude' && !args.lesson_id };
}
export const planMisconceptionTarget = (env, user, args, ctx) => planMiscStatus(env, user, args, ctx, 'misconception.target');
export const planMisconceptionClose = (env, user, args, ctx) => planMiscStatus(env, user, args, ctx, 'misconception.close');
export const planMisconceptionUpdate = (env, user, args, ctx) => planMiscStatus(env, user, args, ctx, 'misconception.update');
export const misconceptionTier = (args, plan, ctx) => (plan && plan.closing_by_claude ? 'confirm' : 'free');

/**
 * Claude's way in (teach_memory_save {misconception}): no id adds one (from a lesson, "log this" or a gap);
 * an id with status targeted or closed moves it; an id with other fields edits it.
 */
export async function misconceptionSave(env, user, m = {}, ctx = {}) {
  const op = m.id == null ? 'misconception.add' : m.status === 'targeted' ? 'misconception.target' : m.status === 'closed' ? 'misconception.close' : 'misconception.update';
  const args = { ...m };
  if (op === 'misconception.target' || op === 'misconception.close') delete args.status;
  const r = await applyChange(env, user, { actor: ctx.actor || 'claude', surface: ctx.surface || 'chat', op, args, mo_said: ctx.mo_said,
    confirm_token: ctx.confirm_token, request_id: ctx.request_id, via: ctx.via || 'mcp:teach_memory_save' });
  if (!r.ok || r.nothing) return r;
  return { id: r.id, status: r.status, ...(r.merged != null ? { merged: r.merged } : {}), ...(r.topic !== undefined ? { topic: r.topic } : {}), ...(r.note ? { note: r.note } : {}),
    batch_id: r.batch_id, seq: r.seq, summary: r.summary, undo: { batch_id: r.batch_id, say: "Say 'undo that' to reverse it." } };
}

// realtime's undo for a misconception event: the row back to how it was (an insert is removed), unless it changed since.
export async function undoMisconception(env, user, event, ctx = {}) {
  const before = parse(event.before_json, null), after = parse(event.after_json, null);
  const id = (after && after.id) || (before && before.id) || event.target_id;
  const current = await readMisc(env, user, id);
  const strip = o => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'user_id')) : o);
  const r = restoreRow('misconceptions', { id }, strip(before), strip(after), current, ctx.now || Date.now());
  if (r.conflict) return { conflict: r.conflict };
  if (r.row && r.row.op === 'insert') r.row.after = Object.fromEntries(Object.entries(r.row.after).filter(([k]) => k !== 'id'));
  return { rows: r.row ? [r.row] : [] };
}

// GET /api/teach/misconceptions?topic=&status=open|targeted|closed|live -> {misconceptions: [...]}
export async function misconceptionsRoute(request, env, ctx, params, url, user) {
  const topic = url.searchParams.get('topic');
  const status = url.searchParams.get('status') || 'live';
  if (!['live', ...MISC_STATUSES, 'all'].includes(status)) return json({ error: 'status is open, targeted, closed, live or all.' }, 400);
  let rows = [];
  try {
    rows = (await env.DB.prepare(`SELECT id, topic_id, topic_name, belief, words, ref, status, first_seen, last_seen, seen_n, targeted_at, closed_at, closed_by,
        lesson_ids_json, note FROM misconceptions WHERE user_id = ?1 AND (?2 IS NULL OR topic_id = ?2)
        AND (?3 = 'all' OR (?3 = 'live' AND status <> 'closed') OR status = ?3) ORDER BY last_seen DESC LIMIT 200`).bind(user, topic || null, status).all()).results || [];
  } catch (e) { if (!noTable(e)) throw e; }
  return json({ misconceptions: rows.map(shapeMisc) });
}
const shapeMisc = m => ({ id: m.id, topic_id: m.topic_id, topic: m.topic_name, belief: m.belief, words: m.words, ref: m.ref, status: m.status,
  first_seen: m.first_seen, last_seen: m.last_seen, seen_n: m.seen_n, targeted_at: m.targeted_at ?? null, closed_at: m.closed_at ?? null, closed_by: m.closed_by ?? null,
  lessons: parse(m.lesson_ids_json, []), note: m.note ?? null });

export async function misconceptionPostRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'misconception.add', args: { words: 'mo', source: 'mo', ...body },
    via: 'api:POST /api/teach/misconceptions' }));
}
export async function misconceptionPatchRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'misconception.update', args: { ...body, id: params.id },
    via: 'api:PATCH /api/teach/misconceptions' }));
}


// Later evidence on a topic as a pass (1) or fail (1) per row, in SQL: right answers, re-tests got, mature cards and
// sound card checks count for; wrong answers, re-tests missed, stated gaps, dated card lapses and a review's gap
// (shaky half) count against (LRN4-4: a review gap on the lesson's card is the card saying it did not stick).
// Lesson rows never count.
export const PASS_SQL = `(CASE WHEN e.kind = 'question' AND e.result = 'right' THEN 1.0 WHEN e.kind = 'question' AND e.result = 'flawed' THEN 0.5
  WHEN e.kind = 'retest' AND coalesce(e.outcome, e.result) IN ('got_it','right') THEN 1.0 WHEN e.kind = 'card_mature' THEN 1.0
  WHEN e.kind = 'card_check' AND e.verdict = 'sound' THEN 1.0 ELSE 0 END)`;
export const FAIL_SQL = `(CASE WHEN e.kind = 'question' AND e.result IN ('wrong','omitted') THEN 1.0 WHEN e.kind = 'question' AND e.result = 'flawed' THEN 0.5
  WHEN e.kind = 'retest' AND coalesce(e.outcome, e.result) IN ('missed_again','missed','wrong') THEN 1.0
  WHEN e.kind = 'card_lapse' AND json_extract(e.detail_json, '$.first_sight') IS NULL THEN 1.0 WHEN e.kind = 'gap_stated' THEN 1.0
  WHEN e.kind = 'card_check' AND coalesce(e.verdict, 'gap') = 'gap' THEN 1.0 WHEN e.kind = 'card_check' AND e.verdict = 'shaky' THEN 0.5 ELSE 0 END)`;
export const WEEK_MS = 7 * DAY_MS;
export const OUTSIDE_MIN = { topics: 5, items: 30 };

/**
 * The outside check (pure): topics taught against similar untaught topics (same category and lane), on what
 * happened after the lesson. For each taught topic, the weeks after its first lesson's week are counted on it and
 * on each untaught topic like it. Honest: with fewer than 5 taught topics or 30 items on either side it says so.
 * taught: [{topic_id, category_id, lane, first_at}]; weeks: [{topic_id, wk, pass, fail}]; topics: [{id, category_id, lane}].
 */
export function outsideCheck({ taught = [], weeks = [], topics = [] }) {
  const byTopic = new Map();
  for (const w of weeks) { if (!byTopic.has(w.topic_id)) byTopic.set(w.topic_id, []); byTopic.get(w.topic_id).push(w); }
  const taughtIds = new Set(taught.map(t => t.topic_id));
  const after = (id, wk0) => (byTopic.get(id) || []).filter(w => w.wk > wk0).reduce((s, w) => ({ pass: s.pass + (Number(w.pass) || 0), fail: s.fail + (Number(w.fail) || 0) }), { pass: 0, fail: 0 });
  const T = { topics: 0, pass: 0, fail: 0 }, U = { topics: new Set(), pass: 0, fail: 0 };
  for (const t of taught) {
    const wk0 = Math.floor((t.first_at || 0) / WEEK_MS);
    const mine = after(t.topic_id, wk0);
    if (mine.pass + mine.fail > 0) { T.topics++; T.pass += mine.pass; T.fail += mine.fail; }
    for (const o of topics) {
      if (taughtIds.has(o.id) || o.category_id !== t.category_id || (o.lane || null) !== (t.lane || null)) continue;
      const theirs = after(o.id, wk0);
      if (theirs.pass + theirs.fail > 0) { U.topics.add(o.id); U.pass += theirs.pass; U.fail += theirs.fail; }
    }
  }
  const side = s => ({ topics: s.topics instanceof Set ? s.topics.size : s.topics, items: round3(s.pass + s.fail), right_rate: s.pass + s.fail ? round3(s.pass / (s.pass + s.fail)) : null });
  const taughtSide = side(T), untaught = side(U);
  const enough = taughtSide.topics >= OUTSIDE_MIN.topics && taughtSide.items >= OUTSIDE_MIN.items && untaught.items >= OUTSIDE_MIN.items;
  const out = { state: enough ? 'ready' : 'not_enough', taught: taughtSide, untaught, min: OUTSIDE_MIN };
  if (!enough) {
    // The counts so far are in taught and untaught; the page shows them once, beside this note (DES4-12).
    out.note = `Not enough data yet: this needs ${OUTSIDE_MIN.topics} taught topics with later questions or cards, and ${OUTSIDE_MIN.items} items on each side.`;
    return out;
  }
  out.difference_pts = Math.round((taughtSide.right_rate - untaught.right_rate) * 100);
  out.note = `After a lesson, taught topics were right ${Math.round(taughtSide.right_rate * 100)}% of the time against ${Math.round(untaught.right_rate * 100)}% on similar untaught topics in the same weeks. Taught topics were picked because they were weak, so this is a conservative comparison.`;
  return out;
}

// One plain sentence on a past lesson's later evidence.
export function stickLine(s) {
  if (!s || s.stick == null) return null;
  const n = s.n != null ? s.n : round3((s.pass || 0) + (s.fail || 0));   // distinct observations (LRN3-5)
  return `${Math.round(s.stick * 100)}% right on ${n} later item${n === 1 ? '' : 's'}`;
}

const median = xs => { const v = xs.filter(x => x != null && Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };

export async function teachProfile(env, user, { now = Date.now() } = {}) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const since = now - 120 * DAY_MS;
  let res;
  try {
    res = await env.DB.batch([
      q(`SELECT content_type, tactic, wins, losses, uses, clicked_n, last_used_at FROM tactic_scores WHERE user_id = ? LIMIT 100`, user),
      q(`SELECT l.id, l.day, l.topic_id, coalesce(t.name, l.topic_name) AS topic, l.kind, l.outcome, l.blend, l.blend_json, l.mo_rating, l.mo_rating_why, l.what_clicked,
           l.claude_view_json, l.minutes, l.questions_asked, l.tactics_json, l.content_type, l.final_result, l.teach_back_json, l.final_explain_json, l.stick_json,
           l.facts_json, l.ended_at, l.surface
         FROM lessons l LEFT JOIN topics t ON t.user_id = l.user_id AND t.id = l.topic_id
         WHERE l.user_id = ? AND l.status = 'done' ORDER BY l.ended_at DESC LIMIT 40`, user),
      q(`SELECT id, topic_id, topic_name, belief, words, ref, status, first_seen, last_seen, seen_n, targeted_at, closed_at, closed_by, lesson_ids_json, note
         FROM misconceptions WHERE user_id = ? ORDER BY status = 'closed', last_seen DESC LIMIT 200`, user),
      // A note scoped to a topic or a system carries its name, so the page says "For COPD", never "topic: copd" (DES4-12).
      q(`SELECT m.id, m.scope, m.scope_ref, m.tactic, m.note, m.status, m.uses, m.wins, m.losses, m.score, m.created_by, m.updated_at,
           CASE m.scope WHEN 'topic' THEN t.name WHEN 'category' THEN c.name END AS scope_name
         FROM teach_memory m
         LEFT JOIN topics t ON m.scope = 'topic' AND t.user_id = m.user_id AND t.id = m.scope_ref
         LEFT JOIN categories c ON m.scope = 'category' AND c.user_id = m.user_id AND c.id = m.scope_ref
         WHERE m.user_id = ? AND m.status IN ('active','pinned') ORDER BY m.status = 'pinned' DESC, m.score DESC, m.updated_at DESC LIMIT 60`, user),
      // Taught topics: a pair test teaches nothing, so it never makes a topic taught (LRN4-1).
      q(`SELECT l.topic_id, min(l.ended_at) AS first_at, t.category_id, u.lane FROM lessons l JOIN topics t ON t.user_id = l.user_id AND t.id = l.topic_id
         LEFT JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id
         WHERE l.user_id = ? AND l.status = 'done' AND l.topic_id IS NOT NULL AND coalesce(l.kind, 'lesson') <> 'pair_test' GROUP BY l.topic_id LIMIT 300`, user),
      q(`SELECT e.topic_id, e.at / ${WEEK_MS} AS wk, sum(${PASS_SQL}) AS pass, sum(${FAIL_SQL}) AS fail FROM evidence e
         WHERE e.user_id = ? AND e.slot = 0 AND e.held = 0 AND e.source <> 'lesson' AND e.at >= ? AND e.topic_id IS NOT NULL
           AND e.kind IN ('question','retest','card_mature','card_lapse','gap_stated','card_check')
         GROUP BY e.topic_id, wk LIMIT 8000`, user, since),
      q(`SELECT t.id, t.category_id, u.lane FROM topics t LEFT JOIN units u ON u.user_id = t.user_id AND u.id = t.unit_id
         WHERE t.user_id = ? AND t.status IN ('proposed','confirmed') LIMIT 3000`, user),
      q(`SELECT coalesce(max(seq), 0) AS seq FROM map_events WHERE user_id = ?`, user),
    ]);
  } catch (e) {
    if (noTable(e)) return { ready: false, note: 'The Teaching page arrives with the map update (migration 0010).' };
    throw e;
  }
  const [tactics, lessons, miscs, notes, taught, weeks, topics, seq] = res.map(r => r.results || []);
  const prefs = await getPrefs(env, user).catch(() => ({}));
  return profileFrom({ tactics, lessons, miscs, notes, taught, weeks, topics, prefs: (prefs && prefs.teach) || {}, now, seq: (seq[0] || {}).seq || 0 });
}

/** The page's shape from the read rows (pure, for the tests). */
export function profileFrom({ tactics = [], lessons = [], miscs = [], notes = [], taught = [], weeks = [], topics = [], prefs = {}, now = Date.now(), seq = 0 }) {
  const favourites = Array.isArray(prefs.favourites) && prefs.favourites.length ? prefs.favourites.filter(t => TACTIC_VOCAB.includes(t)) : FAVOURITES;
  const byType = Object.fromEntries(CONTENT_TYPES.map(c => [c, posteriors(tactics, c, favourites)]));
  // Overall: each tactic's posterior with every content type's lessons pooled.
  const pooled = TACTIC_VOCAB.map(t => {
    const rows = tactics.filter(r => r.tactic === t);
    const [pa, pb] = priorOf(t, favourites);
    const w = rows.reduce((s, r) => s + (Number(r.wins) || 0), 0), l = rows.reduce((s, r) => s + (Number(r.losses) || 0), 0);
    return { tactic: t, mean: round3((pa + w) / (pa + pb + w + l)), lessons: rows.reduce((s, r) => s + (Number(r.uses) || 0), 0),
      clicked: rows.reduce((s, r) => s + (Number(r.clicked_n) || 0), 0), favourite: favourites.includes(t) };
  }).sort((a, b) => b.mean - a.mean || TACTIC_VOCAB.indexOf(a.tactic) - TACTIC_VOCAB.indexOf(b.tactic));
  const clickedByTopic = new Map();
  for (const l of lessons) {
    if (!l.what_clicked) continue;
    const k = l.topic_id || `name:${l.topic}`;
    if (!clickedByTopic.has(k)) clickedByTopic.set(k, { topic_id: l.topic_id || null, topic: l.topic || null, items: [] });
    const g = clickedByTopic.get(k);
    if (g.items.length < 3) g.items.push({ lesson_id: l.id, day: l.day, text: l.what_clicked, tactics: clickedTactics(l.what_clicked) });
  }
  const shapeLesson = l => {
    const stick = parse(l.stick_json, null);
    const view = parse(l.claude_view_json, null);
    return { id: l.id, day: l.day, topic_id: l.topic_id, topic: l.topic, kind: l.kind, surface: l.surface || null, outcome: l.outcome, blend: l.blend ?? null,
      // A pair test shows its score ("Pair test 3/4"), never as a lesson that landed (LRN4-1).
      ...(l.kind === 'pair_test' ? { pair_right: Math.round((Number(l.blend) || 0) * 4) } : {}),
      mo_rating: l.mo_rating ?? null, mo_rating_why: l.mo_rating_why || null, what_clicked: l.what_clicked || null,
      claude_view: view ? { verdict: view.verdict || null, reasons: view.reasons || null } : null, minutes: l.minutes ?? null, questions_asked: l.questions_asked ?? null,
      tactics: parse(l.tactics_json, []), content_type: l.content_type || null, final_result: l.final_result || null,
      teach_back: (parse(l.teach_back_json, null) || {}).judgement || null, stick: stick ? { ...stick, line: stickLine(stick) } : null };
  };
  const live = miscs.filter(m => m.status !== 'closed').map(shapeMisc), closed = miscs.filter(m => m.status === 'closed').map(shapeMisc);
  const done = lessons.slice(0, 40);
  const taughtDone = done.filter(l => l.kind !== 'pair_test');   // pacing is about lessons, not 3-minute pair tests
  return {
    ready: true, as_of: now, seq,
    tactics: { favourites, vocabulary: TACTIC_VOCAB, content_types: CONTENT_TYPES, overall: pooled, by_type: byType, priors: PRIOR },
    clicked: [...clickedByTopic.values()].slice(0, 12),
    misconceptions: { open: live, closed: closed.slice(0, 50), counts: { open: live.filter(m => m.status === 'open').length, targeted: live.filter(m => m.status === 'targeted').length, closed: closed.length } },
    pacing: {
      // 0 is the phase's own length; the page names it ("Default (10 min)") rather than showing 0 (DES4-12).
      lesson_minutes: Number(prefs.lesson_minutes) || 0, default_minutes: phaseFor(daysLeft(londonDay(now))).lesson_minutes, turn_words: Number(prefs.turn_words) || 90,
      notes: notes.filter(n => n.tactic === 'pacing').map(n => ({ id: n.id, note: n.note, status: n.status })),
      stats: { lessons: taughtDone.length, median_minutes: median(taughtDone.map(l => l.minutes)), median_questions: median(taughtDone.map(l => l.questions_asked)),
        median_rating: median(taughtDone.map(l => l.mo_rating)) },
    },
    notes: notes.map(n => ({ id: n.id, scope: n.scope, scope_ref: n.scope_ref, scope_name: n.scope_name ?? null, tactic: n.tactic, note: n.note, status: n.status, uses: n.uses, score: n.score, created_by: n.created_by })),
    lessons: done.slice(0, 30).map(shapeLesson),
    outside: outsideCheck({ taught, weeks, topics }),
  };
}

export async function profileRoute(request, env, ctx, params, url, user) {
  const profile = await teachProfile(env, user);
  if (profile.ready) profile.avoidance = await import('./morning.js').then(m => m.avoidanceSection(env, user))
    .catch(e => { console.error('avoidance section failed', e && e.message); return { ready: false, topics: [] }; });
  return json(profile);
}

export const PREF_FIELDS = { lesson_minutes: 'teach.lesson_minutes', turn_words: 'teach.turn_words', favourites: 'teach.favourites' };
export async function prefsPatchRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 10_000);
  const values = {};
  for (const [k, v] of Object.entries(body)) {
    if (!PREF_FIELDS[k]) return json({ error: `Unknown field ${k}: lesson_minutes, turn_words or favourites.`, refused: true, field: k }, 400);
    values[PREF_FIELDS[k]] = v;
  }
  if (!Object.keys(values).length) return json({ error: 'Nothing to change.', refused: true }, 400);
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'pref.set', args: { values }, via: 'api:PATCH /api/teach/prefs' }));
}
