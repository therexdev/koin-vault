'use strict';
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');

// A kernel-owned listener elects one writer. Unlike a PID file, it cannot
// survive a crash. Extra hosting processes serve static files and relay API
// requests to that writer, including its in-memory signing/dapp sessions.
function endpointFor(dataDir) {
  const id = crypto.createHash('sha256').update(fs.realpathSync(dataDir)).digest('hex');
  // Loopback TCP works on Node 18+ including hosts that prohibit abstract
  // Unix sockets. Identity authentication rejects an unrelated port occupant.
  return { host: '127.0.0.1', port: 20000 + parseInt(id.slice(0, 8), 16) % 40000, exclusive: true };
}

const HEADER = 'x-koin-vault-worker';
const same = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function reply(res, status, error) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' });
  res.end(JSON.stringify({ error }));
}

function createWorker({ dataDir, identity, secret, handle, clientIp, initialize, onFatal,
  log = console.log, retryMs = 1000 }) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const endpoint = endpointFor(dataDir);
  const key = crypto.createHmac('sha256', secret).update('koin-vault-worker-v1\n')
    .update(JSON.stringify([fs.realpathSync(dataDir), identity])).digest();
  const mac = value => crypto.createHmac('sha256', key).update(value).digest('base64url');
  const requestOptions = { host: endpoint.host, port: endpoint.port };
  let owner = false, initialized = false, fatal = false, pending = null, role = '', server;
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
      return res.end(JSON.stringify({ proof: mac('owner:' + challenge) }));
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
    return handle(req, res);
  }

  async function step() {
    if (fatal || initialized) return;
    if (pending) return pending;
    pending = (async () => {
      if (!owner) {
        const candidate = http.createServer(receive);
        const error = await new Promise(resolve => {
          candidate.once('error', resolve);
          candidate.listen(endpoint, () => resolve(null));
        });
        if (error) {
          if (error.code !== 'EADDRINUSE') throw error;
          announce('forwarding to active wallet worker');
          return;
        }
        server = candidate;
        owner = true;
        // Losing the listener while still writing would permit two owners.
        // Production never closes it separately from exiting the process.
        server.on('close', () => process.exit(1));
        server.on('error', () => process.exit(1));
        announce('owns wallet runtime');
      }
      try {
        await initialize();
        initialized = true;
        announce('active wallet worker');
      } catch (error) {
        if (error.code !== 'FUNDING_WORKER_BUSY') throw error;
        // An old release may still own the legacy funding lock during the
        // first rollout. Keep the election listener and wait for it to exit.
        announce(`waiting for previous worker pid=${error.ownerPid || '?'}`);
      }
    })().catch(error => {
      fatal = true;
      onFatal(error);
    }).finally(() => { pending = null; });
    return pending;
  }

  function request({ method, path, headers = {}, body, timeoutMs, maxBytes }) {
    return new Promise((resolve, reject) => {
      const upstream = http.request({ ...requestOptions, agent: false, method, path, headers });
      const timer = setTimeout(() => upstream.destroy(new Error('Wallet worker timed out')), timeoutMs);
      const fail = error => { clearTimeout(timer); reject(error); };
      upstream.once('error', fail);
      upstream.once('response', response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) upstream.destroy(new Error('Wallet worker response too large'));
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
    // Authenticate the listener BEFORE disclosing any request body. The key
    // includes site, network, signing modules and sponsor identity, so a port
    // collision or accidentally shared directory cannot mix different apps.
    try {
      const challenge = crypto.randomBytes(32).toString('hex');
      const probe = await request({ method: 'GET', path: '/_wallet-worker/ping?challenge=' + challenge,
        timeoutMs: 1500, maxBytes: 1024 });
      if (probe.status !== 200 || !same(JSON.parse(probe.body).proof, mac('owner:' + challenge))) {
        announce('worker identity mismatch; check site configuration and DATA_DIR');
        return reply(res, 503, 'Wallet worker configuration does not match. Check the application runtime log.');
      }
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
      const answer = await request({ method: req.method, path: req.url, headers, body,
        timeoutMs: 65000, maxBytes: 2 * 1024 * 1024 });
      if (res.destroyed || res.writableEnded) return;
      const outputHeaders = { 'Content-Type': answer.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' };
      for (const name of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'vary', 'retry-after']) {
        if (answer.headers[name]) outputHeaders[name] = answer.headers[name];
      }
      res.writeHead(answer.status, outputHeaders);
      res.end(answer.body);
    } catch (_) {
      return reply(res, 503, 'Wallet is starting. Please try again shortly.');
    }
  }

  const timer = setInterval(() => { void step(); }, retryMs);
  timer.unref();
  return { start: step, isOwner: () => owner, forward };
}

module.exports = { createWorker, endpointFor };
