// Platform crypto: password hashing, the AES-GCM secret box for AI keys, tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, needsRehash, PBKDF2_ROUNDS, seal, open, keyHint, generatePassword, generateCode, randomToken, b64url, fromB64url, safeEqual } from '../../worker/src/platform/crypto.js';

const SECRET = 'test-platform-secret-0123456789abcdef-xyz';

test('passwords: PBKDF2 at the Workers maximum, salted, verifiable, wrong ones refused', async () => {
  const h = await hashPassword('correct horse battery');
  assert.match(h, new RegExp(`^pbkdf2-sha256\\$${PBKDF2_ROUNDS}\\$[A-Za-z0-9_-]{22}\\$[A-Za-z0-9_-]{43}$`));
  assert.equal(PBKDF2_ROUNDS, 100_000, 'Workers refuse more than 100,000 PBKDF2 rounds');
  assert.notEqual(h, await hashPassword('correct horse battery'), 'a fresh salt each time');
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('correct horse batterY', h), false);
  assert.equal(await verifyPassword('', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2-sha256$999999999$aa$bb'), false, 'absurd round counts are refused, not run');
  assert.equal(needsRehash(h), false);
  assert.equal(needsRehash(await hashPassword('old one', 2000)), true);
  assert.equal(await verifyPassword('old one', await hashPassword('old one', 2000)), true, 'older, weaker hashes still verify (then get rehashed)');
});

test('secret box: round trip, never plaintext at rest, bound to its owner and purpose', async () => {
  const key = 'sk-ant-api03-THIS-IS-A-FAKE-KEY-abcd';
  const box = await seal(SECRET, key, 'sara-k7m2|ai_key|anthropic');
  assert.match(box, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.ok(!box.includes('sk-ant') && !box.includes('FAKE'), 'the key is not readable in the stored value');
  assert.notEqual(box, await seal(SECRET, key, 'sara-k7m2|ai_key|anthropic'), 'a fresh IV each time');
  assert.equal(await open(SECRET, box, 'sara-k7m2|ai_key|anthropic'), key);
  assert.equal(await open(SECRET, box, 'adam-p2q3|ai_key|anthropic'), null, "copied onto another user's row, it will not open");
  assert.equal(await open(SECRET, box, 'sara-k7m2|ai_key|openai'), null, 'nor as another provider');
  assert.equal(await open('another-secret-0123456789abcdef-0000', box, 'sara-k7m2|ai_key|anthropic'), null, 'nor with another Worker secret');
  const parts = box.split('.');
  // A middle character: the last one can be only padding bits, so changing it may change no byte at all.
  const mid = Math.floor(parts[2].length / 2);
  const flipped = parts[2].slice(0, mid) + (parts[2][mid] === 'A' ? 'B' : 'A') + parts[2].slice(mid + 1);
  assert.equal(await open(SECRET, `v1.${parts[1]}.${flipped}`, 'sara-k7m2|ai_key|anthropic'), null, 'tampering is detected');
  assert.equal(await open(SECRET, 'nonsense', 'x'), null);
  await assert.rejects(seal('short', key, 'a'), /PLATFORM_SECRET/);
  await assert.rejects(seal('32 or more random characters (openssl rand -hex 32)', key, 'a'), /PLATFORM_SECRET/, "the template's example value is refused");
  assert.equal(keyHint(key), '…abcd');
  assert.equal(keyHint('short'), '…');
});

test('tokens, generated passwords and codes', async () => {
  const t = randomToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(t, randomToken());
  const pw = generatePassword();
  assert.match(pw, /^[a-hjkmnp-z2-9]{5}(-[a-hjkmnp-z2-9]{5}){3}$/, 'no look-alike characters (0, o, 1, l, i)');
  assert.match(generateCode(), /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.deepEqual([...fromB64url(b64url(new Uint8Array([0, 255, 128, 7])))], [0, 255, 128, 7]);
  assert.equal(await safeEqual('abc', 'abc'), true);
  assert.equal(await safeEqual('abc', 'abd'), false);
  assert.equal(await safeEqual('abc', null), false);
});
