// Why it works (#learn): the learning science in plain words, each idea tied to the part of the hub that does it, and
// a three-question check that is itself retrieval practice. The how (set up, a week, what to say) is in How it works
// (#how). Also the Today tile that points new people at How it works. Short paragraphs, honest about the research.
import { h, icon, btn, linkBtn, pageHead, claudeHref } from './kit.js';

const say = words => h('a', { class: 'say', href: claudeHref(words), target: '_blank', rel: 'noopener' }, icon('sparkle'), `“${words}”`);

const LOOP = [
  ['Test yourself', 'Cards, questions, past papers.'],
  ['Mark it', 'Right, wrong, and how sure you were.'],
  ['See it on your map', 'Weak topics turn orange and red.'],
  ['Fix the weak spots', 'Learn them with Claude, make cards.'],
];

const IDEAS = [
  { title: 'Testing yourself beats rereading', why: [
    'Every time you pull an answer out of your memory, that memory gets stronger. Rereading only makes the page feel familiar, which is not the same as being able to remember it in the exam.',
    'In a well-known experiment, students who tested themselves remembered far more a week later than students who spent the same time rereading (Roediger and Karpicke, 2006).',
  ], hub: 'Flashcards, past papers, and "Test me" with your Claude are all ways of pulling answers out of memory.', try: 'Test me on enzymes with 5 questions.' },
  { title: 'Little and often beats cramming', why: [
    'You forget on a curve: fast at first, then slower. Reviewing something just as you are starting to forget it resets the curve, and each time it lasts longer before you forget again.',
    'Cramming works for tomorrow and is mostly gone in a few weeks. Spacing is one of the most reliable findings in learning research.',
  ], hub: 'Your cards come back on the day you are likely to start forgetting them (the same kind of scheduler as modern Anki). Ten to fifteen minutes a day is enough.', try: 'How many cards do I have due today?' },
  { title: 'Mix your topics', why: [
    'Doing ten questions on one topic in a row is easy because you already know which method to use. In the exam the topics are mixed, so the hard part is spotting what a question needs.',
    'Practising with a mix teaches exactly that, even though it feels harder.',
  ], hub: 'Past papers mix topics. Today offers you two topics to choose from. You can ask Claude for a mixed set.', try: 'Give me 6 mixed questions from my weakest topics.' },
  { title: 'Know what you do not know', why: [
    'The most dangerous answers are the ones you were sure of and got wrong, because you would never think to revise them.',
    'The good news: once you see those mistakes, they are among the easiest to fix (Butterfield and Metcalfe, 2001).',
  ], hub: 'After each answer you tap Sure, Think so or Guess. Your results point out the questions you were sure of and still lost marks on.', try: 'Which questions was I sure about but got wrong?' },
  { title: 'Say your thinking out loud', why: [
    'Explaining your steps as you go (called self-explanation) helps you learn while you work, and it shows up gaps that a simple right or wrong mark hides (Chi and colleagues, 1994).',
    'Two people can both get 2 out of 4 for very different reasons. Your thinking shows which one you are.',
  ], hub: 'Press Record my thinking while you answer. Later your Claude reads what you said and tells you what to keep and what to change.', try: 'Analyse my thinking from my Study Hub recordings.' },
  { title: 'Learn from every lost mark', why: [
    'Marks go for different reasons: you did not know it, you misread the question, you made a slip, or you knew it but could not use it. Each one needs a different fix.',
    'A short reflection after a paper (an exam wrapper) helps you plan the right fix instead of just feeling bad about the score (Lovett, 2013).',
  ], hub: 'When you mark, you pick why marks went. Gaps become notes, lost marks can become flashcards, and three quick questions wrap up each paper.', try: 'Make flashcards from the marks I lost on my last paper.' },
  { title: 'Spend your time where it counts', why: [
    'It is tempting to revise what you already know, because it feels good. But the marks you can gain are in the topics you are weakest at.',
  ], hub: 'Your map turns weak topics orange and red, and Today suggests where to start, so you do not have to guess.', try: 'What should I focus on this week?' },
  { title: 'Practise like the real thing', why: [
    'Doing papers under exam conditions builds speed and calm, and gets you used to command words (describe, explain, evaluate) and how many points each mark needs.',
  ], hub: 'Exams shows the real paper next to your answers, with a clock.', try: 'Find the latest past paper for my Biology course and add it to my Study Hub.' },
  { title: 'Explain it back', why: [
    'If you can explain something in your own words, you understand it. If you cannot, you have found exactly what to learn next.',
  ], hub: 'When you learn a topic with Claude ("Teach me ..."), it ends by asking you to explain it back.', try: 'Teach me how enzymes work, then test me.' },
];

const QUIZ = [
  { q: 'Which helps you remember more a week later?', a: ['Reading your notes again', 'Testing yourself'], right: 1,
    yes: 'Yes. Pulling answers out of memory makes them stick.', no: 'Not quite. Rereading feels good, but testing yourself makes it stick.' },
  { q: 'You were sure of an answer and it was wrong. What now?', a: ['Ignore it, it was a one-off', 'Look at it hardest'], right: 1,
    yes: 'Yes. Those are the dangerous ones, and the easiest to fix once you see them.', no: 'Not quite. Sure but wrong is the one to look at hardest.' },
  { q: 'What is the best way to use flashcards?', a: ['A few minutes every day', 'All of them the night before'], right: 0,
    yes: 'Yes. Little and often beats cramming.', no: 'Not quite. Cramming fades fast; a few minutes a day lasts.' },
];

function quiz() {
  return QUIZ.map(item => {
    const out = h('p', { class: 'foot', 'aria-live': 'polite' });
    const opts = h('div', { class: 'quiz-opts', role: 'group', 'aria-label': item.q });
    item.a.forEach((label, i) => opts.append(h('button', { type: 'button', class: 'btn btn-gray', onclick: e => {
      for (const b of opts.children) { b.disabled = true; b.classList.remove('picked'); }
      e.currentTarget.classList.add('picked');
      opts.children[item.right].classList.add('right');
      out.textContent = i === item.right ? item.yes : item.no;
    } }, label)));
    return h('div', { class: 'quiz-q' }, h('b', null, item.q), opts, out);
  });
}

// How it works sets this flag when it opens (how.js); Not now sets it too.
const seen = app => { try { localStorage.setItem(`sh-how:${app.me && app.me.user}`, '1'); } catch { /* private mode */ } };

/** The Today card for someone who has not opened How it works yet (today.js gives the empty tile). */
export function todayTile(el, app) {
  el.replaceChildren(
    h('div', { class: 'tile-label' }, icon('help'), 'How your Study Hub works'),
    h('p', { class: 'muted', style: 'margin-top:6px' }, 'Two minutes on how the hub and your Claude work together, and what to say to make the most of it.'),
    h('div', { class: 'row-acts' }, linkBtn('Show me', '#how', 'primary', 'chevron'), btn('Not now', () => { seen(app); el.hidden = true; }, 'gray')));
  el.hidden = false;
}

export function render(root) {
  root.append(
    pageHead('Why it works', { kicker: 'The science behind your Study Hub', back: { href: '#how', label: 'How it works' } }),
    h('section', { class: 'tile learn-intro' },
      h('b', null, 'The short version'),
      h('p', null, 'Most people revise by rereading and highlighting. It feels productive, but it does not stick well. What works feels harder: testing yourself, spacing it out, mixing topics, and finding out why you lost marks.'),
      h('p', null, 'Your Study Hub is built so that the things that work are the easy things to do. You do the thinking; the hub and your Claude keep track of everything else.')),

    h('div', { class: 'section-title' }, 'The loop'),
    h('ol', { class: 'learn-loop' }, LOOP.map(([t, s], i) => h('li', null, h('span', { class: 'n' }, String(i + 1)), h('span', null, h('b', null, t), h('span', { class: 'sub' }, s))))),
    h('p', { class: 'foot' }, 'Then round again. Each time round, the map gets more accurate about what you know, so your time goes where it helps most.'),

    h('div', { class: 'section-title' }, 'Why it works'),
    h('div', { class: 'stack' }, IDEAS.map((x, i) => h('details', { class: 'card help-part', open: i === 0 },
      h('summary', null, h('b', null, x.title)),
      ...x.why.map(t => h('p', null, t)),
      h('p', { class: 'learn-hub' }, h('b', null, 'In your hub: '), x.hub),
      h('div', { class: 'help-says' }, h('div', { class: 't-micro' }, 'Try saying to your Claude'), say(x.try))))),

    h('section', { class: 'tile learn-tip' },
      h('b', null, 'The feeling trap'),
      h('p', null, 'If revising feels easy, it is probably not working as well as it could. The moment you struggle to remember something is the moment the memory gets stronger. Getting things wrong in practice is good: it is how the hub knows what to show you next.')),

    h('div', { class: 'section-title' }, 'Check yourself'),
    h('p', { class: 'foot', style: 'margin-bottom:10px' }, 'Three quick questions. Answering them is itself the kind of practice that works.'),
    h('section', { class: 'card learn-quiz' }, quiz()),

    h('div', { class: 'row', style: 'margin:20px 0 8px' }, linkBtn('Open Today', '#today', 'primary', 'chevron'), linkBtn('How it works', '#how', 'tinted', 'help')),
    h('p', { class: 'foot learn-refs' }, 'Where this comes from: Dunlosky and colleagues (2013) reviewed ten common study techniques and rated practice testing and spaced practice the most useful, and rereading and highlighting the least. Also Roediger and Karpicke (2006) on testing; Cepeda and colleagues (2006) on spacing; Rohrer and Taylor (2007) on mixing topics; Butterfield and Metcalfe (2001) on confident mistakes; Chi and colleagues (1994) on explaining out loud; Lovett (2013) on exam wrappers.'));
}
