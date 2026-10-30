// "Make it mine" (layer 1 of personalisation; docs/platform/make-it-mine.md). Each person changes how THEIR Study Hub
// looks and what it shows, by asking their own Claude (tools my_hub_get, my_hub_change, my_hub_undo, my_hub_reset) or
// in Settings. Everything is one validated document, the customisation spec (spec 1), stored in their own
// users.prefs_json.custom with the last 10 versions in custom_history for undo. It is data, never code: colours and
// sizes from fixed lists, tiles and tabs by name, custom pages made of typed blocks drawn with textContent. Nobody
// else's hub is touched. Layer 2 (a person's own copy of the app) reads and writes the same spec (export/import).
import { HttpError, json, readJson, safeParse, now } from '../util.js';
import { SKY, SKY_SWATCHES } from '../../../public/js/map/colour.js';
import { writeBatch, summaryOf } from '../map/events.js';
import { LEARNER } from './modules.js';

export const SPEC = 1;
export const HISTORY_MAX = 10;

// What can be chosen. The front end maps each value to CSS custom properties (public/js/platform/custom.js).
export const OPTIONS = {
  theme: {
    accent: ['blue', 'indigo', 'purple', 'pink', 'teal', 'green', 'graphite'],   // never red or orange: Ember is for weakness only
    background: ['default', 'warm', 'cool', 'paper', 'mint', 'lavender'],
    mode: ['auto', 'light', 'dark'],
    text_size: ['small', 'normal', 'large', 'larger'],
    corners: ['round', 'soft', 'square'],
    density: ['comfy', 'compact'],
    font: ['system', 'rounded', 'serif', 'mono'],
    sky: [...SKY_SWATCHES.map(s => s.id), 'custom'],
  },
  sky: { hue: { min: 0, max: 359, default: SKY.hue }, brightness: { min: SKY.min, max: SKY.max, step: 0.05, default: SKY.brightness } },
  map_group: ['subject', 'section', 'custom'],
  tiles: ['setup', 'learn', 'choice', 'subjects', 'galaxies', 'cards', 'weakest', 'results', 'teach', 'library', 'paste', 'days'],
  tabs: ['subjects', 'map', 'cards', 'results', 'library', 'papers', 'exams', 'mnemonics', 'chats', 'how'],
  blocks: ['heading', 'text', 'checklist', 'links', 'topics', 'countdown'],
  icons: ['star', 'flag', 'book', 'flask', 'brain', 'calc', 'pen', 'clock', 'heart', 'bolt'],
};

const LIMITS = { greeting: 60, page_title: 40, pages: 8, blocks: 30, text: 2000, items: 40, item: 160, url: 500, notes: 600 };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = msg => { throw new HttpError(400, msg); };
const str = (v, max, what) => {
  if (v == null) return null;
  if (typeof v !== 'string') bad(`${what} must be text.`);
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (s.length > max) bad(`${what} can be at most ${max} characters.`);
  return s || null;
};
const pick = (v, list, what) => {
  if (v == null) return null;
  if (!list.includes(v)) bad(`${what} must be one of: ${list.join(', ')}.`);
  return v;
};
const onlyKeys = (o, keys, what) => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`${what} has no "${k}". It can have: ${keys.join(', ')}.`);
};
const num = (v, { min, max }, what) => {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(`${what} must be a number from ${min} to ${max}.`);
  return v;
};
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'page';

function safeUrl(u) {
  const s = str(u, LIMITS.url, 'A link');
  if (!s) return null;
  let url;
  try { url = new URL(s); } catch { bad('A link must be a full web address starting with https://.'); }
  if (url.protocol !== 'https:') bad('Links must start with https://.');
  return url.href;
}

function block(b, i) {
  if (!isObj(b)) bad(`Block ${i + 1} must be an object.`);
  const type = pick(b.type, OPTIONS.blocks, `Block ${i + 1}'s type`);
  if (!type) bad(`Block ${i + 1} needs a type: ${OPTIONS.blocks.join(', ')}.`);
  const items = (list, f) => {
    if (!Array.isArray(list) || !list.length) bad(`Block ${i + 1} (${type}) needs a list of items.`);
    if (list.length > LIMITS.items) bad(`Block ${i + 1} can have at most ${LIMITS.items} items.`);
    return list.map(f);
  };
  switch (type) {
    case 'heading': onlyKeys(b, ['type', 'text'], 'A heading'); return { type, text: str(b.text, 80, 'A heading') || bad('A heading needs text.') };
    case 'text': onlyKeys(b, ['type', 'text'], 'A text block'); return { type, text: str(b.text, LIMITS.text, 'A text block') || bad('A text block needs text.') };
    case 'checklist': onlyKeys(b, ['type', 'title', 'items'], 'A checklist');
      return { type, title: str(b.title, 80, 'A checklist title'), items: items(b.items, (it, j) => {
        const o = typeof it === 'string' ? { text: it, done: false } : isObj(it) ? it : bad(`Checklist item ${j + 1} must be text.`);
        return { text: str(o.text, LIMITS.item, 'A checklist item') || bad('A checklist item needs text.'), done: !!o.done };
      }) };
    case 'links': onlyKeys(b, ['type', 'title', 'items'], 'A links block');
      return { type, title: str(b.title, 80, 'A links title'), items: items(b.items, (it, j) => {
        if (!isObj(it)) bad(`Link ${j + 1} needs a label and a url.`);
        return { label: str(it.label, LIMITS.item, 'A link label') || bad('A link needs a label.'), url: safeUrl(it.url) || bad('A link needs a url.') };
      }) };
    case 'topics': onlyKeys(b, ['type', 'title', 'subject_id', 'galaxy', 'show'], 'A topics block');
      // galaxy: one of their own galaxies, by id or title (galaxies.js); it wins over subject_id.
      return { type, title: str(b.title, 80, 'A topics title'), subject_id: str(b.subject_id, 60, 'subject_id'), galaxy: str(b.galaxy, 60, 'galaxy'),
        show: pick(b.show || 'weakest', ['weakest', 'all', 'not_seen'], 'show') };
    case 'countdown': onlyKeys(b, ['type', 'label', 'date'], 'A countdown');
      if (typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || Number.isNaN(Date.parse(b.date))) bad('A countdown needs a date as YYYY-MM-DD.');
      return { type, label: str(b.label, 80, 'A countdown label') || 'Countdown', date: b.date };
    default: return bad('Unknown block.');
  }
}

/** The whole spec, checked and normalised (unknown keys refused with plain words). Missing parts are left out. */
export function validateCustom(c) {
  if (c == null) return { spec: SPEC };
  if (!isObj(c)) bad('Customisations must be an object.');
  onlyKeys(c, ['spec', 'theme', 'today', 'nav', 'pages', 'teach', 'map', 'anki'], 'Customisations');
  if (c.spec != null && c.spec !== SPEC) bad(`This hub reads customisation spec ${SPEC}.`);
  const out = { spec: SPEC };
  if (c.theme != null) {
    if (!isObj(c.theme)) bad('theme must be an object.');
    onlyKeys(c.theme, [...Object.keys(OPTIONS.theme), 'sky_hue', 'sky_brightness'], 'theme');
    const t = {};
    for (const [k, list] of Object.entries(OPTIONS.theme)) { const v = pick(c.theme[k], list, `theme.${k}`); if (v) t[k] = v; }
    // A hue alone means a custom sky; with a swatch chosen the hue is dropped. Brightness in steps of 0.05.
    const hue = num(c.theme.sky_hue, OPTIONS.sky.hue, 'theme.sky_hue');
    if (hue != null && !t.sky) t.sky = 'custom';
    if (hue != null && t.sky === 'custom') t.sky_hue = Math.round(hue) % 360;
    const b = num(c.theme.sky_brightness, OPTIONS.sky.brightness, 'theme.sky_brightness');
    if (b != null) t.sky_brightness = Math.round(b * 20) / 20;
    if (Object.keys(t).length) out.theme = t;
  }
  if (c.today != null) {
    if (!isObj(c.today)) bad('today must be an object.');
    onlyKeys(c.today, ['order', 'hidden', 'greeting'], 'today');
    const t = {};
    const tiles = (list, what) => {
      if (!Array.isArray(list)) bad(`today.${what} must be a list of tile names.`);
      return [...new Set(list.map(x => pick(x, OPTIONS.tiles, `A tile in today.${what}`)))];
    };
    if (c.today.order != null) t.order = tiles(c.today.order, 'order');
    if (c.today.hidden != null) t.hidden = tiles(c.today.hidden, 'hidden');
    const g = str(c.today.greeting, LIMITS.greeting, 'The greeting');
    if (g) t.greeting = g;
    if (Object.keys(t).length) out.today = t;
  }
  if (c.nav != null) {
    if (!isObj(c.nav)) bad('nav must be an object.');
    onlyKeys(c.nav, ['hidden'], 'nav');
    if (c.nav.hidden != null) {
      if (!Array.isArray(c.nav.hidden)) bad('nav.hidden must be a list of tab names.');
      out.nav = { hidden: [...new Set(c.nav.hidden.map(x => pick(x === 'help' ? 'how' : x, OPTIONS.tabs, 'A tab in nav.hidden')))] };   // help was renamed how
    }
  }
  if (c.pages != null) {
    if (!Array.isArray(c.pages)) bad('pages must be a list.');
    if (c.pages.length > LIMITS.pages) bad(`At most ${LIMITS.pages} pages of your own.`);
    const ids = new Set();
    out.pages = c.pages.map((p, i) => {
      if (!isObj(p)) bad(`Page ${i + 1} must be an object.`);
      onlyKeys(p, ['id', 'title', 'icon', 'blocks'], `Page ${i + 1}`);
      const title = str(p.title, LIMITS.page_title, 'A page title') || bad(`Page ${i + 1} needs a title.`);
      let id = slug(p.id || title);
      while (ids.has(id)) id = `${id}-2`;
      ids.add(id);
      const blocks = Array.isArray(p.blocks) ? p.blocks : bad(`Page "${title}" needs a list of blocks.`);
      if (blocks.length > LIMITS.blocks) bad(`A page can have at most ${LIMITS.blocks} blocks.`);
      return { id, title, icon: pick(p.icon || 'star', OPTIONS.icons, 'A page icon'), blocks: blocks.map(block) };
    });
  }
  if (c.map != null) {
    // How their map is laid out: each subject a galaxy (subject), each section its own cluster (section), or
    // clusters they name with the topics in each (custom: topics not listed stay in their subject). order puts
    // clusters or subjects first, by title or id.
    if (!isObj(c.map)) bad('map must be an object.');
    onlyKeys(c.map, ['group_by', 'clusters', 'order'], 'map');
    const m = {};
    const g = pick(c.map.group_by, OPTIONS.map_group, 'map.group_by');
    if (g) m.group_by = g;
    if (c.map.clusters != null) {
      if (!Array.isArray(c.map.clusters)) bad('map.clusters must be a list of {title, topics}.');
      if (c.map.clusters.length > 20) bad('At most 20 clusters.');
      const titles = new Set();
      m.clusters = c.map.clusters.map((cl, i) => {
        if (!isObj(cl)) bad(`Cluster ${i + 1} needs a title and a list of topics.`);
        onlyKeys(cl, ['title', 'topics'], `Cluster ${i + 1}`);
        const title = str(cl.title, 40, 'A cluster title') || bad(`Cluster ${i + 1} needs a title.`);
        if (titles.has(title.toLowerCase())) bad(`Two clusters are called ${title}.`);
        titles.add(title.toLowerCase());
        if (!Array.isArray(cl.topics) || !cl.topics.length) bad(`Cluster ${title} needs a list of topics (names or ids).`);
        if (cl.topics.length > 250) bad(`Cluster ${title} can have at most 250 topics.`);
        return { title, topics: [...new Set(cl.topics.map(x => str(x, 200, 'A topic') || bad(`Cluster ${title} has an empty topic.`)))] };
      });
      if (m.clusters.length && !m.group_by) m.group_by = 'custom';
    }
    if (c.map.order != null) {
      if (!Array.isArray(c.map.order) || c.map.order.length > 40) bad('map.order must be a list of up to 40 cluster titles or subject names.');
      m.order = c.map.order.map(x => str(x, 80, 'An order entry')).filter(Boolean);
    }
    if (m.group_by === 'custom' && !(m.clusters || []).length) bad('Custom clusters need map.clusters: [{title, topics}].');
    if (Object.keys(m).length) out.map = m;
  }
  if (c.anki != null) {
    // Which of their Anki decks or tags belong to which topic (cards.js ankiTopicOf reads these first).
    if (!isObj(c.anki)) bad('anki must be an object.');
    onlyKeys(c.anki, ['rules'], 'anki');
    if (c.anki.rules != null) {
      if (!Array.isArray(c.anki.rules) || c.anki.rules.length > 200) bad('anki.rules must be a list of up to 200 {match: deck|tag, value, topic}.');
      out.anki = { rules: c.anki.rules.map((r, i) => {
        if (!isObj(r)) bad(`Anki rule ${i + 1} needs match, value and topic.`);
        onlyKeys(r, ['match', 'value', 'topic'], `Anki rule ${i + 1}`);
        return { match: pick(r.match, ['deck', 'tag'], 'An Anki rule\'s match') || bad('An Anki rule needs match: deck or tag.'),
          value: str(r.value, 200, 'An Anki deck or tag') || bad('An Anki rule needs the deck or tag.'), topic: str(r.topic, 200, 'An Anki rule\'s topic') || bad('An Anki rule needs the topic (name or id).') };
      }) };
    }
  }
  if (c.teach != null) {
    if (!isObj(c.teach)) bad('teach must be an object.');
    onlyKeys(c.teach, ['notes'], 'teach');
    const n = str(c.teach.notes, LIMITS.notes, 'Teaching notes');
    if (n) out.teach = { notes: n };
  }
  return out;
}

// A patch onto the current spec: objects merge, lists and values replace, null removes. Then the whole is validated.
export function applyPatch(cur, patch) {
  if (!isObj(patch)) bad('A change must be an object, like {"theme": {"accent": "purple"}}.');
  const merge = (a, b) => {
    const out = isObj(a) ? { ...a } : {};
    for (const [k, v] of Object.entries(b)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (v === null) delete out[k];
      else out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
    }
    return out;
  };
  return validateCustom(merge(cur, patch));
}

// Plain words for what changed, for the toast and for Claude's reply.
export function describe(prev, next) {
  const lines = [];
  const pt = prev.theme || {}, nt = next.theme || {};
  for (const k of Object.keys(OPTIONS.theme)) if (pt[k] !== nt[k]) lines.push(`${k === 'sky' ? 'map sky' : k.replace('_', ' ')}: ${nt[k] || 'default'}`);
  if (pt.sky_hue !== nt.sky_hue && nt.sky_hue != null) lines.push(`sky hue: ${nt.sky_hue}`);
  if (pt.sky_brightness !== nt.sky_brightness) lines.push(`sky brightness: ${Math.round(100 * (nt.sky_brightness ?? SKY.brightness))}%`);
  const j = v => JSON.stringify(v || null);
  if (j((prev.today || {}).order) !== j((next.today || {}).order)) lines.push('Today: tiles reordered');
  if (j((prev.today || {}).hidden) !== j((next.today || {}).hidden)) lines.push(`Today: hidden ${((next.today || {}).hidden || []).join(', ') || 'nothing'}`);
  if ((prev.today || {}).greeting !== (next.today || {}).greeting) lines.push('greeting changed');
  if (j((prev.nav || {}).hidden) !== j((next.nav || {}).hidden)) lines.push(`tabs hidden: ${((next.nav || {}).hidden || []).join(', ') || 'none'}`);
  const pp = (prev.pages || []).map(p => p.title), np = (next.pages || []).map(p => p.title);
  for (const t of np) if (!pp.includes(t)) lines.push(`new page: ${t}`);
  for (const t of pp) if (!np.includes(t)) lines.push(`removed page: ${t}`);
  if (j(prev.pages) !== j(next.pages) && !lines.some(l => /page/.test(l))) lines.push('pages edited');
  if (j(prev.teach) !== j(next.teach)) lines.push('teaching notes updated');
  if (j(prev.anki) !== j(next.anki)) lines.push(`Anki rules: ${((next.anki || {}).rules || []).length}`);
  if (j(prev.map) !== j(next.map)) lines.push(`map layout: ${(next.map && next.map.group_by) || 'section'}${next.map && next.map.clusters ? ` (${next.map.clusters.map(x => x.title).join(', ')})` : ''}`);
  return lines.length ? lines.join('; ') : 'no change';
}

// ------------------------------------------------------------------ storage (the person's own users row only)

async function readRow(env, user) {
  const row = await env.DB.prepare('SELECT prefs_json FROM users WHERE id = ?').bind(user).first();
  const prefs = safeParse(row && row.prefs_json, {});
  const cur = isObj(prefs) && isObj(prefs.custom) ? prefs.custom : { spec: SPEC };
  const hist = isObj(prefs) && Array.isArray(prefs.custom_history) ? prefs.custom_history : [];
  return { cur, hist };
}

export async function getCustom(env, user) {
  return (await readRow(env, user)).cur;
}

// A changed map layout clears the person's saved positions, so their map arranges itself once more in the new shape.
// One look change, with an event so it shows in Recent changes (not undoable there: Make it mine has its own Undo).
async function write(env, user, next, hist, prev, said, actor) {
  const base = `CASE WHEN json_valid(prefs_json) AND json_type(prefs_json) = 'object' THEN prefs_json ELSE '{}' END`;
  const stmts = [env.DB.prepare(`UPDATE users SET prefs_json = json_set(json_set(${base}, '$.custom', json(?)), '$.custom_history', json(?)), updated_at = ? WHERE id = ?`)
    .bind(JSON.stringify(next), JSON.stringify(hist.slice(-HISTORY_MAX)), now(), user)];
  if (prev && JSON.stringify(prev.map || null) !== JSON.stringify(next.map || null)) {
    stmts.push(env.DB.prepare('DELETE FROM topic_positions WHERE user_id = ? AND pinned = 0').bind(user));
  }
  await writeBatch(env, user, { actor, surface: actor === 'claude' ? 'chat' : 'web', via: 'platform:custom', undoable: false, statements: stmts,
    events: [{ kind: 'pref.changed', target_type: 'pref', target_id: 'custom', summary: summaryOf(said.charAt(0).toUpperCase() + said.slice(1)) }] });
}

export async function setCustom(env, user, next, actor = LEARNER) {
  const { cur, hist } = await readRow(env, user);
  const clean = validateCustom(next);
  const said = describe(cur, clean);
  if (said !== 'no change') await write(env, user, clean, [...hist, cur], cur, said, actor);
  return { custom: clean, changed: said, undo_left: Math.min(HISTORY_MAX, hist.length + (said !== 'no change' ? 1 : 0)) };
}

export async function patchCustom(env, user, patch, actor = LEARNER) {
  const { cur } = await readRow(env, user);
  return setCustom(env, user, applyPatch(cur, patch), actor);
}

export async function undoCustom(env, user, actor = LEARNER) {
  const { cur, hist } = await readRow(env, user);
  if (!hist.length) throw new HttpError(409, 'There is nothing to undo.');
  const prev = validateCustom(hist[hist.length - 1]);
  await write(env, user, prev, hist.slice(0, -1), cur, `undone (${describe(cur, prev)})`, actor);
  return { custom: prev, changed: `undone (${describe(cur, prev)})`, undo_left: hist.length - 1 };
}

export const resetCustom = (env, user, actor = LEARNER) => setCustom(env, user, { spec: SPEC }, actor);

// ------------------------------------------------------------------ routes and tools

export const ROUTES = [
  ['GET', '/api/p/custom', async (request, env, ctx, params, url, user) => {
    const { cur, hist } = await readRow(env, user);
    return json({ custom: cur, spec: SPEC, options: OPTIONS, undo_left: hist.length });
  }],
  ['PUT', '/api/p/custom', async (request, env, ctx, params, url, user) => json(await setCustom(env, user, (await readJson(request, 100_000)).custom))],
  ['PATCH', '/api/p/custom', async (request, env, ctx, params, url, user) => json(await patchCustom(env, user, (await readJson(request, 100_000)).patch))],
  ['POST', '/api/p/custom/undo', async (request, env, ctx, params, url, user) => json(await undoCustom(env, user))],
  ['POST', '/api/p/custom/reset', async (request, env, ctx, params, url, user) => json(await resetCustom(env, user))],
  ['GET', '/api/p/custom/export', async (request, env, ctx, params, url, user) => new Response(JSON.stringify({ kind: 'study-hub-custom', spec: SPEC, custom: await getCustom(env, user) }, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="my-study-hub.json"', 'Cache-Control': 'no-store' },
  })],
  ['POST', '/api/p/custom/import', async (request, env, ctx, params, url, user) => {
    const body = await readJson(request, 100_000);
    if (body.kind !== 'study-hub-custom') throw new HttpError(400, 'That is not a Study Hub customisation file.');
    return json(await setCustom(env, user, body.custom));
  }],
];

const SPEC_HELP = 'Spec: theme {accent, background, mode, text_size, corners, density, font, sky (the map\'s night sky), sky_hue (0 to 359, with sky "custom"), sky_brightness (0.6 darker to 1.4 lighter)} (values from options); today {order: [tiles], hidden: [tiles], greeting}; '
  + 'nav {hidden: [tabs]}; map {group_by: section|subject} (the topics not in a galaxy of theirs: each section its own galaxy under its subject, the default, or one galaxy a subject); pages [{title, icon, blocks: [{type: heading|text|checklist|links|topics|countdown, ...}]}]; teach {notes: how they like to be taught}; anki {rules: [{match: deck|tag, value: "A-level::Biology::Enzymes", topic: "Enzymes"}]} (which Anki decks or tags are which topic). '
  + 'A patch merges objects, replaces lists and values, and null removes.';

export const TOOLS = [
  {
    name: 'my_hub_get', module: 'map',
    description: "Shows how the person has customised THEIR OWN Study Hub (look, Today tiles, hidden tabs, their own pages, teaching notes) and every option they can choose. Call before my_hub_change.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: async (env, user) => { const { cur, hist } = await readRow(env, user); return { custom: cur, options: OPTIONS, undo_left: hist.length, how: SPEC_HELP }; },
  },
  {
    name: 'my_hub_change', module: 'map',
    description: `Changes how THEIR OWN Study Hub looks or what it shows, when they ask ("make it purple", "a warmer, darker map sky", "hide Results", "put cards first on Today", "add a page with my required practicals checklist", "teach me with more diagrams", "lay my map out by section", "my Anki deck Biology::Cell cycle is Mitosis"). Only their hub changes; they can undo. Their own galaxies: galaxy_edit. ${SPEC_HELP} Reply with the plain-words summary it returns.`,
    inputSchema: { type: 'object', properties: { patch: { type: 'object', description: 'The change, in the customisation spec' } }, required: ['patch'], additionalProperties: false },
    run: (env, user, args) => patchCustom(env, user, args.patch, 'claude'),
  },
  {
    name: 'my_hub_undo', module: 'map',
    description: 'Undoes their last Study Hub customisation (up to 10 steps back).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (env, user) => undoCustom(env, user, 'claude'),
  },
  {
    name: 'my_hub_reset', module: 'map',
    description: 'Puts their Study Hub back to how it started (their study data is untouched). Ask them to confirm first.',
    inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'], additionalProperties: false },
    run: (env, user, args) => { if (args.confirm !== true) throw new HttpError(400, 'Ask them to confirm, then call again with confirm: true.'); return resetCustom(env, user, 'claude'); },
  },
];
