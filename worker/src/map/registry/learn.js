import * as learn from '../../learn/routes.js';

export const ROUTES = [
  ['POST', '/api/learn/seed/ajmonics', (...a) => learn.seedAjmonicsRoute(...a)],
  ['POST', '/api/learn/sweep', (...a) => learn.sweepRoute(...a)],
  ['GET', '/api/learn/:topic', (...a) => learn.viewRoute(...a)],
  ['POST', '/api/learn/:topic/update', (...a) => learn.updateRoute(...a)],
  ['POST', '/api/learn/:topic/ask', (...a) => learn.askRoute(...a)],
];

export const EXPORT_SKIP = {
  learn_points: "AJmonics' points, loaded again from scripts/seed/ajmonics-points.json by POST /api/learn/seed/ajmonics.",
  learn_summaries: "Claude's Learn summaries: a cache, written again by the next update.",
  learn_cards: "Claude's look-alike cards: a cache, written again with the next summary.",
  learn_faq: 'His Ask Claude questions and answers on Learn: shown on the page, not part of the map backup.',
};
