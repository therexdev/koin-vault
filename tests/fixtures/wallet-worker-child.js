'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createWorker, endpointFor } = require('../../tools/wallet-worker');
const funding = require('../../tools/funding');
const dir = process.env.WORKER_TEST_DIR;
let worker, ready = false;
async function handle(req, res) {
  if (!worker.isOwner()) return worker.forward(req, res);
  if (!ready) { res.writeHead(503); return res.end('{}'); }
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.url === '/api/drop') {
    fs.appendFileSync(path.join(dir, 'submissions'), body + '\n');
    return req.socket.destroy();
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ pid: process.pid, ip: req.walletWorkerIp || '127.0.0.42', body }));
}
worker = createWorker({ dataDir: dir, secret: 'fixture-secret', identity: process.env.WORKER_TEST_ID || 'same-wallet',
  handle, clientIp: () => '127.0.0.42', retryMs: 60,
  initialize() {
    funding.configure({ dataDir: dir, demo: false });
    fs.appendFileSync(path.join(dir, 'owners'), process.pid + '\n');
    ready = true;
  },
  onFatal(error) { process.send?.({ fatal: error.message }); }, log() {},
});
const server = http.createServer(handle);
server.listen(0, '127.0.0.1', async () => {
  await worker.start();
  process.send?.({ pid: process.pid, url: 'http://127.0.0.1:' + server.address().port, endpoint: endpointFor(dir) });
});
