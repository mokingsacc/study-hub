// Teach me: the hand-off to the person's own Claude (with the Study Hub connector, which runs the lesson). A tap
// records the request (POST /api/p/teach/request {topic_id}, keepalive, so it lands even when the Claude app takes
// over at once) and opens Claude on the same tap through a real link, https://claude.ai/new?q=<prompt>, which the
// Claude app opens on an iPhone or iPad. The prompt is also copied, in case the box comes up empty.
import { h, icon, toast, copyText } from './kit.js';
import { post } from './api.js';

export const promptFor = (name, id) => `Teach me ${name}${id ? ` (map: ${id})` : ''}`;
export const claudeHref = prompt => `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;

/** Records the tap (or the morning choice) and copies the prompt; the link itself opens Claude. */
export function handOff(prompt, record) {
  copyText(prompt).then(ok => toast(ok ? 'Opening Claude. If the box is empty, paste: the words are copied.' : 'Opening Claude. If the box is empty, say: ' + prompt, { ms: 5200 }));
  return record().catch(e => toast(`Your tap was not saved (${e.message}). Claude still works.`));
}

/** The Teach me link for one topic: a real <a>, so the tap opens Claude even in the Home Screen app. */
export function teachLink(topic, { label = 'Teach me', cls = 'btn btn-primary', onTap } = {}) {
  const prompt = topic.prompt || promptFor(topic.name, topic.id);
  return h('a', { class: cls, href: claudeHref(prompt), target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${label}: ${topic.name}, in Claude`,
    onclick: () => { handOff(prompt, () => post('/api/p/teach/request', { topic_id: topic.id }, { keepalive: true })); if (onTap) onTap(); } },
  icon('teach'), label);
}
