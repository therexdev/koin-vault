'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const Portfolio = vm.runInNewContext(read('public/js/portfolio.js') + '\nPortfolio;');

// Real entry points with a small DOM: no live account, RPC, or transaction.
function element(dataset = {}) {
  return { dataset, hidden: false, disabled: false, value: '', textContent: '', innerHTML: '', attributes: {}, handlers: {},
    classList: { toggle() {} }, setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener(k, fn) { this.handlers[k] = fn; }, focus() {}, scrollIntoView() {}, close() {}, showModal() {},
  };
}
const ids = new Map([...read('public/index.html').matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], element()]));
const tokens = ['koin', 'vkoin', 'usdt', 'eth', 'sol', 'usdc'];
const balances = Object.fromEntries(tokens.map(asset => [asset, element()]));
const buttons = Object.fromEntries(tokens.slice(1).map(asset => [asset, element({ tradeAsset: asset })]));
function node(selector) {
  if (selector.startsWith('#')) { assert.ok(ids.has(selector.slice(1)), selector); return ids.get(selector.slice(1)); }
  const match = selector.match(/^\[data-trade-(balance|asset)="([^"\]]+)"\]$/);
  assert.ok(match, selector);
  return (match[1] === 'balance' ? balances : buttons)[match[2]];
}
const click = (id, target) => node('#' + id).handlers.click({ target: { closest: () => target } });
let selected, koinSats = '9007199254740993', requests = [];
const context = vm.createContext({ document: { querySelector: node, querySelectorAll: s => s === '[data-trade-asset]' ? Object.values(buttons) : [] }, Portfolio,
  Fund: { selectAsset: a => { selected = a; }, refresh: async () => {} },
});
vm.runInContext(read('public/js/trade.js') + '\nthis.trade = Trade;', context);
const trade = context.trade;
trade.mount({ credentialId: () => 'account', koinBalance: () => koinSats, refreshKoin: async () => { koinSats = '12500000000'; },
  api: async (url, data) => { requests.push({ url, data }); return { quote: { routes: [] } }; },
});
const status = { enabled: true, accountActive: true, ethAddress: '0x' + '1'.repeat(40), solAddress: 'sol-fixture',
  balances: { vkoin: '23.00000001', usdt: '100.000001', eth: '0.0123456789', sol: '1.000000009', usdc: '0' } };
trade.render(status);
assert.equal(balances.koin.textContent, '90,071,992.54740993', 'KOIN uses exact integer units');
assert.equal(balances.usdt.textContent, '100.000001');
assert.equal(balances.sol.textContent, '1.000000009');
assert.equal(balances.usdc.textContent, '0', 'zero balances remain visible');
assert.equal(node('#trade-flow').hidden, true);
for (const asset of ['usdt', 'eth', 'sol', 'usdc']) {
  click('trade-current-balances', buttons[asset]);
  assert.equal(selected, asset);
  assert.equal(node('#trade-buy-card').hidden, false);
  assert.equal(node('#sell-koin-card').hidden, true);
  assert.equal(node('#fund-sol-block').hidden, asset !== 'sol');
  assert.equal(node('#trade-eth-actions').hidden, asset !== 'eth');
}
assert.equal(node('#fund-eth-block').open, true, 'a zero balance opens its deposit QR');
click('trade-current-balances', buttons.vkoin);
assert.equal(selected, null, 'vKOIN is never passed to an unsupported buy endpoint');
assert.equal(node('#trade-deposit-card').hidden, true);
click('btn-trade-sell');
assert.equal(node('#trade-flow').hidden, true);
assert.equal(buttons.usdt.hidden, true, 'no unsupported sell button');
click('trade-current-balances', buttons.eth);
assert.equal(node('#sell-koin-card').hidden, false);
assert.equal(node('#trade-buy-card').hidden, true);

(async () => {
  await click('btn-sell-max');
  assert.equal(node('#sell-koin-amount').value, '10000');
  assert.equal(requests.at(-1).data.amount, '10000', 'Max retains the live cap');
  trade.render({ ...status, job: { status: 'error' } });
  assert.equal(node('#btn-sell-max').disabled, true);
  assert.equal(node('#btn-eth-withdraw').disabled, true, 'an unresolved buy reserves the funds');
  trade.render({ ...status, tradeBlocked: true, trade: { kind: 'sell', status: 'sell_bridge', needsTap: true } });
  click('btn-trade-buy');
  assert.equal(node('#trade-progress').hidden, false, 'navigation never hides a pending approval');
  trade.render({ ...status, balances: { ...status.balances, sol: null, solError: 'unavailable' } });
  assert.equal(balances.sol.textContent, 'Unavailable');
  trade.render({ ...status, balances: null, balancesError: 'offline', tradingUnavailable: true });
  assert.equal(balances.eth.textContent, 'Unavailable');
  assert.equal(node('#btn-sell-quote').disabled, true);
  await click('btn-trade-refresh');
  assert.equal(balances.koin.textContent, '125');
  koinSats = ''; trade.forget();
  assert.equal(node('#trade-flow').hidden, true);
  assert.equal(balances.eth.textContent, 'Loading…');
  assert.equal(node('#sell-koin-amount').value, '');

  // Late buy quotes must not revive a route for the old amount or account.
  const timers = new Map(), pending = [];
  let timer = 0;
  const amount = { value: '10' }, routes = { innerHTML: 'old quote' };
  const panel = { isConnected: true, querySelector: s => s === 'input[data-amt]' ? amount : routes };
  const qctx = vm.createContext({ SELECTED: 'usdt', SESSION: 0, DEBOUNCE: {}, DRAFTS: {}, QUOTE_REQUEST: {},
    document: { querySelector: () => panel },
    CTX: { credentialId: () => 'account', api: (_url, data) => new Promise(resolve => pending.push({ data, resolve })) },
    setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: id => timers.delete(id),
    routesHtml: (_asset, q) => q.id, esc: x => x,
  });
  const source = read('public/js/fund.js');
  vm.runInContext(source.slice(source.indexOf('  function requote('), source.indexOf('  function selectAsset(')), qctx);
  qctx.requote('usdt');
  assert.match(routes.innerHTML, /Pricing/, 'the previous route is removed before the debounce');
  const first = timers.get(timer)();
  amount.value = '20'; qctx.requote('usdt');
  const second = timers.get(timer)();
  pending[1].resolve({ quote: { id: 'new quote' } }); await second;
  pending[0].resolve({ quote: { id: 'stale quote' } }); await first;
  assert.equal(routes.innerHTML, 'new quote');
  qctx.requote('usdt'); const oldSession = timers.get(timer)();
  qctx.SESSION++; routes.innerHTML = 'signed out';
  pending[2].resolve({ quote: { id: 'old account quote' } }); await oldSession;
  assert.equal(routes.innerHTML, 'signed out');
  console.log('Trade UI: exact balances, Buy/Sell navigation, supported actions, deposit visibility, pending jobs, cap, refresh, sign-out and stale quote isolation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
