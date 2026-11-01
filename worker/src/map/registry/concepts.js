const concepts = () => import('../concepts.js');
const clusters = () => import('../clusters.js');
const backfill = () => import('../concept-backfill.js');

export const ROUTES = [
  // Cards on root-cause topics moved to their clinical topics (card-roots.js; the deploy's catch-up, safe to run again).
  ['POST', '/api/map/card-roots/repair', async (...a) => (await import('../card-roots.js')).repairRoute(...a)],
  // The back-fill: dry run first (the default), then {dry_run: false}; {undo: 'bf_...'} or {undo: true} puts a run back.
  ['POST', '/api/map/concepts/backfill', async (...a) => (await backfill()).backfillRoute(...a)],
  // The root causes now (map_overview's line) and the tags by status, for a check from Claude Code.
  ['GET', '/api/map/concepts', async (request, env, ctx, params, url, user) => {
    const { json } = await import('../../util.js');
    const m = await concepts();
    let tags = [];
    try {
      tags = (await env.DB.prepare('SELECT status, count(*) AS n FROM concept_tags WHERE user_id = ? GROUP BY status').bind(user).all()).results || [];
    } catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
    return json({ root_causes: await m.rootCausesLine(env, user), tags: Object.fromEntries(tags.map(r => [r.status, r.n])) });
  }],

  // The clusters as the map's list draws them: {clusters: [{id, name, root, members, pairs, cost, lesson_n}], line}.
  ['GET', '/api/map/clusters', async (request, env, ctx, params, url, user) => {
    const { json } = await import('../../util.js');
    const m = await clusters();
    const rows = await m.readClusters(env, user);
    return json({ clusters: rows.map(c => ({ id: c.id, name: c.name, name_by: c.name_by, root: c.root, cost: c.cost, lesson_n: c.lesson_n, lesson_at: c.lesson_at,
      members: c.members.map(x => ({ id: x.id, name: x.name, kind: x.kind, role: x.role, band: x.band })), pairs: c.pairs.slice(0, 8) })), line: m.clustersLine(rows) });
  }],
  // Find them again now (the nightly job's run, its own Recent activity line): {found, new, kept, gone, top}.
  ['POST', '/api/map/clusters/run', async (request, env, ctx, params, url, user) => {
    const { json } = await import('../../util.js');
    return json(await (await import('../clusters-job.js')).clustersJob(env, user));
  }],
];

export const EXPORT_SKIP = {
  clusters: 'The error clusters (clusters-job.js): worked out again each night from his mix-ups, concepts and look-alike lines; a lesson keeps its cluster id.',
};

const T = 't', I = 'i', R = 'r';
export const EXPORT = {
  concept_tags: {
    cols: ['user_id', 'id', 'source', 'miss_id', 'block_id', 'q_index', 'uworld_block_id', 'uworld_q', 'misconception_id', 'clinical_topic_id', 'clinical_name', 'ref',
      'concept', 'concept_key', 'discipline', 'quote', 'cause', 'confidence', 'weight', 'concept_topic_id', 'queue_id', 'status', 'reason', 'words_hash', 'batch_id',
      'run_key', 'at', 'judged_at', 'applied_at', 'updated_at', 'polarity'],
    required: ['user_id', 'id', 'source', 'status', 'judged_at', 'updated_at'],
    types: { user_id: T, id: T, source: ['nbme_judge', 'uworld_judge', 'review_talk', 'misconception', 'backfill'], miss_id: T, block_id: T, q_index: I, uworld_block_id: T,
      uworld_q: I, misconception_id: T, clinical_topic_id: T, clinical_name: T, ref: T, concept: T, concept_key: T, discipline: T, quote: T, cause: T, confidence: T,
      weight: R, concept_topic_id: T, queue_id: T, status: ['judged', 'pending', 'queued', 'applied', 'none', 'skipped', 'undone'], reason: T, words_hash: T, batch_id: T,
      run_key: T, at: I, judged_at: I, applied_at: I, updated_at: I, polarity: ['miss', 'right'] },
  },
};
