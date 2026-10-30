
import { spokenPrompt } from '../exam/glossary.js';

// Whisper's spelling list: these phrases, then every system's terms in turn, a different slice each clip (never card text).
const PROMPT_LEAD = 'Anki flashcard review, Step 2 CK. Again, hard, good, easy. Gap, I don\'t get. Lean between';
const ROTATE_IDLE_MS = 20 * 60_000;   // a pause this long starts a new session (the hub checks an idle one after 30 min)
const later = ms => new Promise(r => setTimeout(r, ms));

/** A segment's identity on both sides: its start and end in whole ms from the session start (the hub keeps only
 * scrubbed text, so the words themselves cannot be compared). worker/src/spoken.js uses this too. */
export const segmentKey = s => `${Math.round(s.start)}-${Math.round(Math.max(s.start, s.end))}`;

/** {segments, digest} of a list of segments: how many have words, and an FNV-1a hash of their keys in time order. The hub
 * answers each PUT with this for the segments it now holds of those sent, so the page can tell its words were taken. */
export function segmentsDigest(segments) {
  const keys = (segments || []).filter(s => String(s.text || '').trim()).map(s => [Math.round(s.start), Math.round(Math.max(s.start, s.end))])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([a, b]) => `${a}-${b}`);
  let h = 0x811c9dc5;
  for (const ch of keys.join(',')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return { segments: keys.length, digest: h.toString(16).padStart(8, '0') };
}

/** True when the hub's reply to a PUT proves it holds every segment the body carried. */
export function acknowledged(body, reply) {
  const a = reply && reply.accepted, mine = segmentsDigest(body.segments);
  return !!a && a.segments === mine.segments && a.digest === mine.digest;
}

/** The PUT /api/anki-sessions body for a session record: segment times are ms from started_at. */
export function sessionBody(rec) {
  const events = (rec.events || []).filter(e => e.card_id && e.shown && e.redo_of == null && !e.displaced).map(e => ({ card_id: e.card_id, note_id: (rec.notes || {})[e.card_id] || e.note_id || null,
    shown: e.shown, revealed: e.revealed || null, answered: e.answered || null,
    // Buried, suspended, superseded (Anki had a newer review) or never rated: no ease, so the check never makes it a gap.
    ease: e.buried || e.suspended || e.superseded ? null : e.ease || null }));
  const cards = {};
  for (const e of rec.events || []) if (e.card_id && !cards[e.card_id]) cards[e.card_id] = { front: e.question || '', back: e.answer || '', deck: e.deck || null };
  const segments = [...(rec.segments || [])].sort((a, b) => a.start - b.start).map(s => ({ start: Math.round(s.start), end: Math.round(s.end), text: s.text }));
  return { id: rec.id, device: rec.device, started_at: rec.started_at, ended_at: rec.ended_at || null, segments, events, cards };
}

export class Speech {
  /** deps: {api, store (cards/store.js), clips: {list, get, del}, blobOf(clip), now?, wait?, device, onChange?} */
  constructor(deps) {
    this.api = deps.api;
    this.store = deps.store;
    this.clips = deps.clips;
    this.blobOf = deps.blobOf;
    this.now = deps.now || (() => Date.now());
    this.wait = deps.wait || later;
    this.device = deps.device || 'hub';
    this.onChange = deps.onChange || (() => {});
    this.rec = null;           // the session being recorded now
    this.running = null;
    this.again = false;
    this.failed = 0;
    this.offline = false;
    this.waiting = 0;          // clips on this device whose words the hub does not have yet
  }

  /** A new session for this review (the recorder writes its clips under rec.id). */
  async begin(t0 = this.now()) {
    this.rec = { id: `${this.device}-${t0}`, device: this.device, started_at: t0, ended_at: null, events: [], segments: [], notes: {},
      transcribed: {}, confirmed: {}, failedClips: {}, mic: false, last: t0, sent_sig: null };
    await this.save(this.rec);
    return this.rec;
  }

  save(rec) { return this.store.put('sessions', rec).catch(() => {}); }

  /** The review's events (Review.events): saved now, sent to the hub in the background. */
  async noteEvents(events) {
    if (!this.rec) return;
    const from = this.rec.started_at;
    const list = events || [], onScreen = list[list.length - 1];
    events = list.filter(e => e.shown >= from || e.answered >= from || (e === onScreen && e.answered == null && !e.buried));
    const sig = JSON.stringify(events.map(e => [e.card_id, e.shown, e.revealed, e.answered, e.ease, e.buried, e.suspended, e.superseded, e.undone]));
    if (sig === this.eventsSig) return;
    this.eventsSig = sig;
    this.rec.events = events.map(e => ({ ...e }));
    this.rec.last = this.now();
    await this.save(this.rec);
    this.kick();
  }

  /** The recorder started on this session (so its words are worth sending). */
  async micOn() { if (this.rec && !this.rec.mic) { this.rec.mic = true; await this.save(this.rec); } }

  /** After a long pause: end this session and start another, so each is checked whole. Returns true when it rotated. */
  async rotateIfIdle() {
    if (!this.rec || this.now() - this.rec.last < ROTATE_IDLE_MS) return false;
    await this.finish(this.rec.last);
    await this.begin();
    return true;
  }

  /** The end of the review: the last PUT carries ended_at, then the hub is asked to check it. */
  async finish(endedAt = this.now()) {
    if (!this.rec) return;
    this.rec.ended_at = endedAt;
    await this.save(this.rec);
    this.rec = null;
    return this.kick();
  }

  /** Work through every stored session: transcribe its clips, PUT it, delete confirmed clips, finish ended ones. */
  kick() {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          const all = await this.store.all('sessions');
          let waiting = 0;
          for (const stored of all) {
            const rec = this.rec && this.rec.id === stored.id ? this.rec : stored;
            // A session from an earlier visit that never ended (the app was closed): it ends where it stopped.
            if (!rec.ended_at && (!this.rec || this.rec.id !== rec.id)) rec.ended_at = rec.last || rec.started_at;
            waiting += await this.syncOne(rec);
          }
          this.waiting = waiting;
          this.onChange(this);
        } while (this.again);
      } finally { this.running = null; }
    })();
    return this.running;
  }

  async syncOne(rec) {
    const clips = (await this.clips.list({ blockId: rec.id })).sort((a, b) => a.n - b.n);
    if (clips.length && !rec.mic) rec.mic = true;
    // 1. Words for each finished clip (the one still recording has no end yet), in order.
    for (const c of clips) {
      if (rec.transcribed[c.n] || rec.failedClips[c.n]) continue;
      // Still being recorded: only a closed clip, or any clip of a session from an earlier visit (the app was closed mid-clip).
      if (!c.closed && this.rec && this.rec.id === rec.id) continue;
      if (!c.end || c.end <= c.start) { rec.transcribed[c.n] = true; continue; }
      const r = await this.transcribe(rec, c);
      if (r === 'offline') { this.offline = true; await this.save(rec); return clips.length; }
    }
    this.offline = false;
    // 2. The session so far, when anything is new (and only when the mic was on: without speech there is nothing to check).
    if (rec.mic) {
      await this.fillNotes(rec);
      const body = sessionBody(rec);
      // Sent after every card (a card answered, buried or changed), and whenever new words arrive; a reveal alone waits.
      const sig = JSON.stringify([body.ended_at, body.events.map(e => [e.card_id, e.answered, e.ease]), body.segments.length]);
      if (sig !== rec.sent_sig) {
        try {
          const reply = await this.api.put('/api/anki-sessions', body);
          // Only words the hub proves it kept let their audio go; otherwise all of it stays and the next pass sends it again.
          if (!acknowledged(body, reply)) { await this.save(rec); return clips.length; }
          rec.sent_sig = sig;
          for (const n of Object.keys(rec.transcribed)) rec.confirmed[n] = true;
        } catch (e) {
          this.offline = !e.status;
          if (e.status && e.status < 500 && e.status !== 429) { this.failed++; rec.sent_sig = sig; }   // the hub refused this shape: not retried in a loop
          await this.save(rec);
          return clips.length;
        }
      }
    }
    // 3. Clips whose words the hub has confirmed leave the device.
    // A clip Whisper refused stays on the device (never deleted) but does not hold the session back.
    let left = 0;
    for (const c of clips) {
      if (rec.confirmed[c.n] || (!rec.mic && rec.transcribed[c.n])) await this.clips.del(c.id).catch(() => { left++; });
      else if (!rec.failedClips[c.n] && (c.closed || !this.rec || this.rec.id !== rec.id)) left++;   // the clip being recorded is not waiting
    }
    // 4. An ended session with nothing left: ask for the check (as the Mac add-on does) and forget it.
    if (rec.ended_at && !left) {
      if (rec.mic) await this.api.post(`/api/anki-sessions/${encodeURIComponent(rec.id)}/check`, {}).catch(() => {});
      await this.store.del('sessions', rec.id).catch(() => {});
      return 0;
    }
    await this.save(rec);
    return left;
  }

  async transcribe(rec, c) {
    const blob = this.blobOf(c);
    if (!blob || blob.size < 200) { rec.transcribed[c.n] = true; return 'ok'; }
    const fd = new FormData();
    fd.append('block_id', 'anki');
    fd.append('q_index', '-1');
    fd.append('clip_n', String(c.n));
    fd.append('start', String(Math.max(0, c.start - rec.started_at)));
    fd.append('prompt', spokenPrompt(PROMPT_LEAD, c.n));
    fd.append('audio', blob, `cards-${c.n}.${/mp4/.test(c.mime || '') ? 'm4a' : 'webm'}`);
    try {
      const r = await this.api.post('/api/transcribe', fd);
      let segs = (r && r.segments) || [];
      if (!segs.length && r && r.text && r.text.trim()) segs = [{ start: 0, end: (c.end - c.start) / 1000, text: r.text.trim() }];
      const base = c.start - rec.started_at;
      rec.segments.push(...segs.filter(s => String(s.text || '').trim())
        .map(s => ({ start: base + Number(s.start) * 1000, end: base + Number(s.end) * 1000, text: String(s.text).trim(), clip: c.n })));
      rec.transcribed[c.n] = true;
      await this.save(rec);
      return 'ok';
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429) { rec.failedClips[c.n] = e.message || String(e.status); this.failed++; return 'failed'; }   // kept on the device
      return 'offline';
    }
  }

  async fillNotes(rec) {
    const missing = [...new Set(rec.events.map(e => e.card_id))].filter(id => !(id in rec.notes));
    for (let i = 0; i < missing.length; i += 20) {
      const ids = missing.slice(i, i + 20);
      try {
        const r = await this.api.get(`/api/cards/notes?ids=${ids.join(',')}`);
        for (const id of ids) rec.notes[id] = (r.notes && r.notes[id]) || null;
      } catch (e) { return; }   // note ids are a nicety: the next PUT tries again
    }
  }
}
