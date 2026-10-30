import { HttpError, json } from './util.js';
import { reserveSpend, hardCap } from './db.js';

export const LISTEN_PATH = '/api/cards/listen';
export const MODEL = '@cf/deepgram/nova-3';
export const SAMPLE_RATE = 16000;
export const KEYTERMS = ['again', 'hard', 'good', 'easy', 'show', 'flip', 'bury', 'skip', 'undo', 'exam'];
export const IDLE_MS = 2 * 60_000, MAX_MS = 30 * 60_000, TICKET_MS = 60_000;
const MAX_FRAME = 64 * 1024;          // one message of audio (the page sends 40 ms, 1280 bytes)
const KEEPALIVE_MS = 5000;            // Deepgram closes a stream after about 10 s without audio
const BYTES_PER_MIN = SAMPLE_RATE * 2 * 60;

const text = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** Nova-3: is_final pieces add up to a turn; speech_final (endpointing) or UtteranceEnd finishes it. */
export function novaTurns() {
  let parts = [], turn = 0, lastEnd = null;
  const sofar = () => text(parts.join(' '));
  const finish = (by, audioEnd) => {
    const t = sofar();
    parts = [];
    if (!t) return [];
    const out = { type: 'turn', turn: turn++, text: t, speech_end: lastEnd, audio_end: audioEnd, by };
    lastEnd = null;
    return [out];
  };
  return m => {
    if (m.type === 'Results') {
      const alt = (m.channel && Array.isArray(m.channel.alternatives) && m.channel.alternatives[0]) || {};
      const t = text(alt.transcript);
      const words = Array.isArray(alt.words) ? alt.words : [];
      const audioEnd = (Number(m.start) || 0) + (Number(m.duration) || 0);
      if (!m.is_final) return t ? [{ type: 'words', turn, text: text(`${sofar()} ${t}`) }] : [];
      if (t) {
        parts.push(t);
        const end = words.length ? Number(words[words.length - 1].end) : NaN;
        if (Number.isFinite(end)) lastEnd = end;
      }
      if (m.speech_final) return finish('speech_final', audioEnd);
      return t ? [{ type: 'words', turn, text: sofar() }] : [];
    }
    if (m.type === 'UtteranceEnd') return finish('utterance_end', Number(m.last_word_end) || null);
    if (m.type === 'Error' || m.err_msg || m.error) return [{ type: 'error', message: text(m.description || m.err_msg || m.message || m.error).slice(0, 200) }];
    return [];
  };
}

/** Flux: its own turn events, passed on as they are. */
export function fluxTurns() {
  return m => {
    if (!m.event) return m.type === 'Error' ? [{ type: 'error', message: text(m.description || m.message).slice(0, 200) }] : [];
    const base = { turn: Number(m.turn_index) || 0, text: text(m.transcript) };
    if (m.event === 'EndOfTurn') return [{ type: 'turn', ...base, speech_end: null, audio_end: Number(m.audio_window_end) || null, by: 'end_of_turn' }];
    if (m.event === 'EagerEndOfTurn') return [{ type: 'turn', ...base, speech_end: null, audio_end: Number(m.audio_window_end) || null, by: 'eager', eager: true }];
    if (m.event === 'TurnResumed') return [{ type: 'resumed', turn: base.turn }];
    return base.text ? [{ type: 'words', ...base }] : [];
  };
}

// Each model's parameters, best first: the binding is asked again with the next set if it refuses one (an option
// it does not know), so the stream always opens. Every value is text, as in Cloudflare's own example (they become
// the stream's query string): the live binding answered 400 to numbers and true/false (26 Oct 2026), while the same
// settings as text were accepted (tested against the model's REST socket: the turn ended 0.3-0.45 s after the audio).
// utterance_end_ms is Deepgram's milliseconds; keyterm goes as a list, one boosted term each, then without it.
const NOVA_BASE = { encoding: 'linear16', sample_rate: String(SAMPLE_RATE), channels: '1', interim_results: 'true', endpointing: '300', punctuate: 'true', smart_format: 'false' };
export const MODELS = {
  '@cf/deepgram/nova-3': {
    usdPerMin: 0.0092,
    params: [{ ...NOVA_BASE, keyterm: KEYTERMS, vad_events: 'true', utterance_end_ms: '1000' }, { ...NOVA_BASE, vad_events: 'true', utterance_end_ms: '1000' }, NOVA_BASE,
      { encoding: 'linear16', sample_rate: String(SAMPLE_RATE), interim_results: 'true', endpointing: '300' }],
    turns: novaTurns,
  },
  '@cf/deepgram/flux': {
    usdPerMin: 0.0077,
    params: [{ encoding: 'linear16', sample_rate: String(SAMPLE_RATE), eot_threshold: '0.7', eager_eot_threshold: '0.5', eot_timeout_ms: '3000' }],
    turns: fluxTurns,
  },
};

// ------------------------------------------------------------------ the ticket
const enc = new TextEncoder();
async function mac(env, textIn) {
  const k = await crypto.subtle.digest('SHA-256', enc.encode('practice-hub-cards-listen:' + env.HUB_KEY));
  const key = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(textIn)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}
export async function makeTicket(env, now = Date.now()) {
  const exp = (now + TICKET_MS).toString(36);
  return `${exp}.${await mac(env, `listen|${exp}`)}`;
}
export async function ticketOk(ticket, env, now = Date.now()) {
  const m = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{32})$/.exec(String(ticket || ''));
  if (!m || !env.HUB_KEY || parseInt(m[1], 36) < now) return false;
  const want = await mac(env, `listen|${m[1]}`);
  let diff = want.length ^ m[2].length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0;
}

// POST /api/cards/listen
export async function ticket(request, env) {
  if (!env.AI || !env.HUB_KEY) throw new HttpError(503, 'Voice commands are not set up on this hub.');
  return json({ path: LISTEN_PATH, ticket: await makeTicket(env), model: MODEL, sample_rate: SAMPLE_RATE, max_ms: MAX_MS });
}

// GET /api/cards/listen?ticket=... (Upgrade: websocket)
export async function socket(request, env, ctx, params, url) {
  if (!(await ticketOk(url.searchParams.get('ticket'), env))) throw new HttpError(401, 'This listening link has expired; the page asks for a new one.');
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') throw new HttpError(426, 'Expected a WebSocket.');
  if (!env.AI) throw new HttpError(503, 'Voice commands are not set up on this hub.');
  const spec = MODELS[MODEL];
  const release = await reserveSpend(env, (MAX_MS / 60_000) * spec.usdPerMin, hardCap(env), { monthly: false });
  let model;
  try { model = await openModel(env, spec); } catch (e) {
    await release(0).catch(() => {});
    throw new HttpError(502, 'The speech service did not answer. Ratings by voice are paused; the buttons and keys still work.');
  }
  const pair = new WebSocketPair();
  const page = pair[1];
  page.accept();
  bridge(page, model, { spec, release, ctx });
  return new Response(null, { status: 101, webSocket: pair[0] });
}

export async function openModel(env, spec, name = MODEL) {
  let last = null;
  for (const params of spec.params) {
    try {
      const res = await env.AI.run(name, params, { websocket: true });
      const ws = res && res.webSocket;
      if (!ws) throw new Error(`no WebSocket from the model (status ${res && res.status})`);
      ws.accept();
      return ws;
    } catch (e) {
      last = e;
      console.error('listen: the model refused', name, Object.keys(params).join(','), e && e.message);
    }
  }
  throw last || new Error('no parameters');
}

// Audio (an ArrayBuffer) and text go as they are; a message object as JSON.
const send = (ws, msg) => {
  try { ws.send(typeof msg === 'string' || msg instanceof ArrayBuffer || ArrayBuffer.isView(msg) ? msg : JSON.stringify(msg)); return true; } catch (e) { return false; }
};

/**
 * Page <-> model. Audio (binary) goes to the model; the model's messages come back through the adapter; either side
 * closing, 2 minutes without audio or 30 minutes in all closes both and settles the spend. opts.timers is for tests.
 */
export function bridge(page, model, { spec, release, ctx = null, now = Date.now, idleMs = IDLE_MS, maxMs = MAX_MS, timers = globalThis }) {
  let lastAudio = now(), bytes = 0, closed = false, queue = Promise.resolve();
  const turns = spec.turns();
  const end = (code, reason) => {
    if (closed) return;
    closed = true;
    timers.clearInterval(beat);
    timers.clearTimeout(cap);
    send(model, { type: 'CloseStream' });
    try { model.close(1000, 'done'); } catch (e) { /* already closed */ }
    send(page, { type: 'closing', reason });
    try { page.close(code, reason); } catch (e) { /* already closed */ }
    const p = Promise.resolve(release((bytes / BYTES_PER_MIN) * spec.usdPerMin)).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  };
  page.addEventListener('message', e => {
    if (closed) return;
    if (typeof e.data === 'string') {
      if (e.data === 'ping') send(page, 'pong');
      else if (e.data === 'close') end(1000, 'done');
      return;
    }
    const data = e.data;
    const n = data ? data.byteLength || data.size || 0 : 0;
    if (!n || n > MAX_FRAME) return;
    bytes += n;
    lastAudio = now();
    // A frame may come as a Blob (wrangler dev does that): read in turn, so the audio stays in order.
    if (typeof data.arrayBuffer === 'function' && !(data instanceof ArrayBuffer)) {
      queue = queue.then(() => data.arrayBuffer()).then(buf => { if (!closed && !send(model, buf)) end(4002, 'model gone'); }, () => {});
    } else queue = queue.then(() => { if (!closed && !send(model, data)) end(4002, 'model gone'); });
  });
  page.addEventListener('close', () => end(1000, 'page closed'));
  page.addEventListener('error', () => end(1000, 'page error'));
  model.addEventListener('message', e => {
    if (closed || typeof e.data !== 'string') return;
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    for (const out of turns(m || {})) send(page, out);
  });
  model.addEventListener('close', () => end(4002, 'model closed'));
  model.addEventListener('error', () => end(4002, 'model error'));
  const beat = timers.setInterval(() => {
    const quiet = now() - lastAudio;
    if (quiet >= idleMs) end(4000, 'idle');
    else if (quiet >= KEEPALIVE_MS) send(model, { type: 'KeepAlive' });
  }, Math.min(KEEPALIVE_MS, idleMs));
  const cap = timers.setTimeout(() => end(4001, 'session cap'), maxMs);
  send(page, { type: 'ready', model: MODEL, sample_rate: SAMPLE_RATE });
  return { end, get bytes() { return bytes; } };
}
