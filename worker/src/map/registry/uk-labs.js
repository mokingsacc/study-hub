// The UK labs' registry (CONTRACT I34; code in worker/src/uk/imaging.js). The ECG lab has no server part. Handlers
// are wrapped so this file touches the modules only at call time (registry import cycles stay harmless).
import * as imaging from '../../uk/imaging.js';

export const ROUTES = [
  ['GET', '/api/uk/imaging', (...a) => imaging.listRoute(...a)],
  ['GET', '/api/uk/imaging/findings/:id', (...a) => imaging.findingRoute(...a)],
  ['GET', '/api/uk/imaging/media/:id', (...a) => imaging.mediaGetRoute(...a)],
  ['PUT', '/api/uk/imaging/media/:id', (...a) => imaging.mediaPutRoute(...a)],
  ['POST', '/api/uk/imaging/import', (...a) => imaging.importRoute(...a)],
];

export const CHANGE_KINDS = {
  // Adds, updates or removes imaging findings and pictures in one undoable batch. Only the keyed import route
  // (actor code) calls it; Claude has no tool for it and is refused if anything ever tries.
  'uk_img.import': {
    tier: (args, plan, ctx) => (ctx.actor === 'claude' ? 'refused' : 'free'), reason: 'Imaging pictures come in through the imaging import route.',
    kind: 'uk.updated', undoable: true, page_only: true, plan: (...a) => imaging.planImport(...a),
    writes: { uk_img_findings: { actions: 'iu', cols: ['modality', 'title', 'aliases_json', 'signs_json', 'versus_json', 'uk_json', 'sources_json', 'normal_media_id', 'sort', 'demo', 'updated_at', 'deleted_at'] },
      uk_img_media: { actions: 'iu', cols: ['finding_id', 'view', 'r2_key', 'mime', 'w', 'h', 'bytes', 'hotspots_json', 'source', 'source_url', 'licence', 'author', 'attribution', 'sort', 'created_at', 'deleted_at'] } },
  },
};

const T = 't', I = 'i';
export const EXPORT = {
  uk_img_findings: {
    cols: ['user_id', 'id', 'modality', 'title', 'aliases_json', 'signs_json', 'versus_json', 'uk_json', 'sources_json', 'normal_media_id', 'sort', 'demo', 'updated_at', 'deleted_at'],
    required: ['user_id', 'id', 'modality', 'title', 'aliases_json', 'signs_json', 'versus_json', 'uk_json', 'sources_json', 'sort', 'demo', 'updated_at'],
    types: { user_id: T, id: T, modality: imaging.MODALITIES, title: T, aliases_json: 'ja', signs_json: 'ja', versus_json: 'ja', uk_json: 'ja', sources_json: 'ja', normal_media_id: T, sort: I, demo: [0, 1], updated_at: I, deleted_at: I },
  },
  uk_img_media: {
    cols: ['user_id', 'id', 'finding_id', 'view', 'r2_key', 'mime', 'w', 'h', 'bytes', 'hotspots_json', 'source', 'source_url', 'licence', 'author', 'attribution', 'sort', 'created_at', 'deleted_at'],
    required: ['user_id', 'id', 'finding_id', 'r2_key', 'mime', 'w', 'h', 'bytes', 'hotspots_json', 'source', 'licence', 'attribution', 'sort', 'created_at'],
    types: { user_id: T, id: T, finding_id: T, view: T, r2_key: T, mime: T, w: I, h: I, bytes: I, hotspots_json: 'ja', source: imaging.SOURCES, source_url: T, licence: T, author: T, attribution: T, sort: I, created_at: I, deleted_at: I },
  },
};
