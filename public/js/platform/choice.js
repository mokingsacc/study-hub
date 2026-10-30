import { get, post } from './api.js';
import { h, icon, dot } from './kit.js';
import { claudeHref, handOff, promptFor } from './teach.js';

const BAND_T = { strong: 100, good: 300, mixed: 500, weak: 700, very_weak: 900 };

/** The option's weakness as t1000: its own, its band's, or "weakness 76" in the reason; null when not seen yet. */
export function weaknessOf(o) {
  const t = o.topic || {};
  if (t.t1000 != null) return t.t1000;
  if (t.band && t.band in BAND_T) return BAND_T[t.band];
  const r = String(o.reason || '');
  if (/never seen|not seen/i.test(r)) return null;
  const m = /weakness (\d{1,3})/.exec(r);
  return m ? Math.min(1000, Number(m[1]) * 10) : null;
}

/** Paints today's choice into slot (hidden until there is one). today: GET /api/p/today's reply. */
export async function mount(slot, today) {
  // Today carries the choice (null when their Claude is not connected); an older Today without it asks once.
  let c = today && today.choice;
  if (c === null) return;
  if (!c) { try { c = await get('/api/p/today/choice'); } catch { return; } }
  const names = Object.fromEntries(((today && today.subjects) || []).map(x => [x.id, x.name]));
  draw(slot, c, names);
}

function draw(slot, c, names) {
  const opts = (c && c.ready !== false && c.state !== 'rest' ? c.options || [] : []).filter(o => o && o.topic && o.topic.id);
  slot.hidden = !opts.length;
  if (!opts.length) { slot.replaceChildren(); return; }
  const chosen = c.chosen && c.chosen.topic_id;
  const line = c.line || (opts.find(o => o.avoidance && o.avoidance.line) || { avoidance: {} }).avoidance.line;
  slot.replaceChildren(
    h('div', { class: 'tile-label' }, icon('teach'), chosen ? 'Today’s lesson' : 'Pick one to learn today', h('span', { class: 'aside' }, 'in Claude')),
    line ? h('p', { class: 'choice-line' }, icon('flag'), line) : null,
    h('div', { class: 'choice-opts' }, opts.map(o => {
      const prompt = o.prompt || promptFor(o.topic.name, o.topic.id);
      const on = chosen === o.topic.id;
      const sub = o.topic.subject_name || names[o.topic.category_id || o.topic.subject_id] || null;
      return h('a', { class: `choice-opt${chosen ? (on ? ' chosen' : ' dim') : ''}`, href: claudeHref(prompt), target: '_blank', rel: 'noopener noreferrer',
        'aria-label': `Teach me ${o.topic.name}${on ? ', chosen' : ''}`,
        onclick: () => {
          draw(slot, { ...c, state: 'chosen', chosen: { topic_id: o.topic.id, at: Date.now() } }, names);
          handOff(prompt, async () => {
            const r = await post('/api/p/today/choice/choose', { topic_id: o.topic.id }, { keepalive: true });
            if (r && r.today && slot.isConnected) draw(slot, r.today, names);
          });
        } },
      dot(weaknessOf(o), true),
      h('span', { class: 'grow' }, h('b', null, o.topic.name), sub ? h('span', { class: 'sub' }, sub) : null,
        o.reason ? h('span', { class: 'foot' }, o.reason) : null,
        o.avoidance && o.avoidance.line && o.avoidance.line !== line ? h('span', { class: 'choice-avoid' }, o.avoidance.line) : null),
      on ? h('span', { class: 'status ok' }, icon('check'), 'Chosen') : icon('out', 'chev'));
    })),
    chosen ? h('p', { class: 'foot', style: 'margin-top:10px' }, 'Changed your mind? Tap the other one.') : null);
}
