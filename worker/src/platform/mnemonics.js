import { HttpError, json, readJson } from '../util.js';
import { applyChange } from '../map/change.js';
import { listRouteData } from '../mnemonics/routes.js';
import { testQueue, NEW_PER_DAY } from '../mnemonics/store.js';
import { LEARNER, requireModule } from './modules.js';

const st = (env, sql, ...b) => env.DB.prepare(sql).bind(...b);
const subjectsOf = async (env, user) => ((await st(env, "SELECT id, name FROM subjects WHERE user_id = ?1 AND status = 'active' ORDER BY sort", user).all()).results || []);

async function argsOf(env, user, b, { partial = false } = {}) {
  const out = {};
  for (const k of ['cue', 'about', 'kind', 'items', 'topics', 'notes']) if (b[k] !== undefined) out[k] = b[k];
  if (b.subject_id !== undefined || b.subject !== undefined) {
    const want = b.subject_id ?? b.subject;
    if (want == null || want === '') out.category_id = null;
    else {
      const s = (await subjectsOf(env, user)).find(x => x.id === want || x.name.toLowerCase() === String(want).toLowerCase());
      if (!s) throw new HttpError(400, `You have no subject called ${String(want).slice(0, 60)}.`);
      out.category_id = s.id;
    }
  } else if (!partial) out.category_id = null;
  return out;
}

async function change(env, user, op, args, actor = LEARNER) {
  const r = await applyChange(env, user, { actor, surface: actor === 'claude' ? 'chat' : 'web', op, args, via: `platform:${op}` });
  if (r.refused || r.refuse) throw new HttpError(400, r.reason || r.refuse || 'That could not be saved.');
  if (r.needs_confirm) return { needs_confirm: true, ask: r.ask, confirm_token: r.confirm_token };
  const { scores, undo_hint, seq, ...rest } = r;
  return { ...rest, ok: true, batch_id: r.batch_id || null, nothing: !!r.nothing };
}

export async function listFor(env, user, { subject = null, q = '' } = {}) {
  const [d, subjects] = await Promise.all([listRouteData(env, user, { q }), subjectsOf(env, user)]);
  const mine = new Set(subjects.map(s => s.id));
  const inSubject = m => !subject || (subject === 'other' ? !m.category_id || !mine.has(m.category_id) : m.category_id === subject);
  return { mnemonics: d.mnemonics.filter(inSubject), subjects: subjects.map(s => ({ id: s.id, name: s.name })), today: d.today || { new_done: 0, new_cap: NEW_PER_DAY } };
}

const gate = fn => async (request, env, ctx, params, url, user, session) => { requireModule(session, 'mnemonics', env); return fn(request, env, ctx, params, url, user, session); };
const id = params => String(params.id || '');

export const ROUTES = [
  ['GET', '/api/p/mnemonics', gate(async (rq, env, ctx, params, url, user) => json(await listFor(env, user, { subject: url.searchParams.get('subject'), q: url.searchParams.get('q') || '' })))],
  ['GET', '/api/p/mnemonics/test', gate(async (rq, env, ctx, params, url, user) => {
    const d = await listFor(env, user, { subject: url.searchParams.get('subject') });
    const queue = testQueue(d.mnemonics, { now: Date.now(), newToday: d.today.new_done });
    const used = new Set(queue.map(x => x.id));
    return json({ queue, mnemonics: d.mnemonics.filter(m => used.has(m.id)) });
  })],
  ['POST', '/api/p/mnemonics', gate(async (rq, env, ctx, params, url, user) => json(await change(env, user, 'mnemonic.add', await argsOf(env, user, await readJson(rq, 64_000))), 201))],
  ['PATCH', '/api/p/mnemonics/:id', gate(async (rq, env, ctx, params, url, user) => json(await change(env, user, 'mnemonic.edit', { ...(await argsOf(env, user, await readJson(rq, 64_000), { partial: true })), id: id(params) })))],
  ['DELETE', '/api/p/mnemonics/:id', gate(async (rq, env, ctx, params, url, user) => json(await change(env, user, 'mnemonic.remove', { id: id(params) })))],
  ['POST', '/api/p/mnemonics/:id/rate', gate(async (rq, env, ctx, params, url, user) => {
    const b = await readJson(rq, 8_000);
    return json(await change(env, user, 'mnemonic.rate', { id: id(params), dir: b.dir, missed: b.missed, easy: b.easy }));
  })],
];

// ------------------------------------------------------------------ their Claude

const ITEM = { type: 'object', additionalProperties: false, properties: { cue: { type: 'string' }, about: { type: 'string' }, kind: { type: 'string', enum: ['acronym', 'hook', 'rule'] },
  items: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, topics: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } };

export const TOOLS = [{
  name: 'mnemonic_edit',
  module: 'mnemonics',
  description: 'The student\'s mnemonics (memory hooks they test letter by letter in the app). With no add, edit or remove it lists them. '
    + 'add [{cue "PMAT", about "Stages of mitosis", items ["P: Prophase", "M: Metaphase", ...], subject?, topics? (their topic ids), notes?}] (kind: acronym, hook or rule); '
    + 'edit {id, ...fields}; remove [ids]. Write your own, accurate ones and check every item. Never rate a test: the recall is theirs. "Undo that" works (undo_change).',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    add: { type: 'array', maxItems: 20, items: ITEM }, edit: { ...ITEM, properties: { ...ITEM.properties, id: { type: 'string' } }, required: ['id'] },
    remove: { type: 'array', maxItems: 20, items: { type: 'string' } }, subject: { type: 'string' }, query: { type: 'string' } } },
  async run(env, user, a) {
    if (a.add) {
      const out = [];
      for (const it of a.add) out.push(await change(env, user, 'mnemonic.add', await argsOf(env, user, it), 'claude'));
      return { added: out.map(r => r.mnemonic && { id: r.mnemonic.id, cue: r.mnemonic.cue }), batch_ids: out.map(r => r.batch_id), undo: 'They can say "undo that" (undo_change, one batch_id each).' };
    }
    if (a.edit) return change(env, user, 'mnemonic.edit', { ...(await argsOf(env, user, a.edit, { partial: true })), id: a.edit.id }, 'claude');
    if (a.remove) return change(env, user, 'mnemonic.remove', { ids: a.remove }, 'claude');
    const d = await listFor(env, user, { q: a.query || '' });
    const names = new Map(d.subjects.map(s => [s.id, s.name]));
    return { count: d.mnemonics.length, mnemonics: d.mnemonics.filter(m => !a.subject || names.get(m.category_id) === a.subject || m.category_id === a.subject).slice(0, 60)
      .map(m => ({ id: m.id, cue: m.cue, about: m.about, items: m.items.map(i => (i.key ? `${i.key}: ${i.text}` : i.text)), subject: names.get(m.category_id) || null,
        topics: m.topics.map(t => t.name).filter(Boolean), tested: m.fwd ? { reps: m.fwd.reps, lapses: m.fwd.lapses, last: m.fwd.last_rating } : null })) };
  },
}];
