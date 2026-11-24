'use strict';
const assert = require('node:assert/strict');
const { summarize, receiptVerifier } = require('../tools/trade-totals');

(async () => {
  const buy = { id: 'buy-one', account: 'wallet', status: 'done', koinReceived: '123456789', redeemId: '0x1220' + 'ab'.repeat(32) };
  const sale = { id: 'sale-one', kind: 'sell', status: 'done', amount: '2000000000000' };
  const ledger = { transit: { wallet: { ethPriv: 'private-key-marker' } },
    history: { [buy.id]: { ...buy, status: 'awaiting_redeem' }, demo: { ...buy, id: 'demo', demo: true },
      simulated: { ...buy, id: 'simulated', redeemId: '0xdemo-redeem' },
      duplicate: { ...buy, id: 'duplicate' } }, jobs: { wallet: buy },
    tradeHistory: { [sale.id]: sale, fail: { ...sale, id: 'fail', status: 'failed' },
      withdraw: { ...sale, id: 'withdraw', kind: 'withdraw' }, demo: { ...sale, id: 'demo', demo: true } },
    trades: { wallet: sale, pending: { ...sale, id: 'pending', status: 'error' } } };
  const original = JSON.stringify(ledger);
  const recorded = await summarize(ledger);
  assert.equal(recorded.buys.completed, 1);
  assert.equal(recorded.buys.koinRecorded, '1.23456789');
  assert.equal(recorded.buys.koinTotal, null, 'quoted delivery is never presented as verified');
  assert.equal(recorded.sells.koinTotal, '20000');
  assert.equal(recorded.sells.completed, 1);
  const verified = await summarize(ledger, async () => '123000001');
  assert.equal(verified.buys.koinTotal, '1.23000001', 'receipts replace estimates for exact totals');
  assert.equal(verified.buys.verified, 1);
  const unavailable = await summarize(ledger, async () => { throw new Error('RPC unavailable'); });
  assert.equal(unavailable.buys.koinTotal, null);
  assert.equal(unavailable.buys.unverified, 1);
  const missing = await summarize({ jobs: { wallet: { ...buy, koinReceived: null } }, trades: { wallet: { ...sale, amount: null } } });
  assert.equal(missing.buys.missingRecordedAmounts, 1);
  assert.equal(missing.sells.koinTotal, null);
  const large = await summarize({ trades: { wallet: { ...sale, amount: '900719925474099301' } } });
  assert.equal(large.sells.koinTotal, '9007199254.74099301', 'totals retain all eight decimals above the Number precision limit');
  assert.equal((await summarize({})).sells.koinTotal, '0');
  assert.equal(JSON.stringify(ledger), original, 'reporting never changes the ledger');
  assert.doesNotMatch(JSON.stringify(verified), /private-key-marker|wallet|buy-one/);
  const { Contract, Signer } = require('koilib');
  const routes = require('../tools/eth/sell-routes');
  const koin = require('../tools/rpc').NETWORKS.mainnet.koinContract;
  const account = Signer.fromSeed('totals-receipt-account').address;
  const token = new Contract({ id: koin, abi: require('../abi/token-abi.json') });
  const event = { source: koin, name: 'token.transfer_event',
    data: await token.serializer.serialize({ from: koin, to: account, value: '987654321' }, 'token.transfer_event') };
  const readReceipt = routes.koinReceipt;
  routes.koinReceipt = async () => ({ events: [event, { ...event, source: 'another-token' }] });
  const verifyReceipt = await receiptVerifier();
  assert.equal(await verifyReceipt({ ...buy, account }), '987654321', 'the verifier decodes actual KOIN delivery events');
  routes.koinReceipt = readReceipt;
  console.log('Trade totals: exact integer sums, receipt verification, duplicate delivery/job exclusion, demo, pending, withdrawals, missing data and key-free output passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
