import { h, btn, sheet, field, textarea, toast, copyText } from './kit.js';
import { get } from './api.js';

const MAX = 12;
const trail = () => (globalThis.shTrail ||= []);
const pages = [];
let own = null;

/** Called once from custom.js boot: the error listeners, the page trail and the side bar's button. */
export function listen(app) {
  if (listen.done) return;
  listen.done = true;
  const push = (kind, msg, where = '') => { trail().push([Date.now(), kind, where, String(msg || '').slice(0, 300)]); if (trail().length > MAX * 2) trail().splice(0, trail().length - MAX * 2); };
  addEventListener('error', e => push('error', e.message, `${(e.filename || '').split('/').pop()}:${e.lineno || ''}`));
  addEventListener('unhandledrejection', e => push('promise', e.reason && (e.reason.message || e.reason)));
  const page = () => { pages.push([Date.now(), location.hash || '#today']); if (pages.length > 8) pages.shift(); };
  page();
  addEventListener('hashchange', page);
  const b = document.getElementById('report');
  if (b) b.onclick = () => openReport(app);
}

const t = ms => new Date(ms).toTimeString().slice(0, 8);

/** The message for Claude (pure but for the browser facts it is given). */
export function reportText({ what, trying, page, errors, visited, device, ownCopy }) {
  const lines = [
    ownCopy ? 'Please fix a bug in my Study Hub (this repository).' : 'A problem in the Study Hub.',
    '',
    `What went wrong: ${what || '(not described)'}`,
    ...(trying ? [`What I was trying to do: ${trying}`] : []),
    `Page: ${page}`,
    `Device: ${device}`,
    '',
    'Recent errors (newest last):',
    ...(errors.length ? errors.map(([at, kind, where, msg]) => `- ${t(at)} ${kind}${where ? ` ${where}` : ''}: ${msg}`) : ['- none recorded']),
    '',
    `Pages before it: ${visited.map(([at, p]) => `${t(at)} ${p}`).join(', ') || 'none'}`,
  ];
  if (ownCopy) lines.push('', 'Find the cause in the code, fix it with a test that fails before the fix, run npm test, then commit and push to main (the hub redeploys itself). Tell me in plain words what was wrong.');
  return lines.join('\n');
}

export function openReport(app) {
  const what = textarea({ rows: 3, placeholder: 'e.g. The map stayed blank after I added a subject', 'aria-label': 'What went wrong' });
  const trying = textarea({ rows: 2, placeholder: 'optional', 'aria-label': 'What you were trying to do' });
  const preview = h('pre', { class: 'rp-pre' });
  const facts = () => ({ what: what.value.trim(), trying: trying.value.trim(), page: location.hash || '#today',
    errors: trail().map(r => (r.length === 4 && typeof r[1] === 'number' ? [r[0], `HTTP ${r[1]}`, r[2], r[3]] : r)).slice(-MAX), visited: pages.slice(0, -1),
    device: `${navigator.userAgent.replace(/\s*\([^)]*\)\s*/g, ' ').slice(0, 120)}; screen ${innerWidth}x${innerHeight}`, ownCopy: !!own });
  const draw = () => { preview.textContent = reportText(facts()); };
  what.addEventListener('input', draw); trying.addEventListener('input', draw);
  if (own == null) get('/api/p/me').then(m => { own = !!m.own_copy; draw(); }).catch(() => {});
  const copy = btn('Copy for Claude', async () => {
    if (!what.value.trim()) { what.focus(); toast('Say what went wrong first.'); return; }
    await copyText(reportText(facts()));
    s.close();
    toast(own ? 'Copied. Paste it into Claude Code on your Study Hub.' : 'Copied. Send it to whoever runs your Study Hub.');
  }, 'primary', 'copy');
  const s = sheet({ title: 'Report a problem', sub: 'What it copies is below: the page, recent errors and your browser. No study data, login or passwords.', wide: true,
    body: h('div', { class: 'form' }, field('What went wrong?', what), field('What were you trying to do?', trying), preview),
    actions: [btn('Cancel', () => s.close(), 'gray'), copy] });
  draw();
  what.focus();
  return s;
}
