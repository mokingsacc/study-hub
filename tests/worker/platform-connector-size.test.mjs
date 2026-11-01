import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tools, INSTRUCTIONS, listed as advertised } from '../../worker/src/platform/mcp.js';
import { LIST_MAX, DESCRIPTION_MAX } from '../../worker/src/mcp/registry.js';

const INSTRUCTIONS_MAX = 2_000;
const listed = () => advertised(tools());

test('tools/list, every description and the instructions stay inside the caps', () => {
  const size = JSON.stringify({ tools: listed() }).length;
  console.log(`platform tools/list: ${listed().length} tools, ${size} characters; instructions ${INSTRUCTIONS.length}`);
  assert.ok(size <= LIST_MAX, `tools/list is ${size} characters (cap ${LIST_MAX})`);
  for (const t of listed()) assert.ok(t.description.length <= DESCRIPTION_MAX, `${t.name}: ${t.description.length} characters`);
  assert.ok(INSTRUCTIONS.length <= INSTRUCTIONS_MAX, `instructions are ${INSTRUCTIONS.length} characters`);
});

test('tool names are unique, and every tool the instructions name exists', () => {
  const names = listed().map(t => t.name);
  assert.equal(new Set(names).size, names.length);
  const known = new Set(names);
  for (const m of INSTRUCTIONS.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) assert.ok(known.has(m[0]), `the instructions name ${m[0]}, which is not a tool`);
});
