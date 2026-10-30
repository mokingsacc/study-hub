// The platform's crypto, all WebCrypto (no libraries): password hashing, the secret box for users' AI keys,
// random tokens and constant-time comparison. Nothing here touches the database.
//
// Passwords: PBKDF2-SHA256, 100,000 rounds (the most Workers allow), 16-byte salt, stored as
//   pbkdf2-sha256$<rounds>$<salt b64url>$<hash b64url>
// so the rounds can rise later without breaking old hashes (needsRehash says when).
// Secret box: AES-256-GCM with a key derived by HKDF from the PLATFORM_SECRET Worker secret, a fresh 12-byte
// IV per seal, and associated data naming the user and purpose, so a sealed key copied onto another user's
// row will not open. Stored as  v1.<iv b64url>.<ciphertext b64url>.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ROUNDS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export function b64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text) {
  const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));

// A URL-safe random token (sessions, invites, reset links, connector keys): 32 bytes is 256 bits.
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(String(text)));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string equality whatever the lengths (both sides are hashed first).
export async function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

async function pbkdf2(password, salt, rounds) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, key, HASH_BYTES * 8));
}

export async function hashPassword(password, rounds = PBKDF2_ROUNDS) {
  const salt = randomBytes(SALT_BYTES);
  return `pbkdf2-sha256$${rounds}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, rounds))}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const rounds = Number(parts[1]);
  if (!Number.isInteger(rounds) || rounds < 1000 || rounds > PBKDF2_ROUNDS) return false;
  let salt;
  try { salt = fromB64url(parts[2]); } catch { return false; }
  const got = b64url(await pbkdf2(password, salt, rounds));
  return safeEqual(got, parts[3]);
}

export const needsRehash = stored => !String(stored || '').startsWith(`pbkdf2-sha256$${PBKDF2_ROUNDS}$`);

// A password people can type on a phone: four words-ish chunks of unambiguous letters and digits, about 95 bits.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function generatePassword(groups = 4, size = 5) {
  const out = [];
  for (let g = 0; g < groups; g++) {
    let s = '';
    // Rejection sampling keeps every character equally likely.
    while (s.length < size) {
      const b = randomBytes(1)[0];
      if (b < 248) s += ALPHABET[b % ALPHABET.length];
    }
    out.push(s);
  }
  return out.join('-');
}

export const generateCode = () => generatePassword(2, 4).toUpperCase();

// ------------------------------------------------------------------ secret box

const boxKeys = new Map();
async function boxKey(secret) {
  if (!secret || String(secret).length < 32) throw new Error('PLATFORM_SECRET is not set (32+ characters).');
  if (boxKeys.has(secret)) return boxKeys.get(secret);
  const ikm = await crypto.subtle.importKey('raw', enc.encode(String(secret)), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('practice-hub-platform'), info: enc.encode('secret-box-v1') },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  boxKeys.set(secret, key);
  return key;
}

// aad binds the sealed value to its owner and purpose ('<user>|ai_key|anthropic').
export async function seal(secret, plaintext, aad) {
  const key = await boxKey(secret);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(String(aad)) }, key, enc.encode(String(plaintext)));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

// The plaintext, or null when the box is damaged, sealed for someone else, or sealed with another secret.
export async function open(secret, sealed, aad) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const key = await boxKey(secret);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(parts[1]), additionalData: enc.encode(String(aad)) }, key, fromB64url(parts[2]));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

// What the client may see of a key: its provider's shape and the last four characters.
export const keyHint = key => {
  const s = String(key || '');
  return s.length >= 12 ? `…${s.slice(-4)}` : '…';
};
