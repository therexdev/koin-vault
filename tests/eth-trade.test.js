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
    chain.koinBalanceSats = async () => '2000000000000';
    for (const amount of ['9999.99999999', '10000']) {
      const q = await h.trade.sellQuote(account, amount);
      assert.equal(q.routes.filter(r => !r.error).length, 2);
      const prep = await h.trade.prepare(account, { kind: 'sell', quoteId: q.routes[0].quoteId }, identity);
      assert.equal(prep.review.amountKoin, amount);
    }
    for (const amount of ['10000.00000001', '10001', '20000']) {
      await assert.rejects(h.trade.sellQuote(account, amount), /10,000 KOIN per sale/);
    }
    assert.equal(h.current(), undefined);
    assert.equal(h.broadcasts.length, 0);
    chain.koinBalanceSats = async () => '100000000000';
    console.log('Live sell limit: exact 10,000 KOIN boundary accepted, one satoshi over rejected before trading');
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
  routes.quote = quoteReal;
})().catch(e => { console.error(e); process.exitCode = 1; });
