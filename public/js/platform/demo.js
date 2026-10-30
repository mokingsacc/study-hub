// Demo mode (?demo=1 or #demo; add &track=gcse for the GCSE student): in-memory answers that follow
// docs/platform/api.md exactly, so every screen works with no server. Loaded only in demo mode; nothing is stored.
const P = new URLSearchParams(location.search);
const TRACK = P.get('track') === 'gcse' ? 'gcse' : 'alevel';
const LABEL = { alevel: 'A-level', gcse: 'GCSE' }[TRACK];
const DAY = 864e5;
let n = 1000;
const nid = p => `${p}${++n}`;
const iso = (offset = 0) => { const d = new Date(Date.now() + offset * DAY); return d.toISOString().slice(0, 10); };
const clone = x => JSON.parse(JSON.stringify(x));

const BOARDS = { aqa: 'AQA', edexcel: 'Pearson Edexcel', ocr: 'OCR', wjec: 'WJEC', eduqas: 'Eduqas', ccea: 'CCEA', other: 'Other' };
const ALL = ['aqa', 'edexcel', 'ocr', 'wjec', 'eduqas', 'ccea', 'other'], BIG = ['aqa', 'edexcel', 'ocr', 'wjec', 'other'];
const TIERS = ['foundation', 'higher'];
const LANG = ['Vocabulary and themes', 'Grammar', 'Listening', 'Speaking', 'Reading', 'Writing and translation'];
const CATALOGUE = {
  alevel: [
    ['biology', 'Biology', BIG, ['Biological molecules', 'Cells and how they work', 'Exchange and transport', 'Genes, inheritance and evolution', 'Energy transfer', 'Control and homeostasis', 'Populations and ecosystems', 'Practical skills and data']],
    ['chemistry', 'Chemistry', BIG, ['Atomic structure and periodicity', 'Bonding and shapes', 'Energetics', 'Kinetics and equilibria', 'Redox and electrochemistry', 'Acids, bases and buffers', 'Organic chemistry', 'Transition metals', 'Analysis and spectroscopy', 'Practical skills']],
    ['psychology', 'Psychology', ['aqa', 'edexcel', 'ocr', 'wjec', 'eduqas', 'other'], ['Social influence', 'Memory', 'Attachment', 'Mental health conditions', 'Approaches and perspectives', 'Brain and behaviour', 'Research methods and statistics', 'Issues and debates', 'Option topics']],
    ['physics', 'Physics', BIG, ['Mechanics and materials', 'Electricity and circuits', 'Waves and optics', 'Fields and forces', 'Thermal physics and gases', 'Nuclear and particle physics']],
    ['maths', 'Maths', ALL, ['Pure: algebra and functions', 'Pure: calculus', 'Pure: trigonometry and geometry', 'Sequences, series and proof', 'Statistics', 'Mechanics']],
    ['english_literature', 'English Literature', ALL, ['Prose texts', 'Poetry', 'Drama and Shakespeare', 'Unseen texts']],
    ['sociology', 'Sociology', ['aqa', 'edexcel', 'ocr', 'eduqas', 'wjec', 'other'], ['Education', 'Families and households', 'Crime and deviance', 'Research methods']],
    ['economics', 'Economics', ['aqa', 'edexcel', 'ocr', 'eduqas', 'other'], ['Markets and market failure', 'The national economy', 'The global economy']],
    ['history', 'History', ALL, ['Breadth study', 'Depth study', 'Interpretations', 'Working with sources']],
  ],
  gcse: [
    ['maths', 'Maths', ALL, ['Number', 'Algebra', 'Ratio, proportion and rates of change', 'Geometry and measures', 'Probability', 'Statistics'], TIERS],
    ['combined_science', 'Combined Science', BIG, ['Biology', 'Chemistry', 'Physics'], TIERS],
    ['english_language', 'English Language', ALL, ['Reading fiction', 'Reading non-fiction', 'Creative and narrative writing', 'Writing to argue, explain or persuade', 'Spelling, punctuation and grammar']],
    ['english_literature', 'English Literature', ALL, ['Shakespeare play', '19th-century novel', 'Modern prose or drama', 'Poetry collection', 'Unseen poetry']],
    ['biology', 'Biology', BIG, ['Cells and organisation', 'Health and disease', 'Photosynthesis and respiration', 'Genetics and evolution', 'Ecology and the environment'], TIERS],
    ['chemistry', 'Chemistry', BIG, ['Atoms and the periodic table', 'Bonding and structure', 'Quantities and calculations', 'Rates and equilibrium', 'Organic chemistry'], TIERS],
    ['physics', 'Physics', BIG, ['Energy', 'Forces and motion', 'Waves', 'Electricity', 'Magnetism and electromagnetism'], TIERS],
    ['geography', 'Geography', BIG, ['Natural hazards', 'Rivers, coasts and landscapes', 'Population and cities', 'Fieldwork and skills']],
    ['history', 'History', ALL, ['Medieval period', 'Early modern period', 'Modern period', 'Sources and interpretations']],
    ['religious_studies', 'Religious Studies', ALL, ['Beliefs and teachings', 'Practices and festivals', 'Ethical themes']],
    ['computer_science', 'Computer Science', BIG, ['Algorithms and programming', 'Data representation', 'Computer systems', 'Networks', 'Cyber security']],
    ['french', 'French', ALL, LANG],
    ['spanish', 'Spanish', ALL, LANG],
    ['business', 'Business', BIG, ['Starting and running a business', 'Marketing', 'Operations', 'Finance']],
  ],
}[TRACK].map(([id, name, boards, sections, tiers]) => (tiers ? { id, name, boards, tiers, sections } : { id, name, boards, sections }));
const DEFAULTS = TRACK === 'alevel' ? ['biology', 'chemistry', 'psychology'] : ['maths', 'combined_science', 'english_language', 'english_literature'];

// Seed topics: section -> [[name, t1000 or null]].
const SEED = TRACK === 'alevel' ? {
  biology: { board: 'aqa', topics: [
    ['Carbohydrates', 120], ['Lipids', 260], ['Proteins', 180], ['Enzymes', 640], ['Nucleic acids', 450], ['ATP', null], ['Water and inorganic ions', null],
    '|', ['Cell structure', 90], ['Microscopy', 380], ['Mitosis and the cell cycle', 520], ['Cell membranes', 300], ['Osmosis', 760], ['Active transport', 610], ['Immune response', 880], ['Vaccines', null],
    '|', ['Gas exchange in fish and insects', 700], ['Lungs and ventilation', 340], ['Digestion and absorption', null], ['Haemoglobin', 820], ['Circulation', 410], ['Xylem and phloem', null],
    '|', ['DNA and chromosomes', 230], ['Protein synthesis', 590], ['Meiosis', 690], ['Genetic diversity', null], ['Natural selection', 150], ['Classification', null],
    '|', ['Photosynthesis', 840], ['Respiration', 720], ['Energy in ecosystems', null], ['Nutrient cycles', null],
    '|', ['Nerve impulses', null], ['Synapses', null], ['Blood glucose control', null],
    '|',
    '|', ['Required practicals', 330], ['Statistical tests', 900]] },
  chemistry: { board: 'ocr', topics: [
    ['Mass spectrometry', 210], ['Electron configuration', 160], ['Ionisation energies', 560], ['Periodic trends', 280],
    '|', ['Ionic bonding', 100], ['Covalent bonding', 190], ['Shapes of molecules', 620], ['Intermolecular forces', 470],
    '|', ['Enthalpy changes', 380], ["Hess's law", 740], ['Bond enthalpies', 300], ['Born-Haber cycles', null],
    '|', ['Collision theory', 140], ['Maxwell-Boltzmann distribution', 440], ["Le Chatelier's principle", 520], ['Kc calculations', 810],
    '|', ['Oxidation states', 230], ['Half equations', 580],
    '|', ['pH calculations', 860], ['Buffers', null],
    '|', ['Alkanes', 170], ['Alkenes', 260], ['Haloalkanes', 490], ['Alcohols', 350], ['Isomerism', 680],
    '|',
    '|', ['Infrared spectroscopy', 300], ['Mass spectra of organic compounds', null], ['NMR spectroscopy', null]] },
  psychology: { board: 'aqa', topics: [
    ['Conformity', 120], ['Obedience', 200], ['Minority influence', 340],
    '|', ['Multi-store model', 90], ['Working memory model', 260], ['Eyewitness testimony', 480],
    '|', ['Caregiver-infant interactions', 310], ["Bowlby's theory", 560], ['Strange Situation', 220],
    '|', ['Definitions of abnormality', 410], ['Phobias', null], ['Depression', 630], ['OCD', 780],
    '|', ['Behaviourism', 150], ['Social learning theory', 270], ['Cognitive approach', 330], ['Biological approach', 520], ['Psychodynamic approach', 690],
    '|', ['Nervous system', 600], ['Endocrine system', 710], ['Localisation of function', null], ['Biological rhythms', null],
    '|', ['Experimental designs', 380], ['Sampling', 230], ['Inferential tests', 920], ['Reliability and validity', 650]] },
} : {
  maths: { board: 'edexcel', tier: 'higher', topics: [
    ['Fractions and decimals', 120], ['Indices and surds', 580], ['Standard form', 260], ['Upper and lower bounds', 720],
    '|', ['Expanding and factorising', 210], ['Quadratic equations', 470], ['Simultaneous equations', 640], ['Functions', null], ['Sequences', 300],
    '|', ['Ratio problems', 280], ['Percentages', 150], ['Direct and inverse proportion', 690],
    '|', ['Pythagoras', 110], ['Trigonometry', 520], ['Circle theorems', 870], ['Vectors', 790], ['Area and volume', 340],
    '|', ['Tree diagrams', 450], ['Venn diagrams', 230],
    '|', ['Averages', 90], ['Histograms', 760], ['Cumulative frequency', null]] },
  combined_science: { board: 'aqa', tier: 'higher', topics: [
    ['Cells', 160], ['Osmosis', 540], ['Enzymes', 300], ['Homeostasis', 620], ['Inheritance', null],
    '|', ['Atomic structure', 200], ['Bonding', 410], ['Quantitative chemistry', 830], ['Electrolysis', 700], ['Rates of reaction', null],
    '|', ['Energy stores', 260], ['Circuits', 590], ['Particle model', 330], ['Forces', 480], ['Waves', null]] },
  english_language: { board: 'aqa', topics: [
    ['Language analysis', 380], ['Structure questions', 610], ['Evaluating a text', 520],
    '|', ['Summary', 250], ['Comparing viewpoints', 680],
    '|', ['Descriptive writing', 300], ['Narrative writing', 420],
    '|', ['Persuasive techniques', 210], ['Letters and articles', null],
    '|', ['Punctuation for effect', 450]] },
  english_literature: { board: 'aqa', topics: [
    ['Macbeth: themes', 330], ['Macbeth: characters', 280], ['Macbeth: key quotations', 640],
    '|', ['A Christmas Carol: context', 410], ["Scrooge's change", 200],
    '|', ['An Inspector Calls: themes', 360], ['Mr Birling', 150],
    '|', ['Comparing poems', 720], ['Ozymandias', 500], ['Exposure', null],
    '|', ['Unseen poetry analysis', 810]] },
};

// ------------------------------------------------------------------ state
const S = {
  signedOut: false,
  me: { user: TRACK === 'alevel' ? 'sara-k7m2' : 'adam-p3x9', name: TRACK === 'alevel' ? 'Sara' : 'Adam', profile: TRACK },
  exam_date: TRACK === 'alevel' ? '2027-05-13' : '2027-05-11',
  email: null,
  modules: { map: true, results: true, cards: true, library: true, connector: true, gaps: true, ai_topics: true, countdown: true, papers: false, exams: false, anki_link: false },
  subjects: [], topics: [], cards: [], results: [], library: [], gaps: [], batches: {}, links: [],
  ai: { provider: 'workers_ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', daily: 1, monthly: 10, today: 0.04, month: 0.62, calls: 3, keys: [] },
  reviewedToday: 6,
};
const MODULE_LABELS = { map: 'Subjects and topics', results: 'Log results from question banks and past papers', cards: 'Flashcards', library: 'Library: your papers, mark schemes and notes',
  connector: 'Use your own Claude with the hub', gaps: '"Gap:" notes', ai_topics: 'AI suggests topics for each subject', countdown: 'Days to your exams',
  papers: 'Write practice papers in the app (needs your own Claude key)', exams: 'Exams and practice papers: past papers on screen, practice papers your Claude writes', anki_link: 'Link your own Anki' };

const cat = id => CATALOGUE.find(c => c.id === id);
function addSubject(sid, board = 'other', tier = null, name = null) {
  const c = cat(sid);
  const id = `${TRACK}-${sid}`;
  const sub = { id, subject: sid, name: name || (c ? c.name : 'My subject'), track: TRACK, board, tier: c && c.tiers ? (tier || 'higher') : null,
    spec_code: null, exam_year: 2027, status: 'active', sort: S.subjects.length, sections: (c ? c.sections : ['General']).map((nm, i) => ({ id: `${id}-s${i + 1}`, name: nm })) };
  S.subjects.push(sub);
  return sub;
}
function addTopic(subject, section, name, t1000) {
  const t = { id: nid('t'), name, subject_id: subject.id, section, t1000: t1000 == null ? null : t1000, status: 'confirmed', retired: false };
  S.topics.push(t);
  return t;
}
for (const sid of DEFAULTS) {
  const seed = SEED[sid];
  const sub = addSubject(sid, seed ? seed.board : 'other', seed && seed.tier);
  if (!seed) continue;
  let sec = 0;
  for (const x of seed.topics) {
    if (x === '|') { sec++; continue; }
    addTopic(sub, sub.sections[sec].name, x[0], x[1]);
  }
}

const bandOf = t => (t == null ? null : t < 200 ? 'Strong' : t < 400 ? 'Getting there' : t < 600 ? 'Shaky' : t < 800 ? 'Weak' : 'Very weak');
const live = () => S.topics.filter(t => !t.retired);
const chip = t => ({ id: t.id, name: t.name, band: bandOf(t.t1000), t1000: t.t1000, seen: t.t1000 != null });
function subjectOut(s) {
  const ts = live().filter(t => t.subject_id === s.id);
  const seen = ts.filter(t => t.t1000 != null), weak = seen.filter(t => t.t1000 >= 600);
  return { id: s.id, subject: s.subject, name: s.name, track: s.track, board: s.board, board_name: BOARDS[s.board] || 'Other', tier: s.tier, spec_code: s.spec_code,
    exam_year: s.exam_year, status: s.status, topics_n: ts.length, seen_n: seen.length, weak_n: weak.length, ring: ts.length ? (seen.length - weak.length) / ts.length : 0 };
}
const active = () => S.subjects.filter(s => s.status === 'active');
const findSubj = id => active().find(s => s.id === id);
function batch(undo) { const id = nid('b'); S.batches[id] = undo; return id; }

// Cards
const CARD_SEED = TRACK === 'alevel' ? [
  ['What is osmosis?', 'The net movement of water from a less negative to a more negative water potential, across a partially permeable membrane.', 'Osmosis'],
  ['What does a competitive inhibitor do?', 'It has a similar shape to the substrate, binds the active site and blocks substrate binding. More substrate reduces its effect.', 'Enzymes'],
  ['Name the two stages of photosynthesis and where each happens.', 'Light-dependent reaction in the thylakoid membranes; light-independent reaction (Calvin cycle) in the stroma.', 'Photosynthesis'],
  ['What is the role of haemoglobin\'s cooperative binding?', 'Once one oxygen binds, the shape changes so the next ones bind more easily: the S-shaped dissociation curve.', 'Haemoglobin'],
  ['State Hess\'s law.', 'The enthalpy change of a reaction is the same whatever route is taken, if the start and end conditions are the same.', "Hess's law"],
  ['How do you calculate the pH of a strong acid?', 'pH = -log10[H+]. For a strong monoprotic acid, [H+] equals the acid concentration.', 'pH calculations'],
  ['What does Kc not include?', 'Solids and pure liquids. Only gases and aqueous species appear in the expression.', 'Kc calculations'],
  ['Asch: what was the conformity rate on critical trials?', 'About 37% of answers conformed; 75% of people conformed at least once.', 'Conformity'],
  ['Name three features of OCD (behavioural, emotional, cognitive).', 'Compulsions; anxiety and distress; obsessive thoughts.', 'OCD'],
  ['When do you use a Wilcoxon test?', 'A difference, related design (repeated measures or matched pairs), ordinal data.', 'Inferential tests'],
  ['What is the endocrine system?', 'Glands that release hormones into the blood to act on target organs; slower than the nervous system.', 'Endocrine system'],
  ['Name the stages of meiosis that create variation.', 'Crossing over in prophase I and independent segregation in metaphase I.', 'Meiosis'],
  ['What is an antigen?', 'A molecule (often a protein) on a cell surface that triggers an immune response.', 'Immune response'],
  ['What is the Strange Situation measuring?', 'Attachment type: proximity seeking, exploration, stranger anxiety, separation anxiety and reunion behaviour.', 'Strange Situation'],
] : [
  ['What is the angle at the centre theorem?', 'The angle at the centre is twice the angle at the circumference from the same arc.', 'Circle theorems'],
  ['How do you find the upper bound of 3.4 (1 d.p.)?', 'Add half the unit: 3.45.', 'Upper and lower bounds'],
  ['What does a histogram\'s y-axis show?', 'Frequency density = frequency / class width.', 'Histograms'],
  ['Simplify √50.', '5√2', 'Indices and surds'],
  ['What is the formula for the nth term of an arithmetic sequence?', 'a + (n - 1)d, or dn + (a - d).', 'Sequences'],
  ['What happens at the cathode in electrolysis?', 'Positive ions gain electrons (reduction).', 'Electrolysis'],
  ['What is the relative formula mass of CO2?', '12 + 16 + 16 = 44', 'Quantitative chemistry'],
  ['What is osmosis?', 'Diffusion of water from a dilute to a concentrated solution through a partially permeable membrane.', 'Osmosis'],
  ['What does Priestley show through Mr Birling?', 'The arrogance and selfishness of capitalist, upper-middle-class men; dramatic irony undermines him.', 'Mr Birling'],
  ['Give a key quotation for Lady Macbeth\'s ambition.', '"Look like th\' innocent flower, / But be the serpent under\'t."', 'Macbeth: key quotations'],
  ['What is a vector?', 'A quantity with size and direction.', 'Vectors'],
  ['V = IR: what is R?', 'Resistance in ohms.', 'Circuits'],
];
for (const [i, [front, back, tn]] of CARD_SEED.entries()) {
  const t = S.topics.find(x => x.name === tn);
  S.cards.push({ id: ++n, front, back, subject_id: t ? t.subject_id : null, topic_id: t ? t.id : null, source: 'mine', state: i < 9 ? 'review' : 'new',
    due_at: Date.now() - (i < 11 ? 3600e3 : -3 * DAY), lapses: i % 4 === 0 ? 1 : 0, suspended: false });
}
const cardOut = c => ({ id: c.id, front: c.front, back: c.back, subject_id: c.subject_id, topic_id: c.topic_id, state: c.state, due_at: c.due_at, suspended: !!c.suspended, lapses: c.lapses });
const cardFull = c => ({ ...cardOut(c), source: c.source, lapses: c.lapses, suspended: !!c.suspended });
const due = () => S.cards.filter(c => !c.suspended && c.due_at <= Date.now()).sort((a, b) => a.due_at - b.due_at);

// Banks (the person's track only), from worker/src/platform/banks.js.
const SHOT = 'Take a screenshot (side button + volume up).';
const BANKS = [
  { id: 'seneca', name: 'Seneca', how: ['screenshot', 'typed'], steps: ['Finish a Seneca session and stay on the results screen.', SHOT, 'Tap Log results, choose Seneca, then pick or paste the screenshot.', 'Check the rows and fix any topic, then Save.'], hint: 'Seneca shows a score for each topic, so each row is a topic, not a single question.' },
  { id: 'save_my_exams', name: 'Save My Exams', how: ['screenshot', 'typed'], steps: ['Finish a set of questions and open the results page.', 'On the results page, take a screenshot (side button + volume up).', 'Tap Log results, choose Save My Exams, then pick the screenshot.', 'Check the rows and fix any topic, then Save.'], hint: 'Works with the results summary or the marks list. Scroll and take more than one screenshot if the list is long (up to 4).' },
  { id: 'past_paper', name: 'Past paper', how: ['typed'], steps: ['Do the paper, then mark it yourself with the mark scheme.', 'Tap Log results and choose Past paper.', 'Add one row for each question: its number, the marks you got, the marks it was out of, and the topic.', 'Check the topics, then Save.'], hint: 'Type your own marks, question by question. Use the topic from the mark scheme, in a few words.' },
  { id: 'pmt', name: 'Physics & Maths Tutor', how: ['typed', 'screenshot'], steps: ['Print or open the paper and its mark scheme from Physics & Maths Tutor.', 'Mark your answers yourself against the mark scheme.', 'Tap Log results and choose Physics & Maths Tutor.', "Type each question's marks and its topic (or screenshot your own marks table), then Save."], hint: 'The site has no results screen, so this is your own marking.' },
  { id: 'isaac', name: 'Isaac Physics', how: ['screenshot', 'typed'], steps: ['Open your Isaac Physics assignment or progress page.', SHOT, 'Tap Log results, choose Isaac Physics, then pick the screenshot.', 'Check the rows and fix any topic, then Save.'], hint: 'Each row is one question part, right or wrong.' },
  { id: 'other_app', name: 'Another app or website', how: ['screenshot', 'typed'], steps: ['Finish your questions and open the screen that shows your score.', SHOT, 'Tap Log results, choose Another app, then pick the screenshot.', 'Check the rows and fix any topic, then Save.'], hint: 'Anything with a score screen works. If the read is wrong, type the rows yourself.' },
];
{
  const s0 = active()[0], s1 = active()[1];
  S.results.push({ id: nid('r'), bank: 'seneca', bank_name: 'Seneca', subject_id: s0.id, day: iso(-1), label: 'Cells revision', how: 'screenshot', right_n: 14, total_n: 20, marks: null, out_of: null });
  S.results.push({ id: nid('r'), bank: 'past_paper', bank_name: 'Past paper', subject_id: s1.id, day: iso(-4), label: 'Paper 1 June 2024', how: 'typed', right_n: null, total_n: null, marks: 58, out_of: 100 });
  S.results.push({ id: nid('r'), bank: 'save_my_exams', bank_name: 'Save My Exams', subject_id: s0.id, day: iso(-9), label: null, how: 'screenshot', right_n: 9, total_n: 12, marks: 21, out_of: 30 });
}

// Library
const LIB_SEED = TRACK === 'alevel' ? [
  ['file', 'Biology Paper 1 June 2023', 'past_paper', 0, 'bio-paper1-2023.pdf', 'application/pdf', 2_480_000, 36, 'Answer all questions. 1 (a) Describe how water moves into a plant cell by osmosis when it is placed in a dilute solution. Osmosis is the movement of water across a partially permeable membrane.'],
  ['file', 'Biology Paper 1 mark scheme 2023', 'mark_scheme', 0, 'bio-ms1-2023.pdf', 'application/pdf', 980_000, 28, 'Accept: water moves by osmosis from a higher (less negative) water potential to a lower water potential. 1 mark for partially permeable membrane.'],
  ['note', 'My notes on enzyme inhibition', 'notes', 0, null, 'text/plain', 1_800, null, 'Competitive inhibitors bind the active site. Non-competitive inhibitors bind elsewhere and change the shape of the active site. Increasing substrate concentration overcomes competitive inhibition but not non-competitive.'],
  ['link', 'Chemistry specification', 'spec', 1, null, null, 0, null, null, 'https://www.ocr.org.uk/qualifications/as-and-a-level/chemistry-a-h032-h432-from-2015/'],
  ['file', 'Psychology revision guide: Memory', 'textbook', 2, 'memory-guide.pdf', 'application/pdf', 5_600_000, 64, 'The multi-store model describes memory as a flow through the sensory register, short-term memory and long-term memory. Working memory replaces the single short-term store with the central executive, phonological loop and visuo-spatial sketchpad.'],
] : [
  ['file', 'Maths Paper 1 (Higher) November 2023', 'past_paper', 0, 'maths-p1h-2023.pdf', 'application/pdf', 1_900_000, 24, 'Answer ALL questions. 14 Here is a histogram. Use the histogram to find the frequency density for each class. Circle theorems: the angle at the centre is twice the angle at the circumference.'],
  ['file', 'Maths Paper 1 mark scheme', 'mark_scheme', 0, 'maths-ms1h-2023.pdf', 'application/pdf', 640_000, 18, 'M1 for frequency density = frequency / class width. A1 cao. Circle theorems: B1 for angle at the centre is twice the angle at the circumference.'],
  ['note', 'Macbeth quotes to learn', 'notes', 3, null, 'text/plain', 1_200, null, '"Look like th\' innocent flower, but be the serpent under\'t." "Is this a dagger which I see before me?" "Out, damned spot!"'],
  ['link', 'Combined Science specification', 'spec', 1, null, null, 0, null, null, 'https://www.aqa.org.uk/subjects/science/gcse/combined-science-trilogy-8464'],
];
for (const [i, row] of LIB_SEED.entries()) {
  const [kind, title, doc_type, si, filename, mime, size, pages, text, url] = row;
  S.library.push({ id: nid('l'), kind, title, subject_id: active()[si] ? active()[si].id : null, doc_type, filename, mime, size, pages, url: url || null,
    text_status: kind === 'link' ? 'none' : 'ready', created_at: Date.now() - (i + 1) * 2 * DAY, text });
}
const itemOut = it => ({ id: it.id, kind: it.kind, title: it.title, subject_id: it.subject_id, doc_type: it.doc_type, filename: it.filename, mime: it.mime, size: it.size,
  pages: it.pages, url: it.kind === 'file' ? `/api/p/library/${it.id}/file` : it.kind === 'link' ? it.url : null, text_status: it.text_status, created_at: it.created_at });

// ------------------------------------------------------------------ routes
const E = (status, error) => ({ status, data: { error } });
const OK = (data, status = 200) => ({ status, data: clone(data) });
const AI_PROVIDERS = [
  { id: 'workers_ai', name: 'Built-in AI', needs_key: false, models: [{ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B (built in)' }, { id: '@cf/meta/llama-3.2-11b-vision-instruct', label: 'Llama 3.2 Vision (built in)' }] },
  { id: 'anthropic', name: 'Claude', needs_key: true, models: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }, { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)' }, { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best, dearest)' }] },
  { id: 'openai', name: 'ChatGPT (OpenAI)', needs_key: true, models: [{ id: 'gpt-5-mini', label: 'GPT-5 mini' }, { id: 'gpt-5', label: 'GPT-5' }] },
  { id: 'gemini', name: 'Gemini', needs_key: true, models: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }, { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }] },
];
const aiOut = () => ({ provider: S.ai.provider, provider_name: AI_PROVIDERS.find(p => p.id === S.ai.provider).name, model: S.ai.model,
  caps: { daily_usd: S.ai.daily, monthly_usd: S.ai.monthly, ceiling_usd: 30 }, spend: { today_usd: S.ai.today, month_usd: S.ai.month, calls_today: S.ai.calls },
  keys: S.ai.keys, providers: AI_PROVIDERS });
const meOut = () => ({ user: S.me.user, name: S.me.name, track: TRACK, track_label: LABEL, exam_date: S.exam_date, email_set: !!S.email,
  modules: Object.keys(MODULE_LABELS).map(id => ({ id, label: MODULE_LABELS[id], on: S.modules[id], can_switch: !['map', 'anki_link'].includes(id) })) });
const offWhen = id => (S.modules[id] ? null : E(404, 'This part is switched off. You can turn it on in Settings.'));

const SUGGEST_EXTRA = ['Key words and definitions', 'Required practical', 'Common exam questions', 'Calculations', 'Applying the ideas', 'Evaluating studies', 'Linking ideas together'];

const R = [];
const on = (method, pattern, fn, ms) => R.push([method, new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$'), fn, ms]);

on('GET', '/api/auth/me', () => (S.signedOut ? E(401, 'Please sign in.') : OK({ ...S.me, must_change: false, csrf: 'demo-csrf' })));
on('POST', '/api/auth/login', (b) => {
  if (!b.username || !b.password) return E(400, 'Please fill in your login name and password.');
  if (b.password === 'wrong') return E(401, 'That login name or password is not right.');
  S.signedOut = false; return OK({ ...S.me, must_change: false, csrf: 'demo-csrf' });
});
on('POST', '/api/auth/invite', (b) => {
  if (b.token === 'used') return E(400, 'This link has already been used or has run out. Ask Mo for a new one.');
  if (!b.password || b.password.length < 10) return E(400, 'Please choose a password of at least 10 characters.');
  S.signedOut = false; return OK({ ...S.me, must_change: false, csrf: 'demo-csrf' });
});
on('POST', '/api/auth/logout', () => { S.signedOut = true; return OK({ ok: true }); });
on('POST', '/api/auth/password', (b) => (!b.current ? E(400, 'Your current password is not right.') : b.password && b.password.length >= 10 ? OK({ ok: true }) : E(400, 'Please choose a password of at least 10 characters.')));
on('POST', '/api/auth/reset/email', () => E(404, 'Email resets are not switched on.'));
on('POST', '/api/auth/reset/email/confirm', (b) => (b.password && b.password.length >= 10 ? OK({ ok: true }) : E(400, 'Please choose a password of at least 10 characters.')));
on('PUT', '/api/p/email', (b) => { S.email = b.email || null; return OK({ has_email: !!S.email }); });

on('GET', '/api/p/ai', () => OK(aiOut()));
on('PUT', '/api/p/ai', (b) => {
  if (b.provider) { S.ai.provider = b.provider; S.ai.model = AI_PROVIDERS.find(p => p.id === b.provider).models[0].id; }
  if (b.model) S.ai.model = b.model;
  if (b.daily_cap_usd != null) S.ai.daily = Math.min(30, Number(b.daily_cap_usd));
  if (b.monthly_cap_usd != null) S.ai.monthly = Math.min(30, Number(b.monthly_cap_usd));
  return OK(aiOut());
});
on('PUT', '/api/p/ai/keys/:p', (b, [p]) => {
  if (!b.key || b.key.length < 12) return E(400, 'That does not look like a key. Copy the whole key and try again.');
  const k = { provider: p, hint: `…${b.key.slice(-4)}`, status: 'ok', checked_at: Date.now() };
  S.ai.keys = S.ai.keys.filter(x => x.provider !== p).concat(k);
  return OK({ provider: p, hint: k.hint, status: k.status });
});
on('DELETE', '/api/p/ai/keys/:p', (b, [p]) => { S.ai.keys = S.ai.keys.filter(x => x.provider !== p); if (S.ai.provider === p) { S.ai.provider = 'workers_ai'; S.ai.model = AI_PROVIDERS[0].models[0].id; } return OK({ ok: true }); });
on('POST', '/api/p/ai/keys/:p/check', (b, [p]) => OK({ provider: p, status: (S.ai.keys.find(x => x.provider === p) || {}).status || 'unchecked' }));
on('GET', '/api/p/connector', () => OK({ links: S.links.map(({ url, ...l }) => l) }));
on('POST', '/api/p/connector', (b) => {
  const l = { id: nid('k'), label: b.label || 'Claude', created_at: Date.now(), last_used_at: null, url: `${location.origin}/mcp/u/demo${Math.random().toString(36).slice(2, 14)}` };
  S.links.push(l);
  return OK({ id: l.id, url: l.url, shown_once: true }, 201);
});
on('DELETE', '/api/p/connector/:id', (b, [id]) => { S.links = S.links.filter(l => l.id !== id); return OK({ ok: true }); });
on('GET', '/api/p/self-check', () => {
  const items = [
    { id: 'ai', ok: true, level: 'ok', says: 'AI: using the built-in AI. Nothing to set up.' },
    { id: 'spend', ok: true, level: 'ok', says: `Spending: $${S.ai.today.toFixed(2)} today, $${S.ai.month.toFixed(2)} this month (limits $${S.ai.daily.toFixed(2)} a day, $${S.ai.monthly.toFixed(2)} a month).` },
    S.links.length ? { id: 'connector', ok: true, level: 'ok', says: 'Claude: your connector link is set up.' }
      : { id: 'connector', ok: true, level: 'info', says: 'Claude: not linked yet.', fix: 'Make a connector link in Settings and add it to Claude as a custom connector.' },
    S.email ? { id: 'email', ok: true, level: 'ok', says: 'Password resets by email: on.' } : { id: 'email', ok: true, level: 'info', says: 'No email saved for password resets.', fix: 'Add one in Settings if you like, or ask Mo for a new link when you forget.' },
    ...active().filter(s => !live().some(t => t.subject_id === s.id)).map(s => ({ id: `topics-${s.id}`, ok: false, level: 'warn', says: `${s.name} has no topics yet.`, fix: 'Open the subject and tap Suggest topics.' })),
    { id: 'cards', ok: true, level: 'info', says: `${due().length} cards are due.` },
  ];
  return OK({ ok: items.every(i => i.ok), summary: items.every(i => i.ok) ? 'Everything is working.' : 'Mostly working. One thing to look at.', items });
});

on('GET', '/api/p/catalogue', () => OK({ track: TRACK, track_label: LABEL, boards: Object.entries(BOARDS).map(([id, name]) => ({ id, name })), subjects: CATALOGUE, defaults: DEFAULTS, max: 12 }));
on('GET', '/api/p/subjects', () => OK({ subjects: active().map(subjectOut) }));
on('POST', '/api/p/subjects', (b) => {
  if (active().length >= 12) return E(400, 'You can have up to 12 subjects.');
  const sid = b.subject === 'custom' ? `custom_${++n}` : b.subject;
  if (b.subject !== 'custom' && !cat(sid)) return E(400, 'That subject is not in the list.');
  const old = S.subjects.find(s => s.subject === sid);
  if (old && old.status === 'active') return E(409, 'You already have that subject.');
  let sub;
  if (old) { old.status = 'active'; sub = old; if (b.board) old.board = b.board; }
  else sub = addSubject(sid, b.board || 'other', b.tier || null, b.subject === 'custom' ? String(b.name || 'My subject').slice(0, 60) : null);
  if (b.subject === 'custom') sub.sections = [{ id: `${sub.id}-s1`, name: 'General' }];
  return OK({ subject: subjectOut(sub), batch_id: batch(() => { sub.status = 'removed'; return 1; }) }, 201);
});
on('GET', '/api/p/subjects/:id', (b, [id]) => {
  const s = findSubj(id);
  if (!s) return E(404, 'That subject could not be found.');
  const ts = live().filter(t => t.subject_id === id);
  return OK({ subject: subjectOut(s), sections: s.sections.map(sec => ({ id: sec.id, name: sec.name, topics: ts.filter(t => t.section === sec.name).map(chip) })), unplaced: id.endsWith('biology') ? 2 : 0 });
});
on('PATCH', '/api/p/subjects/:id', (b, [id]) => {
  const s = findSubj(id);
  if (!s) return E(404, 'That subject could not be found.');
  const before = { board: s.board, tier: s.tier, spec_code: s.spec_code, exam_year: s.exam_year, name: s.name };
  for (const k of ['board', 'tier', 'spec_code', 'exam_year', 'name']) if (b[k] !== undefined) s[k] = b[k];
  return OK({ subject: subjectOut(s), batch_id: batch(() => { Object.assign(s, before); return 1; }) });
});
on('DELETE', '/api/p/subjects/:id', (b, [id]) => {
  const s = findSubj(id);
  if (!s) return E(404, 'That subject could not be found.');
  s.status = 'removed';
  return OK({ ok: true, batch_id: batch(() => { s.status = 'active'; return 1; }) });
});
on('POST', '/api/p/subjects/:id/suggest', (b, [id]) => {
  if (!S.modules.ai_topics) return offWhen('ai_topics');
  const s = findSubj(id);
  if (!s) return E(404, 'That subject could not be found.');
  const secs = b.section ? s.sections.filter(x => x.name === b.section) : s.sections;
  const have = new Set(live().filter(t => t.subject_id === id).map(t => t.name.toLowerCase()));
  const sections = secs.map((sec, i) => {
    const mine = live().filter(t => t.subject_id === id && t.section === sec.name).map(t => ({ name: t.name }));
    const extra = SUGGEST_EXTRA.slice(i % 3, i % 3 + 3).map(x => ({ name: `${x}: ${sec.name.toLowerCase()}` })).filter(t => !have.has(t.name.toLowerCase()));
    return { name: sec.name, topics: [...mine.slice(0, 3), ...extra] };
  });
  S.ai.today += 0.004; S.ai.month += 0.004; S.ai.calls++;
  return OK({ sections, provider: S.ai.provider, usd: 0.004 });
}, 1600);
on('POST', '/api/p/subjects/:id/topics', (b, [id]) => {
  const s = findSubj(id);
  if (!s) return E(404, 'That subject could not be found.');
  let added = 0, skipped = 0; const made = [];
  for (const sec of b.sections || []) {
    if (!s.sections.some(x => x.name === sec.name)) s.sections.push({ id: `${s.id}-s${s.sections.length + 1}`, name: sec.name });
    for (const t of sec.topics || []) {
      if (live().some(x => x.subject_id === id && x.name.toLowerCase() === String(t.name).toLowerCase())) { skipped++; continue; }
      made.push(addTopic(s, sec.name, String(t.name).slice(0, 80), null)); added++;
    }
  }
  return OK({ added, skipped, batch_id: batch(() => { made.forEach(t => { t.retired = true; }); return made.length; }) });
});
on('GET', '/api/p/topics/:id', (b, [id]) => {
  const t = S.topics.find(x => x.id === id);
  if (!t) return E(404, 'That topic could not be found.');
  const recent = t.t1000 == null ? [] : [
    { day: iso(-1), kind: 'result', result: t.t1000 >= 600 ? 'wrong' : 'right', source: 'seneca', label: 'Seneca' },
    { day: iso(-5), kind: 'card', result: t.t1000 >= 500 ? 'again' : 'good', source: 'hub_cards', label: 'Flashcard' },
    { day: iso(-12), kind: 'result', result: 'partial', source: 'past_paper', label: 'Past paper' },
  ];
  return OK({ topic: { id: t.id, name: t.name, subject_id: t.subject_id, section: t.section, band: bandOf(t.t1000), t1000: t.t1000, seen: t.t1000 != null, status: t.retired ? 'retired' : t.status },
    recent, cards_n: S.cards.filter(c => c.topic_id === id).length, gaps: S.gaps.filter(g => g.topic_id === id).map(g => ({ at: g.at, gap: g.gap })) });
});
on('PATCH', '/api/p/topics/:id', (b, [id]) => {
  const t = S.topics.find(x => x.id === id);
  if (!t) return E(404, 'That topic could not be found.');
  const before = { name: t.name, section: t.section, retired: t.retired };
  if (b.name) t.name = String(b.name).slice(0, 80);
  if (b.section) t.section = b.section;
  if (b.retired) t.retired = true;
  return OK({ topic: { id: t.id, name: t.name, subject_id: t.subject_id, section: t.section, band: bandOf(t.t1000), t1000: t.t1000, seen: t.t1000 != null, status: t.retired ? 'retired' : 'confirmed' },
    batch_id: batch(() => { Object.assign(t, before); return 1; }) });
});
on('GET', '/api/p/today', () => {
  const subs = active().map(subjectOut);
  const names = Object.fromEntries(subs.map(s => [s.id, s.name]));
  const weakest = live().filter(t => t.t1000 != null && names[t.subject_id]).sort((a, b) => b.t1000 - a.t1000).slice(0, 5)
    .map(t => ({ ...chip(t), subject_id: t.subject_id, subject_name: names[t.subject_id] }));
  const days = S.exam_date ? Math.max(0, Math.ceil((new Date(S.exam_date + 'T09:00:00') - Date.now()) / DAY)) : null;
  return OK({ name: S.me.name, track_label: LABEL, days_to_exam: days, subjects: subs.map(s => ({ id: s.id, name: s.name, board_name: s.board_name, ring: s.ring, weak_n: s.weak_n })),
    weakest, cards_due: S.modules.cards ? due().length : 0, last_results: S.results.slice(0, 3).map(({ how, bank_name, ...r }) => r), modules: { ...S.modules }, choice: offer() });
});
// Galaxies and pictures (galaxies.js, pictures.js): read-only in the demo; making them needs a real hub.
const NOT_IN_DEMO = () => E(400, 'In the demo this is shown, not saved. In your own Study Hub it works.');
on('GET', '/api/p/galaxies', () => OK({ galaxies: [], order: active().map(x => { const o = subjectOut(x); return { kind: 'subject', id: o.id, title: o.name, n: o.topics_n, weak_n: o.weak_n }; }), layout: 'subject', max: 30 }));
on('POST', '/api/p/galaxies', NOT_IN_DEMO);
on('GET', '/api/p/topics', () => OK({ topics: live().map(t => ({ ...chip(t), subject_id: t.subject_id, section: t.section, galaxy: null })) }));
on('GET', '/api/p/mnemonics', () => OK({ subjects: active().map(x => ({ id: x.id, name: x.name })), today: { new_done: 0, new_cap: 10 },
  mnemonics: TRACK === 'alevel' ? [{ id: 'mn_demo00001', cue: 'PMAT', about: 'Stages of mitosis', kind: 'acronym', items: [{ key: 'P', text: 'Prophase' }, { key: 'M', text: 'Metaphase' }, { key: 'A', text: 'Anaphase' }, { key: 'T', text: 'Telophase' }],
    category_id: `${TRACK}-biology`, notes: '', topics: [], source: 'claude', created_at: Date.now(), updated_at: Date.now(), fwd: null, rev: null }] : [] }));
on('GET', '/api/p/mnemonics/test', () => OK({ queue: [], mnemonics: [] }));
on('POST', '/api/p/mnemonics', NOT_IN_DEMO);
// Chat notes and the daily tracker (chats.js, activity.js): a made-up few weeks.
on('GET', '/api/p/chats', () => OK({ notes: [{ id: 'ch_demo1', title: 'Osmosis with Claude', source: 'claude', saves: 2, topics: [], excerpt: 'Understood water potential; mixed up hypotonic and hypertonic once. Next: plasmolysis.', created_at: Date.now() - 86_400_000, updated_at: Date.now() - 3_600_000 }] }));
on('POST', '/api/p/chats', NOT_IN_DEMO);
on('POST', '/api/p/activity', () => OK({ ok: true }));
on('GET', '/api/p/activity', () => {
  const days = [];
  for (let k = 0; k < 120; k++) if ((k * 7) % 10 < 6) { const d = new Date(Date.now() - k * 86_400_000); days.push({ day: d.toISOString().slice(0, 10), minutes: 10 + ((k * 13) % 60), actions: (k * 5) % 50 }); }
  days.reverse();
  return OK({ days, today: new Date().toISOString().slice(0, 10), stats: { daily_minutes: 38, days_pct: 60, longest: 9, current: 4, total_days: days.length, total_minutes: days.length * 38 } });
});
on('GET', '/api/p/topics/:id/pictures', () => OK({ pictures: [], max: 12 }));
on('PUT', '/api/p/pictures', NOT_IN_DEMO);
on('POST', '/api/p/pictures', NOT_IN_DEMO);
// Recent changes (worker/src/platform/recent.js): a short made-up week.
on('GET', '/api/p/recent', () => OK({ days: 7, items: [
  { batch_id: 'b_demo2', at: Date.now() - 40 * 60_000, who: 'Your Claude', what: 'Made galaxy Mock 1', more: 3, undoable: true, undone: false },
  { batch_id: 'b_demo1', at: Date.now() - 26 * 3_600_000, who: 'You', what: 'Your hub: colour purple', more: 0, undoable: false, undone: false }] }));
on('GET', '/api/p/map/recent', () => OK({ hours: 24, since: Date.now() - 86_400_000, topics: live().slice(0, 3).map(t => ({ id: t.id, at: Date.now() - 3_600_000, what: 'Result logged', n: 1 })) }));
// How it works (worker/src/platform/guide.js): the live numbers and what is left to set up.
on('GET', '/api/p/guide', () => {
  const subs = active().map(s => { const o = subjectOut(s); const w = live().filter(t => t.subject_id === s.id && t.t1000 != null).sort((x, y) => y.t1000 - x.t1000)[0];
    return { id: o.id, subject: o.subject, name: o.name, board: o.board, board_name: o.board_name, tier: o.tier, topics_n: o.topics_n, weak_n: o.weak_n, weakest: w ? w.name : null }; });
  const days = S.exam_date ? Math.max(0, Math.ceil((new Date(S.exam_date + 'T09:00:00') - Date.now()) / DAY)) : null;
  return OK({ track: TRACK, track_label: LABEL, name: S.me.name, subjects: subs,
    counts: { topics: live().length, galaxies: 0, docs: S.library.length, cards_due: S.modules.cards ? due().length : 0, papers_to_sit: 0, papers_marked: 0 },
    days_to_exam: days, exam_date: S.exam_date, claude: { links: S.links.length, last_used_at: null },
    setup: { claude: false, boards_missing: subs.filter(s => !s.board || s.board === 'other').map(s => s.name), no_topics: subs.filter(s => !s.topics_n).map(s => s.name), exam_date: !!S.exam_date },
    modules: { ...S.modules } });
});
on('POST', '/api/p/gaps', (b) => { const g = { id: nid('g'), gap: b.gap, topic_id: b.topic || null, at: Date.now() }; S.gaps.push(g); return OK({ ok: true, gap_id: g.id, placed: !!b.topic }); });
on('POST', '/api/p/undo', (b) => {
  const id = b.batch_id || Object.keys(S.batches).pop();
  const fn = S.batches[id];
  if (!fn) return E(404, 'There is nothing to undo.');
  delete S.batches[id];
  return OK({ ok: true, undone: fn() || 1 });
});

on('GET', '/api/p/banks', () => offWhen('results') || OK({ banks: BANKS }));
on('POST', '/api/p/results/read', (b) => {
  if (!(b.images || []).length) return E(400, 'Please add a screenshot.');
  const ts = live().filter(t => t.subject_id === b.subject_id);
  const pick = i => ts[(i * 5 + 3) % Math.max(1, ts.length)];
  const per = b.bank === 'seneca';
  const rows = Array.from({ length: 6 }, (_, i) => {
    const t = pick(i);
    const res = ['right', 'wrong', 'right', 'partial', 'right', 'wrong'][i];
    return per ? { q: null, result: null, marks: [8, 3, 10, 6, 9, 4][i], out_of: 10, topic: t ? t.name : null, section: t ? t.section : null, others_pct: [72, 64, 80, 58, 75, 61][i] }
      : { q: String(i + 1), result: res, marks: res === 'right' ? 2 : res === 'partial' ? 1 : 0, out_of: 2, topic: i === 4 ? null : t ? t.name : null, section: t ? t.section : null, others_pct: null };
  });
  S.ai.today += 0.001 * b.images.length; S.ai.calls++;
  return OK({ rows, provider: S.ai.provider, usd: 0.001 * b.images.length });
}, 1800);
on('POST', '/api/p/results', (b) => {
  const rows = (b.rows || []).filter(r => r && (r.q || r.topic || r.marks != null));
  if (!rows.length) return E(400, 'Add at least one row.');
  const ts = live().filter(t => t.subject_id === b.subject_id);
  let placed = 0;
  for (const r of rows) {
    const t = ts.find(x => r.topic && x.name.toLowerCase() === String(r.topic).toLowerCase());
    if (!t) continue;
    placed++;
    const frac = r.out_of ? (Number(r.marks) || 0) / r.out_of : r.result === 'right' ? 1 : r.result === 'partial' ? 0.5 : 0;
    const target = Math.round((1 - frac) * 1000);
    t.t1000 = t.t1000 == null ? target : Math.round(t.t1000 * 0.6 + target * 0.4);
  }
  const marks = rows.some(r => r.out_of) ? rows.reduce((a, r) => a + (Number(r.marks) || 0), 0) : null;
  const out_of = rows.some(r => r.out_of) ? rows.reduce((a, r) => a + (Number(r.out_of) || 0), 0) : null;
  const right_n = rows.filter(r => r.result === 'right').length, total_n = rows.filter(r => r.result).length;
  const bank = BANKS.find(x => x.id === b.bank);
  const res = { id: nid('r'), bank: b.bank, bank_name: bank ? bank.name : b.bank, subject_id: b.subject_id, day: b.day, label: b.label || null, how: b.how, right_n: total_n ? right_n : null, total_n: total_n || null, marks, out_of };
  S.results.unshift(res);
  return OK({ id: res.id, saved: rows.length, placed, unplaced: rows.length - placed, batch_id: batch(() => { S.results = S.results.filter(x => x !== res); return 1; }) }, 201);
});
on('GET', '/api/p/results', (b, m, q) => offWhen('results') || OK({ results: S.results.filter(r => !q.get('subject_id') || r.subject_id === q.get('subject_id')).slice(0, Number(q.get('limit')) || 50) }));
on('DELETE', '/api/p/results/:id', (b, [id]) => { S.results = S.results.filter(r => r.id !== id); return OK({ ok: true }); });

// Library: release 2.5's shapes (worker/src/library/routes.js, with the platform's quota): documents read into pages
// and passages, searched with citations. Links are not documents in 2.5, so the demo shows the files and notes.
const LIB_MAX = { docs: 200, bytes: 500 * 1048576 };
const libDocs = () => S.library.filter(x => x.kind !== 'link');
const pagesOf = it => Math.max(1, it.pages || 1);
const docOut = it => {
  const n = Math.max(4, Math.round(pagesOf(it) * 1.6)), st = it.status || 'ready';
  return { id: it.id, title: it.title, file_name: it.filename || `${it.title}.txt`, collection: it.doc_type || 'notes', source: 'upload', bytes: it.size || 0, page_count: pagesOf(it),
    status: st, status_note: null, pages_in: pagesOf(it), n_pages_text: pagesOf(it), n_ocr: 0, n_passages: n, n_embedded: st === 'ready' ? n : Math.round(n / 2), n_linked: st === 'ready' ? n : 0,
    created_at: it.created_at, updated_at: it.created_at, indexed_at: st === 'ready' ? it.created_at : null, ocr_pending: 0,
    progress: { passages: n, embedded: n, linked: st === 'ready' ? n : 0, pct: st === 'ready' ? 100 : 50 } };
};
const pageText = (it, n) => (n === 1 || !it.text ? it.text || '' : `${it.title}, page ${n}. ${it.text}`);
on('GET', '/api/p/library', () => {
  if (!S.modules.library) return offWhen('library');
  const docs = libDocs().map(docOut);
  const sum = k => docs.reduce((t, d) => t + (d[k] || 0), 0);
  return OK({ docs, totals: { docs: docs.length, ready: docs.filter(d => d.status === 'ready').length, pages: sum('page_count'), passages: sum('n_passages'), embedded: sum('n_embedded'), bytes: sum('bytes') },
    vectors: 'd1', limits: { part_size: 8 * 1048576, max_file_bytes: 50 * 1048576, pages_per_call: 40 }, quota: { docs: docs.length, bytes: sum('bytes'), max_docs: LIB_MAX.docs, max_bytes: LIB_MAX.bytes } });
});
on('GET', '/api/p/library/status', () => OK({ docs: { ready: libDocs().length }, pending: { embed: 0, link: 0, ocr: 0, index: 0 }, vectors: 'd1', job: null }));
on('GET', '/api/p/library/search', (b, m, q) => {
  const text = (q.get('q') || '').trim();
  if (!text && !q.get('topic_id')) return E(400, 'Give q (the words to find) or topic_id.');
  const words = text.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const results = [];
  for (const it of libDocs()) {
    const body = it.text || '', low = body.toLowerCase();
    const hit = words.filter(w => low.includes(w) || it.title.toLowerCase().includes(w)).length;
    if (!hit) continue;
    const at = Math.max(0, low.indexOf(words.find(w => low.includes(w)) || '')), start = Math.max(0, at - 80);
    const page = it.pages ? 1 + (it.title.length % pagesOf(it)) : 1;
    results.push({ id: it.id.length * 100 + results.length, doc_id: it.id, title: it.title, page, page_to: page, heading: it.doc_type === 'mark_scheme' ? 'Mark scheme › Question 1' : null, kind: 'text',
      cite: `${it.title}, p. ${page}`, text: (start ? '…' : '') + body.slice(start, start + 260), char_start: start, char_end: start + 260, score: Math.round((hit / words.length) * 1000) / 1000, via: 'fts' });
  }
  results.sort((x, y) => y.score - x.score);
  return OK({ q: text || null, topic: null, expanded: [], results: results.slice(0, Number(q.get('k')) || 12), n_candidates: results.length, reranked: false, vectors: 'd1', ms: { total: 12 } });
}, 250);
on('GET', '/api/p/library/doc/:id/page/:n', (b, [id, nn], q) => {
  const it = libDocs().find(x => x.id === id);
  if (!it) return E(404, 'That document could not be found.');
  const n = Math.max(1, Math.min(pagesOf(it), Number(nn) || 1)), text = pageText(it, n);
  const marks = [];
  for (const w of [...new Set((q.get('q') || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])].slice(0, 8)) {
    let i = text.toLowerCase().indexOf(w);
    while (i >= 0 && marks.length < 60) { marks.push([i, i + w.length]); i = text.toLowerCase().indexOf(w, i + w.length); }
  }
  marks.sort((x, y) => x[0] - y[0]);
  return OK({ doc: { id: it.id, title: it.title, page_count: pagesOf(it) }, page: { n, text, kind: 'text', ocr_state: null }, passages: [{ id: 1, heading: null, kind: 'text', tokens: 80, page: n, page_to: n, start: 0, end: text.length }],
    highlight: q.get('passage') ? { passage: 1, start: 0, end: Math.min(text.length, 200) } : null, marks, prev: n > 1 ? n - 1 : null, next: n < pagesOf(it) ? n + 1 : null });
});
on('POST', '/api/p/library/docs', (b) => {
  if (!b.file_name || !(Number(b.bytes) > 0)) return E(400, 'Say the file name and its size.');
  if (Number(b.bytes) > 50 * 1048576) return E(413, 'That file is too big. The limit is 50 MB.');
  const it = { id: nid('l'), kind: 'file', title: b.title || String(b.file_name).replace(/\.[a-z0-9]+$/i, ''), doc_type: b.collection || 'notes', filename: b.file_name, size: Number(b.bytes), pages: 4,
    text: 'Text read from your file.', created_at: Date.now(), status: 'uploading' };
  S.library.unshift(it);
  return OK({ doc: docOut(it), upload: { part_size: 8 * 1048576, parts: Math.max(1, Math.ceil(it.size / (8 * 1048576))) } }, 201);
}, 300);
on('PUT', '/api/p/library/docs/:id/parts/:n', (b, [id, nn]) => OK({ part: Number(nn), etag: `demo-${id}-${nn}` }), 300);
on('POST', '/api/p/library/docs/:id/complete', (b, [id]) => {
  const it = libDocs().find(x => x.id === id);
  if (!it) return E(404, 'That document could not be found.');
  it.status = 'indexing';
  setTimeout(() => { it.status = 'ready'; }, 4000);
  return OK({ doc: docOut(it) });
});
on('POST', '/api/p/library/docs/:id/pages', () => OK({ ok: true, pages_in: 4 }));
for (const act of ['extract', 'reindex']) on('POST', `/api/p/library/docs/:id/${act}`, (b, [id]) => { const it = libDocs().find(x => x.id === id); return it ? OK({ doc: docOut(it) }) : E(404, 'That document could not be found.'); });
on('POST', '/api/p/library/run', () => OK({ ok: true, ms: 120 }));
on('GET', '/api/p/library/docs/:id', (b, [id]) => { const it = libDocs().find(x => x.id === id); return it ? OK({ doc: docOut(it) }) : E(404, 'That document could not be found.'); });
on('DELETE', '/api/p/library/docs/:id', (b, [id]) => { S.library = S.library.filter(x => x.id !== id); return OK({ ok: true }); });

on('GET', '/api/p/cards/due', (b, m, q) => {
  if (!S.modules.cards) return offWhen('cards');
  const d = due().filter(c => !q.get('subject_id') || c.subject_id === q.get('subject_id'));
  return OK({ cards: d.slice(0, Number(q.get('limit')) || 20).map(cardOut), due_n: d.length, new_n: d.filter(c => c.state === 'new').length });
});
on('GET', '/api/p/cards/stats', () => {
  const d = due();
  return OK({ total: S.cards.length, due_now: d.length, due_today: d.length + 2, new: S.cards.filter(c => c.state === 'new').length, learning: S.cards.filter(c => c.state === 'learning').length,
    review: S.cards.filter(c => c.state === 'review').length, reviewed_today: S.reviewedToday, streak_days: 4 });
});
on('GET', '/api/p/cards', (b, m, q) => {
  const term = (q.get('q') || '').toLowerCase();
  return OK({ cards: S.cards.filter(c => (!term || (c.front + ' ' + c.back).toLowerCase().includes(term)) && (!q.get('subject_id') || c.subject_id === q.get('subject_id')) && (!q.get('topic_id') || c.topic_id === q.get('topic_id'))).map(cardFull) });
});
on('POST', '/api/p/cards', (b) => {
  if (!b.front || !b.back) return E(400, 'A card needs a front and a back.');
  const c = { id: ++n, front: String(b.front).slice(0, 600), back: String(b.back).slice(0, 600), subject_id: b.subject_id || null, topic_id: b.topic_id || null, source: b.source || 'mine', state: 'new', due_at: Date.now(), lapses: 0, suspended: false };
  S.cards.push(c);
  return OK({ card: cardFull(c) }, 201);
});
on('POST', '/api/p/cards/draft', (b) => {
  const t = b.topic_id && S.topics.find(x => x.id === b.topic_id);
  const about = t ? t.name : String(b.text || 'this topic').slice(0, 60);
  S.ai.today += 0.002; S.ai.calls++;
  return OK({ drafts: [
    { front: `What is meant by "${about}"?`, back: `A short definition of ${about.toLowerCase()} in your own words, with one example.` },
    { front: `Give one exam-style fact about ${about.toLowerCase()}.`, back: `The key point examiners look for on ${about.toLowerCase()}.` },
    { front: `What is a common mistake with ${about.toLowerCase()}?`, back: 'Mixing up the cause and the effect. Say which comes first.' },
  ], usd: 0.002 });
}, 1400);
on('PATCH', '/api/p/cards/:id', (b, [id]) => { const c = S.cards.find(x => x.id === Number(id)); if (!c) return E(404, 'That card could not be found.'); for (const k of ['front', 'back', 'topic_id', 'suspended']) if (b[k] !== undefined) c[k] = b[k]; return OK({ card: cardFull(c) }); });
on('DELETE', '/api/p/cards/:id', (b, [id]) => { S.cards = S.cards.filter(x => x.id !== Number(id)); return OK({ ok: true }); });
on('POST', '/api/p/cards/:id/review', (b, [id]) => {
  const c = S.cards.find(x => x.id === Number(id));
  if (!c) return E(404, 'That card could not be found.');
  const r = Number(b.rating);
  if (![1, 2, 3, 4].includes(r)) return E(400, 'Rate the card 1 to 4.');
  const mins = [0, 10, 60 * 24, 60 * 24 * 3, 60 * 24 * 8][r];
  c.due_at = Date.now() + mins * 60e3;
  c.state = r === 1 ? 'learning' : 'review';
  if (r === 1) c.lapses++;
  S.reviewedToday++;
  const d = due();
  c.reps = (c.reps || 0) + 1;
  return OK({ card: { id: c.id, due_at: c.due_at, state: c.state, reps: c.reps, lapses: c.lapses }, next: d[0] ? cardOut(d[0]) : null, due_n: d.length });
}, 120);

on('GET', '/api/p/me', () => OK(meOut()));
on('PATCH', '/api/p/me', (b) => {
  if (b.name !== undefined) { if (!String(b.name).trim()) return E(400, 'Please type a name.'); S.me.name = String(b.name).trim().slice(0, 40); }
  if (b.exam_date !== undefined) S.exam_date = b.exam_date || null;
  if (b.modules) for (const [k, v] of Object.entries(b.modules)) if (k in S.modules && !['map', 'anki_link'].includes(k)) S.modules[k] = !!v;
  return OK(meOut());
});
on('GET', '/api/p/me/export', () => OK({ exported_at: new Date().toISOString(), user: S.me.user, subjects: active().map(subjectOut), topics: live(), cards: S.cards.map(cardFull), results: S.results, library: S.library.map(itemOut) }));
on('POST', '/api/p/me/delete', (b) => {
  if (!b.password) return E(400, 'Please type your password to confirm.');
  S.signedOut = true;
  return OK({ ok: true, message: 'Your account is closed. Everything is deleted within 24 hours.' });
});

// Practice papers (module papers, own Claude key): docs/platform/api-v1.5-papers.md. Answer with a confidence tap,
// then the mark scheme, self-marking (or "mark this for me"), the exam wrapper, the marks onto the map, card drafts.
S.papers = [];
// ?demo=1&papers=1: papers switched on with a (pretend) Claude key, so the whole paper flow can be tried.
if (P.get('papers') === '1') { S.modules.papers = true; S.ai.keys.push({ provider: 'anthropic', hint: '…demo', status: 'ok', checked_at: Date.now() }); }
const PAPER_Q = ['Explain what is meant by the term "{t}".', 'Describe one experiment that could be used to investigate {t}. Include the variables you would control.', 'Evaluate the claim that {t} is the most important idea in this section.', 'A student says {t} only matters in exams. Give two reasons why they are wrong.', 'Suggest how {t} links to one other topic you have studied.', 'Apply your knowledge of {t} to an unfamiliar example of your choice.'];
const SCHEME = ['Uses the key term correctly', 'Gives a relevant example', 'Explains the link clearly', 'Reaches a justified conclusion', 'Uses correct units or terminology', 'Links to a second idea'];
const LOST_REASONS = { knowledge_gap: "Didn't know it", misread: 'Misread the question', calculation: 'Calculation or unit slip', test_taking: 'Exam technique', faulty_synthesis: "Knew it, couldn't apply it" };
const outOf = p => p.questions.reduce((a, q) => a + q.marks, 0);
const paperFor = id => S.papers.find(x => x.id === id);
function paperShape(p) {
  const base = { id: p.id, subject_id: p.subject_id, title: p.title, status: p.status, created_at: p.created_at, out_of: outOf(p),
    questions: p.questions.map(({ topic_id, ...q }) => q) };
  if (p.status !== 'ready') Object.assign(base, { scheme: p.scheme, marking: p.marking });
  if (p.status === 'marked') Object.assign(base, { results: p.results, total: p.total, confidence_summary: p.confidence_summary, on_map: true, batch_id: p.batch_id, gaps_saved: p.gaps_saved });
  if (p.wrapper) base.wrapper = p.wrapper;
  if (p.drafts) base.drafts = p.drafts;
  return base;
}
const resultOf = (awarded, out, answer) => (!answer && !awarded ? 'omitted' : awarded >= out ? 'right' : awarded * 2 >= out ? 'partial' : 'wrong');
function saveAnswers(p, list) {
  for (const a of list || []) {
    const q = p.questions.find(x => x.n === a.n);
    if (!q) continue;
    if (a.answer !== undefined) q.answer = String(a.answer || '').slice(0, 4000);
    if (a.confidence !== undefined) q.confidence = ['sure', 'think_so', 'guess'].includes(a.confidence) ? a.confidence : null;
  }
}
on('GET', '/api/p/papers', () => offWhen('papers') || OK({ papers: S.papers.map(p => { const x = paperShape(p); return { id: x.id, subject_id: x.subject_id, title: x.title, status: x.status, created_at: x.created_at,
  out_of: x.out_of, questions: x.questions.length, ...(p.status === 'marked' ? { total: p.total } : {}) }; }) }));
on('POST', '/api/p/papers', (b) => {
  if (!S.modules.papers) return offWhen('papers');
  if (!S.ai.keys.some(k => k.provider === 'anthropic')) return E(400, 'Practice papers run on your own Claude key. Add it in Settings first.');
  const s = findSubj(b.subject_id);
  if (!s) return E(404, 'That subject could not be found.');
  const n = Math.max(3, Math.min(12, Number(b.questions) || 6));
  const mine = live().filter(t => t.subject_id === s.id);
  let pool = Array.isArray(b.topic_ids) && b.topic_ids.length ? mine.filter(t => b.topic_ids.includes(t.id)) : b.weakest ? mine.filter(t => t.t1000 != null).sort((a, c) => c.t1000 - a.t1000).slice(0, 4) : mine;
  if (!pool.length) pool = [{ id: null, name: s.name }];
  const questions = Array.from({ length: n }, (_, i) => { const t = pool[i % pool.length]; return { n: i + 1, text: PAPER_Q[i % PAPER_Q.length].replace('{t}', t.name.toLowerCase()), marks: [2, 4, 6, 2, 3, 4][i % 6],
    topic: t.id ? t.name : null, topic_id: t.id, answer: '', confidence: null }; });
  const p = { id: nid('p'), subject_id: s.id, title: b.title || `${s.name} practice paper`, status: 'ready', created_at: Date.now(), questions,
    scheme: questions.map(q => ({ n: q.n, points: SCHEME.slice(0, q.marks) })), marking: {} };
  S.papers.unshift(p);
  return OK({ paper: paperShape(p), usd: 0.04, check: { checked_by_code: 0, checked_by_claude: 0, doubtful: [] } }, 201);
}, 2500);
on('GET', '/api/p/papers/:id', (b, [id]) => { const p = paperFor(id); return p ? OK({ paper: paperShape(p) }) : E(404, 'That paper could not be found.'); });
on('DELETE', '/api/p/papers/:id', (b, [id]) => { S.papers = S.papers.filter(x => x.id !== id); return OK({ ok: true }); });
on('PUT', '/api/p/papers/:id/answers', (b, [id]) => {
  const p = paperFor(id);
  if (!p) return E(404, 'That paper could not be found.');
  if (p.status !== 'ready') return E(409, 'The mark scheme is open, so the answers are fixed now.');
  saveAnswers(p, b.answers);
  return OK({ ok: true });
});
on('POST', '/api/p/papers/:id/working', (b, [id]) => {
  const p = paperFor(id);
  if (!p) return E(404, 'That paper could not be found.');
  if (!Array.isArray(b.images) || !b.images.length) return E(400, 'Add a photo of your working.');
  return OK({ n: b.n, text: 'Water moves by osmosis from a higher water potential to a lower one, through the partially permeable membrane.', usd: 0.01 });
}, 1500);
on('POST', '/api/p/papers/:id/start-marking', (b, [id]) => {
  const p = paperFor(id);
  if (!p) return E(404, 'That paper could not be found.');
  if (p.status === 'ready') {
    saveAnswers(p, b.answers);
    const answered = p.questions.filter(q => q.answer.trim());
    if (!answered.length) return E(400, 'Answer at least one question first.');
    const unsure = answered.filter(q => !q.confidence).map(q => q.n);
    if (unsure.length) return E(400, `Tap how sure you were first, for question ${unsure.join(', ')}.`);
    p.status = 'marking';
  }
  return OK({ paper: paperShape(p) });
});
on('PUT', '/api/p/papers/:id/marks', (b, [id]) => {
  const p = paperFor(id);
  if (!p) return E(404, 'That paper could not be found.');
  if (p.status === 'ready') return E(400, 'Open the mark scheme first.');
  for (const m of b.marks || []) {
    const q = p.questions.find(x => x.n === m.n);
    if (!q) continue;
    const points = Array.isArray(m.points) ? [...new Set(m.points.filter(k => Number.isInteger(k) && k >= 1 && k <= p.scheme[q.n - 1].points.length))] : null;
    const awarded = Math.min(q.marks, points ? points.length : Math.max(0, Number(m.awarded) || 0));
    const lost = awarded < q.marks;
    p.marking[q.n] = { points, awarded, by: 'self', reason: lost && LOST_REASONS[m.reason] ? m.reason : null, note: lost && m.note ? String(m.note).slice(0, 200) : null, comment: null };
  }
  return OK({ paper: paperShape(p) });
});
on('POST', '/api/p/papers/:id/ai-mark', (b, [id]) => {
  const p = paperFor(id), q = p && p.questions.find(x => x.n === b.n);
  if (!q) return E(404, 'That question could not be found.');
  if (!q.answer.trim()) return E(400, 'There is no answer to mark.');
  const awarded = Math.min(q.marks, Math.ceil(q.answer.length / 40));
  const marking = { points: Array.from({ length: awarded }, (_, i) => i + 1), awarded, by: 'ai', reason: awarded < q.marks ? 'knowledge_gap' : null, note: null,
    comment: awarded === q.marks ? 'Full marks: clear and precise.' : 'Good start. Add a specific example to reach full marks.' };
  p.marking[q.n] = marking;
  return OK({ n: q.n, marking, usd: 0.01 });
}, 1600);
on('POST', '/api/p/papers/:id/finish', (b, [id]) => {
  const p = paperFor(id);
  if (!p) return E(404, 'That paper could not be found.');
  if (p.status === 'marked') return OK({ paper: paperShape(p), total: p.total, out_of: outOf(p), already_done: true });
  if (p.status === 'ready') return E(400, 'Open the mark scheme and mark your answers first.');
  const unmarked = p.questions.filter(q => q.answer.trim() && !p.marking[q.n]).map(q => q.n);
  if (unmarked.length) return E(400, `Mark question ${unmarked.join(', ')} first.`);
  if (b.wrapper) p.wrapper = { ...b.wrapper, at: Date.now() };
  p.results = p.questions.map(q => { const m = p.marking[q.n] || { awarded: 0, points: null, by: 'self' };
    return { n: q.n, awarded: m.awarded, out_of: q.marks, result: resultOf(m.awarded, q.marks, q.answer.trim()), topic: q.topic, confidence: q.confidence, reason: m.reason || null, note: m.note || null, by: m.by, ticked: m.points, comment: m.comment || null }; });
  p.total = p.results.reduce((a, r) => a + r.awarded, 0);
  p.confidence_summary = Object.fromEntries(['sure', 'think_so', 'guess'].map(c => { const rs = p.results.filter(r => r.confidence === c); return [c, { n: rs.length, full: rs.filter(r => r.result === 'right').length }]; }));
  p.gaps_saved = Math.min(8, p.results.filter(r => r.awarded < r.out_of && r.reason && !['misread', 'test_taking'].includes(r.reason)).length);
  p.batch_id = batch(() => { p.status = 'marking'; return 1; });
  p.status = 'marked';
  for (const r of p.results) { const t = live().find(x => x.name === r.topic && x.subject_id === p.subject_id); if (t && r.result !== 'omitted') t.t1000 = Math.max(0, Math.min(1000, (t.t1000 ?? 500) + (r.result === 'right' ? -80 : r.result === 'partial' ? 20 : 90))); }
  return OK({ paper: paperShape(p), total: p.total, out_of: outOf(p), already_done: false, result: { id: nid('r'), saved: p.results.length, placed: p.results.filter(r => r.topic).length, unplaced: 0, batch_id: p.batch_id },
    gaps: { saved: p.gaps_saved, skipped: 0 }, can_make_cards: !!S.modules.cards }, 201);
});
on('PUT', '/api/p/papers/:id/wrapper', (b, [id]) => {
  const p = paperFor(id);
  if (!p) return E(404, 'That paper could not be found.');
  if (p.status === 'ready') return E(400, 'The three questions come after marking.');
  p.wrapper = { ...(p.wrapper || {}), ...Object.fromEntries(['went_well', 'marks_lost', 'next_time'].filter(k => typeof b[k] === 'string').map(k => [k, b[k].slice(0, 600)])), at: Date.now() };
  return OK({ paper: paperShape(p) });
});
on('POST', '/api/p/papers/:id/drafts', (b, [id]) => {
  const p = paperFor(id);
  if (!p || p.status !== 'marked') return E(400, 'Finish marking the paper first.');
  const lost = p.results.filter(r => r.awarded < r.out_of && r.reason && !['misread', 'test_taking'].includes(r.reason));
  if (!lost.length) return OK({ drafts: [], message: 'No marks lost to a gap, so no cards to make.' });
  p.drafts = lost.slice(0, 6).map(r => { const q = p.questions[r.n - 1]; return { n: r.n, front: `What does a full answer to "${q.text.slice(0, 80)}" need?`, back: p.scheme[r.n - 1].points.join('; '), topic: q.topic, topic_id: q.topic_id }; });
  return OK({ drafts: p.drafts, usd: 0.01 });
}, 1400);
on('POST', '/api/p/papers/:id/cards', (b, [id]) => {
  const p = paperFor(id);
  if (!p) return E(404, 'That paper could not be found.');
  const made = [];
  let skipped = 0;
  for (const c of (b.cards || []).slice(0, 15)) {
    if (!c.front || !c.back) continue;
    if (S.cards.some(x => x.front === c.front)) { skipped++; continue; }
    const q = c.n ? p.questions[c.n - 1] : null;
    const card = { id: ++n, front: String(c.front).slice(0, 600), back: String(c.back).slice(0, 600), subject_id: p.subject_id, topic_id: q ? q.topic_id : null, source: 'paper', state: 'new', due_at: Date.now(), lapses: 0, suspended: false };
    S.cards.push(card); made.push(card);
  }
  return OK({ added: made.length, skipped, cards: made.map(cardOut) }, 201);
});

S.positions = {}; S.layoutVersion = 0; S.mapSeq = 40; S.share = false; S.offer = null; S.requests = [];
const BAND_CODE = t => (t == null ? 'unseen' : t < 200 ? 'strong' : t < 400 ? 'good' : t < 600 ? 'mixed' : t < 800 ? 'weak' : 'very_weak');
const BAND_I = t => (t == null ? 5 : Math.min(4, Math.floor(t / 200)));
const LOOKALIKES = [['Osmosis', 'Active transport', 70], ['Mitosis and the cell cycle', 'Meiosis', 85], ['Photosynthesis', 'Respiration', 40], ['Lungs and ventilation', 'Gas exchange in fish and insects', 30],
  ['Enzymes', 'Proteins', 20], ['DNA and chromosomes', 'Protein synthesis', 30], ['Immune response', 'Vaccines', 25], ["Hess's law", 'Bond enthalpies', 60], ['Enthalpy changes', 'Born-Haber cycles', 30],
  ['Alkanes', 'Alkenes', 40], ['Ionic bonding', 'Covalent bonding', 35], ['pH calculations', 'Buffers', 50], ['Kc calculations', "Le Chatelier's principle", 55], ['Conformity', 'Obedience', 65],
  ['Multi-store model', 'Working memory model', 75], ['Behaviourism', 'Social learning theory', 45], ['Nervous system', 'Endocrine system', 60], ['Depression', 'OCD', 20], ['Reliability and validity', 'Sampling', 20],
  ['Quadratic equations', 'Simultaneous equations', 40], ['Direct and inverse proportion', 'Ratio problems', 50], ['Indices and surds', 'Standard form', 30]];
const KNOW = {
  Osmosis: { words: ['Water moves from where the water potential is higher, less negative, to where it is lower, across a partially permeable membrane. Pure water is zero, so anything dissolved makes it negative.'],
    clicked: ['Thinking of water potential as "how keen water is to leave": pure water is the keenest.'], met: ['Water moves towards the higher concentration of water'], closed: ['Osmosis needs ATP'],
    goal: 'Water potential in plant cells', final: 'partial', rating: 7 },
  Enzymes: { words: ['A competitive inhibitor is a similar shape to the substrate and sits in the active site, so more substrate pushes it out. A non-competitive one binds somewhere else and changes the shape.'],
    clicked: ['The lock and key picture, with the inhibitor as a wrong key that still fits.'], met: [], closed: ['Enzymes are used up in the reaction'], goal: 'Inhibitors and the rate graph', final: 'right', rating: 8 },
  "Hess's law": { words: ['Whatever route you take from reactants to products, the enthalpy change is the same, so you go round the cycle the other way and flip the signs.'], clicked: ['Arrows against the direction: change the sign.'],
    met: ['Formation enthalpies go in the cycle as they are given'], closed: [], goal: 'Cycles with formation data', final: 'wrong', rating: 5 },
  Conformity: { words: ['Normative is wanting to be liked, informational is wanting to be right. Asch shows normative: people knew the answer but went along.'], clicked: ['NSI = need to be liked, ISI = need to be right.'], met: [], closed: ['Asch shows informational influence'],
    goal: 'Types and explanations of conformity', final: 'right', rating: 9 },
  'Quadratic equations': { words: ['If it does not factorise you use the formula, and the bit under the square root tells you how many answers there are.'], clicked: ['b squared minus 4ac: negative means no real answers.'], met: ['You can always factorise a quadratic'], closed: [],
    goal: 'Solving with the formula', final: 'partial', rating: 6 },
};
const topicNamed = name => live().find(t => t.name === name);
function relatedOf(t) {
  const out = [];
  for (const [a, b] of LOOKALIKES) { const o = a === t.name ? topicNamed(b) : b === t.name ? topicNamed(a) : null; if (o) out.push({ id: o.id, name: o.name, via: 'versus', band: BAND_CODE(o.t1000) }); }
  for (const o of live().filter(x => x.subject_id === t.subject_id && x.section === t.section && x.id !== t.id).slice(0, 3)) if (!out.some(r => r.id === o.id)) out.push({ id: o.id, name: o.name, via: 'similar', band: BAND_CODE(o.t1000) });
  return out.slice(0, 8);
}
on('GET', '/api/p/map', () => {
  const subs = active(), ts = live().filter(t => subs.some(s => s.id === t.subject_id));
  const catI = new Map(subs.map((s, i) => [s.id, i])), units = [], unitI = new Map();
  for (const s of subs) for (const sec of s.sections) { unitI.set(`${s.id}|${sec.name}`, units.length); units.push([units.length, sec.id, sec.name, catI.get(s.id), null, null]); }
  const idx = new Map(ts.map((t, i) => [t.name, i]));
  const topics = ts.map((t, i) => { const p = S.positions[t.id]; return [i, t.id, t.name, null, catI.get(t.subject_id), unitI.get(`${t.subject_id}|${t.section}`) ?? null, p ? p[0] : null, p ? p[1] : null,
    0, t.t1000, t.t1000 == null ? 0 : 55, BAND_I(t.t1000), t.t1000 >= 600 ? 2 : 0, S.cards.filter(c => c.topic_id === t.id).length, null, 0, 0, 0, null]; });
  const categories = subs.map((s, i) => {
    const mine = ts.filter(t => t.subject_id === s.id), seen = mine.filter(t => t.t1000 != null);
    return [i, s.id, s.name, s.name, seen.length ? Math.round(seen.reduce((a, t) => a + t.t1000, 0) / seen.length) : null, mine.length ? Math.round((100 * seen.length) / mine.length) : 0,
      seen.filter(t => t.t1000 >= 600).length, mine.length - seen.length, mine.length];
  });
  return OK({ v: 2, meta: { seq: S.mapSeq, layout_version: S.layoutVersion, user: S.me.user, built_at: Date.now(), ready: true, teaching_now: null, weak_from: 3,
    bands: [['strong', 'Strong', 0], ['good', 'Getting there', 200], ['mixed', 'Shaky', 400], ['weak', 'Weak', 600], ['very_weak', 'Very weak', 800], ['unseen', 'Not seen yet', null]],
    link_types: ['versus', 'treated_by', 'adverse_effect', 'causes'] }, categories, units, topics,
  links: LOOKALIKES.filter(([a, b]) => idx.has(a) && idx.has(b)).map(([a, b, c]) => [idx.get(a), idx.get(b), 0, 60, c, 0]) });
}, 220);
on('PUT', '/api/p/map/positions', (b) => {
  if (!Number.isInteger(b.layout_version) || !Array.isArray(b.topics)) return E(400, 'Each position is [id, x, y] with plain numbers.');
  if (b.layout_version <= S.layoutVersion) return OK({ ok: true, applied: false, layout_version: S.layoutVersion });
  for (const [id, x, y] of b.topics) S.positions[id] = [x, y];
  S.layoutVersion = b.layout_version; S.mapSeq++;
  return OK({ ok: true, applied: true, layout_version: b.layout_version, n: b.topics.length, seq: S.mapSeq });
});
on('GET', '/api/p/topics/:id/knowledge', (b, [id]) => {
  const t = S.topics.find(x => x.id === id);
  if (!t) return E(404, 'That topic is not on the map.');
  const k = KNOW[t.name], sub = findSubj(t.subject_id);
  const cards = S.cards.filter(c => c.topic_id === id).slice(0, 10).map(c => ({ card_id: c.id, front: c.front, day: iso(-3) }));
  const lessons = k ? [{ id: nid('ls'), day: iso(-4), kind: 'lesson', outcome: k.final === 'wrong' ? 'not_landed' : 'landed', mo_rating: k.rating, goal: k.goal, final_result: k.final }] : [];
  return OK({ topic: { id, name: t.name, kind: 'concept', category: { id: t.subject_id, name: sub ? sub.name : null }, band: BAND_CODE(t.t1000), t100: t.t1000 == null ? null : Math.round(t.t1000 / 10) },
    as_of_seq: S.mapSeq, as_of: Date.now(),
    summary: { lessons: lessons.length, landed: lessons.filter(l => l.outcome === 'landed').length, stopped: 0, last_day: lessons.length ? lessons[0].day : null, mean_rating: k ? k.rating : null,
      cards: cards.length, misconceptions: { open: k ? k.met.length : 0, closed: k ? k.closed.length : 0 } },
    in_his_words: k ? k.words.map(text => ({ day: iso(-4), text, judgement: 'complete' })) : [],
    lost_marks: t.t1000 >= 600 ? [{ day: iso(-2), from: 'results', label: 'Paper 1 Q4', result: 'partial', reason: 'knowledge', reason_words: 'did not know it' }] : [], clicked: k ? k.clicked.map(text => ({ day: iso(-4), text })) : [],
    misconceptions: { met: k ? k.met.map(belief => ({ belief, status: 'open' })) : [], closed: k ? k.closed.map(belief => ({ belief, status: 'closed', closed_by: 'lesson' })) : [] },
    cards, mehlman: [], lessons, related: relatedOf(t) });
});
on('GET', '/api/p/library/topic/:id', (b, [id]) => {
  const t = S.topics.find(x => x.id === id);
  if (!t) return OK({ topic_id: id, n: 0, docs: [] });
  const word = t.name.toLowerCase().split(' ')[0];
  const docs = S.library.filter(x => x.text && x.text.toLowerCase().includes(word)).map((x, i) => ({ doc_id: x.id, title: x.title, pages: [{ page: x.pages ? 3 + i * 7 : 1, passages: [] }] }));
  return OK({ topic_id: id, n: docs.length * 2, docs, stale: false, built_at: Date.now() });
});
on('POST', '/api/p/teach/request', (b) => {
  const t = S.topics.find(x => x.id === b.topic_id);
  if (!t) return E(404, 'That topic could not be found.');
  const reused = S.requests.find(r => r.topic_id === t.id);
  if (reused) return OK({ lesson_id: reused.lesson_id, prompt: `Teach me ${t.name} (map: ${t.id})`, reused: true });
  const r = { topic_id: t.id, lesson_id: nid('lesson') };
  S.requests.push(r);
  return OK({ lesson_id: r.lesson_id, prompt: `Teach me ${t.name} (map: ${t.id})`, reused: false });
});
function offer() {
  if (S.offer) return S.offer;
  const names = Object.fromEntries(active().map(x => [x.id, x.name]));
  const seen = live().filter(t => t.t1000 != null && names[t.subject_id]).sort((a, c) => c.t1000 - a.t1000);
  const top = seen[0];
  const other = live().filter(t => names[t.subject_id] && t.subject_id !== (top && top.subject_id) && (t.t1000 == null || t.t1000 >= 400)).sort((a, c) => (a.t1000 == null ? -1 : 1) - (c.t1000 == null ? -1 : 1))[0];
  const opt = (slot, pick, t, reason, avoidance) => ({ slot, pick, topic: { id: t.id, name: t.name, category_id: t.subject_id }, reason, state: 'open', prompt: `Teach me ${t.name} (map: ${t.id})`, ...(avoidance ? { avoidance } : {}) });
  const line = other ? `You've passed on ${other.name} four times.` : null;
  S.offer = { ready: true, day: iso(0), state: 'open', offered_at: Date.now(), chosen: null, line, push: null, as_of: Date.now(),
    options: [top && opt('a', 'top', top, `weakness ${Math.round(top.t1000 / 10)} · 2 lost marks this week`),
      other && opt('b', 'contrast', other, `${other.t1000 == null ? 'never seen' : 'unseen 23 d'} · passed 4×`, { score: 0.7, rules: [{ rule: 'passed', n: 4 }], line })].filter(Boolean) };
  return S.offer;
}
on('GET', '/api/p/today/choice', () => OK(offer()));
on('POST', '/api/p/today/choice/choose', (b) => {
  const o = offer(), pick = o.options.find(x => x.topic.id === b.topic_id);
  if (!pick) return E(400, "That topic is not one of today's two.");
  for (const x of o.options) x.state = x === pick ? 'chosen' : 'declined';
  const lesson_id = nid('lesson');
  o.state = 'chosen'; o.chosen = { topic_id: pick.topic.id, lesson_id, at: Date.now(), via: 'web' };
  return OK({ lesson_id, prompt: pick.prompt, reused: false, day: o.day, chosen: pick.topic.id, today: o });
});
const SHARE_SHOWS = ['A ring for each subject (how much of it you know)', 'Your five weakest topics', 'How many flashcards are due', 'The scores of your last five results', 'Your streak'];
function shareView() {
  const subs = active().map(subjectOut), names = Object.fromEntries(subs.map(x => [x.id, x.name]));
  return { share: S.share, shows: SHARE_SHOWS, never: 'Your library, notes, "gap:" notes, flashcards, paper answers and result labels are never shared.',
    preview: { rings: subs.map(x => ({ subject: x.name, ring: Math.round(x.ring * 100) / 100, topics: x.topics_n, seen: x.seen_n, weak: x.weak_n })),
      weakest: live().filter(t => t.t1000 != null && names[t.subject_id]).sort((a, c) => c.t1000 - a.t1000).slice(0, 5).map(t => ({ topic: t.name, subject: names[t.subject_id], band: bandOf(t.t1000) })),
      cards_due: due().length, streak_days: 4,
      last_results: S.results.slice(0, 5).map(r => ({ subject: names[r.subject_id] || null, source: r.bank_name || r.source || null, day: r.day, marks: r.marks ?? null, out_of: r.out_of ?? null, right_n: r.right_n ?? null, total_n: r.total_n ?? null,
        percent: r.out_of ? Math.round((100 * (r.marks || 0)) / r.out_of) : r.total_n ? Math.round((100 * (r.right_n || 0)) / r.total_n) : null })) } };
}
on('GET', '/api/p/sharing', () => OK(shareView()));
on('PUT', '/api/p/sharing', (b) => { if (typeof b.share !== 'boolean') return E(400, 'Say true or false.'); S.share = b.share; return OK(shareView()); });

// Make it mine (worker/src/platform/custom.js): the same spec, kept in memory, with a demo page to show off.
const MINE_OPTIONS = { theme: { accent: ['blue', 'indigo', 'purple', 'pink', 'teal', 'green', 'graphite'], background: ['default', 'warm', 'cool', 'paper', 'mint', 'lavender'],
  mode: ['auto', 'light', 'dark'], text_size: ['small', 'normal', 'large', 'larger'], corners: ['round', 'soft', 'square'], density: ['comfy', 'compact'], font: ['system', 'rounded', 'serif', 'mono'],
    sky: ['ink', 'ember', 'plum', 'aubergine', 'indigo', 'teal', 'midnight', 'custom'] },
  sky: { hue: { min: 0, max: 359, default: 25 }, brightness: { min: 0.6, max: 1.4, step: 0.05, default: 1 } },
  tiles: ['setup', 'learn', 'choice', 'subjects', 'galaxies', 'cards', 'weakest', 'results', 'teach', 'library'], tabs: ['subjects', 'map', 'cards', 'results', 'library', 'papers', 'exams', 'how'],
  blocks: ['heading', 'text', 'checklist', 'links', 'topics', 'countdown'], icons: ['star', 'flag', 'book', 'flask', 'brain', 'calc', 'pen', 'clock', 'heart', 'bolt'] };
S.mine = S.mine || { spec: 1, pages: [{ id: 'required-practicals', title: 'Required practicals', icon: 'flask', blocks: [
  { type: 'heading', text: 'Chemistry required practicals' },
  { type: 'checklist', title: 'Done in class', items: [{ text: 'Making salts', done: true }, { text: 'Temperature changes', done: false }, { text: 'Rates of reaction', done: false }, { text: 'Chromatography', done: false }] },
  { type: 'countdown', label: 'Chemistry Paper 1', date: '2027-05-20' },
  { type: 'text', text: 'Tip from Miss Khan: always write the independent and dependent variables first.' }] }] };
S.mineHist = S.mineHist || [];
const mineMerge = (a, b) => { const o = { ...(a || {}) }; for (const [k, v] of Object.entries(b || {})) { if (v === null) delete o[k]; else o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? mineMerge(o[k], v) : v; } return o; };
const mineView = () => ({ custom: S.mine, spec: 1, options: MINE_OPTIONS, undo_left: S.mineHist.length });
on('GET', '/api/p/custom', () => OK(mineView()));
on('PATCH', '/api/p/custom', (b) => { S.mineHist.push(S.mine); S.mine = mineMerge(S.mine, b.patch); return OK({ custom: S.mine, changed: 'your hub', undo_left: S.mineHist.length }); });
on('POST', '/api/p/custom/undo', () => { if (!S.mineHist.length) return E(409, 'There is nothing to undo.'); S.mine = S.mineHist.pop(); return OK({ custom: S.mine, changed: 'undone', undo_left: S.mineHist.length }); });
on('POST', '/api/p/custom/reset', () => { S.mineHist.push(S.mine); S.mine = { spec: 1 }; return OK({ custom: S.mine, changed: 'back to the start', undo_left: S.mineHist.length }); });

export async function handle(method, path, body) {
  const url = new URL(path, location.origin);
  for (const [m, re, fn, ms] of R) {
    if (m !== method) continue;
    const hit = url.pathname.match(re);
    if (!hit) continue;
    if (S.signedOut && !url.pathname.startsWith('/api/auth/')) { await wait(80); return E(401, 'Please sign in.'); }
    await wait(ms || (method === 'GET' ? 140 : 180));
    return fn(body || {}, hit.slice(1).map(decodeURIComponent), url.searchParams);
  }
  await wait(100);
  return E(404, 'That could not be found.');
}
const wait = ms => new Promise(r => setTimeout(r, ms));
