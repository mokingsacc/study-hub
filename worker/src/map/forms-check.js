import { fitSql } from '../answer-core.js';
import { quoteFound, normText } from '../ai-audit.js';

export const FORMS = { days: 30, max: 300 };
const DAY = 86_400_000;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

// [sub-check, sql]: each row x (an example label) and id (the row to fix).
export const FORMS_SQL = [
  ['error_cause', `SELECT coalesce(m.label, m.id) AS x, 'misses:' || m.id AS id FROM misses m WHERE m.user_id = ?1 AND m.deleted_at IS NULL
      AND m.cause IS NOT NULL AND m.error_type IS NOT NULL AND NOT ${fitSql('m.error_type', 'm.cause')}
    UNION ALL SELECT 'gap ' || g.id AS x, 'gaps:' || g.id AS id FROM gaps g WHERE g.user_id = ?1 AND g.cause IS NOT NULL AND g.error_type IS NOT NULL
      AND NOT ${fitSql('g.error_type', 'g.cause')}`],
  ['mixed_no_confusion', `SELECT 'gap ' || g.id AS x, g.id AS id FROM gaps g WHERE g.user_id = ?1 AND coalesce(g.mixed_with, '') <> ''
      AND g.cause IS NOT NULL AND g.cause <> 'confusion'`],
];

export function quoteLooksHis(quote, words) {
  if (quoteFound(quote, words)) return true;
  const hay = new Set(normText(Array.isArray(words) ? words.join(' ') : words).split(' '));
  const long = normText(quote).split(' ').filter(w => w.length >= 4);
  if (!long.length) return false;
  return long.filter(w => !hay.has(w)).length <= 1 && long.length >= 2;
}

const text = segs => parse(segs, []).map(s => (s && s.text) || '').join(' ');

export async function fakeQuotes(env, user, { now = Date.now() } = {}) {
  let misses;
  try {
    misses = (await env.DB.prepare(`SELECT id, label, cause_quote, uworld_block_id, block_id, q_index FROM misses WHERE user_id = ?1 AND deleted_at IS NULL
      AND coalesce(cause_quote, '') <> '' AND at >= ?2 AND (uworld_block_id IS NOT NULL OR block_id IS NOT NULL) ORDER BY at DESC LIMIT ?3`)
      .bind(user, now - FORMS.days * DAY, FORMS.max).all()).results || [];
  } catch (e) { if (noTable(e)) return []; throw e; }
  if (!misses.length) return [];
  const uw = [...new Set(misses.map(m => m.uworld_block_id).filter(Boolean))];
  const hub = [...new Set(misses.filter(m => !m.uworld_block_id && m.block_id).map(m => m.block_id))];
  const [blocks, talks, trs] = await env.DB.batch([
    env.DB.prepare('SELECT id, segments_json FROM uworld_blocks WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(uw)),
    env.DB.prepare('SELECT block_id, segments_json FROM uworld_review_talks WHERE user_id = ?1 AND block_id IN (SELECT value FROM json_each(?2))').bind(user, JSON.stringify(uw)),
    env.DB.prepare('SELECT block_id, q_index, segments_json FROM transcripts WHERE block_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(hub)),
  ]);
  const words = new Map();
  for (const b of blocks.results || []) words.set(`u|${b.id}`, [text(b.segments_json)]);
  for (const t of talks.results || []) words.set(`u|${t.block_id}`, [...(words.get(`u|${t.block_id}`) || []), text(t.segments_json)]);
  for (const t of trs.results || []) words.set(`h|${t.block_id}|${t.q_index}`, [text(t.segments_json)]);
  return misses.filter(m => {
    const w = m.uworld_block_id ? words.get(`u|${m.uworld_block_id}`) : words.get(`h|${m.block_id}|${m.q_index}`);
    if (!w || !w.join('').trim()) return false;
    return !quoteLooksHis(m.cause_quote, w);
  }).map(m => ({ id: m.id, label: m.label || m.id }));
}
