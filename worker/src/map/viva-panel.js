import { HttpError, json } from '../util.js';
import { toBase64, audioType, runModels, noteClip, NOVA_MODEL } from '../transcribe.js';
import { addUsage, reserveSpend, hardCap } from '../db.js';
import { startPanelViva, panelVivaState, readViva } from './viva.js';
import { noteJob } from '../job-log.js';

export const PANEL_VIVA = { max_bytes: 3_000_000, min_bytes: 100, max_s: 200, keyterms: 8 };
const NOVA_USD_PER_MIN = 0.0052;
const noTable = e => /no such table|no such column/i.test(String(e && e.message));

/** The keyterm prompt for the clip (pure): the topic's other names first and its own name last, so keytermsFor (which
 * reads the list backwards) puts the name first. "Terms: alias2, alias1, name." */
export function keytermPrompt(name, aliases = []) {
  const tidy = s => String(s || '').replace(/[,.:]/g, ' ').replace(/\s+/g, ' ').trim();
  const list = [...new Set(aliases.map(tidy).filter(a => a && a.length <= 60 && a.toLowerCase() !== tidy(name).toLowerCase()))].slice(0, PANEL_VIVA.keyterms - 1);
  return `Terms: ${[...list.reverse(), tidy(name)].filter(Boolean).join(', ')}.`;
}

async function topicFor(env, user, id) {
  const t = await env.DB.prepare(`SELECT id, name, kind, status, merged_into FROM topics WHERE user_id = ? AND id = ?`).bind(user, id).first();
  if (!t || t.status === 'retired') return null;
  if (t.status === 'merged' && t.merged_into) return topicFor(env, user, t.merged_into);
  const aliases = ((await env.DB.prepare(`SELECT alias FROM topic_aliases WHERE user_id = ? AND topic_id = ? AND status = 'active' ORDER BY length(alias) LIMIT 12`)
    .bind(user, t.id).all()).results || []).map(r => r.alias);
  return { ...t, aliases };
}

/** The grader under waitUntil (viva-job.js, loaded only here: it calls the examiner). Tests pass their own. */
let grader = async (env, user, id) => (await import('./viva-job.js')).gradeNow(env, user, id);
export function _setGrader(fn) { const prev = grader; grader = fn; return () => { grader = prev; }; }

// POST /api/map/topic/:id/viva (multipart: audio): transcribe, keep, grade in the background.
export async function vivaUploadRoute(request, env, ctx, params, url, user) {
  const topic = await topicFor(env, user, decodeURIComponent(String(params.id || '')));
  if (!topic) return json({ error: 'That topic is not on the map.' }, 404);
  let form;
  try { form = await request.formData(); } catch { throw new HttpError(400, 'Please send the recording as a form upload.'); }
  const audio = form.get('audio');
  if (!audio || typeof audio === 'string') throw new HttpError(400, 'The recording is missing.');
  if (audio.size > PANEL_VIVA.max_bytes) throw new HttpError(413, 'That recording is too long: keep a viva under three minutes.');
  if (audio.size < PANEL_VIVA.min_bytes) return json({ error: 'Nothing was recorded. Check the microphone and try again.' }, 422);
  if (!env.AI) throw new HttpError(503, 'Transcription is not set up on this hub.');
  const now = Date.now();
  const release = await reserveSpend(env, Math.max(0.001, (audio.size / 4000 / 60) * NOVA_USD_PER_MIN * 2), hardCap(env), { monthly: false });
  const body = toBase64(new Uint8Array(await audio.arrayBuffer()));
  const r = await runModels(env, { body, contentType: audioType(audio), prompt: keytermPrompt(topic.name, topic.aliases), clip: 0 });
  await noteClip(env, 'viva', r, now);
  if (!r) {
    await release(0);
    return json({ error: "The transcription service didn't answer. Try the viva again in a minute." }, 502);
  }
  await addUsage(env, { whisper: r.seconds });
  await release((r.seconds / 60) * r.usdPerMin);
  const text = String(r.text || '').trim();
  if (!text) return json({ error: "Nothing was heard in the recording. Speak a little closer to the microphone and try again." }, 422);
  let started;
  try { started = await startPanelViva(env, user, topic, text, { now }); } catch (e) {
    if (noTable(e)) return json({ error: 'The viva arrives with migration 0059.' }, 503);
    await noteJob(env, { job: 'viva', user, key: `viva:panel:${now}`, ref: 'panel', state: 'failed', detail: e, at: now, counts: { kind: 'graded' } });
    throw e;
  }
  if (started.refused) return json({ error: started.reason }, 422);
  const run = grader(env, user, started.id).catch(e => { console.error('panel viva grade failed', e && e.message); return null; });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(run); else await run;
  return json({ id: started.id, status: 'grading', words: text.split(/\s+/).length, model: r.model === NOVA_MODEL ? 'nova-3' : 'whisper', heard: r.kind }, 202);
}

// GET /api/map/topic/:id/viva/:viva_id: the panel's poll while it is graded.
export async function vivaStatusRoute(request, env, ctx, params, url, user) {
  const id = String(params.viva_id || '');
  if (!/^A[0-9a-f]{20}$/.test(id)) return json({ error: 'Which viva?' }, 400);
  const v = await readViva(env, user, id);
  if (!v) return json({ error: 'No viva has that id.' }, 404);
  return json(panelVivaState(v));
}
