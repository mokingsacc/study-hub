import { CAUSES, CAUSE_RULES, CAUSE_SCHEMA_PROPS, CAUSE_FIELDS, COULD_NOT_TELL, tidyCause } from '../../public/js/shared/cause.js';
import { CONCEPT_SCHEMA_PROPS, CONCEPT_FIELDS, tidyConcept } from '../../public/js/shared/concept.js';

export const FORM_VERSIONS = Object.freeze({ uworld_judge: 3, nbme_judge: 3, nbme_checker: 3, anki_check: 3, review_talk: 4, viva: 3 });

export const STEPS = Object.freeze(['recognise', 'distinguish', 'test', 'treat', 'trap']);
export const CONFIDENCE_VALUES = Object.freeze(['sure', 'lean', 'guess', 'not_said']);
export const HEARD = Object.freeze(['clear', 'partial', 'unclear', 'not_said']);
export const OTHER_KINDS = Object.freeze(['gap', 'belief']);
export const OTHER_MAX = 4;

const nul = s => ({ anyOf: [s, { type: 'null' }] });

const OTHER_SCHEMA = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['topic', 'kind', 'quote'],
  properties: { topic: { type: 'string' }, kind: { type: 'string', enum: [...OTHER_KINDS] }, quote: { type: 'string' } } } };

/** Every core field as structured-output schema properties, in the order the forms list them. */
export const CORE_SCHEMA_PROPS = Object.freeze({
  ...CAUSE_SCHEMA_PROPS,
  step: nul({ type: 'string', enum: [...STEPS] }),
  confidence: { type: 'string', enum: [...CONFIDENCE_VALUES] },
  confidence_words: { type: 'string' },
  confidence_inferred: { type: 'boolean' },
  ...CONCEPT_SCHEMA_PROPS,
  other_conditions: OTHER_SCHEMA,
  heard: { type: 'string', enum: [...HEARD] },
});
export const CORE_FIELDS = Object.freeze(Object.keys(CORE_SCHEMA_PROPS));
// The groups a form may leave out when its own extras already carry them (the review talk's gaps and beliefs lists are
// its other conditions; the Anki check and the viva's top level name no concept).
const GROUPS = { cause: CAUSE_FIELDS, step: ['step'], confidence: ['confidence', 'confidence_words', 'confidence_inferred'], concept: CONCEPT_FIELDS,
  other_conditions: ['other_conditions'], heard: ['heard'] };

/** The core for one form (pure): {props, fields}, without the groups named in skip. */
export function coreSchema({ skip = [] } = {}) {
  const out = new Set(skip.flatMap(g => GROUPS[g] || []));
  const fields = CORE_FIELDS.filter(f => !out.has(f));
  return { props: Object.fromEntries(fields.map(f => [f, CORE_SCHEMA_PROPS[f]])), fields };
}

/** The blind checker's own cause and step (the second judge, analyze.js): it re-checks nothing else. */
export const CHECK_CORE_PROPS = Object.freeze({ ...CAUSE_SCHEMA_PROPS, step: nul({ type: 'string', enum: [...STEPS] }) });
export const CHECK_CORE_FIELDS = Object.freeze(Object.keys(CHECK_CORE_PROPS));

// The core in words, once for every form (after the cause and concept rules each form already carries).
export const CORE_RULES = `## Every answer's core (every field present; "not said" is a valid answer)
- confidence: how sure HE sounded, read from his own words only: sure, lean, guess, or not_said when his words do not show it or he said nothing. confidence_words: his own words that show it (copied, at most 12), or an empty string. confidence_inferred: false only when he said it outright ("I'm sure", "fifty-fifty", "total guess"); true when you read it from how he spoke, or when not_said.
- heard: how clearly his words came through the transcript: clear; partial (some words garbled or cut off, the gist is there); unclear (mostly garbled, so what he meant is a guess); not_said when there are no words. Judge an unclear stretch no more surely than its words allow.
- other_conditions: other conditions he talks about besides the one asked, only where his words show a gap or a wrong belief on it ("it's not Graves because Graves has low uptake" when Graves has high uptake is a belief; "I never know what Graves does to uptake" is a gap): topic named by the naming rule below (as an AMBOSS article names it), kind gap or belief, quote his own words (copied, at most 25). Ruling a condition out for a right reason is neither. An empty list when there are none.
- concept, for a sound answer: when his words explain the underlying principle correctly, name that principle by the concept rules (the one he showed he understands), with his words in concept_quote; otherwise empty strings.
- naming: name every condition, drug or topic (other conditions, gaps, mixed-with, a topic) as the specific thing he talked about: the drug he named, not its class (he says demeclocycline: Demeclocycline, not Tetracyclines); a condition with its own name keeps it, never swapped for its cause (aplastic crisis: Aplastic crisis, not Parvovirus B19 infection). A crisis, flare or exacerbation of a disease is that disease (myasthenic crisis: Myasthenia gravis) unless his map's names list has the crisis itself. Use the broader name only when he spoke about the broader thing. When his map's names list (after these rules) holds the same condition, use its exact name.
- considered is not confused: cause confusion only when he chose, leaned to, or treated the other condition as the answer, or said he could not tell the two apart. Naming another condition and ruling it out ("not X because ...", "could be X, but ...") is considered, not confused: the cause is whatever made him miss (when he says he did not know the deciding fact, missing_fact), and mixed_with stays empty. Example (invented): "Could be lupus, but there's no rash, so not lupus. I don't know which test comes next, I'll say a biopsy": cause missing_fact, not confusion.
- Code checks only these: every wrong or shaky answer has a cause; a cause he named himself (cause_inferred false) has his words in cause_quote; every quote is his words, copied; mixed_with only for cause confusion. Leave anything else empty rather than guess.`;

/** The core rules for a form that leaves some groups out (coreSchema's skip): those groups' lines go. Pure. */
export function coreRules({ skip = [] } = {}) {
  const drop = { other_conditions: /^- other_conditions:/, concept: /^- concept, for a sound answer:/, confidence: /^- confidence:/, heard: /^- heard:/ };
  return CORE_RULES.split('\n').filter(l => !skip.some(g => drop[g] && drop[g].test(l))).join('\n');
}

// The considered-is-not-confused line on its own, for the blind checker (it carries no other core rule).
const CONSIDERED_LINE = CORE_RULES.split('\n').find(l => l.startsWith('- considered is not confused:')).slice(2);

/** The blind checker's cause rules: its own cause and step, not a re-check of anything the judge left empty. */
export const CHECK_CORE_RULES = `${CAUSE_RULES}
step, for wrong and right_flawed only (null for the others): recognise, distinguish, test, treat or trap, the one step that broke.
${CONSIDERED_LINE}`;

// ---------------------------------------------------------------- tidying

const cut = (s, n) => { const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''; return t ? (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t) : null; };
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function tidyOthers(list, { own = [], safe = v => v } = {}) {
  const mine = new Set((own || []).filter(Boolean).map(norm));
  const out = [], seen = new Set();
  for (const o of Array.isArray(list) ? list : []) {
    const topic = safe(cut(o && o.topic, 80));
    if (!topic || !OTHER_KINDS.includes(o.kind) || mine.has(norm(topic)) || seen.has(`${o.kind}|${norm(topic)}`)) continue;
    seen.add(`${o.kind}|${norm(topic)}`);
    out.push({ topic, kind: o.kind, quote: safe(cut(o.quote, 200)) });
    if (out.length >= OTHER_MAX) break;
  }
  return out;
}

export const confidenceOf = v => (['sure', 'lean', 'guess'].includes(v) ? v : null);
export const heardOf = v => (HEARD.includes(v) ? v : null);

export function tidyCore(x, { flagged = false, sound = false, own = [], safe = v => v } = {}) {
  const c = flagged ? tidyCause(x) : tidyCause(null);
  const conf = confidenceOf(x && x.confidence);
  const words = conf ? safe(cut(x && x.confidence_words, 120)) : null;
  const k = flagged ? tidyConcept(x, c.cause) : sound ? tidyConcept(x, null) : tidyConcept(null);
  return {
    ...c,
    step: flagged && x && STEPS.includes(x.step) ? x.step : null,
    confidence: conf, confidence_words: words,
    confidence_inferred: conf ? (x && x.confidence_inferred === false && words ? 0 : 1) : null,
    ...(k.concept ? { ...k, concept_polarity: flagged ? 'miss' : 'right' } : { concept: null, concept_discipline: null, concept_quote: null }),
    other_conditions: tidyOthers(x && x.other_conditions, { own, safe }),
    heard: heardOf(x && x.heard),
  };
}

// ---------------------------------------------------------------- what code checks (ai-audit.js reads these)

export function coreAudit(item, { flagged = false } = {}) {
  const x = item || {};
  const said = x.cause_inferred === false || x.cause_inferred === 0 || x.cause_inferred === '0';
  const required = flagged ? ['cause', ...(said && x.cause ? ['cause_quote'] : [])] : [];
  const quotes = ['cause_quote', 'confidence_words', 'concept_quote',
    ...(Array.isArray(x.other_conditions) ? x.other_conditions.map((_, i) => `other_conditions.${i}.quote`) : [])];
  return { required, quotes };
}

// ---------------------------------------------------------------- consistency (pure; integrity I11 reads the table)

export const ERROR_CAUSE_FIT = Object.freeze({
  'knowledge gap': ['missing_fact', 'confusion', 'guess'],
  'threshold or number': ['missing_fact', 'confusion'],
  'premature closure': ['ignored_clue', 'reasoning'],
  'faulty synthesis': ['reasoning', 'ignored_clue', 'confusion'],
  misread: ['misread'],
  'test-taking': ['misread', 'guess'],
  calculation: ['misread', 'reasoning'],
});

// The hub's words for an error type from either spelling ('knowledge_gap', 'Knowledge gap', 'test taking').
const ERROR_WORD = { knowledge_gap: 'knowledge gap', threshold: 'threshold or number', threshold_or_number: 'threshold or number', premature_closure: 'premature closure',
  faulty_synthesis: 'faulty synthesis', misread: 'misread', test_taking: 'test-taking', calculation: 'calculation' };
export function errorWord(v) {
  const k = String(v || '').trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
  return ERROR_WORD[k] || null;
}

/** Whether an error type and a cause agree (pure): true when either is empty or the pair is in ERROR_CAUSE_FIT. */
export function errorFitsCause(errorType, cause) {
  const e = errorWord(errorType);
  if (!e || !CAUSES.includes(cause)) return true;
  return ERROR_CAUSE_FIT[e].includes(cause);
}

/**
 * Every consistency problem of one stored answer (pure): {error_type, cause, mixed_with | look_alike_mixed} ->
 * ['error_cause'] when the error type contradicts the cause, ['mixed_without_confusion'] when a mixed-with names a
 * look-alike on a cause that is not a confusion, ['quote_not_his'] when quoteOk is false.
 */
export function consistencyIssues(x, { quoteOk = true } = {}) {
  const out = [];
  if (!x) return out;
  if (!errorFitsCause(x.error_type, x.cause)) out.push('error_cause');
  if (x.mixed_with && String(x.mixed_with).trim() && CAUSES.includes(x.cause) && x.cause !== 'confusion') out.push('mixed_without_confusion');
  if (!quoteOk) out.push('quote_not_his');
  return out;
}

/** The SQL test that an error type column fits a cause column (integrity I11), built from ERROR_CAUSE_FIT. */
export function fitSql(errorCol, causeCol) {
  // Each error type in the hub's words, as an Anki key ('knowledge_gap', 'test_taking') and by its first word ('threshold').
  const names = e => [...new Set([e, e.replace(/[- ]/g, '_'), e.split(' ')[0]])].map(n => `'${n}'`).join(', ');
  const pairs = Object.entries(ERROR_CAUSE_FIT).map(([e, cs]) => `(lower(${errorCol}) IN (${names(e)}) AND ${causeCol} IN (${cs.map(c => `'${c}'`).join(', ')}))`);
  return `(${pairs.join(' OR ')})`;
}

// ---------------------------------------------------------------- the second judge's cause

/**
 * The two judges on the cause (pure): 'agreed' when both name the same cause, or either names none (the second judge
 * does not re-check an empty field); 'disputed' when they name different causes. a, b: {cause}.
 */
export function causeAgreement(a, b) {
  const x = a && CAUSES.includes(a.cause) ? a.cause : null, y = b && CAUSES.includes(b.cause) ? b.cause : null;
  if (!x || !y) return 'agreed';
  return x === y ? 'agreed' : 'disputed';
}

// ---------------------------------------------------------------- considered, not confused (code, after the AI)

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Words too common to stand for a condition on their own.
const NAME_STOP = new Set(['primary', 'secondary', 'acute', 'chronic', 'syndrome', 'disease', 'disorder', 'infection', 'deficiency', 'failure', 'hemorrhage', 'haemorrhage',
  'cancer', 'carcinoma', 'injury', 'fracture', 'poisoning', 'toxicity', 'overdose', 'withdrawal', 'anemia', 'anaemia', 'type', 'with', 'from', 'and', 'the']);
export function nameForms(name) {
  const full = String(name || '').toLowerCase().replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (full.length < 3) return [];
  const words = full.split(/[\s-]+/).filter(Boolean);
  const long = words.filter(w => w.length >= 6 && !NAME_STOP.has(w));
  const initials = words.length >= 3 ? words.map(w => w[0]).join('') : '';
  return [...new Set([full, ...(long.length === 1 ? long : []), ...(initials.length >= 3 ? [initials] : [])])];
}
const formsRe = forms => forms.map(f => esc(f).replace(/\\ /g, '[\\s-]+')).join('|');

export function rulesOut(text, name) {
  const forms = nameForms(name);
  const t = String(text || '').toLowerCase();
  if (!forms.length || !t) return false;
  const n = `(?:${formsRe(forms)})`;
  return new RegExp(`\\b(?:not|isn'?t|is not|wasn'?t|can'?t be|cannot be|couldn'?t be|wouldn'?t be|doesn'?t sound like|don'?t think it'?s|rule[sd]? out|ruling out|exclude[sd]?|less likely)\\s+(?:(?:a|an|the|it'?s|its|going with|going for|for|really|just)\\s+){0,2}${n}\\b`).test(t)
    || new RegExp(`\\b${n}\\b[^.?!;]{0,12}\\b(?:is |seems |looks )?(?:unlikely|less likely|ruled out|excluded|doesn'?t fit|does not fit|is out)\\b`).test(t)
    || new RegExp(`\\b(?:could|might|may) be (?:a |an )?${n}\\b[^.?!;]{0,20}\\bbut\\b[^.?!;]{0,40}\\b(?:no|not|doesn'?t|isn'?t|without|never)\\b`).test(t);
}

export function choseIt(text, name) {
  const forms = nameForms(name);
  const t = String(text || '').toLowerCase();
  if (!forms.length || !t) return false;
  const re = new RegExp(`\\b(?:going (?:with|for)|go (?:with|for)|i'?ll (?:go|say|pick|put)|i'?m (?:going|picking|saying)|pick(?:ing)?|choose|lean(?:ing)? (?:to|towards?)|it'?s|it is|that'?s|this is|thought (?:it|this|that) (?:was|is)|took it for|must be|has to be|probably)\\s+(?:(?:a|an|the|with|for)\\s+)?(?:${formsRe(forms)})\\b`, 'g');
  for (const m of t.matchAll(re)) if (!/\b(?:not|n't|never|no)\s*$/.test(t.slice(Math.max(0, m.index - 8), m.index))) return true;
  return false;
}

const NOT_KNOWN = /\b(?:(?:i\s+)?(?:don'?t|do not|didn'?t|did not)\s+(?:actually\s+|really\s+|even\s+)?(?:know|remember|recall)|no idea|never (?:learnt|learned|knew)|can'?t remember|forgot|i'?m not sure (?:which|what|how|when|whether|if))\b(?![^.?!;]{0,30}\b(?:apart|between|from each other)\b)/i;
const TOOK_FOR = /\bthought (?:it|this|that) (?:was|is|were)\b|\bmistook\b|\bmistaken for\b|\btook (?:it|this|that) (?:for|as)\b/i;

export function consideredNotConfused(x, { words = '', mixed = [], picked = null, fallback = null } = {}) {
  if (!x || x.cause !== 'confusion') return { item: x, changed: false, why: null };
  const text = [x.cause_quote, words].filter(Boolean).join(' ');
  if (!text.trim()) return { item: x, changed: false, why: null };
  const names = [...new Set([x.mixed_with, ...(Array.isArray(mixed) ? mixed : [mixed])].filter(n => typeof n === 'string' && n.trim()))];
  const mixUp = COULD_NOT_TELL.test(text);
  let why = null;
  if (!mixUp) {
    const pickedIt = n => (picked && nameForms(picked).some(f => nameForms(n).includes(f))) || choseIt(text, n);
    if (names.length && names.some(n => rulesOut(text, n)) && !names.some(pickedIt)) why = 'ruled_out';
    else if (!TOOK_FOR.test(text) && NOT_KNOWN.test(text) && !names.some(pickedIt)) why = 'not_known';
  }
  if (!why) return { item: x, changed: false, why: null };
  const cause = CAUSES.includes(fallback) && fallback !== 'confusion' ? fallback : 'missing_fact';
  return { item: { ...x, cause, cause_inferred: typeof x.cause_inferred === 'boolean' ? true : 1, mixed_with: null, cause_considered: why }, changed: true, why };
}
