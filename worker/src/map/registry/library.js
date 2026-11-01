// The study-materials Library registry (owner: LIBRARY; release 2.5). Code in worker/src/library/*; the API contract
// is docs/map-research/requests/LIBRARY.md. The shapes are at the top of registry/index.js. Handlers are wrapped so
// this file touches the modules only at call time (registry import cycles stay harmless).
import * as lib from '../../library/routes.js';

export const ROUTES = [
  ['GET', '/api/library', (...a) => lib.listRoute(...a)],
  ['GET', '/api/library/status', (...a) => lib.statusRoute(...a)],
  ['GET', '/api/library/search', (...a) => lib.searchRoute(...a)],
  ['POST', '/api/library/run', (...a) => lib.runRoute(...a)],
  ['POST', '/api/library/docs', (...a) => lib.createRoute(...a)],
  ['GET', '/api/library/docs/:id', (...a) => lib.docRoute(...a)],
  ['DELETE', '/api/library/docs/:id', (...a) => lib.deleteRoute(...a)],
  ['PUT', '/api/library/docs/:id/parts/:n', (...a) => lib.partRoute(...a)],
  ['POST', '/api/library/docs/:id/complete', (...a) => lib.completeRoute(...a)],
  ['POST', '/api/library/docs/:id/pages', (...a) => lib.pagesRoute(...a)],
  ['POST', '/api/library/docs/:id/extract', (...a) => lib.extractRoute(...a)],
  ['POST', '/api/library/docs/:id/reindex', (...a) => lib.reindexRoute(...a)],
  ['GET', '/api/library/docs/:id/file', (...a) => lib.fileRoute(...a)],
  ['GET', '/api/library/doc/:id/page/:n', (...a) => lib.pageRoute(...a)],
  ['GET', '/api/library/topic/:id', (...a) => lib.topicRoute(...a)],
  ['GET', '/api/library/objectives', (...a) => lib.objectivesRoute(...a)],
];

const T = 't', I = 'i';
// The document list is exported (small); the index is remade from the stored pages by re-index, and the PDFs live in R2.
export const EXPORT = {
  library_docs: {
    cols: ['user_id', 'id', 'title', 'file_name', 'collection', 'source', 'sha256', 'bytes', 'page_count', 'r2_key', 'upload_id', 'parts_json', 'status', 'status_note',
      'extractor', 'pages_in', 'n_pages_text', 'n_ocr', 'n_passages', 'n_embedded', 'n_linked', 'chunker_version', 'embed_model', 'created_at', 'updated_at', 'indexed_at', 'folder'],
    required: ['user_id', 'id', 'title', 'source', 'status', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, title: T, file_name: T, collection: T, source: ['upload', 'import'], sha256: T, bytes: I, page_count: I, r2_key: T, upload_id: T,
      parts_json: 'ja', status: ['uploading', 'uploaded', 'extracting', 'indexing', 'ready', 'refused', 'failed'], status_note: T, extractor: T, pages_in: I,
      n_pages_text: I, n_ocr: I, n_passages: I, n_embedded: I, n_linked: I, chunker_version: I, embed_model: T, created_at: I, updated_at: I, indexed_at: I, folder: T },
  },
};

export const EXPORT_SKIP = {
  library_pages: 'Page text, remade from the pages stored in R2 by POST /api/library/docs/:id/reindex.',
  library_passages: 'Passages and their vectors, remade by re-index and the minute job (library/jobs.js).',
  library_fts: 'The FTS5 index over library_passages (external content), remade with the passages.',
  library_links: 'Passage-to-topic links, remade by the minute job and the topic coverage.',
  library_terms: 'Abbreviations harvested from the passages, remade by re-index.',
  library_coverage: 'When each topic\'s coverage was built: a cache, rebuilt when missing.',
  // The exam bank (exam-bank.js, 0023_exam_bank.sql): loaded from qbx's exports by scripts/exam-bank-build.py.
  xq: 'The exam bank\'s questions, loaded whole by scripts/exam-bank-build.py from the qbx exports.',
  xq_fts: 'The FTS5 index over the exam bank, loaded with it.',
  xq_rank: 'Each checklist unit\'s exam ranks, computed by scripts/exam-bank-build.py.',
};
