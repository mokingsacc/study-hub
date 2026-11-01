const viva = () => import('../viva.js');

export const CHANGE_KINDS = {
  'viva.grade': {
    tier: (args, plan, ctx) => (ctx.actor === 'code' ? 'free' : 'refused'), kind: 'viva.graded', undoable: true, page_only: true,
    evidence: true, codeMarks: ['evidence.result', 'lessons.outcome'], reason: 'A viva is graded by the hub itself.',
    // A lesson's opening or closing viva (0065): its score and headings on the lesson, and a finished lesson's outcome.
    writes: { lessons: { actions: 'u', cols: ['viva_before', 'viva_after', 'viva_json'] } },
    plan: async (...a) => (await viva()).planVivaGrade(...a),
  },
};

export const ROUTES = [
  // The week's self-audit and the newest vivas (the honesty report carries the same summary).
  ['GET', '/api/map/viva', async (request, env, ctx, params, url, user) => {
    const m = await viva();
    const { json } = await import('../../util.js');
    const now = Date.now();
    let recent = [];
    try {
      recent = ((await env.DB.prepare(`SELECT * FROM viva_results WHERE user_id = ? AND status IN ('pending', 'graded', 'failed') ORDER BY updated_at DESC LIMIT 10`)
        .bind(user).all()).results || []).map(v => (v.status === 'graded' ? { topic: v.topic_name, ...m.shapeViva(v) } : { id: v.id, topic: v.topic_name, status: v.status }));
    } catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
    return json({ audit: await m.auditSummary(env, user, { now }), recent });
  }],
];

export const EXPORT_SKIP = {
  viva_rubrics: "Each topic's viva rubric (viva.js): a cache built again from his own sources by the minute job; the grades keep the points they used.",
};

export const EXPORT = {
  viva_results: {
    cols: ['user_id', 'id', 'kind', 'topic_id', 'topic_name', 'lesson_id', 'surface', 'status', 'prompt', 'transcript', 'said_at', 'rubric_version', 'pred_p',
      'pred_band', 'pred_json', 'coverage', 'grade', 'said_n', 'wrong_n', 'missing_n', 'result_json', 'surprise', 'surprise_word', 'attempts', 'error', 'usd',
      'batch_id', 'graded_at', 'created_at', 'updated_at', 'phase', 'heard', 'form_version'],
    required: ['user_id', 'id', 'kind', 'status', 'created_at', 'updated_at'],
    types: { user_id: 't', id: 't', kind: ['lesson', 'audit'], topic_id: 't', topic_name: 't', lesson_id: 't', surface: 't',
      status: ['awaiting', 'pending', 'graded', 'failed', 'expired'], prompt: 't', transcript: 't', said_at: 'i', rubric_version: 'i', pred_p: 'r', pred_band: 't',
      pred_json: 'jo', coverage: 'r', grade: ['good', 'hard', 'again'], said_n: 'i', wrong_n: 'i', missing_n: 'i', result_json: 'jo', surprise: 'r',
      surprise_word: ['matched', 'too_red', 'too_green'], attempts: 'i', error: 't', usd: 'r', batch_id: 't', graded_at: 'i', created_at: 'i', updated_at: 'i',
      phase: ['before', 'after'], heard: ['clear', 'partial', 'unclear', 'not_said'], form_version: 'i' },
  },
};
