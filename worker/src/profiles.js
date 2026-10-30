
export const DEFAULT_PROFILE = 'step2';

// The users table's CHECK lists (users.js re-exports them; kept here, a file with no imports, so the
// registries can read them without an import cycle).
export const ROLES = ['admin', 'student', 'viewer'];
export const STATUSES = ['active', 'paused', 'deleted'];

// Error-type sets by profile.rules.error_types (keys as stored in misses.error_type).
export const ERROR_TYPE_SETS = {
  usmle: ['knowledge_gap', 'misread', 'premature_closure', 'faulty_synthesis', 'test_taking', 'threshold', 'calculation'],
  // School tracks (platform): the same stored keys the misses/evidence CHECKs accept, in a shorter list.
  school: ['knowledge_gap', 'misread', 'calculation', 'test_taking', 'faulty_synthesis'],
};

// What a person sees for each school error type (plan §3).
export const ERROR_LABELS = {
  school: {
    knowledge_gap: "Didn't know it",
    misread: 'Misread the question',
    calculation: 'Calculation or unit slip',
    test_taking: 'Exam technique (command word, timing, not enough points)',
    faulty_synthesis: "Knew it, couldn't apply it",
  },
};


// ------------------------------------------------------------------ platform tracks (docs/platform/plan.md §3)

const BOARDS_ALL = ['aqa', 'edexcel', 'ocr', 'wjec', 'eduqas', 'ccea', 'other'];

const GCSE = {
  id: 'gcse', track: 'gcse', label: 'GCSE', platform: true, stub: false, exam: 'GCSE', exam_date: null,
  ui_locale: 'en-GB', content_locale: 'en-GB', guidelines: 'UK',
  categories: { seed: 'subjects', alias_vocabularies: ['other'] },
  subjects: { catalogue: 'gcse', defaults: ['maths', 'combined_science', 'english_language', 'english_literature'], max: 12 },
  boards: BOARDS_ALL,
  banks: ['past_paper', 'save_my_exams', 'seneca', 'pmt', 'other_app'],
  sources: ['results', 'cards', 'gaps', 'library'], spoken: [], checklist: { kind: 'none' }, yield_inputs: [],
  modules: { on: ['results', 'cards', 'library', 'connector', 'gaps', 'ai_topics', 'countdown', 'exams', 'mnemonics'], off: ['papers', 'anki_link'] },
  cards: { style: 'basic', store: 'hub', deck: null },
  teach: { skill: null, fact_checker: null, final: 'exam_question' },
  ai: { conversation: 'subscription', tasks: ['screenshot', 'topics', 'cards', 'paper'] },
  rules: { protected_text: ['exam_board', 'question_bank'], results_after_sitting: false, error_types: 'school', no_card_for: ['misread'] },
};

const ALEVEL = {
  ...GCSE, id: 'alevel', track: 'alevel', label: 'A-level', exam: 'A-level',
  subjects: { catalogue: 'alevel', defaults: ['biology', 'chemistry', 'psychology'], max: 5 },
  banks: ['past_paper', 'save_my_exams', 'pmt', 'seneca', 'isaac', 'other_app'],
};

// Stubs: offered on the platform, catalogue not ready yet (no subjects are seeded; the person gets a plain message).
const STUB = {
  platform: true, stub: true, exam_date: null, ui_locale: 'en-GB', content_locale: 'en-GB', guidelines: 'UK',
  boards: [], banks: [], sources: ['results', 'cards', 'gaps', 'library'], spoken: [], checklist: { kind: 'none' }, yield_inputs: [],
  modules: { on: ['cards', 'connector', 'gaps', 'countdown', 'mnemonics'], off: ['results', 'library', 'ai_topics', 'papers', 'anki_link'] },
  ai: { conversation: 'subscription', tasks: ['topics', 'cards'] },
};

const LANGUAGE = {
  ...STUB, id: 'language', track: 'language', label: 'A language', exam: 'Language level',   // profile_json {language: 'es', level: 'A2'}
  categories: { seed: 'skills', alias_vocabularies: ['other'] },                              // Vocabulary, Grammar, Listening, Reading, Speaking, Writing
  subjects: { catalogue: 'language', defaults: [], max: 3 },
  banks: ['other_app'],
  cards: { style: 'vocab', store: 'hub', deck: null },
  teach: { skill: null, fact_checker: null, final: 'translation' },
  rules: { protected_text: ['exam_board', 'question_bank'], results_after_sitting: false, error_types: 'school', no_card_for: ['misread'] },
};

const UK_MED = {
  ...STUB, id: 'uk_med', track: 'uk_med', label: 'UK medicine', exam: 'UKMLA AKT | MRCP Part 1 | PLAB 1 | finals',
  categories: { seed: 'systems', alias_vocabularies: ['other'] },                             // the 23 systems from map/systems.js, UK names
  subjects: { catalogue: 'uk_med', defaults: [], max: 1 },
  banks: ['passmedicine', 'quesmed', 'pastest', 'bmj_oe', 'uworld', 'amboss'],
  cards: { style: 'basic', store: 'hub', deck: null },
  teach: { skill: null, fact_checker: null, final: 'vignette' },
  rules: { protected_text: ['uworld', 'amboss', 'passmedicine', 'quesmed', 'pastest'], results_after_sitting: false, error_types: 'usmle', no_card_for: ['misread', 'test_taking'] },
};

// Open tracks (30 Oct): any level, from primary SATs to university. No built-in subject list: their Claude adds their
// subjects by name with them (subject_edit) and researches the course; everything else works as for GCSE.
const OPEN = {
  ...GCSE, boards: ['other'], banks: ['past_paper', 'other_app'],
  subjects: { catalogue: null, defaults: [], max: 12 },
};
const PRIMARY = { ...OPEN, id: 'primary', track: 'primary', label: 'Primary school (SATs)', exam: 'Key Stage 2 SATs' };
const UNIVERSITY = { ...OPEN, id: 'university', track: 'university', label: 'University', exam: 'University exams and coursework' };
const OTHER_TRACK = { ...OPEN, id: 'other', track: 'other', label: 'Something else', exam: 'Your exams' };

export const PROFILES = deepFreeze({
  step2: {
    id: 'step2',
    track: 'step2', label: 'USMLE Step 2 CK', platform: false, stub: false,
    exam: 'USMLE Step 2 CK',
    exam_date: '2027-06-30',
    ui_locale: 'en-GB', content_locale: 'en-US', guidelines: 'US',
    categories: { seed: 'hub_systems', alias_vocabularies: ['uworld_system', 'uworld_subject', 'checklist_system', 'onenote_section', 'hub_system', 'amboss'] },
    sources: ['anki_voice', 'hub_nbme', 'uworld', 'mehlman', 'anking', 'nbme_hy', 'amboss', 'onenote', 'gaps'],
    // evidence.source values for spoken reasoning, now and later.
    spoken: ['uworld', 'nbme', 'anki_desktop', 'ankimobile', 'anki_voice', 'gap_note'],
    checklist: { kind: 'master_checklist', lanes: ['A', 'B', 'C'], steps: ['recognise', 'distinguish', 'test', 'treat', 'trap'], rating: false },
    yield_inputs: ['lane', 'mehlman_rank', 'nbme_images', 'q_seen', 'anking_cards'],
    cards: { style: 'mo_step2', store: 'anki_voice', deck: 'Step 2 — My Cards' },
    teach: { skill: 'step2-teach', fact_checker: 'mehlman', final: 'vignette' },
    ai: { conversation: 'subscription', tutor: null },
    rules: { protected_text: ['uworld', 'nbme'], results_after_sitting: true, error_types: 'usmle', no_card_for: ['misread', 'test_taking'] },
    // Platform fields, set so step2 behaves exactly as it did: no subjects or boards; the module defaults equal what
    // platform/modules.js falls back to for a profile without any (everything the track could offer is on).
    subjects: { catalogue: null, defaults: [], max: 0 },
    boards: [],
    banks: [],
    modules: { on: ['results', 'cards', 'library', 'connector', 'gaps', 'ai_topics', 'countdown'], off: ['papers', 'anki_link'] },
  },
  gcse: GCSE,
  alevel: ALEVEL,
  language: LANGUAGE,
  uk_med: UK_MED,
  primary: PRIMARY,
  university: UNIVERSITY,
  other: OTHER_TRACK,
});

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// A fresh, unfrozen copy of base with over laid on top: objects merge key by key, anything else
// (lists included) replaces. Neither input is changed.
export function deepMerge(base, over) {
  const out = {};
  for (const [k, v] of Object.entries(base || {})) out[k] = isObj(v) ? deepMerge(v, {}) : Array.isArray(v) ? [...v] : v;
  for (const [k, v] of Object.entries(over || {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : isObj(v) ? deepMerge(v, {}) : Array.isArray(v) ? [...v] : v;
  }
  return out;
}

// The named profile with a user's overrides on top (unknown names fall back to the default profile, so a
// typo in a users row never leaves a learner without rules).
export function buildProfile(name, overrides = {}) {
  const base = PROFILES[name] || PROFILES[DEFAULT_PROFILE];
  const merged = deepMerge(base, isObj(overrides) ? overrides : {});
  merged.id = base.id;
  return merged;
}

export function errorTypesFor(profile) {
  return ERROR_TYPE_SETS[profile && profile.rules && profile.rules.error_types] || ERROR_TYPE_SETS.usmle;
}

/**
 * The tracks the platform offers, in display order: [{id, label, exam, stub}]. A stub is offered but has no
 * catalogue yet (nobody is seeded into it). Pass {complete: true} for only the finished tracks.
 */
export function platformTracks({ complete = false } = {}) {
  return Object.values(PROFILES)
    .filter(p => p.platform && (!complete || !p.stub))
    .map(p => ({ id: p.id, label: p.label, exam: p.exam, stub: !!p.stub }));
}
