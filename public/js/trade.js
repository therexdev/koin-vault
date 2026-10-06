'use strict';
const Trade = (() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let ctx, state, review, working = false, generation = 0, quoteGeneration = 0;
  let mode = 'buy', selected = null, refreshWorking = false;
  const dismissedNotices = new Map();
  // Only acknowledge finished notices. This never resets or cancels a job.
  function noticeIdentity(kind, job, account = state?.ethAddress || ctx?.credentialId?.()) {
    const finished = kind === 'buy' ? job?.status === 'done' : ['done', 'cancelled', 'failed'].includes(job?.status);
    const id = job?.id || job?.txHash || job?.swapId || job?.redeemId || job?.ethTxHash || job?.startedAt || job?.updatedAt;
    if (!finished || !id || !account) return null;
    return { key: `kv_trade_notice_v1:${account}:${kind}`, value: JSON.stringify([id, job.status]) };
  }
  function isNoticeDismissed(kind, job, account) {
    const notice = noticeIdentity(kind, job, account);
    if (!notice) return false;
    if (dismissedNotices.get(notice.key) === notice.value) return true;
    try { return localStorage.getItem(notice.key) === notice.value; } catch (_) { return false; }
  }
  function dismissNotice(kind, job) {
    const notice = noticeIdentity(kind, job);
    if (!notice) return false;
    dismissedNotices.set(notice.key, notice.value);
    try { localStorage.setItem(notice.key, notice.value); } catch (_) { /* Still dismissed for this session. */ }
    return true;
  }
  const assets = [
    { id: 'koin', symbol: 'KOIN', network: 'Koinos', dp: 8 },
    { id: 'vkoin', symbol: 'vKOIN', network: 'Ethereum', dp: 8 },
    { id: 'usdt', symbol: 'USDt', network: 'Ethereum', dp: 6 },
    { id: 'eth', symbol: 'ETH', network: 'Ethereum', dp: 8 },
    { id: 'sol', symbol: 'SOL', network: 'Solana', dp: 9 },
    { id: 'usdc', symbol: 'USDC', network: 'Ethereum', dp: 6 },
  ];
  const symbol = asset => assets.find(a => a.id === asset)?.symbol || '';
  function updateBalances() {
    if (!ctx) return;
    for (const asset of assets) {
      const node = document.querySelector(`[data-trade-balance="${asset.id}"]`);
      const sats = ctx.koinBalance?.();
      const value = asset.id === 'koin'
        ? /^\d+$/.test(sats || '') ? Portfolio.fromSats(sats, 8) : null
        : state?.balances?.[asset.id];
      node.textContent = value != null && /^\d+(\.\d+)?$/.test(String(value))
        ? Portfolio.fmtAmount(String(value), asset.dp) : state ? 'Unavailable' : 'Loading…';
    }
    const note = $('#trade-balances-note');
    note.textContent = state?.demo ? 'Sample balances · demo mode'
      : state?.balancesError || state?.balances?.solError ? 'Some balances are unavailable. Refresh to try again.'
      : !state?.balances ? 'Waiting for deposit balances. You can refresh to try again.'
      : 'KOIN is in your wallet. Other balances are at your deposit addresses.';
  }
  function updatePage() {
    const buying = mode === 'buy', ready = !!state?.enabled;
    $('#btn-trade-buy').setAttribute('aria-pressed', String(buying));
    $('#btn-trade-sell').setAttribute('aria-pressed', String(!buying));
    document.querySelectorAll('[data-trade-asset]').forEach(button => {
      const asset = button.dataset.tradeAsset;
      button.hidden = !buying && !['eth', 'vkoin'].includes(asset);
      button.textContent = asset === 'vkoin' ? 'View vKOIN' : buying ? `Buy with ${symbol(asset)}` : 'Sell for ETH';
      button.disabled = !ready;
      button.setAttribute('aria-expanded', String(selected === asset));
      button.classList.toggle('is-selected', selected === asset);
    });
    $('#trade-flow').hidden = !selected || !ready;
    $('#trade-buy-card').hidden = !buying || !selected || selected === 'vkoin';
    $('#sell-koin-card').hidden = buying || selected !== 'eth' || !!state?.demo;
    $('#trade-deposit-card').hidden = selected === 'vkoin';
    $('#trade-eth-actions').hidden = selected !== 'eth';
    $('#fund-sol-block').hidden = selected !== 'sol' || !state?.solAddress;
    $('#fund-eth-label').textContent = selected === 'sol' ? 'Add ETH for network gas' : `Deposit ${symbol(selected)}`;
    $('#fund-eth-note').textContent = `Send only ${selected === 'sol' ? 'ETH' : symbol(selected)} on Ethereum mainnet. Tap the address to copy.`;
    $('#trade-deposit-title').textContent = selected === 'eth' ? 'Deposit or withdraw ETH' : `Deposit ${symbol(selected)}`;
    $('#trade-withdraw-note').hidden = !buying || !selected || ['eth', 'vkoin'].includes(selected);
    $('#trade-withdraw-note').textContent = `${symbol(selected)} withdrawals are not supported yet.`;
    $('#trade-flow-title').textContent = selected === 'vkoin' ? 'Your vKOIN balance' : buying ? `Buy with ${symbol(selected)}` : 'Sell KOIN for ETH';
    $('#trade-flow-note').textContent = selected === 'vkoin'
      ? 'vKOIN is wrapped KOIN on Ethereum. Existing conversions continue through the bridge; their progress and any required approval appear below. Starting a separate vKOIN conversion is not supported yet.'
      : state?.demo && !buying ? 'Selling and withdrawals require a live account.'
      : buying ? `Use your ${symbol(selected)} balance or deposit more, then choose an amount and review the available routes.`
      : 'Compare routes, approve your sale, then withdraw the ETH when it arrives. You can add ETH below for network gas.';
  }
  function chooseMode(next) {
    if (next === mode) return;
    mode = next; selected = null; quoteGeneration++;
    $('#sell-routes').innerHTML = '';
    Fund.selectAsset(null);
    updatePage();
  }
  function openAsset(asset) {
    if (!state?.enabled || !assets.some(a => a.id === asset) || asset === 'koin') return;
    if (mode === 'sell' && !['eth', 'vkoin'].includes(asset)) return;
    selected = asset;
    Fund.selectAsset(mode === 'buy' && asset !== 'vkoin' ? asset : null);
    updatePage();
    $('#fund-eth-block').open = asset !== 'sol' && !(Number(state?.balances?.[asset]) > 0);
    $('#fund-sol-block').open = asset === 'sol' && !(Number(state?.balances?.sol) > 0);
    $('#trade-flow-title').focus({ preventScroll: true });
    $('#trade-flow').scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  async function refreshBalances() {
    if (refreshWorking) return;
    refreshWorking = true; $('#btn-trade-refresh').disabled = true;
    $('#btn-trade-refresh').textContent = 'Refreshing…';
    try { await Promise.all([Fund.refresh(), ctx.refreshKoin?.()]); }
    finally {
      refreshWorking = false; $('#btn-trade-refresh').disabled = false;
      $('#btn-trade-refresh').textContent = 'Refresh'; updateBalances();
    }
  }
  const labels = {
    sell_swap: 'Approve KOIN → vETH', sell_bridge: 'Approve bridge to Ethereum', sell_refresh: 'Refresh Vortex signatures',
    koin_pending: 'Confirming your Koinos transaction…', sell_signatures: 'Waiting for Vortex signatures…',
    eth_redeem: 'Receiving funds on Ethereum…', approve_vkoin: 'Approving vKOIN…', approve_sell_router: 'Approving Uniswap…',
    swap_vkoin_usdt: 'Swapping vKOIN → USDT…', approve_sell_usdt_reset: 'Preparing USDT approval…',
    approve_sell_usdt: 'Approving USDT…', swap_usdt_eth: 'Swapping USDT → native ETH…',
    sell_fee: 'Settling the quoted conversion fee…', withdraw_pending: 'Confirming your Ethereum withdrawal…',
  };
  function message(text) { $('#trade-message').textContent = text || ''; $('#trade-message').hidden = !text; }
  function modalMessage(text) { $('#eth-withdraw-message').textContent = text || ''; }
  function resetReview() { review = null; $('#eth-withdraw-review').hidden = true; $('#btn-eth-confirm').hidden = true; }
  function open(kind) {
    resetReview(); modalMessage('');
    $('#eth-withdraw-title').textContent = kind === 'withdraw' ? 'Withdraw Ethereum' : 'Review KOIN sale';
    $('#eth-withdraw-fields').hidden = kind !== 'withdraw';
    $('#eth-withdraw-to').value = ''; $('#eth-withdraw-amount').value = '';
    $('#eth-withdraw-amount').dataset.max = '';
    $('#eth-withdraw-from').textContent = `From ${state?.ethAddress || ''} · Ethereum mainnet`;
    $('#eth-withdraw-dialog').showModal();
  }
  function showReview(prepared) {
    review = prepared;
    const r = prepared.review;
    $('#eth-withdraw-review').hidden = false;
    if (r.kind === 'withdraw') {
      $('#eth-withdraw-review').textContent = `To ${r.to}\nAmount: ${r.amountEth} ETH\nMaximum network gas: ${r.gasEth} ETH\nTotal: ${r.totalEth} ETH`
        + (r.mayLeaveDust ? '\nUnused contract-call gas stays at this address.' : r.max ? '\nMax sends the balance minus network gas.' : '');
      $('#eth-withdraw-amount').value = r.amountEth;
    } else {
      $('#eth-withdraw-review').textContent = `${r.amountKoin} KOIN → approximately ${r.expectedEth} ETH\nMinimum if completed: ${r.minimumEth} ETH\nConversion fee: ${r.platformFeeEth} ETH (included above)\nEthereum gas budget: ${r.gasBudgetEth} ETH, paid separately from this address.\nETH arrives at ${r.from}.\nPrices can change while bridging. The sale pauses if its minimum or gas budget cannot be met.`;
    }
    $('#btn-eth-confirm').textContent = r.kind === 'withdraw' ? 'Confirm withdrawal with passkey' : 'Approve sale with passkey';
    $('#btn-eth-confirm').hidden = false;
  }
  function mount(context) {
    ctx = context;
    $('#trade-current-balances').innerHTML = assets.map(asset =>
      `<div class="trade-balance-row"><div class="trade-balance-info"><strong>${asset.symbol}</strong><span class="hint">${asset.network}</span>`
      + `<span class="trade-balance-value num" data-trade-balance="${asset.id}">Loading…</span></div>`
      + (asset.id === 'koin' ? '<span class="trade-balance-wallet">Wallet balance</span>'
        : `<button class="ghost small" type="button" data-trade-asset="${asset.id}" aria-controls="trade-flow" aria-expanded="false" disabled></button>`)
      + '</div>').join('');
    $('#btn-trade-buy').addEventListener('click', () => chooseMode('buy'));
    $('#btn-trade-sell').addEventListener('click', () => chooseMode('sell'));
    $('#btn-trade-refresh').addEventListener('click', refreshBalances);
    $('#btn-trade-dismiss').addEventListener('click', () => {
      if (!dismissNotice('trade', state?.trade)) return;
      render(state);
      $('#btn-trade-refresh').focus();
    });
    $('#btn-trade-close-flow').addEventListener('click', () => {
      const previous = selected; selected = null; Fund.selectAsset(null); updatePage();
      document.querySelector(`[data-trade-asset="${previous}"]`)?.focus();
    });
    $('#trade-current-balances').addEventListener('click', e => {
      const button = e.target.closest('[data-trade-asset]');
      if (button && !button.disabled) openAsset(button.dataset.tradeAsset);
    });
    for (const [id, asset] of [['#stat-eth-row', 'eth'], ['#stat-sol-row', 'sol'], ['#stat-stable-row', 'stable']]) {
      $(id)?.addEventListener('click', () => {
        chooseMode('buy');
        openAsset(asset === 'stable' ? Number(state?.spendable?.usdt) > 0 ? 'usdt' : 'usdc' : asset);
      });
    }
    updatePage(); updateBalances();
    $('#btn-eth-withdraw').addEventListener('click', () => open('withdraw'));
    $('#btn-eth-close').addEventListener('click', () => $('#eth-withdraw-dialog').close());
    for (const id of ['#eth-withdraw-to', '#eth-withdraw-amount']) $(id).addEventListener('input', () => {
      if (id.endsWith('amount')) $('#eth-withdraw-amount').dataset.max = '';
      resetReview();
    });
    $('#btn-eth-max').addEventListener('click', () => previewWithdrawal(true));
    $('#btn-eth-preview').addEventListener('click', () => previewWithdrawal($('#eth-withdraw-amount').dataset.max === 'true'));
    $('#btn-eth-confirm').addEventListener('click', confirm);
    $('#btn-sell-quote').addEventListener('click', quote);
    $('#sell-koin-amount').addEventListener('input', () => { quoteGeneration++; $('#sell-routes').innerHTML = ''; });
    $('#btn-sell-max').addEventListener('click', () => {
      const sats = ctx.koinBalance?.();
      if (!/^\d+$/.test(sats || '')) { message('Refresh your wallet balance first.'); return; }
      const capped = BigInt(sats) > 1000000000000n ? '1000000000000' : sats;
      $('#sell-koin-amount').value = Portfolio.fromSats(capped, 8);
      quote();
    });
    $('#sell-routes').addEventListener('click', async e => {
      const button = e.target.closest('[data-sell-quote]');
      if (!button || working) return;
      working = true; const gen = generation, credentialId = ctx.credentialId();
      try {
        const prepared = await ctx.api('/api/fund/trade/prepare', { credentialId, kind: 'sell', quoteId: button.dataset.sellQuote });
        if (gen !== generation) return;
        open('sell'); showReview(prepared);
      } catch (e) { if (gen === generation) message(e.message); }
      finally { working = false; }
    });
    $('#btn-trade-tap').addEventListener('click', tap);
    $('#btn-trade-retry').addEventListener('click', () => action('retry'));
    $('#btn-trade-cancel').addEventListener('click', () => action('cancel'));
  }
  async function previewWithdrawal(max) {
    if (working) return;
    working = true; resetReview(); modalMessage('Estimating network gas…');
    const gen = generation, to = $('#eth-withdraw-to').value.trim(), amount = $('#eth-withdraw-amount').value.trim();
    $('#eth-withdraw-amount').dataset.max = String(max);
    try {
      const prepared = await ctx.api('/api/fund/trade/prepare', { credentialId: ctx.credentialId(), kind: 'withdraw', to, amount, max });
      if (gen !== generation || to !== $('#eth-withdraw-to').value.trim() || amount !== $('#eth-withdraw-amount').value.trim()) return;
      showReview(prepared); modalMessage('Check the full receiving address before approving. Gas is paid from this Ethereum balance.');
    } catch (e) { if (gen === generation) modalMessage(e.message); }
    finally { working = false; }
  }
  async function confirm() {
    if (working || !review) return;
    const prepared = review, gen = generation, credentialId = ctx.credentialId();
    working = true; $('#btn-eth-confirm').disabled = true;
    document.querySelectorAll('#eth-withdraw-fields input, #eth-withdraw-fields button').forEach(n => { n.disabled = true; });
    try {
      if (prepared.expires <= Date.now()) throw new Error('This preview expired. Review the amount and gas again.');
      modalMessage('Confirm with your passkey…');
      const signature = await ctx.signPrepared({ id: prepared.challenge });
      if (gen !== generation) return;
      const result = await ctx.api('/api/fund/trade/submit', { credentialId, ref: prepared.ref, signature });
      if (gen !== generation) return;
      $('#eth-withdraw-dialog').close(); resetReview();
      message(result.trade.kind === 'withdraw' ? 'Withdrawal submitted. Confirmation appears below.' : 'Sale approved. Confirm the Koinos step below to continue.');
      await Fund.refresh();
    } catch (e) { if (gen === generation) modalMessage(e.name === 'NotAllowedError' ? 'Passkey prompt closed. Nothing new was approved.' : e.message); }
    finally { working = false; $('#btn-eth-confirm').disabled = false;
      document.querySelectorAll('#eth-withdraw-fields input, #eth-withdraw-fields button').forEach(n => { n.disabled = false; }); }
  }
  async function quote() {
    if (!state?.enabled || !state.balances || state.demo || state.tradingUnavailable || state.accountActive === false || state.tradeBlocked || (state.job && state.job.status !== 'done')) return;
    const gen = generation, qgen = ++quoteGeneration, amount = $('#sell-koin-amount').value.trim();
    $('#sell-routes').textContent = 'Pricing both routes…';
    try {
      const result = await ctx.api('/api/fund/sell/quote', { credentialId: ctx.credentialId(), amount });
      if (gen !== generation || qgen !== quoteGeneration) return;
      $('#sell-routes').innerHTML = result.quote.routes.map(r => r.error
        ? `<div class="fund-route">Route ${esc(r.route)}: ${esc(r.error)}</div>`
        : `<div class="fund-route${r.best ? ' is-best' : ''}"><strong>${esc(r.label)}</strong><p class="hint">${esc(r.via)}</p>`
          + `<p>≈ ${esc(r.expectedEth)} ETH${r.best ? ' · best after gas' : ''}</p><p class="hint">Minimum ${esc(r.minimumEth)} ETH, if completed.<br>Conversion fee ${esc(r.platformFeeEth)} ETH included.<br>Gas budget ${esc(r.gasBudgetEth)} ETH paid separately.</p>`
          + (!r.gasReady ? '<p class="hint">Add enough ETH to the address above for gas before selling.</p>' : '')
          + `<button class="${r.best ? 'cta' : 'ghost'} small" data-sell-quote="${esc(r.quoteId)}"${!r.gasReady ? ' disabled' : ''}>Review Route ${esc(r.route)}</button></div>`).join('');
    } catch (e) { if (gen === generation && qgen === quoteGeneration) $('#sell-routes').textContent = e.message; }
  }
  async function tap() {
    if (working) return;
    working = true; const gen = generation, credentialId = ctx.credentialId();
    try {
      message('Preparing your Koinos transaction…');
      const prepared = await ctx.api('/api/fund/prepare-step', { credentialId });
      if (gen !== generation) return;
      const signature = await ctx.signPrepared(prepared.tx);
      if (gen !== generation) return;
      message('Submitting your transaction…');
      await ctx.api('/api/submit', { ref: prepared.ref, transaction: { ...prepared.tx, signatures: [signature] } });
      if (gen !== generation) return;
      message('Waiting for chain confirmation. You can return later; progress is saved.');
      await Fund.refresh(); ctx.onKoinMoved?.();
    } catch (e) { if (gen === generation) { message(e.message); await Fund.refresh(); } }
    finally { working = false; }
  }
  async function action(kind) {
    if (working) return;
    working = true; const gen = generation, credentialId = ctx.credentialId();
    try {
      const prep = await ctx.api('/api/fund/trade/prepare', { credentialId, kind });
      if (gen !== generation) return;
      const signature = await ctx.signPrepared({ id: prep.challenge });
      if (gen !== generation) return;
      await ctx.api('/api/fund/trade/submit', { credentialId, ref: prep.ref, signature });
      if (gen === generation) { message(''); await Fund.refresh(); }
    } catch (e) { if (gen === generation) message(e.message); }
    finally { working = false; }
  }
  function render(st) {
    state = st;
    updateBalances(); updatePage();
    $('#trade-eth-balance').textContent = st.balances?.eth != null ? `${st.balances.eth} ETH` : 'ETH balance unavailable';
    const blocked = st.tradeBlocked || !!(st.job && st.job.status !== 'done');
    const disabled = !st.enabled || !st.balances || !!st.demo || blocked || st.accountActive === false || !!st.tradingUnavailable;
    $('#btn-eth-withdraw').disabled = disabled;
    $('#btn-sell-quote').disabled = disabled;
    $('#btn-sell-max').disabled = disabled;
    $('#sell-koin-amount').disabled = disabled;
    if (disabled) { quoteGeneration++; $('#sell-routes').innerHTML = ''; }
    const j = st.trade;
    $('#trade-progress').hidden = !j || isNoticeDismissed('trade', j);
    $('#btn-trade-dismiss').hidden = !noticeIdentity('trade', j);
    if (!j) return;
    $('#trade-progress-label').textContent = j.status === 'done'
      ? j.kind === 'withdraw' ? `Sent ${j.amountEth} ETH to ${j.to}` : `${j.receivedEth} ETH received at your Ethereum address`
      : j.status === 'cancelled' ? 'Sale cancelled before sending funds.'
      : j.status === 'error' || j.status === 'failed' ? j.error : labels[j.status] || j.status;
    $('#trade-progress-detail').textContent = j.lastError || (j.actualGasEth ? `Ethereum gas paid: ${j.actualGasEth} ETH` : 'Progress is saved if you close the wallet.');
    $('#btn-trade-tap').hidden = !j.needsTap; $('#btn-trade-tap').textContent = labels[j.status] || 'Confirm with passkey';
    $('#btn-trade-retry').hidden = j.status !== 'error';
    $('#btn-trade-cancel').hidden = !j.canCancel || ['cancelled', 'done'].includes(j.status);
    const hash = j.pendingTx || j.txHash;
    $('#trade-tx-link').hidden = !/^0x[0-9a-f]{64}$/i.test(hash || '');
    if (!$('#trade-tx-link').hidden) $('#trade-tx-link').href = 'https://etherscan.io/tx/' + hash;
  }
  function forget() {
    generation++; quoteGeneration++; state = null; review = null;
    mode = 'buy'; selected = null;
    $('#eth-withdraw-dialog').close(); resetReview();
    $('#eth-withdraw-to').value = ''; $('#eth-withdraw-amount').value = ''; $('#sell-koin-amount').value = '';
    $('#sell-routes').innerHTML = ''; $('#trade-progress').hidden = true; message('');
    updateBalances(); updatePage();
  }
  return { mount, render, forget, updateBalances, isNoticeDismissed, dismissNotice };
})();
