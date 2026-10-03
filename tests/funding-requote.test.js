"use strict";
const assert = require('node:assert/strict');
const { harness, A } = require('./fixtures/funding-v2-harness');
const quotes = require('../tools/eth/eth-swap');
const { canRequote } = require('../tools/eth/funding-v2');
async function stuck() {
  const h = harness({ own: '0.04' });
  await h.start('eth', 'C', '0.02');
  await h.run(h.account, 'swap_usdt_vkoin');
  const j = h.jobs[h.account];
  h.ctx.save(h.account, { ...j, status: 'error', failedAt: 'swap_usdt_vkoin', error: 'Gas rose' });
  h.opts.gas *= 2n;
  return h;
}
(async () => {
  {
    const h = await stuck(), before = JSON.stringify(h.jobs[h.account]), sent = h.sends.length;
    const original = quotes.quoteVkoinOut;
    quotes.quoteVkoinOut = async args => BigInt(await original(args)) / 2n;
    const { quote } = await h.engine.requote(h.account);
    assert.equal(JSON.stringify(h.jobs[h.account]), before);
    assert.equal(h.sends.length, sent);
    assert.ok(BigInt(quote.koinOutMin) < BigInt(quote.previousKoinOutMin));
    const receipts = JSON.stringify(h.jobs[h.account].ethReceipts);
    const id = h.jobs[h.account].id;
    await h.engine.requote(h.account, quote.quoteId);
    assert.equal(h.jobs[h.account].id, id);
    assert.equal(JSON.stringify(h.jobs[h.account].ethReceipts), receipts);
    await h.run();
    for (const step of ['collect_fee', 'swap_eth_usdt', 'swap_usdt_vkoin', 'bridge_token']) {
      assert.equal(h.sends.filter(s => s.state === step).length, 1, step + ' is not replayed');
    }
    assert.equal(A.costs(h.jobs[h.account]).debt, 0n);
    console.log('✓ higher gas and lower output require explicit approval; same job finishes without duplicate fees or swaps');
  }
  for (const mutation of ['pendingEth', 'confirmedEth', 'ethTxHash', 'pendingTx', 'settlementComplete']) {
    const h = await stuck();
    h.jobs[h.account][mutation] = mutation === 'settlementComplete' ? false : {};
    assert.equal(canRequote(h.jobs[h.account]), false);
    await assert.rejects(h.engine.requote(h.account), /reconcile/);
  }
  for (const change of ['state', 'restart', 'account', 'balance', 'expired']) {
    const h = await stuck();
    const { quote } = await h.engine.requote(h.account);
    if (change === 'state') h.jobs[h.account].error = 'changed';
    if (change === 'restart') h.restart();
    if (change === 'balance') h.setOwn('0');
    if (change === 'account') h.jobs[h.second] = JSON.parse(JSON.stringify(h.jobs[h.account]));
    const now = Date.now;
    if (change === 'expired') Date.now = () => quote.expiresAt + 1;
    try { await assert.rejects(h.engine.requote(change === 'account' ? h.second : h.account, quote.quoteId), /expired|changed|Add ETH/); }
    finally { Date.now = now; }
    assert.equal(h.jobs[h.account].status, 'error');
  }
  {
    const h = await stuck(); h.setOwn('0');
    const { quote } = await h.engine.requote(h.account);
    assert.ok(Number(quote.additionalEthNeeded) > 0);
    h.setOwn('0.04');
    await h.engine.requote(h.account, quote.quoteId);
    await assert.rejects(h.engine.requote(h.account, quote.quoteId), /reconcile/);
    await h.run();
  }
  console.log('✓ pending transactions, stale quotes, wrong accounts, expiry, restart, insufficient ETH and duplicate approval are guarded');
})().catch(e => { console.error(e); process.exit(1); });
