
const MO = 'mo';

// British to US spelling, applied to lower-case text (keys and the naming rule). Order matters: whole words first.
// 'oe' forms only at a word start or after 'gastro' / 'myx', so US words ('gastroesophageal') never change.
export const US = [
  // The genus Haemophilus keeps its spelling in US usage (CDC: Haemophilus influenzae type b), so 'Hemophilus' is
  // turned back; haemophilia, haematology and the rest become US forms.
  [/dyslipidaem/g, 'dyslipidem'], [/leukaem/g, 'leukem'], [/ischaem/g, 'ischem'], [/haem(?!ophilus)/g, 'hem'], [/(?<![a-z])hemophilus/g, 'haemophilus'], [/aemi/g, 'emi'],
  [/(?<![a-z])phaeo/g, 'pheo'], [/(?<![a-z])paracetamol/g, 'acetaminophen'], [/(?<![a-z])adrenaline/g, 'epinephrine'], [/(?<![a-z])noradrenaline/g, 'norepinephrine'],
  [/(?<![a-z])frusemide/g, 'furosemide'], [/(?<![a-z])lignocaine/g, 'lidocaine'],
  [/(?<![a-z])salbutamol/g, 'albuterol'], [/(?<![a-z])rifampicin/g, 'rifampin'], [/aciclovir/g, 'acyclovir'], [/(?<![a-z])ciclosporin/g, 'cyclosporine'],
  [/(?<![a-z])glibenclamide/g, 'glyburide'], [/(?<![a-z])pethidine/g, 'meperidine'], [/(?<![a-z])cefalexin/g, 'cephalexin'],
  [/(?<![a-z])isoprenaline/g, 'isoproterenol'], [/(?<![a-z])glyceryl trinitrate/g, 'nitroglycerin'], [/(?<![a-z])co-?amoxiclav/g, 'amoxicillin clavulanate'],
  [/(?<![a-z])sodium valproate/g, 'valproate'], [/(?<![a-z])colecalciferol/g, 'cholecalciferol'],
  [/(?<![a-z])oedem|(?<=myx)oedem/g, 'edem'], [/(?<![a-z])oesoph|(?<=gastro-?)oesoph/g, 'esoph'], [/(?<![a-z])oestr/g, 'estr'],
  [/paed/g, 'ped'], [/gynaec/g, 'gynec'], [/(?<![a-z])foet/g, 'fet'],
  [/rrhoea/g, 'rrhea'], [/pnoea/g, 'pnea'], [/coeliac/g, 'celiac'], [/tumour/g, 'tumor'], [/behaviour/g, 'behavior'],
  [/fibre/g, 'fiber'], [/centre/g, 'center'], [/sulph/g, 'sulf'], [/caesar/g, 'cesar'], [/manoeuvre/g, 'maneuver'],
  [/anaesth/g, 'anesth'], [/(?<![a-z])leucocyt/g, 'leukocyt'], [/faec/g, 'fec'], [/(?<![a-z])aetiol/g, 'etiol'],
];

export const CUT = /(\.\.\.|…)\s*$/;
const MARKS = /[̀-ͯ]/g;

// Route words a topic id must never be (#map/unit/..., #map/focus/..., #map/bench).
export const RESERVED = ['unit', 'focus', 'bench'];

/** The matching key: lower case, US spelling, no possessives or punctuation, plurals made singular. Never shown. */
export function norm(s) {
  let t = String(s ?? '').normalize('NFKD').replace(MARKS, '').toLowerCase().trim().replace(CUT, '');
  t = t.replace(/['’]s\b/g, '').replace(/['’]/g, '').replace(/&|\+/g, ' and ');
  // A hyphenated prefix joins its word ('gastro-oesophageal', 'non-ST-elevation'), as US spelling writes it.
  t = t.replace(/\b(gastro|cardio|neuro|immuno|electro|hepato|nephro|pseudo|non|post|pre|anti)-(?=[a-z])/g, '$1');
  for (const [re, to] of US) t = t.replace(re, to);
  t = t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(the|a|an) /, '');
  return t.split(' ').map(singular).join(' ');
}

// -is, -us and -ss endings stay ('pneumocystis', 'mellitus', 'abscess'); short words stay ('ms', 'gbs').
function singular(w) {
  if (w.length <= 3) return w;
  return w.replace(/ies$/, 'y').replace(/(x|ch|sh)es$/, '$1').replace(/([^siu])s$/, '$1');
}

export const isCut = s => CUT.test(String(s ?? ''));

export function namedIn(text, names) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  let key = null;
  for (const x of names || []) {
    const n = x && typeof x === 'object' ? x : { alias: x, kind: null };
    const s = String(n.alias ?? '').trim();
    if (!s) continue;
    if (n.kind === 'abbrev' || s.replace(/[^A-Za-z0-9]/g, '').length <= 3) {
      const as = /[A-Z]/.test(s) ? s : s.toUpperCase();
      const esc = as.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?:^|[^A-Za-z0-9])${esc}(?![A-Za-z0-9])`).test(raw)) return s;
      continue;
    }
    const k = norm(s);
    if (!k) continue;
    if (key == null) key = ` ${norm(raw)} `;
    if (key.includes(` ${k} `)) return s;
  }
  return null;
}

export const keyOf = s => ({ key: norm(s), cut: isCut(s) });

/** A display name in US spelling, keeping its capitals ('Iron deficiency anaemia' -> 'Iron deficiency anemia'). */
// UK drug names of more than one word, for toUS (which otherwise goes word by word).
const US_PHRASES = [[/\bglyceryl trinitrate\b/gi, 'nitroglycerin'], [/\bco-?amoxiclav\b/gi, 'amoxicillin-clavulanate'], [/\bsodium valproate\b/gi, 'valproate']];
export function toUS(name) {
  let s = String(name ?? '');
  for (const [re, to] of US_PHRASES) s = s.replace(re, m => (m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to));
  return s.replace(/[A-Za-z]+/g, word => {
    let low = word.toLowerCase();
    for (const [re, to] of US) low = low.replace(re, to);
    if (low === word.toLowerCase()) return word;
    if (word === word.toUpperCase()) return low.toUpperCase();
    return word[0] === word[0].toUpperCase() ? low[0].toUpperCase() + low.slice(1) : low;
  });
}

/** Id slug of a canonical name: kebab case, no US rewriting, no singularising; a route word gets '-topic'. */
export function slug(name) {
  const s = String(name ?? '').normalize('NFKD').replace(MARKS, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
  return RESERVED.includes(s) ? `${s}-topic` : s;
}

export const slugId = (user, name) => (user === MO ? slug(name) : `${user}.${slug(name)}`);
/** A per-user id from a content-derived key ('anki:200', 'label:ascites'). */
export const userKey = (user, key) => (user === MO ? String(key) : `${user}.${key}`);

// Words that join a head to what follows it ('Splenic infarct from SLE', 'Vagal maneuvers in AVNRT').
const HEAD = /\s+(?:with|in|from|on|causing|after|due to|and)\s+/i;
const VS = /\s+(?:vs\.?|versus)\s+/i;
const MAX_SPANS = 60;

/**
 * The parts of a title worth matching, in the order resolveTopic tries them:
 *   {full, parts: [{text, key, via}], vs: [second sides]}
 * via is full | colon | vs | head | bracket | span. A second side of 'X vs Y' goes to vs[] (links' look-alikes).
 */
export function candidates(text) {
  const full = String(text ?? '').trim();
  const parts = [];
  const vs = [];
  const seen = new Set();
  const add = (t, via) => {
    const s = String(t ?? '').trim().replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '');
    const key = norm(s);
    if (!key || seen.has(key)) return;
    seen.add(key);
    parts.push({ text: s, key, via });
  };
  add(full, 'full');
  const clean = full.replace(CUT, '');
  const segments = [clean];
  if (clean.includes(':')) {
    const i = clean.indexOf(':');
    const before = clean.slice(0, i), after = clean.slice(i + 1);
    add(before, 'colon');
    segments.push(before, after);
  }
  // With a colon, the part before it counts only whole ('Pronator drift'); heads come from what follows it, so a
  // learning point before the colon ('Hyperprolactinemia on aripiprazole: ...') never places by its first word.
  const colon = segments.length > 1;
  for (const [n, seg] of segments.entries()) {
    const sides = seg.split(VS);
    if (sides.length > 1) {
      add(sides[0], 'vs');
      for (const s of sides.slice(1)) { const v = s.trim(); if (v && !vs.includes(v)) vs.push(v); }
    }
    if (colon && n !== 2) continue;
    for (const side of [sides[0], seg]) {
      const h = side.split(HEAD);
      if (h.length > 1) add(h[0], 'head');
    }
  }
  const br = /\(([^)]+)\)/.exec(clean);
  if (br) {
    add(br[1], 'bracket');
    add(clean.replace(/\s*\([^)]*\)\s*/g, ' '), 'bracket');
  }
  // Spans never reach into the second side of 'X vs Y': that side is the look-alike, not the topic.
  const firstSides = (clean.includes(':') ? segments.slice(1) : [clean]).map(seg => seg.split(VS)[0]);
  for (const s of spans(firstSides.join(' : '))) add(s, 'span');
  return { full, parts, vs };
}

// Every contiguous 1-5 word span of the text's key, longest first, at most 60. One-word spans of 3 characters
// or fewer are dropped unless the original wrote them in capitals ('MS', 'AF').
export function spans(text) {
  const original = String(text ?? '');
  const caps = new Set((original.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) || []).map(w => w.toLowerCase()));
  // Each ':'-separated piece is spanned on its own, so no span runs across the colon.
  const words = original.split(':').map(p => norm(p)).filter(Boolean).join(' | ').split(' ').filter(Boolean);
  const out = [];
  for (let len = Math.min(5, words.length); len >= 1 && out.length < MAX_SPANS; len--) {
    for (let i = 0; i + len <= words.length && out.length < MAX_SPANS; i++) {
      const w = words.slice(i, i + len);
      if (w.some(x => x === '|') || JOINS.has(w[0]) || JOINS.has(w[w.length - 1])) continue;
      const span = w.join(' ');
      if (len === 1 && span.length <= 3 && !caps.has(span)) continue;
      if (len === 1 && STOP.has(span)) continue;
      out.push(span);
    }
  }
  return out;
}

// Small words a span never starts or ends with ('in ms', 'sign in').
const JOINS = new Set(['in', 'a', 'an', 'of', 'on', 'with', 'from', 'and', 'or', 'the', 'to', 'for', 'vs', 'versus', 'due', 'after', 'causing', 'by', 'at']);

// Words that never name a topic on their own.
export const STOP = new Set(['with', 'from', 'causing', 'after', 'due', 'and', 'the', 'for', 'during', 'versus', 'sign', 'signs',
  'management', 'treatment', 'workup', 'approach', 'diagnosis', 'next', 'step', 'best', 'first', 'line', 'initial', 'test', 'patient',
  'disease', 'syndrome', 'disorder', 'unknown', 'status', 'prolonged', 'risk', 'factor', 'finding', 'mechanism', 'cause', 'type']);

/** A key's content words (no stop words, at least 3 characters). */
export const contentWords = key => String(key ?? '').split(' ').filter(w => w.length >= 3 && !STOP.has(w));

// Tokens that tell two conditions apart. Prefixes are checked within a word ('hyperthyroidism', 'hypothyroidism').
const DISC_WORDS = new Set(['hyper', 'hypo', 'micro', 'macro', 'acute', 'chronic', 'subacute', 'primary', 'secondary', 'tertiary',
  'central', 'peripheral', 'nephrogenic', 'type', 'i', 'ii', 'iii', 'iv', 'left', 'right', 'upper', 'lower', 'anterior', 'posterior',
  'early', 'late', 'pre', 'post', 'congenital', 'acquired', 'benign', 'malignant', 'juvenile', 'adult', 'neonatal', 'partial', 'complete',
  'unilateral', 'bilateral', 'inferior', 'superior', 'proximal', 'distal', 'conjugated', 'unconjugated', 'transudative', 'exudative']);
const DISC_PREFIX = /^(hyper|hypo|micro|macro|pre|post|sub|epi|intra|extra|endo|peri|myo|para|pseudo|non|anti)/;
const LETTER_AFTER = ['hepatitis', 'vitamin', 'type', 'group', 'factor', 'class', 'stage', 'grade'];

const CHILD_HOME = 'neonates-genetics-and-child-development';
export const CONTEXT_HOME = {
  pregnancy: 'obstetrics', pregnant: 'obstetrics', gravid: 'obstetrics', gravida: 'obstetrics', antepartum: 'obstetrics', intrapartum: 'obstetrics',
  neonatal: CHILD_HOME, neonate: CHILD_HOME, neonates: CHILD_HOME, newborn: CHILD_HOME, newborns: CHILD_HOME, infant: CHILD_HOME,
  infants: CHILD_HOME, infancy: CHILD_HOME, sickle: 'haematology', bipolar: null,
};
const PAEDIATRICS = 4;
export const CONTEXT_DISCIPLINE = Object.fromEntries(Object.entries(CONTEXT_HOME).filter(([, c]) => c === CHILD_HOME).map(([w]) => [w, PAEDIATRICS]));
// A map not yet moved to v2 still has release 1's ids: the same homes under their old names.
const OLD_HOME = { [CHILD_HOME]: 'paediatrics', haematology: 'haematology-and-oncology' };
/**
 * The setting words (CONTEXT_HOME) the text names outside the matched key's own words: anywhere (a head part:
 * 'Hypertension' in 'Hypertension in pregnancy'), or with near only within three words before it or two after it
 * (a word span, as spanQualified looks).
 */
export function contextWords(text, key, { near = false } = {}) {
  const k = norm(key).split(' ').filter(Boolean);
  const own = new Set(k);
  const out = new Set();
  for (const piece of String(text ?? '').split(':')) {
    const w = norm(piece).split(' ').filter(Boolean);
    if (!near) { for (const t of w) if (t in CONTEXT_HOME && !own.has(t)) out.add(t); continue; }
    for (let i = 0; i + k.length <= w.length; i++) {
      if (k.some((x, j) => w[i + j] !== x)) continue;
      for (const t of [...w.slice(Math.max(0, i - 3), i), ...w.slice(i + k.length, i + k.length + 2)]) if (t in CONTEXT_HOME && !own.has(t)) out.add(t);
    }
  }
  return [...out];
}
/** Does a setting word keep this hit off (its topic is outside the word's own category)? hit: {category_id, category2_id}. */
export const contextBars = (words, hit) => (words || []).some(w => {
  const home = CONTEXT_HOME[w];
  if (home == null) return true;
  const homes = OLD_HOME[home] ? [home, OLD_HOME[home]] : [home];
  if (homes.includes(hit.category_id) || (hit.category2_id != null && homes.includes(hit.category2_id))) return false;
  return !(CONTEXT_DISCIPLINE[w] && (Number(hit.disciplines) & CONTEXT_DISCIPLINE[w]));
});

const SPAN_QUALIFIERS = new Set(['gestational', 'pregestational', 'subclinical', 'unstable', 'stable', 'hemorrhagic', 'haemorrhagic', 'ischemic', 'ischaemic',
  'urge', 'stress', 'overflow', 'functional', 'open', 'closed', 'closure', 'peripartum', 'postpartum', 'perinatal', 'prenatal', 'postnatal', 'postoperative',
  'drug', 'induced', 'iatrogenic', 'familial', 'hereditary', 'idiopathic', 'reactive', 'toxic', 'refractory', 'resistant', 'occult', 'latent',
  'severe', 'malignant', 'transient', 'variant', 'atypical', 'pediatric', 'paediatric', 'childhood', 'infantile', 'maternal', 'fetal', 'cyclic', 'paradoxical',
  'pulmonary', 'portal', 'intracranial', 'tension', 'septic', 'cardiogenic', 'hypovolemic', 'neurogenic', 'obstructive', 'distributive', 'ectopic',
  'molar', 'viral', 'bacterial', 'fungal', 'spontaneous', 'systolic', 'diastolic', 'preserved', 'reduced', 'lewy', 'vascular', 'frontotemporal', 'acalculous']);

/**
 * True when a word span of `text` that matched `key` sits next to a word that makes it another condition (within
 * three words before it or two after it, in the same ':' piece): 'Gestational diabetes mellitus' against
 * 'diabetes mellitus', 'Secondary hyperparathyroidism in CKD' against 'hyperparathyroidism'.
 */
export function spanQualified(text, key) {
  const k = norm(key).split(' ').filter(Boolean);
  if (!k.length) return false;
  for (const piece of String(text ?? '').split(':')) {
    const w = norm(piece).split(' ').filter(Boolean);
    for (let i = 0; i + k.length <= w.length; i++) {
      if (k.some((x, j) => w[i + j] !== x)) continue;
      const near = [...w.slice(Math.max(0, i - 3), i), ...w.slice(i + k.length, i + k.length + 2)];
      if (near.some(t => DISC_WORDS.has(t) || SPAN_QUALIFIERS.has(t))) return true;
    }
  }
  return false;
}

/** True when two names differ in a telling-apart word: matching across one is a clinical error. */
export function isDiscriminatorDiff(a, b) {
  const ta = norm(a).split(' ').filter(Boolean);
  const tb = norm(b).split(' ').filter(Boolean);
  const sa = new Set(ta), sb = new Set(tb);
  const diff = [...ta.filter(t => !sb.has(t)), ...tb.filter(t => !sa.has(t))];
  if (diff.some(t => DISC_WORDS.has(t) || /^\d+$/.test(t))) return true;
  // The same stem with a different telling-apart prefix, or -itis against -osis.
  for (const x of ta.filter(t => !sb.has(t))) {
    for (const y of tb.filter(t => !sa.has(t))) {
      const px = DISC_PREFIX.exec(x), py = DISC_PREFIX.exec(y);
      if ((px || py) && (px ? x.slice(px[0].length) : x) === (py ? y.slice(py[0].length) : y)) return true;
      if (px && py && px[0] !== py[0]) return true;
      const stem = w => w.replace(/(itis|osis|oma|emia|uria)$/, '');
      if (stem(x) === stem(y) && x !== y && stem(x).length >= 4) return true;
    }
  }
  // A one-sided word that is itself a telling-apart prefix word ('hypertension' against 'pulmonary hypertension' is fine;
  // 'hyperkalemia' against 'kalemia' is not).
  if (diff.some(t => { const p = DISC_PREFIX.exec(t); return p && [...sa, ...sb].includes(t.slice(p[0].length)); })) return true;
  // The letter or number after hepatitis, vitamin, type, group, factor, class, stage or grade.
  for (const w of LETTER_AFTER) {
    const na = ta.indexOf(w), nb = tb.indexOf(w);
    if (na >= 0 && nb >= 0 && ta[na + 1] !== tb[nb + 1]) return true;
  }
  return false;
}
