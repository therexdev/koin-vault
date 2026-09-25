'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { once } = require('node:events');
const { Signer } = require('koilib');
async function run(hostMode) {
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-startup-'));
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `
    require(${JSON.stringify(path.join(root, 'tests/fixtures/managed-http-preload'))});
    require(${JSON.stringify(path.join(root, 'tools/rpc'))}).pickRpcs = () => new Promise(() => {});
    const chain = require(${JSON.stringify(path.join(root, 'tools/chain'))});
    chain.mana = chain.koinBalance = () => new Promise(() => {});
    const funding = require(${JSON.stringify(path.join(root, 'tools/funding'))});
    funding.floatHealth = funding._sdkReady = () => new Promise(() => {});
    const policy = require(${JSON.stringify(path.join(root, 'tools/dapp-policy'))});
    const createBudget = policy.createBudget;
    policy.createBudget = options => {
      const fs = require('node:fs');
      const result = createBudget(options);
      fs.appendFileSync(require('node:path').join(process.env.DATA_DIR, 'budget-loads'), JSON.stringify({
        pid: process.pid, value: fs.existsSync(options.file) ? JSON.parse(fs.readFileSync(options.file, 'utf8')) : null,
      }) + '\\n');
      return result;
    };
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
  async function start(backendUrl = 'local') {
    const portServer = http.createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
    const port = portServer.address().port; await new Promise(r => portServer.close(r));
    const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
      cwd: root, env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: data, MANAGED_HTTP_TEST: hostMode,
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
  try {
    const primary = await start();
    const health = await fetch(primary.base + '/api/health');
    if (hostMode === 'denied') {
      assert.equal(health.status, 503);
      const failure = await health.json();
      assert.equal(failure.code, 'WALLET_WORKER_START_FAILED');
      assert.match(failure.error, /could not start/);
      assert.doesNotMatch(JSON.stringify(failure), new RegExp(dir));
      assert.match(primary.logs(), /code=EACCES/);
      assert.equal(fs.existsSync(path.join(data, 'funding-worker.lock')), false);
      assert.deepEqual(fs.readFileSync(path.join(data, 'accounts.json')), saved);
      console.log('✓ A denied private listener reports a startup failure, logs the cause, and never opens the ledger');
      return;
    }
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
      const secureResponse = await fetch(frontend.base + '/api/dapp/create', { method: 'POST', headers, body: JSON.stringify({ name: 'Trade Koinos', protocolVersion: 2 }) });
      const securePair = await secureResponse.json();
      assert.equal(securePair.protocolVersion, 2);
      const secureUri = new URL(securePair.uri), fragment = new URLSearchParams(secureUri.hash.slice(1));
      assert.equal(secureUri.origin, 'https://koinvault.app'); assert.equal(secureUri.search, '');
      assert.equal(fragment.get('connect'), securePair.sessionId); assert.equal(fragment.get('secret'), securePair.secret);
      const credentials = JSON.stringify({ sessionId: securePair.sessionId, secret: securePair.secret });
      const secureStatus = await fetch(frontend.base + '/api/dapp/status', { method: 'POST', headers, body: credentials });
      assert.equal(secureStatus.status, 200); assert.equal((await secureStatus.json()).connected, false);
      assert.equal(secureStatus.headers.get('cache-control'), 'no-store');
      for (const endpoint of ['status', 'request-status']) {
        const wrongPost = await fetch(frontend.base + '/api/dapp/' + endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://different.example' }, body: credentials });
        assert.equal(wrongPost.status, 403, 'POST polling preserves the session origin check');
        const missing = await fetch(frontend.base + '/api/dapp/' + endpoint, { method: 'POST', headers, body: JSON.stringify({ sessionId: securePair.sessionId }) });
        assert.equal(missing.status, 404, 'POST polling still needs the secret');
      }
      const walletPending = await fetch(frontend.base + '/api/dapp/pending', { method: 'POST', headers: { ...headers, Origin: 'https://koinvault.app' }, body: credentials });
      assert.equal(walletPending.status, 200);
      const foreignPending = await fetch(frontend.base + '/api/dapp/pending', { method: 'POST', headers, body: credentials });
      assert.equal(foreignPending.status, 403, 'POST does not expose the wallet-only pending queue');
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
    const [second, third] = await Promise.all([start(), start()]);
    for (const worker of [second, third]) {
      assert.equal((await fetch(worker.base + '/api/health')).status, 200, worker.logs());
      assert.match(worker.logs(), /forwarding to active wallet worker/);
      const who = await fetch(worker.base + '/api/whoami', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId }) });
      assert.equal((await who.json()).address, account);
      assert.equal((await fetch(worker.base + '/android/api/health')).status, 200);
    }
    const headers = { 'Content-Type': 'application/json', Origin: 'https://ouro.lifestyle' };
    const shared = await (await fetch(second.base + '/api/dapp/create', { method: 'POST', headers, body: JSON.stringify({ name: 'Shared session' }) })).json();
    const status = await fetch(third.base + '/api/dapp/status?' + new URLSearchParams({ sessionId: shared.sessionId, secret: shared.secret }), { headers });
    assert.equal(status.status, 200, 'All hosting processes use the same in-memory dapp sessions');
    assert.equal(fs.readFileSync(path.join(data, 'funding-worker.lock'), 'utf8'), String(primary.child.pid));
    assert.deepEqual(fs.readFileSync(path.join(data, 'accounts.json')), saved);
    assert.equal((await fetch(primary.base + '/api/health')).status, 200);
    console.log('✓ Three live HTTP processes share one writer, account store and dapp session state');

    const spentBudget = { day: new Date().toISOString().slice(0, 10), spent: { global: '1000000000' } };
    fs.writeFileSync(path.join(data, 'dapp-sponsorship.json'), JSON.stringify(spentBudget));
    assert.equal(fs.readFileSync(path.join(data, 'budget-loads'), 'utf8').trim().split('\n').length, 1,
      'Standbys do not preload a sponsorship budget that can become stale');
    const exited = once(primary.child, 'exit'); primary.child.kill('SIGKILL'); await exited;
    let recovered = false;
    for (let i = 0; i < 100; i++) {
      if ([second.child.pid, third.child.pid].includes(Number(fs.readFileSync(path.join(data, 'funding-worker.lock'), 'utf8')))
          && (await fetch(second.base + '/api/health')).status === 200
          && (await fetch(third.base + '/api/health')).status === 200) { recovered = true; break; }
      await new Promise(r => setTimeout(r, 40));
    }
    assert.ok(recovered, second.logs() + third.logs());
    assert.deepEqual(fs.readFileSync(path.join(data, 'accounts.json')), saved);
    const restored = await fetch(second.base + '/api/whoami', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId }) });
    assert.equal((await restored.json()).address, account);
    assert.equal(fs.readFileSync(path.join(data, 'funding.json'), 'utf8'), '{}');
    const budgets = fs.readFileSync(path.join(data, 'budget-loads'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(budgets.length, 2); assert.deepEqual(budgets[1].value, spentBudget, 'Takeover loads the latest persisted budget');
    console.log('✓ SIGKILL elects exactly one replacement automatically; both surviving processes recover without changing either ledger');
    assert.ok(children.length >= 4);
    for (const worker of [primary, second, third, frontend]) {
      assert.doesNotMatch(worker.logs(), /listen\(\) was called more than once/, 'Only the public listener goes through the hosting hook');
    }
    console.log('✓ Startup, forwarding and takeover on ' + (hostMode || 'plain Node'));
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill(); await exited;
    }));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
(async () => {
  for (const mode of (process.env.STARTUP_TEST_HOST ? [process.env.STARTUP_TEST_HOST] : ['', 'litespeed', 'passenger', 'denied'])) await run(mode);
})().catch(e => { console.error(e); process.exitCode = 1; });
