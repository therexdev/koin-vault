'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ethers } = require('ethers');
const { Signer } = require('koilib');
const chain = require('../tools/chain');
const wire = require('../public/js/webauthn-wire');
const routes = require('../tools/eth/sell-routes');
const swap = require('../tools/eth/eth-swap-exec');
const RC = require('../tools/eth/route-constants');
const { create } = require('../tools/eth/trade');
const key = new ethers.Wallet('0x' + '11'.repeat(32));
const recipient = new ethers.Wallet('0x' + '22'.repeat(32)).address;
const account = Signer.fromSeed('eth-trade-test').address;
const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const identity = { origin: 'https://wallet.example', rpId: 'wallet.example' };
const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const eth = ethers.parseEther;
const topicAddress = a => ethers.zeroPadValue(a, 32).toLowerCase();
async function proof(challenge, override = {}) {
  const data = Buffer.alloc(37); crypto.createHash('sha256').update(identity.rpId).digest().copy(data); data[32] = 5;
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', origin: identity.origin,
    challenge: Buffer.from(challenge).toString('base64url'), ...override }));
  return wire.packSignatureBlob({ credentialId: 'test', authenticatorData: data, clientDataJSON: client,
    signature: crypto.sign('sha256', Buffer.concat([data, crypto.createHash('sha256').update(client).digest()]), pair.privateKey) });
}
function harness() {
  let ledger = {}, saved = {}, koinReceipt = null, ethereumReceipt = null;
  let pending = false, own = eth('1'), broadcastError = false;
  const broadcasts = [];
  const provider = {
    getNetwork: async () => ({ chainId: 1n }), getBalance: async () => own,
    getFeeData: async () => ({ gasPrice: 1000000000n }), getCode: async () => '0x',
    getTransactionCount: async () => 0, estimateGas: async () => 21000n,
    getTransactionReceipt: async () => ethereumReceipt, getBlockNumber: async () => 103,
    getBlock: async () => ({ hash: 'block' }),
    broadcastTransaction: async raw => {
      const j = ledger.trades[account];
      assert.equal(saved.trades[account].pendingEth.raw, raw, 'persist before broadcast');
      assert.equal(ethers.keccak256(raw), j.pendingEth.hash);
      broadcasts.push(raw); if (broadcastError) throw new Error('connection lost after broadcast');
      return { hash: ethers.keccak256(raw) };
    },
  };
  const settings = { demo: false, network: 'mainnet', maxEth: '0.1', slippageBps: 150, fee: { ratePct: 1, treasury: recipient } };
  const args = { settings, store: () => ledger, persist: () => { saved = JSON.parse(JSON.stringify(ledger)); },
    provider: async () => provider, transit: () => ({ ethAddress: key.address, ethPriv: key.privateKey }),
    buyBusy: () => pending, invalidate: () => {} };
  let trade = create(args);
  return { get trade() { return trade; }, get ledger() { return ledger; }, provider, settings, broadcasts,
    buyBusy: v => { pending = v; }, own: v => { own = v; }, loseBroadcast: v => { broadcastError = v; },
    restart: () => { ledger = JSON.parse(JSON.stringify(saved)); trade = create(args); },
    receipt: r => { ethereumReceipt = r; }, koin: r => { koinReceipt = r; }, getKoin: () => koinReceipt,
    current: () => ledger.trades?.[account],
  };
}
async function approve(h, body) {
  const prep = await h.trade.prepare(account, body, identity);
  return h.trade.submit(account, prep.ref, await proof(prep.challenge), identity);
}
function receipt(logs = [], status = 1) { return { status, gasUsed: 21000n, gasPrice: 1500000000n, blockNumber: 100, blockHash: 'block', logs }; }
function transfer(token, value) { return { address: token, topics: [ethers.id('Transfer(address,address,uint256)'), topicAddress(ethers.ZeroAddress), topicAddress(key.address)], data: ethers.toBeHex(value, 32) }; }
(async () => {
  chain.accountCredentials = async () => [{ credential_id: 'test', public_key: publicKey }];
  chain.koinBalanceSats = async () => '100000000000';
  chain.provider = () => ({ sendTransaction: async () => {} });
  const quoteReal = routes.quote;
  routes.quote = async route => ({ route, grossWei: eth('0.05').toString(), minWei: eth('0.04').toString(),
    gasUnits: '1200000', bridgeFee: '0', swapMin: '4000000', usdtMin: '1000000', bridgeAmount: '100000000', label: route, via: 'test' });
  // The live test cap is checked before requesting either route or moving funds.
  {
    const h = harness();
    chain.koinBalanceSats = async () => '4000000000000';
    for (const amount of ['20000', '20000.00000001', '30000', '39999.99999999', '40000']) {
      const q = await h.trade.sellQuote(account, amount);
      assert.equal(q.routes.filter(r => !r.error).length, 2);
      const prep = await h.trade.prepare(account, { kind: 'sell', quoteId: q.routes[0].quoteId }, identity);
      assert.equal(prep.review.amountKoin, amount);
    }
    for (const amount of ['40000.00000001', '40001', '50000']) {
      await assert.rejects(h.trade.sellQuote(account, amount), /40,000 KOIN per sale/);
    }
    assert.equal(h.current(), undefined);
    assert.equal(h.broadcasts.length, 0);
    for (const route of ['B', 'C']) {
      const sale = harness();
      const q = await sale.trade.sellQuote(account, '40000');
      await approve(sale, { kind: 'sell', quoteId: q.routes.find(r => r.route === route).quoteId });
      assert.equal(sale.current().amount, '4000000000000', 'the full limit survives approval and submission');
      assert.equal(sale.broadcasts.length, 0);
    }
    chain.koinBalanceSats = async () => '100000000000';
    console.log('Live sell limit: 40,000 KOIN approved on both routes, one satoshi over rejected before trading');
  }
  // The shared ETH cap applies to the gross sale value on both routes.
  {
    const h = harness();
    h.settings.maxEth = '0.5';
    const quote = routes.quote;
    for (const gross of ['0.2', '0.3', '0.5', '0.500000000000000001']) {
      routes.quote = async route => ({ ...await quote(route), grossWei: eth(gross).toString(), minWei: eth('0.19').toString() });
      const q = await h.trade.sellQuote(account, '100');
      if (eth(gross) <= eth('0.5')) {
        assert.equal(q.routes.filter(r => !r.error).length, 2, `${gross} ETH is within the sale cap`);
      } else {
        assert.ok(q.routes.every(r => /ETH trade limit/.test(r.error)), 'one wei over the cap is refused on both routes');
      }
    }
    routes.quote = quote;
    assert.equal(h.current(), undefined);
    assert.equal(h.broadcasts.length, 0);
    console.log('ETH sale cap: 0.5 ETH accepted, one wei over rejected on both routes');
  }
  // Authentication binds account, origin, recipient, amount, chain and nonce.
  let h = harness();
  let prepared = await h.trade.prepare(account, { kind: 'withdraw', to: recipient, max: true }, identity);
  await assert.rejects(h.trade.submit('other', prepared.ref, await proof(prepared.challenge), identity), /expired/);
  await assert.rejects(h.trade.submit(account, prepared.ref, await proof(prepared.challenge, { origin: 'https://evil.example' }), identity), /does not match/);
  await assert.rejects(h.trade.submit(account, prepared.ref, await proof(prepared.challenge), identity), /expired/);
  prepared = await h.trade.prepare(account, { kind: 'withdraw', to: recipient, amount: '0.25' }, identity);
  const signature = await proof(prepared.challenge);
  const responses = await Promise.allSettled([h.trade.submit(account, prepared.ref, signature, identity), h.trade.submit(account, prepared.ref, signature, identity)]);
  assert.equal(responses.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(ethers.Transaction.from(h.current().pendingEth.raw).to, recipient);
  assert.equal(ethers.Transaction.from(h.current().pendingEth.raw).value, eth('0.25'));
  assert.equal(ethers.Transaction.from(h.current().pendingEth.raw).from, key.address);
  assert.equal(JSON.stringify(h.trade.status(account)).includes('\"raw\"'), false);
  const duplicate = await h.trade.submit(account, prepared.ref, signature, identity);
  assert.equal(duplicate.id, prepared.ref); assert.equal(h.trade.blocks(account), true);
  await assert.rejects(h.trade.prepare(account, { kind: 'withdraw', to: recipient, max: true }, identity), /current trade/);
  h.loseBroadcast(true); await h.trade.tick();
  assert.ok(h.current().pendingEth); const raw = h.current().pendingEth.raw;
  h.restart(); h.current().pendingEth.sentAt = 0; h.loseBroadcast(false); await h.trade.tick();
  assert.equal(h.broadcasts[1], raw, 'restart rebroadcasts the identical signed transaction');
  h.receipt(receipt()); await h.trade.tick();
  assert.equal(h.current().status, 'done'); assert.equal(h.trade.blocks(account), false);
  await h.trade.tick(); assert.equal(h.broadcasts.length, 2);
  assert.equal((await h.trade.submit(account, prepared.ref, signature, identity)).status, 'done');
  h = harness(); h.buyBusy(true);
  await assert.rejects(h.trade.prepare(account, { kind: 'withdraw', to: recipient, max: true }, identity), /current trade/);
  h.buyBusy(false); prepared = await h.trade.prepare(account, { kind: 'withdraw', to: recipient, max: true }, identity);
  h.own(1n); await assert.rejects(h.trade.submit(account, prepared.ref, await proof(prepared.challenge), identity), /balance changed/);
  assert.equal(h.current(), undefined);
  h = harness(); await approve(h, { kind: 'withdraw', to: recipient, amount: '0.25' }); h.receipt(receipt([], 0)); await h.trade.tick();
  assert.equal(h.current().status, 'failed'); assert.equal(h.trade.blocks(account), false);
  h = harness(); h.settings.demo = true; await assert.rejects(h.trade.sellQuote(account, '10'), /live/);
  console.log('Trade authorization and withdrawals: real passkeys, replay, race, persistence, ambiguous broadcast and failures passed');

  for (const route of ['B', 'C']) {
    h = harness();
    routes.koinReceipt = async () => h.getKoin();
    routes.bridgeFee = async () => 0n;
    routes.vethReceived = async () => '5000000';
    routes.lockedTransfer = async () => ({ opId: '9', amount: route === 'B' ? '5000000' : '100000000' });
    routes.record = async j => ({ id: j.bridgeTx, opId: '9', ethToken: route === 'B' ? RC.WETH : RC.VKOIN,
      recipient: key.address, amount: j.bridgeAmount, signatures: ['0x' + '11'.repeat(65), '0x' + '22'.repeat(65)], metadata: j.id, expiration: Date.now() + 3600000 });
    routes.quoteVkoinUsdt = async () => 2000000n;
    routes.quoteUsdtEth = async () => ({ amount: eth('0.05'), fee: 500 });
    swap.permit2Allowance = async () => ({ amount: 100000000n, expiration: Math.floor(Date.now() / 1000) + 7200 });
    swap.allowance = async () => 0n;
    const q = await h.trade.sellQuote(account, '1');
    await approve(h, { kind: 'sell', quoteId: q.routes.find(r => r.route === route).quoteId });
    assert.equal(h.current().status, route === 'B' ? 'sell_swap' : 'sell_bridge');
    const id = h.current().id;
    // Once a signed Koinos transaction is durable, cancellation and a second
    // transaction for the same step are forbidden, even across a restart.
    const transaction = { id: '0x1220' + 'ab'.repeat(32), header: {}, operations: [], signatures: ['fixture'] };
    const step = `sell:${id}:${h.current().status}`;
    h.trade.beforeKoinBroadcast(account, step, transaction);
    assert.throws(() => h.trade.beforeKoinBroadcast(account, step, transaction), /changed/);
    await assert.rejects(h.trade.prepare(account, { kind: 'cancel' }, identity), /moved/);
    h.restart(); h.koin({ reverted: false }); await h.trade.tick();
    if (route === 'B') {
      assert.equal(h.current().vethAmount, '5000000'); assert.equal(h.current().status, 'sell_bridge');
      h.trade.beforeKoinBroadcast(account, `sell:${id}:sell_bridge`, { ...transaction, id: '0x1220' + 'cd'.repeat(32) });
      await h.trade.tick();
    }
    assert.equal(h.current().opId, '9'); assert.equal(h.current().status, 'sell_signatures');
    await h.trade.tick(); assert.equal(h.current().status, 'eth_redeem');
    for (let i = 0; i < 40 && h.current().status !== 'done'; i++) {
      const j = h.current();
      if (j.pendingEth) {
        const logs = j.pendingEth.step === 'eth_redeem' && route === 'C' ? [transfer(RC.VKOIN, 100000000n)]
          : j.pendingEth.step === 'swap_vkoin_usdt' ? [transfer(RC.USDT, 2000000n)]
          : j.pendingEth.step === 'swap_usdt_eth' ? [{ address: RC.WETH, topics: [ethers.id('Withdrawal(address,uint256)'), topicAddress(RC.V3_SWAP_ROUTER)], data: ethers.toBeHex(eth('0.05'), 32) }] : [];
        h.receipt(receipt(logs));
      } else h.receipt(null);
      await h.trade.tick();
      assert.notEqual(h.current().status, 'error', h.current().error);
    }
    assert.equal(h.current().status, 'done', 'full reverse route ' + route);
    assert.equal(h.current().receivedEth, '0.0495');
    assert.ok(eth(h.current().actualGasEth) > 0n);
    assert.equal(h.trade.blocks(account), false);
    console.log('Reverse route ' + route + ': full receipt-driven completion and exact fee settlement passed');
  }
  // Updating gas resumes the same paused sale only after a new passkey approval.
  async function pausedSale(route = 'C') {
    const h = harness();
    const q = await h.trade.sellQuote(account, '100');
    await approve(h, { kind: 'sell', quoteId: q.routes.find(r => r.route === route).quoteId });
    Object.assign(h.current(), { status: 'error', failedAt: 'sell_fee', grossReceived: eth('0.05').toString(),
      gasSpent: eth('0.00185').toString(), actualGasEth: '0.00185',
      error: 'Ethereum gas exceeds the approved price; retry when fees fall' });
    h.provider.getFeeData = async () => ({ gasPrice: 5000000000n });
    return h;
  }
  for (const route of ['B', 'C']) {
    const h = await pausedSale(route), original = JSON.parse(JSON.stringify(h.current()));
    assert.equal(h.trade.status(account).canUpdateGas, true);
    const prep = await h.trade.prepare(account, { kind: 'update-gas', gasPriceCap: '1', gasBudget: '1' }, identity);
    assert.equal(prep.review.gasPriceGwei, '7.5');
    assert.equal(prep.review.gasReady, true);
    assert.ok(eth(prep.review.additionalGasEth) > 0n);
    assert.deepEqual(h.current(), original, 'reviewing a fee changes no job or approval');
    assert.equal(h.broadcasts.length, 0);
    const sig = await proof(prep.challenge);
    await h.trade.submit(account, prep.ref, sig, identity);
    assert.equal(h.current().status, 'sell_fee');
    assert.equal(h.current().gasPriceCap, '7500000000');
    for (const field of ['id', 'amount', 'amountKoin', 'minWei', 'usdtMin', 'feeWei', 'feeTo', 'gasSpent', 'grossReceived']) {
      assert.equal(h.current()[field], original[field], field + ' is preserved');
    }
    await h.trade.submit(account, prep.ref, sig, identity);
    assert.equal(h.current().gasUpdates.length, 1, 'duplicate approvals never expand the budget twice');
    h.restart();
    assert.equal(h.current().gasPriceCap, '7500000000', 'approval survives restart');
    await h.trade.tick();
    assert.equal(ethers.Transaction.from(h.current().pendingEth.raw).gasPrice, 7500000000n);
    await assert.rejects(h.trade.prepare(account, { kind: 'update-gas' }, identity), /not paused/);
    const r = receipt(); r.gasPrice = 7500000000n;
    h.receipt(r); await h.trade.tick();
    assert.equal(h.current().status, 'done', 'the paused sale completes with the new gas cap');
    assert.equal(h.current().receivedEth, '0.0495');
  }
  {
    const h = await pausedSale();
    await approve(h, { kind: 'retry' });
    assert.equal(h.current().gasPriceCap, '1500000000', 'ordinary Retry never raises a fee');
    await h.trade.tick();
    assert.equal(h.current().status, 'error');
    let prep = await h.trade.prepare(account, { kind: 'update-gas' }, identity);
    h.provider.getFeeData = async () => ({ gasPrice: 100000000000n });
    await assert.rejects(h.trade.submit(account, prep.ref, await proof(prep.challenge), identity), /Gas changed again/);
    assert.equal(h.current().gasPriceCap, '1500000000');
    h.provider.getFeeData = async () => ({ gasPrice: 5000000000n });
    prep = await h.trade.prepare(account, { kind: 'update-gas' }, identity);
    h.current().gasSpent = '1';
    await assert.rejects(h.trade.submit(account, prep.ref, await proof(prep.challenge), identity), /Sale changed/);
  }
  {
    const h = await pausedSale(); h.own(0n);
    const prep = await h.trade.prepare(account, { kind: 'update-gas' }, identity);
    assert.equal(prep.review.gasReady, false);
    assert.ok(eth(prep.review.shortfallEth) > 0n);
    await assert.rejects(h.trade.submit(account, prep.ref, await proof(prep.challenge), identity), /Add enough ETH/);
    assert.equal(h.current().status, 'error');
    h.current().pendingEth = { hash: 'pending' };
    assert.equal(h.trade.status(account).canUpdateGas, false);
    await assert.rejects(h.trade.prepare(account, { kind: 'update-gas' }, identity), /not paused/);
    h.current().pendingEth = null; h.current().error = 'Price is below your approved ETH minimum';
    assert.equal(h.trade.status(account).canUpdateGas, false, 'a fee update cannot bypass a price minimum');
  }
  {
    const h = await pausedSale();
    h.provider.getTransactionCount = async (_address, tag) => tag === 'pending' ? 1 : 0;
    await assert.rejects(h.trade.prepare(account, { kind: 'update-gas' }, identity), /Wait for existing/);
    h.provider.getTransactionCount = async () => 0;
    const prep = await h.trade.prepare(account, { kind: 'update-gas' }, identity);
    await assert.rejects(h.trade.submit(account, prep.ref, await proof(prep.challenge), { ...identity, origin: 'https://other.example' }), /same wallet site/);
    assert.equal(h.current().status, 'error');
  }
  {
    const h = await pausedSale();
    Object.assign(h.current(), { failedAt: 'swap_usdt_eth', usdtAmount: '264958486' });
    const quote = routes.quoteUsdtEth;
    routes.quoteUsdtEth = async () => ({ amount: eth('0.01'), fee: 500 });
    await assert.rejects(h.trade.prepare(account, { kind: 'update-gas' }, identity), /approved ETH minimum/);
    routes.quoteUsdtEth = async () => ({ amount: eth('0.05'), fee: 500 });
    await approve(h, { kind: 'update-gas' });
    await h.trade.tick();
    const tx = ethers.Transaction.from(h.current().pendingEth.raw);
    assert.equal(tx.to, RC.V3_SWAP_ROUTER, 'a paused USDT swap resumes its existing conversion');
    assert.equal(tx.gasPrice, 7500000000n);
    routes.quoteUsdtEth = quote;
  }
  {
    const h = await pausedSale();
    Object.assign(h.current(), { gasSpent: h.current().gasBudget,
      error: 'This sale reached its approved gas budget; operator review is required' });
    h.provider.getFeeData = async () => ({ gasPrice: 1000000000n });
    const prep = await h.trade.prepare(account, { kind: 'update-gas' }, identity);
    assert.equal(prep.review.gasPriceGwei, '1.5');
    assert.ok(eth(prep.review.additionalGasEth) > 0n, 'an exhausted budget can be renewed without raising the price cap');
    const clock = Date.now;
    try {
      Date.now = () => prep.expires + 1;
      await assert.rejects(h.trade.submit(account, prep.ref, await proof(prep.challenge), identity), /Approval expired/);
    } finally { Date.now = clock; }
    assert.equal(h.current().status, 'error');
  }
  console.log('Sale gas recovery: explicit passkey review, same-sale completion on both routes, restart, replay, changed fees, balance, nonce, pending receipts and price floors passed');
  routes.quote = quoteReal;
})().catch(e => { console.error(e); process.exitCode = 1; });
