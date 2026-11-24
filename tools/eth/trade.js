'use strict';
const crypto = require('crypto');
const { ethers } = require('ethers');
const chain = require('../chain');
const auth = require('../dapp-auth');
const withdrawal = require('./withdrawal');
const routes = require('./sell-routes');
const koindx = require('./koindx');
const swap = require('./eth-swap-exec');
const RC = require('./route-constants');
const { BRIDGE } = require('./bridge-constants');
const done = j => !j || ['done', 'cancelled', 'failed'].includes(j.status);
const tapStates = new Set(['sell_swap', 'sell_bridge', 'sell_refresh']);
const ethSteps = ['eth_redeem', 'approve_vkoin', 'approve_sell_router', 'swap_vkoin_usdt',
  'approve_sell_usdt_reset', 'approve_sell_usdt', 'swap_usdt_eth', 'sell_fee'];
// Conservative allowances for later steps; the next step uses a live estimate.
const stepGas = [400000n, 65000n, 100000n, 450000n, 65000n, 65000n, 300000n, 40000n];
const fmt = ethers.formatEther;
const clone = value => JSON.parse(JSON.stringify(value));
const fingerprint = j => crypto.createHash('sha256').update(JSON.stringify(j)).digest('hex');
const gasHeadroom = units => (BigInt(units) * 12n + 9n) / 10n;
const canUpdateGas = j => !!(j?.kind === 'sell' && j.status === 'error' && !j.pendingEth && !j.pendingKoin
  && ethSteps.includes(j.failedAt) && /gas exceeds the approved price|reached its approved gas budget/.test(j.error || ''));
// Temporary per-sale ceiling for the owner-authorized live testing rollout.
const MAX_SELL_KOIN_SATS = 20000n * 100000000n;
function assertSellLimit(amount) {
  if (BigInt(amount) <= 0n || BigInt(amount) > MAX_SELL_KOIN_SATS) {
    throw new Error('Live testing is limited to 20,000 KOIN per sale');
  }
}

function create({ settings, store, persist, provider, transit, buyBusy, invalidate }) {
  const intents = new Map(), quotes = new Map(), busy = new Set();
  const current = account => store().trades?.[account];
  function save(account, job) {
    store().trades ||= {}; store().tradeHistory ||= {};
    const prior = current(account);
    if (prior) store().tradeHistory[prior.id] = prior;
    if (prior?.status !== job.status) job.lastError = null;
    job.updatedAt = Date.now(); store().trades[account] = job;
    store().tradeHistory[job.id] = job;
    persist(); invalidate(account);
    return job;
  }
  function publicJob(j) {
    if (!j) return null;
    const fields = ['id', 'kind', 'status', 'route', 'from', 'to', 'amountEth', 'amountKoin', 'gasEth', 'max',
      'expectedEth', 'minimumEth', 'gasBudgetEth', 'platformFeeEth', 'actualGasEth', 'receivedEth',
      'error', 'lastError', 'updatedAt', 'bridgeTx', 'txHash', 'cancelled', 'mayLeaveDust'];
    return { ...Object.fromEntries(fields.filter(k => j[k] != null).map(k => [k, j[k]])),
      needsTap: tapStates.has(j.status), canCancel: j.kind === 'sell' && !j.moved && !j.pendingKoin && !j.pendingEth,
      canUpdateGas: canUpdateGas(j),
      pendingTx: j.pendingEth?.hash || j.pendingKoin?.id };
  }
  function live() { if (settings.demo || settings.network !== 'mainnet') throw new Error('Selling and ETH withdrawals require the live mainnet wallet'); }
  function idle(account) {
    live();
    if (busy.has(account) || buyBusy(account) || !done(current(account))) throw new Error('Finish or resume the current trade before starting another trade or withdrawal');
    if (!transit(account)) throw new Error('Open Trade to create your Ethereum address first');
  }
  async function locked(account, fn) {
    if (busy.has(account)) throw new Error('This account is processing a trade; please wait');
    busy.add(account); try { return await fn(); } finally { busy.delete(account); }
  }
  function remember(map, key, value) {
    for (const [id, item] of map) if (item.expires <= Date.now()) map.delete(id);
    if (map.size >= 500) throw new Error('Too many pending trade requests; try again shortly');
    map.set(key, value); return value;
  }
  async function sellQuote(account, amount) {
    idle(account);
    const text = String(amount || '').trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(text)) throw new Error('Enter a KOIN amount with at most 8 decimal places');
    const sats = ethers.parseUnits(text, 8);
    assertSellLimit(sats);
    const p = await provider(), from = transit(account).ethAddress;
    const [balance, ethBalance, fee, network] = await Promise.all([
      chain.koinBalanceSats(account), p.getBalance(from), p.getFeeData(), p.getNetwork(),
    ]);
    if (network.chainId !== 1n) throw new Error('Ethereum mainnet is required');
    if (sats > BigInt(balance)) throw new Error('Not enough KOIN');
    if (!fee.gasPrice || fee.gasPrice <= 0n) throw new Error('Ethereum gas price unavailable');
    const gasPrice = (fee.gasPrice * 15n + 9n) / 10n;
    const rate = BigInt(Math.round(settings.fee.ratePct * 100));
    if (rate >= 10000n) throw new Error('Invalid platform fee configuration');
    const feeTo = settings.gasSponsorKey ? new ethers.Wallet(settings.gasSponsorKey).address : settings.fee.treasury;
    if (rate > 0n && (!ethers.isAddress(feeTo) || feeTo === ethers.ZeroAddress || feeTo.toLowerCase() === from.toLowerCase())) throw new Error('Conversion fee recipient is not configured');
    const all = await Promise.all(['B', 'C'].map(async route => {
      try {
        const plan = await routes.quote(route, sats, settings.slippageBps, p);
        if (BigInt(plan.grossWei) > ethers.parseEther(settings.maxEth)) throw new Error('This sale exceeds the ETH trade limit; use a smaller KOIN amount');
        const feeWei = BigInt(plan.grossWei) * rate / 10000n;
        const gasBudget = (BigInt(plan.gasUnits) + (feeWei > 0n ? 40000n : 0n)) * gasPrice;
        if (BigInt(plan.minWei) <= feeWei + gasBudget) throw new Error('The sale is too small to cover its Ethereum fees');
        const id = crypto.randomUUID(), expires = Date.now() + 120000;
        const q = { ...plan, quoteId: id, account, from, amount: sats.toString(), amountKoin: text, expires,
          feeWei: feeWei.toString(), feeTo, gasBudget: gasBudget.toString(), gasPriceCap: gasPrice.toString(),
          expectedEth: fmt(BigInt(plan.grossWei) - feeWei), minimumEth: fmt(BigInt(plan.minWei) - feeWei),
          platformFeeEth: fmt(feeWei), gasBudgetEth: fmt(gasBudget), gasReady: ethBalance >= gasBudget };
        remember(quotes, id, q);
        return { route, quoteId: id, expires, label: q.label, via: q.via, expectedEth: q.expectedEth,
          minimumEth: q.minimumEth, gasBudgetEth: q.gasBudgetEth, platformFeeEth: q.platformFeeEth,
          netEstimateEth: fmt(BigInt(plan.grossWei) - feeWei - gasBudget), gasReady: q.gasReady };
      } catch (e) { return { route, error: e.message }; }
    }));
    const available = all.filter(r => !r.error).sort((a, b) => ethers.parseEther(a.netEstimateEth) > ethers.parseEther(b.netEstimateEth) ? -1 : 1);
    if (available.length) available[0].best = true;
    return { amountKoin: text, ethBalance: fmt(ethBalance), routes: [...available, ...all.filter(r => r.error)] };
  }
  async function prepare(account, body, identity) {
    live();
    let payload;
    if (body.kind === 'withdraw') {
      idle(account);
      payload = { kind: 'withdraw', ...await withdrawal.quote({ provider: await provider(),
        from: transit(account).ethAddress, to: body.to, amount: body.amount, max: body.max ?? false }) };
    } else if (body.kind === 'sell') {
      idle(account);
      const q = quotes.get(String(body.quoteId));
      if (!q || q.account !== account || q.expires <= Date.now()) throw new Error('Sell quote expired; refresh the routes');
      assertSellLimit(q.amount);
      if (await (await provider()).getBalance(q.from) < BigInt(q.gasBudget)) throw new Error(`Keep at least ${q.gasBudgetEth} ETH at this address for the sale's Ethereum gas`);
      payload = { kind: 'sell', ...clone(q) };
    } else if (body.kind === 'update-gas') {
      payload = await locked(account, () => gasReview(account));
    } else if (['retry', 'cancel'].includes(body.kind)) {
      const j = current(account);
      if (!j || done(j)) throw new Error('No trade to update');
      if (body.kind === 'cancel' && (j.moved || j.pendingKoin || j.pendingEth)) throw new Error('This trade has moved funds; resume it instead');
      payload = { kind: body.kind, jobId: j.id };
    } else throw new Error('Unsupported trade action');
    const ref = crypto.randomUUID(), expires = Math.min(Date.now() + 120000, payload.expires || Infinity);
    const digest = crypto.createHash('sha256').update(JSON.stringify({ ref, account, payload })).digest('hex');
    const challenge = '0x' + Buffer.from('koin-vault:trade:').toString('hex') + digest;
    remember(intents, ref, { account, payload, identity: clone(identity), challenge, expires });
    const { request, ...review } = payload;
    return { ref, challenge, expires, review };
  }
  async function submit(account, ref, signature, identity) {
    live();
    return locked(account, async () => {
      const existing = store().tradeHistory?.[ref];
      if (existing?.account === account) return publicJob(existing);
      if (current(account)?.lastGasUpdateRef === ref) return publicJob(current(account));
      const intent = intents.get(ref);
      if (!intent || intent.account !== account || intent.expires <= Date.now()) throw new Error('Approval expired; review the trade again');
      intents.delete(ref);
      if (identity.origin !== intent.identity.origin || identity.rpId !== intent.identity.rpId) throw new Error('Approve from the same wallet site');
      await auth.verifyProof(account, intent.challenge, signature, chain, intent.identity);
      const v = intent.payload;
      if (v.kind === 'update-gas') {
        const j = current(account);
        if (!canUpdateGas(j) || fingerprint(j) !== v.jobFingerprint) throw new Error('Sale changed; review its gas again');
        const p = await provider();
        const request = await ethRequest({ ...j, status: j.failedAt }, p);
        const [network, fee, balance, nonce, latest, units] = await Promise.all([
          p.getNetwork(), p.getFeeData(), p.getBalance(j.from), p.getTransactionCount(j.from, 'pending'),
          p.getTransactionCount(j.from, 'latest'), p.estimateGas({ ...request, from: j.from, gasPrice: BigInt(v.gasPriceCap) }),
        ]);
        if (network.chainId !== 1n || nonce !== latest) throw new Error('Wait for existing Ethereum transactions to confirm');
        if (!fee.gasPrice || fee.gasPrice <= 0n || fee.gasPrice > BigInt(v.gasPriceCap)) throw new Error('Gas changed again; review the updated fee');
        const remaining = BigInt(v.gasBudget) - BigInt(j.gasSpent || '0');
        if (gasHeadroom(units) * BigInt(v.gasPriceCap) > remaining) throw new Error('Gas estimate changed; review the updated fee');
        if (balance < remaining + BigInt(request.value || 0)) throw new Error('Add enough ETH for the updated gas budget, then review again');
        save(account, { ...j, status: j.failedAt, failedAt: null, error: null, lastError: null,
          gasPriceCap: v.gasPriceCap, gasBudget: v.gasBudget, gasBudgetEth: fmt(v.gasBudget), lastGasUpdateRef: ref,
          gasUpdates: [...(j.gasUpdates || []), { ref, approvedAt: Date.now(), previousGasPriceCap: j.gasPriceCap,
            previousGasBudget: j.gasBudget, gasPriceCap: v.gasPriceCap, gasBudget: v.gasBudget }] });
        return publicJob(current(account));
      }
      if (['retry', 'cancel'].includes(v.kind)) {
        const j = current(account);
        if (!j || j.id !== v.jobId || done(j)) throw new Error('Trade changed; refresh first');
        if (v.kind === 'cancel') {
          if (j.moved || j.pendingKoin || j.pendingEth) throw new Error('This trade has moved funds; resume it instead');
          save(account, { ...j, status: 'cancelled' });
        } else if (j.status === 'error') save(account, { ...j, status: j.failedAt, error: null });
        return publicJob(current(account));
      }
      if (buyBusy(account) || !done(current(account))) throw new Error('Another trade is using this address');
      const p = await provider();
      if ((await p.getNetwork()).chainId !== 1n) throw new Error('Ethereum mainnet is required');
      if (v.kind === 'withdraw') {
        const req = v.request;
        if (await p.getTransactionCount(v.from, 'pending') !== req.nonce || await p.getTransactionCount(v.from, 'latest') !== req.nonce) throw new Error('Ethereum nonce changed; review again');
        if (await p.getBalance(v.from) < BigInt(req.value) + BigInt(req.gasPrice) * BigInt(req.gasLimit)) throw new Error('ETH balance changed; review again');
        if (await p.estimateGas({ ...req, from: v.from }) > BigInt(req.gasLimit)) throw new Error('Gas estimate changed; review again');
        const raw = await new ethers.Wallet(transit(account).ethPriv).signTransaction(req);
        const hash = ethers.keccak256(raw);
        save(account, { ...v, request: undefined, id: ref, account, status: 'withdraw_pending', txHash: hash,
          pendingEth: { raw, hash, step: 'withdraw', sentAt: 0 } });
      } else {
        assertSellLimit(v.amount);
        if (await p.getBalance(v.from) < BigInt(v.gasBudget)) throw new Error('ETH gas balance changed; refresh the quote');
        if (BigInt(await chain.koinBalanceSats(account)) < BigInt(v.amount)) throw new Error('KOIN balance changed');
        save(account, { ...v, id: ref, account, status: v.route === 'B' ? 'sell_swap' : 'sell_bridge',
          gasSpent: '0', actualGasEth: '0', moved: false });
      }
      return publicJob(current(account));
    });
  }
  async function prepareTap(account) {
    const j = current(account);
    if (!j || j.kind !== 'sell' || !tapStates.has(j.status) || j.pendingKoin) throw new Error('Sale is not waiting for a passkey');
    let ops;
    if (j.status === 'sell_swap') {
      ops = await koindx.opsKoindxSwap({ account, amountInSats: j.amount, amountOutMin: j.swapMin, provider: chain.provider(), reverse: true });
    } else if (j.status === 'sell_bridge') {
      const amount = j.route === 'B' ? j.vethAmount : j.amount;
      const fee = await routes.bridgeFee(j.route);
      if (fee > BigInt(j.bridgeFee)) throw new Error('Vortex fees increased beyond this sale quote; wait before bridging');
      ops = await routes.bridgeOps(account, j.route === 'B' ? BRIDGE.mainnet.veth : BRIDGE.mainnet.koin, amount, j.from, j.id);
    } else ops = await routes.refreshOps(j.bridgeTx, j.opId);
    return { step: `sell:${j.id}:${j.status}`, ops, rcLimit: koindx.DEFAULT_SWAP_RC };
  }
  function beforeKoinBroadcast(account, step, transaction) {
    const j = current(account);
    if (!j || step !== `sell:${j.id}:${j.status}` || !tapStates.has(j.status) || j.pendingKoin) throw new Error('Sale changed since preparation; refresh first');
    save(account, { ...j, status: 'koin_pending', pendingKoin: { ...clone(transaction), step: j.status, sentAt: Date.now() }, moved: true });
  }
  async function ethRequest(j, p, deadline = Math.floor(Date.now() / 1000) + 1800) {
    if (j.status === 'eth_redeem') {
      if (!j.record || Number(j.record.expiration) <= Date.now() + 60000) throw new Error('Vortex signatures expired; Retry to refresh them first');
      return routes.redeemTx(j.record);
    }
    if (j.status === 'approve_vkoin') return swap.buildApproveTx(RC.VKOIN, RC.PERMIT2, j.vkoinAmount);
    if (j.status === 'approve_sell_router') return swap.buildPermit2ApproveTx({ token: RC.VKOIN, spender: RC.UNIVERSAL_ROUTER, amount: j.vkoinAmount, expiration: deadline + 1800 });
    if (j.status === 'swap_vkoin_usdt') {
      if (await routes.quoteVkoinUsdt(p, BigInt(j.vkoinAmount)) < BigInt(j.usdtMin)) throw new Error('Price is below your approved USDT minimum; retry when the price recovers');
      return routes.vkoinUsdtTx(j.vkoinAmount, j.usdtMin, deadline);
    }
    if (j.status === 'approve_sell_usdt_reset') return swap.buildApproveTx(RC.USDT, RC.V3_SWAP_ROUTER, 0n);
    if (j.status === 'approve_sell_usdt') return swap.buildApproveTx(RC.USDT, RC.V3_SWAP_ROUTER, j.usdtAmount);
    if (j.status === 'swap_usdt_eth') {
      const q = await routes.quoteUsdtEth(p, BigInt(j.usdtAmount));
      if (q.amount < BigInt(j.minWei)) throw new Error('Price is below your approved ETH minimum; retry when the price recovers');
      return routes.usdtEthTx(j.usdtAmount, j.minWei, q.fee, j.from, deadline);
    }
    if (j.status === 'sell_fee') {
      if (BigInt(j.grossReceived) < BigInt(j.minWei)) throw new Error('ETH output is below the approved minimum; operator review is required');
      return { to: j.feeTo, value: BigInt(j.feeWei) };
    }
    throw new Error('This sale is not waiting for an Ethereum transaction');
  }
  async function gasReview(account) {
    const j = current(account);
    if (!canUpdateGas(j)) throw new Error('This sale is not paused for a gas update; Retry or wait for confirmation');
    const p = await provider(), step = { ...j, status: j.failedAt };
    const [network, fee, balance, nonce, latest] = await Promise.all([
      p.getNetwork(), p.getFeeData(), p.getBalance(j.from), p.getTransactionCount(j.from, 'pending'), p.getTransactionCount(j.from, 'latest'),
    ]);
    if (network.chainId !== 1n || nonce !== latest) throw new Error('Wait for existing Ethereum transactions to confirm');
    if (!fee.gasPrice || fee.gasPrice <= 0n) throw new Error('Ethereum gas price unavailable');
    const suggested = (fee.gasPrice * 15n + 9n) / 10n;
    const price = suggested > BigInt(j.gasPriceCap) ? suggested : BigInt(j.gasPriceCap);
    const request = await ethRequest(step, p);
    let units = gasHeadroom(await p.estimateGas({ ...request, from: j.from, gasPrice: price }));
    for (let i = ethSteps.indexOf(j.failedAt) + 1; i < ethSteps.length; i++) {
      if (j.route === 'B' && ethSteps[i] !== 'sell_fee') continue;
      if (ethSteps[i] === 'sell_fee' && BigInt(j.feeWei) === 0n) continue;
      units += stepGas[i];
    }
    // A Permit2 approval can expire during a later swap; reserve its renewal.
    if (j.failedAt === 'swap_vkoin_usdt') units += stepGas[2];
    const spent = BigInt(j.gasSpent || '0'), estimated = spent + units * price;
    const budget = estimated > BigInt(j.gasBudget) ? estimated : BigInt(j.gasBudget);
    const remaining = budget - spent, required = remaining + BigInt(request.value || 0);
    return { kind: 'update-gas', jobId: j.id, jobFingerprint: fingerprint(j), amountKoin: j.amountKoin,
      minimumEth: j.minimumEth, platformFeeEth: j.platformFeeEth,
      gasPriceCap: price.toString(), gasBudget: budget.toString(),
      previousGasPriceGwei: ethers.formatUnits(j.gasPriceCap, 9), gasPriceGwei: ethers.formatUnits(price, 9),
      previousGasBudgetEth: fmt(j.gasBudget), gasBudgetEth: fmt(budget), actualGasEth: fmt(spent),
      remainingGasEth: fmt(remaining), additionalGasEth: fmt(budget - BigInt(j.gasBudget)),
      shortfallEth: fmt(required > balance ? required - balance : 0n), gasReady: balance >= required };
  }
  async function stageEth(account, j, request) {
    const p = await provider();
    const [network, fee, nonce, latest] = await Promise.all([p.getNetwork(), p.getFeeData(),
      p.getTransactionCount(j.from, 'pending'), p.getTransactionCount(j.from, 'latest')]);
    if (network.chainId !== 1n || nonce !== latest) throw new Error('Wait for existing Ethereum transactions to confirm');
    if (!fee.gasPrice || fee.gasPrice <= 0n || fee.gasPrice > BigInt(j.gasPriceCap)) throw new Error('Ethereum gas exceeds the approved price; retry when fees fall');
    const gasPrice = BigInt(j.gasPriceCap);
    const gasLimit = gasHeadroom(await p.estimateGas({ ...request, from: j.from, gasPrice }));
    if (BigInt(j.gasSpent) + gasLimit * gasPrice > BigInt(j.gasBudget)) throw new Error('This sale reached its approved gas budget; review an updated gas fee to continue');
    if (await p.getBalance(j.from) < BigInt(request.value || 0) + gasLimit * gasPrice) throw new Error('Add ETH to this address for the remaining gas, then retry');
    const raw = await new ethers.Wallet(transit(account).ethPriv).signTransaction({ ...request, gasLimit, gasPrice, nonce, chainId: 1, type: 0 });
    save(account, { ...j, pendingEth: { raw, hash: ethers.keccak256(raw), step: j.status, sentAt: 0 } });
  }
  async function pollEth(account, j) {
    const p = await provider(), pending = j.pendingEth;
    const r = await p.getTransactionReceipt(pending.hash);
    if (!r) {
      if (Date.now() - pending.sentAt >= 15000) {
        // Save before network use. A timeout can only rebroadcast these exact bytes.
        save(account, { ...j, pendingEth: { ...pending, sentAt: Date.now() } });
        try { await p.broadcastTransaction(pending.raw); }
        catch (e) { if (!/already known|known transaction/i.test(e.message)) throw e; }
      }
      return;
    }
    const head = await p.getBlockNumber();
    if (head - r.blockNumber + 1 < 3) return;
    if ((await p.getBlock(r.blockNumber))?.hash !== r.blockHash) return;
    const gas = BigInt(r.gasUsed) * BigInt(r.gasPrice);
    const spent = BigInt(j.gasSpent || '0') + gas;
    const next = { ...j, gasSpent: spent.toString(), actualGasEth: fmt(spent), txHash: pending.hash, pendingEth: null };
    // Keep a confirmed receipt durably until all output accounting succeeds.
    if (Number(r.status) !== 1) {
      save(account, { ...next, status: j.kind === 'withdraw' ? 'failed' : 'error', failedAt: pending.step,
        error: 'Ethereum transaction reverted. Network gas was paid; no transfer or swap completed.' }); return;
    }
    if (j.kind === 'withdraw') { save(account, { ...next, status: 'done' }); return; }
    if (pending.step === 'eth_redeem') {
      if (j.route === 'B') Object.assign(next, { grossReceived: (BigInt(j.bridgeAmount) * 10000000000n).toString(), status: 'sell_fee' });
      else {
        const received = swap.receivedInTx(r, RC.VKOIN, j.from);
        if (received == null || received < BigInt(j.bridgeAmount)) throw new Error('Could not verify the vKOIN receipt');
        Object.assign(next, { vkoinAmount: received.toString(), status: 'approve_vkoin' });
      }
    } else if (pending.step === 'approve_vkoin') next.status = 'approve_sell_router';
    else if (pending.step === 'approve_sell_router') next.status = 'swap_vkoin_usdt';
    else if (pending.step === 'swap_vkoin_usdt') {
      const received = swap.receivedInTx(r, RC.USDT, j.from);
      if (received == null || received < BigInt(j.usdtMin)) throw new Error('Could not verify the USDT swap receipt');
      Object.assign(next, { usdtAmount: received.toString(), status: 'approve_sell_usdt_reset' });
    } else if (pending.step === 'approve_sell_usdt_reset') next.status = 'approve_sell_usdt';
    else if (pending.step === 'approve_sell_usdt') next.status = 'swap_usdt_eth';
    else if (pending.step === 'swap_usdt_eth') {
      const topic = ethers.id('Withdrawal(address,uint256)');
      const owner = ethers.zeroPadValue(RC.V3_SWAP_ROUTER, 32).toLowerCase();
      const received = (r.logs || []).filter(l => l.address.toLowerCase() === RC.WETH.toLowerCase()
        && l.topics[0] === topic && l.topics[1]?.toLowerCase() === owner).reduce((n, l) => n + BigInt(l.data), 0n);
      if (received < BigInt(j.minWei)) throw new Error('Could not verify native ETH delivery');
      Object.assign(next, { grossReceived: received.toString(), status: 'sell_fee' });
    } else if (pending.step === 'sell_fee') Object.assign(next, { status: 'done', receivedEth: fmt(BigInt(j.grossReceived) - BigInt(j.feeWei)) });
    save(account, next);
  }
  async function pollKoin(account, j) {
    const pending = j.pendingKoin;
    const receipt = await routes.koinReceipt(pending.id);
    if (receipt?.pendingFinality) return;
    if (!receipt) {
      if (Date.now() - pending.sentAt >= 30000) {
        save(account, { ...j, pendingKoin: { ...pending, sentAt: Date.now() } });
        const { step, sentAt, ...transaction } = pending;
        // Same nonce, operations and signatures; never prepare a replacement.
        await chain.provider().sendTransaction(transaction);
      }
      return;
    }
    if (receipt.reverted) { save(account, { ...j, pendingKoin: null, status: 'error', failedAt: pending.step, error: 'Koinos transaction reverted; retry this step' }); return; }
    const next = { ...j, pendingKoin: null };
    if (pending.step === 'sell_swap') Object.assign(next, { vethAmount: await routes.vethReceived(receipt, account), status: 'sell_bridge' });
    else if (pending.step === 'sell_bridge') {
      const locked = await routes.lockedTransfer(receipt, j, account);
      Object.assign(next, { bridgeTx: pending.id, opId: locked.opId, bridgeAmount: locked.amount, status: 'sell_signatures' });
    } else next.status = 'sell_signatures';
    save(account, next);
  }
  async function advance(account, j) {
    if (j.pendingEth) return pollEth(account, j);
    if (j.pendingKoin) return pollKoin(account, j);
    const p = await provider(), deadline = Math.floor(Date.now() / 1000) + 1800;
    if (j.status === 'sell_signatures') {
      const r = await routes.record(j, p);
      if (!r) return;
      save(account, { ...j, status: r.expired ? 'sell_refresh' : 'eth_redeem', record: r.expired ? null : r });
    } else if (j.status === 'eth_redeem') {
      if (Number(j.record.expiration) <= Date.now() + 60000) { save(account, { ...j, status: 'sell_refresh', record: null }); return; }
    } else if (j.status === 'swap_vkoin_usdt') {
      const allowance = await swap.permit2Allowance(p, j.from, RC.VKOIN, RC.UNIVERSAL_ROUTER);
      if (BigInt(allowance.expiration) <= BigInt(deadline) || BigInt(allowance.amount) < BigInt(j.vkoinAmount)) { save(account, { ...j, status: 'approve_sell_router' }); return; }
    } else if (j.status === 'approve_sell_usdt_reset') {
      if (await swap.allowance(p, RC.USDT, j.from, RC.V3_SWAP_ROUTER) === 0n) { save(account, { ...j, status: 'approve_sell_usdt' }); return; }
    } else if (j.status === 'sell_fee') {
      if (BigInt(j.grossReceived) < BigInt(j.minWei)) throw new Error('ETH output is below the approved minimum; operator review is required');
      if (BigInt(j.feeWei) === 0n) { save(account, { ...j, status: 'done', receivedEth: fmt(j.grossReceived) }); return; }
    }
    if (ethSteps.includes(j.status)) await stageEth(account, j, await ethRequest(j, p, deadline));
  }
  async function tick() {
    if (settings.demo) return;
    for (const account of Object.keys(store().trades || {})) {
      const j = current(account);
      if (done(j) || j.status === 'error' || tapStates.has(j.status) || busy.has(account)) continue;
      await locked(account, async () => {
        try { await advance(account, j); }
        catch (e) {
          const latest = current(account);
          const message = String(e.shortMessage || e.message || e).replace(/https?:\/\/[^\s)]+/g, '[RPC]').slice(0, 240);
          // An uncertain broadcast or output read retains the transaction and
          // keeps polling; it must never become permission to send a new one.
          save(account, latest.pendingEth || latest.pendingKoin
            ? { ...latest, lastError: message }
            : { ...latest, status: 'error', failedAt: latest.status, error: message });
        }
      });
    }
  }
  return { sellQuote, prepare, submit, prepareTap, beforeKoinBroadcast, tick,
    current, status: account => publicJob(current(account)),
    blocks: account => busy.has(account) || !done(current(account)),
    needsTap: account => tapStates.has(current(account)?.status) };
}
module.exports = { create };
