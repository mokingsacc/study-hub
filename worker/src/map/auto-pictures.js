import { londonDay } from '../util.js';
import { ankiCall, AnkiError } from '../anki.js';
import { applyChange } from './change.js';
import { noteJob } from '../job-log.js';
import { catalogueEntries, AUTO_SOURCES } from './pictures.js';
import { cardSubject } from './sources.js';
import { norm, namedIn } from '../../../public/js/shared/names.js';

export const AUTO = {
  per_run: 3,                 // topics a minute: each is 1-2 Anki calls and at most one short Claude call
  new_ms: 14 * 86_400_000,    // a topic made in the last fortnight counts as new (first in line, seen or not)
  retry_ms: 3_600_000,        // a topic whose look failed is tried again after an hour
  max_tries: 3,
  unclear_max: 2,             // unclear pictures a library sent to the Claude check
  reserve_usd: 0.05,          // held against the daily cap for one check (a check costs about a cent)
  catalogue_ms: 86_400_000,
};
const NAME_KINDS = ['name', 'abbrev', 'british', 'synonym', 'amboss_title', 'nbme_term', 'merge', 'tally_condition'];
const REF = /^[a-z0-9_]{3,60}$/;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));
const cut = (s, n) => { const t = String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t; };
const capped = e => Number(e && e.status) === 429;

// ---------------------------------------------------------------- relevance (pure, tested)

/** The topic's names for namedIn: its name, its short name (as an abbreviation) and its name-like aliases. */
export function topicNameList(topic, aliases = []) {
  const out = [topic.name];
  if (topic.short_name) out.push({ alias: topic.short_name, kind: 'abbrev' });
  for (const a of aliases) if (a && a.alias && NAME_KINDS.includes(a.kind)) out.push({ alias: a.alias, kind: a.kind });
  return out;
}

// "CXR of", "Brain MRI of", "Causes of": the lead before a caption's subject.
const LEAD = /^(?:\S+ ){0,3}?(?:of|showing) /;
/**
 * The whole parts of a caption's subject, as norm keys: its head (before the first full stop, colon, semicolon or
 * dash; brackets left out), split at vs, and, commas and slashes, each also without a lead ("CXR of", "Causes of").
 * What follows the head is a list or a note ("Causes of portal hypertension: cirrhosis, ..."), never a whole part.
 */
export function captionParts(caption) {
  const bare = String(caption || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  const head = bare.split(/\s*[.:;](?:\s|$)|\s*[:;]\s*|\s+[-–—]\s+/)[0] || '';
  const out = new Set();
  for (const part of [head, ...head.split(/\s+(?:vs\.?|versus|and|&)\s+|\s*[,/]\s*/i)]) {
    const k = norm(part);
    if (!k) continue;
    out.add(k);
    const led = k.replace(LEAD, '');
    if (led && led !== k) out.add(led);
  }
  return out;
}

/**
 * How strongly a caption names the topic: 'clear' | 'unclear' | 'no'. names: topicNameList(). A name must be in the
 * caption as whole words first (namedIn: "sclerosis" is not in "atherosclerosis", short ones only in capitals).
 */
export function captionMatch(caption, names) {
  const text = String(caption || '');
  if (!namedIn(text, names)) return 'no';
  const parts = captionParts(text);
  const bare = ` ${norm(text.replace(/\([^)]*\)|\[[^\]]*\]/g, ' '))} `;
  for (const n of names) {
    const k = norm(typeof n === 'string' ? n : n.alias);
    if (!k || k.length < 2) continue;
    if (parts.has(k)) return 'clear';
    if (k.includes(' ') && bare.includes(` ${k} `)) return 'clear';
  }
  return 'unclear';
}

/** A card as a candidate: clear when it is the card's subject, unclear when its text only names the topic. */
export function cardMatch(card, topic, names) {
  const answer = card.answer || card.fact || '';
  if (card.linked) return 'clear';
  if (card.fact && !card.answer) {
    const m = captionMatch(card.fact, names);
    return m !== 'no' ? m : namedIn(`${card.question || ''}\n${card.extra || ''}`, names) ? 'unclear' : 'no';
  }
  if (cardSubject({ question: card.question || '', answer }, topic, names)) return 'clear';
  return namedIn(`${card.question || ''}\n${answer}\n${card.extra || ''}`, names) ? 'unclear' : 'no';
}

const isAnking = deck => /anking/i.test(String(deck || ''));

export function candidatesFor(topic, names, { catalogue = [], nbme = [], cards = [] } = {}) {
  const out = { anking: [], nbme_hy: [], anki: [] };
  for (const e of catalogue) {
    const match = captionMatch(e.title, names);
    if (match !== 'no') out.anking.push({ source: 'anking', ref: e.ref, title: e.title, match });
  }
  for (const p of nbme) {
    const ref = String((p && p.library) || '').replace(/\.webp$/i, '');
    if (!ref.startsWith('nbme_') || !REF.test(ref)) continue;
    const match = captionMatch(p.caption, names);
    if (match !== 'no') out.nbme_hy.push({ source: 'nbme_hy', ref, title: cut(p.caption, 200), match });
  }
  const seen = new Set();
  for (const c of cards) {
    const id = Number(c && c.card_id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id) || !(Number(c.image_count) > 0) || !isAnking(c.deck)) continue;
    seen.add(id);
    const match = cardMatch(c, topic, names);
    if (match !== 'no') out.anki.push({ source: 'anki', ref: `card_${id}`, title: cut(c.answer || c.fact || c.question, 160), match, text: cut(`${c.question || ''} ${c.answer || c.fact || ''}`, 400) });
  }
  // Clear before unclear, each list in the order the library gave it.
  for (const k of Object.keys(out)) out[k] = [...out[k].filter(c => c.match === 'clear'), ...out[k].filter(c => c.match === 'unclear')];
  return out;
}

/** The pick: per library, the first clear one, else the first unclear one Claude said yes to. verdicts: Map id -> bool. */
export function pickPictures(cands, verdicts = new Map()) {
  const out = [];
  for (const src of AUTO_SOURCES) {
    const list = cands[src] || [];
    const clear = list.find(c => c.match === 'clear');
    const yes = clear || list.find(c => c.match === 'unclear' && verdicts.get(c.ref) === true);
    if (yes) out.push({ source: src, ref: yes.ref, title: yes.title, by: clear ? 'name' : 'claude' });
  }
  return out;
}

// ---------------------------------------------------------------- the Claude check

export const CHECK_SYSTEM = `You check pictures for a medical student's topic map (USMLE Step 2 CK). For each candidate picture you get only its
caption (or, for a flashcard, the card's text). Say shows: true only when the picture is about THIS topic itself: it
shows the topic's own finding, imaging, histology, rash, table or comparison that includes it as a main subject. Say
false when the topic is only mentioned (a cause, an association, a look-alike in passing, a different condition that
shares a word), when the caption is about a different or broader topic, or when you are unsure. A wrong picture is
worse than none.`;
export const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'shows'], properties: { id: { type: 'string' }, shows: { type: 'boolean' } } } } },
};
const LIB_WORD = { anking: 'AnKing summary table', nbme_hy: 'NBME High Yield image', anki: 'AnKing flashcard with a picture' };

/** The check's message: the topic, its other names, then each unclear candidate by id. */
export function checkMessage(topic, names, unclear) {
  const other = names.slice(1).map(n => (typeof n === 'string' ? n : n.alias)).filter(Boolean);
  return [`Topic: ${topic.name}${other.length ? ` (also called: ${other.slice(0, 6).join(', ')})` : ''}`, '', 'Candidates:',
    ...unclear.map(c => `- id ${c.ref} (${LIB_WORD[c.source]}): ${c.source === 'anki' ? c.text || c.title : c.title}`)].join('\n');
}

/** The check, through claude.js and the hub's spend caps: Map ref -> shows. */
async function claudeCheck(env, { topic, names, unclear }) {
  const [{ callJson }, { reserveSpend, spendCap }] = await Promise.all([import('../claude.js'), import('../db.js')]);
  const release = await reserveSpend(env, AUTO.reserve_usd, await spendCap(env));
  try {
    const r = await callJson(env, { role: 'picturer', system: CHECK_SYSTEM, schema: CHECK_SCHEMA, effort: 'low', maxTokens: 4000,
      messages: [{ role: 'user', content: checkMessage(topic, names, unclear) }] });
    return verdictMap(r.data, unclear);
  } finally { await release(0); }   // claude.js adds the real cost itself
}

/** The model's reply as Map ref -> shows, only for ids that were asked about. */
export function verdictMap(data, unclear) {
  const asked = new Set(unclear.map(c => c.ref));
  const out = new Map();
  for (const v of (data && Array.isArray(data.verdicts) ? data.verdicts : [])) if (v && asked.has(v.id)) out.set(v.id, v.shows === true);
  return out;
}

// ---------------------------------------------------------------- reads

let catalogueMemo = null;

async function ankingCatalogue(env, user, now, anki) {
  try {
    const rows = (await env.DB.prepare(`SELECT ref, title FROM anking_catalogue WHERE user_id = ? ORDER BY seq, ref`).bind(user).all()).results || [];
    if (rows.length) return rows;
  } catch (e) { if (!noTable(e)) throw e; }
  if (catalogueMemo && now - catalogueMemo.at < AUTO.catalogue_ms) return catalogueMemo.entries;
  const entries = catalogueEntries(await anki('picture_catalogue', {}));
  catalogueMemo = { at: now, entries };
  return entries;
}
export const _resetCatalogue = () => { catalogueMemo = null; };

/** The topics to look at this run, new ones first, then seen ones with no picture, then the rest of the seen ones. */
export async function pickTopics(env, user, now, n = AUTO.per_run) {
  return (await env.DB.prepare(`SELECT t.id, t.name, t.short_name, t.kind, t.category_id, t.category2_id, coalesce(c.tries, 0) AS tries FROM topics t
      LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
      LEFT JOIN topic_picture_checks c ON c.user_id = t.user_id AND c.topic_id = t.id
    WHERE t.user_id = ?1 AND t.status IN ('proposed', 'confirmed') AND (s.seen = 1 OR t.created_at >= ?2)
      AND (c.topic_id IS NULL OR (c.status = 'error' AND c.tries < ?3 AND c.checked_at < ?4))
    ORDER BY t.created_at >= ?2 DESC,
      EXISTS (SELECT 1 FROM topic_pictures p WHERE p.user_id = t.user_id AND p.topic_id = t.id AND p.hidden_at IS NULL),
      t.created_at DESC, t.yield DESC, t.id LIMIT ?5`).bind(user, now - AUTO.new_ms, AUTO.max_tries, now - AUTO.retry_ms, n).all()).results || [];
}

/** How many topics are still waiting (for the job line). */
async function leftCount(env, user, now) {
  const r = await env.DB.prepare(`SELECT count(*) AS n FROM topics t LEFT JOIN topic_scores s ON s.user_id = t.user_id AND s.topic_id = t.id
      LEFT JOIN topic_picture_checks c ON c.user_id = t.user_id AND c.topic_id = t.id
    WHERE t.user_id = ?1 AND t.status IN ('proposed', 'confirmed') AND (s.seen = 1 OR t.created_at >= ?2) AND c.topic_id IS NULL`).bind(user, now - AUTO.new_ms).first();
  return Number(r && r.n) || 0;
}

// ---------------------------------------------------------------- one topic

/**
 * Look for one topic's pictures and add the ones that match. Returns {added: [{source}], ai, error?, held?}. Each
 * library failing alone is left out (and the topic tried again later); what was found is still added.
 */
export async function pictureTopic(env, user, topic, { now = Date.now(), anki, check } = {}) {
  const [al, held, linked] = await env.DB.batch([
    env.DB.prepare(`SELECT alias, kind FROM topic_aliases WHERE user_id = ? AND topic_id = ? AND status = 'active'`).bind(user, topic.id),
    env.DB.prepare(`SELECT DISTINCT source FROM topic_pictures WHERE user_id = ? AND topic_id = ?`).bind(user, topic.id),
    env.DB.prepare(`SELECT c.card_id, c.deck, c.question, c.answer, c.image_count FROM card_topics ct JOIN card_cache c ON c.user_id = ct.user_id AND c.card_id = ct.card_id
      WHERE ct.user_id = ? AND ct.topic_id = ? AND ct.strong = 1 AND ct.removed_at IS NULL AND c.deleted_at IS NULL AND c.image_count > 0 ORDER BY c.card_id LIMIT 20`).bind(user, topic.id),
  ]);
  const names = topicNameList(topic, al.results || []);
  const has = new Set((held.results || []).map(r => r.source));
  const errors = [];
  const soft = async (what, fn) => { try { return await fn(); } catch (e) { if (!(e instanceof AnkiError)) throw e; errors.push(`${what}: ${e.message}`); return null; } };
  const queries = [topic.name, ...names.slice(1).map(n => n.alias).filter(a => a && a.length > 3)].slice(0, 3);

  const catalogue = has.has('anking') ? [] : (await soft('AnKing tables', () => ankingCatalogue(env, user, now, anki))) || [];
  const hy = has.has('nbme_hy') ? null : await soft('NBME High Yield', () => anki('high_yield_notes', { queries, exam: 'step2', limit: 1 }));
  const nbme = ((hy && hy.pictures) || []).filter(p => p && String(p.library || '').startsWith('nbme_'));
  let cards = [];
  if (!has.has('anki')) {
    cards = (linked.results || []).filter(c => isAnking(c.deck)).map(c => ({ ...c, linked: true }));
    if (!cards.length) {
      const found = await soft('AnKing cards', () => anki('find_cards', { text: topic.name, all_decks: true, limit: 5 }));
      cards = ((found && found.cards) || []);
    }
  }
  const cands = candidatesFor(topic, names, { catalogue, nbme, cards });
  // One check a topic, for the libraries with no clear match, their first unclear ones only.
  const unclear = AUTO_SOURCES.flatMap(s => (cands[s].some(c => c.match === 'clear') ? [] : cands[s].filter(c => c.match === 'unclear').slice(0, AUTO.unclear_max)));
  let verdicts = new Map(), ai = 0, heldBack = false, waiting = false;
  if (unclear.length) {
    try { verdicts = await check(env, { topic, names, unclear }); ai = 1; } catch (e) {
      // Waiting for its Message Batch: held like the spend cap (no try used); the look an hour later finds the answer.
      if (e && e.pending === true && e.batch === true) { heldBack = true; waiting = true; } else if (capped(e)) heldBack = true; else errors.push(`Claude check: ${(e && e.message) || e}`);
    }
  }
  const pictures = pickPictures(cands, verdicts);
  let added = [];
  if (pictures.length) {
    const ch = await applyChange(env, user, { actor: 'code', surface: 'cron', op: 'topic_picture.auto', via: 'cron:pictures', args: { topic_id: topic.id, pictures } });
    if (ch.refused) errors.push(`not added: ${ch.reason || 'refused'}`);
    else if (!ch.nothing) added = pictures.filter(p => !has.has(p.source));
  }
  const status = errors.length || heldBack ? 'error' : added.length ? 'found' : 'none';
  // A look held back by the spend cap is not a try: it waits an hour like a failed one, without counting.
  await env.DB.prepare(`INSERT INTO topic_picture_checks (user_id, topic_id, status, added, ai, tries, error, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT (user_id, topic_id) DO UPDATE SET status = excluded.status, added = topic_picture_checks.added + excluded.added, ai = topic_picture_checks.ai + excluded.ai,
      tries = CASE WHEN excluded.status = 'error' THEN topic_picture_checks.tries + ?9 ELSE topic_picture_checks.tries END, error = excluded.error, checked_at = excluded.checked_at`)
    .bind(user, topic.id, status, added.length, ai, errors.length ? 1 : 0, errors.length ? cut(errors.join('; '), 200) : null, now, errors.length ? 1 : 0).run();
  return { added, ai, ...(errors.length ? { error: errors.join('; ') } : {}), ...(heldBack ? { held: true } : {}), ...(waiting ? { waiting: true } : {}) };
}

// ---------------------------------------------------------------- the minute job

/**
 * The minute job (cron.js): up to AUTO.per_run topics, one after another. anki and check are for the tests (the Anki
 * server's tools and the Claude check). Posts one line a day to Recent activity, and a failure line when any failed.
 */
export async function pictureJob(env, user, { at = Date.now(), anki = null, check = claudeCheck, n = AUTO.per_run } = {}) {
  const now = Number(at) || Date.now();
  if (!env || !env.DB) return { skipped: 'no database' };
  if (!anki && !env.ANKI_MCP_URL) return { skipped: 'Anki is not connected' };
  const call = anki || ((name, args) => ankiCall(env, name, args, { timeoutMs: 20_000 }));
  let topics;
  try { topics = await pickTopics(env, user, now, n); } catch (e) { if (noTable(e)) return { skipped: 'no picture table yet' }; throw e; }
  if (!topics.length) return { idle: true };
  const c = { topics: 0, got: 0, anking: 0, nbme: 0, cards: 0, none: 0, ai: 0, failed: 0 };
  const fails = [];
  let held = false, waiting = 0;
  for (const t of topics) {
    let r;
    try { r = await pictureTopic(env, user, t, { now, anki: call, check }); } catch (e) {
      r = { added: [], ai: 0, error: (e && e.message) || String(e) };
      await env.DB.prepare(`INSERT INTO topic_picture_checks (user_id, topic_id, status, tries, error, checked_at) VALUES (?1, ?2, 'error', 1, ?3, ?4)
        ON CONFLICT (user_id, topic_id) DO UPDATE SET status = 'error', tries = topic_picture_checks.tries + 1, error = excluded.error, checked_at = excluded.checked_at`)
        .bind(user, t.id, cut(r.error, 200), now).run().catch(() => {});
    }
    c.topics++;
    c.ai += r.ai || 0;
    if (r.added.length) c.got++;
    for (const p of r.added) c[p.source === 'anking' ? 'anking' : p.source === 'nbme_hy' ? 'nbme' : 'cards']++;
    if (r.error) { c.failed++; fails.push(`${t.name}: ${r.error}`); } else if (r.waiting) waiting++; else if (r.held) held = true;
    else if (!r.added.length) c.none++;
  }
  const day = londonDay(now);
  await noteJob(env, { job: 'pictures', user, key: `run:${day}`, ref: 'run', state: 'ok', add: true, at: now,
    counts: { ...c, left: String(await leftCount(env, user, now).catch(() => 0)) } });
  if (fails.length) await noteJob(env, { job: 'pictures', user, key: `failed:${day}`, ref: 'failed', state: 'failed', add: true, at: now, counts: { n: fails.length }, detail: fails[0] });
  if (held) await noteJob(env, { job: 'pictures', user, key: `held:${day}`, ref: 'held', state: 'held', at: now, counts: {} });
  if (waiting) await noteJob(env, { job: 'pictures', user, key: `batch:${day}`, ref: 'batch', state: 'held', at: now, counts: { batch: 1, n: waiting }, add: true });
  return { ...c, held, ...(waiting ? { waiting } : {}) };
}
