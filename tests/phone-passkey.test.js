'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto').webcrypto;
const script = fs.readFileSync(path.join(__dirname, '../public/js/passkey.js'), 'utf8');
(async () => {
  const storage = new Map(), requests = [];
  let attachment = 'cross-platform', fail = false;
  const rawId = Uint8Array.from([11, 22, 33]).buffer;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('spki', pair.publicKey);
  const answer = async (method, request) => {
    requests.push({ method, ...request.publicKey });
    if (fail) { const e = new Error('Prompt closed'); e.name = 'NotAllowedError'; throw e; }
    return { rawId, authenticatorAttachment: attachment, response: { getPublicKey: () => publicKey,
      signature: new Uint8Array([1, 2]).buffer, authenticatorData: new Uint8Array(37).buffer,
      clientDataJSON: new TextEncoder().encode('{}').buffer } };
  };
  function load() {
    const PublicKeyCredential = { isUserVerifyingPlatformAuthenticatorAvailable: async () => false };
    const context = vm.createContext({
      crypto, btoa, atob, Uint8Array, PublicKeyCredential,
      window: { isSecureContext: true, PublicKeyCredential }, location: { hostname: 'koinvault.app' },
      localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
      navigator: { credentials: { create: r => answer('create', r), get: r => answer('get', r) } },
    });
    vm.runInContext(script, context); return vm.runInContext('Passkey', context);
  }
  let passkey = load();
  assert.equal(passkey.supported(), true); assert.equal(await passkey.platformReady(), false);
  const created = await passkey.createCredential({ usePhone: true });
  assert.equal(requests.at(-1).hints[0], 'hybrid');
  assert.equal(requests.at(-1).authenticatorSelection.authenticatorAttachment, undefined, 'Phone preference must not exclude synced passkeys');
  assert.equal(requests.at(-1).timeout, 120000, 'Allow time to scan the phone QR code');
  assert.equal(requests.at(-1).authenticatorSelection.userVerification, 'required');
  assert.equal(requests.at(-1).authenticatorSelection.residentKey, 'required');
  assert.equal(requests.at(-1).pubKeyCredParams[0].alg, -7);
  assert.equal(created.publicKey, Buffer.from(publicKey).toString('base64url'));
  passkey = load(); // Signing preferences survive reopening the desktop page.
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const proof = await passkey.assert(challenge, [created.credentialId]);
  assert.equal(requests.at(-1).hints[0], 'hybrid');
  assert.equal(requests.at(-1).userVerification, 'required');
  assert.deepEqual(requests.at(-1).challenge, challenge, 'The real transaction challenge is retained');
  assert.deepEqual(Buffer.from(requests.at(-1).allowCredentials[0].id), Buffer.from(rawId));
  assert.equal(requests.at(-1).allowCredentials[0].transports, undefined, 'Do not exclude phone or security-key transports');
  assert.equal(proof.credentialId, created.credentialId);
  await passkey.identify(true, { usePhone: true });
  assert.equal(requests.at(-1).allowCredentials.length, 0, 'Phone sign-in discovers the phone credential, ignoring stale desktop IDs');
  assert.equal(requests.at(-1).rpId, 'koinvault.app');
  await passkey.identify(true, { usePhone: false });
  assert.equal(requests.at(-1).hints, undefined, 'The saved-passkey choice overrides an earlier phone preference');
  assert.equal(requests.at(-1).allowCredentials.length, 0, 'All synced passkeys remain discoverable');
  assert.equal(requests.at(-1).timeout, 120000);
  const count = requests.filter(r => r.method === 'create').length;
  fail = true; await assert.rejects(passkey.identify(true, { usePhone: true }), { name: 'NotAllowedError' });
  assert.equal(requests.filter(r => r.method === 'create').length, count, 'A cancelled phone sign-in never creates a key');
  fail = false; attachment = 'platform';
  await passkey.createCredential();
  assert.equal(requests.at(-1).authenticatorSelection.authenticatorAttachment, undefined, 'Default creation no longer excludes other devices');
  await passkey.assert(challenge, [created.credentialId]);
  assert.equal(requests.at(-1).hints, undefined, 'Local passkeys do not inherit a phone preference');
  passkey.forget(); assert.equal(storage.size, 0);
  console.log('✓ Phone creation/discovery, required user verification, transaction signing, persistent phone preference and cancellation');
})().catch(error => { console.error(error); process.exitCode = 1; });
