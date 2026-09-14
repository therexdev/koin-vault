'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { Signer } = require('koilib');
const root = path.resolve(__dirname, '..');
const fixture = label => Signer.fromSeed('vault-http-test-' + label);
const owner = fixture('owner').getAddress(), recipient = fixture('recipient').getAddress(), token = fixture('token').getAddress();
const modules = { verifier: fixture('verifier').getAddress(), modSign: fixture('sign').getAddress(), modValidation: fixture('validation').getAddress() };
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-token-http-'));
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume the body */ }
    calls.push(req.url); res.setHeader('Content-Type', 'application/json');
    // An unchanged account backend does not advertise or support custom sends.
    if (req.url.endsWith('/api/config')) return res.end(JSON.stringify({ ok: true, demo: false, network: 'mainnet', modules, rpId: 'wallet.usekoinos.com', sendAssets: ['koin', 'vhp'] }));
    if (req.url === '/api/whoami') return res.end(JSON.stringify({ ok: true, address: owner }));
    if (req.url === '/api/prepare') return res.end(JSON.stringify({ ok: true, asset: 'vhp', ref: 'upstream-native' }));
    res.writeHead(404); res.end(JSON.stringify({ error: 'Old backend has no such endpoint' }));
  });
  const backendUrl = await listen(upstream);
  const reservation = http.createServer(); await listen(reservation);
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `
    const chain = require(${JSON.stringify(path.join(root, 'tools/chain'))});
    require(${JSON.stringify(path.join(root, 'tools/veive'))}).configure = () => { throw new Error('Vault must not open account records'); };
    require(${JSON.stringify(path.join(root, 'tools/funding'))}).configure = () => { throw new Error('Vault must not start funding'); };
    chain.accountModules = async () => ${JSON.stringify(Object.values(modules))};
    chain.tokenMeta = async () => ({ symbol: 'KCT', decimals: 6 });
    chain.tokenBalanceSats = async () => '9007199254740993';
    chain.provider = () => ({ getAccountRc: async () => '2000000000' });
    chain.prepareUserTx = async (address, operations) => ({ id: 'http-token-tx', header: { payer: chain.sponsorAddress(), payee: address }, operations });
    chain.verifyPasskeyOnChain = async (_account, signature) => ({ ok: signature === 'verified-passkey' });
    chain.submitSmartCosigned = async tx => tx.id;
  `);
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: root, env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: path.join(dir, 'unused-data'),
      WALLET_BACKEND_URL: backendUrl, PUBLIC_URL: 'https://koinvault.app', PASSKEY_RPID: 'koinvault.app',
      KOINOS_NETWORK: 'mainnet', SPONSOR_WIF: fixture('sponsor').getPrivateKey('wif'),
      VERIFIER_ADDR: modules.verifier, MOD_SIGN_WEBAUTHN_ADDR: modules.modSign, MOD_VALIDATION_SIGNATURE_ADDR: modules.modValidation },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
  const base = 'http://127.0.0.1:' + port;
  const post = (url, body, origin = 'https://koinvault.app') => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  });
  try {
    let running = false;
    for (let i = 0; i < 80; i++) {
      try { running = (await fetch(base)).status === 200; } catch (_) {}
      if (running) break; await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.ok(running, logs);
    for (const prefix of ['', '/android']) {
      const config = await (await fetch(base + prefix + '/api/config')).json();
      assert.equal(config.sendCustomTokens, true); assert.equal(config.rpId, 'koinvault.app');
      const request = { address: owner, to: recipient, asset: token, amount: '1.234567' };
      const response = await post(prefix + '/api/token/prepare', request);
      assert.equal(response.status, 200, await response.clone().text());
      const prep = await response.json();
      assert.equal(prep.transfer.units, '1234567'); assert.equal(prep.tx.operations[0].call_contract.contract_id, token);
      const body = { ref: prep.ref, transaction: { ...prep.tx, signatures: ['verified-passkey'] } };
      assert.equal((await post(prefix + '/api/token/submit', body)).status, 200);
      assert.equal((await post(prefix + '/api/token/submit', body)).status, 400);
      assert.equal((await post(prefix + '/api/token/prepare', request, 'https://evil.example')).status, 403);
      assert.equal((await fetch(base + prefix + '/api/token/prepare')).status, 405);
    }
    assert.equal((await (await post('/api/whoami', { credentialId: 'existing-passkey' })).json()).address, owner);
    assert.equal((await (await post('/api/prepare', { address: owner, asset: 'vhp', amount: '1' })).json()).ref, 'upstream-native');
    assert.ok(!calls.some(url => url.includes('/api/token/')), 'No custom transfer request reaches the old backend');
    assert.equal(fs.existsSync(path.join(dir, 'unused-data')), false, 'The Vault transfer service never opens a second account/funding store');
    console.log('✓ Web and Android custom sends run on Vault with an unchanged upstream; sign-in and native sends still forward');
  } finally {
    child.kill(); if (child.exitCode === null) await once(child, 'exit');
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
