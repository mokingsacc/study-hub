import { HttpError, now } from '../util.js';
import { MO } from '../users.js';
import { DEFAULT_PROFILE, PROFILES } from '../profiles.js';
import { hashPassword, verifyPassword, needsRehash, generatePassword, generateCode, randomToken, randomBytes, sha256Hex, safeEqual } from './crypto.js';

export const SESSION_COOKIE = '__Host-ph_session';
export const CSRF_HEADER = 'X-CSRF-Token';
const DAY = 86_400_000;
export const SESSION_MS = 30 * DAY;          // absolute lifetime
export const IDLE_MS = 14 * DAY;             // signed out after two weeks unused
const TOUCH_MS = 3_600_000;                  // last_seen is written at most hourly
export const RESET_CODE_MS = 30 * 60_000;
export const EMAIL_RESET_MS = 30 * 60_000;
export const MIN_PASSWORD = 10;
// Sign-in limits: 5 wrong passwords per name per 15 minutes, then a 15-minute lock; 30 attempts per address.
export const LIMITS = {
  user: { limit: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
  ip: { limit: 30, windowMs: 15 * 60_000, lockMs: 15 * 60_000 },
  reset: { limit: 5, windowMs: 60 * 60_000, lockMs: 60 * 60_000 },
};
const ANON = '-';   // rate_limits rows that belong to no user yet

export const platformOn = env => !!env && env.PLATFORM === '1';
export const emailResetOn = env => !!env && env.EMAIL_RESET === '1';

// Swappable in tests: the clock and the mail sender.
const io = {
  now: () => now(),
  // Cloudflare Email sending (a send_email binding named MAILER). Stubbed until EMAIL_RESET is on and bound.
  sendMail: async (env, { to, subject, text }) => {
    if (!env.MAILER || typeof env.MAILER.send !== 'function') throw new Error('No mail binding');
    return env.MAILER.send({ to, from: env.MAIL_FROM || 'no-reply@example.invalid', subject, text });
  },
};
export function _setIo(over) {
  const prev = { ...io };
  Object.assign(io, over);
  return () => Object.assign(io, prev);
}

const ID_RE = /^[a-z][a-z0-9-]{2,39}$/;
export const validUserId = id => typeof id === 'string' && ID_RE.test(id) && id !== MO;

// 'Sara Ahmed' -> 'sara-k7m2' (lowercase first name, a dash and four random characters; never a dot).
export function makeUsername(name) {
  const first = String(name || '').normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().split(/[^a-z]+/).filter(Boolean)[0] || 'user';
  const base = (first.length >= 2 ? first : `user${first}`).slice(0, 16);
  const tail = generatePassword(1, 4);
  return `${base}-${tail}`;
}

function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw new HttpError(400, `Please choose a password of at least ${MIN_PASSWORD} characters.`);
  if (pw.length > 200) throw new HttpError(400, 'That password is too long.');
}

const cleanEmail = e => {
  if (e == null || e === '') return null;
  const s = String(e).trim().toLowerCase();
  if (s.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, 'That email address does not look right.');
  return s;
};

// ------------------------------------------------------------------ accounts (admin)

// A new account with a generated login name and a one-use invite link (7 days). The person opens the link and
// chooses their own password, so nobody ever hands a password over. profile is a profiles.js name.
export const INVITE_MS = 7 * DAY;
export const UNSET = 'unset';   // password_hash before the invite is used: never verifies

export function platformProfile(profile) {
  const name = profile == null || profile === '' ? (PROFILES.gcse ? 'gcse' : DEFAULT_PROFILE) : String(profile);
  const p = PROFILES[name];
  if (name === 'step2' || (p && p.platform === false)) throw new HttpError(400, 'That track is not offered here.');
  if (!p && PROFILES.gcse) throw new HttpError(400, 'Please choose GCSE or A-level.');
  return name;
}

export async function createAccount(env, admin, { name, email, profile, profile_json } = {}) {
  const display = String(name || '').trim().slice(0, 60);
  if (!display) throw new HttpError(400, 'Please give the person a name.');
  const track = platformProfile(profile);
  const mail = cleanEmail(email);
  const t = io.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = makeUsername(display);
    const invite = randomToken(24);
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO users (id, name, role, profile, profile_json, prefs_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, display, 'student', track, JSON.stringify(profile_json || {}), '{}', 'active', t, t),
        env.DB.prepare('INSERT INTO credentials (user_id, password_hash, must_change, email, changed_at, created_at) VALUES (?, ?, 1, ?, ?, ?)').bind(id, UNSET, mail, t, t),
        env.DB.prepare('INSERT INTO ai_settings (user_id, updated_at) VALUES (?, ?)').bind(id, t),
        env.DB.prepare('INSERT INTO auth_codes (user_id, id, kind, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, await sha256Hex('invite:' + invite.toUpperCase()), 'invite', String(admin || MO), t, t + INVITE_MS),
      ]);
      return { id, username: id, invite, invite_expires_at: t + INVITE_MS, name: display, created_by: admin };
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test(String(e && e.message))) continue;   // the four random characters clashed
      throw e;
    }
  }
  throw new HttpError(500, 'Could not make a unique login name. Please try again.');
}

// ------------------------------------------------------------------ owner mode (their own copy)

export const ownerMode = env => !!env && typeof env.SETUP_CODE === 'string' && env.SETUP_CODE.trim().length >= 12;

export async function claimOpen(env) {
  if (!ownerMode(env)) return false;
  // Every account, whoever's: the question is whether anyone has one.
  const r = await env.DB.prepare('SELECT COUNT(user_id) AS n FROM credentials').first();
  return !(r && r.n);
}

// id: keep the login name of a Study Hub they are moving from (their export's `user`), so their data moves as is.
export async function claimOwner(env, request, { setup_code, name, profile, password, id, profile_json, prefs } = {}) {
  if (!ownerMode(env)) throw new HttpError(404, 'Not found');
  const t = io.now();
  const ipB = 'claim:' + (await ipBucket(request));
  const wait = await lockedFor(env, ANON, ipB, t);
  if (wait) throw tooMany(wait);
  if (!(await safeEqual(String(setup_code || '').trim(), env.SETUP_CODE.trim()))) {
    if (!(await bump(env, ANON, ipB, LIMITS.reset, t))) throw tooMany(LIMITS.reset.lockMs / 1000);
    throw new HttpError(401, 'That setup code is not right. It is the SETUP_CODE you chose when you set up this copy.');
  }
  if (!(await claimOpen(env))) throw new HttpError(403, 'This Study Hub already has its owner. Sign in instead.');
  const display = String(name || '').trim().slice(0, 60);
  if (!display) throw new HttpError(400, 'Please give your name.');
  checkNewPassword(password);
  const track = platformProfile(profile);
  const keep = id != null && id !== '' ? String(id).toLowerCase() : null;
  if (keep && !validUserId(keep)) throw new HttpError(400, 'That login name cannot be used.');
  const user = keep || makeUsername(display);
  const hash = await hashPassword(password);
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  // One batch, so two people racing with the code cannot both get in: the credentials row is only written while
  // there is none, and the batch is one transaction.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, name, role, profile, profile_json, prefs_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(user, display, 'student', track, JSON.stringify(obj(profile_json)), JSON.stringify(obj(prefs)), 'active', t, t),
    env.DB.prepare('INSERT INTO credentials (user_id, password_hash, must_change, email, changed_at, created_at) SELECT ?, ?, 0, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM credentials)')
      .bind(user, hash, t, t),
    env.DB.prepare('INSERT INTO ai_settings (user_id, updated_at) VALUES (?, ?)').bind(user, t),
  ]);
  const mine = await env.DB.prepare('SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?').bind(user).first();
  if (!mine || mine.n !== 1) {
    await env.DB.batch([env.DB.prepare('DELETE FROM ai_settings WHERE user_id = ?').bind(user), env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user)]);
    throw new HttpError(403, 'This Study Hub already has its owner. Sign in instead.');
  }
  const s = await newSession(env, user, request, t, [clearBucket(env, ANON, ipB)]);
  return { user, name: display, profile: track, must_change: false, ...s };
}

// A fresh invite link for someone who lost theirs (older invites stop working). Also a way back in for
// someone who forgot their password and has no email: the invite lets them choose a new one.
export async function issueInvite(env, admin, userId) {
  const acct = await accountRow(env, userId);
  if (!acct || acct.status === 'deleted') throw new HttpError(404, 'There is no such account.');
  const invite = randomToken(24);
  const t = io.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE auth_codes SET used_at = ? WHERE user_id = ? AND kind = 'invite' AND used_at IS NULL").bind(t, userId),
    env.DB.prepare('INSERT INTO auth_codes (user_id, id, kind, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(userId, await sha256Hex('invite:' + invite.toUpperCase()), 'invite', String(admin || MO), t, t + INVITE_MS),
  ]);
  return { id: userId, invite, invite_expires_at: t + INVITE_MS };
}

export async function listAccounts(env) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.role, u.profile, u.status, u.created_at, c.must_change, c.email IS NOT NULL AS has_email,
       (SELECT MAX(s.last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen
     FROM users u JOIN credentials c ON c.user_id = u.id ORDER BY u.created_at`).all();
  return results.map(r => ({ ...r, must_change: !!r.must_change, has_email: !!r.has_email }));
}

async function accountRow(env, userId) {
  return env.DB.prepare('SELECT u.id, u.name, u.role, u.profile, u.status, c.password_hash, c.must_change, c.email FROM users u JOIN credentials c ON c.user_id = u.id WHERE u.id = ? AND c.user_id = ?')
    .bind(userId, userId).first();
}

// paused or deleted: every session ends at once.
export async function setStatus(env, admin, userId, status) {
  if (!['active', 'paused', 'deleted'].includes(status)) throw new HttpError(400, 'Status must be active, paused or deleted.');
  const acct = await accountRow(env, userId);
  if (!acct) throw new HttpError(404, 'There is no such account.');
  const t = io.now();
  const stmts = [env.DB.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').bind(status, t, userId)];
  if (status !== 'active') stmts.push(...revokeAllStatements(env, userId, t, null, { links: true }));
  await env.DB.batch(stmts);
  return { id: userId, status };
}

// Ends sessions (all, or all but keep) and unused codes; with links, also every connector link (resets and
// pausing: someone who once held a session cannot keep a connector after the owner takes the account back).
function revokeAllStatements(env, userId, t, keep = null, { links = false } = {}) {
  return [
    ...(links ? [env.DB.prepare('UPDATE connector_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(t, userId)] : []),
    keep
      ? env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL').bind(t, userId, keep)
      : env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(t, userId),
    env.DB.prepare('UPDATE auth_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(t, userId),
  ];
}

export async function issueResetCode(env, admin, userId) {
  const acct = await accountRow(env, userId);
  if (!acct || acct.status === 'deleted') throw new HttpError(404, 'There is no such account.');
  const code = generateCode();
  const t = io.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE auth_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL").bind(t, userId),
    env.DB.prepare('INSERT INTO auth_codes (user_id, id, kind, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(userId, await sha256Hex('code:' + code), 'reset', String(admin || MO), t, t + RESET_CODE_MS),
  ]);
  return { id: userId, code, expires_at: t + RESET_CODE_MS };
}

// ------------------------------------------------------------------ rate limits

// An IPv6 address counts by its /64 (one home or phone network hands out a whole /64), IPv4 by the address.
export function ipKey(ip) {
  const a = String(ip || 'unknown').trim().toLowerCase();
  if (!a.includes(':')) return a;
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [], tl = a.includes('::') && tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - tl.length)).fill('0'), ...tl] : h;
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

async function ipBucket(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return 'ip:' + (await sha256Hex('ip:' + ipKey(ip))).slice(0, 32);
}

async function limitRow(env, owner, bucket) {
  return env.DB.prepare('SELECT window_start, count, locked_until FROM rate_limits WHERE user_id = ? AND bucket = ?').bind(owner, bucket).first();
}

// Seconds to wait, or 0 when the bucket is open.
export async function lockedFor(env, owner, bucket, t = io.now()) {
  const r = await limitRow(env, owner, bucket);
  return r && r.locked_until && r.locked_until > t ? Math.ceil((r.locked_until - t) / 1000) : 0;
}

// One more attempt in the bucket's window; locks the bucket when it goes over the limit.
export async function bump(env, owner, bucket, { limit, windowMs, lockMs }, t = io.now()) {
  const r = await env.DB.prepare(
    `INSERT INTO rate_limits (user_id, bucket, window_start, count) VALUES (?, ?, ?, 1)
     ON CONFLICT (user_id, bucket) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start <= ? THEN excluded.window_start ELSE rate_limits.window_start END
     RETURNING count`).bind(owner, bucket, t, t - windowMs, t - windowMs).first();
  if (r && r.count > limit) {
    await env.DB.prepare('UPDATE rate_limits SET locked_until = ? WHERE user_id = ? AND bucket = ?').bind(t + lockMs, owner, bucket).run();
    return false;
  }
  return true;
}

const clearBucket = (env, owner, bucket) => env.DB.prepare('DELETE FROM rate_limits WHERE user_id = ? AND bucket = ?').bind(owner, bucket);

const tooMany = secs => new HttpError(429, `Too many tries. Please wait ${Math.max(1, Math.ceil(secs / 60))} minute${secs > 60 ? 's' : ''} and try again.`);

// ------------------------------------------------------------------ sign in, sessions

// A hash to compare against when the name is unknown, so a wrong name takes as long as a wrong password.
let dummyHash = null;
const dummy = async () => (dummyHash ||= await hashPassword(randomToken(16)));

const normName = u => String(u || '').trim().toLowerCase().slice(0, 60);

export async function login(env, request, { username, password } = {}) {
  const name = normName(username);
  const t = io.now();
  const ipB = await ipBucket(request);
  const userB = 'login:' + name;
  const [ipWait, userWait] = await Promise.all([lockedFor(env, ANON, ipB, t), lockedFor(env, ANON, userB, t)]);
  if (ipWait || userWait) throw tooMany(Math.max(ipWait, userWait));
  if (!(await bump(env, ANON, ipB, LIMITS.ip, t))) throw tooMany(LIMITS.ip.lockMs / 1000);
  // Every attempt is counted (atomically) before the password is checked, so parallel guesses cannot all
  // pass the lock; a right password clears the count.
  if (!(await bump(env, ANON, userB, LIMITS.user, t))) throw tooMany(LIMITS.user.lockMs / 1000);
  const acct = validUserId(name) ? await accountRow(env, name) : null;
  // An unknown name, or an account whose invite is unused, takes as long as a wrong password.
  const real = acct && String(acct.password_hash).startsWith('pbkdf2-');
  const ok = real ? await verifyPassword(String(password || ''), acct.password_hash) : (await verifyPassword(String(password || ''), await dummy()), false);
  if (!ok || acct.status !== 'active') {
    // Same words whether the name, the password or the account's status was wrong.
    throw new HttpError(401, 'That name and password do not match.');
  }
  const stmts = [clearBucket(env, ANON, userB)];
  if (needsRehash(acct.password_hash)) stmts.push(env.DB.prepare('UPDATE credentials SET password_hash = ? WHERE user_id = ?').bind(await hashPassword(password), acct.id));
  const s = await newSession(env, acct.id, request, t, stmts);
  return { user: acct.id, name: acct.name, profile: acct.profile, must_change: !!acct.must_change, ...s };
}

async function newSession(env, userId, request, t, extra = []) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const id = await sha256Hex('session:' + token);
  const device = String(request.headers.get('User-Agent') || '').slice(0, 120) || null;
  await env.DB.batch([
    ...extra,
    env.DB.prepare('INSERT INTO sessions (user_id, id, csrf, created_at, last_seen, expires_at, device) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(userId, id, csrf, t, t, t + SESSION_MS, device),
  ]);
  return { token, csrf, session_id: id, expires_at: t + SESSION_MS };
}

export function readCookie(request, name = SESSION_COOKIE) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export const sessionCookie = (token, maxAgeMs = SESSION_MS) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

// The signed-in person for this request, or null: {user, session_id, csrf, must_change, name, profile}.
export async function resolveSession(env, request) {
  const token = readCookie(request);
  if (!token || token.length < 20 || token.length > 100) return null;
  const id = await sha256Hex('session:' + token);
  const t = io.now();
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.id, s.csrf, s.last_seen, s.expires_at, s.revoked_at, u.status, u.name, u.profile, u.prefs_json, c.must_change
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN credentials c ON c.user_id = s.user_id WHERE s.id = ?`).bind(id).first();
  if (!row || row.revoked_at || row.expires_at <= t || row.last_seen + IDLE_MS <= t || row.status !== 'active') return null;
  if (row.user_id === MO) return null;
  if (t - row.last_seen > TOUCH_MS) {
    await env.DB.prepare('UPDATE sessions SET last_seen = ? WHERE user_id = ? AND id = ?').bind(t, row.user_id, row.id).run();
  }
  return { user: row.user_id, session_id: row.id, csrf: row.csrf, must_change: !!row.must_change, name: row.name, profile: row.profile, prefs_json: row.prefs_json };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

// A write needs the session's CSRF token in X-CSRF-Token, and a browser's Origin (when sent) must be ours.
export async function checkCsrf(request, session) {
  if (SAFE.has(request.method)) return true;
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return false;
  return safeEqual(request.headers.get(CSRF_HEADER) || '', session.csrf);
}

export async function logout(env, session) {
  await env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id = ?').bind(io.now(), session.user, session.session_id).run();
}

// Signed in: change the password; every other session ends.
export async function changePassword(env, user, session, { current, password } = {}) {
  checkNewPassword(password);
  const t0 = io.now();
  if (await lockedFor(env, user, 'password', t0) || !(await bump(env, user, 'password', LIMITS.user, t0))) throw tooMany(LIMITS.user.lockMs / 1000);
  const acct = await accountRow(env, user);
  if (!acct || !(await verifyPassword(String(current || ''), acct.password_hash))) throw new HttpError(401, 'Your current password is not right.');
  if (current === password) throw new HttpError(400, 'Please choose a new password, different from the old one.');
  const t = io.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE credentials SET password_hash = ?, must_change = 0, changed_at = ? WHERE user_id = ?').bind(await hashPassword(password), t, user),
    ...revokeAllStatements(env, user, t, session && session.session_id),
    clearBucket(env, user, 'password'),
  ]);
  return { ok: true };
}

export async function setEmail(env, user, email) {
  const mail = cleanEmail(email);
  await env.DB.prepare('UPDATE credentials SET email = ? WHERE user_id = ?').bind(mail, user).run();
  return { has_email: !!mail };
}

// ------------------------------------------------------------------ resets

async function consumeCode(env, request, kind, code, password, userHint = null) {
  checkNewPassword(password);
  const t = io.now();
  const ipB = 'reset:' + (await ipBucket(request));
  const wait = await lockedFor(env, ANON, ipB, t);
  if (wait) throw tooMany(wait);
  const id = await sha256Hex(({ reset: 'code:', email_reset: 'email:', invite: 'invite:' })[kind] + String(code || '').trim().toUpperCase());
  const row = await env.DB.prepare('SELECT a.user_id, a.kind, a.expires_at, a.used_at, u.status FROM auth_codes a JOIN users u ON u.id = a.user_id WHERE a.id = ?').bind(id).first();
  const good = row && row.kind === kind && !row.used_at && row.expires_at > t && (!userHint || row.user_id === userHint);
  // A paused or deleted account cannot be taken back with an old code or link.
  if (good && row.status !== 'active') throw new HttpError(403, 'This account is paused. Ask Mo.');
  if (!good) {
    if (!(await bump(env, ANON, ipB, LIMITS.reset, t))) throw tooMany(LIMITS.reset.lockMs / 1000);
    throw new HttpError(400, 'That reset code is not right or has expired. Ask for a new one.');
  }
  const user = row.user_id;
  // Claim the code first, so two requests racing with it cannot both use it.
  const claim = await env.DB.prepare('UPDATE auth_codes SET used_at = ? WHERE user_id = ? AND id = ? AND used_at IS NULL').bind(t, user, id).run();
  if (!claim.meta || claim.meta.changes !== 1) throw new HttpError(400, 'That reset code has already been used.');
  await env.DB.batch([
    env.DB.prepare('UPDATE credentials SET password_hash = ?, must_change = 0, changed_at = ? WHERE user_id = ?').bind(await hashPassword(password), t, user),
    ...revokeAllStatements(env, user, t, null, { links: true }),
    clearBucket(env, ANON, 'login:' + user),
  ]);
  return { ok: true, user };
}

// The invite link: the person chooses their password and is signed in at once.
export async function acceptInvite(env, request, { token, password } = {}) {
  const r = await consumeCode(env, request, 'invite', token, password);
  const acct = await accountRow(env, r.user);
  if (!acct || acct.status !== 'active') throw new HttpError(403, 'This account is paused. Ask Mo.');
  const s = await newSession(env, acct.id, request, io.now());
  return { user: acct.id, name: acct.name, profile: acct.profile, must_change: false, ...s };
}

export async function resetWithCode(env, request, { username, code, password } = {}) {
  return consumeCode(env, request, 'reset', code, password, normName(username));
}

// Self-service: always the same answer, so it never says which addresses have accounts.
export const EMAIL_SENT = 'If that address belongs to an account, a reset link is on its way.';
export async function requestEmailReset(env, request, { email } = {}, origin) {
  if (!emailResetOn(env)) throw new HttpError(404, 'Email resets are not switched on. Ask Mo for a reset code.');
  let mail;
  try { mail = cleanEmail(email); } catch { return { message: EMAIL_SENT }; }
  if (!mail) return { message: EMAIL_SENT };
  const t = io.now();
  const ipB = 'mail:' + (await ipBucket(request));
  if (await lockedFor(env, ANON, ipB, t) || !(await bump(env, ANON, ipB, LIMITS.reset, t))) return { message: EMAIL_SENT };
  const row = await env.DB.prepare("SELECT c.user_id FROM credentials c JOIN users u ON u.id = c.user_id WHERE c.email = ? AND u.status = 'active'").bind(mail).first();
  if (!row) return { message: EMAIL_SENT };
  const token = randomToken(24);
  await env.DB.batch([
    env.DB.prepare("UPDATE auth_codes SET used_at = ? WHERE user_id = ? AND kind = 'email_reset' AND used_at IS NULL").bind(t, row.user_id),
    env.DB.prepare('INSERT INTO auth_codes (user_id, id, kind, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(row.user_id, await sha256Hex('email:' + token.toUpperCase()), 'email_reset', 'self', t, t + EMAIL_RESET_MS),
  ]);
  const link = `${origin}/platform.html#reset=${token}`;
  try {
    await io.sendMail(env, { to: mail, subject: 'Reset your study hub password', text: `Open this link within 30 minutes to choose a new password:\n\n${link}\n\nIf you did not ask for this, you can ignore this email.` });
  } catch (e) {
    console.error('reset email failed', e && e.message);
  }
  return { message: EMAIL_SENT };
}

export async function resetWithEmailToken(env, request, { token, password } = {}) {
  if (!emailResetOn(env)) throw new HttpError(404, 'Email resets are not switched on. Ask Mo for a reset code.');
  return consumeCode(env, request, 'email_reset', token, password);
}

// ------------------------------------------------------------------ connector keys

// A new connector address for the person's own Claude: /mcp/u/<token>. Shown once.
export async function createConnectorKey(env, user, label) {
  if (!validUserId(user)) throw new HttpError(403, 'Connector keys are for platform accounts.');
  if (String(label || '').trim().toLowerCase() === 'anki') throw new HttpError(400, 'Make your Anki key in Settings > Link your Anki.');
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM connector_keys WHERE user_id = ? AND revoked_at IS NULL').bind(user).first();
  if (n >= 5) throw new HttpError(400, 'You already have 5 connector links. Remove one first.');
  const token = 'pk_' + randomToken(32);
  const id = await sha256Hex('connector:' + token);
  await env.DB.prepare('INSERT INTO connector_keys (user_id, id, label, created_at) VALUES (?, ?, ?, ?)').bind(user, id, String(label || 'Claude').slice(0, 40), io.now()).run();
  return { id: id.slice(0, 12), token, path: `/mcp/u/${token}` };
}

export async function listConnectorKeys(env, user) {
  const { results } = await env.DB.prepare("SELECT substr(id, 1, 12) AS id, label, created_at, last_used_at FROM connector_keys WHERE user_id = ? AND revoked_at IS NULL AND coalesce(label, '') != 'anki' ORDER BY created_at").bind(user).all();
  return results;
}

// Their one Anki push key (label 'anki'): a new one replaces the old. It is not a Claude connector (userForConnector).
export async function createAnkiKey(env, user) {
  if (!validUserId(user)) throw new HttpError(403, 'Anki keys are for platform accounts.');
  const token = 'pk_' + randomToken(32);
  const id = await sha256Hex('connector:' + token);
  const t = io.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE connector_keys SET revoked_at = ? WHERE user_id = ? AND label = 'anki' AND revoked_at IS NULL").bind(t, user),
    env.DB.prepare("INSERT INTO connector_keys (user_id, id, label, created_at) VALUES (?, ?, 'anki', ?)").bind(user, id, t),
  ]);
  return { token };
}

export async function revokeConnectorKey(env, user, shortId) {
  const r = await env.DB.prepare('UPDATE connector_keys SET revoked_at = ? WHERE user_id = ? AND substr(id, 1, 12) = ? AND revoked_at IS NULL').bind(io.now(), user, String(shortId || '')).run();
  if (!r.meta || r.meta.changes === 0) throw new HttpError(404, 'There is no such connector link.');
  return { ok: true };
}

export async function userForConnector(env, token) {
  if (typeof token !== 'string' || !/^pk_[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const id = await sha256Hex('connector:' + token);
  const row = await env.DB.prepare(
    "SELECT k.user_id, k.last_used_at FROM connector_keys k JOIN users u ON u.id = k.user_id WHERE k.id = ? AND k.revoked_at IS NULL AND u.status = 'active' AND coalesce(k.label, '') != 'anki'").bind(id).first();
  if (!row || row.user_id === MO) return null;
  const t = io.now();
  if (!row.last_used_at || t - row.last_used_at > TOUCH_MS) {
    await env.DB.prepare('UPDATE connector_keys SET last_used_at = ? WHERE user_id = ? AND id = ?').bind(t, row.user_id, id).run();
  }
  return row.user_id;
}

// For tests and the self-check: random bytes are available.
export const _random = randomBytes;
