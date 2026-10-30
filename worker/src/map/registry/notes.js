// Notes registry (owner: NOTES, I30). The shapes are at the top of registry/index.js. Code in worker/src/notes/*.
// Handlers are wrapped so this file touches the modules only at call time (registry import cycles stay harmless).
import * as routes from '../../notes/routes.js';
import * as ops from '../../notes/ops.js';
import * as store from '../../notes/store.js';

export const ROUTES = [
  ['GET', '/api/notes/tree', (...a) => routes.treeRoute(...a)],
  ['GET', '/api/notes/search', (...a) => routes.searchRoute(...a)],
  ['GET', '/api/notes/pages/:id', (...a) => routes.pageRoute(...a)],
  ['POST', '/api/notes/save', (...a) => routes.saveRoute(...a)],
  ['PUT', '/api/notes/images', (...a) => routes.imagePutRoute(...a)],
  ['GET', '/api/notes/images/:name', (...a) => routes.imageGetRoute(...a)],
  ['POST', '/api/notes/reindex', (...a) => routes.reindexRoute(...a)],
  ['GET', '/api/notes/onenote/browse', (...a) => routes.oneBrowseRoute(...a)],
  ['POST', '/api/notes/onenote/import', (...a) => routes.oneImportRoute(...a)],
  ['POST', '/api/notes/onenote/pictures', (...a) => routes.onePicturesRoute(...a)],
  ['GET', '/api/notes/onenote/job', (...a) => routes.jobRoute(...a)],
  ['POST', '/api/notes/onenote/job', (...a) => routes.jobQueueRoute(...a)],
  ['POST', '/api/notes/onenote/job/retry', (...a) => routes.jobRetryRoute(...a)],
  ['POST', '/api/notes/onenote/job/clear', (...a) => routes.jobClearRoute(...a)],
];

// One op for the section: its own apply writes the whole rows, the search rows and one event (store.js applyNotes).
export const CHANGE_KINDS = {
  'note.save': { tier: (...a) => ops.saveTier(...a), kind: 'note.updated', undoable: true, plan: (...a) => ops.planSave(...a), apply: (...a) => store.applyNotes(...a) },
};

// Undo of a notes batch: every row back as it was (store.js undoNotes), for each table an event can name.
const undo = (...a) => store.undoNotes(...a);
export const UNDO = Object.fromEntries(store.TABLES.map(t => [`target:${t}`, undo]));

const T = 't', I = 'i', R = 'r';
const base = { user_id: T, id: T, created_at: I, updated_at: I, deleted_at: I };
const spec = (t, required, types) => ({ cols: ['user_id', ...store.COLS[t]], required: ['user_id', 'id', ...required, 'created_at', 'updated_at'], types: { ...base, ...types } });
export const EXPORT = {
  note_books: spec('note_books', ['name', 'region'], { name: T, region: ['us', 'uk'], show_both: [0, 1], sort: R, onenote_id: T }),
  note_sections: spec('note_sections', ['book_id', 'name'], { book_id: T, name: T, sort: R, onenote_id: T }),
  note_pages: spec('note_pages', ['section_id'], { section_id: T, title: T, sort: R, rev: I, onenote_id: T, onenote_sha: T }),
  note_blocks: spec('note_blocks', ['page_id', 'type', 'x', 'y', 'w'], { page_id: T, type: ['text', 'image', 'table'], x: R, y: R, w: R, h: R, z: I, style: T, html: T,
    cells_json: 'ja', r2_key: T, img_w: I, img_h: I, onenote_ref: T, rev: I, created_by: T }),
  note_strokes: spec('note_strokes', ['page_id', 'tool', 'colour', 'width', 'points'], { page_id: T, tool: ['pen', 'highlighter'], colour: T, width: R, points: T,
    x0: R, y0: R, x1: R, y1: R, z: I, rev: I, created_by: T }),
};
export const EXPORT_SKIP = { note_fts: 'The search index over note pages and blocks, rebuilt by POST /api/notes/reindex.' };
