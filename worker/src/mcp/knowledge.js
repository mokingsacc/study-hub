import { knowledgeBriefFor } from '../map/knowledge.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const KNOWLEDGE_TRIM = ['knowledge.related:1', 'knowledge.mehlman:0', 'knowledge.closed:1', 'knowledge.clicked:1', 'knowledge.his_words:1'];

/** A tool entry with the knowledge summary added to its reply (map_topic only; any other tool is returned as it is). */
export function withKnowledge(tool) {
  if (!tool || tool.name !== 'map_topic') return tool;
  const run = tool.run;
  return {
    ...tool,
    trim: [...(tool.trim || []), ...KNOWLEDGE_TRIM],
    run: async (env, user, args, ctx) => {
      const r = await run(env, user, args, ctx);
      const id = isObj(r) && r.found !== false && !r.refused ? (isObj(r.topic) && r.topic.id) || null : null;
      if (!id) return r;
      const knowledge = await knowledgeBriefFor(env, user, id).catch(() => null);
      return knowledge && knowledge.lessons != null ? { ...r, knowledge } : r;
    },
  };
}
