'use strict';
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');

// A kernel-owned listener elects one writer. Unlike a PID file, it cannot
// survive a crash. Extra hosting processes serve static files and relay API
// requests to that writer, including its in-memory signing/dapp sessions.
function endpointFor(dataDir, transport = process.env.WALLET_WORKER_TRANSPORT || 'auto') {
  const id = crypto.createHash('sha256').update(fs.realpathSync(dataDir)).digest('hex');
  if (!['auto', 'tcp'].includes(transport)) throw new Error('WALLET_WORKER_TRANSPORT must be auto or tcp');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (transport !== 'tcp' && process.platform === 'linux' && (major > 20 || (major === 20 && minor >= 8))) {
    // Kernel-owned namespace, not a file and not a shared hosting TCP port.
    // A crash releases it automatically; never unlink a live worker socket.
    return { path: '\0koin-vault-' + id, exclusive: true };
  }
  return { host: '127.0.0.1', port: 20000 + parseInt(id.slice(0, 8), 16) % 40000, exclusive: true };
}
const connectionFor = endpoint => endpoint.path ? { socketPath: endpoint.path } : { host: endpoint.host, port: endpoint.port };
const transportOf = endpoint => endpoint.path ? 'unix' : 'tcp';

const HEADER = 'x-koin-vault-worker';
const same = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function reply(res, status, error, code) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' });
  res.end(JSON.stringify({ error, ...(code ? { code } : {}) }));
}

function listenPrivate(server, endpoint) {
  return new Promise(resolve => {
    let settled = false;
    const done = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(error);
    };
    const timer = setTimeout(() => {
      server.close();
      done(Object.assign(new Error('Private wallet listener did not start'), { code: 'WALLET_WORKER_LISTEN_TIMEOUT' }));
    }, 5000);
    server.once('error', done);
    try {
      // Managed launchers (LiteSpeed / Passenger) intercept http.listen()
      // for the public app, ignoring or rejecting a second HTTP listener.
      // Use the inherited TCP implementation only for this private socket;
      // the public server still goes through the host's normal HTTP hook.
      net.Server.prototype.listen.call(server, endpoint, () => {
        if (settled) { server.close(); return; }
        const bound = net.Server.prototype.address.call(server);
        if (endpoint.path ? bound !== endpoint.path : (!bound || bound.address !== endpoint.host || bound.port !== endpoint.port)) {
          server.close();
          return done(Object.assign(new Error('Private wallet listener bound an unexpected endpoint'), { code: 'WALLET_WORKER_BIND_MISMATCH' }));
        }
        done(null);
      });
    } catch (error) { done(error); }
  });
}

function createWorker({ dataDir, identity, secret, handle, clientIp, initialize, onFatal,
  log = console.log, retryMs = 1000 }) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let endpoint = endpointFor(dataDir);
  const legacyEndpoint = endpointFor(dataDir, 'tcp');
  const key = crypto.createHmac('sha256', secret).update('koin-vault-worker-v1\n')
    .update(JSON.stringify([fs.realpathSync(dataDir), identity])).digest();
  const mac = value => crypto.createHmac('sha256', key).update(value).digest('base64url');
  let owner = false, initialized = false, fatal = false, pending = null, role = '', server;
  let legacyForward = null, peerReady = false, fault = null;
  let lastFailure = '', lastFailureAt = 0;
  const status = () => ({ protocol: 2, role: fatal ? 'failed' : initialized ? 'owner'
    : legacyForward ? 'forwarding-legacy' : owner ? 'waiting' : peerReady ? 'forwarding' : 'unavailable',
    ready: !fatal && (initialized || peerReady), transport: transportOf(legacyForward || endpoint),
    ...(fault ? { lastFailure: fault } : {}) });
  function failed(code, stage, error) {
    fault = { code, stage, reason: error?.code || code, at: new Date().toISOString() };
    const kind = `${stage}:${fault.reason}`;
    if (kind !== lastFailure || Date.now() - lastFailureAt > 30000) {
      log(`worker:   pid=${process.pid} ${code} stage=${stage} reason=${fault.reason} transport=${transportOf(endpoint)}`);
      lastFailure = kind; lastFailureAt = Date.now();
    }
  }
  function announce(value) {
    if (role === value) return;
    role = value;
    log(`worker:   pid=${process.pid} ${value}; data=${fs.realpathSync(dataDir)}`);
  }

  function receive(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch (_) { return reply(res, 400, 'Invalid worker request'); }
    if (req.method === 'GET' && url.pathname === '/_wallet-worker/ping') {
      const challenge = url.searchParams.get('challenge');
      if (!/^[a-f0-9]{64}$/.test(challenge || '')) return reply(res, 400, 'Invalid worker challenge');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ proof: mac('owner:' + challenge), ready: initialized || !!legacyForward }));
    }
    const proof = String(req.headers[HEADER] || '');
    const [value, signature, extra] = proof.split('.');
    try {
      if (proof.length > 2048 || extra || !same(signature, mac('request:' + value))) throw new Error();
      const [time, ip, method, target] = JSON.parse(Buffer.from(value, 'base64url').toString());
      if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 60000 || !net.isIP(ip)
          || method !== req.method || target !== req.url || !/^\/(android\/)?api\//.test(url.pathname)) throw new Error();
      req.walletWorkerIp = ip; // Trusted property, never a browser-supplied header.
      delete req.headers[HEADER];
    } catch (_) { return reply(res, 403, 'Invalid wallet worker request'); }
    // HTTP request listeners do not consume returned promises. A rejected
    // handler must fail this request, not kill the elected process.
    Promise.resolve().then(() => handle(req, res)).catch(error => {
      failed('WALLET_WORKER_REQUEST_FAILED', 'handler', error);
      if (res.headersSent) return res.destroy();
      reply(res, 500, 'Wallet request failed. Check the application runtime log.', 'WALLET_WORKER_REQUEST_FAILED');
    });
  }

  async function probe(target) {
    const challenge = crypto.randomBytes(32).toString('hex');
    const answer = await request({ endpoint: target, method: 'GET', path: '/_wallet-worker/ping?challenge=' + challenge,
      timeoutMs: 1500, maxBytes: 1024 });
    let data;
    try { data = JSON.parse(answer.body); } catch (_) {}
    if (answer.status !== 200 || !same(data?.proof, mac('owner:' + challenge))) {
      throw Object.assign(new Error('Private listener is not this wallet worker'), { code: 'WALLET_WORKER_IDENTITY' });
    }
    return data.ready !== false; // v1 workers did not include readiness.
  }

  function guardListener(listener) {
    // Releasing an election listener while still writing permits two owners.
    listener.on('close', () => process.exit(1));
    listener.on('error', () => process.exit(1));
  }

  async function step() {
    if (fatal || initialized) return;
    if (pending) return pending;
    pending = (async () => {
      if (!owner) {
        let candidate = http.createServer(receive);
        let error = await listenPrivate(candidate, endpoint);
        if (error && endpoint.path && ['EACCES', 'EPERM', 'EINVAL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT'].includes(error.code)) {
          log(`worker:   abstract socket unavailable (${error.code}); using authenticated loopback TCP`);
          endpoint = legacyEndpoint;
          candidate = http.createServer(receive);
          error = await listenPrivate(candidate, endpoint);
        }
        if (error) {
          if (error.code !== 'EADDRINUSE') throw error;
          // EADDRINUSE proves only that something is listening. Never call
          // it a wallet worker until it has answered our identity challenge.
          try {
            peerReady = await probe(endpoint);
            fault = null;
            announce(peerReady ? 'forwarding to active wallet worker' : 'waiting for wallet worker initialization');
          } catch (error) {
            peerReady = false;
            failed(error.code === 'WALLET_WORKER_IDENTITY' ? error.code : 'WALLET_WORKER_UNREACHABLE', 'election', error);
            announce('private listener occupied but no authenticated wallet worker is reachable');
          }
          return;
        }
        server = candidate;
        owner = true;
        // Losing the listener while still writing would permit two owners.
        // Production never closes it separately from exiting the process.
        guardListener(server);
        announce('owns wallet runtime');
      }
      try {
        await initialize();
        initialized = true;
        legacyForward = null; peerReady = false; fault = null;
        announce('active wallet worker');
        // Keep old TCP-only processes connected during a rolling deployment.
        // An occupied legacy port is harmless: the primary socket still owns
        // election and the funding lock remains the final single-writer gate.
        if (endpoint.path) {
          const alias = http.createServer(receive);
          const error = await listenPrivate(alias, legacyEndpoint);
          if (!error) guardListener(alias);
          else log(`worker:   legacy TCP alias unavailable (${error.code}); primary unix worker is active`);
        }
      } catch (error) {
        if (error.code !== 'FUNDING_WORKER_BUSY') throw error;
        // An old release may still own the legacy funding lock during the
        // first rollout. Keep the election listener and wait for it to exit.
        announce(`waiting for previous worker pid=${error.ownerPid || '?'}`);
        failed('FUNDING_WORKER_BUSY', 'initialize', error);
        // During rollout the old owner may still be serving its TCP endpoint.
        // Relay only after authentication; never steal its live funding lock.
        legacyForward = null; peerReady = false;
        if (endpoint.path) {
          try {
            peerReady = await probe(legacyEndpoint);
            if (peerReady) legacyForward = legacyEndpoint;
          } catch (_) { /* Keep waiting for the recorded owner to exit. */ }
        }
      }
    })().catch(error => {
      fatal = true;
      failed('WALLET_WORKER_START_FAILED', 'initialize', error);
      onFatal(error);
    }).finally(() => { pending = null; });
    return pending;
  }

  function request({ endpoint: target = endpoint, method, path, headers = {}, body, timeoutMs, maxBytes }) {
    return new Promise((resolve, reject) => {
      const upstream = http.request({ ...connectionFor(target), agent: false, method, path, headers });
      const timer = setTimeout(() => upstream.destroy(Object.assign(new Error('Wallet worker timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
      const fail = error => { clearTimeout(timer); reject(error); };
      upstream.once('error', fail);
      upstream.once('response', response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) upstream.destroy(Object.assign(new Error('Wallet worker response too large'), { code: 'EMSGSIZE' }));
          else chunks.push(chunk);
        });
        response.once('error', fail);
        response.once('end', () => {
          clearTimeout(timer);
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
        });
      });
      upstream.end(body);
    });
  }

  async function forward(req, res) {
    if (fatal) return reply(res, 503, 'Wallet server could not start. Check the application runtime log.', 'WALLET_WORKER_START_FAILED');
    // Authenticate the listener BEFORE disclosing any request body. The key
    // includes site, network, signing modules and sponsor identity, so a port
    // collision or accidentally shared directory cannot mix different apps.
    let phase = 'connect';
    try {
      const target = legacyForward || endpoint;
      peerReady = await probe(target);
      const chunks = []; let size = 0;
      const maxBody = /\/api\/dapp\/(launch|approve)$/.test(new URL(req.url, 'http://localhost').pathname)
        ? 512 * 1024 : 64 * 1024;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBody) return reply(res, 413, 'Request too large');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const value = Buffer.from(JSON.stringify([Date.now(), clientIp(req), req.method, req.url])).toString('base64url');
      const headers = { [HEADER]: value + '.' + mac('request:' + value), 'content-length': String(body.length) };
      for (const name of ['content-type', 'origin', 'referer', 'sec-fetch-site', 'x-wallet-client', 'x-koin-wallet-proxy']) {
        if (req.headers[name]) headers[name] = req.headers[name];
      }
      // Exactly ONE attempt. Never replay a signing/submission/funding POST
      // after a lost response, a timeout, or an owner restart.
      phase = 'response';
      const answer = await request({ endpoint: target, method: req.method, path: req.url, headers, body,
        timeoutMs: 65000, maxBytes: 2 * 1024 * 1024 });
      if (res.destroyed || res.writableEnded) return;
      const outputHeaders = { 'Content-Type': answer.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' };
      for (const name of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'vary', 'retry-after']) {
        if (answer.headers[name]) outputHeaders[name] = answer.headers[name];
      }
      res.writeHead(answer.status, outputHeaders);
      res.end(answer.body);
      lastFailure = '';
      fault = null;
    } catch (error) {
      peerReady = false;
      if (error.code === 'WALLET_WORKER_IDENTITY') {
        failed(error.code, phase, error);
        return reply(res, 503, 'Wallet worker configuration does not match. Check the application runtime log.', error.code);
      }
      failed(phase === 'connect' ? 'WALLET_WORKER_UNREACHABLE' : 'WALLET_WORKER_RESPONSE_LOST', phase, error);
      return reply(res, 503, phase === 'connect'
        ? 'Wallet server cannot reach its active worker. Check the application runtime log.'
        : 'Wallet server lost the response. Check the transaction status before trying again.',
      phase === 'connect' ? 'WALLET_WORKER_UNREACHABLE' : 'WALLET_WORKER_RESPONSE_LOST');
    }
  }

  const timer = setInterval(() => { void step(); }, retryMs);
  timer.unref();
  return { start: step, isOwner: () => owner && !legacyForward, forward, status };
}

module.exports = { createWorker, endpointFor };
