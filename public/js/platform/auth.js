// Sign in, accept an invite (#invite=<token>), reset by email link (#reset=<token>) and the forced new password
// (#password, when must_change is set). Passwords never leave this page except in the request body.
// Their own copy: while nobody has an account yet (GET /api/auth/claim), sign-in is the first-time setup instead.
import { post, get, setCsrf, ApiError } from './api.js';
import { h, icon, btn, field, input, select, passwordInput, busy } from './kit.js';

const MIN = 10;

function frame(root, title, sub, ...body) {
  root.append(h('div', { class: 'auth rise' },
    h('div', { class: 'mark', 'aria-hidden': 'true' }, h('i')),
    h('div', null, h('h1', { class: 't-title1' }, title), sub ? h('p', { class: 'muted', style: 'margin-top:8px' }, sub) : null),
    ...body));
}

// The new-password block: rules shown live, show/hide, nothing hidden behind hover.
function newPassword(label = 'New password') {
  const pw = passwordInput({ name: 'new-password', required: true, minLength: MIN, maxLength: 200 });
  const lenRule = h('li', null, icon('check'), `At least ${MIN} characters`);
  const rules = h('ul', { class: 'rules', 'aria-live': 'polite' }, lenRule,
    h('li', null, icon('info'), 'Three or four random words is strong and easy to remember'),
    h('li', null, icon('info'), 'Do not reuse a password from another site'));
  pw.input.addEventListener('input', () => lenRule.classList.toggle('met', pw.input.value.length >= MIN));
  return { el: h('div', { class: 'form' }, field(label, pw.wrap), rules), input: pw.input };
}

function errLine() { return h('p', { class: 'err', role: 'alert', hidden: true }); }
function showErr(el, e) { el.textContent = (e && e.message) || 'Something went wrong. Please try again.'; el.hidden = false; }

function signedIn(app, reply, next) {
  setCsrf(reply.csrf);
  app.setMe(reply);
  history.replaceState(null, '', next);
  app.route();
}

function renderInvite(root, { param, app }) {
  const np = newPassword('Choose a password');
  const err = errLine();
  const go = btn('Continue', null, 'primary', null, { cls: 'btn-lg btn-block' });
  go.type = 'submit';
  const form = h('form', { class: 'card form', novalidate: true }, np.el, err, go);
  form.addEventListener('submit', e => {
    e.preventDefault();
    err.hidden = true;
    if (np.input.value.length < MIN) return showErr(err, new Error(`Please choose a password of at least ${MIN} characters.`));
    busy(go, async () => {
      try {
        const r = await post('/api/auth/invite', { token: param, password: np.input.value });
        signedIn(app, r, '#welcome');
      } catch (e2) { showErr(err, e2); }
    });
  });
  frame(root, 'Welcome to Study Hub', 'Your own space for subjects, weak topics, flashcards and results. Choose a password to finish setting up.', form,
    h('p', { class: 'foot' }, 'Link not working? It works once and lasts 7 days. Ask Mo for a new one.'));
}

function renderReset(root, { param, app }) {
  const np = newPassword();
  const err = errLine();
  const go = btn('Save new password', null, 'primary', null, { cls: 'btn-lg btn-block' });
  go.type = 'submit';
  const form = h('form', { class: 'card form', novalidate: true }, np.el, err, go);
  form.addEventListener('submit', e => {
    e.preventDefault();
    err.hidden = true;
    busy(go, async () => {
      try {
        await post('/api/auth/reset/email/confirm', { token: param, password: np.input.value });
        history.replaceState(null, '', '#login');
        root.replaceChildren();
        renderLogin(root, { app }, 'Password changed. Sign in with your new password.');
      } catch (e2) { showErr(err, e2); }
    });
  });
  frame(root, 'Choose a new password', 'This link is for your Study Hub account.', form);
}

function renderChange(root, { app }) {
  const cur = passwordInput({ autocomplete: 'current-password', name: 'current-password' });
  const np = newPassword();
  const err = errLine();
  const go = btn('Save password', null, 'primary', null, { cls: 'btn-lg btn-block' });
  go.type = 'submit';
  const form = h('form', { class: 'card form', novalidate: true }, field('Current password', cur.wrap), np.el, err, go);
  form.addEventListener('submit', e => {
    e.preventDefault();
    err.hidden = true;
    busy(go, async () => {
      try {
        await post('/api/auth/password', { current: cur.input.value, password: np.input.value });
        app.me = null;
        app.go('#today', true);
      } catch (e2) { showErr(err, e2); }
    });
  });
  frame(root, 'Choose a new password', 'Mo set a temporary password for you. Pick your own to carry on.', form);
}

function renderLogin(root, { app }, notice) {
  const user = input({ autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', name: 'username', placeholder: 'e.g. sara-k7m2', enterKeyHint: 'next' });
  const pw = passwordInput({ autocomplete: 'current-password', name: 'password', enterKeyHint: 'go' });
  const err = errLine();
  const go = btn('Sign in', null, 'primary', null, { cls: 'btn-lg btn-block' });
  go.type = 'submit';
  const form = h('form', { class: 'card form', novalidate: true }, field('Login name', user), field('Password', pw.wrap), err, go);
  form.addEventListener('submit', e => {
    e.preventDefault();
    err.hidden = true;
    if (!user.value.trim() || !pw.input.value) return showErr(err, new Error('Please fill in your login name and password.'));
    busy(go, async () => {
      try {
        const r = await post('/api/auth/login', { username: user.value.trim().toLowerCase(), password: pw.input.value });
        if (r.must_change) signedIn(app, r, '#password'); else signedIn(app, r, '#today');
      } catch (e2) { showErr(err, e2); }
    });
  });

  const email = input({ type: 'email', autocomplete: 'email', inputMode: 'email', autocapitalize: 'off', placeholder: 'you@example.com' });
  const mailMsg = h('p', { class: 'foot', 'aria-live': 'polite' });
  const send = btn('Email me a link', null, 'tinted');
  send.addEventListener('click', () => busy(send, async () => {
    mailMsg.textContent = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { mailMsg.textContent = 'That email address does not look right.'; return; }
    try {
      const r = await post('/api/auth/reset/email', { email: email.value.trim() });
      mailMsg.textContent = r.message || 'If that email is on an account, a link is on its way. Check your inbox.';
    } catch (e2) {
      mailMsg.textContent = e2 instanceof ApiError && e2.status === 404 ? 'Email resets are not switched on. Ask Mo for a new link instead.' : e2.message;
    }
  }));
  const forgot = h('details', { class: 'card', style: 'padding:16px 18px' },
    h('summary', { style: 'cursor:pointer;min-height:28px;color:var(--accent-text);font-size:15px' }, 'Forgot your password?'),
    h('div', { class: 'form', style: 'margin-top:12px' },
      h('p', { class: 'small muted' }, 'Ask Mo for a new link. It lets you choose a new password.'),
      h('p', { class: 'small muted' }, 'If you added an email in Settings, you can get a link by email:'),
      email, send, mailMsg));
  frame(root, 'Study Hub', notice || 'Sign in to carry on.', form, forgot);
  get('/api/auth/claim').then(r => { if (r && r.open && location.hash === '#login') { root.replaceChildren(); renderClaim(root, { app }); } }).catch(() => {});
  if (!notice) get('/api/auth/me').then(me => { if (me && !me.must_change && location.hash === '#login') signedIn(app, me, '#today'); }).catch(() => {});
}

// ------------------------------------------------------------------ their own copy: the first-time setup

const LEVELS = [{ value: 'primary', label: 'Primary school (SATs)' }, { value: 'gcse', label: 'GCSE' }, { value: 'alevel', label: 'A-level' },
  { value: 'university', label: 'University' }, { value: 'other', label: 'Something else' }];
const NOT_MOVED = new Set(['library_docs', 'study_pictures', 'ai_settings', 'ai_usage']);

// Their export, a table at a time in parts of at most 500 rows and about 1.5 MB (POST /api/p/me/import).
async function moveIn(data, say) {
  let added = 0;
  const names = Object.keys(data.tables || {}).filter(n => !NOT_MOVED.has(n) && Array.isArray(data.tables[n]) && data.tables[n].length);
  for (const [i, n] of names.entries()) {
    const rows = data.tables[n];
    for (let at = 0; at < rows.length;) {
      let end = at, bytes = 0;
      while (end < rows.length && end - at < 500 && bytes < 1.5e6) bytes += JSON.stringify(rows[end++]).length;
      say(`Moving your data in: ${i + 1} of ${names.length}`);
      try { added += (await post('/api/p/me/import', { table: n, rows: rows.slice(at, end) })).added; } catch (e) { if (!(e instanceof ApiError) || e.status !== 400) throw e; break; }
      at = end;
    }
  }
  return added;
}

function renderClaim(root, { app }) {
  const code = passwordInput({ name: 'setup-code', autocomplete: 'off' });
  const name = input({ autocomplete: 'given-name', maxLength: 60 });
  const level = select(LEVELS, 'gcse');
  const np = newPassword('Choose a password');
  const file = h('input', { type: 'file', accept: 'application/json,.json', class: 'input' });
  const status = h('p', { class: 'foot', 'aria-live': 'polite' });
  let data = null;
  file.addEventListener('change', async () => {
    data = null; status.textContent = '';
    const f = file.files && file.files[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d || typeof d !== 'object' || !d.tables || !d.account) throw new Error();
      data = d;
      if (!name.value) name.value = d.account.name || '';
      if (LEVELS.some(l => l.value === d.account.track)) level.value = d.account.track;
      status.textContent = `Ready to move in ${d.account.name ? `${d.account.name}'s` : 'your'} Study Hub from ${new Date(d.exported_at).toLocaleDateString('en-GB')}. Your login name stays ${d.user}.`;
    } catch { status.textContent = 'That file is not a Study Hub export. Use "Download my data" in Settings on your old Study Hub.'; }
  });
  const err = errLine();
  const go = btn('Make it mine', null, 'primary', null, { cls: 'btn-lg btn-block' });
  go.type = 'submit';
  const form = h('form', { class: 'card form', novalidate: true },
    field('Setup code', code.wrap, 'the SETUP_CODE you chose when you set up this copy'), field('Your first name', name), field('What are you studying for?', level), np.el,
    h('details', null, h('summary', { style: 'cursor:pointer;min-height:28px;color:var(--accent-text)' }, 'Moving from another Study Hub?'),
      h('div', { class: 'form', style: 'margin-top:10px' }, h('p', { class: 'small muted' }, 'Choose the file from "Download my data" on your old Study Hub. Your subjects, topics, cards, results, papers, lessons, notes and mnemonics come with you. Library files and photos do not: upload them again.'), file)),
    status, err, go);
  form.addEventListener('submit', e => {
    e.preventDefault();
    err.hidden = true;
    if (!name.value.trim()) return showErr(err, new Error('Please give your first name.'));
    if (np.input.value.length < MIN) return showErr(err, new Error(`Please choose a password of at least ${MIN} characters.`));
    busy(go, async () => {
      try {
        const r = await post('/api/auth/claim', { setup_code: code.input.value, name: name.value.trim(), profile: level.value, password: np.input.value,
          ...(data ? { id: data.user, profile_json: data.account.profile, prefs: data.account.settings } : {}) });
        setCsrf(r.csrf);
        if (data) { const n = await moveIn(data, t => { status.textContent = t; }); status.textContent = `Moved in ${n} things.`; }
        const moved = status.textContent;
        root.replaceChildren();
        frame(root, 'It is yours', moved || 'Your Study Hub is set up.', h('div', { class: 'card form' },
          h('p', null, 'Your login name is ', h('b', { class: 'num' }, r.user), '. Keep it with your password: you need both to sign in.'),
          btn('Carry on', () => signedIn(app, r, data ? '#today' : '#welcome'), 'primary', null, { cls: 'btn-lg btn-block' })));
      } catch (e2) { showErr(err, e2); }
    });
  });
  frame(root, 'Make this Study Hub yours', 'Nobody has an account here yet. Set yours up: it is the only one, and only you can open it.', form);
}

export function render(root, ctx) {
  if (ctx.name === 'invite') return renderInvite(root, ctx);
  if (ctx.name === 'reset') return renderReset(root, ctx);
  if (ctx.name === 'password') return renderChange(root, ctx);
  return renderLogin(root, ctx);
}
