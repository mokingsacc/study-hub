const noTable = e => /no such table|no such column/i.test(String(e && e.message));

export async function examRanks(env, user, unitIds = null) {
  const out = new Map();
  try {
    const ids = unitIds ? [...new Set(unitIds.filter(Boolean))] : null;
    if (ids && !ids.length) return out;
    const rows = ids
      ? (await env.DB.prepare(`SELECT unit_id, coll, rank, n, of_n FROM xq_rank WHERE user_id = ? AND unit_id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(ids)).all()).results
      : (await env.DB.prepare(`SELECT unit_id, coll, rank, n, of_n FROM xq_rank WHERE user_id = ?`).bind(user).all()).results;
    for (const r of rows || []) {
      const e = out.get(r.unit_id) || {};
      e[r.coll] = { rank: r.rank, n: r.n, of: r.of_n };
      out.set(r.unit_id, e);
    }
  } catch (e) { if (!noTable(e)) throw e; }
  return out;
}

export const examRankText = (nbme, cms) => [nbme != null ? `NBME #${nbme}` : null, cms != null ? `CMS #${cms}` : null].filter(Boolean).join(' · ');

export const rankJoin = (u = 'u') => `LEFT JOIN xq_rank xrn ON xrn.user_id = ${u}.user_id AND xrn.unit_id = ${u}.id AND xrn.coll = 'nbme'
  LEFT JOIN xq_rank xrc ON xrc.user_id = ${u}.user_id AND xrc.unit_id = ${u}.id AND xrc.coll = 'cms'`;
export const RANK_COLS = 'xrn.rank AS nbme_rank, xrc.rank AS cms_rank';

