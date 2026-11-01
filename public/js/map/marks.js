// The topic marks (plan §9 Topic flags): one home for the flag bits and the words that go with them, shared by
// the Worker (worker/src/map/flags.js builds them in SQL, so the map payload and panel's topicDetail agree)
// and the page (the mini card, the legend and the aria-live readout). Pure: no DOM, no D1.

export const TOPIC_FLAGS = Object.freeze({
  proposed: 1,          // a topic Claude or code suggested, not yet confirmed (dashed ring)
  taught_today: 2,      // a lesson on it ended today (thin outer ring)
  retest_due: 4,
  requested: 8,
  teaching_now: 16,     // a lesson on it is running (ring)
  sure_wrong: 32,       // a sure-and-wrong answer on it
  slow: 64,             // an answer over 120 s on it
  checklist: 128,
  gap: 256,
  // Evidence strength (shared/evidence.js, wave 2 C.4): thin draws the star pale with an outline and no glow; solid is
  // the most there is; neither bit is "some". Words only through the panel and the card's evidence line, never a mark.
  thin: 512,
  solid: 1024,
});

export const MARK_LINES = [
  ['teaching_now', 'Claude is teaching this now'],
  ['requested', 'You asked to be taught this'],
  ['gap', "You said you don't get this"],
  ['taught_today', 'Taught today'],
  ['sure_wrong', 'Sure and wrong before'],
  ['slow', 'Slow before (over 2 minutes)'],
  ['proposed', 'Suggested topic, not confirmed yet'],
];

export const hasFlag = (flags, name) => ((Number(flags) || 0) & TOPIC_FLAGS[name]) !== 0;

/** The card's mark lines for a flags value, as plain sentences. */
export function markLines(flags) {
  return MARK_LINES.filter(([name]) => hasFlag(flags, name)).map(([, words]) => words);
}

export const MAP_MARKS = Object.freeze([
  ['learn_next', 'Learn next'],
  ['high_priority', 'High-priority teaching'],
]);
// Where each mark sits, in screen px beyond the star's drawn radius: the ring's gap and width, the triangle's gap and
// half width, the dot's gap and radius (both renderers read these).
export const MARK_GEOM = Object.freeze({ ring: Object.freeze({ gap: 3.5, width: 1.75 }), tri: Object.freeze({ gap: 3, half: 3.2, tall: 5.4 }), dot: Object.freeze({ gap: 3, r: 1.6 }) });
export const DRAWN = Object.freeze({ dot: TOPIC_FLAGS.retest_due });

/** Which of the three marks topic i carries: {next, high, retest}. teach: {next: Set, high: Set} of topic indices. */
export function marksOf(flags, i, teach = null) {
  const next = !!(teach && teach.next && teach.next.has(i));
  return { next, high: !next && !!(teach && teach.high && teach.high.has(i)), retest: hasFlag(flags, 'retest_due') };
}
