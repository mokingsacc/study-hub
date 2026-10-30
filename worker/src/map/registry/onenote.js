import * as one from '../onenote.js';

export const ROUTES = [
  ['POST', '/api/map/onenote/pages', (...a) => one.pagesRoute(...a)],
  ['POST', '/api/map/onenote/fetch', (...a) => one.fetchRoute(...a)],
  ['POST', '/api/map/onenote/import', (...a) => one.importRoute(...a)],
  ['GET', '/api/map/onenote/status', (...a) => one.statusRoute(...a)],
  ['GET', '/api/map/onenote/raw', (...a) => one.rawRoute(...a)],
];

export const CHANGE_KINDS = {
  'import.start': { tier: 'confirm', kind: 'import.started', undoable: false, plan: (...a) => one.planImportStart(...a) },
};

// realtime's undoBatch: an import takes back the units, open queue items and ticks it created.
export const UNDO = { 'onenote.imported': (...a) => one.undoImport(...a) };

const T = 't', I = 'i';
const BY = ['seed', 'code', 'extractor', 'claude', 'mo'];
export const EXPORT = {
  onenote_pages: {
    cols: ['user_id', 'page_id', 'title', 'section', 'kind', 'parts', 'pictures', 'content_sha', 'prev_sha', 'section_modified', 'fetch_status', 'next_part',
      'fetched_at', 'parsed_at', 'parser_version', 'counts_json', 'error', 'fetch_id', 'parsed_fetch_id', 'sort', 'updated_at'],
    required: ['user_id', 'page_id', 'kind'],
    types: { user_id: T, page_id: T, title: T, section: T, kind: ['checklist', 'tally', 'system', 'review_table', 'mnemonics', 'derived', 'skip', 'dead'],
      parts: I, pictures: I, content_sha: T, prev_sha: T, section_modified: T, fetch_status: ['new', 'queued', 'fetching', 'fetched', 'error', 'dead'],
      next_part: I, fetched_at: I, parsed_at: I, parser_version: I, counts_json: 'jo', error: T, fetch_id: T, parsed_fetch_id: T, sort: I, updated_at: I },
  },
  topic_notes: {
    cols: ['user_id', 'id', 'topic_id', 'unit_id', 'kind', 'step', 'title', 'body', 'answer', 'hot', 'ord', 'status', 'locked', 'source', 'source_ref',
      'content_sha', 'created_by', 'lesson_id', 'card_id', 'gap_id', 'created_at', 'updated_at'],
    required: ['user_id', 'id', 'kind', 'body', 'source', 'source_ref', 'content_sha', 'created_by', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, topic_id: T, unit_id: T,
      kind: ['need_to_know', 'recognise', 'distinguish', 'test', 'treat', 'trap', 'recall_prompt', 'mastery_goal', 'big_picture', 'mnemonic', 'reference',
        'lesson_summary', 'mo_note'],
      step: ['recognise', 'distinguish', 'test', 'treat', 'trap'], title: T, body: T, answer: T, hot: [0, 1], ord: I,
      status: ['active', 'superseded', 'held', 'deleted'], locked: [0, 1], source: T, source_ref: T, content_sha: T, created_by: BY,
      lesson_id: T, card_id: I, gap_id: T, created_at: I, updated_at: I },
  },
};

export const EXPORT_SKIP = { onenote_parts: 'Raw OneNote page HTML: re-fetchable from OneNote, and about 16 MB per version.' };
