import { OUTCOMES, SKIP_REASONS, LEECH, SLOW, RECHECK_DAYS } from '../card-fix.js';
// One source order for lessons, the fact check and cards (the Claude audit, 1 Nov 2026): a nightly rewrite and the fact
// check after it never disagree.
import { SOURCE_RULE } from './fact-sources.js';

export const CARD_REVIEW_MAX = 8000;
export const CLAUDE_SUSPENDED_TAG = 'claude_suspended';

export function cardReviewRules() {
  const reasons = SKIP_REASONS.filter(r => r.key !== 'not_now').map(r => r.word.toLowerCase()).join(', ');
  return [
    // The queue
    `The queue: map_queue {kind: "card_fix", limit: 25} lists the cards waiting, each with card_id, note_id, deck, source (skip: Mo pressed Skip; leech: forgotten ${LEECH.lapses} or more times, or ${LEECH.recent_lapses} times in ${LEECH.recent_days} days; slow: median answer time over his own ${SLOW.percentile}th percentile across ${SLOW.min_reviews} or more reviews), reason (his chip: ${reasons}; none means he gave none), why, ratings (his recent ratings and seconds) and topics (the map topics the card is linked to).`,
    'Work through every item, with no cap: when a page is done, call map_queue again until it is empty. Skip nothing because the night is long.',
    `After each card, settle it at once: map_resolve {items: [{queue_id, action, note}]}, action one of ${OUTCOMES.join(', ')}, note one plain line (at most 200 characters) on what you did and why, never card text or question-bank text. Several cards in one call is fine (25 at most).`,
    // Reading the card and deciding
    'Read the card first: find_cards {card_ids: [card_id]} (Anki connector) for its front, back, notes and tags; get_card_images when it has pictures.',
    'Decide with his own data: map_topic on its topic (include misses, gaps, links) for what he got wrong and how weak it is; the topic\'s exam yield and lane (map_topic, map_search); planner value (a topic in today\'s plan or his weakest list, map_weakest {purpose: "lesson"}, counts for more).',
    `Source order: ${SOURCE_RULE}`,
    'What the exam keeps testing: AnKing cards on the topic (anking_cards, or find_cards with all_decks) and Mehlman (high_yield_notes with the topic, exam "Step 2"). A rewrite is centred on that, not on a detail.',
    'Rewrite when the point is high yield but the card is badly worded, wrong, too long, slow to answer, or keeps failing because it tests the wrong thing or two things at once. Suspend when it is low yield (no exam weight, a detail neither AnKing nor Mehlman cares about) or a duplicate of another of his cards. Keep when it is sound and high yield: a leech he simply has not learned yet stays, and the lapses are the point.',
    'A card Mo skipped as wrong: check the fact in the source order first; if the card is right, keep it and say so in the note.',
    'Mo\'s card style (the rewrite). Front: a short case in plain sentences, ideally under 30 words, built from the findings that decide it (age and sex, the key symptom, the one sign or test result that tells it apart). Then usually two questions: "What is the most likely diagnosis?" then "What is the next step in management?" (or "What is the treatment?"). One question only when the point is a single fact.',
    'Back, one line each: a full sentence answering question 1; a full sentence answering question 2; then "Versus <look-alike>: <the finding that tells them apart>, so <what you do differently>." The look-alike is a real condition, drug or answer a Step 2 question would offer beside this one, best one he mixes up (map_neighbours on the topic), checked in the source order.',
    'Notes (shown on screen only, never read aloud): start with "Why: " and one memorable mechanism sentence; then short paragraphs, one idea each: a mnemonic, the exceptions, the numbers that are tested, and a US versus UK difference only when it would trip him up. Up to three pictures (images), one per source when they show different things: an NBME High Yield picture, an AnKing summary table, an AnKing card picture.',
    'Plain words and full sentences everywhere: no arrows, symbols, abbreviations he would not say, or lists of fragments (he reviews by voice). Key words may be bold. Medicine follows US guidelines. Never put UWorld or NBME question text (stems, options, explanations) on a card: your own case, always.',
    // Doing it in Anki
    'Rewrite, same fact tested: edit the card in place so it keeps its review history: edit_card {which: "rewrite", card_id, front, back, notes}. Anki Voice keeps the old fields, so it can be put back.',
    'Rewrite, a different fact tested (the old card tested the wrong point): make a new card in his deck (edit_card {which: "rewrite", card_id, front, back, notes, new_fact: true}, which adds the new card and suspends the old one), never two live cards on one point.',
    `Suspend (low yield or duplicate): edit_card {which: "suspend", card_id}; never delete a card. Anki Voice suspends it and tags it ${CLAUDE_SUSPENDED_TAG}, so it can be found and unsuspended. Start the note with "Low yield:" or "Duplicate of <which card>:".`,
    'Keep: change nothing in Anki; the note says in one line why it stays.',
    // Undo and honesty
    'Every verdict can be undone: "undo that" (hub_undo) reopens the item and puts the card back in Anki (the old fields, or unsuspended). edit_card {which: "revert", card_id} does the Anki side alone.',
    `A card you settled is not queued again by the night for ${RECHECK_DAYS} days; if Mo skips it again, it comes back.`,
    'When a card cannot be read (find_cards finds nothing, Anki is down), leave its item open and say so in the nightly line (map_overview {note}).',
    'Finish with one line in the nightly note: how many rewritten, suspended (low yield or duplicate) and kept.',
  ];
}
