// Review page (board, checklist) registry (owner: REV). The shapes are at the top of registry/index.js. Handlers
// and planners are wrapped so this file only touches board.js and board-routes.js at call time (registry import
// cycles stay harmless).
import * as board from '../board.js';
import * as routes from '../board-routes.js';
import * as recent from '../recent.js';

export const CHANGE_KINDS = {
  'checklist.tick': {
    tier: (args, plan, ctx) => board.tickTier(args, plan, ctx), kind: 'checklist.ticked', undoable: true,
    evidence: { remove: ['tick:'], repoint: false }, plan: (...a) => board.planChecklistTick(...a),
  },
  // The reviewed tick on error-log rows (one, or up to 25 from board_tick). Free and undoable; never moves a colour.
  'miss.review': { tier: 'free', kind: 'miss.reviewed', undoable: true, plan: (...a) => board.planMissReview(...a) },
};

export const ROUTES = [
  ['GET', '/api/board/summary', (...a) => routes.summaryRoute(...a)],
  ['GET', '/api/board/log', (...a) => routes.logRoute(...a)],
  ['GET', '/api/board/misses', (...a) => routes.missesRoute(...a)],
  ['GET', '/api/board/misses/:id/anki', (...a) => routes.missAnkiRoute(...a)],
  ['GET', '/api/board/tally', (...a) => routes.tallyRoute(...a)],
  ['GET', '/api/board/checklist', (...a) => routes.checklistRoute(...a)],
  ['PATCH', '/api/board/checklist', (...a) => routes.tickRoute(...a)],
  ['PATCH', '/api/board/misses/:id', (...a) => routes.reviewRoute(...a)],
  ['GET', '/api/map/recent', (...a) => recent.recentTopicsRoute(...a)],
  ['GET', '/api/recent', (...a) => recent.recentRoute(...a)],
];

// How the Review page opens (plan §9 Prefs). The last tab used on a device is kept in localStorage too.
export const PREFS = {
  'board.default_tab': { type: 'enum', enum: ['log', 'tally', 'yield', 'checklist'], default: 'log', label: 'Review page: the tab it opens on', owner: 'review' },
  'board.log_group': { type: 'enum', enum: ['system', 'day', 'none'], default: 'system', label: 'Error log grouped by system, by day or not at all', owner: 'review' },
  'board.log_range': { type: 'enum', enum: ['7', '30', 'all'], default: '30', label: 'Error log: the days it shows first (7, 30 or all)', owner: 'review' },
  'board.page_size': { type: 'int', min: 20, max: 200, default: 60, label: 'Error log: rows shown before "Show more"', owner: 'review' },
};

// Recent activity's job lines (0043, job-log.js): a 30-day log of what ran in the background, not study data.
export const EXPORT_SKIP = { job_runs: "Recent activity's job lines, kept 30 days: a log of background runs, not study data." };

const T = 't', I = 'i';
export const EXPORT = {
  checklist_progress: {
    cols: ['user_id', 'unit_id', 'step', 'mastered', 'rating', 'mastered_at', 'source', 'source_ref', 'created_by', 'updated_at'],
    required: ['user_id', 'unit_id', 'step', 'updated_at'],
    types: { user_id: T, unit_id: T, step: ['recognise', 'distinguish', 'test', 'treat', 'trap', 'studied', 'overall'], mastered: [0, 1],
      rating: ['red', 'amber', 'green'], mastered_at: I, source: ['hub', 'onenote'], source_ref: T, created_by: ['seed', 'code', 'claude', 'mo'], updated_at: I },
  },
};
