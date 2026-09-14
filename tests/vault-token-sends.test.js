'use strict';
const assert = require('node:assert/strict');
const { Signer } = require('koilib');
const chain = require('../tools/chain');
const { NETWORKS } = require('../tools/rpc');
const { createTokenService } = require('../tools/vault-token-sends');
const address = label => Signer.fromSeed('vault-token-test-' + label).getAddress();
const from = address('owner'), to = address('recipient'), token = address('token');
const modules = { verifier: address('verifier'), modSign: address('sign'), modValidation: address('validation') };
let now = 1000, verdict = true, broadcasts = 0, limit = false, mana = '2000000000', balance = '9007199254740993', decimals = 6;
let installed = Object.values(modules), nextId = 0;
const facade = {
  K: chain.K, isAddr: chain.isAddr,
  configure: options => chain.configure(options), sponsorAddress: () => address('sponsor'),
  accountModules: async () => installed,
  tokenMeta: async (contract, options) => { assert.equal(contract, token); assert.equal(options.fresh, true); return { symbol: 'KCT', decimals }; },
  tokenBalanceSats: async (contract, owner) => { assert.equal(contract, token); assert.equal(owner, from); return balance; },
  provider: () => ({ getAccountRc: async () => mana }),
  opTokenTransfer: chain.opTokenTransfer,
  prepareUserTx: async (owner, operations, options) => ({ id: 'tx-' + nextId++, header: { payee: owner, payer: address('sponsor'), rc_limit: options.rcLimit }, operations }),
  verifyPasskeyOnChain: async (owner, signature) => { assert.equal(owner, from); assert.equal(signature, 'passkey'); return { ok: verdict }; },
  submitSmartCosigned: async (tx, id, owner) => { assert.equal(owner, from); assert.equal(tx.id, id); broadcasts++; return id; },
};
const opts = { chain: facade, network: 'mainnet', modules, sponsorWif: 'fixture', rateLimited: () => limit, now: () => now };
const service = createTokenService(opts);
// This is the OLD account backend's config: no custom-token capability.
const config = { ok: true, demo: false, network: 'mainnet', modules, sendAssets: ['koin', 'vhp'] };
const prepare = patch => service.prepare({ address: from, to, asset: token, amount: '1.234567', ...patch }, '192.0.2.1');
const signed = prep => ({ ref: prep.ref, transaction: { ...prep.tx, signatures: ['passkey'] } });
(async () => {
  await assert.rejects(prepare(), /unavailable/);
  assert.equal(service.configureResponse(config).sendCustomTokens, true, 'Vault supplies the capability without an upstream upgrade');
  const prep = await prepare({ decimals: 99, symbol: 'FAKE', entry_point: 1, abi: {} });
  assert.deepEqual(prep.transfer, { contract: token, symbol: 'KCT', decimals: 6, units: '1234567' });
  assert.deepEqual((await chain.tokenContractAt(token).decodeOperation(prep.tx.operations[0])).args, { from, to, value: '1234567' });
  const result = await service.submit(signed(prep));
  assert.equal(result.txid, prep.tx.id); assert.equal(broadcasts, 1);
  await assert.rejects(service.submit(signed(prep)), /already submitted/);
  for (const mutate of [
    tx => { tx.id = 'other'; },
    tx => { tx.header.payee = to; },
    tx => { tx.operations[0].call_contract.contract_id = to; },
    tx => { tx.operations[0].call_contract.args = 'changed-recipient'; },
    tx => { tx.operations.push(tx.operations[0]); },
    tx => { tx.signatures.push('extra'); },
  ]) {
    const next = signed(await prepare()); mutate(next.transaction);
    await assert.rejects(service.submit(next), /changed|exactly one/i);
  }
  assert.equal(broadcasts, 1, 'Altered operations and signatures never reach the sponsor');
  for (const answer of [false, null]) {
    verdict = answer; await assert.rejects(service.submit(signed(await prepare())), /rejected|unavailable/);
  }
  assert.equal(broadcasts, 1, 'An unreadable signature verdict must fail closed'); verdict = true;
  const concurrent = signed(await prepare());
  const outcomes = await Promise.allSettled([service.submit(concurrent), service.submit(concurrent)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1); assert.equal(broadcasts, 2);
  const expired = signed(await prepare()); now += 11 * 60000;
  await assert.rejects(service.submit(expired), /expired/);
  await assert.rejects(prepare(), /unavailable/); service.configureResponse(config);
  for (const asset of ['koin', 'vhp', NETWORKS.mainnet.koinContract, NETWORKS.mainnet.vhpContract, 'invalid']) await assert.rejects(prepare({ asset }), /contract/);
  for (const amount of ['0', '-1', '1e6', '1.0000001', '18446744073709.551616']) await assert.rejects(prepare({ amount }), /Amount/);
  balance = '1'; await assert.rejects(prepare(), /Not enough/); balance = '9007199254740993';
  decimals = null; await assert.rejects(prepare(), /decimals/); decimals = 6;
  mana = '1999999999'; await assert.rejects(prepare(), /recharging/); mana = '2000000000';
  installed = []; await assert.rejects(prepare(), /not ready/); installed = Object.values(modules);
  limit = true; await assert.rejects(prepare(), /Too many/); limit = false;
  for (const bad of [{ ...config, network: 'harbinger' }, { ...config, modules: { ...modules, modSign: to } }, { ...config, demo: true }]) {
    assert.equal(service.configureResponse(bad).sendCustomTokens, false); await assert.rejects(prepare(), /unavailable/);
  }
  for (const disabled of [{ sponsorWif: '' }, { demo: true }, { modules: {} }]) {
    const unavailable = createTokenService({ ...opts, ...disabled });
    assert.equal(unavailable.configureResponse(config).sendCustomTokens, false);
  }
  console.log('✓ Vault-only sponsored transfers work with the old backend config and exact contract amounts');
  console.log('✓ Tampering, replay, concurrent submission, stale config, missing modules/mana and unverified passkeys fail safely');
})().catch(error => { console.error(error); process.exitCode = 1; });
