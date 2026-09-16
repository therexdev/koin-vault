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
const signer = Signer.fromSeed('transaction-history-http-fixture');
const address = signer.getAddress();
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-history-'));
  let historyCalls = 0;
  const rpc = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    assert.equal(data.method, 'account_history.get_account_history');
    assert.equal(data.params.address, address); assert.equal(data.params.ascending, false);
    historyCalls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: data.id, result: {} }));
  });
  const rpcPort = await listen(rpc);
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `
    const veive = require(${JSON.stringify(path.join(root, 'tools/veive'))});
    veive.configure = () => {}; veive.reconcile = () => {};
    const funding = require(${JSON.stringify(path.join(root, 'tools/funding'))});
    funding.configure = () => {}; funding._sdkReady = async () => {};
    funding._solRail = () => ({enabled: false, reason: 'HTTP test'});
  `);
  async function run(demo) {
    const reservation = http.createServer(); const port = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const child = spawn(process.execPath, ['--require', preload, 'server.js'], { cwd: root,
      env: { PATH: process.env.PATH, PORT: String(port), KOINOS_NETWORK: 'mainnet', DEMO_MODE: demo ? '1' : '0',
        WALLET_BACKEND_URL: 'local', KOINOS_HISTORY_RPC: 'http://127.0.0.1:' + rpcPort,
        DATA_DIR: dir, SPONSOR_WIF: signer.getPrivateKey('wif'),
        VERIFIER_ADDR: address, MOD_SIGN_WEBAUTHN_ADDR: address, MOD_VALIDATION_SIGNATURE_ADDR: address },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = ''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
    const base = 'http://127.0.0.1:' + port;
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try { ready = (await fetch(base + '/api/transactions?address=' + address)).status === 200; } catch (_) {}
        if (ready) break; await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.ok(ready, logs);
      const before = historyCalls;
      for (const prefix of ['', '/android']) {
        const response = await fetch(base + prefix + '/api/transactions?address=' + address);
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        const data = await response.json(); assert.equal(data.address, address); assert.deepEqual(data.items, []);
        assert.equal(!!data.demo, demo); assert.equal(data.nextCursor, null);
        assert.equal((await fetch(base + prefix + '/api/transactions?address=invalid')).status, 400);
        if (!demo) assert.equal((await fetch(base + prefix + '/api/transactions?address=' + address + '&cursor=-1')).status, 400);
        assert.equal((await fetch(base + prefix + '/api/transactions?address=' + address, { method: 'POST' })).status, 404);
        const html = await (await fetch(base + (prefix || '') + '/')).text();
        assert.ok(html.includes('id="transactions"')); assert.ok(html.includes('/js/transactions.js'));
      }
      if (demo) assert.equal(historyCalls, before, 'Demo cannot access live history');
    } finally {
      child.kill(); if (child.exitCode === null) await once(child, 'exit');
    }
  }
  try { await run(false); await run(true); console.log('✓ Live and demo history API, address/cursor validation, no-store and Android routing'); }
  finally { rpc.closeAllConnections(); await new Promise(resolve => rpc.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
