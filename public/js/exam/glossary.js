
export const MISHEARD = [
  'mittelschmerz', // "Messerschmitts"
  'Bartonella henselae', // "hensleyi"
  'E. coli O157:H7', // "015707"
  'syringomyelia', // "spiro-malasia"
  'sertraline', // "surgery"
  'akathisia', // "akathesia"
  'erythema toxicum neonatorum', // "toxicum neonautum"
  'Fusobacterium necrophorum',
  'Lemierre syndrome',
  'levothyroxine', // "levo"
];

export const GLOSSARY_BY_SYSTEM = {
  cardio: ['STEMI', 'NSTEMI', 'troponin', 'PCI', 'aortic dissection', 'pericarditis', 'tamponade', 'atrial fibrillation',
    'amiodarone', 'adenosine', 'heparin', 'enoxaparin', 'warfarin', 'apixaban', 'clopidogrel', 'nitroglycerin',
    'furosemide', 'spironolactone', 'metoprolol', 'lisinopril', 'losartan', 'hydralazine', 'digoxin', 'statin',
    'endocarditis', 'aortic stenosis', 'mitral stenosis', 'mitral regurgitation', 'hypertrophic cardiomyopathy',
    'restrictive cardiomyopathy', 'amyloidosis', 'constrictive pericarditis', 'cilostazol', 'AV fistula', 'pseudoaneurysm'],
  pulm: ['pulmonary embolism', 'D-dimer', 'CT angiography', 'COPD', 'asthma', 'albuterol', 'ipratropium', 'sarcoidosis',
    'pneumothorax', 'thoracentesis', 'bronchiectasis', 'tuberculosis', 'spirometry', 'FEV1', 'V/Q mismatch',
    'intrapulmonary shunt', 'atelectasis', 'Pneumocystis'],
  renal: ['hyponatremia', 'hyperkalemia', 'hypercalcemia', 'SIADH', 'diabetes insipidus', 'nephrotic syndrome',
    'nephritic syndrome', 'acute tubular necrosis', 'nephrolithiasis', 'rhabdomyolysis', 'FENa', 'hypertonic saline',
    'acute interstitial nephritis', 'renal artery stenosis', 'calcium gluconate'],
  endo: ['DKA', 'insulin', 'metformin', 'Graves disease', 'Hashimoto', 'thyroid storm', 'methimazole',
    'propylthiouracil', 'Cushing syndrome', 'Addison disease', 'hydrocortisone', 'pheochromocytoma',
    'hyperaldosteronism', 'congenital adrenal hyperplasia', '21-hydroxylase', 'glucagon'],
  gi: ['cholecystitis', 'cholangitis', 'pancreatitis', 'appendicitis', 'diverticulitis', 'Crohn disease',
    'ulcerative colitis', 'celiac disease', 'cirrhosis', 'hepatic encephalopathy', 'lactulose', 'rifaximin',
    'esophageal varices', 'octreotide', 'Helicobacter pylori', 'omeprazole', 'achalasia', 'colonoscopy',
    'endoscopy', 'ERCP', 'eosinophilic esophagitis', 'budesonide', 'Campylobacter', 'Shigella', 'emphysematous',
    'Nissen fundoplication', 'SAAG'],
  id: ['ceftriaxone', 'vancomycin', 'piperacillin-tazobactam', 'azithromycin', 'doxycycline', 'nitrofurantoin',
    'trimethoprim-sulfamethoxazole', 'metronidazole', 'clindamycin', 'cefazolin', 'amoxicillin', 'penicillin',
    'acyclovir', 'fluconazole', 'meningitis', 'lumbar puncture', 'cellulitis', 'osteomyelitis', 'sepsis', 'HIV',
    'syphilis', 'cytomegalovirus', 'mononucleosis', 'Monospot', 'Lyme disease', 'group B streptococcus', 'Bartonella'],
  heme: ['iron deficiency', 'thalassemia', 'sickle cell', 'hemolytic anemia', 'TTP', 'HIT', 'DIC', 'ITP',
    'von Willebrand', 'hemophilia', 'leukemia', 'AML', 'ALL', 'CML', 'CLL', 'BCR-ABL', 'lymphoma', 'Hodgkin',
    'Reed-Sternberg', 'multiple myeloma', 'tumor lysis syndrome', 'hydroxyurea', 'schistocytes', 'haptoglobin',
    'Coombs test', 'desmopressin', 'hemolytic uremic syndrome'],
  neuro: ['stroke', 'tPA', 'subarachnoid hemorrhage', 'intracerebral hemorrhage', 'subdural hematoma',
    'epidural hematoma', 'seizure', 'status epilepticus', 'lorazepam', 'levetiracetam', 'valproate', 'lamotrigine',
    'ethosuximide', 'Guillain-Barre', 'myasthenia gravis', 'multiple sclerosis', 'Parkinson disease',
    'normal pressure hydrocephalus', 'hydrocephalus', 'meningioma', 'cervical myelopathy', 'central cord syndrome',
    'Wernicke encephalopathy', 'thiamine', 'radiculopathy', 'Charcot', 'monofilament', 'dexamethasone'],
  psych: ['delirium', 'dementia', 'schizophrenia', 'bipolar disorder', 'lithium', 'haloperidol', 'olanzapine',
    'quetiapine', 'SSRI', 'SNRI', 'fluoxetine', 'serotonin syndrome', 'neuroleptic malignant syndrome',
    'benztropine', 'propranolol', 'alcohol withdrawal', 'chlordiazepoxide', 'naloxone', 'buprenorphine',
    'panic disorder', 'generalized anxiety disorder', 'PTSD', 'autism spectrum disorder', 'MDMA', 'anticholinergic',
    'CBT', 'SIGECAPS'],
  ob: ['preeclampsia', 'eclampsia', 'magnesium sulfate', 'ectopic pregnancy', 'placenta previa', 'placental abruption',
    'gestational diabetes', 'oxytocin', 'Rh immune globulin', 'RhoGAM', 'chorioamnionitis', 'PPROM', 'Tdap',
    'late decelerations', 'variability', 'VEAL CHOP', 'granulosa cell tumor', 'inhibin', 'estradiol', 'beta-hCG',
    'leukorrhea', 'LEEP', 'cone biopsy', 'cervical intraepithelial neoplasia'],
  gyn: ['PCOS', 'endometriosis', 'endometrial biopsy', 'Turner syndrome', 'combined oral contraceptive'],
  peds: ['croup', 'epiglottitis', 'bacterial tracheitis', 'bronchiolitis', 'Kawasaki disease', 'intussusception',
    'pyloric stenosis', 'Hirschsprung disease', 'febrile seizure', 'neonatal jaundice', 'racemic epinephrine',
    'dermal melanocytosis', 'nasolacrimal duct obstruction', 'hypogammaglobulinemia', 'cerebral palsy', 'SIDS'],
  msk: ['gout', 'colchicine', 'allopurinol', 'pseudogout', 'calcium pyrophosphate', 'rheumatoid arthritis',
    'methotrexate', 'lupus', 'giant cell arteritis', 'prednisone', 'septic arthritis', 'compartment syndrome',
    'ankylosing spondylitis', 'TNF inhibitor', 'secukinumab', 'systemic sclerosis', 'Felty syndrome',
    'Heberden nodes', 'osteoarthritis'],
  derm: ['melanoma', 'atopic dermatitis', 'emollients', 'Stevens-Johnson syndrome', 'scarlet fever', 'erythema multiforme',
    'erythema nodosum'],
  eye_ent: ['angle-closure glaucoma', 'laser iridotomy', 'hyphema', 'conjunctivitis', 'retinal detachment'],
  emerg: ['anaphylaxis', 'epinephrine', 'beta blocker overdose', 'atropine', 'acetaminophen', 'N-acetylcysteine'],
  stats: ['sensitivity', 'specificity', 'positive predictive value', 'attributable risk', 'confounding',
    'effect modification', 'type 2 error', 'hospice'],
};

export const GLOSSARY = (() => {
  const seen = new Set(), out = [];
  for (const w of [...MISHEARD, ...Object.values(GLOSSARY_BY_SYSTEM).flat()]) {
    const k = w.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(w); }
  }
  return out;
})();

// Whisper keeps only the last ~223 tokens of its prompt (faster-whisper; OpenAI documents 224) and drops the front, and
// medical words run about 2.85 characters a token, so a prompt is built to about 200 tokens with what matters most at
// the end: the general slice first (cut first), then MISHEARD, then the question's option names or the recorder's phrases.
export const PROMPT_CHARS = 560;

/**
 * Every system's terms in turn (round robin), each system's list starting `clip` words in, so consecutive clips get
 * different words. With misheard (default) MISHEARD comes first, for callers that want the whole order.
 */
export function balancedTerms(clip = 0, { misheard = true } = {}) {
  const lists = Object.values(GLOSSARY_BY_SYSTEM);
  const n = Math.max(0, Math.floor(Number(clip) || 0));
  const out = misheard ? [...MISHEARD] : [];
  const longest = Math.max(...lists.map(l => l.length));
  for (let i = 0; i < longest; i++) {
    for (const l of lists) if (i < l.length) out.push(l[(i + n) % l.length]);
  }
  return out;
}

const tidy = w => String(w || '').replace(/\s+/g, ' ').trim().replace(/[.;:,]+$/, '');

/**
 * One prompt: `head` words, then `tail` words, as one comma list in a sentence, at most `max` characters. The tail is
 * kept whole (as much of it as fits); the head fills what is left, in order, so the general slice is what gets cut.
 */
function compose(head, tail, max, lead = 'Step 2 CK terms') {
  const seen = new Set();
  const take = list => list.map(tidy).filter(t => { const k = t.toLowerCase(); if (!t || t.length > 80 || seen.has(k)) return false; seen.add(k); return true; });
  const end = take(tail);
  const front = take(head);
  const fits = words => `${lead}: ${words.join(', ')}.`.length <= max;
  while (end.length && !fits(end)) end.shift();
  const kept = [];
  for (const w of front) { if (!fits([...kept, w, ...end])) break; kept.push(w); }
  const words = [...kept, ...end];
  return words.length ? `${lead}: ${words.join(', ')}.` : '';
}

export function buildPrompt(optionNames = [], max = PROMPT_CHARS, clip = 0) {
  return compose(balancedTerms(clip, { misheard: false }), [...MISHEARD, ...optionNames], max);
}

export function spokenPrompt(lead = '', clip = 0, max = PROMPT_CHARS) {
  const phrases = String(lead || '').split(/[,.]\s*/).map(tidy).filter(Boolean);
  return compose(balancedTerms(clip, { misheard: false }), [...MISHEARD, ...phrases], max);
}

// Nova-3's keyterm prompting (transcribe.js) takes up to 100 terms, about 500 tokens in all.
export const KEYTERMS_MAX = 100, KEYTERM_CHARS = 1400;

export function keytermsFor(prompt = '', clip = 0) {
  const body = String(prompt || '').replace(/^[^:]{0,40}:\s*/, '').replace(/\.\s*$/, '');
  const fromPrompt = body ? body.split(/,\s*/).map(tidy).filter(Boolean).reverse() : [];
  const seen = new Set(), out = [];
  let chars = 0;
  for (const t of [...fromPrompt, ...MISHEARD, ...balancedTerms(clip, { misheard: false })]) {
    const k = t.toLowerCase();
    if (!t || seen.has(k) || t.split(/\s+/).length > 6 || t.length > 60) continue;
    if (out.length >= KEYTERMS_MAX || chars + t.length > KEYTERM_CHARS) break;
    seen.add(k); out.push(t); chars += t.length;
  }
  return out;
}
