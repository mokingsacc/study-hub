// "Make the most of it with your Claude" (docs/platform/v2-plan.md 2.5): per track (A-level, GCSE) and per subject,
// what the exam rewards, what to say to their Claude, what to watch out for and, for AQA, the required practicals.
// One source for the How it works page (how.js) and their Claude (worker/src/platform/guide.js, tool hub_guide).
// Facts are the national subject content; lines marked aqa show only when that subject's board is AQA, other boards
// get a neutral line. Pure data and pure functions: no DOM, so the Worker imports it too.

const AQA_ONLY = 'aqa';

export const GUIDE = {
  alevel: {
    label: 'A-level',
    moves: [
      'Start a new chat for each lesson or paper, with Study Hub switched on: the hub remembers, the chat does not need to.',
      'Say "gap:" the moment you are confused, so it is saved on that topic.',
      'Between past papers, let your Claude write practice papers on your weakest topics.',
      'Use voice mode for cards and quick quizzes when you are out.',
      'Every Sunday: "What should I focus on this week?"',
      'Make a galaxy for each mock or paper, so your map shows what is coming.',
    ],
    week: [
      ['Every day', '20 to 30 minutes', ['Your cards (or "quiz me on my cards").', 'One of Today\'s two topics with Teach me.']],
      ['Twice a week', '1 to 2 hours', ['A past paper, or half of one, timed on the Exams screen.', 'Record your thinking on two hard questions.', 'Mark it with your Claude, answer the three wrapper questions, make cards from lost marks.']],
      ['Once a week', '15 minutes', ['"What should I focus on this week?" and "Analyse my thinking".', 'Tidy the galaxy for your next mock.']],
      ['Before mocks', '', ['Practice papers from your Claude on that galaxy\'s weakest topics.']],
    ],
    subjects: {
      biology: {
        rewards: [
          'About a third of the marks are recall (AO1). The biggest share, around 40%, is applying it to unfamiliar examples (AO2). About a quarter is analysing data and judging experiments (AO3).',
          'At least 10% of marks need maths (percentages, rates, standard deviation, statistical tests), and at least 15% test practical skills, in the written papers.',
          [AQA_ONLY, 'Paper 3 includes a 25-mark essay linking topics from across the course.'],
        ],
        say: [
          'Give me an unfamiliar example of {topic} and ask me to apply it, exam style',
          'Invent an experiment with a results table, then ask me to describe, explain and evaluate it',
          'Quiz me on the required practicals one at a time: method, variables and how to make it valid',
          'Give me 5 maths questions in a biology context: percentage change, rate from a graph, standard deviation',
          [AQA_ONLY, 'Plan a 25-mark essay with me on a theme you choose, using at least five topics'],
          'Make flashcards for the definitions I keep losing marks on',
        ],
        watch: [
          'Describe means what the data shows, with numbers and units; explain means why, using biology.',
          'Use exact terms (complementary, active site, water potential, ATP); energy is transferred, never "made".',
          'One mark is roughly one point: count the marks.',
          'Show working; give units and sensible significant figures.',
        ],
        practicals: { aqa: ['Rate of an enzyme reaction (one variable)', 'Mitosis in root tip squashes and the mitotic index', 'Water potential of plant tissue (dilution series)',
          'Permeability of cell membranes', 'Dissecting a gas exchange or transport system', 'Antimicrobial substances with aseptic technique', 'Chromatography of leaf pigments',
          'Dehydrogenase activity in chloroplasts', 'Respiration rate in single-celled organisms', 'Animal movement in a choice chamber or maze',
          'Glucose concentration by colorimeter (calibration curve)', 'Species distribution and an environmental factor'] },
        other_practicals: 'OCR calls them PAGs and Edexcel core practicals: ask your Claude for your board\'s list.',
      },
      chemistry: {
        rewards: [
          'About a third recall (AO1), around 40% applying (AO2), about a quarter analysing and evaluating (AO3).',
          'At least 20% of marks are maths (moles, concentrations, Kc and Kp, pH, enthalpy and entropy, rates).',
          'At least 15% test practical skills.',
        ],
        say: [
          'Give me 5 mole calculations that get harder, one at a time, and check my working',
          'Here\'s a photo of my mechanism for nucleophilic substitution: check my curly arrows',
          'Test me on definitions word for word: first ionisation energy, standard enthalpy of formation',
          'Write me a 6-question practice paper on {topic} with a mark scheme',
          'Show me a worked answer with two mistakes and let me find them',
          'Make flashcards of the tests and colours for ions',
        ],
        watch: [
          'Units and significant figures; do not round halfway through.',
          'Equilibrium: say which way it shifts and why.',
          'Curly arrows start at a lone pair or a bond.',
          'Definitions are easy marks if they are exact.',
        ],
        practicals: { aqa: ['Standard solution and acid-base titration', 'Enthalpy change', 'Rate and temperature', 'Test-tube tests for cations and anions', 'Distilling a product',
          'Tests for alcohols, aldehydes, alkenes and carboxylic acids', 'Rates by initial rates and continuous monitoring', 'EMF of electrochemical cells', 'pH curves',
          'A pure organic solid (with a purity test) and a pure organic liquid', 'Tests for transition metal ions', 'Thin-layer chromatography'] },
        other_practicals: 'OCR calls them PAGs and Edexcel core practicals: ask your Claude for your board\'s list.',
      },
      psychology: {
        rewards: [
          'Three skills: AO1 describe theories and studies, AO2 apply them to the people in a scenario, AO3 evaluate (strengths, limitations, evidence, why it matters).',
          'Research methods are a big share (about a quarter of all marks), and at least 10% of marks need maths.',
          [AQA_ONLY, 'Three 2-hour papers of 96 marks; essays up to 16 marks; on Paper 3 you answer one option from each of three groups.'],
        ],
        say: [
          'Mark my 16-mark essay like an examiner: split it into AO1 and AO3, give the level and one thing to improve',
          'Give me a scenario on {topic} and make me apply the theory to the people in it',
          'Quiz me on key studies: aim, procedure, findings, conclusion and one evaluation point',
          'Research methods drill: give me 5 study designs and I\'ll pick the statistical test and say why',
          'Teach me how to write an evaluation point that earns AO3 marks',
          'Make flashcards of key terms for Issues and debates',
        ],
        watch: [
          '"Outline" or "describe" gets no marks for evaluation; "evaluate" gets few for description.',
          'Evaluation needs elaboration: point, evidence, explain, link back.',
          'In application questions, use the scenario\'s names and details.',
          'Do not just name a study: say what it found and what that shows.',
        ],
      },
    },
  },
  gcse: {
    label: 'GCSE',
    moves: [
      'Start a new chat for each lesson or paper, with Study Hub switched on.',
      'Say "gap:" the moment something does not make sense.',
      'Let your Claude write you practice questions on your weak topics.',
      'Use voice mode to go through your cards.',
      'Every Sunday: "What should I focus on this week?"',
    ],
    week: [
      ['Every day', '10 to 20 minutes', ['Your cards.', 'One weak topic with Teach me.']],
      ['Twice a week', '30 to 60 minutes', ['One past paper section with the clock on the Exams screen.', 'Mark it with your Claude; cards from what you lost.']],
      ['Once a week', '', ['"What should I focus on this week?"']],
      ['Before mocks', '', ['Practice papers on weak topics, and a required practicals quiz.']],
    ],
    subjects: {
      maths: {
        rewards: [
          'AO1 standard methods (half the marks on Foundation, 40% on Higher), AO2 reasoning and explaining (25% / 30%), AO3 solving problems (25% / 30%).',
          'One of your three papers is without a calculator.',
          ['tier:foundation', 'Foundation covers grades 1 to 5.'], ['tier:higher', 'Higher covers grades 4 to 9.'],
          [AQA_ONLY, 'Three papers of 80 marks, 1 hour 30 each; Paper 1 has no calculator.'],
        ],
        say: [
          'Here\'s a photo of a question from class: give me 5 like it with different numbers, one at a time',
          'Here\'s a photo of my working: find the first wrong line and tell me which method marks I\'d still get',
          'Non-calculator warm-up: 10 quick questions on fractions, percentages and negative numbers',
          'Teach me how to tell whether a question needs ratio, proportion or percentages',
          'Make flashcards of the formulas and facts I have to remember',
          'Mark my past paper with me',
        ],
        watch: [
          'Show every step: method marks come even with a wrong answer.',
          'Round only at the end, to what the question asks.',
          '"Show that" needs every line, ending with the given answer.',
          'Check units and reread the question\'s last line.',
        ],
      },
      combined_science: {
        rewards: [
          'AO1 knowledge 40%, AO2 applying 40%, AO3 analysing data and experiments 20%.',
          'About a fifth of marks need maths, and at least 15% are about required practicals.',
          'It is a double award, graded like 6-5.',
          [AQA_ONLY, 'Trilogy: six papers (two each for biology, chemistry and physics), 1 hour 15 each; 21 required practicals: 7 biology, 6 chemistry, 8 physics.'],
        ],
        say: [
          'Quiz me on the required practicals one at a time: method, variables, a risk and how to improve it',
          'Give me a 6-mark question on {topic} and mark it with me',
          'Quiz me on the physics equations I have to remember, then give me a calculation using one',
          'Explain {topic} in three simple steps, then test me',
          'Make flashcards from the marks I lost on my last paper',
        ],
        watch: [
          '6-mark answers need steps in a logical order.',
          'Write the equation, substitute, give the unit.',
          'Describing a graph: the trend plus numbers from it.',
          '"Compare" means similarities or differences, not each one separately.',
        ],
      },
      english_language: {
        rewards: [
          'Reading: find and interpret (AO1), analyse language and structure (AO2), compare views (AO3), evaluate (AO4).',
          'Writing: content and organisation (AO5), and vocabulary, sentences, spelling and punctuation (AO6).',
          [AQA_ONLY, 'Two papers, 1 hour 45 each (fiction reading and creative writing; non-fiction reading and writing your viewpoint); AO6 is 16 of the 40 writing marks.'],
        ],
        say: [
          'Write me a short fiction extract and a language question, then mark my answer against the levels',
          'Here\'s my descriptive writing: mark it for AO5 and AO6 and give me one thing to fix',
          'Teach me how to write about structure: openings, shifts in focus, endings',
          'Give me a timing plan for each question on my paper',
          'Make flashcards of language and structure terms, each with an example',
        ],
        watch: [
          'Quote briefly, then zoom in on a word and its effect.',
          'Naming a technique earns little without its effect.',
          'Plan writing for 5 minutes and keep 5 to check.',
        ],
      },
      english_literature: {
        rewards: [
          'AO1 a personal response backed by quotations, AO2 language, form and structure, AO3 context, AO4 spelling, punctuation and grammar on some questions.',
          'It is closed book: you need short quotations in your head.',
          [AQA_ONLY, 'Paper 1 Shakespeare and the 19th-century novel (1 hour 45); Paper 2 modern text, poetry anthology and unseen poetry (2 hours 15).'],
        ],
        say: [
          'Make me 20 flashcards of short quotations from my Shakespeare play, by character and theme',
          'Give me a theme from my 19th-century novel: I\'ll give a quotation and analyse one word',
          'Mark my paragraph on a character for AO1, AO2 and AO3',
          'Teach me the context of my modern text that actually helps an essay',
          'Compare two poems from my anthology with me',
        ],
        watch: [
          'Context should explain your point, not be a history lesson.',
          'Use short quotations woven into your sentences.',
          'Answer the question\'s focus word in every paragraph.',
        ],
      },
    },
  },
};

// Any other level (primary SATs, university, something else): the moves and week that work anywhere; their Claude
// finds out what their course rewards (DEFAULT_SUBJECT says to ask).
const OPEN_GUIDE = {
  moves: [
    'Start a new chat for each lesson, with Study Hub switched on: your Claude saves notes as you go.',
    'Say "gap:" the moment something does not make sense.',
    'Ask your Claude what your course or exam rewards, and to write you questions in that style.',
    'Test yourself more than you reread: cards, mnemonics and practice questions.',
    'Every Sunday: "What should I focus on this week?"',
  ],
  week: [
    ['Every day', '10 to 30 minutes', ['Your cards and mnemonics.', 'One weak topic with Teach me.']],
    ['Twice a week', '30 to 90 minutes', ['Practice questions or a past paper, then mark it with your Claude.']],
    ['Once a week', '', ['"What should I focus on this week?"']],
  ],
  subjects: {},
};

// GCSE separate sciences use Combined Science's advice, with their own AQA practical counts.
const SEPARATE = { biology: 10, chemistry: 8, physics: 10 };

export const DEFAULT_SUBJECT = {
  rewards: ['Most exams reward knowing it (AO1), using it in new situations (AO2) and analysing or evaluating (AO3); ask your Claude what your {board} {subject} papers reward.'],
  say: ['What do my {board} {level} {subject} papers look like and what do they reward?', 'Teach me my weakest {subject} topic', 'Find a past paper for {subject} and add it to my Study Hub', 'Make me 10 flashcards on {subject} key terms'],
  watch: ['Read the command word first.', 'About one point per mark.'],
};

/** {topic}, {board}, {level}, {subject} filled in. */
export function fillSay(text, { topic, board, level, subject } = {}) {
  return String(text).replace(/\{topic\}/g, topic || `a ${subject || 'subject'} topic`).replace(/\{board\}/g, board && board !== 'Other' ? board : 'exam board')
    .replace(/\{level\}/g, level || '').replace(/\{subject\}/g, subject || 'subject').replace(/\s{2,}/g, ' ').replace(/\bmy exam board\b/, 'my');
}

// A line is a string, or [condition, string]: 'aqa' (board is AQA), 'tier:foundation' or 'tier:higher'.
const keep = (line, s) => (typeof line === 'string' ? true : line[0] === AQA_ONLY ? s.board === 'aqa' : line[0].startsWith('tier:') ? s.tier === line[0].slice(5) : false);
const text = line => (typeof line === 'string' ? line : line[1]);

/**
 * The guide for a person: track = 'alevel' | 'gcse', or any other level (the open guide, with label); subjects [{id, subject
 * (catalogue id), name, board (id), board_name, tier, weakest}] (active ones). Returns {track, label, moves, week,
 * subjects: [{id, name, board_name, tier, rewards, say, watch, practicals?, practicals_note?, note?}]}.
 */
export function guideFor({ track, subjects = [], label = null }) {
  const g = GUIDE[track] || { ...OPEN_GUIDE, label: label || 'your course' };
  return {
    track: GUIDE[track] ? track : 'open', label: g.label, moves: g.moves, week: g.week,
    subjects: subjects.map(s => {
      const key = s.subject;
      const sep = track === 'gcse' && SEPARATE[key] ? key : null;
      const d = g.subjects[sep ? 'combined_science' : key] || DEFAULT_SUBJECT;
      const vars = { topic: s.weakest || null, board: s.board_name, level: g.label, subject: s.name };
      const out = { id: s.id, name: s.name, board_name: s.board_name, tier: s.tier || null,
        rewards: d.rewards.filter(l => keep(l, s)).map(l => fillSay(text(l), vars)).filter(l => !(sep && /Trilogy/.test(l))),
        say: d.say.filter(l => keep(l, s)).map(l => fillSay(text(l), vars)),
        watch: d.watch.map(l => fillSay(l, vars)) };
      if (sep && s.board === 'aqa') out.rewards.push(`Separate ${s.name}: ${SEPARATE[key]} AQA required practicals.`);
      if (d.practicals && d.practicals.aqa) {
        if (s.board === 'aqa') out.practicals = d.practicals.aqa;
        else if (d.other_practicals) out.practicals_note = d.other_practicals;
      }
      if (!s.board || s.board === 'other') out.note = 'Pick your exam board so your Claude can match your papers.';
      else if (s.board !== 'aqa' && d !== DEFAULT_SUBJECT) out.note = `Your board's papers differ from AQA's: ask your Claude "What's in my ${s.board_name} ${s.name} papers?"`;
      return out;
    }),
  };
}

/** The guide in plain text for their Claude (hub_guide), at most `max` characters. */
export function guideText(gd, max = 8000) {
  const lines = [`Track: ${gd.label}.`, 'Moves:', ...gd.moves.map(m => `- ${m}`), 'A simple week:', ...gd.week.map(([w, l, items]) => `- ${w}${l ? ` (${l})` : ''}: ${items.join(' ')}`)];
  for (const s of gd.subjects) {
    lines.push(`${s.name}${s.board_name ? ` (${s.board_name}${s.tier ? `, ${s.tier}` : ''})` : ''}:`, ...s.rewards.map(r => `- Rewards: ${r}`), ...s.say.map(x => `- Try: "${x}"`), ...s.watch.map(x => `- Watch out: ${x}`));
    if (s.practicals) lines.push(`- AQA required practicals: ${s.practicals.join('; ')}`);
    if (s.practicals_note) lines.push(`- ${s.practicals_note}`);
    if (s.note) lines.push(`- ${s.note}`);
  }
  let out = lines.join('\n');
  if (out.length > max) out = `${out.slice(0, max - 20)}\n(cut to fit)`;
  return out;
}
