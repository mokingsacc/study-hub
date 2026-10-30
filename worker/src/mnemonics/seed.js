import { json } from '../util.js';
import { applyChange } from '../map/change.js';
import { plan, fetchAliases, decide, hintSystems, ACCEPT } from '../map/resolve.js';
import SEED from './seed-onenote.js';

export const BATCH = 200;
const low = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Topic names -> live topic ids (exact matching only; a miss is left out). names: [[name, subject?], ...]. */
export async function topicIds(env, user, names) {
  const texts = names.map(([n]) => String(n || '').trim().slice(0, 200));
  const p = plan(texts, { exact: true });
  if (!p.keys.length) return texts.map(() => null);
  const data = await fetchAliases(env, user, p.keys);
  const out = p.items.map((it, i) => {
    const r = decide({ items: [it] }, data, hintSystems(names[i][1] || null), { exact: true });
    return r && r.topic_id && (r.confidence ?? 1) >= ACCEPT ? r.topic_id : null;
  });
  // a topic with no alias row yet: its own name, exactly (case and spacing aside)
  const missed = [...new Set(texts.filter((t, i) => !out[i]).map(low))];
  if (missed.length) {
    const rows = (await env.DB.prepare(`SELECT id, name FROM topics WHERE user_id = ? AND status IN ('proposed','confirmed')
      AND lower(name) IN (SELECT value FROM json_each(?))`).bind(user, JSON.stringify(missed)).all()).results || [];
    const by = new Map(rows.map(r => [low(r.name), r.id]));
    texts.forEach((t, i) => { if (!out[i]) out[i] = by.get(low(t)) || null; });
  }
  return out;
}

/** How many seed mnemonics are not in the hub yet (the page's banner). */
export async function seedLeft(env, user) {
  if (!SEED.length) return 0;
  const r = await env.DB.prepare(`SELECT count(*) AS n FROM mnemonics WHERE user_id = ? AND source = 'onenote'`).bind(user).first();
  return Math.max(0, SEED.length - ((r && r.n) || 0));
}

// POST /api/mnemonics/seed: import (or update) every seed mnemonic. -> {ok, added, updated, kept_his_edits, topics_matched, batches}
export async function seedRoute(request, env, ctx, params, url, user) {
  if (env.MNEMONICS !== 'on') return json({ error: 'Not found.' }, 404);
  if (!SEED.length) return json({ error: 'There are no OneNote mnemonics to bring in.' }, 404);
  const r = await seedImport(env, user, SEED);
  return json(r, r.ok ? 200 : 400);
}

/** The import itself, for any list in SEED's shape (tests pass their own). */
export async function seedImport(env, user, seed) {
  const pairs = [];
  for (const m of seed) for (const t of m.topics || []) pairs.push([t, m.subject]);
  const ids = await topicIds(env, user, pairs);
  let k = 0;
  const items = seed.map(m => {
    const topics = [...new Set((m.topics || []).map(() => ids[k++]).filter(Boolean))].slice(0, 12);
    return { source_ref: m.source_ref, cue: m.cue, about: m.about, kind: m.kind, items: m.items, category_id: m.subject || null, topics, notes: m.notes || null };
  });
  const out = { ok: true, added: 0, updated: 0, kept_his_edits: 0, topics_matched: ids.filter(Boolean).length, topics_named: ids.length, batches: [] };
  for (let i = 0; i < items.length; i += BATCH) {
    const r = await applyChange(env, user, { actor: 'code', surface: 'web', op: 'mnemonic.import', via: 'api:POST /api/mnemonics/seed', args: { source: 'onenote', items: items.slice(i, i + BATCH) } });
    if (r.refused) return { ...out, ok: false, error: r.reason };
    if (r.batch_id) out.batches.push(r.batch_id);
    out.added += r.added || 0; out.updated += r.updated || 0; out.kept_his_edits += r.kept_his_edits || 0;
  }
  return out;
}
