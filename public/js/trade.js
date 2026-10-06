'use strict';
const Trade = (() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let ctx, state, review, working = false, generation = 0, quoteGeneration = 0;
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
    $('#trade-eth-balance').textContent = st.balances ? `${st.balances.eth} ETH` : 'Balance unavailable';
    const blocked = st.tradeBlocked || !!(st.job && st.job.status !== 'done');
    $('#btn-eth-withdraw').disabled = !!st.demo || blocked || st.accountActive === false;
    $('#btn-sell-quote').disabled = !!st.demo || blocked || st.accountActive === false;
    $('#sell-koin-card').hidden = !!st.demo;
    if (blocked) $('#sell-routes').innerHTML = '';
    const j = st.trade;
    $('#trade-progress').hidden = !j;
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
    $('#eth-withdraw-dialog').close(); resetReview();
    $('#eth-withdraw-to').value = ''; $('#eth-withdraw-amount').value = ''; $('#sell-koin-amount').value = '';
    $('#sell-routes').innerHTML = ''; $('#trade-progress').hidden = true; message('');
  }
  return { mount, render, forget };
})();
