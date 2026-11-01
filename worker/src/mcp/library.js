import { topicCount, topicCoverage, collectionsOf, spreadAcrossBooks } from '../library/search.js';
import { tagOf } from '../map/fact-sources.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const LIBRARY_TRIM = ['library.passages:2'];
export const LIBRARY_MAX = 8, LIBRARY_TEXT = 700;   // 900: the teach brief sends Claude here to read a candidate in full

/** A tool entry with the library added to its reply (map_topic only; any other tool is returned as it is). */
export function withLibrary(tool) {
  if (!tool || tool.name !== 'map_topic') return tool;
  const run = tool.run;
  return {
    ...tool,
    trim: [...LIBRARY_TRIM, ...(tool.trim || [])],
    run: async (env, user, args, ctx) => {
      const include = Array.isArray(args && args.include) ? args.include : null;
      const wantPassages = !!(include && include.includes('library'));
      const rest = include ? include.filter(x => x !== 'library') : null;
      const inner = include ? { ...args, include: rest.length ? rest : ['notes'] } : args;
      const r = await run(env, user, inner, ctx);
      const id = isObj(r) && r.found !== false && !r.refused ? (isObj(r.topic) && r.topic.id) || null : null;
      if (!id) return r;
      try {
        if (!wantPassages) {
          const c = await topicCount(env, user, id);
          return c && c.n ? { ...r, library: { n: c.n, docs: c.docs, next_step: 'map_topic with include ["library"] for the passages.' } } : r;
        }
        const cov = await topicCoverage(env, user, id, { build: true, limit: 60, textMax: LIBRARY_TEXT, ai: env.AI });
        const passages = [];
        for (const d of cov.docs || []) for (const p of d.pages) for (const x of p.passages) passages.push({ cite: x.cite, doc_id: d.doc_id, page: p.page, passage_id: x.id, score: x.score, text: x.text });
        const coll = await collectionsOf(env, user, passages.map(x => x.doc_id));
        const spread = spreadAcrossBooks(passages, x => coll.get(x.doc_id)).map(x => ({ ...x, tag: tagOf(x.cite), source: coll.get(x.doc_id) || null }));
        const books = [...new Set((cov.docs || []).map(d => d.title))];
        return { ...r, library: { n: cov.n, docs: books.length, books, passages: spread.slice(0, LIBRARY_MAX), more: Math.max(0, spread.length - LIBRARY_MAX) } };
      } catch (e) {
        console.error('map_topic library failed', e && e.message);
        return r;
      }
    },
  };
}
