// Settings (#settings): account (name, exam date, email, password), your Claude (connected or not, connector links),
// Make it mine, parts on/off, Link your Anki, self-check, sharing, built-in AI folded (own keys never shown back,
// model, limits with spend rings), export, delete, sign out, and the one-line privacy note.
import { get, post, put, patch, del, clearSession, DEMO } from './api.js';
import { h, icon, ring, btn, sheet, confirmSheet, toast, field, input, select, toggle, pageHead, loading, errorState, state, busy, passwordInput, money, fmtDay, copyText } from './kit.js';
import { connectorBox } from './welcome.js';

const card = (title, ...kids) => h('section', null, h('div', { class: 'section-title' }, title), h('div', { class: 'list' }, ...kids));
const row = (label, sub, control) => h('div', { class: 'set-row' }, h('div', { class: 'grow' }, h('b', null, label), sub ? h('span', { class: 'sub' }, sub) : null), control);

export function render(root, { app }) {
  root.append(pageHead('Settings'), loading(3));
  // The order on screen: you, your Claude, the look, parts, Anki, the self-check, sharing, then built-in AI (folded) and your data.
  const parts = { account: h('div'), connector: h('div'), mine: h('div'), modules: h('div'), anki: h('div'), check: h('div'), sharing: h('div'), ai: h('div'), data: h('div') };
  Promise.all([get('/api/p/me'), get('/api/p/ai').catch(e => e), get('/api/p/connector').catch(e => e), get('/api/p/sharing').catch(e => e)]).then(([me, ai, conn, share]) => {
    app.setModules(me.modules);
    const privacy = h('p', { class: 'privacy' });
    root.replaceChildren(pageHead('Settings', { kicker: me.track_label, how: 'mine' }), ...Object.values(parts), privacy);
    import('./custom.js').then(m => parts.mine.replaceChildren(m.settingsPanel(app, (msg, bad) => toast(bad ? msg : `Changed: ${msg}`)))).catch(() => {});
    account(parts.account, me, app);
    if (me.own_copy) privacy.textContent = 'Your study data lives only in your own Cloudflare account. Nobody else can see it.';
    else sharing(parts.sharing, share instanceof Error ? null : share, privacy);
    if (ai instanceof Error) parts.ai.replaceChildren(card('AI', errorState(ai))); else aiSection(parts.ai, ai);
    if (me.modules.find(m => m.id === 'connector' && m.on)) connector(parts.connector, conn instanceof Error ? { links: [] } : conn);
    if (me.modules.find(m => m.id === 'anki_link' && m.on)) anki(parts.anki);
    modules(parts.modules, me, app);
    selfCheck(parts.check);
    data(parts.data, app, me);
  }).catch(e => root.replaceChildren(pageHead('Settings'), errorState(e, () => app.route())));
}

// ------------------------------------------------------------------ account
function account(box, me, app) {
  const name = input({ value: me.name || '', maxLength: 40, 'aria-label': 'Your name', style: 'max-width:220px;text-align:right' });
  name.addEventListener('change', async () => {
    try { const r = await patch('/api/p/me', { name: name.value.trim() }); app.me.name = r.name; toast('Name saved'); } catch (e) { toast(e.message); name.value = me.name; }
  });
  const exam = input({ type: 'date', value: me.exam_date || '', 'aria-label': 'First exam date', style: 'max-width:180px' });
  exam.addEventListener('change', async () => {
    try { await patch('/api/p/me', { exam_date: exam.value || null }); toast(exam.value ? 'Exam date saved' : 'Exam date cleared'); } catch (e) { toast(e.message); }
  });
  box.replaceChildren(card('You',
    row('Name', null, name),
    row('Login name', 'You need it to sign in on another device', h('span', { class: 'muted' }, me.user)),
    row('First exam', 'For the countdown on Today', exam),
    row('Email', me.email_set ? 'Saved, for password resets' : 'Optional, only for password resets', btn(me.email_set ? 'Change' : 'Add', () => emailSheet(me), 'tinted', null, { cls: 'btn-sm' })),
    row('Password', null, btn('Change', passwordSheet, 'tinted', null, { cls: 'btn-sm' }))));
}

function emailSheet(me) {
  const email = input({ type: 'email', inputMode: 'email', autocomplete: 'email', autocapitalize: 'off', placeholder: 'you@example.com' });
  const save = btn('Save', null, 'primary');
  const sh = sheet({ title: 'Email for resets', sub: 'Used only to send you a link if you forget your password. Leave it empty to remove it.', body: field('Email', email),
    actions: [btn('Cancel', () => sh.close(), 'gray'), save] });
  save.addEventListener('click', () => busy(save, async () => {
    try { const r = await put('/api/p/email', { email: email.value.trim() || null }); me.email_set = r.has_email; sh.close(); toast(r.has_email ? 'Email saved' : 'Email removed'); }
    catch (e) { toast(e.message); }
  }));
}

function passwordSheet() {
  const cur = passwordInput({ autocomplete: 'current-password' });
  const nw = passwordInput({ autocomplete: 'new-password', minLength: 10 });
  const save = btn('Change password', null, 'primary');
  const sh = sheet({ title: 'Change password', body: [field('Current password', cur.wrap), field('New password', nw.wrap, 'at least 10 characters')],
    actions: [btn('Cancel', () => sh.close(), 'gray'), save] });
  save.addEventListener('click', () => busy(save, async () => {
    if (nw.input.value.length < 10) { toast('Please choose a password of at least 10 characters.'); return; }
    try { await post('/api/auth/password', { current: cur.input.value, password: nw.input.value }); sh.close(); toast('Password changed'); }
    catch (e) { toast(e.message); }
  }));
}

const PRIVATE = 'Your study data is private to you. Mo can see only that your account exists and your AI spend.';
const SHARED = 'Mo can see the progress shown under "Share my progress with Mo", your account and your AI spend. Nothing else.';
function sharing(box, share, privacy) {
  privacy.textContent = share && share.share ? SHARED : PRIVATE;
  if (!share) { box.replaceChildren(); return; }
  const preview = h('div', { class: 'share-preview' });
  const paint = v => {
    privacy.textContent = v.share ? SHARED : PRIVATE;
    preview.replaceChildren(sharePreview(v));
  };
  const sw = toggle(share.share, async (on, input) => {
    input.disabled = true;
    try {
      const r = await put('/api/p/sharing', { share: on });
      paint({ ...share, ...r });
      toast(r.share ? 'Mo can now see your progress' : 'Your progress is private again');
    } catch (e) { input.checked = !on; toast(e.message); }
    input.disabled = false;
  }, 'Share my progress with Mo');
  paint(share);
  box.replaceChildren(card('Mo', row('Share my progress with Mo', 'Off unless you switch it on. You can switch it off any time.', sw), preview));
}
function sharePreview(v) {
  const p = v.preview || {};
  const pct = x => `${Math.round((Number(x) || 0) * 100)}%`;
  const lines = [
    ...(p.rings || []).map(r => `${r.subject}: ${pct(r.ring)} strong (${r.seen} of ${r.topics} seen, ${r.weak} weak)`),
    (p.weakest || []).length ? `Weakest: ${p.weakest.map(w => `${w.topic} (${w.band})`).join(', ')}` : null,
    p.cards_due != null ? `${p.cards_due} card${p.cards_due === 1 ? '' : 's'} due${p.streak_days ? ` · ${p.streak_days}-day streak` : ''}` : null,
    ...(p.last_results || []).map(r => `${r.subject}${r.source ? `, ${r.source}` : ''}: ${r.out_of ? `${r.marks}/${r.out_of}` : r.total_n ? `${r.right_n}/${r.total_n}` : `${r.percent}%`}${r.day ? ` (${fmtDay(r.day)})` : ''}`),
  ].filter(Boolean);
  return h('div', { class: 'set-row share-what' }, h('div', { class: 'grow' },
    h('b', null, v.share ? 'What Mo sees now' : 'What Mo would see'),
    (v.shows || []).length ? h('span', { class: 'sub' }, `Shared: ${v.shows.map(x => x[0].toLowerCase() + x.slice(1)).join('; ')}.`) : null,
    h('ul', { class: 'share-lines' }, lines.length ? lines.map(l => h('li', null, l)) : h('li', null, 'Nothing yet: add topics and log some results.')),
    v.never ? h('span', { class: 'sub' }, v.never) : null));
}

// ------------------------------------------------------------------ AI
const STATUS = { ok: ['ok', 'Working'], invalid: ['bad', 'Refused'], no_credit: ['warn', 'No credit'], unchecked: ['na', 'Not checked'] };

function aiSection(box, ai) {
  const redraw = next => aiSection(box, next);
  const prov = ai.providers.find(p => p.id === ai.provider) || ai.providers[0];
  const provSel = select(ai.providers.map(p => ({ value: p.id, label: p.needs_key ? `${p.name} (your key)` : p.name })), ai.provider, async v => {
    const p = ai.providers.find(x => x.id === v);
    if (p.needs_key && !ai.keys.some(k => k.provider === v)) { keySheet(p, ai, async () => redraw(await put('/api/p/ai', { provider: v }))); provSel.value = ai.provider; return; }
    try { redraw(await put('/api/p/ai', { provider: v })); toast(`Now using ${p.name}`); } catch (e) { toast(e.message); provSel.value = ai.provider; }
  }, { 'aria-label': 'AI provider', style: 'max-width:240px' });
  const modelSel = select(prov.models.map(m => ({ value: m.id, label: m.label })), ai.model, async v => {
    try { redraw(await put('/api/p/ai', { model: v })); toast('Model saved'); } catch (e) { toast(e.message); }
  }, { 'aria-label': 'Model', style: 'max-width:240px' });

  const capIn = (val, key, label) => {
    const i = input({ type: 'text', inputMode: 'decimal', value: Number(val).toFixed(2), 'aria-label': label, style: 'width:88px;text-align:right' });
    i.addEventListener('change', async () => {
      const v = Number(i.value.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(v) || v < 0) { toast('Type an amount in dollars, like 1.00'); return; }
      try { redraw(await put('/api/p/ai', { [key]: v })); toast('Limit saved'); } catch (e) { toast(e.message); }
    });
    return h('span', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, h('span', { class: 'muted' }, '$'), i);
  };
  const spendRing = (used, cap, label) => h('div', { class: 'one' },
    ring(cap ? used / cap : 0, { size: 56, stroke: 7, label: `${label}: ${money(used)} of ${money(cap)}`, center: '', color: used >= cap && cap ? 'var(--bad)' : 'var(--accent)' }),
    h('div', null, h('div', { class: 't-head num' }, money(used)), h('div', { class: 'foot' }, `${label} · limit ${money(cap)}`)));

  const keys = ai.providers.filter(p => p.needs_key).map(p => {
    const k = ai.keys.find(x => x.provider === p.id);
    const [cls, word] = k ? STATUS[k.status] || STATUS.unchecked : ['na', 'No key'];
    return row(`${p.name} key`, k ? `Ends ${k.hint}${k.checked_at ? ` · checked ${fmtDay(k.checked_at)}` : ''}` : 'Optional. Uses your own account and credit.',
      h('span', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, h('span', { class: `status ${cls}` }, word),
        btn(k ? 'Manage' : 'Add', () => keySheet(p, ai, async () => redraw(await get('/api/p/ai'))), 'tinted', null, { cls: 'btn-sm' })));
  });

  // Folded: with a Claude subscription none of this is needed; the summary says what the built-in AI has used today.
  box.replaceChildren(card('Built-in AI and your own keys', h('details', { class: 'ai-fold' },
    h('summary', { class: 'set-row' }, h('div', { class: 'grow' }, h('b', null, prov.needs_key ? `${prov.name}, on your key` : 'Built-in AI'),
      h('span', { class: 'sub' }, `${money(ai.spend.today_usd)} of ${money(ai.caps.daily_usd)} today · for topic ideas, screenshots and card drafts`)), h('span', { class: 'linkish' }, 'Show options')),
    row('AI provider', prov.needs_key ? 'For topic ideas, screenshots and card drafts, on your own key' : 'For topic ideas, screenshots and card drafts. Built in: nothing to set up.', provSel),
    row('Model', null, modelSel),
    h('div', { class: 'set-row' }, h('div', { class: 'spend grow' }, spendRing(ai.spend.today_usd, ai.caps.daily_usd, 'Today'), spendRing(ai.spend.month_usd, ai.caps.monthly_usd, 'This month'))),
    row('Daily limit', null, capIn(ai.caps.daily_usd, 'daily_cap_usd', 'Daily limit in dollars')),
    row('Monthly limit', `Mo's ceiling for you: ${money(ai.caps.ceiling_usd)} a month`, capIn(ai.caps.monthly_usd, 'monthly_cap_usd', 'Monthly limit in dollars')),
    ...keys)));
}

function keySheet(p, ai, done) {
  const k = ai.keys.find(x => x.provider === p.id);
  const key = passwordInput({ autocomplete: 'off', placeholder: 'Paste your key', name: `key-${p.id}` });
  const save = btn('Save key', null, 'primary');
  const where = { anthropic: 'console.anthropic.com > API keys', openai: 'platform.openai.com > API keys', gemini: 'aistudio.google.com > Get API key' }[p.id];
  const extra = [];
  if (k) {
    const check = btn('Check key', null, 'gray', 'refresh');
    check.addEventListener('click', () => busy(check, async () => {
      try { const r = await post(`/api/p/ai/keys/${p.id}/check`); toast(`${p.name} key: ${(STATUS[r.status] || STATUS.unchecked)[1]}`); sh.close(); done(); } catch (e) { toast(e.message); }
    }));
    const remove = btn('Remove key', null, 'danger', 'trash');
    remove.addEventListener('click', () => busy(remove, async () => {
      try { await del(`/api/p/ai/keys/${p.id}`); toast(`${p.name} key removed`); sh.close(); done(); } catch (e) { toast(e.message); }
    }));
    extra.push(h('div', { class: 'row' }, h('span', { class: 'foot grow' }, `Saved key ends ${k.hint}. It is never shown again.`), check, remove));
  }
  const sh = sheet({ title: `${p.name} key`, sub: `Get one at ${where}. It is stored sealed and never shown back to anyone, Mo included.`,
    body: [...extra, field(k ? 'Replace with a new key' : 'Key', key.wrap)], actions: [btn('Cancel', () => sh.close(), 'gray'), save] });
  save.addEventListener('click', () => busy(save, async () => {
    if (!key.input.value.trim()) { toast('Paste the key first.'); return; }
    try {
      const r = await put(`/api/p/ai/keys/${p.id}`, { key: key.input.value.trim() });
      key.input.value = '';
      toast(r.status === 'ok' ? `${p.name} key works` : `${p.name} key saved: ${(STATUS[r.status] || STATUS.unchecked)[1]}`);
      sh.close(); done();
    } catch (e) { toast(e.message); }
  }));
}

// ------------------------------------------------------------------ connector
function connector(box, conn) {
  const redraw = async () => { try { connector(box, await get('/api/p/connector')); } catch (e) { toast(e.message); } };
  const make = btn('Make a new link', null, 'tinted', 'plus', { cls: 'btn-sm' });
  make.addEventListener('click', () => busy(make, async () => {
    try {
      const r = await post('/api/p/connector', { label: conn.links.length ? `Claude ${conn.links.length + 1}` : 'Claude' });
      sheet({ title: 'Your Claude connector', sub: 'Add it to Claude now: the link is shown only once.', body: connectorBox(r.url), onClose: redraw });
    } catch (e) { toast(e.message); }
  }));
  const links = conn.links.map(l => row(l.label || 'Claude', `Made ${fmtDay(l.created_at)}${l.last_used_at ? ` · last used ${fmtDay(l.last_used_at)}` : ' · not used yet'}`,
    btn('Remove', async () => {
      if (!(await confirmSheet({ title: 'Remove this link?', sub: 'Claude stops reaching your hub through it straight away.', ok: 'Remove', danger: true }))) return;
      try { await del(`/api/p/connector/${encodeURIComponent(l.id)}`); toast('Link removed'); redraw(); } catch (e) { toast(e.message); }
    }, 'danger', null, { cls: 'btn-sm' })));
  const used = conn.links.reduce((m, l) => (l.last_used_at && (!m || l.last_used_at > m) ? l.last_used_at : m), null);
  box.replaceChildren(card('Your Claude',
    row(used ? 'Connected' : conn.links.length ? 'Link made, not used yet' : 'Not connected yet',
      used ? `Last reached your hub ${fmtDay(used).replace(/^(Today|Yesterday)$/, w => w.toLowerCase())}` : conn.links.length ? 'Add it in the Claude app: Settings, Connectors, Add custom connector. Then switch Study Hub on in a chat.' : 'Make a link, then add it in the Claude app. It runs on your own Claude plan.',
      h('a', { class: 'btn btn-tinted btn-sm', href: '#how/claude' }, 'What it can do')),
    row('Connector links', conn.links.length ? 'Your Claude can read and update your hub' : 'Let the Claude app see your topics, log results and quiz your cards', make),
    ...links));
}

// ------------------------------------------------------------------ Anki
// Link your own Anki: the add-on comes with their hub address and key inside; it sends after every sync on the
// computer, so phone reviews count once the phone has synced too. A new download or key stops the old one.
function anki(box) {
  const redraw = () => anki(box);
  const copyRow = (label, value) => h('div', { class: 'copybox' }, h('code', null, value),
    btn('Copy', async () => toast((await copyText(value)) ? `${label} copied` : 'Could not copy. Press and hold to copy it.'), 'tinted', 'copy', { cls: 'btn-sm' }));
  const steps = r => h('div', { class: 'form' },
    h('ol', { class: 'steplist' },
      h('li', null, 'On your computer, double-click study-hub.ankiaddon (or in Anki: Tools, Add-ons, Install from file).'),
      h('li', null, 'Restart Anki, then press Sync. Your cards and reviews come across after every sync.'),
      h('li', null, 'On your phone, review as usual and sync. Next time Anki on the computer syncs, those reviews come too.')),
    h('p', { class: 'foot' }, 'Cards land on a topic when a deck or tag has the topic\'s name. To send a whole deck to a topic, tell your Claude, for example: "Send my Anki deck Biology::Cell cycle to Mitosis."'),
    h('details', null, h('summary', null, 'Set it up by hand instead'),
      h('p', { class: 'foot' }, 'In Anki: Tools, Study Hub, Change hub address or key. The key is shown once and works like a password.'),
      copyRow('Address', r.hub), copyRow('Key', r.key)));
  const download = btn('Download the Anki add-on', null, 'primary', 'download', { cls: 'btn-sm' });
  download.addEventListener('click', () => busy(download, async () => {
    try {
      const r = await post('/api/p/anki/key', { addon: true });
      const bytes = Uint8Array.from(atob(r.addon_b64), ch => ch.charCodeAt(0));
      const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })), download: r.addon_name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      sheet({ title: 'Your Anki add-on', sub: 'It has your own key inside, so keep the file to yourself. Any older copy stops working.', body: steps(r), onClose: redraw });
    } catch (e) { toast(e.message); }
  }));
  box.replaceChildren(card('Anki', row('Link your Anki', 'Checking…', download)));
  get('/api/p/anki/status').then(st => {
    const sub = !st.linked ? 'Not linked yet. Download the add-on on your computer (Anki on the computer, any phone).'
      : !st.last_sync_at ? `Add-on made ${fmtDay(st.key_made_at)} · waiting for the first sync`
      : `Last sync ${fmtDay(st.last_sync_at)} · ${st.cards} cards, ${st.on_topics} on your topics`;
    box.replaceChildren(card('Anki', row('Link your Anki', sub, download)));
  }).catch(e => box.replaceChildren(card('Anki', row('Link your Anki', e.message, download))));
}

// ------------------------------------------------------------------ modules
function modules(box, me, app) {
  box.replaceChildren(card('Parts of the hub', ...me.modules.filter(m => m.id !== 'map').map(m =>
    row(m.label, m.can_switch ? null : m.on ? 'Always on' : 'Not available yet', toggle(m.on, async (on, el) => {
      m.on = on;
      app.setModules(me.modules);
      try { const r = await patch('/api/p/me', { modules: { [m.id]: on } }); me.modules = r.modules; app.setModules(r.modules); toast(`${on ? 'Switched on' : 'Switched off'}: ${m.label}`); }
      catch (e) { m.on = !on; el.checked = !on; app.setModules(me.modules); toast(e.message); }
    }, m.label, !m.can_switch)))));
}

// ------------------------------------------------------------------ self-check
const LEVEL_ICON = { ok: 'check', info: 'info', warn: 'warn', stop: 'warn' };
function selfCheck(box) {
  const run = btn('Check now', null, 'tinted', 'refresh', { cls: 'btn-sm' });
  const out = h('div');
  run.addEventListener('click', () => busy(run, async () => {
    out.replaceChildren(h('div', { class: 'check-item' }, h('span', { class: 'foot' }, 'Checking…')));
    try {
      const r = await get('/api/p/self-check');
      out.replaceChildren(
        h('div', { class: 'check-item' }, h('span', { class: `ic ${r.ok ? 'ok' : 'warn'}` }, icon(r.ok ? 'check' : 'warn')), h('b', null, r.summary || (r.ok ? 'Everything is working.' : 'Something needs a look.'))),
        ...r.items.map(i => h('div', { class: 'check-item' }, h('span', { class: `ic ${i.level}` }, icon(LEVEL_ICON[i.level] || 'info')),
          h('div', { class: 'grow' }, h('div', null, i.says), i.fix ? h('div', { class: 'foot', style: 'margin-top:2px' }, i.fix) : null))));
    } catch (e) { out.replaceChildren(h('div', { class: 'check-item' }, h('span', { class: 'err' }, e.message))); }
  }));
  box.replaceChildren(card('Is everything working?', row('Self-check', 'AI, spending, Claude, topics and cards in plain words', run), out));
}

// ------------------------------------------------------------------ data and sign out
// Their own copy: the file from Export on another Study Hub, brought in a table at a time (auth.js moveIn). Rows
// already here stay as they are; nothing is replaced.
function bringIn(app) {
  const file = h('input', { type: 'file', accept: 'application/json,.json', class: 'input' });
  const say = h('p', { class: 'foot', 'aria-live': 'polite' });
  const go = btn('Bring it in', null, 'primary');
  const s = sheet({ title: 'Bring in your data', sub: 'Choose the file from Export on your other Study Hub. Subjects, topics, cards, results, papers, lessons, notes and mnemonics come in; library files and photos do not, so upload those again. Nothing already here is changed.',
    body: h('div', { class: 'form' }, file, say), actions: [btn('Cancel', () => s.close(), 'gray'), go] });
  go.addEventListener('click', () => busy(go, async () => {
    const f = file.files && file.files[0];
    if (!f) { say.textContent = 'Choose the file first.'; return; }
    let d;
    try { d = JSON.parse(await f.text()); if (!d || !d.tables) throw new Error(); } catch { say.textContent = 'That file is not a Study Hub export.'; return; }
    try {
      const { moveIn } = await import('./auth.js');
      const n = await moveIn(d, t => { say.textContent = t; });
      s.close();
      toast(`Brought in ${n} things`);
      app.route();
    } catch (e) { say.textContent = e.message; }
  }));
}

function data(box, app, me = {}) {
  const exp = btn('Export', null, 'tinted', 'download', { cls: 'btn-sm' });
  exp.addEventListener('click', () => busy(exp, async () => {
    try {
      const all = await get('/api/p/me/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' }));
      const a = h('a', { href: url, download: `study-hub-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('Your data is downloading');
    } catch (e) { toast(e.message); }
  }));
  const out = btn('Sign out', async () => {
    try { await post('/api/auth/logout'); } catch { /* signed out anyway */ }
    clearSession(); app.me = null; app.go('#login', true);
  }, 'gray', 'logout', { cls: 'btn-sm' });
  box.replaceChildren(card('Your data',
    row('Export my data', 'Everything you added, as a file', exp),
    me.own_copy ? row('Bring in data', 'From Export on another Study Hub', btn('Choose file', () => bringIn(app), 'tinted', 'upload', { cls: 'btn-sm' })) : null,
    row('Delete my account', 'Closes it and deletes your data within 24 hours', btn('Delete', () => deleteSheet(app), 'danger', null, { cls: 'btn-sm' })),
    row('Sign out', DEMO ? 'Demo: sign in again with any name' : null, out)));
}

function deleteSheet(app) {
  const pw = passwordInput({ autocomplete: 'current-password' });
  const go = btn('Delete my account', null, 'danger', 'trash');
  const sh = sheet({ title: 'Delete your account?', sub: 'This signs you out everywhere, removes your Claude links and deletes your subjects, cards, results and library within 24 hours. It cannot be undone. Export first if you want a copy.',
    body: field('Type your password to confirm', pw.wrap), actions: [btn('Cancel', () => sh.close(), 'gray'), go] });
  go.addEventListener('click', () => busy(go, async () => {
    if (!pw.input.value) { toast('Type your password first.'); return; }
    try {
      const r = await post('/api/p/me/delete', { password: pw.input.value });
      sh.close(); clearSession(); app.me = null;
      toast(r.message || 'Your account is closed.', { ms: 6000 });
      app.go('#login', true);
    } catch (e) { toast(e.message); }
  }));
}
