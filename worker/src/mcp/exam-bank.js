import { examEvidence, examVersus, searchBank, citeRow } from '../exam-bank.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const EXAMS_K = 6, VERSUS_N = 2, VERSUS_K = 3, SEARCH_K = 5;
const quiet = (what, e) => console.error(`${what} exam bank failed`, e && e.message);

async function topicExams(env, user, args, r, run, ctx) {
  const include = Array.isArray(args && args.include) ? args.include : null;
  if (!include || !include.includes('exams')) return run(env, user, args, ctx);
  const rest = include.filter(x => x !== 'exams');
  const res = await run(env, user, { ...args, include: rest.length ? rest : ['notes'] }, ctx);
  const t = isObj(res) && res.found !== false && !res.refused && isObj(res.topic) ? res.topic : null;
  if (!t) return res;
  try {
    const unitId = isObj(t.unit) && /^u\d{3}$/.test(String(t.unit.id || '')) ? t.unit.id : null;
    return { ...res, exams: { ...(await examEvidence(env, user, { unitId, words: t.name, k: EXAMS_K })), cite_as: 'On your exams: ... (CMS Peds 4 Q12, NBME 13 B2 Q31)' } };
  } catch (e) { quiet('map_topic', e); return res; }
}

async function neighbourExams(env, user, res) {
  if (!isObj(res) || !isObj(res.topic) || !Array.isArray(res.rows)) return res;
  try {
    const vs = res.rows.filter(x => x.type === 'versus' && isObj(x.other)).slice(0, VERSUS_N);
    const found = await Promise.all(vs.map(x => examVersus(env, user, res.topic.name, x.other.name, VERSUS_K)));
    vs.forEach((x, i) => { if (found[i].questions.length) x.exams = found[i].questions; });
    return res;
  } catch (e) { quiet('map_neighbours', e); return res; }
}

async function searchExams(env, user, args, res) {
  if (!isObj(res) || !args || !args.q) return res;
  try {
    const r = await searchBank(env, user, { q: args.q, k: SEARCH_K, meaning: false });
    if (!r.results.length) return res;
    const full = (await env.DB.prepare(`SELECT * FROM xq WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(r.results.map(x => x.id))).all()).results || [];
    const by = new Map(full.map(x => [x.id, x]));
    return { ...res, exam_questions: r.results.map(x => by.get(x.id)).filter(Boolean).map(citeRow) };
  } catch (e) { quiet('map_search', e); return res; }
}

/** A tool entry with the exam bank added to its reply (map_topic, map_neighbours, map_search; others as they are). */
export function withExams(tool) {
  if (!tool) return tool;
  const run = tool.run;
  if (tool.name === 'map_topic') return { ...tool, trim: ['exams.questions:3', ...(tool.trim || [])], run: (env, user, args, ctx) => topicExams(env, user, args, null, run, ctx) };
  if (tool.name === 'map_neighbours') return { ...tool, run: async (env, user, args, ctx) => neighbourExams(env, user, await run(env, user, args, ctx)) };
  if (tool.name === 'map_search') return { ...tool, trim: ['exam_questions:2', ...(tool.trim || [])], run: async (env, user, args, ctx) => searchExams(env, user, args, await run(env, user, args, ctx)) };
  return tool;
}
