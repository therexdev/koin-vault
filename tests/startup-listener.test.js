'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { once } = require('node:events');
const { Signer } = require('koilib');
(async () => {
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-startup-'));
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `
    require(${JSON.stringify(path.join(root, 'tools/rpc'))}).pickRpcs = () => new Promise(() => {});
    const chain = require(${JSON.stringify(path.join(root, 'tools/chain'))});
    chain.mana = chain.koinBalance = () => new Promise(() => {});
    const funding = require(${JSON.stringify(path.join(root, 'tools/funding'))});
    funding.floatHealth = funding._sdkReady = () => new Promise(() => {});
    if (process.env.WALLET_BACKEND_URL && process.env.WALLET_BACKEND_URL !== 'local') {
      funding.configure = () => { throw new Error('Frontend must never start a funding worker'); };
      require(${JSON.stringify(path.join(root, 'tools/veive'))}).configure = () => { throw new Error('Frontend must never open accounts'); };
    }
  `);
  const data = path.join(dir, 'data'); fs.mkdirSync(data);
  const account = Signer.fromSeed('startup-existing-fixture').getAddress();
  const credentialId = 'existing-passkey-credential';
  fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify({ accounts: {
    [account]: { address: account, credentialId, credentials: [{ id: credentialId, kind: 'passkey' }], step: 'active', external: true },
  }, byCredential: { [credentialId]: account } }));
  fs.writeFileSync(path.join(data, 'funding.json'), '{}');
  const saved = fs.readFileSync(path.join(data, 'accounts.json'));
  const children = [];
  async function start(backendUrl = 'local', dataDir = data) {
    const portServer = http.createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
    const port = portServer.address().port; await new Promise(r => portServer.close(r));
    const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
      cwd: root, env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: dataDir,
        ...(backendUrl === 'local' ? {} : { WALLET_BACKEND_URL: backendUrl }), KOINOS_NETWORK: 'mainnet', DEMO_MODE: '0',
        PUBLIC_URL: backendUrl === 'local' ? 'https://wallet.usekoinos.com' : 'https://koinvault.app',
        PASSKEY_RPID: backendUrl === 'local' ? 'wallet.usekoinos.com' : 'koinvault.app',
        SPONSOR_WIF: Signer.fromSeed('startup-test-only-sponsor').getPrivateKey('wif'),
        VERIFIER_ADDR: account, MOD_SIGN_WEBAUTHN_ADDR: account, MOD_VALIDATION_SIGNATURE_ADDR: account },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let logs = ''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
    const base = 'http://127.0.0.1:' + port;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base)).status === 200) return { child, base, logs: () => logs }; } catch (_) {}
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error('HTTP did not start: ' + logs);
  }
  async function stop(child, signal = 'SIGTERM') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(signal); await exited;
  }
  async function waitUntilReady(server) {
    for (let i = 0; i < 100; i++) {
      if ((await fetch(server.base + '/api/health')).status === 200) return;
      await new Promise(r => setTimeout(r, 80));
    }
    throw new Error('Wallet did not recover: ' + server.logs());
  }
  try {
    const primary = await start();
    const health = await fetch(primary.base + '/api/health');
    assert.equal(health.status, 200, primary.logs());
    assert.deepEqual(await health.json(), { ok: true, demo: false, network: 'mainnet' });
    const config = await fetch(primary.base + '/api/config', { signal: AbortSignal.timeout(1000) });
    assert.equal(config.status, 200, 'Stalled Koinos and ETH probes cannot block configuration');
    assert.equal((await config.json()).demo, false);
    const who = await fetch(primary.base + '/api/whoami', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId }) });
    assert.equal((await who.json()).address, account);
    assert.equal(fs.readFileSync(path.join(data, 'funding-worker.lock'), 'utf8'), String(primary.child.pid));
    const frontend = await start(primary.base);
    const frontendConfig = await (await fetch(frontend.base + '/api/config')).json();
    assert.equal(frontendConfig.demo, false);
    assert.equal(frontendConfig.rpId, 'koinvault.app');
    assert.equal((await (await fetch(primary.base + '/api/config')).json()).rpId, 'wallet.usekoinos.com');
    const same = await fetch(frontend.base + '/api/whoami', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId }) });
    assert.equal((await same.json()).address, account);
    assert.match(frontend.logs(), /ready: wallet frontend/);
    const connection = await (await fetch(frontend.base + '/api/dapp/create', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ouro.lifestyle' }, body: JSON.stringify({ name: 'OURO' }) })).json();
    assert.ok(connection.uri.startsWith('https://koinvault.app/'));
    for (const origin of ['https://usekoinos.com', 'https://www.usekoinos.com', 'https://unlisted-developer.example']) {
      const headers = { Origin: origin, 'Content-Type': 'application/json' };
      const preflight = await fetch(frontend.base + '/api/dapp/create', { method: 'OPTIONS', headers });
      assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
      const created = await fetch(frontend.base + '/api/dapp/create', { method: 'POST', headers, body: JSON.stringify({ name: 'Use Koinos' }) });
      assert.equal(created.status, 200);
      assert.equal(created.headers.get('access-control-allow-origin'), origin);
      const pair = await created.json();
      assert.equal(new URL(pair.uri).origin, 'https://koinvault.app');
      const status = await fetch(frontend.base + '/api/dapp/status?' + new URLSearchParams({ sessionId: pair.sessionId, secret: pair.secret }), { headers });
      assert.equal(status.headers.get('access-control-allow-origin'), origin);
      assert.equal((await status.json()).connected, false);
      const wrong = await fetch(frontend.base + '/api/dapp/status?' + new URLSearchParams({ sessionId: pair.sessionId, secret: pair.secret }), { headers: { Origin: 'https://different.example' } });
      assert.equal(wrong.status, 403, 'A different site cannot use this session even with the bearer secret');
    }
    const denied = await fetch(frontend.base + '/api/dapp/create', { method: 'POST', headers: { Origin: 'http://insecure.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    for (const route of ['challenge', 'connect', 'pending', 'approve', 'reject']) {
      const attempt = await fetch(frontend.base + '/api/dapp/' + route, { method: 'OPTIONS', headers: { Origin: 'https://unlisted-developer.example' } });
      assert.equal(attempt.status, 403, 'Wallet-only API is not exposed by open CORS');
    }
    const proofBody = JSON.stringify({ sessionId: connection.sessionId, secret: connection.secret, address: account });
    const readQuery = new URLSearchParams({ sessionId: connection.sessionId, secret: connection.secret });
    for (const route of ['pending', 'status']) {
      for (const headers of [{ 'Sec-Fetch-Site': 'same-origin' }, { Referer: 'https://koinvault.app/' }]) {
        assert.equal((await fetch(frontend.base + '/api/dapp/' + route + '?' + readQuery, { headers })).status, 200,
          'Wallet browser GET without Origin must work through the proxy');
      }
      for (const headers of [{}, { 'Sec-Fetch-Site': 'cross-site', Referer: 'https://unlisted-developer.example/' }]) {
        assert.equal((await fetch(frontend.base + '/api/dapp/' + route + '?' + readQuery, { headers })).status, 403);
      }
    }
    assert.equal((await fetch(frontend.base + '/api/dapp/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://koinvault.app' }, body: proofBody })).status, 200);
    assert.equal((await fetch(frontend.base + '/api/dapp/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: proofBody })).status, 403);
    assert.equal(fs.readFileSync(path.join(data, 'funding-worker.lock'), 'utf8'), String(primary.child.pid));
    console.log('✓ Both real HTTP app processes use one account store and one funding lock; each domain keeps its own passkey settings');
    const second = await start();
    const blocked = await fetch(second.base + '/api/health');
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).code, 'WALLET_RESTART_PENDING');
    assert.match(second.logs(), /Another funding worker/);
    await new Promise(r => setTimeout(r, 3300));
    assert.equal((await fetch(second.base + '/api/config')).status, 503, 'Retries must not bypass a live owner');
    assert.equal(fs.readFileSync(path.join(data, 'funding-worker.lock'), 'utf8'), String(primary.child.pid));
    assert.deepEqual(fs.readFileSync(path.join(data, 'accounts.json')), saved);
    assert.equal((await fetch(primary.base + '/api/health')).status, 200);
    await stop(second.child);
    assert.equal(fs.readFileSync(path.join(data, 'funding-worker.lock'), 'utf8'), String(primary.child.pid), 'Stopping a waiter must not remove the owner lock');

    const replacement = await start();
    assert.equal((await fetch(replacement.base + '/api/health')).status, 503);
    await stop(primary.child);
    assert.equal(fs.existsSync(path.join(data, 'funding-worker.lock')), false, 'SIGTERM releases the exiting worker lock');
    await waitUntilReady(replacement);
    assert.equal(fs.readFileSync(path.join(data, 'funding-worker.lock'), 'utf8'), String(replacement.child.pid));
    const restored = await fetch(replacement.base + '/api/whoami', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId }) });
    assert.equal((await restored.json()).address, account, 'Restart loads the original account');
    assert.deepEqual(fs.readFileSync(path.join(data, 'accounts.json')), saved);
    assert.equal(fs.readFileSync(path.join(data, 'funding.json'), 'utf8'), '{}', 'Waiting and restarting preserve the funding ledger');
    console.log('✓ Restart waits for a live worker, preserves both stores, and recovers automatically after the owner exits');

    await stop(replacement.child, 'SIGKILL');
    assert.equal(fs.readFileSync(path.join(data, 'funding-worker.lock'), 'utf8'), String(replacement.child.pid));
    const afterCrash = await start();
    assert.equal((await fetch(afterCrash.base + '/api/health')).status, 200, 'A dead owner lock is recovered after a hard crash');
    assert.equal(fs.readFileSync(path.join(data, 'funding-worker.lock'), 'utf8'), String(afterCrash.child.pid));
    await stop(afterCrash.child, 'SIGINT');
    assert.equal(fs.existsSync(path.join(data, 'funding-worker.lock')), false, 'SIGINT also releases the exiting worker lock');

    const brokenData = path.join(dir, 'broken'); fs.mkdirSync(brokenData);
    fs.writeFileSync(path.join(brokenData, 'funding.json'), '{broken');
    const broken = await start('local', brokenData);
    const failed = await fetch(broken.base + '/api/config');
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).code, 'WALLET_STARTUP_FAILED');
    assert.match(broken.logs(), /funding ledger could not be read/);
    assert.doesNotMatch(broken.logs(), /Wallet startup waiting/);
    assert.equal(fs.readFileSync(path.join(brokenData, 'funding.json'), 'utf8'), '{broken');
    console.log('✓ Signal cleanup and dead-owner recovery work; unreadable ledgers remain a fatal startup error');
  } finally {
    await Promise.all(children.map(child => stop(child)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
