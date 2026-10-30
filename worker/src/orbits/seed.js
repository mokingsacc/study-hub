import { HttpError, json, readJson } from '../util.js';
import { jsonInsert } from '../map/events.js';
import { needOrbits, linkId, RELS, HOWS, WHY_BAD, norm } from './common.js';
import { topicIndex, placeName, replace } from './place.js';

const ID = /^[a-z0-9][a-z0-9_-]{1,80}$/;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const intOr = (v, d = null) => (Number.isSafeInteger(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const regionText = r => (Array.isArray(r) && r.length === 4 && r.every(x => Number.isFinite(Number(x)) && x >= 0 && x <= 1) ? r.map(x => Number(x)).join(',')
  : typeof r === 'string' && /^[\d.]+,[\d.]+,[\d.]+,[\d.]+$/.test(r) ? r : null);

const upsert = (cols, pk, keep = []) => `ON CONFLICT (${pk.join(', ')}) DO UPDATE SET ${cols.filter(c => !pk.includes(c) && !keep.includes(c)).map(c => `${c} = excluded.${c}`).join(', ')}`;

/** The checked rows of one seed body (pure but for the link ids); throws HttpError 400 on the first bad row. */
export async function seedRows(user, body, idx, now = Date.now()) {
  const bad = m => { throw new HttpError(400, m); };
  const sections = (Array.isArray(body.sections) ? body.sections : []).map((s, i) => {
    if (!ID.test(String(s.id || ''))) bad(`Section ${i + 1} needs an id.`);
    if (!['pharm', 'microbes'].includes(s.kind)) bad(`Section ${s.id}: kind is pharm or microbes.`);
    return { user_id: user, id: s.id, kind: s.kind, title: str(s.title, 80) || bad(`Section ${s.id} needs a title.`), short: str(s.short || s.title, 40),
      deck: s.kind === 'pharm' ? 'pharm' : 'pathogens', page: intOr(s.page) ?? bad(`Section ${s.id} needs its page.`), book_page: intOr(s.book_page),
      region: regionText(s.region), category_id: str(s.category_id, 80) || bad(`Section ${s.id} needs its category.`),
      also_json: JSON.stringify(Array.isArray(s.also) ? s.also.map(String).slice(0, 8) : []), sort: intOr(s.sort, i), updated_at: now };
  });
  const items = (Array.isArray(body.items) ? body.items : []).map((t, i) => {
    if (!ID.test(String(t.id || ''))) bad(`Item ${i + 1} needs an id.`);
    if (!['drug', 'class', 'organism'].includes(t.kind)) bad(`Item ${t.id}: kind is drug, class or organism.`);
    const name = str(t.name, 120) || bad(`Item ${t.id} needs a name.`);
    return { user_id: user, id: t.id, kind: t.kind, name, aliases_json: JSON.stringify((t.aliases || []).map(String).slice(0, 20)),
      sections_json: JSON.stringify((t.sections || []).map(String).slice(0, 10)), book_pages_json: JSON.stringify((t.book_pages || []).map(Number).filter(Number.isFinite).slice(0, 20)),
      topic_id: idx ? placeName(idx, name) : null, pin: typeof t.pin === 'string' ? t.pin.slice(0, 40) : Array.isArray(t.pin) ? t.pin.join(',') : null, updated_at: now };
  });
  const links = [];
  const seen = new Set();
  for (const [i, l] of (Array.isArray(body.links) ? body.links : []).entries()) {
    if (!ID.test(String(l.item_id || ''))) bad(`Link ${i + 1} needs its item_id.`);
    if (!RELS.includes(l.rel)) bad(`Link ${i + 1}: rel is one of ${RELS.join(', ')}.`);
    if (l.how != null && !HOWS.includes(l.how)) bad(`Link ${i + 1}: unknown how ${l.how}.`);
    const to = str(l.to_name, 160) || bad(`Link ${i + 1} needs to_name.`);
    const why = str(l.why, 400);
    if (why.length > 200 || WHY_BAD.test(why)) bad(`Link ${i + 1}: why is plain words, at most 200 characters, with no arrows or angle brackets.`);
    const id = await linkId(user, l.item_id, l.rel, to);
    if (l.id && l.id !== id) bad(`Link ${i + 1}: its id should be ${id}.`);
    if (seen.has(id)) bad(`Link ${i + 1} repeats ${l.item_id} ${l.rel} ${to}.`);
    seen.add(id);
    links.push({ user_id: user, id, item_id: l.item_id, rel: l.rel, how: l.how || null, topic_id: idx ? placeName(idx, to) : null, to_name: to, why,
      source_ref: str(l.source_ref, 160) || null, created_by: 'seed', created_at: now, updated_at: now });
  }
  const pages = (Array.isArray(body.pages) ? body.pages : []).map(p => {
    if (!['pharm', 'pathogens'].includes(p.deck)) bad('A page needs its deck (pharm or pathogens).');
    return { user_id: user, deck: p.deck, page: intOr(p.page) ?? bad('A page needs its number.'), book_page: intOr(p.book_page), title: str(p.title, 80) || `Page ${p.page}`,
      md_w: intOr(p.md_w, 1224), md_h: intOr(p.md_h, 1607) };
  });
  return { sections, items, links, pages };
}

export async function seedRoute(request, env, ctx, params, url, user) {
  needOrbits(env);
  const body = await readJson(request, 3_000_000);
  if ((body.links || []).length > 1000) throw new HttpError(400, 'At most 1,000 links per call; send the rest in another.');
  const now = Date.now();
  const idx = await topicIndex(env, user);
  const r = await seedRows(user, body, idx, now);
  const S = ['user_id', 'id', 'kind', 'title', 'short', 'deck', 'page', 'book_page', 'region', 'category_id', 'also_json', 'sort', 'updated_at'];
  const I = ['user_id', 'id', 'kind', 'name', 'aliases_json', 'sections_json', 'book_pages_json', 'topic_id', 'pin', 'updated_at'];
  const L = ['user_id', 'id', 'item_id', 'rel', 'how', 'topic_id', 'to_name', 'why', 'source_ref', 'created_by', 'created_at', 'updated_at'];
  const P = ['user_id', 'deck', 'page', 'book_page', 'title', 'md_w', 'md_h'];
  const linkConflict = `ON CONFLICT (user_id, id) DO UPDATE SET item_id = excluded.item_id, rel = excluded.rel, how = excluded.how,
    topic_id = COALESCE(excluded.topic_id, orbit_links.topic_id), to_name = excluded.to_name, why = excluded.why, source_ref = excluded.source_ref,
    updated_at = CASE WHEN orbit_links.why IS excluded.why AND orbit_links.how IS excluded.how AND orbit_links.source_ref IS excluded.source_ref
      AND orbit_links.topic_id IS COALESCE(excluded.topic_id, orbit_links.topic_id) THEN orbit_links.updated_at ELSE excluded.updated_at END`;
  const st = [
    ...jsonInsert(env.DB, 'orbit_sections', S, r.sections, upsert(S, ['user_id', 'id'], ['updated_at']) + ', updated_at = CASE WHEN orbit_sections.title IS excluded.title AND orbit_sections.category_id IS excluded.category_id AND orbit_sections.region IS excluded.region THEN orbit_sections.updated_at ELSE excluded.updated_at END'),
    ...jsonInsert(env.DB, 'orbit_items', I, r.items, upsert(I, ['user_id', 'id'], ['updated_at', 'topic_id']) + ', topic_id = COALESCE(excluded.topic_id, orbit_items.topic_id)'),
    ...jsonInsert(env.DB, 'orbit_links', L, r.links, linkConflict),
    ...jsonInsert(env.DB, 'atlas_pages', P, r.pages, upsert(P, ['user_id', 'deck', 'page'])),
  ];
  for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
  const placedNow = await replace(env, user, now);
  return json({ ok: true, sections: r.sections.length, items: r.items.length, links: r.links.length, pages: r.pages.length,
    placed: placedNow.placed, unplaced: placedNow.unplaced });
}

export { norm };
