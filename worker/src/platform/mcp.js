import { advertise } from '../mcp/registry.js';
import { HttpError, safeParse } from '../util.js';
import { userForConnector } from './auth.js';
import { safeEqual } from './crypto.js';
import * as features from './features.js';
import { SELF_CHECK_TOOL } from './selfcheck.js';
import { modulesFor } from './modules.js';
import { ADMIN_TOOLS, ADMIN_INSTRUCTIONS, adminToken } from './admin.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const INSTRUCTIONS = [
  "This is the student's own Study Hub (subjects, topics on a map, weak spots, cards, papers, library, results). Read it live with these tools, only about this student, never from memory.",
  '"gap: ..." means log_gap with their words; reply only "Logged."',
  '"Teach me" or "teach me X": teach_next once, follow its method, end with lesson_save.',
  'Never copy question-bank, past-paper or mark-scheme text into any field; write in your own words.',
  'A score they tell you: log_results. Photos cannot pass through a tool: give a library_upload_link. A photo of their working: read it and save it, mistakes included, with paper_mark.',
  'A past paper online: library_add_link, then exam_make. A practice paper: write original questions and a mark scheme, check every answer, then paper_make. Mark with them: paper_get, paper_mark (finish puts it on their map); offer cards from lost marks.',
  '"Analyse my thinking": thinking_get, then kind, specific feedback, saved with thinking_note if they want.',
  'Changing their hub when they ask: looks, Today, tabs and pages with my_hub_get then my_hub_change; parts with my_hub_parts; their own galaxies with galaxy_edit; subjects, boards, tiers and exam date with subject_edit; topics with add_topics, topic_edit, remove_topics; diagrams from their library onto a topic with topic_picture; cards with card_edit; mnemonics with mnemonic_edit. Say in one line what changed and that "undo that" works (undo_change; my_hub_undo for looks).',
  'New here, or "set up my Study Hub": setup_guide, then ask one thing at a time and save as you go. How to use the hub or revise a subject: hub_guide.',
  'Save what you cover as you go, without asking: chat_save (a short summary in your own words and its topics) at the end of a topic, when they finish and about every 15 messages, the same key for the whole chat. Before teaching or testing a topic, read chat_notes.',
].join(' ');

const result = (id, r) => ({ jsonrpc: '2.0', id, result: r });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const reply = (payload, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, ...(isError ? { isError: true } : {}) });

function checkNames(list) {
  const seen = new Set();
  for (const t of list) {
    if (seen.has(t.name)) throw new Error(`platform tool ${t.name} is defined twice`);
    seen.add(t.name);
  }
  return list;
}

export const listed = list => list.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema: advertise(inputSchema), ...(annotations ? { annotations } : {}) }));

export function tools() {
  return checkNames([SELF_CHECK_TOOL, ...features.tools()]);
}

// Tools of switched-off modules are hidden from tools/list and refused by tools/call.
const visible = (mods, t) => !t.module || [].concat(t.module).some(m => !!mods[m]);

async function call(env, who, toolset, name, args, ctx) {
  const tool = toolset.list.find(t => t.name === name);
  if (!tool) return reply({ error: `Unknown tool ${name}` }, true);
  if (!toolset.allowed(tool)) return reply({ refused: true, reason: 'That part of the hub is switched off. It can be turned on in Settings.' }, true);
  try {
    const payload = await tool.run(env, who, args || {}, ctx);
    if (payload && payload.__mcp) return payload.__mcp;   // a tool that answers with its own blocks (images)
    return reply(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload ?? null });
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return reply({ refused: true, reason: e.message }, true);
    console.error('platform tool failed', name, e && e.message);
    return reply({ error: 'The study hub could not do that just now. Try once more.' }, true);
  }
}

async function dispatch(env, msg, who, toolset, ctx) {
  if (!msg || typeof msg !== 'object') return error(null, -32600, 'Invalid request');
  const { method, id } = msg;
  const params = msg.params || {};
  if (id === undefined || id === null) return null;
  if (method === 'initialize') {
    const v = VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0];
    return result(id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: toolset.info, instructions: toolset.instructions });
  }
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') {
    return result(id, { tools: listed(toolset.list.filter(t => toolset.allowed(t))) });
  }
  if (method === 'tools/call') {
    const args = params.arguments || {};
    if (typeof args !== 'object' || Array.isArray(args)) return error(id, -32602, 'arguments must be an object');
    return result(id, await call(env, who, toolset, String(params.name || ''), args, ctx));
  }
  if (method === 'resources/list') return result(id, { resources: [] });
  if (method === 'resources/templates/list') return result(id, { resourceTemplates: [] });
  if (method === 'prompts/list') return result(id, { prompts: [] });
  return error(id, -32601, `Method not found: ${method}`);
}

async function serve(request, env, ctx, who, toolset) {
  if (request.method === 'DELETE') return new Response(null, { status: 200 });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE' } });
  let body;
  try { body = await request.json(); } catch { return jsonResponse(error(null, -32700, 'Parse error'), 400); }
  if (Array.isArray(body)) {
    if (body.length > 20) return jsonResponse(error(null, -32600, 'Too many requests in one batch'), 400);
    const out = (await Promise.all(body.map(m => dispatch(env, m, who, toolset, ctx)))).filter(Boolean);
    return out.length ? jsonResponse(out) : new Response(null, { status: 202 });
  }
  const r = await dispatch(env, body, who, toolset, ctx);
  return r ? jsonResponse(r) : new Response(null, { status: 202 });
}

// Tool context: waitUntil for background work and the site's origin (for links in replies).
const toolCtx = (ctx, url) => ({ waitUntil: ctx && typeof ctx.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : null, origin: url.origin });

export async function handlePlatformMcp(request, env, url, ctx = null) {
  if (url.pathname.startsWith('/mcp/admin/')) {
    const token = url.pathname.replace(/^\/mcp\/admin\/?/, '').replace(/\/+$/, '');
    if (!env.HUB_KEY || !(await safeEqual(token, await adminToken(env.HUB_KEY)))) return new Response('Not found', { status: 404 });
    return serve(request, env, toolCtx(ctx, url), 'mo',
      { list: checkNames(ADMIN_TOOLS), allowed: () => true, instructions: ADMIN_INSTRUCTIONS, info: { name: 'study-hub-admin', version: '1.0.0' } });
  }
  const token = url.pathname.replace(/^\/mcp\/u\/?/, '').replace(/\/+$/, '');
  const user = await userForConnector(env, token);
  if (!user) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare('SELECT profile, prefs_json FROM users WHERE id = ?').bind(user).first();
  const mods = modulesFor(row && row.profile, safeParse(row && row.prefs_json, {}), env);
  if (!mods.connector) return new Response('Not found', { status: 404 });
  return serve(request, env, toolCtx(ctx, url), user,
    { list: tools(), allowed: t => visible(mods, t), instructions: INSTRUCTIONS, info: { name: 'study-hub', version: '1.0.0' } });
}
