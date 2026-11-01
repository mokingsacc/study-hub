import { NOT_CHECKED } from './fact-sources.js';

export const EXAM_WORDING_RULE = 'Use these phrases exactly as the exam means them, never loosely. A stem saying the phrase means exactly this; '
  + 'when a lesson line turns on one of them, say it this way and give its tag.';

const E = (phrase, means, keys, src) => ({ phrase, means, keys, src: src || null });

export const EXAM_WORDING = [
  // Chest: breath sounds and percussion.
  E('Lungs clear to auscultation', 'Normal breath sounds on both sides, with no crackles, wheeze or rhonchi. It argues against tension pneumothorax (absent breath sounds on one side) and pulmonary edema (crackles); in obstructive shock, clear lungs fit tamponade or a massive PE.',
    ['pneumothorax', 'tamponade', 'shock', 'embolism', 'pulmonary edema', 'heart failure', 'pneumonia', 'effusion'], 'UW Tables p. 74; FA p. 678'),
  E('Absent or decreased breath sounds on one side', 'Air or fluid between lung and chest wall, or a collapsed lung: pneumothorax if hyperresonant, effusion or hemothorax if dull.',
    ['pneumothorax', 'effusion', 'hemothorax', 'chest trauma', 'atelectasis', 'empyema'], 'FA p. 678'),
  E('Hyperresonance to percussion', 'Too much air: pneumothorax on one side, or hyperinflation on both sides in COPD or asthma.',
    ['pneumothorax', 'copd', 'chronic obstructive', 'asthma', 'emphysema'], 'FA p. 678'),
  E('Dullness to percussion', 'Fluid or solid lung: effusion or hemothorax (with decreased breath sounds and fremitus) or consolidation (with bronchial breath sounds and increased fremitus).',
    ['effusion', 'hemothorax', 'pneumonia', 'consolidation', 'empyema'], 'FA p. 678'),
  E('Increased tactile fremitus', 'Consolidation, such as lobar pneumonia. Fremitus is decreased in effusion and pneumothorax.',
    ['pneumonia', 'consolidation', 'effusion', 'pneumothorax'], 'FA p. 678'),
  E('Bronchial breath sounds, egophony, bronchophony', 'Consolidation carrying sound through solid lung: lobar pneumonia. Not effusion or pneumothorax.',
    ['pneumonia', 'consolidation', 'effusion'], 'FA p. 678'),
  E('Crackles (rales)', 'Fluid or scarring in the alveoli: pneumonia, pulmonary edema, fibrosis. Absent over an effusion or pneumothorax.',
    ['pneumonia', 'heart failure', 'pulmonary edema', 'fibrosis', 'effusion', 'pneumothorax'], 'FA p. 678'),
  E('Tracheal deviation', 'Pushed away from a tension pneumothorax or a large effusion. A stem need not mention it for tension pneumothorax.',
    ['pneumothorax', 'effusion', 'atelectasis'], 'FA p. 679; Mehlman HY Internal Medicine p. 440'),
  E('Wheeze', 'Expiratory whistling from narrowed small airways: asthma, COPD, anaphylaxis. Not the same as stridor.',
    ['asthma', 'copd', 'chronic obstructive', 'anaphylaxis', 'bronchiolitis'], null),
  E('Silent chest in an asthma attack', 'No air is moving: a near-fatal attack, not improvement. Intubation is near.',
    ['asthma'], null),
  E('Stridor', 'Inspiratory noise from the upper airway: croup, epiglottitis, foreign body, anaphylaxis.',
    ['croup', 'epiglottitis', 'foreign body', 'anaphylaxis', 'tracheitis'], null),
  E('Steeple sign and barking cough', 'Croup: subglottic narrowing. The thumbprint sign is epiglottitis.',
    ['croup', 'epiglottitis'], 'Mehlman Microbiology Learning Modules p. 68'),
  E('Long, narrow heart or a subxiphoid point of maximal impulse', 'Hyperinflated lungs in COPD. A laterally displaced apex means left ventricular hypertrophy or dilation.',
    ['copd', 'chronic obstructive', 'emphysema', 'heart failure'], 'Mehlman HY Pulmonary p. 13'),
  E('Light criteria for an exudate', 'Any one of: pleural to serum protein over 0.5, pleural to serum LDH over 0.6, pleural LDH over two thirds of the upper limit of normal serum LDH.',
    ['effusion', 'empyema', 'parapneumonic'], 'FA Algorithms p. 311'),
  // Heart and neck veins.
  E('Raised JVP, distended neck veins (JVD)', 'High right-sided filling pressure: tamponade, tension pneumothorax, massive PE, right heart failure, constrictive pericarditis. Flat neck veins mean hypovolemia.',
    ['tamponade', 'pneumothorax', 'embolism', 'heart failure', 'constrictive', 'shock', 'cor pulmonale'], 'UW Objectives p. 35; UW Objectives p. 245'),
  E('Flat neck veins', 'Low filling pressure: hypovolemia, such as hemorrhagic shock or a massive hemothorax.',
    ['hypovolemic', 'hemorrhagic', 'hemothorax', 'shock', 'dehydration'], 'UW Objectives p. 245'),
  E('Muffled (distant) heart sounds', 'Fluid around the heart: pericardial effusion or tamponade.',
    ['tamponade', 'pericardial effusion', 'pericarditis'], 'UW Objectives p. 193'),
  E('Beck triad', 'Hypotension, distended neck veins and muffled heart sounds: cardiac tamponade. A stem need not give all three.',
    ['tamponade', 'pericardial', 'shock'], 'UW Objectives p. 35; Mehlman HY USMLE Review Part IV p. 16'),
  E('Pulsus paradoxus', 'Systolic blood pressure falls more than 10 mm Hg on inspiration. Classic for tamponade; also severe asthma or COPD, constrictive pericarditis, tension pneumothorax.',
    ['tamponade', 'asthma', 'copd', 'constrictive', 'pneumothorax', 'pericard'], 'UW Tables p. 74; FA p. 37'),
  E('Electrical alternans', 'QRS height changes from beat to beat: a large pericardial effusion, usually with tamponade.',
    ['tamponade', 'pericardial effusion', 'pericard'], 'UW Objectives p. 35'),
  E('Kussmaul sign', 'The JVP rises, or fails to fall, on inspiration: constrictive pericarditis. Not Kussmaul breathing, the deep fast breaths of metabolic acidosis.',
    ['constrictive', 'pericard', 'restrictive cardiomyopathy', 'tamponade', 'ketoacidosis'], 'FA p. 78; UW Tables p. 71'),
  E('Pericardial knock', 'An early diastolic sound as the heart hits a stiff pericardium: constrictive pericarditis.',
    ['constrictive', 'pericard'], 'FA p. 78'),
  E('Pulsus parvus et tardus', 'A weak, late carotid upstroke: severe aortic stenosis.',
    ['aortic stenosis', 'valv', 'syncope', 'hypertrophic'], 'UW Tables p. 76; FA Algorithms p. 65'),
  E('Crescendo-decrescendo systolic murmur at the right upper sternal border, radiating to the carotids', 'Aortic stenosis.',
    ['aortic stenosis', 'valv', 'hypertrophic', 'murmur'], 'UW Tables p. 76'),
  E('Holosystolic murmur at the left lower sternal border', 'Ventricular septal defect in a child.',
    ['ventricular septal', 'vsd', 'congenital heart', 'murmur'], 'UW Objectives p. 330'),
  E('Wide pulse pressure, bounding pulses', 'A hyperdynamic circulation: aortic regurgitation, or high-output states.',
    ['aortic regurgitation', 'valv', 'high-output', 'thyrotoxicosis', 'hyperthyroidism'], 'UW Objectives p. 30'),
  E('Pulsus alternans', 'Strong and weak beats alternate: severe left ventricular dysfunction.',
    ['heart failure', 'cardiomyopathy'], 'FA p. 37'),
  // Circulation and shock.
  E('Orthostatic hypotension', 'Systolic drop over 20 mm Hg or diastolic drop over 10 mm Hg from lying to standing: intravascular fluid depletion.',
    ['orthostatic', 'syncope', 'dehydration', 'hypovolemic'], 'Mehlman HY Cardio p. 32'),
  E('Shock in trauma', 'Systolic pressure under 90 mm Hg with a fast, weak pulse, pallor and sweating. Hemorrhage first.',
    ['shock', 'trauma', 'hemorrhagic', 'hypovolemic'], 'FA p. 766'),
  E('Cold, clammy extremities', 'High systemic vascular resistance: hypovolemic, cardiogenic or obstructive shock. Warm extremities with low resistance mean distributive shock (septic, anaphylactic).',
    ['shock', 'sepsis', 'septic', 'anaphylaxis', 'hypovolemic', 'cardiogenic'], 'UW Objectives p. 245; FA p. 801'),
  E('Hypotension with bradycardia after a spinal injury', 'Neurogenic shock.',
    ['shock', 'spinal cord', 'neurogenic', 'trauma'], 'FA p. 801'),
  E('Fever (SIRS)', 'Temperature over 38 degrees C (100.4 F) or under 36 degrees C; with heart rate over 90 and breathing over 20 a minute these are the SIRS criteria.',
    ['sepsis', 'septic', 'fever', 'shock'], 'FA p. 801'),
  // Nervous system.
  E('Cushing triad', 'Hypertension, bradycardia and slow or irregular breathing: raised intracranial pressure.',
    ['intracranial', 'head trauma', 'herniation', 'subdural', 'epidural', 'hemorrhage', 'skull fracture'], 'Mehlman HY Neuroanatomy p. 61'),
  E('Nuchal rigidity', 'Neck stiffness from meningeal irritation: meningitis, or subarachnoid hemorrhage.',
    ['meningitis', 'subarachnoid', 'encephalitis', 'meningococc'], 'UW Objectives p. 356'),
  E('Fever with petechiae or purpura', 'Meningococcal disease until proven otherwise; it can progress within 12 to 24 hours.',
    ['meningitis', 'meningococc', 'sepsis', 'petechiae'], 'UW Tables p. 1093'),
  E('Asterixis', 'A flapping tremor of the outstretched hands: a metabolic encephalopathy, classically hepatic.',
    ['hepatic encephalopathy', 'cirrhosis', 'encephalopathy', 'uremi', 'liver failure'], 'Mehlman HY Family Medicine p. 155'),
  // Abdomen and limbs.
  E('McBurney point tenderness and Rovsing sign', 'Appendicitis: tenderness one third of the way from the anterior superior iliac spine to the umbilicus; right lower pain on pressing the left lower quadrant.',
    ['appendicitis', 'right lower quadrant', 'abdominal pain'], 'Mehlman HY Internal Medicine p. 140'),
  E('Psoas and obturator signs', 'An inflamed appendix lying on the psoas (retrocecal) or in the pelvis.',
    ['appendicitis', 'psoas abscess'], 'Divine p. 357'),
  E('Rebound tenderness, guarding, a rigid abdomen', 'Peritoneal irritation: peritonitis. A board-like abdomen suggests a perforation.',
    ['peritonitis', 'perforat', 'appendicitis', 'diverticulitis', 'peptic ulcer', 'acute abdomen'], null),
  E('Murphy sign', 'Breathing stops short on pressing under the right costal margin: acute cholecystitis.',
    ['cholecystitis', 'gallstone', 'biliary', 'cholangitis'], null),
  E('Pain out of proportion and pain on passive stretch', 'Compartment syndrome, classically after a cast or a crush. Pulses can still be present, so do not wait for them to go.',
    ['compartment syndrome', 'fracture', 'crush', 'burn'], 'Mehlman HY Anatomy-MSK-Rheumatology p. 61 (pain only)'),
];

/** map_rules {part: 'exam_wording'}: the rule, then "phrase: means (tag)" per entry, unsourced ones marked. */
export function examWordingLines(list = EXAM_WORDING) {
  return [EXAM_WORDING_RULE, ...list.map(e => `${e.phrase}: ${e.means} (${e.src || `not found in his library, ${NOT_CHECKED}`})`)];
}

const norm = s => String(s || '').toLowerCase();

/**
 * The teach brief's exam_wording (pure): the entries whose keys any of the names touch (the topic, its aliases, its
 * look-alikes, the pair), most matches first, at most max. null when none do.
 */
export function examWordingFor(names, max = 6, list = EXAM_WORDING) {
  const text = (Array.isArray(names) ? names : [names]).filter(Boolean).map(norm).join(' | ');
  if (!text) return null;
  const hits = [];
  list.forEach((e, i) => {
    const n = e.keys.filter(k => text.includes(k)).length;
    if (n) hits.push({ e, n, i });
  });
  if (!hits.length) return null;
  hits.sort((a, b) => b.n - a.n || a.i - b.i);
  return { rule: EXAM_WORDING_RULE, items: hits.slice(0, max).map(({ e }) => ({ phrase: e.phrase, means: e.means, source: e.src || NOT_CHECKED })) };
}
