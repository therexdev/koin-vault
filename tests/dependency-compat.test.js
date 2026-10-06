'use strict';
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
// These imports must fail the reference-SDK CI job rather than silently skip.
for (const name of Object.keys(require('../package.json').devDependencies)) require(name);
const lock = require('../package-lock.json');
assert.ok(!Object.keys(lock.packages).some(p => p.endsWith('/stream-json')));
const anchorRequire = createRequire(require.resolve('@coral-xyz/anchor'));
assert.equal(anchorRequire('toml').parse('[wallet]\nnetwork = "mainnet"').wallet.network, 'mainnet');
const solRequire = createRequire(require.resolve('@wormhole-foundation/sdk-solana'));
const rpcRequire = createRequire(solRequire.resolve('rpc-websockets'));
const uuid = rpcRequire('uuid');
assert.equal(uuid.validate(uuid.v4()), true);
assert.throws(() => uuid.v5('test', uuid.v5.DNS, new Uint8Array(8), 4), RangeError);
const { Connection, PublicKey } = require('@solana/web3.js');
const connection = new Connection('http://localhost:1', {
  fetch: async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.method, 'getBalance');
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({
      jsonrpc: '2.0', id: request.id, result: { context: { slot: 1 }, value: 1234 },
    }) };
  },
});
(async () => {
  assert.equal(await connection.getBalance(new PublicKey('11111111111111111111111111111111')), 1234);
  console.log('Patched TOML, UUID bounds, all reference SDK imports and Solana JSON-RPC compatibility passed');
})().catch(e => { console.error(e); process.exit(1); });
