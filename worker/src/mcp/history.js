import { searchHistory } from '../history/search.js';
import { SHOWN_KINDS, SOURCES, kindShown } from '../history/items.js';
import { readOnly } from './annotations.js';

const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };

export const HISTORY_TOOLS = [
  {
    name: 'hub_history', title: 'His history', annotations: readOnly('His history'), cap: 9000, trim: ['hits:3'],
    description: 'Search all he did and said (words and meaning): misses, gaps, his words per UWorld question and Anki card, lessons, teaching notes, misconceptions, checks of misses, mnemonics. For his past answers, words or habits, and before explaining beyond map_topic. open: read a hit.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', minLength: 1, maxLength: 200 }, kinds: { type: 'array', maxItems: 9, items: { type: 'string', enum: SHOWN_KINDS } },
      topic: { type: 'string', maxLength: 120 }, system: { type: 'string', maxLength: 60 }, source: { type: 'string', enum: SOURCES },
      since: DAY, until: DAY, limit: { type: 'integer', minimum: 1, maximum: 25 } }, required: ['query'], additionalProperties: false },
    // The old kind name 'retest' still works (1 Nov 2026).
    alias: a => (Array.isArray(a.kinds) ? { ...a, kinds: a.kinds.map(kindShown) } : a),
    run: (env, user, args) => searchHistory(env, user, args),
  },
];
