"use strict";
const assert = require('node:assert/strict');
const { harness, A, RC } = require('./fixtures/funding-v2-harness');
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
async function stuckBridge(step = 'bridge_token', asset = 'eth', route = 'C') {
  const h = harness({ own: '0.04' });
  await h.start(asset, route, asset === 'eth' ? '0.02' : asset === 'sol' ? '0.2' : '100');
  if (asset === 'sol') h.arriveSol();
  await h.run(h.account, step);
  h.opts.gas *= 2n;
  await assert.rejects(h.engine.advance(h.account, h.jobs[h.account]), /Gas rose/);
  h.ctx.save(h.account, { ...h.jobs[h.account], status: 'error', failedAt: step, error: 'Gas rose' });
  // All stablecoins were spent. Recovery must use the actual vKOIN instead.
  for (const key of h.tokens.keys()) if (!key.endsWith(RC.VKOIN.toLowerCase())) h.tokens.set(key, 0n);
  return h;
}
(async () => {
  for (const step of ['approve_bridge', 'bridge_token']) {
    for (const [asset, route] of [['eth', 'C'], ['usdc', 'D'], ['usdc', 'C'], ['usdt', 'C'], ['sol', 'S'], ['sol', 'T']]) {
      const h = await stuckBridge(step, asset, route);
      const before = JSON.stringify(h.jobs[h.account]), sent = h.sends.length;
      quotes.quoteVkoinOut = async () => { throw new Error('Spent stablecoins must not be requoted'); };
      assert.equal(canRequote(h.jobs[h.account]), true);
      const { quote } = await h.engine.requote(h.account);
      assert.equal(JSON.stringify(h.jobs[h.account]), before, 'preview never changes the job or its fee limits');
      assert.equal(h.sends.length, sent, 'preview never sends');
      assert.equal(quote.vortexRecovery, true);
      assert.equal(quote.koinOut, h.jobs[h.account].vkoinSats);
      assert.equal(quote.koinOutMin, quote.koinOut);
      assert.ok(Number(quote.estimatedRemainingGasEth) < Number(quote.remainingGasMaxEth));
      const old = JSON.parse(before);
      await h.engine.requote(h.account, quote.quoteId);
      const updated = h.jobs[h.account];
      for (const key of ['id', 'vkoinSats', 'feePaidWei', 'settlementTx', 'settlementComplete', 'ethReceipts']) {
        assert.deepEqual(updated[key], old[key], key + ' is preserved');
      }
      assert.equal(updated.status, step);
      assert.equal(updated.feePlan.serviceWei, old.feePlan.serviceWei);
      assert.equal(updated.feePlan.gasLimits.swap_usdt_vkoin, old.feePlan.gasLimits.swap_usdt_vkoin);
      assert.equal(BigInt(updated.feePlan.gasMaxWei),
        Object.values(updated.ethReceipts).reduce((a, r) => a + BigInt(r.gasWei), 0n)
          + require('ethers').parseEther(quote.remainingGasMaxEth));
      await h.run();
      assert.deepEqual(h.sends.slice(sent).map(s => s.state), step === 'approve_bridge' ? ['approve_bridge', 'bridge_token'] : ['bridge_token']);
      assert.equal(h.sends.filter(s => s.state === 'collect_fee').length, 1, 'no second platform fee');
      assert.equal(h.sends.filter(s => s.state === 'bridge_token').length, 1, 'one bridge transfer');
      assert.equal(A.costs(h.jobs[h.account]).debt, 0n);
      assert.equal(canRequote(h.jobs[h.account]), false, 'a sent bridge transfer cannot be requoted');
    }
  }
  console.log('✓ all vKOIN routes recover bridge approval/transfer with existing tokens, no duplicate swap or fee');
  {
    const h = await stuckBridge();
    const { GAS } = require('../tools/eth/funding-v2');
    h.wallets[h.account].estimateGas = async () => GAS.bridge_token * 2n;
    const { quote } = await h.engine.requote(h.account);
    await h.engine.requote(h.account, quote.quoteId);
    assert.equal(BigInt(h.jobs[h.account].feePlan.gasLimits.bridge_token), GAS.bridge_token * 2n * 120n / 100n);
    await h.run();
  }
  for (const mutation of ['pendingEth', 'confirmedEth', 'pendingTx', 'ethTxHash', 'settlement', 'debt', 'alreadySent']) {
    const h = await stuckBridge();
    const { quote } = await h.engine.requote(h.account);
    const j = h.jobs[h.account];
    if (mutation === 'settlement') j.settlementComplete = false;
    else if (mutation === 'debt') j.ethReceipts.extra = { sponsored: true, gasWei: '1' };
    else if (mutation === 'alreadySent') j.ethReceipts.extra = { state: 'bridge_token', success: true, gasWei: '1' };
    else j[mutation] = {};
    assert.equal(canRequote(j), false);
    await assert.rejects(h.engine.requote(h.account, quote.quoteId), /reconcile/);
  }
  for (const change of ['state', 'account', 'restart', 'expired', 'eth', 'vkoin']) {
    const h = await stuckBridge();
    const { quote } = await h.engine.requote(h.account);
    const sent = h.sends.length;
    if (change === 'state') h.jobs[h.account].error = 'changed';
    if (change === 'account') h.jobs[h.second] = JSON.parse(JSON.stringify(h.jobs[h.account]));
    if (change === 'restart') h.restart();
    if (change === 'eth') h.setOwn('0');
    if (change === 'vkoin') for (const key of h.tokens.keys()) h.tokens.set(key, 0n);
    const now = Date.now;
    if (change === 'expired') Date.now = () => quote.expiresAt + 1;
    try { await assert.rejects(h.engine.requote(change === 'account' ? h.second : h.account, quote.quoteId), /expired|changed|Add ETH/); }
    finally { Date.now = now; }
    assert.equal(h.jobs[h.account].status, 'error');
    assert.equal(h.sends.length, sent);
    if (change === 'vkoin') await assert.rejects(h.engine.requote(h.account), /vKOIN balance changed/);
  }
  {
    const h = await stuckBridge(); h.setOwn('0');
    const { quote } = await h.engine.requote(h.account);
    assert.equal(quote.additionalEthNeeded, quote.remainingGasMaxEth);
    await assert.rejects(h.engine.requote(h.account, quote.quoteId), /Add ETH/);
    h.setOwn('0.04');
    await h.engine.requote(h.account, quote.quoteId);
    await assert.rejects(h.engine.requote(h.account, quote.quoteId), /reconcile/);
    await h.run();
  }
  console.log('✓ bridge recovery rejects pending, stale, paid-out, unsettled, underfunded and duplicate approvals');
  for (const own of ['0', '0.01233689']) {
    const h = harness({ own });
    await h.start('sol', 'T', '0.2'); h.arriveSol();
    const cap = BigInt(h.jobs[h.account].feePlan.gasLimits.wh_redeem);
    h.wallets[h.account].estimateGas = async () => cap * 2n;
    h.sponsorWallet.estimateGas = async () => cap * 2n;
    await assert.rejects(h.engine.advance(h.account, h.jobs[h.account]), /approved route budget/);
    h.ctx.save(h.account, { ...h.jobs[h.account], status: 'error', failedAt: 'wh_redeem' });
    const before = JSON.stringify(h.jobs[h.account]);
    const { quote } = await h.engine.requote(h.account);
    assert.equal(JSON.stringify(h.jobs[h.account]), before);
    assert.equal(h.sends.length, 0);
    assert.equal(quote.additionalEthNeeded, '0.0');
    assert.equal(quote.sponsoredRedeem, own === '0');
    const saved = h.jobs[h.account];
    for (const key of ['pendingEth', 'confirmedEth', 'pendingTx', 'ethTxHash']) {
      h.jobs[h.account] = { ...saved, [key]: {} };
      assert.equal(canRequote(h.jobs[h.account]), false);
      await assert.rejects(h.engine.requote(h.account, quote.quoteId), /reconcile/);
    }
    h.jobs[h.account] = saved;
    const wormhole = require('../tools/sol/wormhole');
    const originalRedeemed = wormhole.isRedeemedOnEthereum;
    wormhole.isRedeemedOnEthereum = async () => true;
    try { await assert.rejects(h.engine.requote(h.account, quote.quoteId), /already redeemed/); }
    finally { wormhole.isRedeemedOnEthereum = originalRedeemed; }
    if (own === '0') {
      const balance = h.balance(h.sponsorWallet.address);
      h.ethBalances.set(h.sponsorWallet.address, 0n);
      await assert.rejects(h.engine.requote(h.account, quote.quoteId), /protected reserve/);
      h.ethBalances.set(h.sponsorWallet.address, balance);
    }
    assert.equal(h.sends.length, 0);
    await h.engine.requote(h.account, quote.quoteId);
    await assert.rejects(h.engine.requote(h.account, quote.quoteId), /reconcile/);
    const redemptionWallet = own === '0' ? h.sponsorWallet : h.wallets[h.account];
    // Keep the elevated estimate for redemption only.
    await h.engine.advance(h.account, h.jobs[h.account]);
    assert.equal(h.sends[0].from, redemptionWallet.address);
    // Restore simulator estimates for the remaining route.
    const { GAS } = require('../tools/eth/funding-v2');
    for (const w of [h.wallets[h.account], h.sponsorWallet]) w.estimateGas = async () => {
      const state = h.jobs[h.account].status;
      return ['front_gas', 'collect_fee'].includes(state) ? GAS[state] : GAS[state] * 7n / 10n;
    };
    await h.run();
    assert.equal(h.sends.filter(s => s.state === 'wh_redeem').length, 1);
    assert.equal(h.sends.filter(s => s.state === 'collect_fee').length, 1);
    assert.equal(A.costs(h.jobs[h.account]).debt, 0n);
    console.log('✓ existing Wormhole transfer requotes actual gas and resumes once with ' + (own === '0' ? 'sponsored' : 'existing') + ' ETH');
  }
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
