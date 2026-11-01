import { norm } from '../../../public/js/shared/names.js';

export const NEAR_MAX = 40;
// A crisis, flare or exacerbation of a disease (step 3): the disease's own topic unless the crisis is one.
export const PHASE_WORDS = ['crisis', 'storm', 'exacerbation', 'flare', 'attack', 'relapse', 'emergency', 'complication'];
// The words after a disease's own name that still name that disease ("Myasthenia gravis", "Sickle cell disease").
const TAIL_WORDS = ['disease', 'syndrome', 'disorder', 'gravis', 'mellitus', 'infection'];
// At most this many names a call goes through steps 2 and 3 (each a few D1 reads); the rest keep their names.
export const NAME_MAX = 24;

const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const uniq = list => [...new Set(list)];
const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------- 1: the drug, not its class

export const DRUG_CLASSES = [
  [/^tetracycline$/, /\b[a-z]*cycline\b/g],
  [/^(?:beta blocker|beta adrenergic blocker|b blocker)$/, /\b[a-z]+olol\b/g],
  [/^(?:ace inhibitor|angiotensin converting enzyme inhibitor)$/, /\b[a-z]+pril\b/g],
  [/^(?:arb|angiotensin receptor blocker|angiotensin ii receptor blocker)$/, /\b[a-z]+sartan\b/g],
  [/^(?:statin|hmg coa reductase inhibitor)$/, /\b[a-z]+statin\b/g],
  [/^(?:fluoroquinolone|quinolone)$/, /\b[a-z]+floxacin\b/g],
  [/^macrolide$/, /\b(?:[a-z]+thromycin|erythromycin)\b/g],
  [/^benzodiazepine$/, /\b[a-z]+(?:azepam|azolam|azepate|azepoxide)\b/g],
  [/^(?:proton pump inhibitor|ppi)$/, /\b[a-z]+prazole\b/g],
  [/^bisphosphonate$/, /\b[a-z]+dronate\b/g],
  [/^sulfonylurea$/, /\b(?:glipizide|glyburide|glimepiride|gliclazide|glibenclamide)\b/g],
  [/^(?:thiazide|thiazide diuretic)$/, /\b(?:[a-z]*thiazide|chlorthalidone|indapamide|metolazone)\b/g],
  [/^(?:loop diuretic)$/, /\b(?:furosemide|bumetanide|torsemide)\b/g],
  [/^cephalosporin$/, /\b(?:cef|ceph)[a-z]+\b/g],
  [/^penicillin$/, /\b[a-z]+cillin\b/g],
  [/^aminoglycoside$/, /\b(?:gentamicin|tobramycin|amikacin|streptomycin|neomycin)\b/g],
  [/^(?:doac|direct oral anticoagulant|factor xa inhibitor)$/, /\b(?:[a-z]+xaban|dabigatran)\b/g],
  [/^triptan$/, /\b[a-z]+triptan\b/g],
  [/^(?:sglt2 inhibitor|sglt 2 inhibitor)$/, /\b[a-z]+gliflozin\b/g],
  [/^(?:dpp4 inhibitor|dpp 4 inhibitor|gliptin)$/, /\b[a-z]+gliptin\b/g],
  [/^(?:thiazolidinedione|glitazone)$/, /\b[a-z]+glitazone\b/g],
  [/^(?:ssri|selective serotonin reuptake inhibitor)$/, /\b(?:fluoxetine|sertraline|citalopram|escitalopram|paroxetine|fluvoxamine)\b/g],
  [/^(?:snri|serotonin norepinephrine reuptake inhibitor)$/, /\b(?:venlafaxine|duloxetine|desvenlafaxine|milnacipran)\b/g],
  [/^(?:tca|tricyclic antidepressant)$/, /\b(?:amitriptyline|nortriptyline|imipramine|clomipramine|desipramine|doxepin)\b/g],
  [/^(?:corticosteroid|glucocorticoid|steroid)$/, /\b(?:prednisone|prednisolone|methylprednisolone|hydrocortisone|dexamethasone)\b/g],
  [/^(?:calcium channel blocker|ccb)$/, /\b(?:[a-z]+dipine|verapamil|diltiazem)\b/g],
  [/^(?:azole|azole antifungal)$/, /\b[a-z]+conazole\b/g],
];

export function memberOf(name, ...texts) {
  const key = norm(name);
  const cls = DRUG_CLASSES.find(([c]) => c.test(key));
  if (!cls) return null;
  for (const t of texts) {
    const words = norm(t);
    if (!words) continue;
    const found = uniq((words.match(cls[1]) || []).filter(w => w.length >= 6));
    if (` ${words} `.includes(` ${key} `) || found.includes(key)) return null;
    if (found.length === 1) return cap(found[0]);
    if (found.length > 1) return null;
  }
  return null;
}

// ---------------------------------------------------------------- 3: a close relative

// A word's stem for matching relatives: "myasthenic" and "myasthenia" are one ("myasthen"). Short stems never match.
const stem = w => String(w || '').replace(/(?:ical|ics|ic|ia|al|ous|es|s)$/, '');
const sameStem = (a, b) => a === b || (stem(a).length >= 5 && stem(a) === stem(b));
const wordsOf = s => String(s || '').split(' ').filter(Boolean);

/**
 * A close relative of a name not on the map (pure): rows are alias rows [{id, name, key}] (key: an alias key, norm'd).
 *   a) the only topic with a key holding every word of the name, by stem ("COPD exacerbation": Acute exacerbation of COPD)
 *   b) for a crisis, flare or exacerbation (PHASE_WORDS last): the only topic whose key starts with the disease's words
 *      and goes on with at most one tail word ("Myasthenic crisis": Myasthenia gravis; never Lambert-Eaton myasthenic syndrome)
 * Returns {id, name, via: 'relative' | 'parent'} or null (none, or more than one topic fits).
 */
export function relativeOf(name, rows) {
  const w = wordsOf(norm(name));
  if (!w.length || !Array.isArray(rows) || !rows.length) return null;
  const one = (hits, via) => { const ids = uniq(hits.map(r => r.id)); return ids.length === 1 ? { id: ids[0], name: hits[0].name, via } : null; };
  if (w.length >= 2) {
    const all = rows.filter(r => { const k = wordsOf(r.key); return k.length > w.length && w.every(x => k.some(y => sameStem(x, y))); });
    const a = one(all, 'relative');
    if (a) return a;
  }
  if (w.length >= 2 && PHASE_WORDS.includes(w[w.length - 1])) {
    const base = w.slice(0, -1);
    const par = rows.filter(r => {
      const k = wordsOf(r.key);
      return k.length >= base.length && k.length <= base.length + 1 && base.every((b, i) => sameStem(b, k[i])) && k.slice(base.length).every(x => TAIL_WORDS.includes(x));
    });
    return one(par, 'parent');
  }
  return null;
}

// The stems a name's relatives are looked up by (its words of five letters or more, at most three).
export const relativeStems = name => uniq(wordsOf(norm(name)).filter(x => !PHASE_WORDS.includes(x) && !TAIL_WORDS.includes(x)).map(stem).filter(s => s.length >= 5)).slice(0, 3);

// ---------------------------------------------------------------- in memory (the golden eval)

export function nameOnMap(raw, { topics = [], words = '', quote = '' } = {}) {
  const named = String(raw || '').trim();
  if (!named) return { name: named, topic: null, via: null, named };
  const member = memberOf(named, quote, words);
  const name = member || named;
  const list = (topics || []).map(t => (typeof t === 'string' ? { name: t, aliases: [] } : { name: t.name, aliases: t.aliases || [] })).filter(t => t.name);
  const rows = list.flatMap(t => [t.name, ...t.aliases].map(a => ({ id: t.name, name: t.name, key: norm(a) })));
  const key = norm(name);
  const exact = rows.find(r => r.key === key);
  if (exact) return { name: exact.name, topic: exact.name, via: member ? 'drug' : 'exact', named };
  const inside = rows.filter(r => r.key && wordsOf(r.key).length >= 2 && ` ${key} `.includes(` ${r.key} `)).sort((a, b) => b.key.length - a.key.length);
  if (inside.length && uniq(inside.filter(r => r.key.length === inside[0].key.length).map(r => r.id)).length === 1) return { name: inside[0].name, topic: inside[0].name, via: 'span', named };
  const rel = relativeOf(name, rows);
  if (rel) return { name: rel.name, topic: rel.name, via: rel.via, named };
  return { name, topic: null, via: member ? 'drug' : null, named };
}

// ---------------------------------------------------------------- the database

// Alias rows whose words start with one of the stems, for relativeOf (one read for every name of a call).
async function relativeRows(env, user, stems) {
  if (!stems.length) return [];
  const like = stems.map((s, i) => `' ' || a.alias_key LIKE ?${i + 2}`).join(' OR ');
  try {
    return (await env.DB.prepare(`SELECT DISTINCT t.id, t.name, a.alias_key AS key FROM topic_aliases a JOIN topics t ON t.user_id = a.user_id AND t.id = a.topic_id
        WHERE a.user_id = ?1 AND a.status = 'active' AND t.status IN ('proposed','confirmed') AND (${like}) LIMIT 200`)
      .bind(user, ...stems.map(s => `% ${s}%`)).all()).results || [];
  } catch (e) { if (noTable(e)) return []; throw e; }
}

export async function namesToMap(env, user, items, { words = '' } = {}) {
  const list = (items || []).map(it => (typeof it === 'string' ? { name: it } : it || {}));
  const out = list.map(it => {
    const named = String(it.name || '').trim();
    const member = named ? memberOf(named, it.quote || '', words) : null;
    return { name: member || named, topic_id: null, via: member ? 'drug' : null, named };
  });
  if (!env || !env.DB) return out;
  try {
    const { resolveTopic, ACCEPT } = await import('./resolve.js');
    const memo = new Map();
    const todo = out.filter(o => o.name).slice(0, NAME_MAX);
    for (const o of todo) {
      const k = norm(o.name);
      if (!memo.has(k)) memo.set(k, await resolveTopic(env, user, { texts: [o.name] }).catch(e => { if (noTable(e)) return null; throw e; }));
      const r = memo.get(k);
      if (r && r.topic_id && (r.confidence ?? 0) >= ACCEPT) Object.assign(o, { topic_id: r.topic_id, name: r.name || o.name, via: o.via === 'drug' ? 'drug' : r.via || 'alias' });
    }
    const left = todo.filter(o => !o.topic_id);
    const rows = await relativeRows(env, user, uniq(left.flatMap(o => relativeStems(o.name))).slice(0, 8));
    for (const o of left) {
      const rel = relativeOf(o.name, rows);
      if (rel) Object.assign(o, { topic_id: rel.id, name: rel.name, via: rel.via });
    }
  } catch (e) { console.error('naming to the map failed', e && e.message); }
  return out;
}

/**
 * A form's named items with their names on the map (namesToMap): list [{topic, quote}] (field and quoteKey name the
 * keys); own: the question's own topics, an item that lands on one of them is left out (its gap is the question's own);
 * the same name twice is kept once. Returns a new list.
 */
export async function nameItems(env, user, list, { words = '', field = 'topic', quoteKey = 'quote', own = [] } = {}) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return items;
  const named = await namesToMap(env, user, items.map(x => ({ name: x && x[field], quote: x && x[quoteKey] })), { words });
  const mine = new Set((own || []).filter(Boolean).map(norm));
  const seen = new Set();
  const out = [];
  items.forEach((x, i) => {
    const name = named[i] && named[i].name ? named[i].name : x[field];
    const k = `${x.kind || ''}|${norm(name)}`;
    if (!name || mine.has(norm(name)) || seen.has(k)) return;
    seen.add(k);
    out.push({ ...x, [field]: name });
  });
  return out;
}

/** The answer forms' other conditions ({topic, kind, quote}) on the map: nameItems with its defaults. */
export const nameOthers = (env, user, list, opts = {}) => nameItems(env, user, list, opts);

// ---------------------------------------------------------------- the names list in the markers' prompts

/**
 * Up to NEAR_MAX map names near the questions' topics (texts: their labels and conditions; ids: topic ids known already,
 * a card's topics): the topics themselves, their look-alikes and links (the most mixed-up and strongest first), and
 * their parents and children. Three or four reads. [] when none of them is on the map.
 */
export async function nearNames(env, user, texts, { ids: known = [], limit = NEAR_MAX } = {}) {
  const keys = uniq((texts || []).filter(t => typeof t === 'string' && t.trim()).map(norm).filter(Boolean)).slice(0, 60);
  if ((!keys.length && !(known || []).length) || !env || !env.DB) return [];
  try {
    const own = [];
    if (keys.length) {
      const { fetchAliases } = await import('./resolve.js');
      const { byKey } = await fetchAliases(env, user, keys);
      for (const k of keys) for (const h of byKey.get(k) || []) if (!own.some(o => o.id === h.id)) own.push({ id: h.id, name: h.name });
    }
    const extra = uniq((known || []).map(String)).filter(id => !own.some(o => o.id === id)).slice(0, 40);
    if (extra.length) {
      for (const r of (await env.DB.prepare(`SELECT id, name FROM topics WHERE user_id = ?1 AND status IN ('proposed','confirmed') AND id IN (SELECT value FROM json_each(?2))`)
        .bind(user, JSON.stringify(extra)).all()).results || []) own.push({ id: r.id, name: r.name });
    }
    if (!own.length) return [];
    const ids = JSON.stringify(own.map(o => o.id));
    const [links, family] = await env.DB.batch([
      env.DB.prepare(`SELECT CASE WHEN l.from_id IN (SELECT value FROM json_each(?2)) THEN l.to_id ELSE l.from_id END AS id, max(l.confusion + l.strength) AS score
        FROM links l WHERE l.user_id = ?1 AND l.status IN ('active','proposed')
          AND (l.from_id IN (SELECT value FROM json_each(?2)) OR l.to_id IN (SELECT value FROM json_each(?2))) GROUP BY 1 ORDER BY score DESC LIMIT 120`).bind(user, ids),
      env.DB.prepare(`SELECT t.id, t.name FROM topics t WHERE t.user_id = ?1 AND t.status IN ('proposed','confirmed')
          AND (t.parent_id IN (SELECT value FROM json_each(?2)) OR t.id IN (SELECT parent_id FROM topics WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2)))) LIMIT 60`).bind(user, ids),
    ]);
    const linked = (links.results || []).map(r => r.id).filter(id => !own.some(o => o.id === id));
    const names = new Map(linked.length ? ((await env.DB.prepare(`SELECT id, name FROM topics WHERE user_id = ?1 AND status IN ('proposed','confirmed') AND id IN (SELECT value FROM json_each(?2))`)
      .bind(user, JSON.stringify(linked)).all()).results || []).map(r => [r.id, r.name]) : []);
    return uniq([...own.map(o => o.name), ...linked.map(id => names.get(id)).filter(Boolean), ...(family.results || []).map(r => r.name)]).slice(0, limit);
  } catch (e) {
    if (noTable(e)) return [];
    console.error('map names for the prompt failed', e && e.message);
    return [];
  }
}

/** The names list as a prompt part (pure): '' when there are none. It follows the form's rules, so the rules stay cached. */
export function namesPrompt(names) {
  const list = uniq((names || []).filter(n => typeof n === 'string' && n.trim()).map(n => n.trim())).slice(0, NEAR_MAX);
  if (!list.length) return '';
  return `## His map's names near these questions
These topics are already on his map: the questions' own topics, their look-alikes and links. When a condition, drug or topic you name (other conditions, gaps, mixed-with, a card's topic) is the same thing as one of these, use this exact name. Otherwise name it as an AMBOSS article names it, by the naming rule.
${list.join('; ')}`;
}

/** A form's system prompt with the names list after its rules (pure): the rules alone when there are no names. */
export const withNames = (system, names) => { const p = namesPrompt(names); return p ? [...(Array.isArray(system) ? system : [system]), p] : system; };
