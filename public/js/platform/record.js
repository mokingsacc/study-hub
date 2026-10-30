// "Record my thinking" (Exams and practice papers): one big button. Press it, talk through how you are thinking about
// the question, press Stop. The clip goes to POST /api/p/papers/:id/thinking, is turned into words (Workers AI
// Whisper) and kept with the question; the sound itself is not kept. Their Claude reads the words with thinking_get
// when they say "analyse my thinking".
import { post } from './api.js';
import { h, icon, toast, addIcons } from './kit.js';

addIcons({
  mic: 'r:9 3.5 6 11 3|p:M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3',
  stop: 'r:6.5 6.5 11 11 2',
});

const MAX_SECS = 10 * 60;
const pickMime = () => {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  return '';
};
export const canRecord = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * The button. paperId: the paper; question(): {n, label} the recording is about (or null for the whole paper);
 * onSaved(recording): after the words are saved.
 */
export function recordButton({ paperId, question, onSaved = () => {} }) {
  const label = h('span', null, 'Record my thinking');
  const dot = h('span', { class: 'rec-dot', 'aria-hidden': 'true' });
  const b = h('button', { type: 'button', class: 'btn btn-record', 'aria-pressed': 'false' }, dot, icon('mic'), label);
  const note = h('span', { class: 'foot rec-note', 'aria-live': 'polite' });
  const box = h('div', { class: 'rec' }, b, note);
  let rec = null, stream = null, chunks = [], started = 0, tick = 0, about = null, busy = false;

  const idle = text => {
    b.setAttribute('aria-pressed', 'false'); box.classList.remove('on');
    b.replaceChildren(dot, icon('mic'), label);
    b.disabled = false;
    if (text != null) note.textContent = text;
  };
  const stopTracks = () => { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; };

  async function start() {
    if (!canRecord()) { toast('This browser cannot record. Try Safari or Chrome.'); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } }); }
    catch (e) {
      note.textContent = e && e.name === 'NotAllowedError'
        ? 'The microphone is blocked. Allow it for this site in your browser settings, then try again.'
        : 'No microphone was found.';
      return;
    }
    const mime = pickMime();
    try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined); }
    catch { rec = new MediaRecorder(stream); }
    chunks = [];
    about = question ? question() : null;
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = send;
    rec.start(1000);
    started = Date.now();
    b.setAttribute('aria-pressed', 'true'); box.classList.add('on');
    const lab = h('span', null, 'Stop · 0:00');
    b.replaceChildren(dot, icon('stop'), lab);
    note.textContent = about ? `Talk through how you are thinking about question ${about.label}. Say it out loud as you go.` : 'Talk through your thinking out loud as you go.';
    tick = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      lab.textContent = `Stop · ${clock(s)}`;
      if (s >= MAX_SECS) stop();
    }, 500);
  }

  function stop() {
    clearInterval(tick);
    if (rec && rec.state !== 'inactive') rec.stop();
    stopTracks();
  }

  async function send() {
    const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
    const type = (rec && rec.mimeType) || 'audio/webm';
    rec = null;
    b.disabled = true;
    b.replaceChildren(icon('mic'), h('span', null, 'Turning it into words…'));
    try {
      const form = new FormData();
      form.append('audio', new Blob(chunks, { type }), /mp4/.test(type) ? 'thinking.m4a' : 'thinking.webm');
      if (about) form.append('n', String(about.n));
      form.append('secs', String(secs));
      const r = await post(`/api/p/papers/${encodeURIComponent(paperId)}/thinking`, form);
      if (!r.saved) { idle(r.message || 'Nothing was heard. Try again.'); return; }
      idle(`Saved${about ? ` with question ${about.label}` : ''}. When you are ready, ask your Claude: "Analyse my thinking."`);
      onSaved(r.recording);
    } catch (e) { idle(e.message); toast(e.message); }
    chunks = [];
  }

  b.addEventListener('click', () => {
    if (busy) return;
    busy = true; setTimeout(() => { busy = false; }, 400);
    if (rec && rec.state === 'recording') stop(); else start();
  });
  box.stop = () => { if (rec && rec.state === 'recording') stop(); else stopTracks(); };
  return box;
}
