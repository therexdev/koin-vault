'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/js/app.js'), 'utf8');
const start = source.indexOf('  function paintDappRequest(');
const end = source.indexOf('  async function pollDapp(', start);
const elements = new Map();
let opened = 0, focused = 0;
const ctx = vm.createContext({
  DAPP_REQUEST: null, NET: 'mainnet',
  $: id => { if (!elements.has(id)) elements.set(id, { hidden: true, textContent: '', scrollIntoView() {}, focus() { focused++; } }); return elements.get(id); },
  UI: { showTab(id) { assert.equal(id, 'tab-security'); opened++; } }, dappSay() {},
});
vm.runInContext(source.slice(start, end), ctx);
ctx.app = { name: 'Trade Koinos', origin: 'https://app.tradekoinos.com' };
ctx.request = { id: 'first', summary: { title: 'Trade', network: 'mainnet' }, operations: [{ call_contract: { contract_id: 'example', entry_point: 123 } }] };
vm.runInContext('paintDappRequest(app, request)', ctx);
assert.equal(opened, 1); assert.equal(focused, 1);
assert.equal(elements.get('#dapp-request').hidden, false);
assert.equal(elements.get('#btn-dapp-approve').disabled, true, 'Legacy summary-only requests cannot be approved');
vm.runInContext('paintDappRequest(app, request)', ctx);
assert.equal(opened, 1, 'polling same request must not repeatedly steal focus');
ctx.request = {
  id: 'reviewed', summary: { title: 'FREE GIFT', detail: '<script>fake</script>' },
  operations: [{ call_contract: { contract_id: 'full-contract-address', entry_point: 123 } }],
  review: { version: 1, title: 'Allow spending of KOIN', network: 'mainnet', requiresAcknowledgement: true,
    actions: [{ title: 'Allowance', contract: 'full-contract-address', detail: 'Spender: full-spender-address\nSpending limit: 500 KOIN' }],
    warnings: ['Later spends may not need your fingerprint.'] },
  funding: { payer: 'wallet', address: 'full-wallet-address', maxMana: '20' },
};
vm.runInContext('paintDappRequest(app, request)', ctx);
assert.equal(elements.get('#dapp-title').textContent, 'Allow spending of KOIN');
assert.match(elements.get('#dapp-detail').textContent, /full-contract-address/);
assert.match(elements.get('#dapp-detail').textContent, /full-spender-address/);
assert.ok(!elements.get('#dapp-detail').textContent.includes('script'));
assert.match(elements.get('#dapp-payer').textContent, /Your wallet.*full-wallet-address/);
assert.match(elements.get('#dapp-mana').textContent, /20 mana/);
assert.equal(elements.get('#dapp-ack-row').hidden, false);
assert.equal(elements.get('#btn-dapp-approve').disabled, true);
elements.get('#dapp-ack').checked = true;
vm.runInContext('paintDappRequest(app, request)', ctx);
assert.equal(elements.get('#btn-dapp-approve').disabled, false, 'Acknowledgement survives polling the same request');
ctx.request = { ...ctx.request, id: 'another-request' };
vm.runInContext('paintDappRequest(app, request)', ctx);
assert.equal(elements.get('#dapp-ack').checked, false, 'A new request requires a new acknowledgement');
vm.runInContext('paintDappRequest(null, null)', ctx);
assert.equal(elements.get('#dapp-request').hidden, true);
console.log('✓ Incoming requests become visible once, retain focus during polling and clear after handling');
