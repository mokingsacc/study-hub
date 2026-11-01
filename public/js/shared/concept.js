
import { causeMult } from './cause.js';

// [discipline key, the system's name, its short name on the map]. Biostatistics and ethics are already clinical
// systems (systems.js SYSTEMS_V2), so they are not foundations.
export const DISCIPLINES = Object.freeze([
  ['physiology', 'Physiology', 'Physiology'],
  ['pathology', 'Pathology', 'Pathology'],
  ['pharmacology', 'Pharmacology', 'Pharm'],
  ['microbiology', 'Microbiology', 'Micro'],
  ['immunology', 'Immunology', 'Immunology'],
  ['biochemistry_genetics', 'Biochemistry and genetics', 'Biochem'],
  ['anatomy', 'Anatomy', 'Anatomy'],
]);
export const DISCIPLINE_KEYS = Object.freeze(DISCIPLINES.map(d => d[0]));
export const FOUNDATION_PREFIX = 'foundation-';
/** The foundation system's category id for a discipline key ('biochemistry_genetics' -> 'foundation-biochemistry-genetics'). */
export const foundationCategoryId = key => `${FOUNDATION_PREFIX}${String(key).replace(/_/g, '-')}`;
// Sorted after the 23 clinical systems, so the payload numbers them last.
export const FOUNDATION_CATEGORIES = Object.freeze(DISCIPLINES.map(([key, name, short], i) => Object.freeze({
  id: foundationCategoryId(key), discipline: key, name, short_name: short, sort: 100 + i })));
export const FOUNDATION_IDS = Object.freeze(FOUNDATION_CATEGORIES.map(c => c.id));
export const isFoundationCategory = id => typeof id === 'string' && id.startsWith(FOUNDATION_PREFIX);
export const disciplineOf = categoryId => (FOUNDATION_CATEGORIES.find(c => c.id === categoryId) || {}).discipline || null;

// A concept row weighs half the miss's own cause weight (missing fact or confusion 1 -> 0.5, reasoning 0.8 -> 0.4), so
// three misses on one idea add up on the concept without any one of them counting twice. A wrong belief with no judged
// cause (a misconception, a viva) weighs BELIEF_MULT of a miss: 0.3, the same as a misconception found in a lesson.
export const CONCEPT_WEIGHT = 0.5;
export const BELIEF_MULT = 0.6;
// Causes that never rest on a concept: a slip, or a blind guess.
export const NOT_CONCEPTUAL = Object.freeze(['misread', 'guess']);
// The bands that make a concept "weak" for the at-risk flag, and the most misses a teach_next pick needs.
// The map codes Shaky as 'mixed' (1 Nov fix: a Shaky concept now shows "At risk because" and can be taught); 'shaky' kept for old rows.
export const WEAK_BANDS = Object.freeze(['mixed', 'shaky', 'weak', 'very_weak']);
export const TEACH_MIN_MISSES = 2;

const round3 = x => Math.round(x * 1000) / 1000;

/** A concept row's weight (pure): CONCEPT_WEIGHT x the miss's cause weight, or x BELIEF_MULT for a belief. 0 for a slip. */
export function conceptWeight(cause = null, confidence = null, { belief = false } = {}) {
  if (NOT_CONCEPTUAL.includes(cause)) return 0;
  if (belief && !cause) return round3(CONCEPT_WEIGHT * BELIEF_MULT);
  return round3(CONCEPT_WEIGHT * (causeMult(cause, confidence) ?? 1));
}

/** The flag a clinical topic shows: "At risk because Thyroid uptake is weak". */
export const atRiskWords = name => `At risk because ${name} is weak`;

// ---------------------------------------------------------------- the judges' shared rule

export const CONCEPT_RULES = `## Concept (wrong and right_flawed only)
concept: only when the miss rests on misunderstanding an underlying principle, name that principle as a textbook concept a Step 1 book would index, 2 to 6 words ("Thyroid radioactive iodine uptake", "Frank-Starling mechanism", "Renal drug clearance", "Type IV hypersensitivity"): the one idea that, once understood, would also fix other topics. Never the disease or drug itself, never a whole discipline ("Physiology"). An empty string when the error is a single fact he never learned, a number, a misread or a guess.
concept_discipline: physiology, pathology, pharmacology, microbiology, immunology, biochemistry_genetics or anatomy (empty with no concept). Biostatistics and ethics are never concepts here.
concept_quote: his own words (at most 25, copied) that show the misunderstanding, or an empty string.`;

// The concept fields of a structured-output schema (the judges add them to their own).
export const CONCEPT_SCHEMA_PROPS = {
  concept: { type: 'string' },
  concept_discipline: { type: 'string', enum: [...DISCIPLINE_KEYS, ''] },
  concept_quote: { type: 'string' },
};
export const CONCEPT_FIELDS = Object.keys(CONCEPT_SCHEMA_PROPS);

const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t ? (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t) : null; };
// Whole disciplines and empty words are not concepts.
const TOO_BROAD = new Set(['physiology', 'pathology', 'pharmacology', 'microbiology', 'immunology', 'biochemistry', 'genetics', 'anatomy',
  'biochemistry and genetics', 'pathophysiology', 'mechanism', 'none', 'n/a', 'na', 'unknown']);

/**
 * A judge's concept fields made safe (pure): {concept, concept_discipline, concept_quote}, nulls when absent, too
 * broad, too long, without a discipline, or when the miss's cause is a slip or a guess.
 */
export function tidyConcept(x, cause = null) {
  const none = { concept: null, concept_discipline: null, concept_quote: null };
  if (!x || typeof x !== 'object' || NOT_CONCEPTUAL.includes(cause)) return none;
  const name = cut(x.concept, 80);
  const discipline = DISCIPLINE_KEYS.includes(x.concept_discipline) ? x.concept_discipline : null;
  if (!name || !discipline) return none;
  const key = name.toLowerCase().replace(/[.,;:]+$/, '');
  if (TOO_BROAD.has(key) || name.split(/\s+/).length > 8) return none;
  return { concept: name.replace(/[.;:]+$/, ''), concept_discipline: discipline, concept_quote: cut(x.concept_quote, 300) };
}

// ---------------------------------------------------------------- the ring on the map

export const RING_GAP = 120;
/**
 * Where a foundation system's galaxy starts before the first layout runs with it (the Worker's positions.js placeAll):
 * on the ring round everything placed so far (reach: the farthest placed topic's distance from the middle), at its
 * discipline's seventh of the circle from the top. Rounded to a tenth.
 */
export function ringCentre(categoryId, reach) {
  const i = Math.max(0, FOUNDATION_IDS.indexOf(categoryId));
  // a new system's galaxy is small, so it sits about where the layout puts it (reach + RING_GAP + its radius)
  const rho = Math.max(600, Number(reach) || 0) + RING_GAP + 30;
  const a = -Math.PI / 2 + (2 * Math.PI * i) / FOUNDATION_IDS.length;
  return { x: Math.round(rho * Math.cos(a) * 10) / 10, y: Math.round(rho * Math.sin(a) * 10) / 10 };
}
