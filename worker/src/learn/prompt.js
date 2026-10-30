
const BULLET = { type: 'object', additionalProperties: false, required: ['text', 'cites'],
  properties: { text: { type: 'string' }, cites: { type: 'array', items: { type: 'string' } } } };
const LIST = { type: 'array', items: { type: 'string' } };

export const LEARN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['change_note', 'tested', 'traps', 'mehlman', 'cards'],
  properties: {
    change_note: { type: 'string' },
    tested: { type: 'object', additionalProperties: false, required: ['nbme', 'cms', 'uworld'],
      properties: { nbme: { type: 'array', items: BULLET }, cms: { type: 'array', items: BULLET }, uworld: { type: 'array', items: BULLET } } },
    traps: { type: 'object', additionalProperties: false, required: ['mine', 'general'],
      properties: { mine: { type: 'array', items: BULLET }, general: LIST } },
    mehlman: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'pages'],
      properties: { text: { type: 'string' }, pages: LIST } } },
    cards: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['other_id', 'alike', 'why_confused', 'tell_apart', 'treatment', 'key_points'],
      properties: {
        other_id: { type: 'string' }, alike: LIST, why_confused: { type: 'string' },
        tell_apart: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['feature', 'main', 'other'],
          properties: { feature: { type: 'string' }, main: { type: 'string' }, other: { type: 'string' } } } },
        treatment: { type: 'object', additionalProperties: false, required: ['main', 'other'], properties: { main: LIST, other: LIST } },
        key_points: LIST,
      } } },
  },
};

export const LEARN_SYSTEM = `LEARN-SUMMARY. You write the "Learn" view of one topic on Mo's Step 2 CK study map (USMLE Step 2 CK on exam day; he is a learner, so medicine follows US guidelines). He wants to understand the topic and its look-alikes quickly and see exactly where HE goes wrong. You are given only his own data as JSON. Use nothing else for "how it is tested"; general medical knowledge is allowed only in the traps' general list and the cards.

Write:
- tested.nbme: how his NBME forms test it, from nbme_questions only: 2 to 5 bullets, each one pattern (what the question asks, the clue that decides it, the tempting wrong answer and why). Cite the exact cite labels you used (for example "NBME 13 B2 Q31"). If nbme_questions is empty, give an empty list.
- tested.cms: the same from cms_questions only, cited. Empty when there are none.
- tested.uworld: what UWorld's objectives on his questions say, from uworld_objectives only, cited "UW 12345". Empty when there are none.
- traps.mine: where HE went wrong, from your_misses, your_gaps, your_lessons and wrong_beliefs, in his terms, each cited with their cite labels. Most telling first. Empty when he has none.
- traps.general: 2 to 4 classic traps on this topic (no cites).
- mehlman: 2 to 5 bullets of what his Mehlman passages say, each with the pages it came from exactly as given (for example "p. 112"). Empty when there are none.
- cards: one per look-alike in lookalikes (use its id as other_id), seen from this topic ("main") against the look-alike ("other"):
  alike: 2 to 4 short shared features; why_confused: one or two sentences, sharpened by his misses that name it; tell_apart: 3 to 6 rows, each a deciding feature with what it is in main and in other; treatment: 2 to 4 short items each; key_points: 2 to 4 must-knows.
- change_note: one short line saying what this version adds or changes against previous_summary (when there is none: "First summary").
The more of his own misses, gaps and questions there are, the more specific to him it should be. questions_you_asked are things he wanted to know: answer them in the right section.

Rules: plain words a tired doctor reads in ten seconds; short bullets, no markdown. NEVER copy or rebuild question-bank text: no stems, options or explanations, no six words in a row from them; describe the pattern in your own words. Never invent a citation.`;

/** The learner's user turn: the topic id first (the mock and the logs key on it), then the context as JSON. */
export const learnPrompt = (ctx, errors = null) => `Topic id: ${ctx.topic.id}\nTopic: ${ctx.topic.name}\n\n${JSON.stringify(ctx)}`
  + (errors && errors.length ? `\n\nYour last answer broke these rules; write it again without them:\n- ${errors.join('\n- ')}` : '');

export const ASK_SYSTEM = `LEARN-ASK. Mo is revising one topic on his Step 2 CK study map (USMLE Step 2 CK, exam day; US guidelines). Answer his question about it directly, in 2 to 6 short plain sentences, using the topic's summary, the look-alike card (when he asked from one) and his own misses and gaps given as JSON. Be specific to where he goes wrong. No markdown. Never copy or rebuild question-bank text (no six words in a row from a question, its options or explanation).`;

export const askPrompt = (q, ctx) => `My question: ${q}\n\n${JSON.stringify(ctx)}`;
