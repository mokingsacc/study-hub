// One source for the teaching method (plan §2.10): the step2-teach SKILL.md in the repo. Every teach_next brief
// carries METHOD_CARD, so voice and any app where the skill did not load still teach the current way, and
// map_rules {part: 'teach_method'} serves METHOD_DIGEST to a chat without the skill.
//
// The text comes from teach-method-text.js, which scripts/skill-zip.sh generates from SKILL.md (node cannot
// import a .md file; the test fails when the two differ). Markers in SKILL.md:
//   <!-- method-card:start --> … <!-- method-card:end -->   the one-paragraph card (≤ 1,000 characters)
//   <!-- digest:start --> … <!-- digest:end -->             Probe through Voice, the digest
//   <!-- digest:skip:start --> … <!-- digest:skip:end -->   left out of the digest (Claude Code file paths, card fields)
import SKILL_MD from './teach-method-text.js';
import { fnv1a } from './teach-priority.js';

export const METHOD_CARD_MAX = 1000;
export const METHOD_DIGEST_MAX = 7000;

const between = (text, name) => {
  const m = new RegExp(`<!-- ${name}:start -->\\n?([\\s\\S]*?)\\n?<!-- ${name}:end -->`).exec(text);
  return m ? m[1].trim() : null;
};

// {card, digest, version, problems[]} from a SKILL.md text (pure, for the tests).
export function methodFrom(text) {
  const problems = [];
  const card = between(text, 'method-card');
  let digest = between(text, 'digest');
  if (card == null) problems.push('SKILL.md has no <!-- method-card:start/end --> markers.');
  if (digest == null) problems.push('SKILL.md has no <!-- digest:start/end --> markers.');
  if (card && card.length > METHOD_CARD_MAX) problems.push(`METHOD_CARD is ${card.length} characters; the limit is ${METHOD_CARD_MAX}.`);
  if (digest != null) {
    digest = digest.replace(/<!-- digest:skip:start -->[\s\S]*?<!-- digest:skip:end -->\n?/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (/<!--/.test(digest)) problems.push('The digest has an unmatched marker.');
    if (digest.length > METHOD_DIGEST_MAX) problems.push(`METHOD_DIGEST is ${digest.length} characters; the limit is ${METHOD_DIGEST_MAX}.`);
  }
  return { card: card || '', digest: digest || '', version: fnv1a(text), problems };
}

const METHOD = methodFrom(SKILL_MD);
export const METHOD_CARD = METHOD.card;
export const METHOD_DIGEST = METHOD.digest;
export const METHOD_VERSION = METHOD.version;
export const METHOD_PROBLEMS = METHOD.problems;

// What teach_next sends as `method`.
export const methodBlock = () => ({ version: METHOD_VERSION, text: METHOD_CARD });
// What map_rules {part: 'teach_method'} sends.
export const methodDigest = () => ({ version: METHOD_VERSION, text: METHOD_DIGEST });
