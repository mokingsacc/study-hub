import { norm } from '../../../public/js/shared/names.js';

// The 23 system galaxies, in the decisions' order: [name, short_name, cms_subject, checklist_system, disciplines].
// ids are slug(name) (vocab.js builds STEP2_CATEGORIES from this list; a test pins the ids).
export const SYSTEMS_V2 = Object.freeze([
  ['Cardiology', 'Cardio', 'Internal Medicine', 'Cardiovascular'],
  ['Respiratory', 'Resp', 'Internal Medicine', 'Lungs + Airway'],
  ['GI and Hepatology', 'GI', 'Internal Medicine', 'Gi + Hepatobiliary'],
  ['Renal, Urinary and Electrolytes', 'Renal', 'Internal Medicine', 'Kidney + Acid–Base'],
  ['Endocrine and Diabetes', 'Endo', 'Internal Medicine', 'Endocrine'],
  ['Haematology', 'Haem', 'Internal Medicine', 'Blood + Oncology'],
  ['Infectious Disease', 'ID', 'Internal Medicine', 'Infection'],
  ['Rheumatology and MSK', 'Rheum', 'Internal Medicine', 'Rheum + Msk'],
  ['Dermatology', 'Derm', 'Internal Medicine', 'Derm + Wounds'],
  ['Neurology', 'Neuro', 'Neurology', 'Brain, Spine + Senses'],
  ['Ophthalmology', 'Eye', 'Neurology', 'Brain, Spine + Senses'],
  ['ENT', 'ENT', 'Surgery', 'Brain, Spine + Senses'],
  ['Psychiatry', 'Psych', 'Psychiatry', 'Psychiatry + Substances'],
  ['Obstetrics', 'Obs', 'OBGYN', 'Obstetrics'],
  ['Gynaecology and Breast', 'Gyn', 'OBGYN', "Gyn + Men's Health"],
  ['Male Reproductive and Urology', 'Uro', 'Surgery', "Gyn + Men's Health"],
  ['Neonates, Genetics and Child Development', 'Child', 'Pediatrics', 'Pediatrics + Development'],
  ['Immunology and Allergy', 'Immuno', 'Internal Medicine', 'Immune + Allergy'],
  ['Emergency, Toxicology and Environment', 'EM-tox', 'Emergency Medicine', 'Emergency + Tox'],
  ['Surgery, Trauma and Perioperative', 'Surg', 'Surgery', 'Surgery + Perioperative'],
  ['Biostatistics and Epidemiology', 'Biostat', null, 'Biostats + Epidemiology'],
  ['Ethics and Communication', 'Ethics', null, 'Ethics + Communication'],
  ['Prevention and Geriatrics', 'Prev', 'Family Medicine', 'Screening + Prevention'],
]);

// The v2 ids (slug of each name), spelled out so this file needs nothing but norm.
export const S = Object.freeze({
  cardio: 'cardiology', resp: 'respiratory', gi: 'gi-and-hepatology', renal: 'renal-urinary-and-electrolytes', endo: 'endocrine-and-diabetes',
  haem: 'haematology', id: 'infectious-disease', rheum: 'rheumatology-and-msk', derm: 'dermatology', neuro: 'neurology', eye: 'ophthalmology',
  ent: 'ent', psych: 'psychiatry', obs: 'obstetrics', gyn: 'gynaecology-and-breast', uro: 'male-reproductive-and-urology',
  child: 'neonates-genetics-and-child-development', immuno: 'immunology-and-allergy', em: 'emergency-toxicology-and-environment',
  surg: 'surgery-trauma-and-perioperative', biostat: 'biostatistics-and-epidemiology', ethics: 'ethics-and-communication', prev: 'prevention-and-geriatrics',
});
export const SYSTEM_IDS_V2 = Object.freeze(Object.values(S));
const V2 = new Set(SYSTEM_IDS_V2);

export const LEGACY = Object.freeze({
  obstetrics: S.obs, paediatrics: S.child, 'gynaecology-and-mens-health': S.gyn, endocrine: S.endo, cardiology: S.cardio, respiratory: S.resp,
  'renal-and-acid-base': S.renal, 'gi-and-hepatology': S.gi, 'haematology-and-oncology': S.haem, 'infectious-disease': S.id,
  'immunology-and-allergy': S.immuno, 'neurology-eye-and-ent': S.neuro, psychiatry: S.psych, 'emergency-and-toxicology': S.em,
  'rheumatology-and-msk': S.rheum, dermatology: S.derm, surgery: S.surg, 'prevention-nutrition-and-geriatrics': S.prev,
  'ethics-safety-and-biostatistics': S.ethics,
});
export const LEGACY_IDS = Object.freeze(Object.keys(LEGACY));
// Every v2 system an old category's topics can land in (resolve's category hint takes the whole set).
export const LEGACY_SPREAD = Object.freeze({
  'haematology-and-oncology': [S.haem, S.resp, S.gi, S.endo, S.renal, S.uro, S.gyn, S.derm, S.neuro, S.eye, S.ent, S.rheum],
  'neurology-eye-and-ent': [S.neuro, S.eye, S.ent],
  'gynaecology-and-mens-health': [S.gyn, S.uro],
  'ethics-safety-and-biostatistics': [S.ethics, S.biostat, S.prev],
  paediatrics: [S.child, S.cardio, S.resp, S.gi, S.renal, S.ent, S.neuro, S.rheum, S.id, S.derm, S.psych, S.haem, S.endo],
  'emergency-and-toxicology': [S.em, S.surg],
  'renal-and-acid-base': [S.renal, S.uro, S.surg],
});
export const SPLIT = Object.freeze(['haematology-and-oncology', 'neurology-eye-and-ent', 'gynaecology-and-mens-health', 'ethics-safety-and-biostatistics',
  'paediatrics', 'emergency-and-toxicology', 'renal-and-acid-base']);

/** An old category id, or a v2 id, as the v2 id it defaults to; null for anything else. */
export function legacySystem(id) {
  if (id == null) return null;
  const k = String(id);
  if (V2.has(k)) return k;
  return LEGACY[k] || null;
}
// The old category each system came from (a map not yet remapped still has it on its topics): its default
// source, and for a system that is new in v2 (Ophthalmology, ENT, ...) the merged section it was split from.
const MERGED = ['haematology-and-oncology', 'neurology-eye-and-ent', 'gynaecology-and-mens-health', 'ethics-safety-and-biostatistics'];
const PARENTS = (() => {
  const out = {};
  const add = (sys, old) => { if (sys !== old) (out[sys] = out[sys] || []).includes(old) || out[sys].push(old); };
  for (const [old, def] of Object.entries(LEGACY)) add(def, old);
  for (const old of MERGED) for (const sys of LEGACY_SPREAD[old]) if (!LEGACY[sys]) add(sys, old);
  return out;
})();
/** A hint's systems with the old categories they came from, so a hint still finds a topic of a release-1 map. */
export const withParents = list => [...new Set((list || []).flatMap(id => [id, ...(PARENTS[id] || [])]))];

/** Every v2 id an id may stand for (a v2 id: itself; an old split category: all its systems). */
export function systemsOf(id) {
  if (id == null) return [];
  const k = String(id);
  if (V2.has(k)) return [k];
  return LEGACY_SPREAD[k] ? [...LEGACY_SPREAD[k]] : LEGACY[k] ? [LEGACY[k]] : [];
}

// ---------------------------------------------------------------- the condition-name rules

// Each alternative is norm()'d too, so the rules are written in plain words ('diabetes', 'Wilms') and still match.
const rx = words => new RegExp(`\\b(?:${[...new Set(words.split('|').map(w => norm(w)).filter(Boolean))].join('|')})\\b`);

// Solid tumours, by organ (the old 'Haematology and Oncology' category only; blood cancers stay in Haematology).
const ORGAN_CANCER = [
  [rx('breast|phyllode'), S.gyn],
  [rx('hydatidiform|molar pregnancy|gestational trophoblastic|choriocarcinoma'), S.obs],
  [rx('cervical|cervix|ovarian|ovary|endometrial|uterine|uterus|vulvar|vulva|vaginal|fallopian'), S.gyn],
  [rx('retinoblastoma|uveal|ocular|orbital|eye'), S.eye],
  [rx('head and neck|laryngeal|larynx|nasopharyngeal|nasopharynx|oropharyngeal|oral cavity|oral cancer|salivary|parotid|tongue|lip cancer|esthesioneuroblastoma'), S.ent],
  [rx('lung|bronchogenic|bronchial|mesothelioma|pancoast|small cell|nonsmall cell|pulmonary nodule|solitary pulmonary|pleural'), S.resp],
  [rx('thyroid|adrenal|adrenocortical|pituitary|pheochromocytoma|paraganglioma|multiple endocrine neoplasia|neuroblastoma|parathyroid|insulinoma|gastrinoma|vipoma|glucagonoma|zollinger|pancreatic neuroendocrine'), S.endo],
  [rx('esophageal|esophagu|gastric|stomach|colon|colorectal|rectal|rectum|anal|pancreatic|pancrea|hepatocellular|liver|hepatoblastoma|cholangiocarcinoma|gallbladder|biliary|bile duct|carcinoid|gastrointestinal stromal|small bowel|small intestine|lynch|polyposis|peutz jegher|ampullary'), S.gi],
  [rx('renal cell|kidney|wilms|nephroblastoma|renal'), S.renal],
  [rx('bladder|urothelial|transitional cell|prostate|prostatic|testicular|testis|seminoma|germ cell|penile|scrotal|leydig|sertoli'), S.uro],
  [rx('melanoma|basal cell|skin|merkel|keratoacanthoma|actinic|dermatofibrosarcoma|kaposi'), S.derm],
  [rx('brain|glioma|glioblastoma|astrocytoma|oligodendroglioma|medulloblastoma|ependymoma|meningioma|schwannoma|craniopharyngioma|cns|spinal cord|neurofibroma|hemangioblastoma|pinealoma'), S.neuro],
  [rx('osteosarcoma|ewing|chondrosarcoma|bone|soft tissue sarcoma|rhabdomyosarcoma|liposarcoma|giant cell tumor|osteoid osteoma|osteochondroma'), S.rheum],
];

// The old 'Neurology, Eye and ENT': the eye and the ear, nose and throat by the condition's own words.
const EYE = rx('eye|ocular|orbital|orbit|periorbital|preseptal|retina|retinal|retinopathy|retinitis|retinoblastoma|macular|macula|cataract|glaucoma|conjunctiva|conjunctivitis|uveitis|iritis|keratitis|corneal|cornea|scleritis|episcleritis|endophthalmitis|blepharitis|chalazion|hordeolum|stye|dacryocystitis|dacryostenosis|nasolacrimal|strabismus|amblyopia|vision|visual|blindness|optic neuritis|hyphema|amaurosis|vitreous|ophthalmia|ophthalmic|ophthalmology|presbyopia|myopia|leukocoria|crao|crvo|central retinal|red eye|diplopia|exophthalmo|proptosis|photokeratitis|subconjunctival|keratoconjunctivitis|keratoconus|pterygium|pinguecula|trachoma|xerophthalmia');
const ENT = rx('ear|otitis|otalgia|otosclerosis|cholesteatoma|mastoiditis|hearing|deafness|tinnitus|vertigo|bppv|benign paroxysmal positional|meniere|labyrinthitis|vestibular|sinusitis|rhinosinusitis|rhinitis|nasal|nose|epistaxis|pharyngitis|tonsil|tonsillitis|tonsillar|peritonsillar|retropharyngeal|parapharyngeal|epiglottitis|laryngeal|laryngitis|laryngomalacia|larynx|croup|laryngotracheobronchitis|bacterial tracheitis|stridor|hoarseness|vocal cord|salivary|parotid|parotitis|sialadenitis|sialolithiasis|ludwig angina|deep neck|neck mass|head and neck|nasopharyngeal|nasopharynx|oropharyngeal|thyroglossal|branchial cleft|choanal atresia|adenoid|adenoidal|cerumen|tympanic|otorrhea|anosmia|acoustic neuroma');
// The old "Gynaecology and Men's Health": the male reproductive tract and urology.
const MALE = rx('testis|testicle|testicular|scrotal|scrotum|varicocele|hydrocele|spermatocele|cryptorchidism|undescended|prostate|prostatic|prostatitis|benign prostatic|bph|erectile|penile|penis|peyronie|priapism|phimosis|paraphimosis|hypospadias|epispadias|epididymis|epididymitis|orchitis|seminoma|vasectomy|gynecomastia|klinefelter|male infertility|male hypogonadism|balanitis|urethral stricture|male breast');
// The old 'Ethics, Safety and Biostatistics': biostatistics and epidemiology by their words; the rest is ethics.
const BIOSTAT = rx('sensitivity|specificity|predictive value|likelihood ratio|relative risk|odds ratio|risk reduction|attributable risk|number needed to treat|number needed to harm|confidence interval|p value|type i error|type ii error|statistical|statistic|statistical power|power of a study|bias|confounding|confounder|effect modification|cohort|case control|cross sectional|randomized|randomised|clinical trial|study design|meta analysis|systematic review|incidence|prevalence|mean|median|mode|standard deviation|normal distribution|skewed|skewness|t test|anova|chi square|correlation|regression|precision|accuracy|reliability|validity|lead time|length time|attrition|recall bias|selection bias|hawthorne|survival|hazard ratio|kaplan meier|epidemiology|screening test|roc curve|receiver operating|null hypothesis|crossover|ecological study|noninferiority|biostatistic|biostatistics|nnt|nnh|ppv|npv');
// The old 'Emergency and Toxicology': major trauma goes to Surgery, Trauma and Perioperative.
const TRAUMA = rx('trauma|traumatic|penetrating|blunt|primary survey|secondary survey|atls|focused assessment with sonography|efast|hemothorax|flail chest|splenic injury|splenic rupture|splenic laceration|liver laceration|hepatic injury|diaphragmatic injury|diaphragmatic rupture|bowel injury|pelvic fracture|cervical spine injury|tracheobronchial injury|aortic injury|cardiac contusion|pulmonary contusion|bladder rupture|urethral injury|renal injury');

// The old 'Paediatrics': newborns, genetics and development stay in their galaxy; the rest goes to its organ.
const CHILD = rx('neonatal|neonate|newborn|prematurity|premature|preterm infant|apgar|kernicterus|meconium|transient tachypnea|respiratory distress syndrome|necrotizing enterocolitis|neonatal abstinence|congenital infection|congenital syphilis|congenital cytomegalovirus|congenital toxoplasmosis|congenital rubella|torch|sudden infant death|sids|trisomy|down syndrome|edwards syndrome|patau syndrome|fragile x|chromosomal|chromosome|genetic|genetics|inborn error|phenylketonuria|galactosemia|glycogen storage|lysosomal storage|mucopolysaccharidosis|tay sachs|developmental milestone|milestone|developmental delay|growth chart|failure to thrive|short stature|tanner|puberty|precocious|breath holding|child abuse|child neglect|shaken baby|nonaccidental|abusive head|well child|vaccine|vaccination|immunization|car seat|toilet training|night terror|infantile colic|colic|teething|physiologic jaundice|neonatal jaundice|breastfeeding jaundice|breast milk jaundice|newborn screening');
const CHILD_ORGAN = [
  [rx('psychiatric|adhd|attention deficit|autism|autism spectrum|oppositional defiant|conduct disorder|tourette|tic disorder|separation anxiety|selective mutism|disruptive mood'), S.psych],
  [rx('septal defect|tetralogy|transposition|ductus arteriosus|coarctation|truncus arteriosus|hypoplastic left|ebstein|anomalous pulmonary venous|cyanotic|congenital heart|innocent murmur|still murmur'), S.cardio],
  [rx('croup|epiglottitis|bacterial tracheitis|peritonsillar|retropharyngeal|otitis|tonsillitis|laryngomalacia|choanal'), S.ent],
  [rx('bronchiolitis|asthma|cystic fibrosis|pneumonia|foreign body aspiration|aspiration|bronchopulmonary dysplasia'), S.resp],
  [rx('pyloric|intussusception|hirschsprung|meckel|malrotation|midgut volvulus|volvulus|duodenal atresia|esophageal atresia|tracheoesophageal|gastroschisis|omphalocele|biliary atresia|celiac|gastroenteritis|constipation|encopresis|intestinal atresia'), S.gi],
  [rx('vesicoureteral|posterior urethral|enuresis|hydronephrosis|wilms|nephrotic|hemolytic uremic|nephritic'), S.renal],
  [rx('sickle|thalassemia|hemophilia|thrombocytopenia|leukemia|lymphoma|anemia|von willebrand'), S.haem],
  [rx('febrile seizure|seizure|epilepsy|hydrocephalus|cerebral palsy|spina bifida|neural tube|muscular dystrophy|duchenne|spinal muscular atrophy|infant botulism'), S.neuro],
  [rx('developmental dysplasia of the hip|hip dysplasia|slipped capital|legg calve|perthes|osgood|nursemaid|radial head subluxation|juvenile idiopathic arthritis|kawasaki|henoch|iga vasculitis|transient synovitis|osteogenesis imperfecta|clubfoot|scoliosis'), S.rheum],
  [rx('measles|mumps|rubella|varicella|roseola|erythema infectiosum|fifth disease|hand foot and mouth|pertussis|scarlet fever|impetigo|parvovirus'), S.id],
  [rx('atopic dermatitis|eczema|diaper|seborrheic|molluscum|infantile hemangioma|port wine'), S.derm],
  [rx('congenital adrenal hyperplasia|diabetes|hypothyroidism|congenital hypothyroidism|growth hormone'), S.endo],
];

/**
 * The condition-name rules of a split category: the v2 system the words of a topic (or unit, or label) name, or
 * null when they name none (the unit or the category's default decides then). oldId: the old category.
 */
export function systemByName(name, oldId) {
  const k = norm(name);
  if (!k) return null;
  switch (oldId) {
    case 'haematology-and-oncology': {
      for (const [re, sys] of ORGAN_CANCER) if (re.test(k)) return sys;
      return null;
    }
    case 'neurology-eye-and-ent':
      if (EYE.test(k)) return S.eye;
      if (ENT.test(k)) return S.ent;
      return null;
    case 'gynaecology-and-mens-health':
      return MALE.test(k) ? S.uro : null;
    case 'ethics-safety-and-biostatistics':
      return BIOSTAT.test(k) ? S.biostat : null;
    case 'emergency-and-toxicology':
      return TRAUMA.test(k) ? S.surg : null;
    case 'renal-and-acid-base':
      return MALE.test(k) ? S.uro : null;
    case 'paediatrics': {
      if (CHILD.test(k)) return S.child;
      for (const [re, sys] of CHILD_ORGAN) if (re.test(k)) return sys;
      return null;
    }
    default: return null;
  }
}

// ---------------------------------------------------------------- units

// Checklist units that leave their checklist system's default galaxy: [id, the start of the unit's name, system].
// The name must still start that way (another profile's checklist numbers its units for itself), else the
// ordinary rules decide.
export const UNIT_SYSTEMS = Object.freeze([
  ['u022', 'GU trauma', S.surg],                              // kidney, bladder, urethral injury: major trauma
  ['u052', 'Trauma survey', S.surg],                          // the primary survey and chest, spleen, bowel injury
  ['u085', 'Acute angle-closure glaucoma', S.eye],
  ['u096', 'Conjunctivitis', S.eye],                          // conjunctivitis, uveitis (eye) · otitis, cholesteatoma: topics go to ENT by name
  ['u132', 'Testicular torsion', S.uro],
  ['u141', 'Varicocele', S.uro],                              // varicocele, hydrocele, cryptorchidism, BPH, prostate cancer
  ['u144', 'Croup', S.ent],                                   // croup, epiglottitis, tracheitis, RPA/PTA
  ['u145', 'Foreign-body aspiration', S.resp],
  ['u148', 'ToF', S.cardio],                                  // congenital heart defects
  ['u149', 'Pyloric stenosis', S.gi],                         // pyloric stenosis, intussusception, Hirschsprung, Meckel
  ['u150', 'VUR', S.renal],                                   // VUR, PUV, enuresis, neonatal AKI
  ['u221', 'Gender-affirming', S.prev],
  ['u224', 'Drug effects', S.prev],                           // interactions and dose adjustment, beside polypharmacy (u197)
]);
const UNIT_OVERRIDE = new Map(UNIT_SYSTEMS.map(([id, start, sys]) => [id, { start: norm(start), sys }]));

// The checklist's own systems (its 24 h2 headings) -> v2. 'Rapid differentials' has no units.
export const CHECKLIST_V2 = Object.freeze([
  [['Cardiovascular'], S.cardio], [['Lungs + Airway'], S.resp], [['Kidney + Acid–Base', 'Kidney + Acid-Base'], S.renal],
  [['Gi + Hepatobiliary'], S.gi], [['Infection'], S.id], [['Emergency + Tox'], S.em], [['Endocrine'], S.endo], [['Blood + Oncology'], S.haem],
  [['Brain, Spine + Senses'], S.neuro], [['Rheum + Msk'], S.rheum], [['Biostats + Epidemiology'], S.biostat],
  [['Ethics + Communication', 'Patient Safety + Qi', 'Special Populations'], S.ethics],
  [['Obstetrics'], S.obs], [["Gyn + Men's Health"], S.gyn], [['Pediatrics + Development'], S.child], [['Derm + Wounds'], S.derm],
  [['Psychiatry + Substances'], S.psych], [['Surgery + Perioperative'], S.surg],
  [['Nutrition — 2026 Focus', 'Screening + Prevention', 'Geriatrics'], S.prev], [['Immune + Allergy'], S.immuno],
]);
const CHECKLIST_BY_KEY = new Map(CHECKLIST_V2.flatMap(([names, sys]) => names.map(n => [norm(n), sys])));
const SECTION_IDS = new Map(Object.entries({
  Obstetrics: 'obstetrics', Paediatrics: 'paediatrics', "Gynaecology and Men's Health": 'gynaecology-and-mens-health', Endocrine: 'endocrine',
  Cardiology: 'cardiology', Respiratory: 'respiratory', 'Renal and Acid-Base': 'renal-and-acid-base', 'GI and Hepatology': 'gi-and-hepatology',
  'Haematology and Oncology': 'haematology-and-oncology', 'Infectious Disease': 'infectious-disease', 'Immunology and Allergy': 'immunology-and-allergy',
  'Neurology, Eye and ENT': 'neurology-eye-and-ent', Psychiatry: 'psychiatry', 'Emergency and Toxicology': 'emergency-and-toxicology',
  'Rheumatology and MSK': 'rheumatology-and-msk', Dermatology: 'dermatology', Surgery: 'surgery',
  'Prevention, Nutrition and Geriatrics': 'prevention-nutrition-and-geriatrics', 'Ethics, Safety and Biostatistics': 'ethics-safety-and-biostatistics',
}).map(([n, id]) => [norm(n), id]));
export const sectionId = name => (name == null ? null : SECTION_IDS.get(norm(name)) || null);

export function unitSystemFor(u) {
  if (!u) return null;
  const o = u.id ? UNIT_OVERRIDE.get(String(u.id)) : null;
  if (o && (!u.kind || u.kind === 'checklist') && norm(u.name).startsWith(o.start)) return o.sys;
  const section = sectionId(u.onenote_section) || (LEGACY[u.category_id] ? u.category_id : null);
  const isChecklist = !u.kind || u.kind === 'checklist';
  if (!isChecklist && section && SPLIT.includes(section)) {
    const byName = systemByName(u.name, section);
    if (byName) return byName;
  }
  const bySystem = u.checklist_system ? CHECKLIST_BY_KEY.get(norm(u.checklist_system)) : null;
  if (bySystem) return bySystem;
  if (section) return LEGACY[section];
  if (u.category_id && V2.has(String(u.category_id))) return String(u.category_id);
  return null;
}

// ---------------------------------------------------------------- topics

/**
 * A topic's v2 system and why: {system, why}. topic: {name, short_name?, category_id (old), unit_id?}.
 * unitOld: the topic's unit's category before the remap; unitNew: its v2 system. In order:
 *   name     a split category's condition-name rule (a solid tumour to its organ, an eye or ENT condition, ...)
 *   unit     the topic follows its unit when the two shared a category
 *   default  the old category's v2 system
 * A topic already in a v2 id keeps it ('kept').
 */
export function topicSystemFor(topic, { unitOld = null, unitNew = null } = {}) {
  const old = topic && topic.category_id != null ? String(topic.category_id) : null;
  if (old == null) return { system: unitNew || null, why: unitNew ? 'unit' : 'none' };
  if (V2.has(old) && !LEGACY[old]) return { system: old, why: 'kept' };
  if (SPLIT.includes(old)) {
    const byName = systemByName(topic.name, old) || (topic.short_name ? systemByName(topic.short_name, old) : null);
    if (byName) return { system: byName, why: 'name' };
  }
  if (unitNew && unitOld === old) return { system: unitNew, why: 'unit' };
  const def = LEGACY[old];
  if (def) return { system: def, why: def === old ? 'kept' : 'default' };
  return { system: old, why: 'unknown' };
}

/** A second home (category2_id) under v2: its name rule or its default, and null when it equals the first home. */
export function secondSystemFor(topic, first) {
  const c2 = topic && topic.category2_id != null ? String(topic.category2_id) : null;
  if (c2 == null) return null;
  const sys = (SPLIT.includes(c2) && systemByName(topic.name, c2)) || legacySystem(c2) || c2;
  return sys === first ? null : sys;
}

/** A label or new topic's v2 system from words and an old (or v2) category hint, for queue items and new topics. */
export function systemForWords(words, hint) {
  if (hint == null) return null;
  const h = String(hint);
  if (SPLIT.includes(h)) return systemByName(words, h) || LEGACY[h];
  return legacySystem(h) || h;
}

// ---------------------------------------------------------------- tags

// Every cancer, and oncology care itself (tumour lysis, febrile neutropenia, chemotherapy, paraneoplastic
// syndromes), plus the hereditary cancer syndromes and precancers. Benign tumours (adenoma, meningioma) are not.
const ONCOLOGY = rx('cancer|carcinoma|adenocarcinoma|carcinoma in situ|sarcoma|osteosarcoma|melanoma|lymphoma|leukemia|myeloma|blastoma|neuroblastoma|retinoblastoma|medulloblastoma|glioblastoma|hepatoblastoma|nephroblastoma|glioma|astrocytoma|oligodendroglioma|ependymoma|mesothelioma|seminoma|germ cell tumor|choriocarcinoma|teratoma|myelodysplastic|myeloproliferative|polycythemia vera|essential thrombocythemia|myelofibrosis|waldenstrom|macroglobulinemia|mycosis fungoides|carcinoid|neuroendocrine tumor|metastasis|metastase|metastatic|malignancy|malignant|tumor lysis|febrile neutropenia|neutropenic fever|paraneoplastic|chemotherapy|lynch|polyposis|multiple endocrine neoplasia|neoplasia|neoplasm|wilms|ewing|hodgkin|burkitt|tumor|monoclonal gammopathy|mgus|plasmacytoma|langerhans cell histiocytosis|pancoast|superior vena cava syndrome|hypercalcemia of malignancy|gestational trophoblastic|hydatidiform');
const ONC_SHORT = new Set(['cll', 'cml', 'aml', 'all', 'hcc', 'rcc', 'bcc', 'scc', 'nhl', 'mm', 'crc', 'nsclc', 'sclc', 'mgus', 'cin', 'men1', 'men2']);
const NOT_ONC = rx('benign|pseudotumor|tumor necrosis');

/** 1 when the topic is a cancer or oncology care, else 0 (name and short name only). */
export function oncologyOf(topic) {
  const k = norm(topic && topic.name);
  const s = norm(topic && topic.short_name);
  if (s && ONC_SHORT.has(s)) return 1;
  if (!k) return 0;
  if (NOT_ONC.test(k) && !/\b(cancer|carcinoma|malignan)/.test(k)) return 0;
  return ONCOLOGY.test(k) ? 1 : 0;
}

// The discipline filter (Medicine, Surgery, Paediatrics, ObGyn, Psychiatry) as bits, so a topic can carry two
// (pyloric stenosis: Paediatrics and Surgery; postpartum depression: ObGyn and Psychiatry).
export const DISCIPLINES = Object.freeze([['medicine', 'Medicine', 1], ['surgery', 'Surgery', 2], ['paediatrics', 'Paediatrics', 4],
  ['obgyn', 'ObGyn', 8], ['psychiatry', 'Psychiatry', 16]]);
export const D = Object.freeze(Object.fromEntries(DISCIPLINES.map(([k, , b]) => [k, b])));
export const DISCIPLINE_KEYS = Object.freeze(DISCIPLINES.map(d => d[0]));
const SYSTEM_DISC = { [S.surg]: D.surgery, [S.child]: D.paediatrics, [S.obs]: D.obgyn, [S.gyn]: D.obgyn, [S.psych]: D.psychiatry,
  [S.uro]: D.surgery | D.medicine };
// Units that also belong to another discipline, by id (with the start of their name, as UNIT_SYSTEMS).
export const UNIT_DISCIPLINES = Object.freeze([
  ['u003', 'Aortic emergency', D.surgery], ['u013', 'Simple/tension pneumothorax', D.surgery], ['u022', 'GU trauma', D.surgery],
  ['u031', 'Acute abdomen', D.surgery], ['u032', 'Obstruction/perforation', D.surgery], ['u033', 'Acute cholecystitis', D.surgery],
  ['u035', 'Biliary colic', D.surgery], ['u052', 'Trauma survey', D.surgery], ['u098', 'Compartment syndrome', D.surgery],
  ['u107', 'Clavicle', D.surgery], ['u110', 'SCFE', D.paediatrics | D.surgery], ['u156', 'Cellulitis', D.surgery],
  ['u144', 'Croup', D.paediatrics], ['u145', 'Foreign-body aspiration', D.paediatrics], ['u148', 'ToF', D.paediatrics],
  ['u149', 'Pyloric stenosis', D.paediatrics | D.surgery], ['u150', 'VUR', D.paediatrics], ['u181', 'Marasmus', D.paediatrics],
  ['u130', 'Congenital infection', D.obgyn | D.paediatrics], ['u129', 'Postpartum depression', D.psychiatry],
  ['u048', 'STI/PID', D.obgyn], ['u049', 'Genital ulcers', D.obgyn], ['u152', 'Milestones', D.psychiatry],
  ['u195', 'Delirium', D.psychiatry], ['u190', 'Prenatal', D.paediatrics | D.obgyn], ['u131', 'Ovarian torsion', D.surgery],
]);
const UNIT_DISC = new Map(UNIT_DISCIPLINES.map(([id, start, bits]) => [id, { start: norm(start), bits }]));
const CHILD_WORDS = rx('neonatal|neonate|newborn|infant|infantile|childhood|child|pediatric|juvenile|congenital|kawasaki|preterm');
const PREGNANCY_WORDS = rx('pregnancy|pregnant|antepartum|intrapartum|postpartum|peripartum|gestational|obstetric|puerperal|lactation');

/**
 * The topic's disciplines as bits (D): its system's own discipline, its unit's extra ones, and its words (a child's
 * or a pregnancy's condition), with Medicine when nothing else is said. A paediatric topic in an organ system is
 * Paediatrics, not Medicine.
 */
export function disciplinesOf(topic, systemId, unit = null, oldId = null) {
  let bits = SYSTEM_DISC[systemId] || 0;
  const u = unit && unit.id ? UNIT_DISC.get(String(unit.id)) : null;
  if (u && (!unit.kind || unit.kind === 'checklist') && norm(unit.name).startsWith(u.start)) bits |= u.bits;
  if (oldId === 'paediatrics') bits |= D.paediatrics;
  if (oldId === 'surgery') bits |= D.surgery;
  const k = norm(topic && topic.name);
  if (k && CHILD_WORDS.test(k)) bits |= D.paediatrics;
  if (k && PREGNANCY_WORDS.test(k)) bits |= D.obgyn;
  if (!(bits & (D.paediatrics | D.obgyn | D.psychiatry | D.surgery))) bits |= D.medicine;
  // Surgery beside a medical system keeps Medicine (aortic dissection is both); Paediatrics never does.
  if ((bits & D.surgery) && !SYSTEM_DISC[systemId] && !(bits & D.paediatrics)) bits |= D.medicine;
  return bits;
}

/** Both tags for a topic in its v2 system: {oncology, disciplines}. */
export function tagsOf(topic, systemId, unit = null, oldId = null) {
  return { oncology: oncologyOf(topic), disciplines: disciplinesOf(topic, systemId, unit, oldId) };
}
