const LOAD = {
  routes: () => import('../../orbits/routes.js'), seed: () => import('../../orbits/seed.js'), atlas: () => import('../../orbits/atlas.js'),
  due: () => import('../../orbits/due.js'), 'cards-subject': () => import('../../orbits/cards-subject.js'),
};
const R = (mod, fn) => async (...a) => (await LOAD[mod]())[fn](...a);
const routes = LOAD.routes;

export const ROUTES = [
  ['GET', '/api/orbits', R('routes', 'payloadRoute')],
  ['GET', '/api/orbits/section/:id', R('routes', 'sectionRoute')],
  ['GET', '/api/orbits/topic/:id', R('routes', 'topicRoute')],
  ['GET', '/api/orbits/link/:id', R('routes', 'linkRoute')],
  ['GET', '/api/orbits/topic-link', R('routes', 'topicLinkRoute')],
  ['POST', '/api/orbits/links/:id/hide', R('routes', 'hideRoute')],
  ['POST', '/api/orbits/links/:id/show', R('routes', 'showRoute')],
  ['POST', '/api/orbits/seed', R('seed', 'seedRoute')],
  ['GET', '/api/atlas/:deck/:page/:size', R('atlas', 'getRoute')],
  ['PUT', '/api/atlas/:deck/:page/:size', R('atlas', 'putRoute')],
  ['GET', '/api/orbits/due', R('due', 'dueRoute')],
  ['POST', '/api/orbits/due/refresh', R('due', 'refreshRoute')],
  ['GET', '/api/cards/subject/:category/list', R('cards-subject', 'listRoute')],
  ['GET', '/api/cards/batch', R('cards-subject', 'batchRoute')],
];

const pageOnly = (args, plan, ctx) => (ctx && (ctx.actor === 'mo' || ctx.actor === 'code') ? 'free' : 'refused');
const WRITES = { orbit_links: { actions: 'u', cols: ['status'] } };
export const CHANGE_KINDS = {
  'orbit_link.hide': { tier: pageOnly, page_only: true, reason: 'Mo hides drug links on the map himself.', kind: 'link.updated', undoable: true,
    plan: async (...a) => (await routes()).planHide(...a), writes: WRITES },
  'orbit_link.show': { tier: pageOnly, page_only: true, reason: 'Mo shows drug links on the map himself.', kind: 'link.updated', undoable: true,
    plan: async (...a) => (await routes()).planShow(...a), writes: WRITES },
};

export const EXPORT = {
  orbit_links: {
    cols: ['user_id', 'id', 'item_id', 'rel', 'how', 'topic_id', 'to_name', 'why', 'source_ref', 'status', 'created_by', 'created_at', 'updated_at'],
    required: ['id', 'item_id', 'rel', 'to_name', 'status', 'created_at', 'updated_at'],
    types: { user_id: 't', id: 't', item_id: 't', rel: ['treats', 'adverse_effect', 'avoid_in', 'causes'], how: 't', topic_id: 't', to_name: 't', why: 't', source_ref: 't',
      status: ['active', 'hidden'], created_by: 't', created_at: 'i', updated_at: 'i' },
  },
};
export const EXPORT_SKIP = {
  atlas_pages: "Megan Lane's page images are private and re-uploaded from Mo's own copy (scripts/orbits/upload-atlas.mjs).",
  orbit_sections: 'Reference data from the seed (scripts/orbits/build-seed.mjs).',
  orbit_items: 'Reference data from the seed (scripts/orbits/build-seed.mjs).',
  card_due: "A cache of Anki's schedule, rebuilt by the cards.due job.",
  card_subjects: 'Which subjects each card counts in, rebuilt by the cards.due job.',
  card_home: "Each card's one primary subject, rebuilt by the cards.due job (its auto topic links are in card_topics, which is exported).",
};
