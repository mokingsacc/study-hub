// The platform's subject catalogue (docs/platform/plan.md §4): data only, no imports and no logic beyond lookups.
// Each subject is {id, name, boards, tiers?, sections}. The sections are short, generic revision headings written
// for this hub in its own words: they are NOT a specification's wording and are the same whatever the board, so
// nothing here is copied from an exam board. The person picks their board and tier on the subject, can type a
// spec code if they like, and asks the AI for topic headings under each section. Add a subject here and nowhere else.

export const BOARDS = {
  aqa: 'AQA',
  edexcel: 'Pearson Edexcel',
  ocr: 'OCR',
  wjec: 'WJEC',
  eduqas: 'Eduqas',
  ccea: 'CCEA',
  other: 'Other',
};
export const BOARD_IDS = Object.keys(BOARDS);

export const TIERS = ['foundation', 'higher'];
export const TIER_NAMES = { foundation: 'Foundation', higher: 'Higher' };

// Board lists by how widely a subject is offered (every list ends with 'other').
const ALL = ['aqa', 'edexcel', 'ocr', 'wjec', 'eduqas', 'ccea', 'other'];
const BIG3 = ['aqa', 'edexcel', 'ocr', 'other'];
const BIG3_W = ['aqa', 'edexcel', 'ocr', 'wjec', 'other'];
const ENG = ['aqa', 'edexcel', 'ocr', 'eduqas', 'wjec', 'ccea', 'other'];
const LANGS = ['aqa', 'edexcel', 'ocr', 'eduqas', 'wjec', 'ccea', 'other'];
const AQA_EDX_OCR_WJEC = BIG3_W;

const s = (id, name, boards, sections, tiers) => (tiers ? { id, name, boards, tiers: [...tiers], sections } : { id, name, boards, sections });

// Language skills are the same four-skill shape in every language.
const LANGUAGE_SECTIONS = ['Vocabulary and themes', 'Grammar', 'Listening', 'Speaking', 'Reading', 'Writing and translation'];

const GCSE_SUBJECTS = [
  s('maths', 'Maths', ALL, ['Number', 'Algebra', 'Ratio, proportion and rates of change', 'Geometry and measures', 'Probability', 'Statistics'], TIERS),
  s('combined_science', 'Combined Science', BIG3_W, ['Biology', 'Chemistry', 'Physics'], TIERS),
  s('english_language', 'English Language', ENG, ['Reading fiction', 'Reading non-fiction', 'Creative and narrative writing', 'Writing to argue, explain or persuade', 'Spelling, punctuation and grammar']),
  s('english_literature', 'English Literature', ENG, ['Shakespeare play', '19th-century novel', 'Modern prose or drama', 'Poetry collection', 'Unseen poetry']),
  s('biology', 'Biology', BIG3_W, ['Cells and organisation', 'Health and disease', 'Photosynthesis and respiration', 'Body control and homeostasis', 'Genetics and evolution', 'Ecology and the environment', 'Practical skills'], TIERS),
  s('chemistry', 'Chemistry', BIG3_W, ['Atoms and the periodic table', 'Bonding and structure', 'Quantities and calculations', 'Reactions and energy changes', 'Rates and equilibrium', 'Organic chemistry', 'Analysis and the Earth', 'Practical skills'], TIERS),
  s('physics', 'Physics', BIG3_W, ['Energy', 'Forces and motion', 'Waves', 'Electricity', 'Magnetism and electromagnetism', 'Particles and matter', 'Space physics', 'Practical skills'], TIERS),
  s('geography', 'Geography', AQA_EDX_OCR_WJEC, ['Natural hazards', 'Rivers, coasts and landscapes', 'Weather, climate and ecosystems', 'Population and cities', 'Resources and development', 'Fieldwork and skills']),
  s('history', 'History', ENG, ['Medieval period', 'Early modern period', 'Modern period', 'A theme across time', 'Sources and interpretations']),
  s('religious_studies', 'Religious Studies', ALL, ['Beliefs and teachings', 'Practices and festivals', 'Ethical themes', 'Philosophy and meaning', 'Texts and sources']),
  s('computer_science', 'Computer Science', BIG3_W, ['Algorithms and programming', 'Data representation', 'Computer systems', 'Networks', 'Cyber security', 'Ethical, legal and environmental impacts']),
  s('french', 'French', LANGS, LANGUAGE_SECTIONS),
  s('spanish', 'Spanish', LANGS, LANGUAGE_SECTIONS),
  s('german', 'German', LANGS, LANGUAGE_SECTIONS),
  s('business', 'Business', BIG3_W, ['Starting and running a business', 'Marketing', 'Operations', 'Finance', 'People and organisations', 'Outside influences on business']),
  s('art', 'Art and Design', ALL, ['Developing ideas', 'Experimenting with media', 'Recording from observation', 'Studying other artists', 'Final piece and presentation']),
  s('pe', 'Physical Education', BIG3_W, ['Anatomy and physiology', 'Movement and training', 'Health and fitness', 'Sport psychology', 'Sport and society', 'Practical performance']),
  s('music', 'Music', ALL, ['Listening and appraising', 'Performing', 'Composing', 'Musical elements and notation', 'Styles and set works']),
  s('design_technology', 'Design and Technology', BIG3_W, ['Materials and components', 'Technical principles', 'Designing', 'Making', 'Evaluating and the wider impact']),
  s('statistics', 'Statistics', ['edexcel', 'aqa', 'other'], ['Collecting data', 'Displaying data', 'Averages and spread', 'Probability', 'Relationships between data', 'Time series and index numbers'], TIERS),
  s('further_maths', 'Further Maths', ['aqa', 'edexcel', 'ocr', 'other'], ['Algebra and functions', 'Calculus', 'Coordinate geometry', 'Trigonometry', 'Matrices and transformations', 'Sequences and proof']),
  s('drama', 'Drama', BIG3_W, ['Working with texts', 'Devising and performing', 'Design for the stage', 'Evaluating live theatre']),
  s('food_nutrition', 'Food Preparation and Nutrition', BIG3_W, ['Nutrition and health', 'Food science', 'Food choice and provenance', 'Planning and cooking skills', 'Safety and hygiene']),
  s('psychology', 'Psychology', ['aqa', 'edexcel', 'ocr', 'wjec', 'eduqas', 'other'], ['Memory', 'Development', 'Social influence', 'Mental health', 'Brain and behaviour', 'Research methods']),
  s('sociology', 'Sociology', ['aqa', 'edexcel', 'eduqas', 'wjec', 'other'], ['Families', 'Education', 'Crime and deviance', 'Social inequality', 'Research methods']),
];

const ALEVEL_SUBJECTS = [
  s('biology', 'Biology', BIG3_W, ['Biological molecules', 'Cells and how they work', 'Exchange and transport', 'Genes, inheritance and evolution', 'Energy transfer', 'Control and homeostasis', 'Populations and ecosystems', 'Practical skills and data']),
  s('chemistry', 'Chemistry', BIG3_W, ['Atomic structure and periodicity', 'Bonding and shapes', 'Energetics', 'Kinetics and equilibria', 'Redox and electrochemistry', 'Acids, bases and buffers', 'Organic chemistry', 'Transition metals', 'Analysis and spectroscopy', 'Practical skills']),
  s('physics', 'Physics', BIG3_W, ['Mechanics and materials', 'Electricity and circuits', 'Waves and optics', 'Fields and forces', 'Thermal physics and gases', 'Nuclear and particle physics', 'Astrophysics and cosmology', 'Practical skills and data']),
  s('psychology', 'Psychology', ['aqa', 'edexcel', 'ocr', 'wjec', 'eduqas', 'other'], ['Social influence', 'Memory', 'Attachment', 'Mental health conditions', 'Approaches and perspectives', 'Brain and behaviour', 'Research methods and statistics', 'Issues and debates', 'Option topics']),
  s('maths', 'Maths', ALL, ['Pure: algebra and functions', 'Pure: calculus', 'Pure: trigonometry and geometry', 'Sequences, series and proof', 'Statistics', 'Mechanics']),
  s('further_maths', 'Further Maths', BIG3_W, ['Complex numbers', 'Matrices', 'Further calculus', 'Differential equations', 'Further statistics', 'Further mechanics', 'Decision and discrete maths']),
  s('english_literature', 'English Literature', ENG, ['Prose texts', 'Poetry', 'Drama and Shakespeare', 'Unseen texts', 'Critical approaches and context', 'Independent study']),
  s('english_language', 'English Language', ['aqa', 'edexcel', 'eduqas', 'wjec', 'other'], ['Language and context', 'Language variation and change', 'Language and identity', "Children's language development", 'Original writing', 'Language investigation']),
  s('history', 'History', ENG, ['Breadth study', 'Depth study', 'Interpretations', 'Working with sources', 'Independent enquiry']),
  s('geography', 'Geography', AQA_EDX_OCR_WJEC, ['Water and carbon cycles', 'Hazards', 'Coasts', 'Changing places', 'Global systems and governance', 'Population and environment', 'Fieldwork and skills']),
  s('economics', 'Economics', ['aqa', 'edexcel', 'ocr', 'eduqas', 'other'], ['Markets and market failure', 'Firms and costs', 'Government intervention', 'The national economy', 'Macroeconomic policy', 'The global economy', 'Data and quantitative skills']),
  s('sociology', 'Sociology', ['aqa', 'edexcel', 'ocr', 'eduqas', 'wjec', 'other'], ['Education', 'Families and households', 'Beliefs in society', 'Crime and deviance', 'Research methods', 'Social theory', 'Culture and identity']),
  s('computer_science', 'Computer Science', BIG3_W, ['Programming and problem solving', 'Data structures and algorithms', 'Computer architecture', 'Data representation', 'Networks and the web', 'Databases and big data', 'Legal, ethical and social issues', 'Project work']),
  s('business', 'Business', ['aqa', 'edexcel', 'ocr', 'eduqas', 'other'], ['Business objectives and types', 'Marketing', 'Operations', 'Finance', 'People in organisations', 'Strategy and decisions', 'External influences', 'Data skills']),
  s('politics', 'Politics', ['aqa', 'edexcel', 'ocr', 'eduqas', 'other'], ['Democracy and participation', 'Parties and elections', 'Political ideas', 'Institutions of government', 'Comparative government']),
  s('religious_studies', 'Religious Studies / Philosophy', ALL, ['Philosophy of religion', 'Ethics', 'Beliefs and practices', 'Texts and developments']),
  s('law', 'Law', ['aqa', 'ocr', 'edexcel', 'other'], ['The legal system', 'Law-making', 'Criminal law', 'Civil law and tort', 'Human rights', 'Legal concepts']),
  s('art', 'Art and Design', ALL, ['Personal investigation', 'Externally set task', 'Techniques and media', 'Critical and contextual study']),
  s('pe', 'Physical Education', BIG3_W, ['Applied anatomy', 'Exercise physiology', 'Skill acquisition', 'Sport psychology', 'Sport and society', 'Biomechanics', 'Technology in sport']),
  s('music', 'Music', ALL, ['Appraising', 'Performing', 'Composing', 'Set works', 'Analysis']),
  s('drama', 'Drama and Theatre', BIG3_W, ['Set texts', 'Devising', 'Performing', 'Evaluating live theatre']),
  s('media_studies', 'Media Studies', ['aqa', 'edexcel', 'eduqas', 'wjec', 'other'], ['Media language and representation', 'Industries and audiences', 'Set products', 'Theory and context', 'Practical production']),
  s('french', 'French', LANGS, LANGUAGE_SECTIONS),
  s('spanish', 'Spanish', LANGS, LANGUAGE_SECTIONS),
  s('german', 'German', LANGS, LANGUAGE_SECTIONS),
];

// By catalogue name (profiles.js subjects.catalogue). The stub tracks have no catalogue yet.
export const SUBJECTS = {
  gcse: GCSE_SUBJECTS,
  alevel: ALEVEL_SUBJECTS,
};

/** The subjects of a catalogue, or [] for a catalogue that does not exist (a stub track). */
export function subjectsOf(catalogue) {
  return SUBJECTS[catalogue] || [];
}

/** One catalogue subject by id, or null. */
export function findSubject(catalogue, id) {
  return subjectsOf(catalogue).find(x => x.id === id) || null;
}

export const boardName = id => BOARDS[id] || BOARDS.other;
