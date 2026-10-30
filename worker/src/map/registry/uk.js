// The UK hub's registry (CONTRACT I32; code in worker/src/uk/). The shapes are at the top of registry/index.js.
// Handlers are wrapped so this file touches the modules only at call time (registry import cycles stay harmless).
import * as routes from '../../uk/routes.js';
import * as store from '../../uk/store.js';

export const ROUTES = [
  ['GET', '/api/uk/entries', (...a) => routes.listRoute(...a)],
  ['GET', '/api/uk/entries/:id', (...a) => routes.entryRoute(...a)],
  ['GET', '/api/uk/search', (...a) => routes.searchRoute(...a)],
  ['POST', '/api/uk/entries/import', (...a) => routes.importRoute(...a)],
];

const COLS = ['kind', 'category', 'title', 'aliases_json', 'summary', 'sections_json', 'sources_json', 'demo', 'deleted_at'];
export const CHANGE_KINDS = {
  // Adds, updates or removes UK entries in one undoable batch. Only the keyed import route (actor code) calls it:
  // the main connector is frozen, so Claude has no tool for it, and is refused if anything ever tries.
  'uk.import': {
    tier: (args, plan, ctx) => (ctx.actor === 'claude' ? 'refused' : 'free'), reason: 'UK entries come in through the UK import route.',
    kind: 'uk.updated', undoable: true, page_only: true, plan: (...a) => store.planImport(...a),
    writes: { uk_entries: { actions: 'iud', cols: COLS } },
  },
};

const T = 't', I = 'i';
export const EXPORT = {
  uk_entries: {
    cols: ['user_id', 'id', 'kind', 'category', 'title', 'aliases_json', 'summary', 'sections_json', 'sources_json', 'demo', 'created_at', 'updated_at', 'deleted_at'],
    required: ['user_id', 'id', 'kind', 'category', 'title', 'aliases_json', 'sections_json', 'sources_json', 'demo', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, kind: store.KINDS, category: T, title: T, aliases_json: 'ja', summary: T, sections_json: 'ja', sources_json: 'ja', demo: [0, 1],
      created_at: I, updated_at: I, deleted_at: I },
  },
};
export const EXPORT_SKIP = { uk_fts: 'The FTS5 index over uk_entries, kept by its triggers.' };
