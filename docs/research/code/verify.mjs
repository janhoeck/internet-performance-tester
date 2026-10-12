// Verifies the node:crypto re-implementation against the router's OWN sjcl.js +
// sjclCrypto.js, executed in an isolated node:vm sandbox (no require/process/fetch/net).
// Usage: node verify.mjs
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as ref from './arris-crypto.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(here, '..', '..'); // scratchpad/
const sjclSrc = readFileSync(join(here, 'downloaded', 'sjcl.js'), 'utf8');
const wrapSrc = readFileSync(join(scratch, 'router', 'scripts_sjclCrypto.js'), 'utf8');
const tv = JSON.parse(readFileSync(join(here, 'testvectors.json'), 'utf8'));

// Minimal sandbox: NO require, NO process, NO fetch, NO XHR, NO net. Just a window
// shim so sjcl's feature-detection does not throw. sjcl.random is never invoked.
const sandbox = { window: {}, console: { log() {}, error() {} } };
sandbox.self = sandbox; sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(sjclSrc, ctx, { filename: 'sjcl.js', timeout: 5000 });
vm.runInContext(wrapSrc, ctx, { filename: 'sjclCrypto.js', timeout: 5000 });

function callSjcl(fn, ...args) {
  ctx.__args = args;
  return vm.runInContext(`${fn}.apply(null, __args)`, ctx, { timeout: 5000 });
}

const results = [];
function check(name, a, b) {
  const ok = a === b;
  results.push({ name, ok, sjcl: a, node: b });
  if (!ok) console.error(`MISMATCH ${name}\n  sjcl: ${a}\n  node: ${b}`);
}

// 1) PBKDF2 derived key
const keySjcl = callSjcl('sjclPbkdf2', tv.password, tv.salt, tv.iterations, tv.keySizeBits);
const keyNode = ref.sjclPbkdf2(tv.password, tv.salt, tv.iterations, tv.keySizeBits);
check('pbkdf2', keySjcl, keyNode);

// 2) CCM encrypt of the login payload (aad 'loginPassword')
const encSjcl = callSjcl('sjclCCMencrypt', keySjcl, tv.loginPlaintext, tv.iv, tv.encAad, tv.tagLenBits);
const encNode = ref.sjclCCMencrypt(keyNode, tv.loginPlaintext, tv.iv, tv.encAad, tv.tagLenBits);
check('ccm.encrypt(loginPassword)', encSjcl, encNode);

// 3) CCM decrypt round-trips back to the plaintext (both impls)
const decBySjcl = callSjcl('sjclCCMdecrypt', keySjcl, encSjcl, tv.iv, tv.encAad, tv.tagLenBits);
const decByNode = ref.sjclCCMdecrypt(keyNode, encSjcl, tv.iv, tv.encAad, tv.tagLenBits);
check('ccm.decrypt roundtrip == plaintext (sjcl)', decBySjcl, tv.loginPlaintext);
check('ccm.decrypt roundtrip == plaintext (node)', decByNode, tv.loginPlaintext);

// 4) Cross decrypt: node decrypts what sjcl encrypted, sjcl decrypts what node encrypted
check('node decrypts sjcl ciphertext', ref.sjclCCMdecrypt(keyNode, encSjcl, tv.iv, tv.encAad, tv.tagLenBits), tv.loginPlaintext);
check('sjcl decrypts node ciphertext', callSjcl('sjclCCMdecrypt', keySjcl, encNode, tv.iv, tv.encAad, tv.tagLenBits), tv.loginPlaintext);

// 5) csrf_nonce path: encrypt a value with aad 'nonce' in sjcl, decrypt with node (and vice versa)
const nonceCipherSjcl = callSjcl('sjclCCMencrypt', keySjcl, tv.decPlaintext, tv.iv, tv.decAad, tv.tagLenBits);
check('node decrypts sjcl nonce-ciphertext (aad nonce)', ref.sjclCCMdecrypt(keyNode, nonceCipherSjcl, tv.iv, tv.decAad, tv.tagLenBits), tv.decPlaintext);
const nonceCipherNode = ref.sjclCCMencrypt(keyNode, tv.decPlaintext, tv.iv, tv.decAad, tv.tagLenBits);
check('sjcl decrypts node nonce-ciphertext (aad nonce)', callSjcl('sjclCCMdecrypt', keySjcl, nonceCipherNode, tv.iv, tv.decAad, tv.tagLenBits), tv.decPlaintext);
check('nonce ciphertext byte-equal (aad nonce)', nonceCipherSjcl, nonceCipherNode);

const allOk = results.every(r => r.ok);
console.log(JSON.stringify({ allOk, derivedKey: keyNode, loginCipher: encNode, results }, null, 2));
process.exit(allOk ? 0 : 1);
