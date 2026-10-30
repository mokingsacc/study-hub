// map_rules (plan §10.3, claude design §8): the map's rules for Claude, assembled from the owners' own
// constants, so a rule changed in code is the rule Claude reads. Nothing here decides anything.
//   rules(part)       {version, <part>: lines} for one part, or every part but teach_method for 'all'
//   rulesRoute        GET /api/map/rules?part=
import { json } from '../util.js';
import { BANDS, LEGEND, GLOW } from '../../../public/js/map/scale.js';
import { rulesLines, WEIGHTS_VERSION } from './weights.js';
import { fsrsRulesLines } from './fsrs.js';
import { YIELD_BANDS, PHASES, T_MAX, NO_LESSON_ERRORS, EXAM_DAY, addDays } from './teach-priority.js';
import { linkRules } from './links.js';
import { NAMING_RULES, CATEGORY_IDS } from './vocab.js';
import { ERROR_KEYS, errorWords } from './ingest/map-fields.js';
import { changeKinds } from './change-kinds.js';
import { LIMITS } from './change.js';
import { methodDigest } from './teach-method.js';

export const RULE_PARTS = ['colour', 'weakness', 'priority', 'links', 'phases', 'hard_rules', 'writes', 'error_types', 'freshness', 'naming', 'teach_method'];

const ERROR_MEANING = {
  knowledge_gap: 'did not know the fact (or guessed between two look-alikes)', misread: 'missed or misread a word or number in the stem', premature_closure: 'stopped at the first diagnosis that fit',
  faulty_synthesis: 'had the facts but combined them wrongly', test_taking: 'changed a right answer, ran out of time or misclicked',
  threshold: 'knew it but set the bar for acting wrong', calculation: 'arithmetic or formula slip',
};

const lane = l => `${l} ${YIELD_BANDS[l][0].toFixed(2)}–${YIELD_BANDS[l][1].toFixed(2)}`;

function colour() {
  return [
    `Bands by t (of 1000; higher is weaker): ${BANDS.map(b => `${b.word} ${b.from}–${b.to}`).join(', ')}.`,
    `${LEGEND.unseen}: grey, no evidence yet. Blue is strong, red is seen and weak.`,
    `${LEGEND.glow} A topic glows from certainty ${GLOW.min_cert100} of 100.`,
    LEGEND.drift,
  ];
}

function priority() {
  return [
    'Teach me picks, in order: the topic Mo names; a Teach me tap from the last 24 hours (oldest first); a gap Mo stated in the last 7 days on a placed lane A or B topic (highest gain first, then newest; one per call); then the computed pick.',
    `The pick is gain = Y × N × K × T: Y the topic's yield by lane (${['A', 'B', 'C', 'off'].map(lane).join(', ')}), N its stored weakness, K 0 when every recent miss was a ${NO_LESSON_ERRORS.join(' or ')} slip, T Mo's tie-breaks (sure and wrong, repeats, slow, overdue re-test, mixed-up look-alike, weak category; at most ${T_MAX}).`,
    `Left out: a topic whose last lesson landed, until a later miss, missed re-test, gap or card lapse on it (no clock); one partly landed in the last 2 days unless missed since; a strong topic; one seen only in an unfinished sitting; one taught today; one outside the phase's lanes; in consolidate, one outside lane A untouched for ${PHASES.find(p => p.quiet_days).quiet_days} days.`,
    'On topics days (Friday and Sunday) consecutive picks alternate categories.',
  ];
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayOfD = d => DATE.format(new Date(Date.parse(addDays(EXAM_DAY, -d) + 'T12:00:00Z')));
export function phaseRange(i, list = PHASES) {
  const p = list[i];
  const hi = i === 0 ? null : list[i - 1].minD - 1;
  if (hi == null) return `${p.minD} or more days left (to ${dayOfD(p.minD)})`;
  if (!Number.isFinite(p.minD)) return `the last ${hi} days (${dayOfD(hi)} to ${dayOfD(1)})`;
  return `${hi} to ${p.minD} days left (${dayOfD(hi)} to ${dayOfD(p.minD)})`;
}
function phases() {
  return PHASES.map((p, i) => `${p.name}: ${phaseRange(i)}; lessons about ${p.lesson_minutes} min${p.lanes ? `; lanes ${p.lanes.join(' and ')} only` : ''}${p.quiet_days ? `; outside lane A only with evidence in ${p.quiet_days} days` : ''}${p.mode ? `; ${p.mode} lessons` : ''}${p.rest ? '; no new teaching' : ''}.`);
}

const HARD_RULES = [
  'Never put UWorld or NBME question text (stems, options, explanations) in any hub field or reply; the hub refuses long text and text that copies a hub question.',
  'Right or wrong is decided by code: Claude never writes result, verdict, outcome, score, certainty, t or held.',
  'A hub sitting\'s results stay hidden until Mo finishes it: none of its misses, gaps, links or lessons reach the map, Review or Claude.',
  'Cards and the mistake log change only through the Anki connector; misreads and test-taking slips get no card and no lesson.',
  'Every change Claude or Mo makes is logged and can be undone ("undo that": hub_undo).',
  'AMBOSS is never read: only its links are stored.',
];

const FRESHNESS = [
  'Every reply carries as_of_seq, the map version it describes; reads are live, never cached.',
  'hub_changes {since_seq} gives exactly what changed since a reply.',
  'map_overview\'s fresh: how long since the Anki log was read (teach_next and map_overview read it first when over 20 s old).',
  'The map can change between turns: read it again next turn.',
];

function writes(kinds = changeKinds()) {
  const by = { free: [], asks: [], depends: [], refused: [] };
  for (const [op, e] of Object.entries(kinds)) {
    if (e.page_only) continue;
    const t = typeof e.tier === 'function' ? 'depends' : e.tier === 'confirm' ? 'asks' : e.tier;
    (by[t] || by.depends).push(op);
  }
  return [
    `Free: ${by.free.sort().join(', ') || 'none'}.`,
    `Asks Mo first (needs_confirm, then call again with confirm_token after his yes): ${by.asks.sort().join(', ') || 'none'}.`,
    `Depends on the call: ${by.depends.sort().join(', ') || 'none'}.`,
    ...(by.refused.length ? [`Code only: ${by.refused.sort().join(', ')}.`] : []),
    `More than ${LIMITS.confirmOver} rows in one call asks first; more than ${LIMITS.maxRows} is refused; ${LIMITS.per10min} changes in 10 minutes or ${LIMITS.perDay} in a day is the limit.`,
    `hub_undo undoes Claude's own last ${LIMITS.undoFreeMax} changes from the last 24 hours freely; anything older asks.`,
  ];
}

function errorTypes() {
  return ERROR_KEYS.map(k => `${k} (${errorWords(k) || k.replace(/_/g, ' ')}): ${ERROR_MEANING[k] || ''}`.trim());
}

const PARTS = {
  colour, weakness: () => [...fsrsRulesLines(), ...rulesLines()], priority, links: () => linkRules().split('\n'), phases, hard_rules: () => HARD_RULES, writes,
  error_types: errorTypes, freshness: () => FRESHNESS, naming: () => [...NAMING_RULES.split('\n'), `Category ids: ${CATEGORY_IDS.join(', ')}.`],
  teach_method: () => methodDigest(),
};

/** The rules for one part, or all of them ('all' leaves out teach_method, which is long: ask for it by name). */
export function rules(part = 'all') {
  const want = part == null || part === 'all' ? RULE_PARTS.filter(p => p !== 'teach_method') : [part];
  if (!want.every(p => PARTS[p])) return { refused: true, reason: `part is all or one of ${RULE_PARTS.join(', ')}.` };
  const out = { version: `w${WEIGHTS_VERSION}` };
  for (const p of want) out[p] = PARTS[p]();
  if (part === 'all' || part == null) out.next_step = 'For the teaching method: map_rules {part: "teach_method"}.';
  return out;
}

// GET /api/map/rules?part=
export async function rulesRoute(request, env, ctx, params, url) {
  const r = rules(url.searchParams.get('part') || 'all');
  return json(r, r.refused ? 400 : 200);
}
