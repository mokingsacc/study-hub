// Map page (payload, positions, map settings) registry (owner: LOOK). The shapes are at the top of registry/index.js.
// Handlers are wrapped so this file touches the modules only at call time (registry import cycles stay harmless).
import * as payload from '../payload.js';
import * as positions from '../positions.js';
import * as embed from '../embed.js';
import * as marks from '../teach-marks.js';

export const ROUTES = [
  ['GET', '/api/map', (...a) => payload.mapRoute(...a)],
  ['GET', '/api/map/aliases', (...a) => payload.aliasesRoute(...a)],
  ['PUT', '/api/map/positions', (...a) => positions.putPositionsRoute(...a)],
  ['PATCH', '/api/map/prefs', (...a) => payload.prefsRoute(...a)],
  // The semantic layout (v3): the embedding neighbours for a layout run, and one embedding step now.
  ['GET', '/api/map/layout-input', (...a) => embed.layoutInputRoute(...a)],
  ['POST', '/api/map/embeddings/run', (...a) => embed.embedRunRoute(...a)],
  ['GET', '/api/map/teach-marks', (...a) => marks.teachMarksRoute(...a)],
];

// How the map looks (plan §9 Prefs). Read from GET /api/state prefs.map; Claude sets them with hub_settings.
export const PREFS = {
  // 25 Oct: the map follows the hub's light or dark theme (the bar's button switches it live); this keeps it on the
  // night sky in the light theme too. It replaces map.night_sky (default on), so a stored "on" from before no longer
  // holds the map on the night sky.
  'map.always_night': { type: 'bool', default: false, label: 'Map always on the night sky, in the light theme too (off: it follows the light or dark theme)', owner: 'look' },
  'map.sky_swatch': { type: 'enum', enum: ['ink', 'ember', 'plum', 'aubergine', 'indigo', 'teal', 'midnight', 'custom'], default: 'ink', label: 'Night sky colour (a swatch, or custom for the hue below)', owner: 'look' },
  'map.sky_hue': { type: 'int', min: 0, max: 359, default: 25, label: 'Night sky hue when the colour is custom (0 to 359)', owner: 'look' },
  'map.sky_brightness': { type: 'num', min: 0.6, max: 1.4, default: 1, label: 'Night sky brightness (0.6 darker to 1.4 lighter)', owner: 'look' },
  'map.link_density': { type: 'enum', enum: ['few', 'normal', 'many'], default: 'normal', label: 'Lines on the whole map (600, 1,500 or 3,000)', owner: 'look' },
  'map.label_density': { type: 'enum', enum: ['key', 'fewer', 'normal', 'more'], default: 'key', label: 'Topic names on the map', owner: 'look' },
  'map.follow_lessons': { type: 'enum', enum: ['off', 'pill', 'fly'], default: 'pill', label: 'When Claude starts teaching: nothing, a pill, or fly there', owner: 'look' },
  'map.hover_intent_ms': { type: 'int', min: 0, max: 300, default: 40, label: 'Hover delay before a topic grows (ms)', owner: 'look' },
};

const T = 't', I = 'i', R = 'r';
export const EXPORT = {
  topic_positions: {
    cols: ['user_id', 'kind', 'ref_id', 'x', 'y', 'placed_by', 'pinned', 'layout_version', 'source', 'source_ref', 'created_by', 'updated_at'],
    required: ['user_id', 'kind', 'ref_id', 'x', 'y', 'placed_by', 'created_by', 'updated_at'],
    types: { user_id: T, kind: ['topic', 'category'], ref_id: T, x: R, y: R, placed_by: ['rule', 'layout', 'mo'], pinned: I, layout_version: I,
      source: T, source_ref: T, created_by: T, updated_at: I },
  },
};

export const EXPORT_SKIP = {
  topic_embeddings: 'Text embeddings and neighbour lists, remade from the topics by Workers AI whenever they are missing (embed.js).',
};
