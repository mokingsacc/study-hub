// The rest of the Study Hub kit, loaded with the first screen that needs it (not part of the first view):
// sheets, confirm, form controls and the colour key. Re-exports ui.js so a screen imports from one place.
import { h, $, icon, btn, dot, bandText, addIcons } from './ui.js';
export * from './ui.js';

addIcons({
  map: 'c:6 7 2|c:17.5 6 2|c:12.5 12.5 2|c:8 18.5 2|p:M7.6 8.3l3.3 2.9M16.3 7.6l-2.6 3.3M11.4 14.2l-2.3 2.6',
  home: 'p:M3.5 10.6 12 3.5l8.5 7.1|p:M5.5 9.2V19a1.5 1.5 0 0 0 1.5 1.5h3.2v-5.2h3.6v5.2H17a1.5 1.5 0 0 0 1.5-1.5V9.2',
  close: 'p:m6.5 6.5 11 11M17.5 6.5l-11 11',
  check: 'p:m5 12.5 4.5 4.5L19 7.5',
  back: 'p:m14.5 6-6 6 6 6',
  undo: 'p:M9 6.5 4.5 11 9 15.5|p:M4.5 11H15a4.5 4.5 0 0 1 0 9h-2',
  photo: 'r:3.8 5 16.4 14 2|p:m4 16 4.4-4.4 3.4 3.4 2.4-2.4 5.8 5.6|c:15.3 9.3 1.4',
  pencil: 'p:M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10Z|p:m14 8 2 2',
  trash: 'p:M4.5 7h15M9.5 7V4.8h5V7M6.5 7l1 12.2a1.5 1.5 0 0 0 1.5 1.3h6a1.5 1.5 0 0 0 1.5-1.3l1-12.2M10 11v6M14 11v6',
  search: 'c:10.5 10.5 6|p:m15 15 5 5',
  copy: 'r:8.5 8.5 11 11 2|p:M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2',
  eye: 'p:M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z|c:12 12 3',
  eyeOff: 'p:M4 4l16 16|p:M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.7 3.4M6.6 7.2A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1|p:M9.9 10a3 3 0 0 0 4.1 4.2',
  key: 'c:8 15 4|p:m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14.5 8.5l2 2',
  info: 'c:12 12 8.5|p:M12 11v5.5|f:12 7.9 .9',
  clock: 'c:12 12 8.5|p:M12 7.5V12l3 2',
  link: 'p:M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2|p:M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2',
  note: 'p:M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z|p:M13.5 3.5v4h4M8.5 12h7M8.5 15.5h7',
  exam: 'p:M6.5 3.5h11a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z|p:M8.5 8h7M8.5 11.5h7M8.5 15h4|c:16 16.5 1.4',
  help: 'c:12 12 9|p:M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6|f:12 16.8 .9',
  file: 'p:M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z|p:M13.5 3.5v4h4',
  upload: 'p:M12 15.5V4.5M7.5 9 12 4.5 16.5 9|p:M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15',
  download: 'p:M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5|p:M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15',
  bolt: 'p:M13.2 3 5.5 13.3h6L10.8 21l7.7-10.3h-6Z',
  type: 'r:2.8 6 18.4 12 2|p:M6.5 9.5h1M10 9.5h1M13.5 9.5h1M17 9.5h.5M6.5 12h1M10 12h1M13.5 12h1M17 12h.5M8 14.8h8',
  logout: 'p:M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14|p:M10 8l-4 4 4 4M6 12h9.5',
  shield: 'p:M12 3.5 5 6.2v5.3c0 4.4 3 7.8 7 9 4-1.2 7-4.6 7-9V6.2Z|p:m9 12 2.2 2.2L15.5 10',
  user: 'c:12 8.5 3.8|p:M4.8 20a7.2 7.2 0 0 1 14.4 0',
  paste: 'r:5.5 4.5 13 16 2|p:M9 4.5V3.8a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v.7M9 11h6M9 14.5h6',
  chat: 'p:M20.5 11.5a8 8 0 0 1-11.7 7.1L4 19.8l1.2-4.5a8 8 0 1 1 15.3-3.8Z',
  target: 'c:12 12 8.5|c:12 12 4.5|f:12 12 1.2',
  galaxy: 'p:M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0|p:M4 9.5c2.5-4.5 9-6 13-3.5M20 14.5c-2.5 4.5-9 6-13 3.5|c:18.5 6 1|c:5.5 18 1',
  list: 'p:M9 6.5h11M9 12h11M9 17.5h11|f:5 6.5 1.1|f:5 12 1.1|f:5 17.5 1.1',
  moon: 'p:M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z',
  arrowUp: 'p:M12 19V5M6.5 10.5 12 5l5.5 5.5',
  arrowDown: 'p:M12 5v14M6.5 13.5 12 19l5.5-5.5',
});

export function topicChip(t, onclick) {
  return h(onclick ? 'button' : 'span', { class: 'chip', type: onclick ? 'button' : null, onclick, 'aria-label': `${t.name}: ${bandText(t)}` },
    dot(t.t1000), h('span', { class: 'nm' }, t.name), h('span', { class: 'bw', 'aria-hidden': 'true' }, bandText(t)));
}

// A page's header. how: the How it works section this page is explained in (an (i) beside the title).
export function pageHead(title, { kicker, actions, back, how } = {}) {
  return h('header', { class: 'head' },
    h('div', { class: 'titles' },
      back ? h('a', { class: 'back', href: back.href }, icon('back'), back.label) : null,
      kicker ? h('div', { class: 't-micro kicker' }, kicker) : null,
      h('h1', { class: 't-title1' }, title, how ? h('a', { class: 'how-i', href: `#how/${how}`, 'aria-label': `How ${title} works` }, icon('info')) : null)),
    actions && actions.length ? h('div', { class: 'acts' }, actions) : null);
}

export function legend() {
  const row = [[100, 'Strong'], [300, 'Getting there'], [500, 'Shaky'], [700, 'Weak'], [900, 'Very weak'], [null, 'Not seen yet']];
  return h('div', { class: 'legend', 'aria-label': 'Colour key' }, row.map(([t, w]) => h('span', null, dot(t), w)));
}


// ------------------------------------------------------------------ toast with optional Undo
let toastTimer = 0;
export function toast(message, { undo, ms } = {}) {
  const el = $('#toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.replaceChildren(h('span', null, message));
  el.classList.toggle('plain', !undo);
  if (undo) {
    el.append(h('button', { type: 'button', onclick: async () => {
      hideToast();
      try { await undo(); } catch (e) { toast(e.message || 'Could not undo that.'); }
    } }, 'Undo'));
  }
  el.classList.add('on');
  toastTimer = setTimeout(hideToast, ms || (undo ? 7000 : 3200));
}
export function hideToast() { const el = $('#toast'); if (el) el.classList.remove('on'); }

// ------------------------------------------------------------------ formats moved out of the first view
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// A new chat in the Claude app with the words already typed (their own subscription does the work).
export const claudeHref = words => 'https://claude.ai/new?q=' + encodeURIComponent(words);

/**
 * "Ask my Claude": a real link to a new Claude chat with the words typed in. A tap also copies the words (the app may
 * not fill them in). When their Claude has never reached the hub (app.claude), it first offers to connect. label may be
 * nodes (a whole list row, with ico null).
 */
export function askClaude(words, label = 'Ask my Claude', { app = null, cls = 'btn btn-tinted btn-sm', ico = 'sparkle' } = {}) {
  const a = h('a', { class: cls, href: claudeHref(words), target: '_blank', rel: 'noopener' }, ico ? icon(ico) : null, label);
  a.addEventListener('click', e => {
    copyText(words).catch(() => {});
    if (app && app.claude && !app.claude.last_used_at) { e.preventDefault(); connectSheet(words); return; }
    toast('Opening Claude. Check Study Hub is switched on in the chat (+, then Connectors). The words are copied too.');
  });
  return a;
}

export function connectSheet(words) {
  const s = sheet({ title: 'Connect your Claude first', sub: 'Your Claude needs the Study Hub connector for this. It takes two minutes, once.',
    body: h('div', { class: 'form' },
      h('a', { class: 'btn btn-primary', href: '#settings', onclick: () => s.close() }, icon('link'), 'Connect now'),
      h('a', { class: 'btn btn-tinted', href: claudeHref(words), target: '_blank', rel: 'noopener', onclick: () => s.close() }, icon('sparkle'), 'Open Claude anyway'),
      h('p', { class: 'foot' }, 'Already connected? Switch Study Hub on in the chat.')) });
}
// The date of their first exam, from Today's "Add your exam date" (Settings has the same field).
export function examDateSheet(app) {
  const d = h('input', { class: 'input', type: 'date', 'aria-label': 'First exam date' });
  const save = btn('Save', null, 'primary');
  const s = sheet({ title: 'Your first exam', sub: 'Today counts down to it. Your Claude can change it too.', body: d, actions: [btn('Cancel', () => s.close(), 'gray'), save] });
  save.addEventListener('click', () => busy(save, async () => {
    if (!d.value) { toast('Pick the day first.'); return; }
    try { const { patch } = await import('./api.js'); await patch('/api/p/me', { exam_date: d.value }); s.close(); toast('Exam date saved'); app.route(); } catch (e) { toast(e.message); }
  }));
}
export const money = v => '$' + (Number(v) || 0).toFixed(2);
export function bytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
}

// ------------------------------------------------------------------ sheets (bottom sheet on phones, a card on iPad)
const touch = matchMedia('(pointer: coarse)').matches;
export function sheet({ title, sub, body, actions, onClose, wide } = {}) {
  const prevFocus = document.activeElement;
  const scrim = h('div', { class: 'scrim' });
  const bodyEl = h('div', { class: 'body' }, body);
  const actEl = h('div', { class: 'actions' }, actions);
  if (!actions) actEl.hidden = true;
  const box = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
    h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('close')),
    h('h2', null, title), sub ? h('p', { class: 'sub' }, sub) : null, bodyEl, actEl);
  if (wide) box.classList.add('wide');
  let closed = false;
  const onKey = e => { if (e.key === 'Escape') close(); };
  function close() {
    if (closed) return; closed = true;
    scrim.classList.remove('on'); box.classList.remove('on');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { scrim.remove(); box.remove(); }, 340);
    if (prevFocus && prevFocus.focus) try { prevFocus.focus({ preventScroll: true }); } catch { /* gone */ }
    if (onClose) onClose();
  }
  scrim.addEventListener('click', () => close());
  document.addEventListener('keydown', onKey);
  document.body.append(scrim, box);
  requestAnimationFrame(() => { scrim.classList.add('on'); box.classList.add('on'); });
  const first = !touch && box.querySelector('.body input:not([type=hidden]), .body textarea, .body select');
  (first || box).focus({ preventScroll: true });
  return {
    el: box, body: bodyEl, close,
    setBody(...n) { bodyEl.replaceChildren(...n.flat()); },
    setActions(...n) { actEl.replaceChildren(...n.flat()); actEl.hidden = !n.flat().length; },
    get closed() { return closed; },
  };
}

// A yes/no question in a sheet. Resolves true when confirmed.
export function confirmSheet({ title, sub, ok = 'OK', danger, extra }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); s.close(); } };
    const s = sheet({ title, sub, body: extra || null, onClose: () => { if (!done) { done = true; resolve(false); } },
      actions: [btn('Cancel', () => finish(false), 'gray'), btn(ok, () => finish(true), danger ? 'danger' : 'primary')] });
  });
}

export async function busy(button, fn) {
  if (button) { if (button.getAttribute('aria-busy') === 'true') return undefined; button.setAttribute('aria-busy', 'true'); }
  try { return await fn(); } finally { if (button) button.removeAttribute('aria-busy'); }
}
export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', null, label, hint ? h('span', { class: 'hint' }, ` · ${hint}`) : null), control);
}
export function input(props = {}) { return h('input', { class: 'input', type: 'text', ...props }); }
export function textarea(props = {}) { return h('textarea', { class: 'input', ...props }); }
export function select(options, value, onchange, props = {}) {
  const s = h('select', { class: 'input', onchange: onchange ? e => onchange(e.target.value) : null, ...props },
    options.map(o => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
  return s;
}
export function seg(options, value, onchange, cls = '') {
  const box = h('div', { class: `seg ${cls}`, role: 'group' });
  const draw = v => box.replaceChildren(...options.map(o => h('button', { type: 'button', 'aria-pressed': String(o.value === v), 'aria-label': o.aria || null,
    onclick: () => { draw(o.value); onchange(o.value); } }, o.label)));
  draw(value);
  return box;
}
export function toggle(checked, onchange, label, disabled) {
  const i = h('input', { type: 'checkbox', checked: !!checked, disabled: !!disabled, 'aria-label': label, role: 'switch', onchange: e => onchange(e.target.checked, e.target) });
  return h('span', { class: 'switch' }, i, h('span'));
}
export function passwordInput(props = {}) {
  const i = input({ type: 'password', autocomplete: 'new-password', autocapitalize: 'off', spellcheck: 'false', ...props });
  const eye = h('button', { type: 'button', class: 'eye', 'aria-label': 'Show password', 'aria-pressed': 'false' }, icon('eye'));
  eye.addEventListener('click', () => {
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    eye.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    eye.setAttribute('aria-pressed', String(show));
  });
  return { wrap: h('div', { class: 'pw' }, i, eye), input: i };
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const t = h('textarea', { value: text, readonly: true });
  t.style.cssText = 'position:fixed;opacity:0;top:0';
  document.body.append(t); t.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  t.remove();
  return ok;
}

