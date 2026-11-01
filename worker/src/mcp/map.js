import { applyChange } from '../map/change.js';
import { overview, weakest, PURPOSES } from '../map/overview.js';
import { rules, RULE_PARTS } from '../map/rules.js';
import { readExamDay } from '../exam-day.js';
import { listQueue, QUEUE_KINDS, MAX_ALIASES, retryTransient } from '../map/topics.js';
import { searchTopics, liveTopic, requeueAfter } from '../map/resolve.js';
import { neighbours, topPairs } from '../map/links-store.js';
import { LINK_TYPES, CAPS as LINK_CAPS } from '../map/links.js';
import { TOPIC_KINDS, CATEGORY_IDS, NAME_MAX } from '../map/vocab.js';
import { DISCIPLINE_KEYS } from '../map/systems.js';
import { topicDetail } from '../map/topic.js';
import { loadLive } from '../map/live.js';
import { changeReply } from './reply.js';
import { noteFixed, OUTCOMES } from '../card-fix.js';
import { CAUSES } from '../../../public/js/shared/cause.js';
import { readOnly, additive, destructive, ALWAYS_LOAD } from './annotations.js';
import { factCheckRules } from '../map/fact-check.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const noTable = e => /no such table|no such column/i.test(String(e && e.message));

// Shared argument shapes.
export const SURFACE = { type: 'string', enum: ['chat', 'voice', 'code'] };
export const MO_SAID = { type: 'string', maxLength: 600 };
export const REASON = { type: 'string', maxLength: 200 };
export const CONFIRM = { type: 'string', maxLength: 80, description: 'From needs_confirm, after his yes' };
const RUN_ID = { type: 'string', maxLength: 80, description: 'From map_import_start' };
const TOPIC_REF = { type: 'string', minLength: 1, maxLength: 120, description: 'Id, name or alias' };
const TYPES = Object.keys(LINK_TYPES);
// Category ids are checked by taxonomy's planners; listing all 19 in every schema would crowd tools/list.
const CATEGORY = { type: 'string', maxLength: 40 };
const LANES = ['A', 'B', 'C', 'off'];

/** applyChange for Claude, with the connector's own fields taken out of args. */
// After these ops land, taxonomy re-places open queue items the new names now match, and placed misses bring their
// look-alikes (resolve.js requeueAfter, in waitUntil).
const REQUEUE_OPS = new Set(['queue.resolve', 'topic.add', 'topic.update']);

export async function claudeChange(env, user, op, args, ctx, extra = {}) {
  const { confirm_token, surface, mo_said, ...rest } = isObj(args) ? args : {};
  const apply = () => applyChange(env, user, {
    actor: 'claude', surface: surface || ctx.surface || 'chat', op, args: rest, mo_said: mo_said || null, confirm_token: confirm_token || null,
    via: ctx.via || null, request_id: ctx.request_id || null,
  });
  // queue.resolve once more on a transient error (release-2 fixes): a failed batch wrote nothing.
  const r = op === 'queue.resolve' ? await retryTransient(apply) : await apply();
  if (r && r.ok && r.batch_id && REQUEUE_OPS.has(op)) {
    try { await requeueAfter(env, user, r.batch_id, ctx); } catch (e) { console.error('requeueAfter failed', e && e.message); }
  }
  // Cards to fix settled (card-fix.js): the night's one "Cards reviewed by Claude" line on Recent activity grows with each.
  if (r && r.ok && op === 'queue.resolve' && Array.isArray(r.results) && r.results.some(x => x && x.fixed)) await noteFixed(env, r.results);
  return changeReply(r, extra);
}

/** A topic named by id, name or alias: {topic} when one is clear, else {found: false, candidates}. */
export async function findTopic(env, user, text) {
  const s = String(text || '').trim();
  if (/^[a-z0-9][a-z0-9._-]*$/.test(s)) {
    const t = await liveTopic(env, user, s).catch(e => { if (noTable(e)) return null; throw e; });
    if (t) return { topic: t };
  }
  const hits = await searchTopics(env, user, { q: s, limit: 5 });
  if (hits.length && hits[0].score >= 0.9 && !(hits[1] && hits[1].score >= hits[0].score)) {
    const t = await liveTopic(env, user, hits[0].id).catch(() => null);
    if (t) return { topic: t };
  }
  return { found: false, candidates: hits.slice(0, 5).map(h => ({ id: h.id, name: h.name, status: h.status, matched_on: h.matched_on })) };
}

async function mapTopic(env, user, args, ctx) {
  const f = await findTopic(env, user, args.topic);
  if (!f.topic) return f;
  const slow = (args.include || []).some(x => x === 'cards' || x === 'mehlman');
  const opts = { audience: 'claude', include: args.include, missesLimit: args.misses_limit, ctx, awaitSourcesMs: slow ? 2500 : 0 };
  let d = await topicDetail(env, user, f.topic.id, opts);
  if (d && d.redirect) d = await topicDetail(env, user, d.redirect, opts);
  if (!d || d.redirect) return { found: false, candidates: [], next_step: 'That topic is not on the map: map_search for the name.' };
  const { seq, ...rest } = d;
  return { found: true, as_of_seq: seq, ...rest };
}

async function mapSearch(env, user, args) {
  const rows = await searchTopics(env, user, { q: args.q, category: args.category_id || null, kind: args.kind || null, status: args.status || null, limit: args.limit || 8 });
  if (!rows.length) return { rows: [], next_step: 'Nothing matches: map_add_topic if it is truly a new topic (check the naming rules in map_rules {part: "naming"}).' };
  // Each colour as of now (live.js: the stored row faded on read); an unseen topic has no row here.
  const by = await loadLive(env, user, { ids: rows.map(r => r.id) });
  return { rows: rows.map(r => {
    const s = by.get(r.id) || {};
    return { id: r.id, name: r.name, kind: r.kind, category: r.category_id, status: r.status, band: s.band || 'unseen', t1000: s.seen && s.t != null ? Math.round(s.t * 1000) : null,
      seen: !!s.seen, matched_on: r.matched_on };
  }) };
}

async function mapNeighbours(env, user, args) {
  const limit = args.limit || 12;
  if (!args.topic) return { topic: null, pairs: await topPairs(env, user, limit, { mixedOnly: !!args.confused_only }) };
  const f = await findTopic(env, user, args.topic);
  if (!f.topic) return f;
  return { topic: { id: f.topic.id, name: f.topic.name }, rows: await neighbours(env, user, f.topic.id, { types: args.types, confused_only: !!args.confused_only, limit }) };
}

const NEW_TOPIC = {
  type: 'object', properties: {
    name: { type: 'string', minLength: 1, maxLength: NAME_MAX }, kind: { type: 'string', enum: TOPIC_KINDS }, category_id: CATEGORY, category2_id: CATEGORY, unit_id: { type: 'string', maxLength: 40 }, parent_id: { type: 'string', maxLength: 120 },
    short_name: { type: 'string', maxLength: 20 }, aliases: { type: 'array', maxItems: MAX_ALIASES, items: { type: 'string', maxLength: 80 } },
    amboss_title: { type: 'string', maxLength: 120 }, amboss_url: { type: 'string', maxLength: 300 }, status: { type: 'string', enum: ['proposed', 'confirmed'] },
  }, required: ['name', 'kind', 'category_id'], additionalProperties: false,
};

export const MAP_TOOLS = [
  {
    name: 'map_overview', title: 'Map overview', annotations: readOnly('Map overview'), _meta: ALWAYS_LOAD, cap: 6000,
    trim: ['since_last.lines:2', 'gaps_stated:2', 'next_up:3', 'requested:2', 'map.weakest_categories'],
    description: 'First in study chats but "teach me"; again after 30 min or asked; not in Anki Voice. Changes since last look, stated gaps, Teach me taps, 5 weakest, why, last lesson, to place, totals, days left, new pattern, profile. voice: say line. note: nightly line',
    // note: the nightly scheduled session's one-line summary, posted to Recent activity (job nightly_session).
    inputSchema: { type: 'object', properties: { voice: { type: 'boolean' }, note: { type: 'string' } }, additionalProperties: false },
    run: (env, user, args, ctx) => overview(env, user, { voice: !!args.voice, ctx, note: typeof args.note === 'string' ? args.note : null }),
  },
  {
    // cap: the longest part, the qbank method (METHOD_TEXT_MAX), with room; every other part is under 8,000 (tests).
    name: 'map_rules', title: 'Map rules', annotations: readOnly('Map rules'), cap: 36000,
    // The parts are the enum; tools/list is at its cap, so the description names only the ones 'all' leaves out.
    // fact_check (1 Nov 2026) also carries today's lessons, cards and corrections to check (fact-check.js).
    description: 'The map\'s rules from code, by part. By name only: teach_method, qbank_method (the two skills\' methods), exam_wording, fact_check, card_review.',
    inputSchema: { type: 'object', properties: { part: { type: 'string', enum: ['all', ...RULE_PARTS] } }, additionalProperties: false },
    run: async (env, user, args) => (args.part === 'fact_check' ? factCheckRules(env, user)
      : rules(args.part || 'all', !args.part || args.part === 'all' || args.part === 'phases' ? { examDay: await readExamDay(env) } : {})),
  },
  {
    name: 'map_topic', title: 'One topic', annotations: readOnly('One topic'), cap: 12000,
    trim: ['read.mehlman.items:1', 'lessons.memory:1', 'lessons.items:1', 'cards.items:1', 'links.other:2', 'links.versus:3', 'misses.items:3', 'gaps.items:2'],
    description: 'One topic: for_explaining (history), band, why, unit, lane, misses (his thinking, rule, look-alike), gaps, habits, links, lessons, notes, AMBOSS. cards/mehlman: Anki, slow; library: PDFs; exams: NBME/CMS Qs; cited. found false: candidates; retry by id.',
    inputSchema: { type: 'object', properties: {
      topic: TOPIC_REF,
      include: { type: 'array', maxItems: 9, items: { type: 'string', enum: ['misses', 'links', 'lessons', 'notes', 'gaps', 'cards', 'mehlman', 'library', 'exams'] } },
      misses_limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['topic'], additionalProperties: false },
    run: (env, user, args, ctx) => mapTopic(env, user, args, ctx),
  },
  {
    name: 'map_search', title: 'Find topics', annotations: readOnly('Find topics'), cap: 4000, trim: ['rows:3'],
    description: 'Find topics by name, abbreviation or alias, with bands, plus his exam Qs. Before map_add_topic: a synonym is an alias.',
    inputSchema: { type: 'object', properties: {
      q: { type: 'string', minLength: 1, maxLength: 120 }, category_id: { type: 'string', maxLength: 40 }, kind: { type: 'string', enum: TOPIC_KINDS },
      status: { type: 'string', enum: ['proposed', 'confirmed', 'any'] }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['q'], additionalProperties: false },
    run: (env, user, args) => mapSearch(env, user, args),
  },
  {
    name: 'map_weakest', title: 'Weakest topics', annotations: readOnly('Weakest topics'), cap: 16000, trim: ['rows:8'],
    description: 'lesson: next to teach. weakest: by colour. cards ("make flashcards"): misses after since_anki_id (last carded) or since_day, no slips, has_card; then mistake_sources. miss_cards (voice: 3): misses whose card is not answered yet. pairs: most mixed-up look-alikes. review: weakest units.',
    inputSchema: { type: 'object', properties: {
      purpose: { type: 'string', enum: PURPOSES }, category_id: { type: 'string', maxLength: 40 }, lane: { type: 'string', enum: LANES },
      since_anki_id: { type: 'integer', minimum: 0 }, since_day: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, limit: { type: 'integer', minimum: 1, maximum: 15 },
      voice: { type: 'boolean' } }, additionalProperties: false },
    alias: a => (a.purpose === 'retest' ? { ...a, purpose: 'miss_cards' } : a),   // its old name (1 Nov 2026)
    run: (env, user, args) => weakest(env, user, args),
  },
  {
    name: 'map_neighbours', title: 'Look-alikes and links', annotations: readOnly('Look-alikes and links'), cap: 5000, trim: ['rows:4', 'pairs:4'],
    description: 'A topic\'s look-alikes (telling fact, how often mixed up; exam Qs that pit them) and drug links. No topic: most mixed-up pairs.',
    inputSchema: { type: 'object', properties: {
      topic: TOPIC_REF, types: { type: 'array', maxItems: 4, items: { type: 'string', enum: TYPES } }, confused_only: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 24 } }, additionalProperties: false },
    run: (env, user, args) => mapNeighbours(env, user, args),
  },
  {
    name: 'map_queue', title: 'Items to place', annotations: readOnly('Items to place'), cap: 8000, trim: ['items:5'],
    description: 'Items code could not place, most seen first, his words, ≤3 candidates. Settle with map_resolve, 25 at a time. Cards to fix: kind card_fix.',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: QUEUE_KINDS }, category_id: { type: 'string', maxLength: 40 }, limit: { type: 'integer', minimum: 1, maximum: 25 } }, additionalProperties: false },
    run: (env, user, args) => listQueue(env, user, { kind: args.kind || null, category: args.category_id || null, limit: args.limit || 10 }),
  },
  {
    name: 'map_resolve', title: 'Place queued items', annotations: additive('Place queued items'), cap: 3000, trim: ['problems:5', 'new_topics:5'],
    description: 'Settle up to 25 map_queue items (50 in an import): {queue_id, topic_id}, {queue_id, new_topic} (map_rules naming) or {queue_id, reject: why}; unit, versus: as map_queue shows; card_fix: {queue_id, action, note}.',
    inputSchema: { type: 'object', properties: {
      items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: {
        queue_id: { type: 'string', minLength: 1, maxLength: 200 }, topic_id: { type: 'string', maxLength: 120 }, new_topic: NEW_TOPIC, reject: { type: 'string', maxLength: 120 },
        topics: { type: 'array', maxItems: 12 }, skip_conditions: { type: 'array', maxItems: 20 }, names: { type: 'array', maxItems: 12 }, links: { type: 'array', maxItems: 12 },
        skip_pairs: { type: 'array', maxItems: 20 }, action: { type: 'string', enum: OUTCOMES }, note: { type: 'string', maxLength: 200 } }, required: ['queue_id'], additionalProperties: false } },
      run_id: RUN_ID, reason: REASON, mo_said: MO_SAID, confirm_token: CONFIRM }, required: ['items'], additionalProperties: false },
    run: (env, user, args, ctx) => claudeChange(env, user, 'queue.resolve', args, ctx),
  },
  {
    name: 'map_move_miss', title: 'Move or correct a miss', annotations: additive('Move or correct a miss'), cap: 1000,
    description: 'Move a miss to its topic (to), or fix a miss or gap Mo says is wrong, as his correction. Ids: map_topic.',
    inputSchema: { type: 'object', properties: { miss_id: { type: 'string', minLength: 1, maxLength: 120 }, gap_id: { type: 'string', maxLength: 160 },
      to: { type: 'string', minLength: 1, maxLength: 120 },
      fix: { type: 'object', properties: { cause: { type: 'string', enum: CAUSES }, confidence: { type: 'string', enum: ['sure', 'lean', 'guess'] },
        his_words: { type: 'string', maxLength: 300 } }, additionalProperties: false },
      mo_said: MO_SAID }, additionalProperties: false },
    run: (env, user, args, ctx) => {
      const { fix, to, ...rest } = args || {};
      if (fix) return claudeChange(env, user, 'miss.correct', { ...rest, ...fix }, ctx);
      if (!rest.miss_id || !to) return { refused: true, reason: 'Send miss_id and to (a move), or fix (a correction).' };
      return claudeChange(env, user, 'miss.move', { ...rest, to }, ctx);
    },
  },
  {
    name: 'map_add_topic', title: 'Add topics', annotations: additive('Add topics'), cap: 1500, trim: ['created:5', 'existing:3'],
    description: 'Add up to 25 topics (50 in an import), named as AMBOSS US articles; naming, category ids: map_rules {part: "naming"}. map_search first (an alias answers existing). status confirmed only if Mo named it.',
    inputSchema: { type: 'object', properties: {
      topics: { type: 'array', minItems: 1, maxItems: 50, items: NEW_TOPIC }, run_id: RUN_ID, reason: REASON, mo_said: MO_SAID, confirm_token: CONFIRM },
    required: ['topics'], additionalProperties: false },
    run: (env, user, args, ctx) => claudeChange(env, user, 'topic.add', args, ctx),
  },
  {
    name: 'map_update_topic', title: 'Change a topic', annotations: destructive('Change a topic'), cap: 2000,
    description: 'Change one topic when Mo asks: name, kind, category, unit, aliases, AMBOSS link, cards, oncology/discipline tags. Retiring or dropping an alias asks Mo.',
    inputSchema: { type: 'object', properties: {
      topic: TOPIC_REF,
      set: { type: 'object', properties: {
        name: { type: 'string', maxLength: NAME_MAX }, short_name: { type: ['string', 'null'], maxLength: 20 }, kind: { type: 'string', enum: TOPIC_KINDS },
        category_id: CATEGORY, category2_id: { type: ['string', 'null'], maxLength: 40 }, unit_id: { type: ['string', 'null'], maxLength: 40 },
        parent_id: { type: ['string', 'null'], maxLength: 120 }, status: { type: 'string', enum: ['confirmed', 'retired'] }, amboss_url: { type: ['string', 'null'], maxLength: 300 },
        amboss_checked: { type: 'boolean' }, aliases_add: { type: 'array', maxItems: MAX_ALIASES, items: { type: 'string', maxLength: 80 } },
        aliases_remove: { type: 'array', maxItems: MAX_ALIASES, items: { type: 'string', maxLength: 80 } },
        cards_add: { type: 'array', maxItems: 10, items: { type: 'integer' } },
        oncology: { type: 'boolean' }, disciplines: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', enum: DISCIPLINE_KEYS } } }, additionalProperties: false },
      reason: REASON, mo_said: MO_SAID, confirm_token: CONFIRM }, required: ['topic', 'set'], additionalProperties: false },
    run: (env, user, args, ctx) => claudeChange(env, user, 'topic.update', args, ctx),
  },
  {
    name: 'map_add_link', title: 'Add a link', annotations: additive('Add a link', { idempotent: true }), cap: 1500, trim: ['candidates:3'],
    description: `Link two topics: versus (fact: "<finding that tells them apart>, so <what you do differently>", ≤${LINK_CAPS.fact} chars), treated_by, adverse_effect or causes. Unknown names: candidates. A link Mo removed stays so unless restore.`,
    inputSchema: { type: 'object', properties: {
      type: { type: 'string', enum: TYPES }, from: TOPIC_REF, to: TOPIC_REF, how: { type: 'string', maxLength: 40 },
      fact: { type: 'string', maxLength: LINK_CAPS.fact }, evidence: { type: 'string', maxLength: LINK_CAPS.evidence }, picture: { type: 'string', maxLength: 80 },
      restore: { type: 'boolean' }, run_id: RUN_ID, mo_said: MO_SAID, confirm_token: CONFIRM }, required: ['type', 'from', 'to'], additionalProperties: false },
    run: (env, user, args, ctx) => claudeChange(env, user, 'link.add', args, ctx),
  },
  {
    name: 'map_update_link', title: 'Change a link', annotations: destructive('Change a link'), cap: 1500,
    description: 'Change a link when Mo asks: fact (fact_for: the topic it is read from), how, note, picture; status removed (alone) removes, active restores.',
    inputSchema: { type: 'object', properties: {
      link_id: { type: 'string', minLength: 1, maxLength: 40 },
      set: { type: 'object', properties: {
        fact: { type: 'string', maxLength: LINK_CAPS.fact }, fact_for: { type: 'string', maxLength: 120 }, how: { type: 'string', maxLength: 40 },
        note: { type: ['string', 'null'], maxLength: LINK_CAPS.note }, picture: { type: ['string', 'null'], maxLength: 80 }, status: { type: 'string', enum: ['active', 'removed'] } },
      additionalProperties: false },
      reason: REASON, mo_said: MO_SAID, confirm_token: CONFIRM }, required: ['link_id', 'set'], additionalProperties: false },
    run: (env, user, args, ctx) => {
      const set = isObj(args.set) ? args.set : {};
      if (set.status === 'removed') {
        if (Object.keys(set).length > 1) return { refused: true, reason: 'Removing a link changes nothing else: send status alone.' };
        const rest = { ...args };
        delete rest.set;
        return claudeChange(env, user, 'link.remove', rest, ctx);
      }
      return claudeChange(env, user, 'link.update', args, ctx);
    },
  },
  {
    name: 'map_import_start', title: 'Start an import run', annotations: additive('Start an import run'), cap: 800,
    description: 'Seeding or OneNote import only: asks Mo once; its run_id gives map_resolve, map_add_topic and map_add_link bigger pages for 3 h.',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['seed', 'onenote'] }, reason: REASON, mo_said: MO_SAID, confirm_token: CONFIRM }, required: ['kind', 'reason'], additionalProperties: false },
    run: (env, user, args, ctx) => claudeChange(env, user, 'import.start', args, ctx),
  },
];
