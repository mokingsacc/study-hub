import { norm, slug, isCut, toUS } from '../../../public/js/shared/names.js';
import { SYSTEMS_V2, S, LEGACY, LEGACY_SPREAD, SPLIT, CHECKLIST_V2, legacySystem } from './systems.js';

const SECTION_OF = {
  [S.cardio]: 'Cardiology', [S.resp]: 'Respiratory', [S.gi]: 'GI and Hepatology', [S.renal]: 'Renal and Acid-Base', [S.endo]: 'Endocrine',
  [S.haem]: 'Haematology and Oncology', [S.id]: 'Infectious Disease', [S.rheum]: 'Rheumatology and MSK', [S.derm]: 'Dermatology',
  [S.neuro]: 'Neurology, Eye and ENT', [S.eye]: 'Neurology, Eye and ENT', [S.ent]: 'Neurology, Eye and ENT', [S.psych]: 'Psychiatry',
  [S.obs]: 'Obstetrics', [S.gyn]: "Gynaecology and Men's Health", [S.uro]: "Gynaecology and Men's Health", [S.child]: 'Paediatrics',
  [S.immuno]: 'Immunology and Allergy', [S.em]: 'Emergency and Toxicology', [S.surg]: 'Surgery', [S.biostat]: 'Ethics, Safety and Biostatistics',
  [S.ethics]: 'Ethics, Safety and Biostatistics', [S.prev]: 'Prevention, Nutrition and Geriatrics',
};
export const STEP2_CATEGORIES = Object.freeze(SYSTEMS_V2.map(([name, short_name, cms_subject, checklist_system], i) => Object.freeze({
  id: slug(name), name, short_name, sort: i + 1, cms_subject, onenote_section: SECTION_OF[slug(name)], checklist_system,
})));
export const CATEGORY_IDS = STEP2_CATEGORIES.map(c => c.id);
const C = Object.fromEntries(STEP2_CATEGORIES.map(c => [c.name, c.id]));

export const LEGACY_CATEGORIES = Object.freeze([
  'Obstetrics', 'Paediatrics', "Gynaecology and Men's Health", 'Endocrine', 'Cardiology', 'Respiratory', 'Renal and Acid-Base', 'GI and Hepatology',
  'Haematology and Oncology', 'Infectious Disease', 'Immunology and Allergy', 'Neurology, Eye and ENT', 'Psychiatry', 'Emergency and Toxicology',
  'Rheumatology and MSK', 'Dermatology', 'Surgery', 'Prevention, Nutrition and Geriatrics', 'Ethics, Safety and Biostatistics',
].map(name => Object.freeze({ id: slug(name), name, system: LEGACY[slug(name)], split: SPLIT.includes(slug(name)) })));
// An old section name points at its default system; a merged one only as a hint (its topics split by name).
const legacyRows = LEGACY_CATEGORIES.map(c => [[c.name], c.system, c.split ? 0.8 : 1]);
const byId = id => STEP2_CATEGORIES.find(c => c.id === id).name;

// [names, category name or null (a known name with no default), confidence]
const UWORLD_SYSTEM = [
  [['Cardiovascular', 'Cardiovascular System'], 'Cardiology', 1],
  [['Pulmonary & Critical Care', 'Pulmonary', 'Pulmonary and Critical Care', 'Respiratory'], 'Respiratory', 1],
  [['Gastrointestinal & Nutrition', 'Gastrointestinal and Nutrition', 'Gastrointestinal'], 'GI and Hepatology', 0.8],
  [['Renal, Urinary Systems & Electrolytes', 'Renal, Urinary Systems and Electrolytes', 'Renal'], 'Renal, Urinary and Electrolytes', 1],
  [['Endocrine, Diabetes & Metabolism', 'Endocrine, Diabetes and Metabolism', 'Endocrine'], 'Endocrine and Diabetes', 1],
  [['Hematology & Oncology', 'Hematology and Oncology', 'Hematology'], 'Haematology', 0.8],
  [['Infectious Diseases'], 'Infectious Disease', 1],
  [['Allergy & Immunology', 'Allergy/Immunology', 'Allergy and Immunology', 'Immunology'], 'Immunology and Allergy', 1],
  [['Nervous System', 'Neurology'], 'Neurology', 1],
  [['Ophthalmology'], 'Ophthalmology', 1],
  [['Ear, Nose & Throat (ENT)', 'Ear, Nose and Throat (ENT)', 'Ear, Nose & Throat', 'ENT'], 'ENT', 1],
  [['Psychiatric/Behavioral & Substance Use Disorder', 'Psychiatric/Behavioral and Substance Use Disorder', 'Psychiatry'], 'Psychiatry', 1],
  [['Poisoning & Environmental Exposure', 'Poisoning and Environmental Exposure'], 'Emergency, Toxicology and Environment', 1],
  [['Rheumatology/Orthopedics & Sports', 'Rheumatology/Orthopedics and Sports', 'Musculoskeletal'], 'Rheumatology and MSK', 1],
  [['Dermatology'], 'Dermatology', 1],
  [['Pregnancy, Childbirth & Puerperium', 'Pregnancy, Childbirth and Puerperium'], 'Obstetrics', 1],
  [['Female Reproductive System & Breast', 'Female Reproductive System and Breast'], 'Gynaecology and Breast', 1],
  [['Male Reproductive System'], 'Male Reproductive and Urology', 1],
  [['Pediatrics'], 'Neonates, Genetics and Child Development', 0.8],
  [['Genetics', 'Biochemistry & Genetics', 'Biochemistry and Genetics'], 'Neonates, Genetics and Child Development', 0.8],
  [['Social Sciences (Ethics/Legal/Professional)', 'Social Sciences'], 'Ethics and Communication', 1],
  [['Biostatistics & Epidemiology', 'Biostatistics and Epidemiology'], 'Biostatistics and Epidemiology', 1],
  [['Miscellaneous (Multisystem)', 'General Principles'], null, 1],
];
const UWORLD_SUBJECT = [
  [['Surgery'], 'Surgery, Trauma and Perioperative', 0.6],
  [['Medicine', 'Internal Medicine', 'Pediatrics', 'Obstetrics & Gynecology', 'Obstetrics and Gynecology', 'Psychiatry', 'Neurology',
    'Family Medicine', 'Emergency Medicine', 'Ethics'], null, 1],
];
// The checklist's own systems (systems.js CHECKLIST_V2, which unitSystemFor reads); 'Rapid differentials' has no units.
const CHECKLIST_SYSTEM = [...CHECKLIST_V2.map(([names, id]) => [names, byId(id)]), [['Rapid differentials'], null]];
// Assumed from public knowledge: AMBOSS's section names sit behind its login.
const AMBOSS = [
  [['Cardiology'], 'Cardiology'], [['Pulmonology'], 'Respiratory'], [['Nephrology'], 'Renal, Urinary and Electrolytes'],
  [['Urology'], 'Male Reproductive and Urology'], [['Gastroenterology', 'Hepatology'], 'GI and Hepatology'], [['Endocrinology'], 'Endocrine and Diabetes'],
  [['Hematology'], 'Haematology'], [['Oncology'], 'Haematology', 0.6], [['Infectious diseases', 'Microbiology'], 'Infectious Disease'],
  [['Immunology'], 'Immunology and Allergy'], [['Neurology'], 'Neurology'], [['Ophthalmology'], 'Ophthalmology'], [['Otolaryngology'], 'ENT'],
  [['Psychiatry'], 'Psychiatry'], [['Emergency medicine', 'Toxicology'], 'Emergency, Toxicology and Environment'],
  [['Rheumatology', 'Orthopedics'], 'Rheumatology and MSK'], [['Dermatology'], 'Dermatology'], [['Obstetrics'], 'Obstetrics'],
  [['Gynecology'], 'Gynaecology and Breast'], [['Pediatrics', 'Neonatology', 'Genetics'], 'Neonates, Genetics and Child Development'],
  [['General surgery', 'Trauma surgery', 'Anesthesiology'], 'Surgery, Trauma and Perioperative'], [['Public health', 'Geriatrics', 'Nutrition'], 'Prevention and Geriatrics'],
  [['Epidemiology', 'Biostatistics'], 'Biostatistics and Epidemiology'], [['Ethics'], 'Ethics and Communication'], [['Pharmacology'], null],
];

export const VOCABS = ['hub_system', 'onenote_section', 'uworld_system', 'checklist_system', 'amboss', 'uworld_subject', 'other'];

export const CATEGORY_ALIASES = Object.freeze((() => {
  const out = [];
  const seen = new Set();
  const push = (vocab, table, ids = false) => {
    for (const [names, cat, conf = 1] of table) {
      for (const alias of names) {
        const alias_key = norm(alias);
        if (seen.has(`${vocab}|${alias_key}`)) continue;
        seen.add(`${vocab}|${alias_key}`);
        out.push(Object.freeze({ vocab, alias, alias_key, category_id: cat ? (ids ? cat : C[cat]) : null, confidence: conf }));
      }
    }
  };
  for (const v of ['hub_system', 'onenote_section']) {
    push(v, STEP2_CATEGORIES.map(c => [[c.name], c.id]), true);
    push(v, legacyRows, true);
  }
  push('uworld_system', UWORLD_SYSTEM);
  push('checklist_system', CHECKLIST_SYSTEM);
  push('amboss', AMBOSS);
  push('uworld_subject', UWORLD_SUBJECT);
  return out;
})());

/**
 * The category a system name points at, from any vocabulary: {category_id, confidence, vocab, known: true}, with
 * category_id null for a known name with no default ('General Principles'), or null for an unknown name.
 * A name or id of a merged old category ('Neurology, Eye and ENT') points at its default system and lists every
 * system its topics went to in category_ids. A label cut short ('Renal, Urinary Syst...') matches when exactly
 * one category's alias keys start with it.
 */
export function categoryFor(label, vocab = null) {
  if (label == null || label === '') return null;
  const key = norm(label);
  if (!key) return null;
  const order = vocab ? [vocab] : VOCABS;
  const spread = (r, id) => (LEGACY_SPREAD[id] ? { ...r, category_ids: [...LEGACY_SPREAD[id]] } : r);
  for (const v of order) {
    const hit = CATEGORY_ALIASES.find(a => a.vocab === v && a.alias_key === key);
    if (hit) {
      const old = LEGACY_CATEGORIES.find(c => norm(c.name) === key);
      return spread({ category_id: hit.category_id, confidence: hit.confidence, vocab: v, known: true }, old && hit.category_id === old.system ? old.id : null);
    }
  }
  // A category id given as is ('cardiology'), or an old one ('haematology-and-oncology').
  if (!vocab && CATEGORY_IDS.includes(String(label))) return { category_id: String(label), confidence: 1, vocab: 'id', known: true };
  if (!vocab && LEGACY[String(label)]) {
    const id = String(label);
    return spread({ category_id: LEGACY[id], confidence: SPLIT.includes(id) ? 0.8 : 1, vocab: 'id', known: true, legacy: true }, id);
  }
  if (isCut(label) && key.length >= 4) {
    const hits = CATEGORY_ALIASES.filter(a => order.includes(a.vocab) && a.alias_key.startsWith(key));
    const cats = [...new Set(hits.map(h => h.category_id))];
    if (hits.length && cats.length === 1) return { category_id: cats[0], confidence: Math.min(...hits.map(h => h.confidence)), vocab: hits[0].vocab, known: true, cut: true };
  }
  return null;
}

// Abbreviations, by category ('*' for any). One key can mean two things in two categories ('MS', 'GBS', 'PE', 'ASD').
export const ABBREV = Object.freeze({
  '*': {
    copd: 'Chronic obstructive pulmonary disease', ards: 'Acute respiratory distress syndrome', dvt: 'Deep vein thrombosis', dka: 'Diabetic ketoacidosis',
    hhs: 'Hyperosmolar hyperglycemic state', aki: 'Acute kidney injury', ckd: 'Chronic kidney disease', sle: 'Systemic lupus erythematosus',
    hiv: 'HIV infection', tb: 'Tuberculosis', uti: 'Urinary tract infection', ibd: 'Inflammatory bowel disease', gerd: 'Gastroesophageal reflux disease',
    dic: 'Disseminated intravascular coagulation', ttp: 'Thrombotic thrombocytopenic purpura', hus: 'Hemolytic uremic syndrome',
    itp: 'Immune thrombocytopenia', hit: 'Heparin-induced thrombocytopenia', siadh: 'Syndrome of inappropriate antidiuretic hormone secretion',
    men: 'Multiple endocrine neoplasia', af: 'Atrial fibrillation', acs: 'Acute coronary syndrome', aaa: 'Abdominal aortic aneurysm',
    sjs: 'Stevens-Johnson syndrome', ten: 'Toxic epidermal necrolysis', nms: 'Neuroleptic malignant syndrome', ptsd: 'Posttraumatic stress disorder',
    ocd: 'Obsessive-compulsive disorder', adhd: 'Attention-deficit/hyperactivity disorder', gad: 'Generalized anxiety disorder', mdd: 'Major depressive disorder',
    sbo: 'Small bowel obstruction', cmv: 'Cytomegalovirus infection', ebv: 'Epstein-Barr virus infection', hsv: 'Herpes simplex virus infection',
    rsv: 'Respiratory syncytial virus infection', mrsa: 'Methicillin-resistant Staphylococcus aureus', cap: 'Community-acquired pneumonia', tia: 'Transient ischemic attack',
  },
  [S.cardio]: {
    as: 'Aortic stenosis', ar: 'Aortic regurgitation', ms: 'Mitral stenosis', mr: 'Mitral regurgitation', svt: 'Supraventricular tachycardia',
    vt: 'Ventricular tachycardia', nstemi: 'Non-ST-elevation myocardial infarction', stemi: 'ST-elevation myocardial infarction', chf: 'Heart failure',
    hcm: 'Hypertrophic cardiomyopathy', avnrt: 'Atrioventricular nodal reentrant tachycardia', wpw: 'Wolff-Parkinson-White syndrome',
    pda: 'Patent ductus arteriosus', vsd: 'Ventricular septal defect', asd: 'Atrial septal defect', pad: 'Peripheral artery disease', pe: 'Pulmonary embolism',
    tof: 'Tetralogy of Fallot', tga: 'Transposition of the great arteries',
  },
  [S.resp]: { pe: 'Pulmonary embolism', osa: 'Obstructive sleep apnea', ild: 'Interstitial lung disease', pcp: 'Pneumocystis pneumonia', rds: 'Neonatal respiratory distress syndrome' },
  [S.renal]: { atn: 'Acute tubular necrosis', ain: 'Acute interstitial nephritis', psgn: 'Poststreptococcal glomerulonephritis', rta: 'Renal tubular acidosis',
    vur: 'Vesicoureteral reflux', puv: 'Posterior urethral valves', adpkd: 'Autosomal dominant polycystic kidney disease' },
  [S.endo]: { di: 'Diabetes insipidus', cah: 'Congenital adrenal hyperplasia', men: 'Multiple endocrine neoplasia' },
  [S.gi]: { uc: 'Ulcerative colitis', pud: 'Peptic ulcer disease', sbp: 'Spontaneous bacterial peritonitis', psc: 'Primary sclerosing cholangitis',
    pbc: 'Primary biliary cholangitis', nafld: 'Nonalcoholic fatty liver disease', hcc: 'Hepatocellular carcinoma', crc: 'Colorectal cancer', fap: 'Familial adenomatous polyposis' },
  [S.haem]: { cml: 'Chronic myeloid leukemia', cll: 'Chronic lymphocytic leukemia', aml: 'Acute myeloid leukemia', all: 'Acute lymphoblastic leukemia' },
  [S.neuro]: { ms: 'Multiple sclerosis', gbs: 'Guillain-Barre syndrome', als: 'Amyotrophic lateral sclerosis', sah: 'Subarachnoid hemorrhage',
    nph: 'Normal pressure hydrocephalus' },
  [S.eye]: { crao: 'Central retinal artery occlusion', crvo: 'Central retinal vein occlusion', amd: 'Age-related macular degeneration' },
  [S.ent]: { bppv: 'Benign paroxysmal positional vertigo', pta: 'Peritonsillar abscess', rpa: 'Retropharyngeal abscess', om: 'Otitis media' },
  [S.obs]: { gbs: 'Group B streptococcus', pe: 'Preeclampsia', pprom: 'Preterm prelabor rupture of membranes', gdm: 'Gestational diabetes mellitus',
    iugr: 'Fetal growth restriction', fgr: 'Fetal growth restriction', hellp: 'HELLP syndrome' },
  [S.child]: { gbs: 'Group B streptococcus', nec: 'Necrotizing enterocolitis', sids: 'Sudden infant death syndrome', ddh: 'Developmental dysplasia of the hip',
    scfe: 'Slipped capital femoral epiphysis', asd: 'Autism spectrum disorder', rds: 'Neonatal respiratory distress syndrome', ttn: 'Transient tachypnea of the newborn',
    vsd: 'Ventricular septal defect', pda: 'Patent ductus arteriosus', tof: 'Tetralogy of Fallot', tga: 'Transposition of the great arteries' },
  [S.gyn]: { pid: 'Pelvic inflammatory disease', pcos: 'Polycystic ovary syndrome', aub: 'Abnormal uterine bleeding', cin: 'Cervical intraepithelial neoplasia' },
  [S.uro]: { bph: 'Benign prostatic hyperplasia' },
  [S.id]: { gbs: 'Group B streptococcus', pcp: 'Pneumocystis pneumonia', sti: 'Sexually transmitted infection' },
  [S.rheum]: { ra: 'Rheumatoid arthritis', gca: 'Giant cell arteritis', pmr: 'Polymyalgia rheumatica', ddh: 'Developmental dysplasia of the hip',
    scfe: 'Slipped capital femoral epiphysis', oa: 'Osteoarthritis' },
  [S.derm]: { bcc: 'Basal cell carcinoma', scc: 'Squamous cell carcinoma of the skin' },
  [S.psych]: { asd: 'Autism spectrum disorder' },
  [S.biostat]: { nnt: 'Number needed to treat', nnh: 'Number needed to harm', arr: 'Absolute risk reduction', rrr: 'Relative risk reduction',
    rr: 'Relative risk', or: 'Odds ratio', ppv: 'Positive predictive value', npv: 'Negative predictive value', ci: 'Confidence interval' },
});

/** The full name for an abbreviation within a category (the category's own meaning first), or null. */
export function expandAbbrev(token, categoryId = null) {
  const k = norm(token);
  if (!k) return null;
  const cat = legacySystem(categoryId) || categoryId;   // an old category id reads as its system
  return (cat && ABBREV[cat] && ABBREV[cat][k]) || ABBREV['*'][k] || null;
}

// ---------------------------------------------------------------- units

export const LANE_OVERRIDES = Object.freeze([
  { lane: 'A', why: 'Decision 9: biostatistics is 3-5% of Step 2', test: key => /\bsensitivity\b/.test(key) && /\bspecificity\b/.test(key) },
  { lane: 'A', why: 'Decision 9: biostatistics is 3-5% of Step 2', test: key => /\bnnt\b/.test(key) && /\b(arr|rr)\b/.test(key) },
]);

export function laneFor(unit) {
  const lane = unit && unit.lane ? unit.lane : null;
  if (!unit || (unit.kind && unit.kind !== 'checklist')) return { lane };
  const key = norm(unit.name);
  const o = LANE_OVERRIDES.find(x => x.test(key));
  return o && o.lane !== lane ? { lane: o.lane, why: o.why } : { lane };
}

export const PSEUDO_LANE = { onenote_core: 'B', onenote_mehlman: 'C' };

// The checklist writes a unit's conditions as 'Prolactinoma · acromegaly · MEN · gastrinoma' or 'Valves — AS · AR'.
const UNIT_SPLIT = /\s+·\s+|\s+—\s+|\s*;\s*|,\s+/;
const SLASH = /\s*\/\s*/;
// Heart defects in a unit make its 'ASD' the atrial septal defect, whatever the category ('ToF · TGA · VSD · ASD · PDA').
const HEART_DEFECTS = new Set(['vsd', 'pda', 'tof', 'tga', 'avsd', 'coa', 'tapvr', 'hlhs']);
const HEART_ABBREV = { asd: 'Atrial septal defect', vsd: 'Ventricular septal defect', pda: 'Patent ductus arteriosus', tof: 'Tetralogy of Fallot',
  tga: 'Transposition of the great arteries' };
// An abbreviation as the checklist writes it: 2 to 6 letters with at least two capitals ('MS', 'ToF', 'TGA').
const isAbbrev = t => /^[A-Za-z]{2,6}$/.test(t) && (t.match(/[A-Z]/g) || []).length >= 2;
// 'ITP / TTP' splits; 'symptomatic/ruptured AAA' (an adjective sharing the noun) and 'B1/B12/folate/D' (single
// letters) stay whole.
function slashParts(chunk) {
  const parts = chunk.split(SLASH).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return [chunk];
  if (parts.some(p => p.replace(/[^A-Za-z0-9]/g, '').length <= 2)) return [chunk];
  const words = p => p.split(/\s+/).length;
  if (words(parts[0]) === 1 && !isAbbrev(parts[0]) && parts[0] === parts[0].toLowerCase() && words(parts[parts.length - 1]) > 1) return [chunk];
  return parts;
}

/**
 * A unit name pre-split into its likely conditions, abbreviations expanded within the unit's category:
 * [{text, expanded?}]. A heading before ' — ' is dropped when parts follow it ('Valves — AS · AR').
 */
export function splitUnit(name, categoryId = null) {
  let s = String(name ?? '').trim();
  const dash = s.split(/\s+—\s+/);
  if (dash.length > 1 && dash[1].trim()) s = dash.slice(1).join(' — ');
  const out = [];
  const seen = new Set();
  const pieces = s.split(UNIT_SPLIT).flatMap(slashParts).map(p => p.trim()).filter(Boolean);
  const heart = pieces.some(p => HEART_DEFECTS.has(norm(p)));
  const vte = pieces.some(p => /\b(?:dvt|vte)\b|thrombo|embol/.test(norm(p)));
  const htn = pieces.some(p => /hellp|eclampsia|hypertension/.test(norm(p))) && !pieces.some(p => norm(p) === 'preeclampsia');
  const pe = categoryId === 'obstetrics' ? (vte ? 'Pulmonary embolism' : htn ? 'Preeclampsia' : null) : undefined;
  for (const text of pieces) {
    if (seen.has(norm(text))) continue;
    seen.add(norm(text));
    const k = norm(text);
    const expanded = isAbbrev(text) ? (heart && HEART_ABBREV[k]) || (k === 'pe' && pe !== undefined ? pe : expandAbbrev(text, categoryId)) : null;
    out.push(expanded ? { text, expanded } : { text });
  }
  return out;
}

// ---------------------------------------------------------------- the naming rule

export const TOPIC_KINDS = ['condition', 'approach', 'drug', 'organism', 'concept', 'finding', 'procedure'];
export const NAME_MAX = 80;

export const NAMING_RULES = `Topic names (one topic = one thing a Step 2 answer turns on):
1. Name it as an AMBOSS US article would: sentence case, singular. Never a learning point or "X vs Y" (make each a topic and link them); no ":", no "workup", "management", "treatment" or "approach" suffix. An approach topic takes the symptom's or result's name ("Nipple discharge").
2. US spelling ("Anemia", "Esophagus"); British forms are kept as aliases.
3. Eponyms without the possessive ("Crohn disease").
4. The full name is the name; an abbreviation goes in short_name ("Atrioventricular nodal reentrant tachycardia", "AVNRT").
5. Drugs by generic name or class plural ("Beta blockers"); organisms by Latin binomial.
6. At most 80 characters. Prefer finer topics: a subtype a question turns on is its own topic, linked to its look-alike.
Call map_search before every new topic: a synonym is an alias, not a new topic.`;

const SUFFIX = /\b(work-?up|management|treatment|approach|evaluation)\s*$/i;

/** Why a topic name breaks the naming rule (one plain sentence), or null when it is fine. */
export function namingProblem(name, kind = null) {
  if (typeof name !== 'string' || !name.trim()) return 'A topic needs a name.';
  const n = name.trim();
  if (n !== name || /\s{2,}/.test(n)) return 'Write the name without extra spaces.';
  if (n.length > NAME_MAX) return `Topic names are at most ${NAME_MAX} characters; name the condition, not the learning point.`;
  if (n.includes(':')) return 'No ":" in a topic name: name the condition, and put the learning point on the miss.';
  if (/\s(vs\.?|versus)\s/i.test(n)) return 'Never "X vs Y" as a topic: make X and Y each a topic and link them with map_add_link.';
  if (SUFFIX.test(n)) return `Drop the "${SUFFIX.exec(n)[1]}" ending: an approach topic takes the symptom's or result's own name.`;
  if (/['’]s\b/.test(n)) return `Write eponyms without the possessive: "${n.replace(/['’]s\b/g, '')}".`;
  if (n.length > 6 && /^[A-Z0-9][A-Z0-9 \-/]+$/.test(n)) return 'Use the full name; put the abbreviation in short_name.';
  if (n.split(/\s+/).length > 10) return 'That reads like a learning point: name the one condition.';
  if (kind !== 'organism' && toUS(n) !== n) return `Use US spelling: ${toUS(n)}.`;
  return null;
}

// ---------------------------------------------------------------- seeding the vocabulary

/**
 * Planner for code op 'vocab.seed' (POST /api/map/seed/vocab): the 23 systems and their aliases, keyed and
 * idempotent (the 19 old categories of a release-1 map are retired by taxonomy.remap, never here). One read; only missing or changed rows are written, so a second run is a no-op.
 */
export async function planVocabSeed(env, user, args, ctx) {
  const now = ctx.now || Date.now();
  const [cats, aliases] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, short_name, sort, cms_subject, onenote_section, checklist_system, status FROM categories WHERE user_id = ?').bind(user),
    env.DB.prepare('SELECT vocab, alias_key, alias, category_id, confidence FROM category_aliases WHERE user_id = ?').bind(user),
  ]);
  const haveCat = new Map((cats.results || []).map(r => [r.id, r]));
  const haveAlias = new Map((aliases.results || []).map(r => [`${r.vocab}|${r.alias_key}`, r]));
  const rows = [];
  const CAT_COLS = ['name', 'short_name', 'sort', 'cms_subject', 'onenote_section', 'checklist_system'];
  for (const c of STEP2_CATEGORIES) {
    const cur = haveCat.get(c.id);
    const want = Object.fromEntries(CAT_COLS.map(k => [k, c[k]]));
    if (!cur) rows.push({ table: 'categories', op: 'insert', key: { id: c.id }, before: null, after: { ...want, status: 'active', source: 'seed', created_by: 'seed', created_at: now, updated_at: now } });
    else {
      const diff = Object.fromEntries(CAT_COLS.filter(k => cur[k] !== c[k]).map(k => [k, c[k]]));
      if (Object.keys(diff).length) rows.push({ table: 'categories', op: 'update', key: { id: c.id }, before: Object.fromEntries(Object.keys(diff).map(k => [k, cur[k]])), after: { ...diff, updated_at: now } });
    }
  }
  for (const a of CATEGORY_ALIASES) {
    const cur = haveAlias.get(`${a.vocab}|${a.alias_key}`);
    if (!cur) rows.push({ table: 'category_aliases', op: 'insert', key: { vocab: a.vocab, alias_key: a.alias_key }, before: null,
      after: { alias: a.alias, category_id: a.category_id, confidence: a.confidence, source: 'seed', created_by: 'seed', created_at: now } });
    else if (cur.category_id !== a.category_id || cur.confidence !== a.confidence) rows.push({ table: 'category_aliases', op: 'update',
      key: { vocab: a.vocab, alias_key: a.alias_key }, before: { category_id: cur.category_id, confidence: cur.confidence }, after: { category_id: a.category_id, confidence: a.confidence } });
  }
  if (!rows.length) return { noop: true, summary: `The ${STEP2_CATEGORIES.length} categories and their ${CATEGORY_ALIASES.length} names are already set.` };
  const nCat = rows.filter(r => r.table === 'categories').length;
  const summary = `Categories set: ${nCat} categories and ${rows.length - nCat} system names`;
  return {
    rows, count: rows.length, summary,
    events: [{ kind: 'map.resync', target_type: 'map', target_id: 'vocab', summary, undoable: false }],
    reply: { categories: STEP2_CATEGORIES.length, aliases: CATEGORY_ALIASES.length, written: rows.length },
  };
}
