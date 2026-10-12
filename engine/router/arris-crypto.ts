// node:crypto re-implementation of the ARRIS sjclCrypto.js wrappers used by the Vodafone Station
// web UI login (verified byte-exact against the router's own sjcl.js, docs/research/router-api.md §a).
//  - PBKDF2-HMAC-SHA256, salt HEX-DECODED, 1000 iterations, 128-bit key
//  - AES-128-CCM, nonce = 8-byte IV (16 hex chars), 16-byte tag, AAD = UTF-8 string
//  - ciphertext format: hex(ciphertext ‖ tag)
import { createCipheriv, createDecipheriv, pbkdf2, pbkdf2Sync } from 'node:crypto';

export const SJCL_ITERATIONS = 1000;
export const SJCL_KEY_BITS = 128;
export const SJCL_TAG_BITS = 128;

/** AAD strings used by the router GUI. */
export const AAD_LOGIN = 'loginPassword';
export const AAD_NONCE = 'nonce';

/** sjclPbkdf2(password, saltHex, 1000, 128) → derived key as hex. */
export function sjclPbkdf2(password: string, saltHex: string, iterations = SJCL_ITERATIONS, keySizeBits = SJCL_KEY_BITS): string {
  return pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), iterations, keySizeBits / 8, 'sha256').toString('hex');
}

/** Same as sjclPbkdf2 but off the event loop (libuv thread pool). */
export function sjclPbkdf2Async(password: string, saltHex: string, iterations = SJCL_ITERATIONS, keySizeBits = SJCL_KEY_BITS): Promise<string> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, Buffer.from(saltHex, 'hex'), iterations, keySizeBits / 8, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

/** AES-128-CCM encrypt → hex(ciphertext ‖ tag). */
export function sjclCcmEncrypt(keyHex: string, plaintext: string, ivHex: string, aad: string, tagLenBits = SJCL_TAG_BITS): string {
  const authTagLength = tagLenBits / 8;
  const pt = Buffer.from(plaintext, 'utf8');
  const cipher = createCipheriv('aes-128-ccm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'), { authTagLength });
  cipher.setAAD(Buffer.from(aad, 'utf8'), { plaintextLength: pt.length });
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]).toString('hex');
}

/** AES-128-CCM decrypt of hex(ciphertext ‖ tag); verifies the tag (throws on mismatch). */
export function sjclCcmDecrypt(keyHex: string, cipherHex: string, ivHex: string, aad: string, tagLenBits = SJCL_TAG_BITS): string {
  const authTagLength = tagLenBits / 8;
  const buf = Buffer.from(cipherHex, 'hex');
  if (buf.length < authTagLength) throw new Error('ciphertext too short');
  const ct = buf.subarray(0, buf.length - authTagLength);
  const tag = buf.subarray(buf.length - authTagLength);
  const d = createDecipheriv('aes-128-ccm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'), { authTagLength });
  d.setAuthTag(tag);
  d.setAAD(Buffer.from(aad, 'utf8'), { plaintextLength: ct.length });
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/**
 * Login plaintext exactly as the router GUI builds it (space after ':' and ','):
 * `{"Password": "<pw>", "Nonce": "<currentSessionId>"}`.
 */
export function loginPlaintext(password: string, sessionId: string): string {
  return `{"Password": "${password}", "Nonce": "${sessionId}"}`;
}

export interface LoginRequestBody {
  EncryptData: string;
  Name: string;
  AuthData: string;
}

/** Body for POST /php/ajaxSet_Password.php plus the derived key (needed to decrypt the csrf nonce). */
export async function buildLoginRequest(
  password: string, username: string, sessionId: string, saltHex: string, ivHex: string,
): Promise<{ key: string; body: LoginRequestBody }> {
  const key = await sjclPbkdf2Async(password, saltHex);
  const EncryptData = sjclCcmEncrypt(key, loginPlaintext(password, sessionId), ivHex, AAD_LOGIN);
  return { key, body: { EncryptData, Name: username, AuthData: AAD_LOGIN } };
}

/** Decrypt the login response's `encryptData` (AAD 'nonce') → csrf nonce (leading hex run). */
export function readCsrfNonce(keyHex: string, encryptDataHex: string, ivHex: string): string {
  const pt = sjclCcmDecrypt(keyHex, encryptDataHex, ivHex, AAD_NONCE).trim();
  const m = /^[0-9a-fA-F]{16,}/.exec(pt);
  return m ? m[0] : pt;
}

/** true for an even-length hex string of the given byte length (optional). */
export function isHex(s: unknown, bytes?: number): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return false;
  return bytes === undefined || s.length === bytes * 2;
}
