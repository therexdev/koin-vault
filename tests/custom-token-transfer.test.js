'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Signer } = require('koilib');
const chain = require('../tools/chain');
const { NETWORKS } = require('../tools/rpc');
const TokenAmounts = require('../public/js/token-amounts');
const source = fs.readFileSync(require.resolve('../server'), 'utf8');
const from = Signer.fromSeed('custom-token-test-owner').getAddress();
const to = Signer.fromSeed('custom-token-test-recipient').getAddress();
const token = Signer.fromSeed('custom-token-test-contract').getAddress();
let decimals = 6, balance = '18446744073709551615', reads = [], prepared = 0, metaError, balanceError;
const remembered = [];
const context = {
  structuredClone,
  TokenAmounts, api: {}, DEMO: false, NETWORKS, CFG: { network: 'mainnet', minSponsorMana: 20, maxTransfersPerDayAddr: 100 },
  veive: { isSmartAccount: () => true, ensureReady: async () => {} }, verifyProof: () => null,
  rateLimited: () => false, httpError: (status, message) => Object.assign(new Error(message), { status }),
  rememberPrepared: (id, address, flags) => { remembered.push({ id, address, flags }); return 'custom-ref'; },
  chain: {
    K: chain.K, isAddr: chain.isAddr, opTokenTransfer: chain.opTokenTransfer,
    tokenMeta: async (id, opts) => { assert.equal(id, token); assert.equal(opts.fresh, true); if (metaError) throw metaError; return { symbol: 'KCT', decimals }; },
    tokenBalanceSats: async (id, owner) => {
      assert.equal(id, token); assert.equal(owner, from); reads.push(id);
      if (balanceError) throw balanceError;
      return balance;
    },
    koinBalanceSats: async () => { throw new Error('Must not use the KOIN balance'); },
    vhpBalanceSats: async () => { throw new Error('Must not use the VHP balance'); },
    sponsorAddress: () => 'sponsor', mana: async () => 100,
    prepareUserTx: async (address, operations, options) => {
      prepared++; assert.equal(address, from); assert.equal(options.rcLimit, chain.K.rcLimitSmart);
      return { id: 'custom-id', header: { payer: 'sponsor', payee: address }, operations };
    },
  },
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('const fromSats ='), source.indexOf('api.portfolio =')), context);
vm.runInContext(source.slice(source.indexOf('api.prepare ='), source.indexOf('/** Broadcast a signed prepared')), context);
const prepare = patch => context.api.prepare({ address: from, to, asset: token, amount: '1', ...patch }, 'fixture-ip');

(async () => {
  for (const network of ['mainnet', 'harbinger']) {
    chain.configure({ network, rpcs: ['http://127.0.0.1:1'] }); context.CFG.network = network;
    for (const [dp, amount, expected] of [
      [0, '7', '7'], [6, '1.234567', '1234567'], [8, '1.00000001', '100000001'],
      [18, '0.000000000000000001', '1'], [18, '18.446744073709551615', '18446744073709551615'],
      [6, '9007199254.740993', '9007199254740993'],
    ]) {
      decimals = dp;
      const result = await prepare({ amount, decimals: 99, symbol: 'FAKE', contract: to, entry_point: 123, abi: {} });
      assert.equal(result.asset, token); assert.equal(result.transfer.contract, token);
      assert.equal(result.transfer.decimals, dp); assert.equal(result.transfer.symbol, 'KCT'); assert.equal(result.transfer.units, expected);
      assert.equal(result.tx.operations.length, 1);
      assert.equal(result.tx.operations[0].call_contract.contract_id, token);
      assert.equal(result.tx.operations[0].call_contract.entry_point, 0x27f576ca);
      const decoded = await chain.tokenContractAt(token).decodeOperation(result.tx.operations[0]);
      assert.deepEqual(decoded.args, { from, to, value: expected }, 'Decode the actual standard-token operation');
      assert.equal(result.tx.header.payer, 'sponsor'); assert.equal(result.tx.header.payee, from);
      assert.equal(remembered.at(-1).flags.smart, true, 'Submission still requires the existing passkey signature');
      assert.equal(reads.at(-1), token);
    }
  }
  const before = prepared;
  decimals = 6;
  for (const amount of ['0', '-1', '1e6', 'NaN', '1.0000001', '18446744073709.551616']) await assert.rejects(prepare({ amount }), /Amount/);
  balance = '1234567';
  await assert.rejects(prepare({ amount: '1.234568' }), /not enough KCT — you hold 1.234567/);
  await assert.rejects(prepare({ to: from }), /KCT to yourself/);
  await assert.rejects(prepare({ to: 'invalid' }), /destination/);
  for (const dp of [undefined, null, -1, 256, 1.5, NaN, '8']) {
    decimals = dp; await assert.rejects(prepare(), /unsupported decimals/);
  }
  decimals = 6;
  metaError = new Error('Token metadata unavailable'); await assert.rejects(prepare(), /metadata unavailable/); metaError = null;
  balanceError = new Error('Token balance unavailable'); await assert.rejects(prepare(), /balance unavailable/); balanceError = null;
  context.DEMO = true; await assert.rejects(prepare(), /live chain connection/); context.DEMO = false;
  assert.equal(prepared, before, 'Invalid transfers never become signable');

  for (const dp of [0, 6, 8, 18, 255]) {
    const all = TokenAmounts.fromUnits('18446744073709551615', dp);
    assert.equal(TokenAmounts.toUnits(all, dp), '18446744073709551615');
  }
  assert.throws(() => TokenAmounts.toUnits('1.0', 0), /whole number/);
  assert.throws(() => TokenAmounts.toUnits('9'.repeat(10000), 8), /Amount/);
  assert.equal(TokenAmounts.fromUnits('18446744073709551616', 8), null);
  assert.equal(TokenAmounts.fromUnits('', 8), null);
  console.log('✓ Custom token operations decode to the exact contract, sender, recipient and units on both networks');
  console.log('✓ Chain decimals override client fields; precision, uint64, balances, metadata failures and passkey preparation stay safe');
})().catch(e => { console.error(e); process.exitCode = 1; });
