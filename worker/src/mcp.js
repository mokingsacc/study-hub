import { currentUser } from './users.js';
import { HttpError } from './util.js';
import { Refusal } from './map/guard.js';
import { latestSeq } from './map/events.js';
import { kickAnkiPull } from './map/sync.js';
import { TOOLS, INSTRUCTIONS, toolByName, listTools } from './mcp/registry.js';
import { checkArgs } from './mcp/args.js';
import { legacy, jsonResult, londonStamp } from './mcp/reply.js';
import { NOTES_SERVER } from './mcp/notes-registry.js';

export const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'step2-practice-hub', version: '2.0.0' };
const enc = new TextEncoder();
export { INSTRUCTIONS, TOOLS };

// A server this transport answers for: the hub's connector, and (I30) the Notes connector on its own address, which
// answers only while NOTES = "on". Each has its token prefix, info, instructions and tools; kick: the Anki nudge.
export const MAIN_SERVER = { prefix: 'practice-hub-connector:', info: SERVER_INFO, instructions: INSTRUCTIONS, toolByName, listTools, kick: true };
const SERVERS = [MAIN_SERVER, NOTES_SERVER];

export async function connectorToken(hubKey, server = MAIN_SERVER) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(`${server.prefix}${hubKey}`));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

async function tokenOk(given, hubKey, server = MAIN_SERVER) {
  if (!given || !hubKey) return false;
  const want = await connectorToken(hubKey, server);
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(want))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// The Anki pull nudge and the map version read, swappable in tests.
const io = { kick: (env, ctx) => kickAnkiPull(env, ctx, 'mcp'), latestSeq: (env, user) => latestSeq(env, user) };
export function _setIo(over) {
  const prev = { ...io };
  Object.assign(io, over);
  return () => Object.assign(io, prev);
}

const result = (id, r) => ({ jsonrpc: '2.0', id, result: r });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// A failure inside a tool, as a payload: the guard's refusals and 4xx answers are said plainly, anything else is logged.
// The database's own words (D1_ERROR, SQLITE_..., a constraint) never reach Claude: they say nothing it can act on (B4-1).
const DB_RAW = /D1_ERROR|SQLITE_|constraint failed|no such (?:table|column)/i;
export function failure(name, e) {
  if (e instanceof Refusal || (e instanceof HttpError && e.status < 500)) return { refused: true, reason: e.message };
  console.error('connector tool failed', name, e && e.message);
  const msg = e && e.message ? String(e.message) : 'unknown error';
  if (/UNIQUE constraint failed/i.test(msg)) return { error: 'The hub could not save that: it clashed with another change made at the same moment. Call it once more.' };
  if (DB_RAW.test(msg)) return { error: "The hub's database could not do that just now. Call it once more; if it fails again, tell Mo the hub had a database error." };
  return { error: `The hub could not do that: ${msg}` };
}

/** One tools/call: the argument check, the tool, then (for the new tools) the JSON envelope with as_of_seq. */
export async function callTool(env, user, name, args, ctx = {}, server = MAIN_SERVER) {
  const tool = server.toolByName(name);
  if (!tool) return legacy({ error: `Unknown tool ${name}` }, null, true);
  // The 12 original tools keep their own (lenient) checks, as before the split; every new tool is checked here.
  const problems = tool.legacy ? [] : checkArgs(tool.inputSchema, args, { unknownOk: !!tool.unknownOk });
  if (problems.length) return jsonResult({ problems, next_step: `Fix these and call ${name} again.` }, { cap: tool.cap });
  // A tool that builds its own MCP result (notes_see's picture), after the same argument check.
  if (tool.raw) { try { return await tool.run(env, user, args, ctx); } catch (e) { const f = failure(name, e); return legacy(f, f.reason || f.error, true); } }
  const runCtx = {
    surface: typeof args.surface === 'string' ? args.surface : 'chat', via: `mcp:${name}`, request_id: ctx.request_id || null,
    ...(ctx.waitUntil ? { waitUntil: ctx.waitUntil } : {}),
  };
  if (tool.legacy) {
    try { return await tool.run(env, user, args, runCtx); } catch (e) {
      const f = failure(name, e);
      return legacy(f, f.reason || f.error, true);
    }
  }
  let payload;
  try { payload = await tool.run(env, user, args, runCtx); } catch (e) { payload = failure(name, e); }
  if (!isObj(payload)) payload = { value: payload ?? null };
  let seq = Number.isInteger(payload.as_of_seq) ? payload.as_of_seq : Number.isInteger(payload.seq) ? payload.seq : null;
  if (seq == null) seq = await io.latestSeq(env, user).catch(() => null);
  const rest = { ...payload };
  delete rest.as_of_seq;
  delete rest.as_of;
  return jsonResult({ as_of_seq: seq, as_of: londonStamp(), ...rest }, { cap: tool.cap, trim: tool.trim || [], moreCall: tool.moreCall || null, args });
}

async function dispatch(env, msg, user, ctx, server = MAIN_SERVER) {
  if (!msg || typeof msg !== 'object') return error(null, -32600, 'Invalid request');
  const { method, id } = msg;
  const params = msg.params || {};
  if (id === undefined || id === null) return null; // a notification
  if (method === 'initialize') {
    const v = VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0];
    return result(id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: server.info, instructions: server.instructions });
  }
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') return result(id, { tools: server.listTools(env) });
  if (method === 'tools/call') {
    const args = params.arguments || {};
    if (typeof args !== 'object' || Array.isArray(args)) return error(id, -32602, 'arguments must be an object');
    const waitUntil = ctx && typeof ctx.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : null;
    // New Anki misses come across soon after any conversation turn (at most once every 15 s, in the background).
    if (waitUntil && server.kick) waitUntil(Promise.resolve().then(() => io.kick(env, ctx)).catch(() => {}));
    try {
      return result(id, await callTool(env, user, String(params.name || ''), args, { waitUntil, request_id: String(id) }, server));
    } catch (e) {
      const f = failure(String(params.name || ''), e);
      return result(id, legacy({ error: f.reason || f.error || 'The hub could not do that.' }, null, true));
    }
  }
  if (method === 'resources/list') return result(id, { resources: [] });
  if (method === 'resources/templates/list') return result(id, { resourceTemplates: [] });
  if (method === 'prompts/list') return result(id, { prompts: [] });
  return error(id, -32601, `Method not found: ${method}`);
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function handleMcp(request, env, url, ctx = null) {
  const token = url.pathname.replace(/^\/mcp\/?/, '').replace(/\/+$/, '');
  let server = null;
  for (const s of SERVERS) if ((!s.enabled || s.enabled(env)) && (await tokenOk(token, env.HUB_KEY, s))) { server = s; break; }
  if (!server) return new Response('Not found', { status: 404 });
  if (request.method === 'GET') return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE' } });
  if (request.method === 'DELETE') return new Response(null, { status: 200 });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE' } });
  let body;
  try { body = await request.json(); } catch { return jsonResponse(error(null, -32700, 'Parse error'), 400); }
  const user = await currentUser(env, request);
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(m => dispatch(env, m, user, ctx, server)))).filter(Boolean);
    return out.length ? jsonResponse(out) : new Response(null, { status: 202 });
  }
  const r = await dispatch(env, body, user, ctx, server);
  return r ? jsonResponse(r) : new Response(null, { status: 202 });
}
