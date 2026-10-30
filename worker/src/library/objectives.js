
export const MAX_IDS = 60;
export const isQid = s => /^\d{3,6}$/.test(String(s || ''));

const SQL = `SELECT p.pid, p.doc_id, p.page, p.page_to, p.text FROM library_fts f JOIN library_passages p ON p.pid = f.rowid
  WHERE library_fts MATCH ?2 AND p.user_id = ?1 AND instr(p.text, ?3) > 0 LIMIT 4`;

/** The objective for `id` cut out of one passage's text, or null. */
export function cutObjective(text, id) {
  const tag = `[${id}]`;
  const at = String(text || '').indexOf(tag);
  if (at < 0) return null;
  const before = text.slice(0, at);
  const prev = before.search(/\[\d{3,6}\][^[]*$/);
  const from = prev < 0 ? 0 : before.indexOf(']', prev) + 1;
  // A section heading the PDF prints in capitals at the top of a page ("GLOMERULAR DISEASES, NEPHROTIC…") is not
  // part of the objective.
  const cut = before.slice(from).replace(/\s+/g, ' ').trim().replace(/^(?:[A-Z0-9][A-Z0-9,/&()'-]*\s+){2,}(?=[A-Z][a-z])/, '');
  return cut.length >= 20 ? { text: cut, whole: prev >= 0 } : null;
}

/** {id: {text, doc_id, page, pid}} for the ids found (unknown ids are left out). */
export async function objectivesFor(env, user, ids) {
  const want = [...new Set(ids.map(String).filter(isQid))].slice(0, MAX_IDS);
  if (!want.length) return {};
  const res = await env.DB.batch(want.map(id => env.DB.prepare(SQL).bind(user, `text:"${id}"`, `[${id}]`)));
  const out = {};
  want.forEach((id, i) => {
    let best = null;
    for (const r of (res[i] && res[i].results) || []) {
      const c = cutObjective(r.text, id);
      // A cut that starts after the previous objective's tag is whole; otherwise the longer one is likelier whole.
      if (c && (!best || (c.whole && !best.whole) || (c.whole === best.whole && c.text.length > best.text.length))) best = { ...c, doc_id: r.doc_id, page: r.page, page_to: r.page_to, pid: r.pid };
    }
    if (best) out[id] = { text: best.text, doc_id: best.doc_id, page: best.page, page_to: best.page_to, pid: best.pid, whole: best.whole };
  });
  // The page text around each hit, for the cuts that started at a passage's edge.
  const part = Object.keys(out).filter(id => !out[id].whole);
  if (part.length) {
    const pages = await env.DB.batch(part.map(id => env.DB.prepare('SELECT n, text FROM library_pages WHERE user_id = ?1 AND doc_id = ?2 AND n BETWEEN ?3 AND ?4 ORDER BY n')
      .bind(user, out[id].doc_id, Math.max(1, out[id].page - 1), out[id].page_to)));
    part.forEach((id, i) => {
      const rows = (pages[i] && pages[i].results) || [];
      const c = cutObjective(rows.map(r => r.text).join('\n'), id);
      if (c && c.text.length >= out[id].text.length) {
        out[id].text = c.text;
        out[id].page = (rows.find(r => r.text.includes(`[${id}]`)) || {}).n || out[id].page;
      }
    });
  }
  for (const o of Object.values(out)) { delete o.whole; delete o.page_to; }
  return out;
}
