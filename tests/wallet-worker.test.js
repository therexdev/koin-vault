'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { fork, spawn } = require('node:child_process');
const { once } = require('node:events');
const { processIdentity, sameProcess } = require('../tools/process-identity');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-workers-'));
  const children = [];
  const stop = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  };
  const delay = () => new Promise(resolve => setTimeout(resolve, 30));
  async function start(dataDir, identity) {
    const child = fork(path.join(__dirname, 'fixtures/wallet-worker-child.js'), [], {
      env: { PATH: process.env.PATH, WORKER_TEST_DIR: dataDir, ...(identity ? { WORKER_TEST_ID: identity } : {}) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    let logs = ''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker did not start: ' + logs)), 6000);
      child.once('message', message => { clearTimeout(timer); message.fatal ? reject(new Error(message.fatal)) : resolve(message); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Worker exited: ' + code + ' ' + logs)); });
    });
    return { child, ...info };
  }
  const read = async worker => {
    const response = await fetch(worker.url + '/api/echo');
    return { status: response.status, data: await response.json() };
  };
  async function awaitReady(workers) {
    for (let i = 0; i < 150; i++) {
      const responses = await Promise.all(workers.map(read));
      if (responses.every(r => r.status === 200)) return responses;
      await delay();
    }
    throw new Error('Workers failed to recover');
  }
  try {
    const workers = await Promise.all(Array.from({ length: 5 }, () => start(dir)));
    const first = await awaitReady(workers);
    const owner = first[0].data.pid;
    assert.ok(first.every(r => r.data.pid === owner));
    assert.equal(fs.readFileSync(path.join(dir, 'owners'), 'utf8').trim(), String(owner));
    const follower = workers.find(w => w.pid !== owner);
    const body = JSON.stringify({ request: 'one request', address: 'fixture' });
    const echo = await (await fetch(follower.url + '/api/echo', { method: 'POST', body })).json();
    assert.equal(echo.body, body); assert.equal(echo.ip, '127.0.0.42');

    // The private listener cannot be used without its proof, even on loopback.
    const denied = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: follower.endpoint.port, path: '/api/echo' }, res => {
        res.resume(); resolve(res.statusCode);
      });
      req.once('error', reject); req.end();
    });
    assert.equal(denied, 403);
    const alien = await start(dir, 'different-wallet');
    const mismatch = await fetch(alien.url + '/api/drop', { method: 'POST', body: 'must not arrive' });
    assert.equal(mismatch.status, 503); assert.match((await mismatch.json()).error, /does not match/);
    assert.equal(fs.existsSync(path.join(dir, 'submissions')), false, 'Different identity never discloses its body to the owner');
    await stop(alien.child);

    const lost = await fetch(follower.url + '/api/drop', { method: 'POST', body: 'one submission' });
    assert.equal(lost.status, 503);
    assert.equal((await lost.json()).code, 'WALLET_WORKER_RESPONSE_LOST');
    assert.equal(fs.readFileSync(path.join(dir, 'submissions'), 'utf8'), 'one submission\n', 'A lost response does not replay a POST');
    console.log('✓ Five simultaneous starts elect one writer; forwarding preserves bodies/IP; identity and local-request authentication; no POST replay');

    await stop(workers.find(w => w.pid === owner).child);
    const survivors = workers.filter(w => w.pid !== owner);
    const second = await awaitReady(survivors);
    assert.ok(second.every(r => r.data.pid === second[0].data.pid && r.data.pid !== owner));
    const owners = fs.readFileSync(path.join(dir, 'owners'), 'utf8').trim().split('\n');
    assert.equal(owners.length, 2, 'Only one replacement initializes after a crash');
    for (const worker of survivors) await stop(worker.child);

    // A release without coordination may still be finishing during deployment.
    const legacyDir = path.join(dir, 'legacy'); fs.mkdirSync(legacyDir);
    const legacy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); children.push(legacy);
    fs.writeFileSync(path.join(legacyDir, 'funding-worker.lock'), String(legacy.pid));
    const waiting = await start(legacyDir);
    assert.equal((await read(waiting)).status, 503);
    assert.equal(fs.readFileSync(path.join(legacyDir, 'funding-worker.lock'), 'utf8'), String(legacy.pid));
    await stop(legacy);
    assert.equal((await awaitReady([waiting]))[0].data.pid, waiting.pid);
    await stop(waiting.child);
    console.log('✓ Crash takeover and legacy rollout waits recover automatically without stealing an active lock');

    const current = processIdentity(process.pid);
    assert.equal(sameProcess(current, { ...current, host: 'another-host' }), null);
    assert.equal(sameProcess({ pid: process.pid }, current), null, 'Legacy lock stays conservative');
    if (current.start && current.namespace) {
      assert.equal(sameProcess(current, current), true);
      assert.equal(sameProcess({ ...current, start: String(BigInt(current.start) - 1n) }, current), false);
      const reusedDir = path.join(dir, 'reused'); fs.mkdirSync(reusedDir);
      fs.writeFileSync(path.join(reusedDir, 'funding-worker.lock'), String(process.pid));
      fs.writeFileSync(path.join(reusedDir, 'funding-worker.lock.owner.json'), JSON.stringify({ ...current, start: '0' }));
      const reclaimed = await start(reusedDir);
      assert.equal((await awaitReady([reclaimed]))[0].data.pid, reclaimed.pid);
      await stop(reclaimed.child);
    }
    console.log('✓ PID reuse is distinguished from a living worker; unknown identities fail closed');
  } finally {
    await Promise.all(children.map(stop));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
