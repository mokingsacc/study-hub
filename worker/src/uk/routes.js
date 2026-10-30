import { HttpError, json, readJson } from '../util.js';
import { applyChange, changeResponse } from '../map/change.js';
import * as store from './store.js';

export const ukOn = env => !!env && (env.UK === 'on' || env.UK === 'import');
function gate(env) { if (!ukOn(env)) throw new HttpError(404, 'There is nothing at that address.'); }
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);

// GET /api/uk/entries?kind=&category= -> {entries, counts: {kind: n}, demo, labs?}
// labs: {ecg, imaging} only with UK_LABS on (CONTRACT I34), so the page knows without touching state.features.
export const labsOn = env => ukOn(env) && env.UK_LABS === 'on';
export const labsRoutesOn = env => ukOn(env) && (env.UK_LABS === 'on' || env.UK_LABS === 'import');
export async function listRoute(request, env, ctx, params, url, user) {
  gate(env);
  const kind = url.searchParams.get('kind') || null;
  if (kind && !store.KINDS.includes(kind)) throw new HttpError(400, `kind is one of ${store.KINDS.join(', ')}.`);
  const out = await store.listEntries(env, user, { kind, category: url.searchParams.get('category') || null });
  if (labsOn(env)) out.labs = { ecg: true, imaging: true };
  return json(out);
}

// GET /api/uk/entries/:id -> {entry} with its tables and sources
export async function entryRoute(request, env, ctx, params, url, user) {
  gate(env);
  const entry = await store.getEntry(env, user, params.id);
  if (!entry) throw new HttpError(404, 'That UK entry is not on the hub.');
  return json({ entry });
}

// GET /api/uk/search?q= -> {hits: [{id, kind, category, title, demo, snippet}]}; snippet marks are \u0002 and \u0003.
export async function searchRoute(request, env, ctx, params, url, user) {
  gate(env);
  const q = (url.searchParams.get('q') || '').slice(0, 200);
  return json({ q, hits: await store.searchEntries(env, user, q) });
}

// POST /api/uk/entries/import {entries?, remove?, remove_demo?} -> applyChange's answer ({ok, batch_id, summary, counts})
// The go-live task and later "UK:" imports run in Claude Code with the hub key, so the actor is code. Demo entries
// are refused anywhere but a local dev server, so the live hub never holds one.
export async function importRoute(request, env, ctx, params, url, user) {
  gate(env);
  const body = await readJson(request, 1_000_000);
  if (Array.isArray(body.entries) && body.entries.some(e => e && e.demo === true) && !LOCAL.has(url.hostname)) {
    throw new HttpError(400, 'Demo entries are only for a local hub.');
  }
  return changeResponse(await applyChange(env, user, { actor: 'code', surface: 'code', op: 'uk.import', args: body, via: 'api:POST /api/uk/entries/import' }));
}
