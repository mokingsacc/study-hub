import { searchHistory } from '../history/search.js';
import { KINDS, SOURCES } from '../history/items.js';
import { readOnly } from './annotations.js';

const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };

export const HISTORY_TOOLS = [
  {
    name: 'hub_history', title: 'His history', annotations: readOnly('His history'), cap: 9000, trim: ['hits:3'],
    description: 'Search all he did and said, words and meaning: misses (reasoning, rule, look-alikes), gaps, his words per UWorld question and Anki card, lessons, teaching notes, misconceptions, re-tests, mnemonics. For any question on his past answers, words or habits, and before explaining when map_topic is not enough. open: the call to read a hit.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', minLength: 1, maxLength: 200 }, kinds: { type: 'array', maxItems: 9, items: { type: 'string', enum: KINDS } },
      topic: { type: 'string', maxLength: 120 }, system: { type: 'string', maxLength: 60 }, source: { type: 'string', enum: SOURCES },
      since: DAY, until: DAY, limit: { type: 'integer', minimum: 1, maximum: 25 } }, required: ['query'], additionalProperties: false },
    run: (env, user, args) => searchHistory(env, user, args),
  },
];
