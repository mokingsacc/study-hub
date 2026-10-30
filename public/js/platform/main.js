// Study Hub shell and router: one page, hash routes, each screen imported on demand (warmed on idle). Signed-in
// state from GET /api/auth/me; the CSRF token stays in api.js memory.
import { get, DEMO, setCsrf, onAuthLost } from './api.js';
import { $, $$, h, icon, onThemeChange, state, btn } from './ui.js';

const SCREENS = {
  today: () => import('./today.js'),
  subjects: () => import('./subjects.js'),
  subject: () => import('./subjects.js'),
  map: () => import('./map.js'),
  cards: () => import('./cards.js'),
  results: () => import('./results.js'),
  library: () => import('./library.js'),
  settings: () => import('./settings.js'),
  papers: () => import('./papers.js'),
  exams: () => import('./exams.js'),
  galaxy: () => import('./galaxies.js'),
  how: () => import('./how.js'),
  chats: () => import('./chats.js'),
  progress: () => import('./progress.js'),
  mnemonics: () => import('./mnemonics.js'),
  learn: () => import('./learn.js'),
  up: () => import('./upload.js'),
  welcome: () => import('./welcome.js'),
  login: () => import('./auth.js'),
  invite: () => import('./auth.js'),
  reset: () => import('./auth.js'),
  password: () => import('./auth.js'),
  page: () => import('./custom.js').then(m => ({ render: m.renderPage })),
  more: () => import('./more.js'),
};
// Their own colours before the first paint (Make it mine, custom.js caches them).
try { const t = JSON.parse(localStorage.getItem('sh-theme')); if (t) { if (t.mode !== 'auto') document.documentElement.dataset.theme = t.mode; for (const k in t.vars) document.documentElement.style.setProperty(k, t.vars[k]); } } catch { /* none yet */ }
const TITLES = { today: 'Today', subjects: 'Subjects', subject: 'Subject', map: 'Map', cards: 'Cards', results: 'Results', library: 'Library', settings: 'Settings', papers: 'Practice papers', exams: 'Exams', galaxy: 'Galaxy', how: 'How it works', mnemonics: 'Mnemonics', chats: 'Chat notes', progress: 'Your study days', learn: 'Why it works', up: 'Add to your Study Hub',
  welcome: 'Welcome', page: 'Your page', login: 'Sign in', invite: 'Welcome', reset: 'New password', password: 'New password', more: 'More' };
const SOLO = new Set(['login', 'invite', 'reset', 'password', 'welcome', 'up']);
const OPEN = new Set(['login', 'invite', 'reset', 'password', 'up']);
const NAV_OF = { subject: 'subjects', library: 'more', settings: 'more', papers: 'more', page: 'more', exams: 'more', galaxy: 'map', how: 'more', mnemonics: 'more', chats: 'more', progress: 'today', learn: 'more' };
// Old addresses that still work: #help and #help/<part> are How it works.
const ALIAS = { help: 'how' };

// Shared state the screens read: who is signed in and which parts are switched on.
export const app = {
  me: null,
  modules: {},
  go(hash, replace) {
    if (replace) { history.replaceState(null, '', hash); route(); }
    else if (location.hash === hash) route();
    else location.hash = hash;
  },
  setMe(me) {
    app.me = me;
    if (me && me.csrf) setCsrf(me.csrf);
    const who = $('#who');
    if (who) who.textContent = me ? `Signed in as ${me.name || me.user}` : '';
    // The modules for the nav, behind the first paint.
    if (me && !me.must_change) setTimeout(() => { get('/api/p/me').then(m => { app.claude = m.claude || null; app.setModules(m.modules); }).catch(() => {}); import('./custom.js').then(m => m.boot(app)).catch(() => {}); }, 60);
  },
  setModules(mods) {
    if (!mods) return;
    app.modules = Array.isArray(mods) ? Object.fromEntries(mods.map(m => [m.id, m.on])) : { ...mods };
    for (const a of $$('[data-module]')) { const v = app.modules[a.dataset.module]; a.hidden = a.hasAttribute('data-optin') ? v !== true : v === false; }
  },
  on: id => app.modules[id] !== false,
  welcomed() { try { return localStorage.getItem(`sh-welcomed:${app.me && app.me.user}`) === '1'; } catch { return true; } },
  markWelcomed() { try { localStorage.setItem(`sh-welcomed:${app.me && app.me.user}`, '1'); } catch { /* private mode */ } },
};

function parse(hash) {
  const raw = (hash || '').replace(/^#/, '');
  const eq = raw.match(/^(invite|reset)=(.+)$/);
  if (eq) return { name: eq[1], param: decodeURIComponent(eq[2]) };
  const [first, ...rest] = raw.split('/');
  const name = ALIAS[first] || first;
  const param = rest.length ? decodeURIComponent(rest.join('/')) : null;
  if (!name || name === 'demo') return { name: 'today', param: null };
  return SCREENS[name] !== undefined ? { name, param } : { name: 'today', param: null };
}

let seq = 0;
let cleanup = null;
let current = null;
const main = $('#main');

async function ensureMe() {
  if (app.me) return true;
  try {
    const me = await get('/api/auth/me');
    app.setMe(me);
    if (me.must_change) { app.go('#password', true); return false; }
    return true;
  } catch (e) {
    if (e.status === 401 || e.status === 404) { app.go('#login', true); return false; }
    main.replaceChildren(state('warn', 'Study Hub did not load', e.message, btn('Try again', () => location.reload(), 'tinted', 'refresh')));
    return false;
  }
}

async function route() {
  const my = ++seq;
  const { name, param } = parse(location.hash);
  const solo = SOLO.has(name);
  if (!OPEN.has(name) && !(await ensureMe())) return;
  if (my !== seq) return;
  $('#shell').classList.toggle('solo', solo);
  const navName = NAV_OF[name] || name;
  for (const a of $$('[data-nav]')) {
    const on = a.dataset.nav === navName || (a.closest('.side') ? a.dataset.nav === name : a.dataset.nav === 'more' && navName === 'subjects');
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.title = `${TITLES[name] || 'Study Hub'} · Study Hub`;
  let mod = null;
  {
    try { mod = await SCREENS[name](); } catch {
      if (my === seq) main.replaceChildren(state('refresh', 'This page needs a reload', 'Study Hub was updated. Reload to get the new version.', btn('Reload', () => location.reload(), 'tinted', 'refresh')));
      return;
    }
  }
  if (my !== seq) return;
  app.onReturn = null;
  if (typeof cleanup === 'function') try { cleanup(); } catch { /* old screen */ }
  cleanup = null;
  const root = h('div', { class: 'screen' });
  main.replaceChildren(root);
  if (current !== name + param) window.scrollTo(0, 0);
  current = name + param;
  try {
    cleanup = await mod.render(root, { name, param, app });
    // These screens just draw again on return; the rest set their own app.onReturn.
    if (!app.onReturn && /^(today|subjects?|cards|results|how)$/.test(name)) app.onReturn = route;
  } catch (e) {
    if (my === seq) root.replaceChildren(state('warn', 'Something went wrong', (e && e.message) || 'Please try again.', btn('Try again', route, 'tinted', 'refresh')));
  }
}
app.route = route;
// Back after 15 s or more (from the Claude app, say): the screen refreshes if it set app.onReturn.
let away = 0;
document.addEventListener('visibilitychange', () => { if (document.hidden) away = Date.now(); else if (away && Date.now() - away > 15e3 && app.onReturn) app.onReturn(); });

onAuthLost(() => { app.me = null; if (!OPEN.has(parse(location.hash).name)) app.go('#login', true); });
window.addEventListener('hashchange', route);
onThemeChange(() => route());

if (DEMO) document.body.append(h('div', { class: 'demo-badge', 'aria-hidden': 'true' }, 'Demo'));
route();

// Warm the other screens once the first one has painted, so a tab tap never waits on the network.
const warm = () => ['./today.js', './subjects.js', './map.js', './cards.js', './results.js', './library.js', './settings.js'].forEach(p => import(p).catch(() => {}));
if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 2500 }); else setTimeout(warm, 1200);
