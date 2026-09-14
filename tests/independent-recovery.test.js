'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chain = require('../tools/chain');
const veive = require('../tools/veive');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-independent-'));
const address = require('koilib').Signer.fromSeed('independent-recovery-fixture').getAddress();
const kit = 'rk-activated-recovery-credential';
const passkey = 'existing-vault-passkey-credential';
(async () => {
  // Simulate only public chain reads; no legacy server or account files exist.
  chain.veiveReady = () => true;
  chain.credentialAddress = async id => [kit, passkey].includes(id) ? address : null;
  chain.credentialRegisteredFor = async (owner, id) => owner === address && [kit, passkey].includes(id);
  chain.accountModules = async () => [chain.K.modules.modSign, chain.K.modules.modValidation];
  veive.configure({ dataDir: dir, demo: false });
  assert.equal(veive.status(kit), null);
  assert.equal((await veive.whoami(kit)).address, address);
  await veive.ensureReady(address);
  assert.equal((await veive.whoami(passkey)).address, address);
  assert.equal(await veive.whoami('rk-unactivated-credential'), null);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json')));
  assert.equal(saved.accounts[address].bootstrapWif, '');
  assert.equal(saved.accounts[address].external, true);
  assert.equal(veive.accountsCreatedSince(0), 0);
  veive.configure({ dataDir: dir, demo: false });
  assert.equal(veive.status(kit).address, address);
  assert.equal(veive.status(passkey).address, address);
  assert.deepEqual(veive.credentialsFor(address), [kit, passkey]);
  console.log('✓ Empty backend rediscovers recovery and Vault credentials, persists across restart, and rejects unknown kits');
})().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
