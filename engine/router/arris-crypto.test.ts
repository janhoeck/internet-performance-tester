// Verifies the node:crypto re-implementation of the ARRIS sjclCrypto.js wrappers against the fixed
// test vector (docs/research/code/testvectors.json) and the byte-exact cipher from router-api.md §a.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AAD_LOGIN,
  AAD_NONCE,
  buildLoginRequest,
  isHex,
  loginPlaintext,
  readCsrfNonce,
  sjclCcmDecrypt,
  sjclCcmEncrypt,
  sjclPbkdf2,
  sjclPbkdf2Async,
} from './arris-crypto';

interface Vectors {
  password: string;
  salt: string;
  iv: string;
  iterations: number;
  keySizeBits: number;
  tagLenBits: number;
  loginPlaintext: string;
  encAad: string;
  decAad: string;
  decPlaintext: string;
}

const tv = JSON.parse(
  readFileSync(new URL('../../docs/research/code/testvectors.json', import.meta.url), 'utf8'),
) as Vectors;

// byte-exact expectations recorded in docs/research/router-api.md §a (verified against the router's sjcl.js)
const DERIVED_KEY = '249082069e5104592beaece2a76446dd';
const LOGIN_CIPHER =
  '7e66d67ae1de39bb88f060cb940d0eb947f973841242ffe71b788a152dfdb9f5e3605e13574376e579106557a5e2242fd6a8ea912afec352f1be6ad50bd6b752586bef2d4e15b625080ec4d05c7a793bea746519668b7f528fe1';

describe('sjclPbkdf2', () => {
  it('derives the verified 128-bit key (salt hex-decoded, 1000 iters, HMAC-SHA256)', () => {
    expect(sjclPbkdf2(tv.password, tv.salt, tv.iterations, tv.keySizeBits)).toBe(DERIVED_KEY);
  });

  it('async variant matches the sync one', async () => {
    await expect(sjclPbkdf2Async(tv.password, tv.salt)).resolves.toBe(DERIVED_KEY);
  });

  it('uses defaults (1000 iterations, 128 bit) without explicit params', () => {
    expect(sjclPbkdf2(tv.password, tv.salt)).toBe(DERIVED_KEY);
  });
});

describe('sjclCcmEncrypt / sjclCcmDecrypt', () => {
  const pt = loginPlaintext(tv.password, 'df59fc3de28c9f18d95a162836aa298b');

  it('builds the login plaintext with a space after ":" and "," (router-exact)', () => {
    expect(pt).toBe(tv.loginPlaintext);
    expect(pt).toContain('"Password": "');
    expect(pt).toContain('", "Nonce": "');
  });

  it('encrypts the login payload byte-exact (aad loginPassword)', () => {
    expect(sjclCcmEncrypt(DERIVED_KEY, pt, tv.iv, AAD_LOGIN)).toBe(LOGIN_CIPHER);
  });

  it('round-trips ciphertext back to the plaintext', () => {
    const c = sjclCcmEncrypt(DERIVED_KEY, pt, tv.iv, AAD_LOGIN);
    expect(sjclCcmDecrypt(DERIVED_KEY, c, tv.iv, AAD_LOGIN)).toBe(pt);
  });

  it('verifies the auth tag: a flipped byte throws', () => {
    const c = sjclCcmEncrypt(DERIVED_KEY, pt, tv.iv, AAD_LOGIN);
    const broken = `${c.slice(0, -2)}${c.endsWith('00') ? '01' : '00'}`;
    expect(() => sjclCcmDecrypt(DERIVED_KEY, broken, tv.iv, AAD_LOGIN)).toThrow();
  });

  it('a wrong AAD fails decryption', () => {
    const c = sjclCcmEncrypt(DERIVED_KEY, pt, tv.iv, AAD_LOGIN);
    expect(() => sjclCcmDecrypt(DERIVED_KEY, c, tv.iv, AAD_NONCE)).toThrow();
  });

  it('rejects a ciphertext shorter than the tag', () => {
    expect(() => sjclCcmDecrypt(DERIVED_KEY, 'abcd', tv.iv, AAD_LOGIN)).toThrow(/too short/);
  });
});

describe('buildLoginRequest / readCsrfNonce', () => {
  it('produces the verified POST body and a key that decrypts the csrf nonce', async () => {
    const { key, body } = await buildLoginRequest(
      tv.password,
      'admin',
      'df59fc3de28c9f18d95a162836aa298b',
      tv.salt,
      tv.iv,
    );
    expect(key).toBe(DERIVED_KEY);
    expect(body).toEqual({ EncryptData: LOGIN_CIPHER, Name: 'admin', AuthData: 'loginPassword' });

    // the router answers encryptData encrypted with aad 'nonce'; our key must decrypt it
    const encryptData = sjclCcmEncrypt(key, tv.decPlaintext, tv.iv, AAD_NONCE);
    expect(readCsrfNonce(key, encryptData, tv.iv)).toBe(tv.decPlaintext);
  });

  it('readCsrfNonce extracts the leading hex run even with trailing noise', () => {
    const key = sjclPbkdf2(tv.password, tv.salt);
    const encryptData = sjclCcmEncrypt(key, `${tv.decPlaintext}\u0000padding`, tv.iv, AAD_NONCE);
    expect(readCsrfNonce(key, encryptData, tv.iv)).toBe(tv.decPlaintext);
  });
});

describe('isHex', () => {
  it('accepts even-length hex, optionally of a fixed byte length', () => {
    expect(isHex('c1697be73d452e75', 8)).toBe(true);
    expect(isHex('c1697be73d452e75')).toBe(true);
    expect(isHex('c1697be73d452e75', 16)).toBe(false);
    expect(isHex('xyz')).toBe(false);
    expect(isHex('abc')).toBe(false); // odd length
    expect(isHex('')).toBe(false);
    expect(isHex(123 as unknown)).toBe(false);
  });
});
