// The bank catalogue (docs/platform/plan.md §7): where a person's practice results come from, with the steps in
// plain words for an iPhone or iPad, filtered by their track. A track's own profile may list its `banks`
// (profiles.js); until it does, TRACK_BANKS below says which banks a track sees.
//
// `how` is the ways in: 'screenshot' (the AI reads a screenshot of the results screen) and 'typed' (the person
// enters marks themselves). The third way, their own Claude calling the log_results tool, needs no screen.
// `reads` is what a screenshot read looks for: numbers and short labels only, never question text.
import { buildProfile } from '../profiles.js';

const SHOT = 'take a screenshot (side button + volume up)';
const SHOT_UP = 'Take a screenshot (side button + volume up).';

export const BANKS = {
  past_paper: {
    id: 'past_paper', name: 'Past paper', tracks: ['gcse', 'alevel', 'language'], how: ['typed'],
    steps: [
      'Do the paper, then mark it yourself with the mark scheme.',
      'Tap Log results and choose Past paper.',
      'Add one row for each question: its number, the marks you got, the marks it was out of, and the topic.',
      'Check the topics, then Save.',
    ],
    reads: ['question number', 'marks', 'out of', 'topic'],
    hint: 'Type your own marks, question by question. Use the topic from the mark scheme, in a few words.',
  },
  save_my_exams: {
    id: 'save_my_exams', name: 'Save My Exams', tracks: ['gcse', 'alevel'], how: ['screenshot', 'typed'],
    steps: [
      'Finish a set of questions and open the results page.',
      `On the results page, ${SHOT}.`,
      'Tap Log results, choose Save My Exams, then pick the screenshot.',
      'Check the rows and fix any topic, then Save.',
    ],
    reads: ['question number', 'marks', 'out of', 'topic'],
    hint: 'Works with the results summary or the marks list. Scroll and take more than one screenshot if the list is long (up to 4).',
  },
  seneca: {
    id: 'seneca', name: 'Seneca', tracks: ['gcse', 'alevel'], how: ['screenshot', 'typed'],
    steps: [
      'Finish a Seneca session and stay on the results screen.',
      SHOT_UP,
      'Tap Log results, choose Seneca, then pick or paste the screenshot.',
      'Check the rows and fix any topic, then Save.',
    ],
    reads: ['topic', 'percent right', 'questions right'],
    hint: 'Seneca shows a score for each topic, so each row is a topic, not a single question.',
  },
  pmt: {
    id: 'pmt', name: 'Physics & Maths Tutor', tracks: ['gcse', 'alevel'], how: ['typed', 'screenshot'],
    steps: [
      'Print or open the paper and its mark scheme from Physics & Maths Tutor.',
      'Mark your answers yourself against the mark scheme.',
      'Tap Log results and choose Physics & Maths Tutor.',
      'Type each question\'s marks and its topic (or screenshot your own marks table), then Save.',
    ],
    reads: ['question number', 'marks', 'out of', 'topic'],
    hint: 'The site has no results screen, so this is your own marking.',
  },
  isaac: {
    id: 'isaac', name: 'Isaac Physics', tracks: ['gcse', 'alevel'], how: ['screenshot', 'typed'],
    steps: [
      'Open your Isaac Physics assignment or progress page.',
      SHOT_UP,
      'Tap Log results, choose Isaac Physics, then pick the screenshot.',
      'Check the rows and fix any topic, then Save.',
    ],
    reads: ['question number', 'right or wrong', 'topic'],
    hint: 'Each row is one question part, right or wrong.',
  },
  other_app: {
    id: 'other_app', name: 'Another app or website', tracks: ['gcse', 'alevel', 'language', 'uk_med', 'step2'], how: ['screenshot', 'typed'],
    steps: [
      'Finish your questions and open the screen that shows your score.',
      SHOT_UP,
      'Tap Log results, choose Another app, then pick the screenshot.',
      'Check the rows and fix any topic, then Save.',
    ],
    reads: ['question number', 'right or wrong', 'marks', 'out of', 'topic'],
    hint: 'Anything with a score screen works. If the read is wrong, type the rows yourself.',
  },
  // Stubs for the UK medicine track (not switched on for the school tracks).
  passmedicine: {
    id: 'passmedicine', name: 'PassMedicine', tracks: ['uk_med'], how: ['screenshot', 'typed'],
    steps: [
      'Finish a test and open its results page.',
      `On the results page, ${SHOT}.`,
      'Tap Log results, choose PassMedicine, then pick the screenshot.',
      'Check the rows, then Save.',
    ],
    reads: ['question number', 'right or wrong', 'topic'],
    hint: 'Numbers and topic labels only; the question text is never kept.',
  },
  quesmed: {
    id: 'quesmed', name: 'QuesMed', tracks: ['uk_med'], how: ['screenshot', 'typed'],
    steps: [
      'Finish a quiz and open its results.',
      `On the results screen, ${SHOT}.`,
      'Tap Log results, choose QuesMed, then pick the screenshot.',
      'Check the rows, then Save.',
    ],
    reads: ['question number', 'right or wrong', 'topic'],
    hint: 'Numbers and topic labels only; the question text is never kept.',
  },
  pastest: {
    id: 'pastest', name: 'Pastest', tracks: ['uk_med'], how: ['screenshot', 'typed'],
    steps: [
      'Finish a test and open the performance page.',
      `On the performance page, ${SHOT}.`,
      'Tap Log results, choose Pastest, then pick the screenshot.',
      'Check the rows, then Save.',
    ],
    reads: ['question number', 'right or wrong', 'topic'],
    hint: 'Numbers and topic labels only; the question text is never kept.',
  },
  uworld: {
    id: 'uworld', name: 'UWorld', tracks: ['uk_med', 'step2'], how: ['screenshot', 'typed'],
    steps: [
      'End the block and open its performance summary.',
      `On the summary, ${SHOT}.`,
      'Tap Log results, choose UWorld, then pick the screenshot.',
      'Check the rows, then Save.',
    ],
    reads: ['question number', 'right or wrong', 'topic', 'others percent'],
    hint: 'Numbers and topic labels only; the question text is never kept.',
  },
  amboss: {
    id: 'amboss', name: 'AMBOSS', tracks: ['uk_med', 'step2'], how: ['screenshot', 'typed'],
    steps: [
      'Finish a session and open its summary.',
      `On the summary, ${SHOT}.`,
      'Tap Log results, choose AMBOSS, then pick the screenshot.',
      'Check the rows, then Save.',
    ],
    reads: ['question number', 'right or wrong', 'topic'],
    hint: 'Numbers and topic labels only; the question text is never kept.',
  },
  bmj_oe: {
    id: 'bmj_oe', name: 'BMJ OnExamination', tracks: ['uk_med'], how: ['screenshot', 'typed'],
    steps: [
      'Finish a quiz and open its results.',
      `On the results screen, ${SHOT}.`,
      'Tap Log results, choose BMJ OnExamination, then pick the screenshot.',
      'Check the rows, then Save.',
    ],
    reads: ['question number', 'right or wrong', 'topic'],
    hint: 'Numbers and topic labels only; the question text is never kept.',
  },
};

// Which banks a track sees, in the order shown. Used until the track's profile lists its own `banks`.
export const TRACK_BANKS = {
  gcse: ['past_paper', 'save_my_exams', 'seneca', 'pmt', 'isaac', 'other_app'],
  alevel: ['past_paper', 'save_my_exams', 'seneca', 'pmt', 'isaac', 'other_app'],
  language: ['past_paper', 'other_app'],
  uk_med: ['passmedicine', 'quesmed', 'pastest', 'uworld', 'amboss', 'bmj_oe', 'other_app'],
  step2: ['uworld', 'amboss', 'other_app'],
};

/** The track a profile name or profile object stands for ('gcse', 'alevel', ...). */
export function trackOf(profile) {
  if (profile && typeof profile === 'object') return String(profile.track || profile.id || 'step2');
  return String(profile || 'step2');
}

/** Bank ids the person's track offers: the profile's own `banks` list when it has one, else TRACK_BANKS. */
export function bankIdsFor(profile) {
  const key = trackOf(profile);
  let listed = null;
  try {
    const p = profile && typeof profile === 'object' ? profile : buildProfile(key);
    if (p && Array.isArray(p.banks) && p.banks.length && (typeof profile === 'object' || p.id === key)) listed = p.banks;
  } catch { listed = null; }
  const ids = (listed || TRACK_BANKS[key] || TRACK_BANKS.step2).filter(id => BANKS[id]);
  return [...new Set(ids)];
}

/** The catalogue for GET /api/p/banks: [{id, name, how, steps, hint}] for the person's track only. */
export function banksFor(profile) {
  return bankIdsFor(profile).map(id => {
    const b = BANKS[id];
    return { id: b.id, name: b.name, how: [...b.how], steps: [...b.steps], hint: b.hint };
  });
}

/** The bank record (with `reads`) for an id the person's track offers, or null. */
export function bankFor(profile, id) {
  return bankIdsFor(profile).includes(id) ? BANKS[id] : null;
}

/** A bank id from what Claude or a person wrote ('seneca', 'Save My Exams', 'PMT'), or null. */
export function bankFromName(text) {
  const s = String(text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!s) return null;
  for (const b of Object.values(BANKS)) {
    if (b.id.replace(/_/g, ' ') === s || b.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === s) return b.id;
  }
  if (/\bpmt\b|physics (and|&)? ?maths tutor/.test(s)) return 'pmt';
  if (/\bsave my exams\b|\bsme\b/.test(s)) return 'save_my_exams';
  if (/\bpast paper\b|\bpaper\b/.test(s)) return 'past_paper';
  return null;
}
