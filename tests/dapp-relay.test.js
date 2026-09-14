'use strict';
const assert = require('node:assert/strict');
const relay = require('../tools/dapp-relay');

const made = relay.create({ origin: 'https://trade.example', name: 'Trade Koinos', icon: 'javascript:bad' });
assert.ok(made.id && made.secret);
assert.equal(relay.get(made.id, 'wrong'), null, 'wrong bearer secret is refused');
const session = relay.get(made.id, made.secret);
assert.equal(relay.publicSession(session).secret, undefined, 'secret is never returned by status');
assert.equal(session.icon, '', 'unsafe icon URL is removed');
relay.connect(session, '1TestAddress');

const operation = { call_contract: { contract_id: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', entry_point: 123, args: 'AA==' } };
// The RPC's bytes codec requires padded Base64url. App inputs may use
// either alphabet/padding style, but their bytes must survive unchanged.
for (const bytes of [Buffer.alloc(0), Buffer.from([251]), Buffer.from([251, 255]), Buffer.from([251, 255, 254])]) {
  for (const input of [bytes.toString('base64'), bytes.toString('base64url')]) {
    const [normalized] = relay.validateOperations([{call_contract: {...operation.call_contract, args: input}}]);
    const actual = normalized.call_contract.args;
    assert.equal(actual, bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_'));
    assert.equal(actual.length % 4, 0, 'RPC argument encoding must be padded');
    assert.deepEqual(Buffer.from(actual, 'base64url'), bytes, 'signed argument bytes are preserved');
  }
}
const req = relay.addRequest(session, { operations: [operation], summary: { title: '<b>Place order</b>', detail: 'Buy', network: 'mainnet' }, transaction: { id: 'tx' } });
assert.equal(relay.pending(session)[0].id, req.id);
assert.throws(() => relay.addRequest(session, { operations: [operation], transaction: {} }), /pending/);
relay.settle(req, 'rejected');
assert.equal(relay.request(session, req.id).status, 'rejected');
assert.throws(() => relay.validateOperations([]), /1-6/);
assert.throws(() => relay.validateOperations([{ upload_contract: {} }]), /contract calls only/);
assert.throws(() => relay.validateOperations(Array(7).fill(operation)), /1-6/);
relay.disconnect(session);
assert.equal(relay.get(made.id, made.secret), null);
console.log('✓ dApp relay binds secrets, limits contract calls, serializes requests, and revokes sessions');
