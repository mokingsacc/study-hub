import { SOURCE_RULE } from './fact-sources.js';

export const FACT_CHECK_NOTE = 'Fact check:';

export const FACT_CHECK_LINES = [
  `Source order: ${SOURCE_RULE}`,
  'What to check: the today block below (the last 24 hours): every lesson saved (its summary, step titles and corrections), every card made or edited in a lesson or for a miss, and every correction logged with its card.',
  'Read each card with the Anki connector: find_cards {card_ids} (or the note ids, deck "Step 2 — My Cards"). A card listed with a correction is checked first: its lesson already took a line back.',
  'Check every deciding line (rules in or out, "means", always or never, a number or cut-off, a first-line test or drug) against map_topic {topic, include: ["library"]} (UWorld passages, then First Aid), then high_yield_notes (Mehlman), then anking_cards. Exam phrases: map_rules {part: "exam_wording"}; use them exactly.',
  'A wrong card: correct the wrong line in place with edit_card {which: "rewrite", card_id, front, back, notes} in his card style (map_rules card_review), which keeps the old fields so it can be put back; never add a "Corrected:" line beside the wrong one (the card is read aloud) and never delete it.',
  'A wrong line in a lesson: teach_memory_save {scope: "topic", scope_ref: <topic id>, tactic: "other", note: "Correction: <right>. Not: <wrong>. (<tag>)", reason: "nightly fact check"}. The next lesson on it, or on a look-alike, starts with "Do not repeat".',
  'Right, or no source either way: leave it. Never change a card on memory alone; a line you cannot source stays and is named in the morning line as not checked.',
  `Morning line, once, at the end: map_overview {note: "${FACT_CHECK_NOTE} corrected 1 card: tension pneumothorax gives absent, not clear, breath sounds."}, or "${FACT_CHECK_NOTE} 4 cards and 2 lessons checked, nothing wrong." It shows on Recent activity as its own line.`,
  'Never quote UWorld or NBME question stems or options; paraphrase library passages and cite them by tag.',
];
