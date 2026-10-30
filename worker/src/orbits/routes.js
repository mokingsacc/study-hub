import { HttpError, json } from '../util.js';
import { applyChange, changeResponse } from '../map/change.js';
import { needOrbits, parseJson } from './common.js';

const n = v => (v == null ? null : Number(v));

// ---------------------------------------------------------------- shared reads
async function readAll(env, user) {
  const [s, it, l, p] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM orbit_sections WHERE user_id = ? ORDER BY kind, sort, id').bind(user),
    env.DB.prepare('SELECT id, kind, name, topic_id, sections_json, book_pages_json, pin, updated_at FROM orbit_items WHERE user_id = ? ORDER BY id').bind(user),
    env.DB.prepare('SELECT id, item_id, rel, how, topic_id, to_name, status, source_ref, updated_at FROM orbit_links WHERE user_id = ? ORDER BY id').bind(user),
    env.DB.prepare('SELECT deck, page, book_page, title, md_w, md_h, sizes, uploaded_at FROM atlas_pages WHERE user_id = ? ORDER BY deck, page').bind(user),
  ]);
  return { sections: s.results || [], items: it.results || [], links: l.results || [], pages: p.results || [] };
}

/**
 * The section a link belongs to (DESIGN §12.5: a drug in two sections shows each link where its source puts it):
 * "pathogens p3" is the pathogen page; "pharm p30 (Antibiotics)" the section of that title (else of that book page);
 * otherwise the item's first section.
 */
export function sectionOf(link, item, sections) {
  const ref = String(link.source_ref || '');
  let m = /^pathogens p(\d+)/.exec(ref);
  if (m) { const s = sections.find(x => x.kind === 'microbes' && Number(x.page) === Number(m[1])); if (s) return s.id; }
  m = /^pharm p(\d+)(?: \(([^)]+)\))?/.exec(ref);
  if (m) {
    const t = (m[2] || '').toLowerCase();
    const s = (t && sections.find(x => x.kind === 'pharm' && x.title.toLowerCase() === t)) || sections.find(x => x.kind === 'pharm' && Number(x.book_page) === Number(m[1]) && !x.region)
      || sections.find(x => x.kind === 'pharm' && Number(x.book_page) === Number(m[1]));
    if (s) return s.id;
  }
  const own = item ? parseJson(item.sections_json, []) : [];
  return own.find(id => sections.some(s => s.id === id)) || null;
}

const sectionOut = s => ({ id: s.id, kind: s.kind, title: s.title, short: s.short, deck: s.deck, page: n(s.page), book_page: n(s.book_page),
  region: s.region ? s.region.split(',').map(Number) : null, category_id: s.category_id, also: parseJson(s.also_json, []), sort: n(s.sort), status: s.status });

async function etagOf(text) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return `"o${[...new Uint8Array(d)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('')}"`;
}

// ---------------------------------------------------------------- GET /api/orbits
/**
 * The payload (compact): sections with counts, items [id, name, kind, topic_id], links [item_idx, rel, how, topic_id,
 * status, id, section_idx] (no whys), pages. Behind an ETag.
 */
export async function payloadRoute(request, env, ctx, params, url, user) {
  needOrbits(env);
  const all = await readAll(env, user);
  const secIdx = new Map(all.sections.map((s, i) => [s.id, i]));
  const itemIdx = new Map(all.items.map((t, i) => [t.id, i]));
  const counts = all.sections.map(() => ({ placed: 0, unplaced: 0, hidden: 0 }));
  const links = [];
  for (const l of all.links) {
    const ii = itemIdx.get(l.item_id);
    if (ii == null) continue;
    const sid = sectionOf(l, all.items[ii], all.sections);
    const si = sid == null ? -1 : secIdx.get(sid);
    if (si >= 0) { const c = counts[si]; if (l.status === 'hidden') c.hidden++; else if (l.topic_id) c.placed++; else c.unplaced++; }
    links.push([ii, l.rel, l.how || null, l.topic_id || null, l.status === 'hidden' ? 0 : 1, l.id, si]);
  }
  const body = {
    sections: all.sections.map((s, i) => ({ ...sectionOut(s), counts: counts[i] })),
    items: all.items.map(t => [t.id, t.name, t.kind, t.topic_id || null]),
    links,
    pages: all.pages.map(p => ({ deck: p.deck, page: n(p.page), book_page: n(p.book_page), title: p.title, w: n(p.md_w), h: n(p.md_h),
      sizes: String(p.sizes || '').split(',').filter(Boolean) })),
  };
  const maxAt = Math.max(0, ...all.sections.map(s => s.updated_at || 0), ...all.items.map(t => t.updated_at || 0), ...all.links.map(l => l.updated_at || 0), ...all.pages.map(p => p.uploaded_at || 0));
  const etag = await etagOf(`${maxAt}|${all.sections.length}|${all.items.length}|${all.links.length}|${all.pages.map(p => p.sizes).join(';')}|${links.filter(l => !l[4]).length}`);
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  const res = json(body);
  res.headers.set('ETag', etag);
  res.headers.set('Cache-Control', 'private, no-cache');
  return res;
}

// ---------------------------------------------------------------- one section, one topic, one link
async function topicNames(env, user, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const r = await env.DB.prepare(`SELECT id, name, category_id FROM topics WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`).bind(user, JSON.stringify(list)).all();
  return new Map((r.results || []).map(t => [t.id, t]));
}

const linkOut = (l, item, names, sid) => ({ id: l.id, item_id: l.item_id, item: item ? item.name : null, item_kind: item ? item.kind : null, item_topic_id: item ? item.topic_id || null : null,
  rel: l.rel, how: l.how || null, topic_id: l.topic_id || null, topic: l.topic_id && names.get(l.topic_id) ? names.get(l.topic_id).name : null,
  category_id: l.topic_id && names.get(l.topic_id) ? names.get(l.topic_id).category_id : null, to_name: l.to_name, why: l.why || '', source_ref: l.source_ref || null,
  status: l.status, section_id: sid });

// GET /api/orbits/section/:id: its links with whys (placed, unplaced and hidden) and its drugs with book pages.
export async function sectionRoute(request, env, ctx, params, url, user) {
  needOrbits(env);
  const all = await readAll(env, user);
  const s = all.sections.find(x => x.id === params.id);
  if (!s) throw new HttpError(404, 'No such diagram.');
  const items = new Map(all.items.map(t => [t.id, t]));
  const mine = all.links.filter(l => sectionOf(l, items.get(l.item_id), all.sections) === s.id);
  const whys = mine.length ? await env.DB.prepare('SELECT id, why FROM orbit_links WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(user, JSON.stringify(mine.map(l => l.id))).all() : { results: [] };
  const why = new Map((whys.results || []).map(r => [r.id, r.why]));
  const names = await topicNames(env, user, mine.map(l => l.topic_id));
  const drugs = all.items.filter(t => parseJson(t.sections_json, []).includes(s.id)).map(t => ({ id: t.id, name: t.name, kind: t.kind, topic_id: t.topic_id || null,
    book_pages: parseJson(t.book_pages_json, []), pin: t.pin || null }));
  const page = all.pages.find(p => p.deck === s.deck && Number(p.page) === Number(s.page)) || null;
  return json({ section: sectionOut(s), page: page && { title: page.title, w: n(page.md_w), h: n(page.md_h), sizes: String(page.sizes || '').split(',').filter(Boolean) },
    links: mine.map(l => linkOut({ ...l, why: why.get(l.id) }, items.get(l.item_id), names, s.id)), drugs });
}

// GET /api/orbits/topic/:id: the drug and organism links into one topic (the panel block and the topic's threads).
export async function topicRoute(request, env, ctx, params, url, user) {
  needOrbits(env);
  const id = String(params.id || '');
  const [l, all] = await Promise.all([
    env.DB.prepare('SELECT * FROM orbit_links WHERE user_id = ? AND topic_id = ? ORDER BY rel, how, id').bind(user, id).all(),
    readAll(env, user),
  ]);
  const items = new Map(all.items.map(t => [t.id, t]));
  const names = await topicNames(env, user, [id]);
  const rows = (l.results || []).map(x => linkOut(x, items.get(x.item_id), names, sectionOf(x, items.get(x.item_id), all.sections)));
  return json({ topic_id: id, links: rows.filter(r => r.status !== 'hidden'), hidden: rows.filter(r => r.status === 'hidden').length });
}

// GET /api/orbits/link/:id: one link's note (rel, how, why, source, item, section with page and region, the topic).
export async function linkRoute(request, env, ctx, params, url, user) {
  needOrbits(env);
  const l = await env.DB.prepare('SELECT * FROM orbit_links WHERE user_id = ? AND id = ?').bind(user, params.id).first();
  if (!l) throw new HttpError(404, 'That link is no longer there.');
  const all = await readAll(env, user);
  const item = all.items.find(t => t.id === l.item_id) || null;
  const sid = sectionOf(l, item, all.sections);
  const s = all.sections.find(x => x.id === sid) || null;
  const names = await topicNames(env, user, [l.topic_id]);
  return json({ link: linkOut(l, item, names, sid), section: s ? sectionOut(s) : null, seeded_at: l.created_at });
}

// ---------------------------------------------------------------- topic-to-topic link notes (DESIGN §9)
const DAY_WORDS = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });
const LINK_TYPES = ['versus', 'treated_by', 'adverse_effect', 'causes'];

/** One support row's label, built by code from structured fields only. */
export function supportLabel(s, names, link) {
  const day = s.at ? DAY_WORDS(s.at) : '';
  if (s.miss_label) {
    const other = s.truth_id ? (s.truth_id === link.from_id ? link.to_id : link.from_id) : null;
    const picked = s.role === 'picked' && s.truth_id && other ? `you picked ${names.get(other) || 'the other'}; it was ${names.get(s.truth_id) || 'this one'}` : null;
    return { kind: 'exam', text: [s.miss_label, day, picked].filter(Boolean).join(' · ') };
  }
  if (s.gap_id) return { kind: 'gap', text: s.gap_text ? `Gap · ${day} · ‘${String(s.gap_text).slice(0, 80)}’` : `Gap · ${day}` };
  if (s.lesson_id) return { kind: 'lesson', text: `Taught as a pair · ${day}` };
  if (s.card_id) return { kind: 'card', text: `Card review · ${day}` };
  if (s.src === 'anking_hy') return { kind: 'card', text: 'AnKing high-yield table' };
  if (s.src === 'onenote') return { kind: 'note', text: `Your OneNote notes${day ? ` · ${day}` : ''}` };
  if (s.src === 'claude') return { kind: 'lesson', text: `Added with Claude${day ? ` · ${day}` : ''}` };
  return { kind: 'hub', text: 'Found by the hub' };
}

export async function topicLinkRoute(request, env, ctx, params, url, user) {
  needOrbits(env);
  const type = url.searchParams.get('type') || 'versus';
  const a = url.searchParams.get('a') || '', b = url.searchParams.get('b') || '';
  if (!LINK_TYPES.includes(type) || !a || !b) throw new HttpError(400, 'Which link? Give type, a and b.');
  const link = await env.DB.prepare(`SELECT * FROM links WHERE user_id = ?1 AND type = ?2 AND status = 'active'
      AND ((from_id = ?3 AND to_id = ?4) OR (from_id = ?4 AND to_id = ?3)) ORDER BY strength DESC LIMIT 1`).bind(user, type, a, b).first();
  if (!link) throw new HttpError(404, 'That link is no longer there.');
  const sup = await env.DB.prepare(`SELECT ls.src, ls.role, ls.truth_id, ls.miss_id, ls.gap_id, ls.lesson_id, ls.card_id, ls.at,
      m.label AS miss_label, CASE WHEN g.sitting_id IS NULL AND (g.ref IS NULL OR g.ref NOT LIKE 'UW%') THEN g.gap END AS gap_text
    FROM link_support ls LEFT JOIN misses m ON m.id = ls.miss_id AND m.held = 0 AND m.deleted_at IS NULL LEFT JOIN gaps g ON g.id = ls.gap_id
    WHERE ls.user_id = ?1 AND ls.link_id = ?2 AND ls.held = 0 AND (ls.miss_id IS NULL OR m.id IS NOT NULL)
    ORDER BY ls.at DESC LIMIT 200`).bind(user, link.id).all();
  const rows = sup.results || [];
  const tn = await topicNames(env, user, [link.from_id, link.to_id]);
  const names = new Map([...tn].map(([k, v]) => [k, v.name]));
  const fromA = link.from_id === a;
  return json({
    link: { id: link.id, type: link.type, from_id: link.from_id, to_id: link.to_id, from: names.get(link.from_id) || null, to: names.get(link.to_id) || null,
      how: link.how || null, fact: (fromA ? link.a_vs_b : link.b_vs_a) || link.a_vs_b || link.b_vs_a || null, strength: n(link.strength), confusion: n(link.confusion),
      confused_n: n(link.confused_n) || 0, last_confused_at: n(link.last_confused_at), source: link.source, created_by: link.created_by, created_at: n(link.created_at) },
    support: rows.slice(0, 6).map(s => supportLabel(s, names, link)), more: Math.max(0, rows.length - 6), total: rows.length,
  });
}

// ---------------------------------------------------------------- hide and show (applyChange)
async function planStatus(env, user, args, status) {
  const id = String((args && args.link_id) || '');
  const l = await env.DB.prepare('SELECT id, status, topic_id, to_name, item_id, rel FROM orbit_links WHERE user_id = ? AND id = ?').bind(user, id).first();
  if (!l) return { refuse: 'That link is no longer there.', field: 'link_id' };
  if (l.status === status) return { noop: true, summary: status === 'hidden' ? 'That link is already hidden.' : 'That link is already shown.' };
  const item = await env.DB.prepare('SELECT name FROM orbit_items WHERE user_id = ? AND id = ?').bind(user, l.item_id).first();
  const words = `${item ? item.name : 'A drug'} and ${l.to_name}`.slice(0, 120);
  return {
    rows: [{ table: 'orbit_links', op: 'update', key: { id }, before: { status: l.status }, after: { status, updated_at: Date.now() } }],
    events: [{ target_type: 'orbit_links', target_id: id, topic_id: l.topic_id || null, summary: `${status === 'hidden' ? 'Hid' : 'Showed'} the link between ${words}` }],
    summary: status === 'hidden' ? 'Link hidden' : 'Link shown',
  };
}
export const planHide = (env, user, args) => planStatus(env, user, args, 'hidden');
export const planShow = (env, user, args) => planStatus(env, user, args, 'active');

/** links' 'link.updated' undo hands orbit_links events here: the status goes back, unless it changed again since. */
export async function undoOrbitLink(env, user, e) {
  const before = parseJson(e.before_json, null), after = parseJson(e.after_json, null);
  const cur = await env.DB.prepare('SELECT id, status FROM orbit_links WHERE user_id = ? AND id = ?').bind(user, e.target_id).first();
  if (!cur || !before) return { conflict: 'That link is no longer there.' };
  if (after && after.status && cur.status !== after.status) return { conflict: 'That was changed again since; undo the later change first.' };
  return { rows: [{ table: 'orbit_links', op: 'update', key: { id: e.target_id }, before: { status: cur.status }, after: { status: before.status, updated_at: Date.now() } }] };
}

export async function hideRoute(request, env, ctx, params, url, user) {
  needOrbits(env);
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'orbit_link.hide', args: { link_id: params.id }, via: 'api:POST /api/orbits/links/hide' }));
}
export async function showRoute(request, env, ctx, params, url, user) {
  needOrbits(env);
  return changeResponse(await applyChange(env, user, { actor: 'mo', surface: 'web', op: 'orbit_link.show', args: { link_id: params.id }, via: 'api:POST /api/orbits/links/show' }));
}
