// node:crypto re-implementation of the ARRIS sjclCrypto.js wrapper functions.
// Pure Node 22, no external deps. This is the reference the TS adapter will use.
import { pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';

// Wrapper for sjcl.misc.pbkdf2.
//   password: ascii/utf8 string
//   saltHex:  hex string (sjcl wrapper HEX-DECODES the salt before use)
//   iterations: integer (router uses 1000)
//   keySizeBits: integer (router uses 128)
// returns derived key as hex string.
export function sjclPbkdf2(password, saltHex, iterations = 1000, keySizeBits = 128) {
  const salt = Buffer.from(saltHex, 'hex');
  const dk = pbkdf2Sync(password, salt, iterations, keySizeBits / 8, 'sha256');
  return dk.toString('hex');
}

// Wrapper for sjcl.mode.ccm.encrypt (AES-CCM).
//   keyHex:   derived key, hex string
//   plaintext: utf8 string
//   ivHex:    nonce, hex string (router IV is 8 bytes -> 16 hex chars)
//   aad:      utf8 string ('loginPassword' for login, 'ARRIS' post-login, 'nonce' for csrf)
//   tagLenBits: 128
// returns hex(ciphertext || tag).
export function sjclCCMencrypt(keyHex, plaintext, ivHex, aad, tagLenBits = 128) {
  const key = Buffer.from(keyHex, 'hex');
  const nonce = Buffer.from(ivHex, 'hex');
  const pt = Buffer.from(plaintext, 'utf8');
  const aadBuf = Buffer.from(aad, 'utf8');
  const authTagLength = tagLenBits / 8;
  const cipher = createCipheriv('aes-128-ccm', key, nonce, { authTagLength });
  cipher.setAAD(aadBuf, { plaintextLength: pt.length });
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ct, tag]).toString('hex');
}

// Wrapper for sjcl.mode.ccm.decrypt (AES-CCM).
//   cipherHex: hex(ciphertext || tag)
// returns utf8 plaintext string.
export function sjclCCMdecrypt(keyHex, cipherHex, ivHex, aad, tagLenBits = 128) {
  const key = Buffer.from(keyHex, 'hex');
  const nonce = Buffer.from(ivHex, 'hex');
  const aadBuf = Buffer.from(aad, 'utf8');
  const authTagLength = tagLenBits / 8;
  const buf = Buffer.from(cipherHex, 'hex');
  const ct = buf.subarray(0, buf.length - authTagLength);
  const tag = buf.subarray(buf.length - authTagLength);
  const decipher = createDecipheriv('aes-128-ccm', key, nonce, { authTagLength });
  decipher.setAAD(aadBuf, { plaintextLength: ct.length });
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}
