import { all, reserveSpend, spendCap } from './db.js';
import { callJson } from './claude.js';
import { GLOSSARY } from '../../public/js/exam/glossary.js';
import { MO } from './users.js';

const MAX_TERMS = 8000, MAX_LEXICON_CHARS = 120_000, MAX_LINES = 1500, MAX_FIXES = 300, RESERVE_USD = 0.5, LEXICON_TTL_MS = 3600_000;
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const lexicons = new WeakMap();
export async function lexiconFor(env, user = MO, t = Date.now()) {
  const c = lexicons.get(env.DB);
  if (c && t - c.at < LEXICON_TTL_MS) return c.lexicon;
  let rows = [];
  try {
    rows = await all(env, `SELECT name AS term FROM topics WHERE user_id = ?1 AND status IN ('proposed', 'confirmed')
      UNION SELECT alias AS term FROM topic_aliases WHERE user_id = ?1 AND status = 'active'`, user);
  } catch (e) { rows = []; }   // no map yet: the glossary alone
  const lexicon = buildLexicon([...rows.map(r => r.term), ...GLOSSARY]);
  lexicons.set(env.DB, { lexicon, at: t });
  return lexicon;
}

/** {terms: [sorted unique], keys: Set of their norm()} from any list of names; short names only. */
export function buildLexicon(names) {
  const byKey = new Map();
  for (const n of names) {
    const s = String(n || '').replace(/\s+/g, ' ').trim();
    const k = norm(s);
    if (!k || s.length > 60 || s.split(' ').length > 6 || byKey.has(k)) continue;
    byKey.set(k, s);
  }
  const terms = [...byKey.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  const kept = [];
  let chars = 0;
  for (const s of terms) { if (kept.length >= MAX_TERMS || chars + s.length + 2 > MAX_LEXICON_CHARS) break; kept.push(s); chars += s.length + 2; }
  return { terms: kept, keys: new Set(kept.map(norm)), byKey: new Map(kept.map(s => [norm(s), s])) };
}

const RULES = `You fix speech-recognition errors in what Mo said aloud while studying for USMLE Step 2 CK (a learner, often fast and muttered). Each numbered line is what the speech model heard. Fix only a word or short phrase that is clearly a mis-hearing of a medical term in the lexicon below, judged by sound and the sentence around it (for example "increase the surgery" said about an SSRI is "sertraline"; "Messerschmitts" for mid-cycle pain is "mittelschmerz"; "E. coli 015707" is "E. coli O157:H7").
Rules:
- Never change a word that is already a real medical term or drug, even if it is the wrong answer: his own mistakes must stay exactly as he said them.
- Never add words, reasoning or an answer, never fix grammar or ordinary English, and never fix what you are unsure of.
- heard is the exact text as it appears in the line (the shortest stretch that is wrong); fixed is the lexicon term exactly as written there.
Return an empty list when nothing needs fixing.

Lexicon (his own Step 2 vocabulary):
`;

const SCHEMA = {
  type: 'object',
  properties: { fixes: { type: 'array', items: { type: 'object', properties: {
    line: { type: 'integer' }, heard: { type: 'string' }, fixed: { type: 'string' },
  }, required: ['line', 'heard', 'fixed'], additionalProperties: false } } },
  required: ['fixes'], additionalProperties: false,
};

export const systemFor = lexicon => RULES + lexicon.terms.join('; ');

// Letter pairs in common (Dice), with digits read as the letters Whisper confuses them with (0 o, 1 l).
const pairs = s => { const t = norm(s).replace(/ /g, '').replace(/0/g, 'o').replace(/1/g, 'l'); const out = []; for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2)); return out; };
export function closeEnough(heard, fixed) {
  const a = pairs(heard), b = pairs(fixed);
  if (!a.length || !b.length) return false;
  const pool = [...b];
  let common = 0;
  for (const p of a) { const i = pool.indexOf(p); if (i >= 0) { common++; pool.splice(i, 1); } }
  const dice = (2 * common) / (a.length + b.length);
  const ha = norm(heard), fa = norm(fixed);
  const ratio = ha.length / Math.max(1, fa.length);
  return dice >= 0.3 || (ha[0] === fa[0] && ratio >= 0.5 && ratio <= 2);
}

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The fixes Claude gave, kept only when they pass every guard, applied to the lines. lines: [{text}]. Returns
 * {lines: [{...line, text, fixes}], fixes: [{line, heard, fixed}]}. Pure.
 */
export function applyFixes(lines, data, lexicon) {
  const out = lines.map(l => ({ ...l, fixes: [] }));
  const kept = [];
  for (const f of (data && Array.isArray(data.fixes) ? data.fixes : []).slice(0, MAX_FIXES)) {
    const n = Number(f && f.line) - 1;
    const line = out[n];
    const heard = String((f && f.heard) || '').trim(), want = String((f && f.fixed) || '').trim();
    if (!line || !heard || !want || heard.split(/\s+/).length > 5) continue;
    const fixed = lexicon.byKey.get(norm(want));
    if (!fixed || lexicon.keys.has(norm(heard)) || norm(heard) === norm(fixed) || !closeEnough(heard, fixed)) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escape(heard)}(?=$|[^\\p{L}\\p{N}])`, 'iu');
    if (!re.test(line.text)) continue;
    line.text = line.text.replace(re, (m, pre) => `${pre}${fixed}`);
    line.fixes.push({ heard, fixed });
    kept.push({ line: n + 1, heard, fixed });
  }
  return { lines: out, fixes: kept };
}

export const linesMessage = lines => lines.map((l, i) => `${i + 1}. ${l.text}`).join('\n');

export async function correctLines(env, lines, { user = MO, reserved = false } = {}) {
  const todo = (lines || []).slice(0, MAX_LINES);
  const asIs = { lines: (lines || []).map(l => ({ ...l, fixes: [] })), fixes: [], usd: 0 };
  if (!todo.some(l => String(l.text || '').trim())) return asIs;
  let release = null, usd = 0;
  try {
    const lexicon = await lexiconFor(env, user);
    if (!reserved) release = await reserveSpend(env, RESERVE_USD, await spendCap(env));
    const r = await callJson(env, { role: 'corrector', system: systemFor(lexicon), schema: SCHEMA, effort: 'high', maxTokens: 16000,
      messages: [{ role: 'user', content: `${todo.length} lines he said:\n${linesMessage(todo)}` }] });
    usd = r.usd || 0;
    const done = applyFixes(todo, r.data, lexicon);
    return { lines: [...done.lines, ...asIs.lines.slice(todo.length)], fixes: done.fixes, usd };
  } catch (e) {
    // Waiting for its Message Batch: the caller waits too (its judge reads the fixed words).
    if (e && e.pending === true && e.batch === true) throw e;
    usd = Number(e && e.usd) || 0;
    console.error('spelling check skipped', e && e.message);
    return { ...asIs, usd, skipped: e && e.status === 429 ? 'limit' : 'error' };
  } finally {
    if (release) await release(0);
  }
}

/** The fixes as a short note for a judge's message, or ''. */
export function fixesNote(fixes) {
  if (!fixes || !fixes.length) return '';
  return `\n\nSpelling check of his words (the speech model heard, then the term he meant): ${fixes.map(f => `"${f.heard}" was ${f.fixed}`).join('; ')}.`;
}
