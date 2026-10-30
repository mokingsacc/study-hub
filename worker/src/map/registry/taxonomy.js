// Taxonomy (topics, units, categories, queue) registry (owner: TAX). The shapes are at the top of registry/index.js.
// Planners are wrapped so this file only touches them at call time (registry import cycles stay harmless).
import * as topics from '../topics.js';
import { planVocabSeed } from '../vocab.js';
import { planYieldRefresh } from '../yield.js';
import * as linkStore from '../links-store.js';
import * as remap from '../remap.js';
import * as aliasCleanup from '../alias-cleanup.js';

// Code's own jobs (seeding, the hourly yield) go through applyChange as actor code; no one else may run them.
const codeOnly = (a, p, c) => (c && c.actor === 'code' ? 'free' : 'refused');
const CODE_REASON = 'That is done by the hub itself.';
const YIELD = { topics: { actions: 'iu', cols: ['yield', 'yield_json', 'q_seen', 'anking_cards'] }, units: { actions: 'u', cols: ['yield', 'yield_json'] } };

export const CHANGE_KINDS = {
  // map_add_topic, POST /api/map/topic. Up to 25 new topics are one free change (50 in an import run).
  'topic.add': { tier: 'free', kind: 'topic.added', undoable: true, writes: YIELD, plan: (...a) => topics.planTopicAdd(...a) },
  'topic.update': { tier: a => topics.updateTier(a), kind: 'topic.updated', undoable: true, writes: YIELD, evidence: true, plan: (...a) => topics.planTopicUpdate(...a) },
  'topic.confirm': { tier: 'free', kind: 'topic.confirmed', undoable: true, plan: (...a) => topics.planTopicConfirm(...a) },
  'topic.retire': { tier: 'confirm', kind: 'topic.retired', undoable: true, writes: YIELD, evidence: true, plan: (...a) => topics.planTopicRetire(...a) },
  'alias.add': { tier: 'free', kind: 'alias.added', undoable: true, writes: YIELD, plan: (...a) => topics.planAliasAdd(...a) },
  'alias.remove': { tier: 'confirm', kind: 'alias.removed', undoable: true, writes: YIELD, plan: (...a) => topics.planAliasRemove(...a) },
  'unit.update': { tier: 'free', kind: 'unit.updated', undoable: true, writes: YIELD, plan: (...a) => topics.planUnitUpdate(...a) },
  // map_resolve, the map's tray and the queue re-run: each item to its kind's QUEUE_HANDLERS.
  // writes is read at call time (a getter), so links' columns for versus items never touch links-store mid-cycle.
  'queue.resolve': { tier: 'free', kind: 'queue.resolved', undoable: true, get writes() { return { ...YIELD, ...linkStore.LINK_WRITES }; }, evidence: true,
    plan: (...a) => topics.planQueueResolve(...a) },
  'vocab.seed': { tier: codeOnly, reason: CODE_REASON, kind: 'map.resync', undoable: false, plan: (...a) => planVocabSeed(...a) },
  'yield.refresh': { tier: codeOnly, reason: CODE_REASON, kind: 'topic.updated', undoable: false, writes: YIELD, plan: (...a) => planYieldRefresh(...a) },
  'alias.cleanup': { tier: codeOnly, reason: CODE_REASON, kind: 'alias.removed', undoable: true, evidence: true, page_only: true,
    writes: { ...YIELD, topic_queue: { actions: 'iu', cols: ['kind', 'label_norm', 'label_raw', 'context_json', 'candidates_json', 'refs', 'first_seen_at', 'last_seen_at', 'status', 'resolved_topic_id', 'resolved_by'] } },
    plan: (...a) => aliasCleanup.planAliasCleanup(...a) },
  'taxonomy.remap': { tier: (a, p, c) => (c && (c.actor === 'mo' || c.actor === 'code') ? 'free' : 'refused'),
    reason: 'Moving the whole map to the new systems is Mo\'s to do, from POST /api/map/remap.', kind: 'map.resync', undoable: true,
    plan: (...a) => remap.planRemap(...a), apply: (...a) => remap.applyRemap(...a) },
};

// Undo of a retire's unplaced misses and gaps: the row and its evidence go back on the topic.
export const UNDO = {
  'target:taxonomy_remap': (...a) => remap.undoRemap(...a),
  'target:retired_miss': (...a) => topics.undoRetiredRow(...a),
  'target:retired_gap': (...a) => topics.undoRetiredRow(...a),
};

export const QUEUE_HANDLERS = {
  label: (...a) => topics.TAX_QUEUE_HANDLERS.label(...a),
  lookalike: (...a) => topics.TAX_QUEUE_HANDLERS.lookalike(...a),
  gap: (...a) => topics.TAX_QUEUE_HANDLERS.gap(...a),
  card: (...a) => topics.TAX_QUEUE_HANDLERS.card(...a),
  unit: (...a) => topics.TAX_QUEUE_HANDLERS.unit(...a),
};

export const ROUTES = [
  ['GET', '/api/map/search', (...a) => topics.searchRoute(...a)],
  ['POST', '/api/map/topic', (...a) => topics.addTopicRoute(...a)],
  ['PATCH', '/api/map/topic/:id', (...a) => topics.patchTopicRoute(...a)],
  ['GET', '/api/map/queue', (...a) => topics.queueRoute(...a)],
  ['POST', '/api/map/queue/resolve', (...a) => topics.resolveQueueRoute(...a)],
  ['POST', '/api/map/seed/vocab', (...a) => topics.seedVocabRoute(...a)],
  ['POST', '/api/map/seed/yield', (...a) => topics.seedYieldRoute(...a)],
  ['GET', '/api/map/seed/status', (...a) => topics.seedStatusRoute(...a)],
  ['POST', '/api/map/remap', (...a) => remap.remapRoute(...a)],
  ['POST', '/api/map/alias-cleanup', (...a) => aliasCleanup.aliasCleanupRoute(...a)],
];

// Export and import (export.js): column types t text, i whole number, r number, jo/ja JSON, or the allowed values.
const T = 't', I = 'i', R = 'r';
const BY = ['seed', 'code', 'extractor', 'claude', 'mo'];
// As topics.js ALIAS_KINDS (kept here so loading this registry never reads topics.js mid-cycle; a test pins them equal).
const ALIAS_KINDS = ['name', 'abbrev', 'british', 'synonym', 'uworld_label', 'truncated', 'log_topic', 'analysis_topic', 'gap_topic',
  'tally_condition', 'amboss_title', 'nbme_term', 'merge', 'typo'];
export const EXPORT = {
  categories: {
    cols: ['user_id', 'id', 'name', 'short_name', 'sort', 'exam_profile', 'cms_subject', 'onenote_section', 'checklist_system', 'status', 'source', 'source_ref',
      'created_by', 'created_at', 'updated_at'],
    required: ['user_id', 'id', 'name', 'short_name', 'sort', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, name: T, short_name: T, sort: I, exam_profile: T, cms_subject: T, onenote_section: T, checklist_system: T, status: ['active', 'retired'],
      source: T, source_ref: T, created_by: BY, created_at: I, updated_at: I },
  },
  category_aliases: {
    cols: ['user_id', 'vocab', 'alias', 'alias_key', 'category_id', 'confidence', 'source', 'source_ref', 'created_by', 'created_at'],
    required: ['user_id', 'vocab', 'alias', 'alias_key', 'created_at'],
    types: { user_id: T, vocab: ['uworld_system', 'uworld_subject', 'checklist_system', 'onenote_section', 'hub_system', 'amboss', 'other'], alias: T, alias_key: T,
      category_id: T, confidence: R, source: T, source_ref: T, created_by: T, created_at: I },
  },
  units: {
    cols: ['user_id', 'id', 'num', 'kind', 'name', 'heading', 'lane', 'mehlman_rank', 'checklist_system', 'checklist_order', 'category_id', 'onenote_section',
      'onenote_page_id', 'onenote_object_id', 'onenote_link', 'coverage_json', 'nbme_images', 'notes_gap', 'yield', 'yield_json', 'locked_json', 'exam_profile',
      'source', 'source_ref', 'created_by', 'created_at', 'updated_at'],
    required: ['user_id', 'id', 'name', 'category_id', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, num: I, kind: ['checklist', 'onenote_core', 'onenote_mehlman'], name: T, heading: T, lane: ['A', 'B', 'C'], mehlman_rank: I,
      checklist_system: T, checklist_order: I, category_id: T, onenote_section: T, onenote_page_id: T, onenote_object_id: T, onenote_link: T, coverage_json: 'jo',
      nbme_images: I, notes_gap: [0, 1], yield: R, yield_json: 'jo', locked_json: 'ja', exam_profile: T, source: T, source_ref: T, created_by: T, created_at: I, updated_at: I },
  },
  unit_topics: {
    cols: ['user_id', 'unit_id', 'topic_id', 'role', 'source', 'created_by', 'created_at'],
    required: ['user_id', 'unit_id', 'topic_id', 'created_by', 'created_at'],
    types: { user_id: T, unit_id: T, topic_id: T, role: ['primary', 'also'], source: T, created_by: T, created_at: I },
  },
  topics: {
    cols: ['user_id', 'id', 'name', 'short_name', 'kind', 'status', 'merged_into', 'suspect_dupe_of', 'category_id', 'category2_id', 'unit_id', 'parent_id',
      'amboss_url', 'amboss_src', 'amboss_checked_at', 'yield', 'yield_json', 'q_seen', 'anking_cards', 'mehlman_match', 'nbme_images_own', 'exam_profile',
      'source', 'source_ref', 'created_by', 'created_at', 'updated_at', 'confirmed_at', 'confirmed_by', 'oncology', 'disciplines'],
    required: ['user_id', 'id', 'name', 'kind', 'category_id', 'source', 'created_by', 'created_at', 'updated_at'],
    types: { user_id: T, id: T, name: T, short_name: T, kind: ['condition', 'approach', 'drug', 'organism', 'concept', 'finding', 'procedure'],
      status: ['proposed', 'confirmed', 'merged', 'retired'], merged_into: T, suspect_dupe_of: T, category_id: T, category2_id: T, unit_id: T, parent_id: T,
      amboss_url: T, amboss_src: ['tally', 'claude', 'guess', 'mo'], amboss_checked_at: I, yield: R, yield_json: 'jo', q_seen: I, anking_cards: I,
      mehlman_match: ['strong', 'weak'], nbme_images_own: I, exam_profile: T, source: T, source_ref: T, created_by: BY, created_at: I, updated_at: I,
      confirmed_at: I, confirmed_by: T, oncology: [0, 1], disciplines: I },
  },
  topic_aliases: {
    cols: ['user_id', 'alias_key', 'topic_id', 'alias', 'kind', 'status', 'source', 'source_ref', 'created_by', 'created_at'],
    required: ['user_id', 'alias_key', 'topic_id', 'alias', 'kind', 'source', 'created_by', 'created_at'],
    types: { user_id: T, alias_key: T, topic_id: T, alias: T, kind: ALIAS_KINDS, status: ['active', 'removed'], source: T, source_ref: T, created_by: T, created_at: I },
  },
};
