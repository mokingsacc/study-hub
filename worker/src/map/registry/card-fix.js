const fix = () => import('../../card-fix.js');

export const QUEUE_HANDLERS = {
  card_fix: async (...a) => (await fix()).cardFixHandler(...a),
};

export const UNDO = {
  'card.fixed': async (...a) => (await fix()).undoCardFix(...a),
};

export const ROUTES = [
  ['POST', '/api/cards/:id/skip', async (...a) => (await fix()).skipRoute(...a)],
];
