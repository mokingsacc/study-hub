import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './d1-fake.mjs';
import * as auth from '../../worker/src/platform/auth.js';

const URL0 = 'https://hub.test';
const req = (path = '/api/auth/login', { method = 'POST', cookie, csrf, origin, ip = '1.2.3.4' } = {}) => new Request(URL0 + path, {
  method, headers: { 'CF-Connecting-IP': ip, 'User-Agent': 'test', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(origin ? { Origin: origin } : {}) },
});
const withCookie = (token, opts = {}) => req('/api/p/me', { method: 'GET', cookie: `${auth.SESSION_COOKIE}=${token}`, ...opts });

async function made(s, name, body = {}) {
  const a = await auth.createAccount(s.env, 'mo', { name, ...body });
  const password = `${name.toLowerCase()}-own-password`;
  await auth.acceptInvite(s.env, req('/api/auth/invite'), { token: a.invite, password });
  return { ...a, password };
}

function setup() {
  const d = createD1();
  let t = Date.UTC(2026, 9, 25, 10);
  const mails = [];
  const restore = auth._setIo({ now: () => t, sendMail: async (env, m) => { mails.push(m); } });
  return { d, env: d.env, mails, tick: ms => { t += ms; }, now: () => t, done: () => { restore(); d.close(); } };
}

test('Mo makes an account: a generated name and a one-use invite; the person picks the password and is signed in', async () => {
  const s = setup();
  const a = await auth.createAccount(s.env, 'mo', { name: 'Sara Ahmed', profile: 'alevel' });
  assert.match(a.username, /^sara-[a-hjkmnp-z2-9]{4}$/);
  assert.equal(a.id, a.username);
  assert.match(a.invite, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(!('password' in a), 'no password is ever made or handed over');
  const cred = s.d.row('SELECT * FROM credentials WHERE user_id = ?', a.id);
  assert.equal(cred.password_hash, auth.UNSET);
  assert.equal(s.d.row('SELECT profile, role, status FROM users WHERE id = ?', a.id).profile, 'alevel');
  assert.equal(s.d.row('SELECT provider FROM ai_settings WHERE user_id = ?', a.id).provider, 'workers_ai', 'Workers AI by default, no setup');
  assert.equal(s.d.rows('SELECT * FROM auth_codes WHERE id LIKE ?', '%' + a.invite + '%').length, 0, 'the invite is stored hashed');
  // Before the invite is used, no password signs in (not even "unset").
  for (const pw of ['unset', '', 'anything-at-all']) await assert.rejects(auth.login(s.env, req(), { username: a.id, password: pw }), e => e.status === 401);
  await assert.rejects(auth.acceptInvite(s.env, req(), { token: a.invite, password: 'short' }), /at least 10/);
  const r = await auth.acceptInvite(s.env, req(), { token: a.invite, password: 'saras-own-password' });
  assert.equal(r.user, a.id);
  assert.equal(r.must_change, false);
  assert.ok((await auth.resolveSession(s.env, withCookie(r.token))).user === a.id, 'signed in straight away');
  await assert.rejects(auth.acceptInvite(s.env, req(), { token: a.invite, password: 'another-password' }), /not right|already/, 'the invite works once');
  assert.ok(await auth.login(s.env, req(), { username: a.id, password: 'saras-own-password' }));
  // A fresh invite (lost link or forgotten password) stops the older one.
  const i1 = await auth.issueInvite(s.env, 'mo', a.id);
  const i2 = await auth.issueInvite(s.env, 'mo', a.id);
  await assert.rejects(auth.acceptInvite(s.env, req(), { token: i1.invite, password: 'new-password-1' }), /not right/);
  await auth.acceptInvite(s.env, req(), { token: i2.invite, password: 'new-password-1' });
  assert.ok(await auth.login(s.env, req(), { username: a.id, password: 'new-password-1' }));
  // Expiry
  const b = await auth.createAccount(s.env, 'mo', { name: 'Late' });
  s.tick(auth.INVITE_MS + 1);
  await assert.rejects(auth.acceptInvite(s.env, req(), { token: b.invite, password: 'late-password-1' }), /expired/);
  const list = await auth.listAccounts(s.env);
  assert.deepEqual(list.map(r2 => r2.id).sort(), [a.id, b.id].sort(), 'Mo is not a platform account');
  assert.ok(!JSON.stringify(list).includes('pbkdf2'), 'the list never carries hashes');
  await assert.rejects(auth.createAccount(s.env, 'mo', { name: '  ' }), /name/);
  await assert.rejects(auth.createAccount(s.env, 'mo', { name: 'X', email: 'not-an-email' }), /email/);
  assert.match(auth.makeUsername('Émile'), /^emile-/);
  assert.match(auth.makeUsername('李'), /^user-/);
  s.done();
});

test('sign in: right password gives a session cookie and CSRF token; wrong name or password read the same', async () => {
  const s = setup();
  const a = await made(s, 'Adam');
  const r = await auth.login(s.env, req(), { username: a.username.toUpperCase(), password: a.password });
  assert.equal(r.user, a.id);
  assert.equal(r.must_change, false);
  assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(s.d.rows('SELECT * FROM sessions WHERE id = ?', r.token).length, 0, 'the token itself is never stored');
  const cookie = auth.sessionCookie(r.token);
  assert.match(cookie, /^__Host-ph_session=.+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/);
  const sess = await auth.resolveSession(s.env, withCookie(r.token));
  assert.equal(sess.user, a.id);
  assert.equal(sess.csrf, r.csrf);
  const wrongPw = await auth.login(s.env, req(), { username: a.username, password: 'nope-nope-nope' }).catch(e => e);
  const wrongName = await auth.login(s.env, req(), { username: 'nobody-abcd', password: 'nope-nope-nope' }).catch(e => e);
  assert.equal(wrongPw.status, 401);
  assert.equal(wrongPw.message, wrongName.message);
  const asMo = await auth.login(s.env, req(), { username: 'mo', password: 'anything-at-all' }).catch(e => e);
  assert.equal(asMo.status, 401, 'nobody can sign in as Mo');
  assert.equal(await auth.resolveSession(s.env, withCookie('x'.repeat(43))), null);
  assert.equal(await auth.resolveSession(s.env, req('/', { method: 'GET' })), null);
  s.done();
});

test('rate limits: 5 wrong passwords lock the name for 15 minutes, even for the right password; then it opens', async () => {
  const s = setup();
  const a = await made(s, 'Adam');
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login(s.env, req(), { username: a.id, password: 'wrong-password' }), e => e.status === 401);
  const locked = await auth.login(s.env, req(), { username: a.id, password: 'wrong-password' }).catch(e => e);
  assert.equal(locked.status, 429);
  const stillLocked = await auth.login(s.env, req('/x', { ip: '9.9.9.9' }), { username: a.id, password: a.password }).catch(e => e);
  assert.equal(stillLocked.status, 429, 'locked by name, whatever the address');
  s.tick(16 * 60_000);
  const ok = await auth.login(s.env, req(), { username: a.id, password: a.password });
  assert.equal(ok.user, a.id);
  s.done();
});

test('rate limits: one address trying many names is stopped after 30 tries', async () => {
  const s = setup();
  let status = 0;
  for (let i = 0; i < 31 && status !== 429; i++) {
    status = (await auth.login(s.env, req(), { username: `name${i}-abcd`, password: 'xxxxxxxxxx' }).catch(e => e)).status;
  }
  assert.equal(status, 429);
  s.done();
});

test('sessions end: logout, expiry, two weeks idle, a paused account', async () => {
  const s = setup();
  const a = await made(s, 'Adam');
  const r1 = await auth.login(s.env, req(), { username: a.id, password: a.password });
  const sess = await auth.resolveSession(s.env, withCookie(r1.token));
  await auth.logout(s.env, sess);
  assert.equal(await auth.resolveSession(s.env, withCookie(r1.token)), null);

  const r2 = await auth.login(s.env, req(), { username: a.id, password: a.password });
  s.tick(auth.IDLE_MS + 1);
  assert.equal(await auth.resolveSession(s.env, withCookie(r2.token)), null, 'idle too long');

  const r3 = await auth.login(s.env, req(), { username: a.id, password: a.password });
  for (let i = 0; i < 3; i++) { s.tick(8 * 86_400_000); assert.ok(await auth.resolveSession(s.env, withCookie(r3.token)), 'kept alive by use'); }
  s.tick(auth.SESSION_MS);
  assert.equal(await auth.resolveSession(s.env, withCookie(r3.token)), null, 'absolute lifetime');

  const r4 = await auth.login(s.env, req(), { username: a.id, password: a.password });
  await auth.setStatus(s.env, 'mo', a.id, 'paused');
  assert.equal(await auth.resolveSession(s.env, withCookie(r4.token)), null);
  await assert.rejects(auth.login(s.env, req(), { username: a.id, password: a.password }), e => e.status === 401);
  await auth.setStatus(s.env, 'mo', a.id, 'active');
  assert.ok(await auth.login(s.env, req(), { username: a.id, password: a.password }));
  s.done();
});

test('CSRF: writes need the token and our own origin; reads do not', async () => {
  const s = setup();
  const sess = { csrf: 'abc123token' };
  assert.equal(await auth.checkCsrf(req('/api/p/x', { method: 'GET' }), sess), true);
  assert.equal(await auth.checkCsrf(req('/api/p/x', { method: 'POST' }), sess), false);
  assert.equal(await auth.checkCsrf(req('/api/p/x', { method: 'POST', csrf: 'wrong' }), sess), false);
  assert.equal(await auth.checkCsrf(req('/api/p/x', { method: 'POST', csrf: 'abc123token' }), sess), true);
  assert.equal(await auth.checkCsrf(req('/api/p/x', { method: 'POST', csrf: 'abc123token', origin: URL0 }), sess), true);
  assert.equal(await auth.checkCsrf(req('/api/p/x', { method: 'POST', csrf: 'abc123token', origin: 'https://evil.test' }), sess), false);
  s.done();
});

test('change password: needs the current one, clears must_change, ends every other session', async () => {
  const s = setup();
  const a = await made(s, 'Adam');
  const phone = await auth.login(s.env, req(), { username: a.id, password: a.password });
  const ipad = await auth.login(s.env, req(), { username: a.id, password: a.password });
  const here = await auth.resolveSession(s.env, withCookie(ipad.token));
  await assert.rejects(auth.changePassword(s.env, a.id, here, { current: 'wrong', password: 'a-new-password' }), e => e.status === 401);
  await assert.rejects(auth.changePassword(s.env, a.id, here, { current: a.password, password: 'short' }), /at least 10/);
  await auth.changePassword(s.env, a.id, here, { current: a.password, password: 'a-new-password' });
  assert.equal(await auth.resolveSession(s.env, withCookie(phone.token)), null, 'the other device is signed out');
  const still = await auth.resolveSession(s.env, withCookie(ipad.token));
  assert.equal(still.must_change, false);
  await assert.rejects(auth.login(s.env, req(), { username: a.id, password: a.password }), e => e.status === 401);
  assert.ok(await auth.login(s.env, req(), { username: a.id, password: 'a-new-password' }));
  s.done();
});

test("reset code from Mo: single use, 30 minutes, only for that name, newest code wins, ends sessions", async () => {
  const s = setup();
  const a = await made(s, 'Adam');
  const b = await made(s, 'Sara');
  const open = await auth.login(s.env, req(), { username: a.id, password: a.password });
  const old = await auth.issueResetCode(s.env, 'mo', a.id);
  const c = await auth.issueResetCode(s.env, 'mo', a.id);
  assert.match(c.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await assert.rejects(auth.resetWithCode(s.env, req(), { username: a.id, code: old.code, password: 'fresh-password-1' }), /not right/, 'the older code stopped working');
  await assert.rejects(auth.resetWithCode(s.env, req(), { username: b.id, code: c.code, password: 'fresh-password-1' }), /not right/, "Adam's code cannot reset Sara");
  const r = await auth.resetWithCode(s.env, req(), { username: a.id, code: c.code.toLowerCase(), password: 'fresh-password-1' });
  assert.equal(r.user, a.id);
  assert.equal(await auth.resolveSession(s.env, withCookie(open.token)), null);
  await assert.rejects(auth.resetWithCode(s.env, req(), { username: a.id, code: c.code, password: 'fresh-password-2' }), /not right/, 'single use');
  assert.ok(await auth.login(s.env, req(), { username: a.id, password: 'fresh-password-1' }));
  const late = await auth.issueResetCode(s.env, 'mo', a.id);
  s.tick(auth.RESET_CODE_MS + 1);
  await assert.rejects(auth.resetWithCode(s.env, req(), { username: a.id, code: late.code, password: 'fresh-password-3' }), /expired/);
  await assert.rejects(auth.issueResetCode(s.env, 'mo', 'mo'), e => e.status === 404, 'Mo has no password to reset');
  s.done();
});

test('reset codes cannot be guessed: 5 wrong codes from one address lock resets', async () => {
  const s = setup();
  const a = await made(s, 'Adam');
  const c = await auth.issueResetCode(s.env, 'mo', a.id);
  for (let i = 0; i < 5; i++) await assert.rejects(auth.resetWithCode(s.env, req(), { username: a.id, code: 'AAAA-AAAA', password: 'fresh-password-1' }), e => e.status === 400);
  const e = await auth.resetWithCode(s.env, req(), { username: a.id, code: 'AAAA-AAAA', password: 'fresh-password-1' }).catch(x => x);
  assert.equal(e.status, 429);
  await assert.rejects(auth.resetWithCode(s.env, req(), { username: a.id, code: c.code, password: 'fresh-password-1' }), e2 => e2.status === 429);
  s.done();
});

test('email reset: off by default; when on, same answer for every address, link works once', async () => {
  const s = setup();
  const a = await made(s, 'Adam', { email: 'Adam@Example.com' });
  await assert.rejects(auth.requestEmailReset(s.env, req(), { email: 'adam@example.com' }, URL0), e => e.status === 404);
  const env = { ...s.env, EMAIL_RESET: '1' };
  const known = await auth.requestEmailReset(env, req(), { email: 'adam@example.com' }, URL0);
  const unknown = await auth.requestEmailReset(env, req(), { email: 'who@example.com' }, URL0);
  assert.deepEqual(known, unknown);
  assert.equal(s.mails.length, 1);
  assert.equal(s.mails[0].to, 'adam@example.com');
  const token = /#reset=([A-Za-z0-9_-]+)/.exec(s.mails[0].text)[1];
  await assert.rejects(auth.resetWithEmailToken(s.env, req(), { token, password: 'email-password-1' }), e => e.status === 404, 'flag off: link refused');
  await auth.resetWithEmailToken(env, req(), { token, password: 'email-password-1' });
  await assert.rejects(auth.resetWithEmailToken(env, req(), { token, password: 'email-password-2' }), /not right/);
  assert.ok(await auth.login(s.env, req(), { username: a.id, password: 'email-password-1' }));
  s.done();
});

test('connector keys: per user, shown once, stored hashed, revocable, never Mo', async () => {
  const s = setup();
  const a = await made(s, 'Adam');
  const b = await made(s, 'Sara');
  const ka = await auth.createConnectorKey(s.env, a.id, 'iPad');
  const kb = await auth.createConnectorKey(s.env, b.id);
  assert.match(ka.path, /^\/mcp\/u\/pk_[A-Za-z0-9_-]{43}$/);
  assert.equal(s.d.rows('SELECT * FROM connector_keys WHERE id LIKE ?', '%' + ka.token + '%').length, 0, 'stored hashed');
  assert.equal(await auth.userForConnector(s.env, ka.token), a.id);
  assert.equal(await auth.userForConnector(s.env, kb.token), b.id);
  assert.equal(await auth.userForConnector(s.env, 'pk_' + 'x'.repeat(43)), null);
  assert.deepEqual((await auth.listConnectorKeys(s.env, a.id)).map(k => k.label), ['iPad'], "Adam's list has only his");
  await assert.rejects(auth.revokeConnectorKey(s.env, b.id, ka.id), e => e.status === 404, 'Sara cannot revoke Adam\'s key');
  await auth.revokeConnectorKey(s.env, a.id, ka.id);
  assert.equal(await auth.userForConnector(s.env, ka.token), null);
  await assert.rejects(auth.createConnectorKey(s.env, 'mo'), e => e.status === 403);
  await auth.setStatus(s.env, 'mo', b.id, 'paused');
  assert.equal(await auth.userForConnector(s.env, kb.token), null, 'paused accounts lose the connector too');
  s.done();
});

// ------------------------------------------------------------------ security review fixes (25 Oct)

test('review fix: parallel guesses cannot pass the 5-try lock, even from many IPv6 addresses in one /64', async () => {
  const s = setup();
  const a = await made(s, 'Adam');
  const tries = Array.from({ length: 40 }, (_, i) => auth.login(s.env, req('/api/auth/login', { ip: `2001:db8:1:2::${(i + 1).toString(16)}` }),
    { username: a.id, password: i === 39 ? a.password : `wrong-password-${i}` }).then(() => 200, e => e.status));
  const out = await Promise.all(tries);
  assert.ok(out.filter(x => x !== 429).length <= 5, `at most 5 attempts were checked: ${out.join(',')}`);
  assert.equal(auth.ipKey('2001:db8:1:2::1'), auth.ipKey('2001:0db8:0001:0002:ffff:0:0:9'), 'one /64');
  assert.notEqual(auth.ipKey('2001:db8:1:2::1'), auth.ipKey('2001:db8:1:3::1'));
  assert.equal(auth.ipKey('1.2.3.4'), '1.2.3.4');
  s.done();
});

test('review fix: a reset or pause revokes connector links; a normal password change keeps them', async () => {
  const s = setup();
  const a = await made(s, 'Adam');
  const k1 = await auth.createConnectorKey(s.env, a.id, 'phone');
  const sess = await auth.resolveSession(s.env, withCookie((await auth.login(s.env, req(), { username: a.id, password: a.password })).token));
  await auth.changePassword(s.env, a.id, sess, { current: a.password, password: 'changed-password-1' });
  assert.equal(await auth.userForConnector(s.env, k1.token), a.id, 'his own change keeps his Claude linked');
  const code = await auth.issueResetCode(s.env, 'mo', a.id);
  await auth.resetWithCode(s.env, req(), { username: a.id, code: code.code, password: 'changed-password-2' });
  assert.equal(await auth.userForConnector(s.env, k1.token), null, 'a reset ends every connector link');
  const k2 = await auth.createConnectorKey(s.env, a.id, 'phone');
  await auth.setStatus(s.env, 'mo', a.id, 'paused');
  await auth.setStatus(s.env, 'mo', a.id, 'active');
  assert.equal(await auth.userForConnector(s.env, k2.token), null, 'pausing ends connector links for good');
  s.done();
});

test('review fix: guessing the current password is rate limited', async () => {
  const s = setup();
  const a = await made(s, 'Adam');
  const sess = await auth.resolveSession(s.env, withCookie((await auth.login(s.env, req(), { username: a.id, password: a.password })).token));
  for (let i = 0; i < 5; i++) await assert.rejects(auth.changePassword(s.env, a.id, sess, { current: `wrong-${i}-password`, password: 'new-password-1' }), e => e.status === 401);
  await assert.rejects(auth.changePassword(s.env, a.id, sess, { current: a.password, password: 'new-password-1' }), e => e.status === 429);
  s.done();
});

test('review fix: an invite or reset code cannot be used on a paused account', async () => {
  const s = setup();
  const a = await auth.createAccount(s.env, 'mo', { name: 'Adam' });
  await auth.setStatus(s.env, 'mo', a.id, 'paused');
  await assert.rejects(auth.acceptInvite(s.env, req(), { token: a.invite, password: 'paused-password-1' }), e => e.status === 400, 'pausing cancels open invites');
  const later = await auth.issueInvite(s.env, 'mo', a.id);
  await assert.rejects(auth.acceptInvite(s.env, req(), { token: later.invite, password: 'paused-password-1' }), e => e.status === 403);
  assert.equal(s.d.row('SELECT password_hash FROM credentials WHERE user_id = ?', a.id).password_hash, auth.UNSET, 'nothing changed');
  s.done();
});
