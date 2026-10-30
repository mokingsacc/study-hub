// The connector's INSTRUCTIONS (plan §10.1), at most 2,000 characters because some Claude clients cut them at
// 2,048. Built from the registered tools: a line is included only when every tool it names is registered, and
// falls back to its phase-0 wording otherwise, so the text never sends Claude to a tool that is not there.
// The longer how-tos live in the tools' own descriptions, trigger words first.
export const INSTRUCTIONS_MAX = 2000;

const HEAD_MAP = "Mo's Step 2 CK hub: his exams, UWorld and Anki recordings, gaps, and his map of every topic met (weakness, look-alikes). Read it live, never from memory.";
const HEAD_0 = "Mo's Step 2 CK hub (exam Tue exam day): his practice exams with code marking, UWorld and Anki recordings and the gaps he logs. Read it live, never from memory.";
const NO_QBANK = 'Never put UWorld or NBME question text (stems, options) in any hub field or reply; use your own words. Misreads and test-taking slips: no card, no lesson.';
const ANKI_ONLY = 'Cards and the mistake log change only through the Anki connector.';
const STEP_TOOLS = ['check_rules', 'exam_mistakes', 'map_weakest', 'uworld_times', 'uworld_blocks'];

const list = names => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The instructions for the tools whose names are given (an array or a Set). */
export function buildInstructions(names) {
  const has = new Set(names);
  const all = (...n) => n.every(x => has.has(x));
  const mapTools = all('map_overview', 'map_rules');
  const lines = [mapTools ? HEAD_MAP : HEAD_0];
  if (has.has('log_gap')) {
    lines.push('"gap: ..." (or "gap, why ..."), by voice too: log_gap with his words and the topic as an AMBOSS article names it; reply only "Logged." and carry on; teach only if he asks.');
    lines.push('Anki Voice review: any card rated with a part wrong or nudged: log_gap in the same turn as rate_card (source anki_voice, origin review, card_id, topic, what he missed); say nothing.');
  }
  if (has.has('teach_memory_save')) lines.push('"log this" or "gap:" showing a wrong belief: also teach_memory_save {misconception: {topic, belief, ref}}.');
  if (all('teach_next', 'lesson_save', 'map_rules')) {
    lines.push('"Teach me (X)", "test me on this pair" or a map Teach me tap: teach_next once, teach with step2-teach, then lesson_save (code marks it). No step2-teach skill: map_rules {part: teach_method} first.');
  } else if (has.has('list_gaps')) {
    lines.push('"Teach me" with no topic: call list_gaps (gaps he stated come first), then follow step2-teach. "Teach me X": follow step2-teach.');
  }
  if (has.has('map_overview')) lines.push('Other study chats: map_overview once, at the start.');
  const explain = 'Explaining or answering on a topic (not mid-review or lesson): map_topic first; say in a line what he got wrong before (for_explaining).'
    + (has.has('hub_history') ? ' Past answers, words, misses, habits: hub_history first.' : '');
  if (all('map_topic', 'map_neighbours')) lines.push(`${explain} Only if he asks how it is tested (clues, traps, wrong choices): include ["exams"] (pairs: map_neighbours); end "On your exams:" with 2-3 cites; not in his data: say so.`);
  else if (has.has('map_topic')) lines.push(explain);
  if (all('hub_undo', 'map_update_topic')) {
    const settings = has.has('hub_settings') ? ' Settings, page looks: hub_settings (get first).' : '';
    const code = has.has('hub_request_change') ? 'Anything that needs code: hub_request_change with his words.' : 'Anything that needs code: say it needs Claude Code.';
    lines.push(`Changing the hub when Mo asks: map_, board_, hub_ tools; say in a line what changed and that "undo that" works (hub_undo). needs_confirm: ask Mo; call again with the confirm_token only after his yes.${settings} ${code} ${ANKI_ONLY}`);
    lines.push(NO_QBANK);
  } else {
    lines.push(`${NO_QBANK} ${ANKI_ONLY}`);
  }
  if (has.has('teach_debrief')) lines.push('A UWorld question under review ("log this" too): one teach_debrief by its ID.');
  const steps = STEP_TOOLS.filter(n => has.has(n)).concat(has.has('teach_debrief') || !has.has('uworld_words') ? [] : ['uworld_words']);
  const what = has.has('teach_debrief') ? 'Exam checks, "make flashcards", timing, habit analysis' : 'Exam checks, "make flashcards", UWorld "log this", timing, habit analysis';
  if (steps.length) lines.push(`${what}: ${list(steps)}.${has.has('map_rules') ? " Map rules: map_rules." : ''}`);
  return lines.join('\n');
}
