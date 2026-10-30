// Links (look-alikes, drugs) registry (owner: LNK). The shapes are at the top of registry/index.js.
// Every handler is wrapped so this file touches the modules only at call time (registry import cycles stay harmless).
import * as store from '../links-store.js';
import * as ingest from '../links-ingest.js';
import { SOURCES, ROLES } from '../links.js';
import { applyChange, changeResponse } from '../change.js';
import { readJson } from '../../util.js';

const LINK_WRITES = store.LINK_WRITES;

export const CHANGE_KINDS = {
  'link.add': { tier: 'free', kind: 'link.added', undoable: true, plan: (...a) => store.planAdd(...a), writes: LINK_WRITES },
  // map_update_link: facts, how, note, picture, or restoring a removed link. Free.
  'link.update': { tier: 'free', kind: 'link.updated', undoable: true, plan: (...a) => store.planUpdate(...a), writes: LINK_WRITES },
  'link.remove': { tier: (a, p) => store.removeTier(a, p), kind: 'link.removed', undoable: true, plan: (...a) => store.planRemove(...a), writes: LINK_WRITES },
};

// realtime's undoBatch: link events compare only the editable fields, and put the change's own support back.
// (map orbits' drug-link hides are link.updated events on orbit_links: their own undo, I33)
const undo = (env, user, e, ctx) => (e && e.target_type === 'orbit_links' ? import('../../orbits/routes.js').then(m => m.undoOrbitLink(env, user, e, ctx)) : store.undoLinkEvent(env, user, e, ctx));
export const UNDO = { 'link.added': undo, 'link.updated': undo, 'link.removed': undo };

// map_resolve on 'versus' items (taxonomy's queue.resolve dispatches here: handler(env, user, entries, ctx, shared)).
export const QUEUE_HANDLERS = { versus: (...a) => ingest.versusHandler(...a) };

const T = 't', I = 'i', R = 'r';
export const EXPORT = {
  links: {
    cols: ['id', 'user_id', 'type', 'from_id', 'to_id', 'directed', 'how', 'a_vs_b', 'b_vs_a', 'note', 'picture', 'strength', 'support_n',
      'confusion', 'confusion_at', 'confused_n', 'last_confused_at', 'last_truth_id', 'last_tested_at', 'status', 'source', 'source_ref',
      'created_by', 'created_at', 'updated_at', 'removed_at', 'removed_by', 'removed_reason'],
    required: ['id', 'type', 'from_id', 'to_id', 'directed', 'status', 'source', 'created_by', 'created_at', 'updated_at'],
    types: { id: T, user_id: T, type: ['versus', 'treated_by', 'adverse_effect', 'causes'], from_id: T, to_id: T, directed: [0, 1], how: T, a_vs_b: T, b_vs_a: T,
      note: T, picture: T, strength: R, support_n: I, confusion: R, confusion_at: I, confused_n: I, last_confused_at: I, last_truth_id: T, last_tested_at: I,
      status: ['held', 'proposed', 'active', 'removed'], source: T, source_ref: T, created_by: ['seed', 'code', 'extractor', 'claude', 'mo'],
      created_at: I, updated_at: I, removed_at: I, removed_by: T, removed_reason: T },
  },
  link_support: {
    cols: ['id', 'user_id', 'link_id', 'obs_key', 'src', 'role', 'w', 'cw', 'truth_id', 'text', 'miss_id', 'card_id', 'note_id', 'gap_id', 'lesson_id',
      'sitting_id', 'held', 'at', 'created_at'],
    required: ['user_id', 'link_id', 'obs_key', 'src', 'role', 'at', 'created_at'],
    types: { id: I, user_id: T, link_id: T, obs_key: T, src: SOURCES, role: ROLES, w: R, cw: R, truth_id: T, text: T, miss_id: T, card_id: I, note_id: I,
      gap_id: T, lesson_id: T, sitting_id: T, held: [0, 1], at: I, created_at: I },
  },
};

async function addLinkRoute(request, env, ctx, params, url, user) {
  const args = await readJson(request, 20_000);
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'link.add', args, via: 'api:POST /api/map/links' }));
}
async function patchLinkRoute(request, env, ctx, params, url, user) {
  const body = await readJson(request, 20_000);
  const set = body.set && typeof body.set === 'object' ? body.set : {};
  const op = set.status === 'removed' ? 'link.remove' : 'link.update';
  const args = op === 'link.remove' ? { link_id: params.id, ...(body.reason != null ? { reason: body.reason } : {}) } : { link_id: params.id, set, ...(body.reason != null ? { reason: body.reason } : {}) };
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op, args, via: 'api:PATCH /api/map/links' }));
}

export const ROUTES = [
  ['POST', '/api/map/seed/links-catalogue', (...a) => ingest.seedCatalogueRoute(...a)],
  ['POST', '/api/map/links', (...a) => addLinkRoute(...a)],
  ['PATCH', '/api/map/links/:id', (...a) => patchLinkRoute(...a)],
];
