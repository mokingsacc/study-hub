import { applyChange } from '../map/change.js';
import { changeReply } from '../mcp/reply.js';
import { listRouteData } from './routes.js';

const off = env => env.MNEMONICS !== 'on';
const OFF = { refused: true, reason: 'Mnemonics are not switched on in the hub yet.' };

/** mnemonics_list {category?, query?}: compact rows, newest schedule state included. */
export async function mnemonicsList(env, user, args = {}) {
  if (off(env)) return OFF;
  const d = await listRouteData(env, user, { category: args.category || null, q: args.query || '' });
  return {
    count: d.mnemonics.length,
    mnemonics: d.mnemonics.map(m => ({ id: m.id, cue: m.cue, about: m.about, kind: m.kind, items: m.items, category_id: m.category_id,
      topics: m.topics.map(t => ({ id: t.id, name: t.name })), notes: m.notes || undefined, source: m.source,
      tested: m.fwd ? { reps: m.fwd.reps, lapses: m.fwd.lapses, last: m.fwd.last_rating } : null })),
  };
}

/**
 * mnemonics_write: exactly one of add [..], edit {id, ...}, remove [ids], undo batch_id. add of one with no
 * source_ref is mnemonic.add; otherwise mnemonic.import (source_ref makes a second add of the same one an update).
 */
export async function mnemonicsWrite(env, user, args = {}, ctx = {}) {
  if (off(env)) return OFF;
  const parts = ['add', 'edit', 'remove', 'undo'].filter(k => args[k] != null);
  if (parts.length !== 1) return { refused: true, reason: 'Send exactly one of add, edit, remove or undo.' };
  const base = { actor: 'claude', surface: ctx.surface || 'chat', via: ctx.via, request_id: ctx.request_id, mo_said: args.mo_said || null, confirm_token: args.confirm_token || null };
  let req;
  if (args.undo != null) req = { op: 'undo', args: { batch_id: args.undo } };
  else if (args.edit != null) req = { op: 'mnemonic.edit', args: args.edit };
  else if (args.remove != null) req = { op: 'mnemonic.remove', args: { ids: args.remove } };
  else {
    const list = args.add;
    req = list.length === 1 && !list[0].source_ref
      ? { op: 'mnemonic.add', args: { ...list[0], ...(args.source ? { source: args.source } : {}) } }
      : { op: 'mnemonic.import', args: { source: args.source || 'claude', items: list.map((x, i) => ({ source_ref: x.source_ref || `claude:${Date.now()}:${i}`, ...x })) } };
  }
  return changeReply(await applyChange(env, user, { ...base, ...req }));
}
