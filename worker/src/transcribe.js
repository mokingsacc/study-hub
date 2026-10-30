import { HttpError, json, readJson, int } from './util.js';
import { addUsage, getBlock, getSitting, getQuestion, run, reserveSpend, hardCap } from './db.js';
import { buildLeakIndex } from './checks.js';
import { releasable } from './map/ingest/map-fields.js';
import { saveCues } from './gaps.js';
import { spokenPrompt, keytermsFor } from '../../public/js/exam/glossary.js';
import { noteJob } from './job-log.js';

export const NOVA_MODEL = '@cf/deepgram/nova-3';
export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const NOVA_USD_PER_MIN = 0.0052; // Workers AI price per audio minute over HTTP
const WHISPER_USD_PER_MIN = 0.000513;
const UTT_SPLIT_S = 0.8; // a pause this long ends a segment
const MAX_AUDIO = 8_000_000; // about 33 minutes at 32 kbps; a clip is one question
const MIC_TEST_GAP_MS = 10_000;
const MIC_TEST = 'mic-test';
const UWORLD = 'uworld';
// The Spoken reasoning add-on (desktop Anki): the same, its sessions are saved with PUT /api/anki-sessions.
const ANKI = 'anki';
const FLAG_TYPES = ['answer_change', 'override_out_of_range', 'mic_gap', 'unknown_clip'];

export function toBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function transcribe(request, env) {
  let form;
  try { form = await request.formData(); } catch { throw new HttpError(400, 'Please send the clip as a form upload.'); }
  const blockId = String(form.get('block_id') || '');
  if (!blockId) throw new HttpError(400, 'Please give the block for this clip.');
  const micTest = blockId === MIC_TEST; // setup mic check: transcribe and log usage, write no rows
  const uworld = blockId === UWORLD || blockId === ANKI;
  const qIndex = int(form.get('q_index'), 'Question index', { min: micTest || uworld ? -1 : 0, optional: false });
  const clipN = int(form.get('clip_n'), 'Clip number', { min: 0 });
  int(form.get('start'), 'Clip start', { min: 0 });
  const audio = form.get('audio');
  if (!audio || typeof audio === 'string') throw new HttpError(400, 'The audio file is missing.');
  if (audio.size > MAX_AUDIO) throw new HttpError(413, 'That clip is too long to transcribe in one go.');
  if (audio.size < 100) return json({ text: '', segments: [] });
  // A recorder that sends no spelling list (the Mac add-on) gets the balanced glossary for this clip.
  const prompt = String(form.get('prompt') || '').slice(0, 900) || (uworld ? spokenPrompt('', clipN || 0) : '');
  if (uworld) {
    // no rows, no rate limit: clips arrive about once a minute through a block
  } else if (!micTest) {
    const block = await getBlock(env, blockId);
    if (qIndex < block.q_from || qIndex > block.q_to) throw new HttpError(400, 'That question is not in this block.');
  } else {
    // One mic test per 10 s for the whole hub (claimed in one statement).
    const t = Date.now();
    const r = await run(env, `INSERT INTO settings (key, value) VALUES ('mic_test_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE CAST(settings.value AS INTEGER) <= ?`, String(t), t - MIC_TEST_GAP_MS);
    if (!r.meta || !r.meta.changes) throw new HttpError(429, 'Please wait a few seconds before testing the microphone again.');
  }
  const estUsd = Math.max(0.001, (audio.size / 4000 / 60) * NOVA_USD_PER_MIN * 2);
  const release = await reserveSpend(env, estUsd, hardCap(env), { monthly: false });

  const body = toBase64(new Uint8Array(await audio.arrayBuffer()));
  const r = await runModels(env, { body, contentType: audioType(audio), prompt, clip: clipN || 0 });
  // One Recent activity line a recording (clips less than 20 minutes apart), saying which model heard each clip.
  if (!micTest) await noteClip(env, blockId === UWORLD ? 'uworld' : blockId === ANKI ? 'anki' : 'exam', r);
  if (!r) {
    await release(0);
    throw new HttpError(502, 'The transcription service did not answer. The clip is kept; it will be tried again.');
  }
  await addUsage(env, { whisper: r.seconds }); // the usage column counts every model's transcribed seconds
  await release((r.seconds / 60) * r.usdPerMin);
  return json({ text: r.text, segments: r.segments, model: r.model });
}

// The clip's type for Nova-3 (the upload's own, else from its name): WebM/Opus from Chrome, MP4 from Safari, mp3 from the Mac.
export function audioType(audio) {
  const t = String((audio && audio.type) || '').split(';')[0].trim().toLowerCase();
  if (/^audio\/|^video\//.test(t)) return t.replace(/^video\//, 'audio/');
  const name = String((audio && audio.name) || '').toLowerCase();
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  if (name.endsWith('.m4a') || name.endsWith('.mp4')) return 'audio/mp4';
  if (name.endsWith('.wav')) return 'audio/wav';
  if (name.endsWith('.ogg')) return 'audio/ogg';
  return 'audio/webm';
}

const NOVA_BASE = { language: 'en', punctuate: true, smart_format: true, utterances: true, utt_split: UTT_SPLIT_S };
/** The attempts, best first: Nova-3 medical with keyterms, medical alone, plain Nova-3, then Whisper with the prompt. */
export function attempts({ body, contentType, prompt, clip }) {
  const audio = { body, contentType };
  const keyterm = keytermsFor(prompt, clip);
  const whisper = { audio: body, task: 'transcribe', language: 'en', vad_filter: true, ...(prompt ? { initial_prompt: prompt } : {}) };
  return [
    { model: NOVA_MODEL, usdPerMin: NOVA_USD_PER_MIN, inputs: { audio, ...NOVA_BASE, mode: 'medical', ...(keyterm.length ? { keyterm } : {}) } },
    { model: NOVA_MODEL, usdPerMin: NOVA_USD_PER_MIN, inputs: { audio, ...NOVA_BASE, mode: 'medical' } },
    { model: NOVA_MODEL, usdPerMin: NOVA_USD_PER_MIN, inputs: { audio, ...NOVA_BASE } },
    { model: WHISPER_MODEL, usdPerMin: WHISPER_USD_PER_MIN, inputs: whisper },
  ];
}

export const clipCounts = r => ({ clips: 1, nova: r && r.step === 0 ? 1 : 0, plain: r && (r.step === 1 || r.step === 2) ? 1 : 0, whisper: r && r.step === 3 ? 1 : 0, failed: r ? 0 : 1 });
const noteClip = (env, ref, r, at = Date.now()) => noteJob(env, { job: 'transcribe', ref, key: `${ref}:${at}`, runMs: 20 * 60_000, add: true, at,
  state: !r ? 'failed' : r.step === 0 ? 'ok' : 'fallback', counts: clipCounts(r) });

async function runModels(env, clip) {
  for (const [step, a] of attempts(clip).entries()) {
    try {
      const out = await env.AI.run(a.model, a.inputs);
      const r = a.model === NOVA_MODEL ? fromNova(out) : fromWhisper(out);
      if (r) return { ...r, model: a.model, usdPerMin: a.usdPerMin, step };
    } catch (e) {
      console.error('transcription failed', a.model, a.inputs.mode || '', e && e.message);
    }
  }
  return null;
}

const seg = (start, end, text) => ({ start: Math.max(0, Number(start) || 0), end: Math.max(0, Number(end) || Number(start) || 0), text: String(text || '').trim() });

/** Whisper's answer as {text, segments, seconds}. */
export function fromWhisper(out) {
  if (!out || typeof out !== 'object') return null;
  const segments = (Array.isArray(out.segments) ? out.segments : []).map(s => seg(s.start, s.end, s.text)).filter(s => s.text);
  const info = out.transcription_info || {};
  const seconds = Number(info.duration) || (segments.length ? segments[segments.length - 1].end : 0);
  return { text: String(out.text || '').trim(), segments, seconds };
}

/**
 * Nova-3's answer (Deepgram's prerecorded shape, under result when the binding wraps it) as {text, segments, seconds}:
 * its utterances as the segments, else the paragraphs' sentences, else the words cut at pauses, else one segment.
 * null when the answer is not Deepgram's (the next attempt is tried).
 */
export function fromNova(raw) {
  const out = raw && raw.result && raw.result.results ? raw.result : raw;
  const results = out && out.results;
  if (!results || !Array.isArray(results.channels)) return null;
  const alt = (results.channels[0] && results.channels[0].alternatives && results.channels[0].alternatives[0]) || {};
  const words = Array.isArray(alt.words) ? alt.words : [];
  let segments = [];
  if (Array.isArray(results.utterances) && results.utterances.length) {
    segments = results.utterances.map(u => seg(u.start, u.end, u.transcript));
  } else if (alt.paragraphs && Array.isArray(alt.paragraphs.paragraphs)) {
    segments = alt.paragraphs.paragraphs.flatMap(p => (p.sentences || []).map(s => seg(s.start, s.end, s.text)));
  } else if (words.length) {
    let cur = null;
    for (const w of words) {
      const text = w.punctuated_word || w.word || '';
      if (cur && (Number(w.start) - cur.end > UTT_SPLIT_S || cur.n >= 40)) { segments.push(seg(cur.start, cur.end, cur.text)); cur = null; }
      if (!cur) cur = { start: Number(w.start) || 0, end: Number(w.end) || 0, text, n: 1 };
      else { cur.end = Number(w.end) || cur.end; cur.text += ` ${text}`; cur.n++; }
    }
    if (cur) segments.push(seg(cur.start, cur.end, cur.text));
  } else if (alt.transcript) {
    segments = [seg(0, 0, alt.transcript)];
  }
  segments = segments.filter(s => s.text);
  const meta = (out && out.metadata) || {};
  const last = words.length ? Number(words[words.length - 1].end) || 0 : segments.length ? segments[segments.length - 1].end : 0;
  return { text: String(alt.transcript || segments.map(s => s.text).join(' ')).trim(), segments, seconds: Number(meta.duration) || last };
}

export async function putTranscript(request, env) {
  const body = await readJson(request, 2_000_000);
  const blockId = String(body.block_id || '');
  if (!blockId) throw new HttpError(400, 'Please give the block for this transcript.');
  const qIndex = int(body.q_index, 'Question index', { min: 0, optional: false });
  if (!Array.isArray(body.segments)) throw new HttpError(400, 'segments must be a list.');
  const block = await getBlock(env, blockId);
  if (qIndex < block.q_from || qIndex > block.q_to) throw new HttpError(400, 'That question is not in this block.');
  const segments = body.segments.map(s => {
    const o = { start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').slice(0, 4000) };
    if (s.boundary) o.boundary = true;
    if (s.override) o.override = true;
    if (s.from != null) o.from = s.from;
    if (s.clip != null) o.clip = String(s.clip);
    return o;
  });
  const text = typeof body.text === 'string' ? body.text.slice(0, 100_000) : segments.map(s => s.text).join(' ');
  if (body.flags != null && !Array.isArray(body.flags)) throw new HttpError(400, 'flags must be a list.');
  const flags = (body.flags || []).filter(f => f && FLAG_TYPES.includes(f.type)).slice(0, 200).map(f => {
    const o = { type: f.type };
    for (const k of ['q', 't', 'from', 'to', 'n', 'items', 'v', 'clip']) if (f[k] != null) o[k] = typeof f[k] === 'object' ? String(f[k]) : f[k];
    if (f.text != null) o.text = String(f.text).slice(0, 500);
    return o;
  });
  await run(env,
    `INSERT INTO transcripts (block_id, q_index, segments_json, text, flags_json) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(block_id, q_index) DO UPDATE SET segments_json = excluded.segments_json, text = excluded.text, flags_json = excluded.flags_json`,
    blockId, qIndex, JSON.stringify(segments), text, JSON.stringify(flags));
  // "Gap, I don't get ..." said on this question: a gap tied to it. A cue that repeats the question's own words
  // is dropped (question text never leaves the hub), and the cues stay hidden until the sitting ends.
  const sitting = await getSitting(env, block.sitting_id);
  let leakIndex = null;
  if (sitting.exam_id) {
    try { leakIndex = buildLeakIndex(await getQuestion(env, sitting.exam_id, qIndex)); } catch { leakIndex = null; }
  }
  if (sitting.exam_id && !leakIndex) return json({ ok: true, cues: 0 }); // no question to check against: keep no cue
  await saveCues(env, segments, `tr:${blockId}:${qIndex}`, () => ({ ref: `block:${blockId}:q${qIndex}` }),
    { leakIndex, hold: releasable(sitting) ? null : { sitting_id: sitting.id } });
  return json({ ok: true });
}
