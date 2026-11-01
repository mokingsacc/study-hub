import SKILL_MD from './teach-method-text.js';
import { fnv1a } from './teach-priority.js';

export const METHOD_CARD_MAX = 1000;
// map_rules' reply cap (mcp/map.js) holds the longest served method, the qbank one, with room.
export const METHOD_TEXT_MAX = 33000; // 1 Nov 2026: with map_rules at 36,000, room for the methods to grow

const between = (text, name) => {
  const m = new RegExp(`<!-- ${name}:start -->\\n?([\\s\\S]*?)\\n?<!-- ${name}:end -->`).exec(text);
  return m ? m[1].trim() : null;
};

/** A SKILL.md's body for Claude: no front matter, no markers (pure). */
export function skillBody(text) {
  return String(text || '').replace(/^---\n[\s\S]*?\n---\n/, '').replace(/<!-- [a-z:-]+ -->\n?/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// {card, text, version, problems[]} from a SKILL.md text (pure, for the tests).
export function methodFrom(text) {
  const problems = [];
  const card = between(text, 'method-card');
  const body = skillBody(text);
  if (card == null) problems.push('SKILL.md has no <!-- method-card:start/end --> markers.');
  if (card && card.length > METHOD_CARD_MAX) problems.push(`METHOD_CARD is ${card.length} characters; the limit is ${METHOD_CARD_MAX}.`);
  if (/<!--/.test(body)) problems.push('The method has an unmatched marker.');
  if (body.length > METHOD_TEXT_MAX) problems.push(`The method is ${body.length} characters; the limit is ${METHOD_TEXT_MAX}.`);
  return { card: card || '', text: body, version: fnv1a(text), problems };
}

const METHOD = methodFrom(SKILL_MD);
export const METHOD_CARD = METHOD.card;
export const METHOD_TEXT = METHOD.text;
export const METHOD_VERSION = METHOD.version;
export const METHOD_PROBLEMS = METHOD.problems;

// What teach_next sends as `method`.
export const methodBlock = () => ({ version: METHOD_VERSION, text: METHOD_CARD });
// What map_rules {part: 'teach_method'} sends.
export const methodText = () => ({ version: METHOD_VERSION, text: METHOD_TEXT });
