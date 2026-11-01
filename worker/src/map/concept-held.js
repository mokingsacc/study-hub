import { questionBase, GATE_CREDIT } from './weights.js';
import { REVIEW_W } from './fsrs.js';
import { londonDay } from '../util.js';

export const HELD_KIND = 'concept_held';
// The question rules that count as holding a topic: a right answer, not guessed, not flawed (weights.js questionBase).
export const HELD_RULES = Object.freeze(['right_sure', 'right_lean', 'right']);
const MISS_RESULTS = new Set(['wrong', 'omitted', 'flawed']);

// A concept is a topic of a foundation system (shared/concept.js, 'foundation-' ids); its links to the clinical topics
// it underlies are type causes, from the concept.
export const LINKED_RIGHTS_SQL = `SELECT l.from_id AS concept_id, e.topic_id, e.obs_key, e.slot, e.kind, e.at, e.day, e.result, e.outcome, e.verdict,
    e.confidence, e.flaw_kind, e.held
  FROM links l JOIN topics c ON c.user_id = l.user_id AND c.id = l.from_id AND c.category_id LIKE 'foundation-%'
  JOIN evidence_live e ON e.user_id = l.user_id AND e.topic_id = l.to_id AND e.kind = 'question' AND e.held = 0
  WHERE l.user_id = ?1 AND l.type = 'causes' AND l.status IN ('proposed', 'active') AND l.from_id IN (SELECT value FROM json_each(?2))`;
export const CONCEPTS_OF_SQL = `SELECT l.to_id AS topic_id, l.from_id AS concept_id
  FROM links l JOIN topics c ON c.user_id = l.user_id AND c.id = l.from_id AND c.category_id LIKE 'foundation-%'
  WHERE l.user_id = ?1 AND l.type = 'causes' AND l.status IN ('proposed', 'active') AND l.to_id IN (SELECT value FROM json_each(?2))`;

/** Whether the rules live now give a held day any weight (both 0 as shipped: no read, nothing changes). */
export const heldOn = () => (Number(REVIEW_W.concept_held) || 0) > 0 || (Number(GATE_CREDIT.concept) || 0) > 0;

/**
 * The concept's held days (pure). rows: question rows of the topics it underlies ({topic_id, at, day?, result, outcome,
 * verdict, confidence, flaw_kind, held}). exclude: a topic id left out (the shadow test's answer topic). Returns rows
 * {obs_key, slot 0, kind concept_held, topic_id: conceptId, at (the day's last right), day, amount, held 0, detail_json}
 * in time order.
 */
export function heldRows(conceptId, rows, { exclude = null } = {}) {
  const days = new Map();   // day -> topic -> {right, miss, at}
  for (const r of rows || []) {
    if (!r || Number(r.held) === 1 || (r.kind && r.kind !== 'question')) continue;
    if (exclude != null && String(r.topic_id) === String(exclude)) continue;
    const at = Number(r.at);
    if (!Number.isFinite(at)) continue;
    const day = r.day || londonDay(at);
    if (!days.has(day)) days.set(day, new Map());
    const by = days.get(day), k = String(r.topic_id);
    const t = by.get(k) || { right: false, miss: false, at: 0 };
    const base = questionBase(r);
    const res = String(r.result || '').toLowerCase();
    if (MISS_RESULTS.has(res) || (base && /^wrong|^omitted/.test(base.rule))) t.miss = true;
    else if (base && HELD_RULES.includes(base.rule)) { t.right = true; t.at = Math.max(t.at, at); }
    by.set(k, t);
  }
  const out = [];
  for (const [day, by] of days) {
    const held = [...by].filter(([, t]) => t.right && !t.miss);
    if (!held.length) continue;
    out.push({
      obs_key: `held:${conceptId}:${day}`, slot: 0, kind: HELD_KIND, topic_id: conceptId, at: Math.max(...held.map(([, t]) => t.at)), day,
      amount: held.length, held: 0, source: 'derived', detail_json: JSON.stringify({ topics: held.map(([k]) => k).sort() }),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Every concept's held days from LINKED_RIGHTS_SQL rows: Map(concept id -> rows). */
export function heldByConcept(linked) {
  const by = new Map();
  for (const r of linked || []) { const k = String(r.concept_id); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  return new Map([...by].map(([k, rows]) => [k, heldRows(k, rows)]));
}
