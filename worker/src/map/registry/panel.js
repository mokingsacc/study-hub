// Topic panel (card cache, resources) registry (owner: PAN). The shapes are at the top of registry/index.js.
// Handlers are wrapped so this file touches the modules only at call time (registry import cycles stay harmless).
import * as topic from '../topic.js';
import * as sources from '../sources.js';
import * as mehlmanSummary from '../mehlman-summary.js';
import * as selfRating from '../self-rating.js';
import { HttpError } from '../../util.js';

const codeOnly = (a, p, c) => (c && c.actor === 'code' ? 'free' : 'refused');

export const CHANGE_KINDS = {
  'card_topic.unlink': {
    tier: 'free', kind: 'card.unlinked', undoable: true,
    evidence: { remove: ['cardstate:', 'cardlapses:', 'card:'], repoint: false },
    plan: (...a) => sources.planCardUnlink(...a), apply: (...a) => sources.applyCardUnlink(...a),
  },
  'self.rate': {
    tier: (...a) => selfRating.selfRateTier(...a), reason: 'Only Mo rates how sure he is, on the topic panel.', kind: 'self.rated', undoable: true, page_only: true,
    evidence: { remove: ['self:'], repoint: false }, plan: (...a) => selfRating.planSelfRate(...a),
  },
  'resources.seed': { tier: codeOnly, reason: 'That is done by the hub itself.', kind: 'map.resync', undoable: false, plan: (...a) => sources.planResourcesSeed(...a) },
};

export const ROUTES = [
  ['GET', '/api/map/topic/:id', (...a) => topic.topicRoute(...a)],
  ['POST', '/api/map/topic/:id/refresh', (...a) => topic.refreshRoute(...a)],
  ['PATCH', '/api/map/topic/:id/cards/:card_id', (...a) => sources.unlinkRoute(...a)],
  ['GET', '/api/map/topic/:id/mehlman', (...a) => mehlmanSummary.mehlmanRoute(...a)],
  ['POST', '/api/map/topic/:id/mehlman/summary', (...a) => mehlmanSummary.summaryRoute(...a)],
  ['GET', '/api/map/card/:card_id', (...a) => topic.cardRoute(...a)],
  ['POST', '/api/map/topic/:id/rating', (...a) => selfRating.rateRoute(...a)],
  ['POST', '/api/map/topic/:id/viva', async (...a) => (await import('../viva-panel.js')).vivaUploadRoute(...a)],
  ['GET', '/api/map/topic/:id/viva/:viva_id', async (...a) => (await import('../viva-panel.js')).vivaStatusRoute(...a)],
  ['POST', '/api/map/seed/resources', (...a) => sources.seedResourcesRoute(...a)],
];

export const EXPORT_SKIP = {
  mehlman_summaries: "A cache of Claude's one-paragraph summaries of Mehlman passages; the next tap makes it again.",
};

export const PREFS = {
  'panel.show_onenote': { type: 'bool', default: true, label: 'Show the OneNote link on the topic panel', owner: 'panel' },
};

const T = 't', I = 'i', R = 'r', JA = 'ja';
const BY = ['seed', 'code', 'extractor', 'claude', 'mo'];
export const EXPORT = {
  card_cache: {
    cols: ['user_id', 'card_id', 'note_id', 'deck', 'question', 'answer', 'vs', 'notes', 'schedule', 'lapses', 'image_count', 'images_json', 'full',
      'fetched_at', 'deleted_at'],
    required: ['user_id', 'card_id', 'fetched_at'],
    types: { user_id: T, card_id: I, note_id: I, deck: T, question: T, answer: T, vs: T, notes: T, schedule: T, lapses: I, image_count: I, images_json: JA,
      full: [0, 1], fetched_at: I, deleted_at: I },
  },
  card_topics: {
    cols: ['user_id', 'card_id', 'topic_id', 'match', 'strong', 'created_by', 'created_at', 'removed_at', 'removed_by'],
    required: ['user_id', 'card_id', 'topic_id', 'match', 'created_at'],
    types: { user_id: T, card_id: I, topic_id: T, match: ['miss', 'search', 'claude', 'gap'], strong: [0, 1], created_by: T, created_at: I, removed_at: I, removed_by: T },
  },
  resources: {
    cols: ['user_id', 'id', 'kind', 'title', 'subject', 'exam', 'pages', 'file_name', 'r2_key', 'url', 'bytes', 'text_status', 'exam_profile', 'source',
      'source_ref', 'created_by', 'created_at', 'updated_at'],
    required: ['user_id', 'id', 'kind', 'title', 'created_by', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, kind: ['mehlman_pdf', 'onenote', 'pdf', 'note', 'web'], title: T, subject: T, exam: T, pages: I, file_name: T, r2_key: T,
      url: T, bytes: I, text_status: ['none', 'pages', 'indexed'], exam_profile: T, source: T, source_ref: T, created_by: BY, created_at: I, updated_at: I },
  },
  resource_links: {
    cols: ['id', 'user_id', 'topic_id', 'kind', 'resource_id', 'page', 'page_to', 'label', 'section', 'snippet', 'query', 'rank', 'status', 'fetched_at',
      'source', 'source_ref', 'created_by', 'created_at'],
    required: ['id', 'user_id', 'topic_id', 'kind', 'resource_id', 'created_by', 'created_at'],
    types: { id: T, user_id: T, topic_id: T, kind: ['mehlman', 'pdf', 'note'], resource_id: T, page: I, page_to: I, label: T, section: T, snippet: T,
      query: T, rank: R, status: ['live', 'wrong', 'hidden'], fetched_at: I, source: T, source_ref: T, created_by: T, created_at: I },
    check: row => { if (row.snippet != null && String(row.snippet).length > 600) throw new HttpError(400, 'A resource_links row has a snippet over 600 characters.'); },
  },
  source_fetches: {
    cols: ['user_id', 'topic_id', 'kind', 'fetched_at', 'n', 'status', 'error', 'list_sha', 'queries_json'],
    required: ['user_id', 'topic_id', 'kind', 'fetched_at', 'status'],
    types: { user_id: T, topic_id: T, kind: ['cards', 'mehlman', 'pictures'], fetched_at: I, n: I, status: ['ok', 'weak', 'error'], error: T, list_sha: T,
      queries_json: JA },
  },
};
