export const PREFIX = 'notes.import:';
export const ACTIVE = ['wait', 'pics'];
export const parse = s => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
/** sync_state rows {source, cursor, next_at, last_ok_at} as pages, in queue order. */
export const rowsOf = rows => (rows || []).map(x => ({ id: String(x.source).slice(PREFIX.length), source: x.source, order: Number(x.next_at) || 0,
  at: Number(x.last_ok_at) || 0, ...parse(x.cursor) })).sort((a, b) => a.order - b.order);

/** The job as the sidebar and the bar's chip show it. */
export function summarise(list, { now = Date.now(), lockUntil = 0 } = {}) {
  const pages = list.length, done = list.filter(p => p.st === 'done').length, failed = list.filter(p => p.st === 'failed');
  const active = list.filter(p => ACTIVE.includes(p.st));
  const cur = active[0] || null;
  const pics = { total: 0, done: 0, failed: 0 };
  for (const p of list) { pics.total += p.tot || 0; pics.done += p.got || 0; pics.failed += (p.miss || []).length; }
  return {
    running: active.length > 0, working: lockUntil > now, pages, done, failed: failed.length, waiting: active.length,
    current: cur ? { title: cur.t, n: list.indexOf(cur) + 1, stage: cur.st, pics_total: cur.tot || 0, pics_done: (cur.got || 0) + (cur.miss || []).length,
      ...(cur.nx > now ? { retry_at: cur.nx, error: cur.err || null } : {}) } : null,
    pics,
    problems: list.filter(p => p.st === 'failed' || (p.miss || []).length).map(p => ({ onenote_id: p.id, title: p.t, page_id: p.pid || null,
      error: p.st === 'failed' ? p.err || 'It did not come across.' : null, pictures_failed: (p.miss || []).length })),
    landed: list.filter(p => p.pid).map(p => ({ page_id: p.pid, got: p.got || 0 })),
    updated_at: Math.max(0, ...list.map(p => p.at)),
  };
}

/** The bar's chip (map/recent.js): a job line while pages wait, or one that names what failed. */
export function chipJob(st, now = Date.now()) {
  if (!st || !st.pages) return null;
  const base = { key: 'notes-import', source: 'Notes', since: st.updated_at || null };
  if (st.running) {
    const c = st.current;
    return { ...base, state: 'running', what: `Importing OneNote into Notes: page ${c ? c.n : st.done + 1} of ${st.pages}${c && c.pics_total ? `, pictures ${c.pics_done} of ${c.pics_total}` : ''}` };
  }
  const bad = st.problems.length;
  if (bad && now - (st.updated_at || 0) < 24 * 3600_000) {
    return { ...base, state: 'failed', what: `OneNote import: ${[st.failed && `${st.failed} page${st.failed === 1 ? '' : 's'}`, st.pics.failed && `${st.pics.failed} picture${st.pics.failed === 1 ? '' : 's'}`].filter(Boolean).join(' and ')} did not come across`,
      detail: 'Open Notes and press Retry.' };
  }
  return null;
}
