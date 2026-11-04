'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'public/js/fund.js'), 'utf8');

function ui() {
  function element() {
    return { hidden: false, disabled: false, open: false, textContent: '', innerHTML: '', handlers: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      showModal() { this.open = true; }, close() { this.open = false; this.handlers.close?.(); },
    };
  }
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], element()]));
  const row = element();
  const node = selector => selector === '#fund-job .btn-row' ? row : nodes.get(selector.slice(1)) || null;
  const requests = [], options = { credential: 'fixture-account', now: 1000 };
  const state = { enabled: true, accountActive: true, ethAddress: '0x-fixture-deposit', balances: { eth: '0.01' },
    job: { id: 'fixture-job', asset: 'eth', route: 'C', status: 'error', failedAt: 'bridge_token', canRequote: true, error: 'Gas rose above your approved maximum' } };
  const quote = { quoteId: 'fixture-quote', vortexRecovery: true, expiresAt: 61000,
    koinOut: '123456789', koinOutMin: '123456789', estimatedRemainingGasEth: '0.0001',
    remainingGasMaxEth: '0.0002', additionalEthNeeded: '0', totalMaxFeeEth: '0.0008', previousMaxFeeEth: '0.0006' };
  const context = vm.createContext({ document: { querySelector: node }, setTimeout: () => 1, clearTimeout() {},
    Date: { now: () => options.now }, console });
  vm.runInContext(source + '\nthis.fund = Fund;', context);
  const fund = context.fund;
  fund.mount({ credentialId: () => options.credential, api: async (url, data) => {
    if (url.startsWith('/api/fund/status')) return structuredClone(state);
    assert.equal(url, '/api/fund/requote');
    requests.push({ ...data });
    if (data.quoteId) {
      if (options.approvalWait) await options.approvalWait;
      if (options.reject) throw new Error(options.reject);
      return { ok: true };
    }
    if (options.previewWait) await options.previewWait;
    return { quote: { ...quote } };
  } });
  return { fund, node, requests, options, quote, state, click: id => node('#' + id).handlers.click() };
}

(async () => {
  const h = ui(); await h.fund.refresh();
  assert.equal(h.node('#btn-fund-requote').hidden, false);
  assert.equal(h.node('#btn-fund-reset').hidden, true, 'recovery replaces a blocked New swap action');
  await h.click('btn-fund-requote');
  assert.equal(h.node('#fund-fee-dialog').open, true);
  assert.match(h.node('#fund-fee-details').textContent, /1.23456789 vKOIN/);
  assert.match(h.node('#fund-fee-details').textContent, /Estimated remaining gas fee: 0.0001 ETH/);
  assert.match(h.node('#fund-fee-details').textContent, /Maximum remaining gas fee: 0.0002 ETH/);
  assert.match(h.node('#fund-fee-note').textContent, /No new platform fee/);
  assert.equal(h.requests.filter(r => r.quoteId).length, 0, 'review alone cannot approve');
  h.click('btn-fund-fee-cancel');
  await h.click('btn-fund-fee-approve');
  assert.equal(h.requests.filter(r => r.quoteId).length, 0, 'cancel discards approval');
  await h.click('btn-fund-requote');
  let finish;
  h.options.approvalWait = new Promise(resolve => { finish = resolve; });
  const approval = h.click('btn-fund-fee-approve');
  await h.click('btn-fund-fee-approve');
  assert.equal(h.requests.filter(r => r.quoteId).length, 1, 'double click submits once');
  finish(); await approval;
  assert.equal(h.node('#fund-fee-dialog').open, false);
  assert.match(h.node('#fund-status').textContent, /Continuing your conversion/);

  for (const reason of ['shortfall', 'expired', 'changed', 'account']) {
    const t = ui(); await t.fund.refresh();
    if (reason === 'shortfall') t.quote.additionalEthNeeded = '0.00005';
    await t.click('btn-fund-requote');
    if (reason === 'expired') t.options.now = 62000;
    if (reason === 'account') t.options.credential = 'other-account';
    if (reason === 'changed') t.options.reject = 'The conversion changed. Review a fresh quote.';
    await t.click('btn-fund-fee-approve');
    assert.equal(t.requests.filter(r => r.quoteId).length, reason === 'changed' ? 1 : 0);
    if (reason !== 'account') {
      assert.equal(t.node('#btn-fund-fee-approve').disabled, true);
      assert.match(t.node('#fund-fee-message').textContent, /ETH|expired|changed/);
      t.quote.additionalEthNeeded = '0'; t.quote.expiresAt = 200000; t.options.reject = null;
      await t.click('btn-fund-fee-refresh');
      assert.equal(t.node('#btn-fund-fee-approve').disabled, false);
    }
  }
  {
    const t = ui(); await t.fund.refresh();
    let finish;
    t.options.previewWait = new Promise(resolve => { finish = resolve; });
    const preview = t.click('btn-fund-requote');
    t.fund.forget(); t.options.credential = 'other-account';
    finish(); await preview;
    assert.equal(t.node('#fund-fee-dialog').open, false, 'late response cannot reopen a signed-out account');
    await t.click('btn-fund-fee-approve');
    assert.equal(t.requests.filter(r => r.quoteId).length, 0);
  }
  console.log('✓ fee dialog shows estimate/maximum, requires explicit approval and guards cancel, shortfall, expiry, account changes and double clicks');
})().catch(e => { console.error(e); process.exit(1); });
