// The connector's INSTRUCTIONS (plan §10.1), at most 2,000 characters because some Claude clients cut them at
// 2,048. Built from the registered tools: a line is included only when every tool it names is registered, and
// falls back to its phase-0 wording otherwise, so the text never sends Claude to a tool that is not there.
// The longer how-tos live in the tools' own descriptions, trigger words first.
import { QUOTE_RULE } from '../../../public/js/shared/evidence.js';
export const INSTRUCTIONS_MAX = 2000;

const HEAD_MAP = "Mo's Step 2 CK hub: his exams, UWorld and Anki recordings, gaps, and his map of every topic met. Read it live, never from memory.";
const HEAD_0 = "Mo's Step 2 CK hub (exam Tue exam day): his practice exams with code marking, UWorld and Anki recordings and the gaps he logs. Read it live, never from memory.";
const NO_QBANK = 'No UWorld or NBME question text (stems, options) in any hub field or reply: your own words. Misreads, test-taking slips: no card or lesson.';
// "log this" goes to the hub (teach_debrief, log_gap; 1 Nov 2026), so only cards are the Anki connector's.
const ANKI_ONLY = 'Cards change only through the Anki connector.';
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
    // No Anki Voice line: the Anki server sends rate_card's gap to the hub itself (Anki Voice hub_gaps.py), so a parallel
    // log_gap logged every missed card twice (audit, 31 Oct 2026).
  }
  if (has.has('teach_memory_save')) lines.push('"log this" or "gap:" showing a wrong belief: also teach_memory_save {misconception: {topic, belief, ref}}.');
  if (all('teach_next', 'lesson_save', 'map_rules')) {
    // The skills are stubs: the methods come from the hub (map_rules teach_method, qbank_method; the Claude audit, 1 Nov 2026).
    lines.push('"Teach me (X)", "test me on this pair", "audit me" or a map Teach me tap: teach_next once, follow its method (in full: map_rules {part: teach_method}), then lesson_save.');
    lines.push('UWorld blocks and questions, "log this", "make flashcards": map_rules {part: qbank_method} once a chat, then follow it.');
  } else if (has.has('list_gaps')) {
    lines.push('"Teach me" with no topic: call list_gaps (gaps he stated come first), then follow step2-teach. "Teach me X": follow step2-teach.');
  }
  if (has.has('map_overview')) lines.push('Other study chats: map_overview first, once.');
  if (has.has('map_topic')) lines.push(QUOTE_RULE);
  const explain = 'Explaining or answering on a topic (not mid-review or lesson): map_topic first; name what he got wrong before (for_explaining).'
    + (has.has('hub_history') ? ' Past answers, words, misses, habits: hub_history first.' : '');
  if (all('map_topic', 'map_neighbours')) lines.push(`${explain} How it is tested, only if he asks: include ["exams"] (pairs: map_neighbours); end "On your exams:" with 2-3 cites; none: say so.`);
  else if (has.has('map_topic')) lines.push(explain);
  if (all('hub_undo', 'map_update_topic')) {
    const settings = has.has('hub_settings') ? ' Settings, page looks: hub_settings (get first).' : '';
    const code = has.has('hub_request_change') ? 'Anything that needs code: hub_request_change with his words.' : 'Anything that needs code: say it needs Claude Code.';
    lines.push(`Changing the hub when Mo asks: map_, board_, hub_ tools; say in a line what changed and that "undo that" works (hub_undo). needs_confirm: ask Mo; call again with the confirm_token only after his yes.${settings} ${code} ${ANKI_ONLY}`);
    lines.push(NO_QBANK);
  } else {
    lines.push(`${NO_QBANK} ${ANKI_ONLY}`);
  }
  if (has.has('teach_debrief')) lines.push('A UWorld question in review ("log this" too): one teach_debrief by ID.');
  if (has.has('map_photo_inbox')) lines.push("Photos to file: map_photo_inbox list, then file. Pasted in chat: ask him to put them in the hub's Photo inbox.");
  const steps = STEP_TOOLS.filter(n => has.has(n)).concat(has.has('teach_debrief') || !has.has('uworld_words') ? [] : ['uworld_words']);
  const what = has.has('teach_debrief') ? 'Exam checks, "make flashcards", timing, habit analysis' : 'Exam checks, "make flashcards", UWorld "log this", timing, habit analysis';
  // (map_rules's own description says what it holds; the line that named it made room for "audit me", wave 4.)
  if (steps.length) lines.push(`${what}: ${list(steps)}.`);
  return lines.join('\n');
}
