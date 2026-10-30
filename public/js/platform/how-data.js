// How it works (#how), the words: the tree of boxes, the hub part by part, and what to say where
// (docs/platform/v2-plan.md 2.4). Pure data for how.js and the copy tests (tests/web/platform-how.test.mjs).

export const UPDATED = '29 Oct 2026';
export const TITLE = 'How it works';
export const SUB = 'Tap any box to open it.';
export const INTRO = 'Your Study Hub keeps score; your Claude does the thinking. Test yourself, mark it, see it on your map, fix the weak spots, and round again.';

// The tree: You, then your Claude, then the Study Hub, then its four parts. live(key) fills the line under a box.
export const NODES = [
  { id: 'you', icon: 'user', title: 'You', line: 'iPhone · iPad · your voice',
    text: 'Open the Study Hub from your Home Screen to see your map, do your cards and sit papers. Or just talk to your Claude in the Claude app, typing or by voice.' },
  { id: 'claude', icon: 'sparkle', title: 'Your Claude', line: 'through the Study Hub connector', live: 'claude',
    text: 'Your own Claude, on your own plan. It reads your hub live and does things on it when you ask: teaches you, tests you, marks papers with you, writes practice papers, adds topics, changes how your hub looks. It costs the hub nothing, and every change can be undone.' },
  { id: 'hub', icon: 'shield', title: 'Study Hub', line: 'private to you',
    text: 'Keeps your subjects, topics, cards, papers and notes in one place. Its own code marks every answer and moves your map, so the colours are fair. Nobody else can see your hub unless you switch on sharing with Mo.' },
  { id: 'map', icon: 'map', title: 'The map', live: 'map', section: 'map',
    text: 'Every topic is a star, coloured by how well you know it. Each subject is a galaxy, and you can make your own. Tap a star for what you know and Teach me.' },
  { id: 'cards', icon: 'cards', title: 'Cards', live: 'cards', section: 'cards',
    text: 'Flashcards that come back just before you would forget them. Review on screen, by voice with your Claude, or link your own Anki.' },
  { id: 'exams', icon: 'exam', title: 'Exams', live: 'exams', section: 'exams',
    text: 'Past papers on screen with a clock, and practice papers your Claude writes. Mark them with your Claude; lost marks become notes and cards.' },
  { id: 'library', icon: 'library', title: 'Library', live: 'library', section: 'library',
    text: 'Your notes, past papers and mark schemes. Your Claude can search them and quote the page.' },
];

// The hub, part by part. tint: one of the Make it mine accents (never red or orange: Ember is for weakness only).
export const SECTIONS = [
  { id: 'today', name: 'Today', icon: 'home', tint: 'blue', module: null, items: [
    ['calendar', 'Countdown', 'Days to your first exam. Add the date in Settings.'],
    ['teach', 'Pick one to learn today', 'Each morning the hub offers two topics: its top pick and one you have been putting off. Tap one and your Claude teaches it.'],
    ['grid', 'A ring per subject', 'How much of each subject you have seen and are not weak in.'],
    ['cards', 'Cards due', 'Start here, or ask your Claude to quiz you by voice.'],
    ['flag', 'Weakest five', 'Your five weakest topics now, with the band word. Tap one to open it.'],
    ['results', 'Results', 'Your latest score. Log one from Seneca, Save My Exams or a past paper, or just tell your Claude.'],
    ['sparkle', 'Your galaxies', 'Rings for the galaxies you have made.'],
    ['calendar', 'Your study days', 'A square for every day you studied, darker the longer, with your streak. Tap it for the whole year.'],
    ['chat', 'Paste from Claude', 'A chat or its summary from the Claude app, saved for your Claude to read next time.'],
    ['settings', 'Make Today yours', 'Hide or reorder tiles, or change the greeting: tell your Claude, or Settings, Make it mine.'],
  ] },
  { id: 'map', name: 'The map', icon: 'map', tint: 'indigo', module: null, items: [
    ['map', 'One star, one topic', 'Galaxies group them: one per subject, plus any you make.'],
    ['target', 'Colour shows weakness', 'Blue strong, green getting there, yellow shaky, orange weak, red very weak; a hollow ring is not seen yet.'],
    ['results', 'Everything you do moves it', 'Cards, papers, results, lessons and gap notes all count. The hub\'s code moves the colours.'],
    ['clock', 'Strength fades', 'A topic you have not tested for a while drifts back, like real memory. Test it again to reset it.'],
    ['info', 'Tap a star', 'Its band, what you know in your own words, results, gap notes, Teach me and Make cards.'],
    ['list', 'Zoom and List', 'Pinch to zoom, tap a galaxy\'s name to fly to it; List shows the same topics as a list.'],
    ['moon', 'Your sky', 'Change the night sky\'s colour and brightness with the moon button.'],
  ] },
  { id: 'galaxies', name: 'Your galaxies', icon: 'galaxy', tint: 'purple', module: null, items: [
    ['sparkle', 'What a galaxy is', 'A group of topics you name: Energy, Paper 1, Mock in March, Hard ones. Each subject is one too.'],
    ['plus', 'Make one', 'Map, Galaxies, New galaxy. Or tell your Claude "Make a galaxy called Energy with Enzymes and Respiration".'],
    ['list', 'In and out', 'A topic lives in one galaxy at a time; take it out and it goes back to its subject\'s galaxy.'],
    ['pencil', 'New topics straight in', 'Type them into a galaxy and pick the subject they belong to.'],
    ['grid', 'Still in their subject', 'Rings, papers, results and lessons still count a topic for its subject.'],
    ['settings', 'Rename, reorder, delete', 'Put them in your order; deleting one sends its topics home.'],
    ['undo', 'Undo', 'Every change has Undo, and "undo that" works with your Claude.'],
  ] },
  { id: 'subjects', name: 'Subjects and topics', icon: 'grid', tint: 'teal', module: null, items: [
    ['grid', 'Your subjects', 'Each with its board and tier, so suggestions and papers fit your course.'],
    ['sparkle', 'Getting topics', 'Suggest topics gives a checklist to tick; Add topics lets you type your own; or ask your Claude.'],
    ['list', 'Sections', 'Like the chapters of your course. Move a topic between them any time.'],
    ['pencil', 'Edit a topic', 'Rename it, move it, put it in a galaxy or retire it. Its history stays.'],
    ['undo', 'Undo', 'Changes show Undo for a few seconds, and "undo that" works with your Claude.'],
  ] },
  { id: 'cards', name: 'Cards', icon: 'cards', tint: 'blue', module: 'cards', items: [
    ['cards', 'Your deck', 'Short question-and-answer cards for facts you need by heart.'],
    ['clock', 'Back just in time', 'Each card returns just before you would forget it. 10 to 15 minutes a day is plenty.'],
    ['check', 'Rating', 'Again, Hard, Good or Easy; 1 to 4 and Space on an iPad keyboard; swipe right for Good, left for Again.'],
    ['sparkle', 'Where cards come from', 'You, your Claude ("make me 5 cards on alkenes"), lost marks and lessons.'],
    ['chat', 'By voice', 'In the Claude app say "quiz me on my cards": it reads the front, you answer, it rates.'],
    ['link', 'Your own Anki', 'Switch on Link your own Anki and install the add-on on your computer; phone reviews count once it syncs.'],
  ] },
  { id: 'exams', name: 'Exams and papers', icon: 'exam', tint: 'indigo', module: 'exams', items: [
    ['upload', 'Get a paper in', 'Ask your Claude to find one online, or send it photos (it gives you a link to tap).'],
    ['exam', 'Make it an exam', 'Your Claude sets up every question with its marks and page.'],
    ['clock', 'Sit it', 'The real paper beside your answers, with a clock. Tap how sure you were after each answer.'],
    ['sparkle', 'Practice papers', 'New questions on your weak topics, written by your Claude with a mark scheme. The hub checks the maths.'],
    ['check', 'Mark it', 'Tick the points you earned, or mark it with your Claude. The hub adds up the marks.'],
    ['flag', 'After marking', 'Marks go on your map; lost marks become notes and, if you want, cards. Three quick questions wrap it up.'],
  ] },
  { id: 'thinking', name: 'Record your thinking', icon: 'mic', tint: 'teal', module: 'exams', items: [
    ['mic', 'Think out loud', 'Press Record and say what the question wants, what you know and how you will get the marks.'],
    ['shield', 'Words, not sound', 'Only the words are kept, with the question.'],
    ['sparkle', 'Analyse my thinking', 'Your Claude tells you two or three things to keep and to change.'],
    ['note', 'Feedback kept', 'It is saved next to the question for next time.'],
  ] },
  { id: 'teach', name: 'Teach me', icon: 'teach', tint: 'pink', module: null, items: [
    ['teach', 'Start', 'Tap Teach me on any topic, or say "teach me osmosis".'],
    ['search', 'A quick probe', 'One to three questions find where your understanding stops.'],
    ['bolt', 'Small steps', 'Short explanations, each with a quick check on a new example.'],
    ['target', 'An exam-style question', 'Marked point by point against a mark scheme.'],
    ['chat', 'Explain it back', 'About 30 seconds in your own words, then rate the topic 1 to 10.'],
    ['cards', 'A card if you want', 'Claude drafts one and saves it only if you say yes.'],
    ['library', 'What you know', 'Your explanations and what clicked, kept in the topic sheet.'],
  ] },
  { id: 'mnemonics', name: 'Mnemonics', icon: 'teach', tint: 'green', module: 'mnemonics', items: [
    ['teach', 'A hook to remember', 'Like PMAT for the stages of mitosis, or MRS GREN for life processes.'],
    ['plus', 'Add one', 'Mnemonics, Add: the cue, what it is for and its letters. Or ask your Claude to write some.'],
    ['check', 'Test it', 'The cue, then each letter in turn: tap Got it or Missed. Misses come back sooner.'],
    ['clock', 'Both ways', 'After a day it also asks the other way round: what is the mnemonic for this?'],
    ['map', 'On your topics', 'A missed letter nudges the topics it covers on your map.'],
  ] },
  { id: 'library', name: 'Library', icon: 'library', tint: 'purple', module: 'library', items: [
    ['upload', 'Add files', 'PDFs or photos of notes, papers and mark schemes, here or through your Claude.'],
    ['search', 'Search', 'By words or meaning; results show the document and page.'],
    ['sparkle', 'Your Claude reads it', 'It quotes your notes, with the page, when teaching or marking.'],
    ['photo', 'Pictures on a topic', 'Add a photo of a diagram to a topic, or a page from your notes. Your Claude can pin pages too.'],
    ['shield', 'Private', 'Only you and your Claude can open it. Add only what you are allowed to use for your own study.'],
  ] },
  { id: 'results', name: 'Results', icon: 'results', tint: 'teal', module: 'results', items: [
    ['results', 'Log a score', 'From Seneca, Save My Exams, Physics & Maths Tutor, Isaac or a past paper: a screenshot, typed marks, or tell your Claude.'],
    ['shield', 'Numbers only', 'Scores and topic names, never the questions.'],
    ['map', 'Onto the map', 'Each question lands on its topic; unmatched ones wait.'],
    ['chat', 'Or just say it', 'Tell your Claude "I got 14 out of 20 on Seneca for organic chemistry" and it is saved.'],
  ] },
  { id: 'mine', name: 'Make it yours', icon: 'sparkle', tint: 'green', module: null, items: [
    ['sparkle', 'Just ask', '"Make my hub purple with bigger text", "put cards first on Today", "hide Results".'],
    ['settings', 'Or tap', 'Settings, Make it mine: colour, background, light or dark, text size, font, corners, spacing and the sky.'],
    ['grid', 'Today and tabs', 'Hide or reorder tiles; hide tabs you do not use; switch whole parts on or off.'],
    ['note', 'Your own pages', 'A required practicals checklist, a countdown to mocks, your weakest Chemistry topics.'],
    ['map', 'Galaxies and layout', 'Your galaxies, or the rest laid out by section instead of subject.'],
    ['teach', 'How you are taught', '"More diagrams, shorter turns" and every lesson follows it.'],
    ['undo', 'Undo and reset', 'Undo the last 10 look changes, start again, or export your setup.'],
  ] },
  { id: 'claude', name: 'Your Claude', icon: 'chat', tint: 'graphite', module: null, items: [
    ['link', 'Connect once', 'Settings, Claude, Make a new link. In the Claude app: Settings, Connectors, Add custom connector; paste it and name it Study Hub.'],
    ['sparkle', 'Switch it on in a chat', 'Tap + (the tools button) and switch Study Hub on.'],
    ['chat', 'Your plan, not the hub\'s', 'What it does runs on your Claude plan. No API key needed.'],
    ['check', 'Live, and only yours', 'It reads your hub live, never from memory, and only your hub.'],
    ['note', 'Notes as you go', 'With Study Hub switched on, it saves a short note of what you covered, so the next lesson starts from there. See them in More, Chat notes.'],
    ['undo', 'Undo that', 'Anything it changes can be undone.'],
    ['mic', 'By voice', 'Voice mode can quiz your cards, teach you and talk you through a paper.'],
  ] },
  { id: 'privacy', name: 'Privacy and fairness', icon: 'shield', tint: 'graphite', module: null, items: [
    ['shield', 'Private to you', 'Mo sees only that your account exists and your AI spend, unless you share your progress.'],
    ['check', 'Code marks, not Claude', 'Marks come from the mark scheme points ticked, added up by the hub.'],
    ['warn', 'No copied exam text', 'Your Claude\'s practice papers are its own; past papers stay in your own library.'],
    ['download', 'Your data', 'Export everything or delete your account in Settings.'],
    ['clock', 'Built-in AI limits', 'Small built-in jobs (screenshots, topic ideas) have a daily limit.'],
  ] },
  { id: 'fix', name: 'If something goes wrong', icon: 'refresh', tint: 'graphite', module: null, items: [
    ['refresh', 'Refresh', 'Tap Refresh in More, or reopen the app; the hub also refreshes when you come back from Claude.'],
    ['check', 'Self-check', 'Settings, Is everything working?, or ask your Claude "is my Study Hub working?".'],
    ['undo', 'Undo', 'In the message, or "undo that" with your Claude.'],
    ['user', 'Ask Mo', 'Tell him what you were doing and what you saw.'],
  ] },
];

// What to say, by place. Each phrase: {say, does, when?}.
export const PLACES = [
  { id: 'chat', name: 'Any Claude chat', tag: 'Any time', icon: 'chat', where: 'The Claude app or claude.ai, with Study Hub switched on.', items: [
    { say: 'Set up my Study Hub with me', does: 'Your Claude asks about your subjects, boards, exams and results, one thing at a time, and sets it all up.' },
    { say: 'What should I revise today?', does: 'Your Claude reads your map and picks one or two topics, with why.' },
    { say: 'Teach me osmosis', does: 'A short lesson ending in an exam-style question. "Teach me" on its own picks a weak topic.' },
    { say: 'gap: I don\'t get why enzymes denature', does: 'Saved on that topic; it just says "Logged."' },
    { say: 'What are my weakest topics in Chemistry?', does: 'The five weakest, with how weak.' },
    { say: 'Make me 5 flashcards on alkenes', does: 'Cards in your deck on that topic.' },
    { say: 'Make me a mnemonic for the stages of mitosis', does: 'Saved under Mnemonics, ready to test.' },
    { say: 'I got 14 out of 20 on Seneca for organic chemistry', does: 'Saved as a result; your map moves.' },
    { say: 'Analyse my thinking', does: 'Feedback on how you reason (after Record).' },
    { say: 'Is my Study Hub working?', does: 'A self-check in plain words.' },
    { say: 'Undo that', does: 'Takes back the last change.' },
  ] },
  { id: 'exams', name: 'Papers and exams', tag: 'Exams', icon: 'exam', where: 'Any Claude chat, before or after you sit a paper.', items: [
    { say: 'Find the AQA A-level Biology Paper 1 June 2023 and its mark scheme and add them to my Study Hub', does: 'Both PDFs in your library.', when: 'Change board, paper and year.' },
    { say: 'Add these photos of my exam paper', does: 'A link to tap; it works for an hour.' },
    { say: 'Make my exam paper into an exam I can sit', does: 'Ready under Exams.' },
    { say: 'Write me a 6-question practice paper on my weakest Chemistry topics', does: 'New questions with a mark scheme, under Exams.' },
    { say: 'Here\'s a photo of my working for question 3', does: 'Saved as your answer, mistakes and all.' },
    { say: 'Mark my latest exam with me', does: 'Question by question; the hub adds up the marks.' },
    { say: 'Make flashcards from the marks I lost', does: 'Cards on exactly what you missed.' },
    { say: 'Put the heart diagram from my notes on Cardiac cycle', does: 'That page shows in the topic, under Pictures.' },
  ] },
  { id: 'mine', name: 'Change your hub', tag: 'Make it yours', icon: 'sparkle', where: 'Any Claude chat. Only your hub changes, and "undo that" works.', items: [
    { say: 'Make a galaxy called Energy with Enzymes, Respiration and Photosynthesis', does: 'A new galaxy on your map with those topics.' },
    { say: 'Move Enzymes into my Energy galaxy', does: 'It moves there on your map.' },
    { say: 'Take Enzymes out of my Energy galaxy', does: 'It goes back to its subject\'s galaxy.' },
    { say: 'Rename my Energy galaxy to Bioenergetics', does: 'New name, same topics.' },
    { say: 'Add meiosis and the cell cycle to my Mock 1 galaxy', does: 'New topics, made in their subject and put in the galaxy.' },
    { say: 'Delete my Mock 1 galaxy', does: 'Its topics go back to their subjects.' },
    { say: 'Make my hub purple with bigger text', does: 'A new look, on your hub only.' },
    { say: 'Put cards first on Today and hide Results', does: 'Today and the tabs, your way.' },
    { say: 'Add a page with a checklist of my required practicals', does: 'A page of your own in the menu.' },
    { say: 'My first exam is on 14 May', does: 'Today counts down to it.' },
    { say: 'Switch on Link your own Anki', does: 'The Anki part appears in Settings.' },
    { say: 'Teach me with more diagrams and shorter turns', does: 'Every lesson follows it.' },
  ] },
  { id: 'voice', name: 'By voice', tag: 'Hands-free', icon: 'mic', where: 'The Claude app\'s voice mode, with Study Hub switched on.', items: [
    { say: 'Quiz me on my cards', does: 'It reads the front, you answer, it rates.' },
    { say: 'Talk me through my practice paper', does: 'Answers and how sure you were, then marking.' },
    { say: 'Test me on the required practicals', does: 'One practical at a time.' },
    { say: 'Explain enzymes to me while I walk', does: 'A lesson in short spoken turns.' },
  ] },
];

export const LEFT_OUT = ['Copying exam questions into your hub', 'Keeping your voice', 'Keeping photos of your working', 'Anyone else seeing your hub', 'Claude deciding your marks'];
export const LEFT_OUT_WHY = 'Nothing is broken: this keeps your hub private, fair and on the right side of copyright.';

// Old Help ids (#help/<id>) and how.js targets: a section id, 'plan', 'say', or null for the top.
const HELP_TO = { start: null, claude: 'claude', map: 'map', cards: 'cards', exams: 'exams', thinking: 'thinking', library: 'library', results: 'results', mine: 'mine', help: 'fix' };
export function targetOf(id) {
  if (!id) return null;
  if (id === 'plan' || id === 'say') return id;
  if (SECTIONS.some(s => s.id === id)) return id;
  return Object.prototype.hasOwnProperty.call(HELP_TO, id) ? HELP_TO[id] : null;
}

const fold = s => String(s).toLowerCase();
export const phraseText = (p, place) => fold(`${p.say} ${p.does} ${p.when || ''} ${place ? `${place.name} ${place.tag}` : ''}`);
/** Phrases matching every word of q, as [{place, item}]. */
export function filterPhrases(q, places = PLACES) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  const out = [];
  for (const place of places) for (const item of place.items) { const t = phraseText(item, place); if (words.every(w => t.includes(w))) out.push({ place, item }); }
  return out;
}
export const phraseCount = (places = PLACES) => places.reduce((n, p) => n + p.items.length, 0);
