'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = p => fs.readFileSync(require('node:path').join(__dirname, '..', p), 'utf8');
const app = read('public/js/app.js'), ui = read('public/js/ui.js');
const nodes = new Map(), handlers = new Map();
function node(id) {
  if (!nodes.has(id)) nodes.set(id, {
    value: '', hidden: false, textContent: '', className: '', innerHTML: '', disabled: false,
    focus() {}, addEventListener: (event, fn) => handlers.set(id + ':' + event, fn),
  });
  return nodes.get(id);
}
const context = vm.createContext({
  byId: node, $: selector => node(selector.slice(1)),
  CTX: { cfg: { sendAssets: ['koin', 'vhp'] }, model: {
    koin: { amountText: '12', sats: '1200000000' }, vhp: { amountText: '40', sats: '4000000000' }, koinUsd: 2, vhpUsd: 0.5,
  } }, sendAsset: 'koin', sendBusy: false, sym: () => 'KOIN', netLabel: () => 'Koinos', groups: s => s,
  QR: { looksLikeAddress: () => true }, Portfolio: { fmtUsd: n => '$' + n.toFixed(2) },
  openSheet: id => { context.opened = id; },
  ADDRESS: 'fixture-account', ACTIVE: true, RECOVERY: null, SENDING: false,
  BALANCE_SATS: '1200000000', VHP_BALANCE_SATS: '9007199254740993', paint() {},
});
vm.runInContext(ui.slice(ui.indexOf('  function canSendAsset('), ui.indexOf('  function paintOffline(')), context);
vm.runInContext('var UI = { sendAsset: () => sendAsset, sendSymbol, canSendAsset, setSendBusy };', context);
vm.runInContext(app.slice(app.indexOf('  function sendAllAmount('), app.indexOf("  $('#btn-send-all')")), context);
vm.runInContext(app.slice(app.indexOf("  $('#btn-send').addEventListener"), app.indexOf('  /* ---------------- scan a QR code')), context);

(async () => {
  node('send-to').value = 'recipient'; node('send-amount').value = '10';
  context.setSendAsset('vhp');
  assert.equal(node('send-amount').value, '', 'Switching assets clears the previous amount');
  node('send-amount').value = '10'; context.renderSendSummary();
  assert.equal(node('sym2').textContent, 'VHP');
  assert.equal(node('send-suffix').textContent, 'VHP');
  assert.equal(node('send-avail').textContent, 'Available 40 VHP');
  assert.match(node('ss-amount').textContent, /^10 VHP ≈ \$5.00$/);
  assert.equal(context.sendAllAmount(), '90071992.54740993');
  context.VHP_BALANCE_SATS = '';
  assert.equal(context.sendAllAmount(), null, 'Unknown VHP cannot use the KOIN balance');
  context.VHP_BALANCE_SATS = '0';
  assert.equal(context.sendAllAmount(), null);
  context.CTX.model.vhpUsd = null; context.renderSendSummary();
  assert.equal(node('send-usd').textContent, '', 'Unknown VHP price cannot use the KOIN price');
  context.setSendBusy(true); context.setSendAsset('koin');
  assert.equal(context.sendAsset, 'vhp');
  for (const id of ['send-asset', 'send-to', 'send-amount', 'btn-send-all', 'btn-scan', 'btn-paste']) assert.equal(node(id).disabled, true);
  context.setSendBusy(false); context.setSendAsset('koin');
  assert.equal(context.sendAllAmount(), '12');
  context.CTX.cfg = {}; context.setSendAsset('vhp');
  assert.equal(context.sendAsset, 'koin', 'Old backend configuration keeps VHP disabled');
  context.CTX.cfg = { sendAssets: ['koin', 'vhp'] };
  context.openSend('vhp');
  assert.equal(context.opened, 'sheet-send');
  assert.equal(context.sendAsset, 'vhp', 'Token detail entry preserves the selected asset');
  console.log('✓ VHP labels, availability, price, exact Send all, asset switching and old-backend gating');

  const calls = []; let signed = 0, submitted = 0, prepAsset = 'vhp', signError = null, finishSign;
  context.api = async (url, body) => {
    calls.push({ url, body });
    if (url === '/api/prepare') return { asset: prepAsset, ref: 'ref', tx: { id: 'tx-id' } };
    submitted++; assert.equal(body.transaction.signatures[0], 'passkey-blob'); return { txid: 'tx-id' };
  };
  context.signPrepared = async tx => {
    signed++; assert.equal(tx.id, 'tx-id');
    if (signError) throw signError;
    if (finishSign) await finishSign.promise;
    return 'passkey-blob';
  };
  const click = handlers.get('btn-send:click');
  node('send-amount').value = '1.00000001';
  let resolve; finishSign = { promise: new Promise(r => { resolve = r; }) };
  const pending = click(); await new Promise(r => setImmediate(r));
  assert.equal(context.sendBusy, true);
  await click();
  assert.equal(calls.length, 1, 'Double clicks cannot prepare a second transfer');
  resolve(); await pending; finishSign = null;
  assert.equal(calls[0].body.asset, 'vhp'); assert.equal(calls[0].body.amount, '1.00000001');
  assert.equal(submitted, 1); assert.equal(context.sendBusy, false); assert.equal(node('send-asset').disabled, false);
  assert.match(node('send-status').innerHTML, /Sent VHP/);
  assert.equal(node('send-amount').value, '');
  node('send-amount').value = '1'; node('send-to').value = 'recipient';
  prepAsset = undefined;
  await click();
  assert.equal(signed, 1, 'An older backend returning KOIN must never reach the passkey prompt');
  assert.equal(submitted, 1);
  prepAsset = 'vhp'; signError = Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
  await click();
  assert.equal(submitted, 1); assert.equal(context.sendBusy, false);
  assert.match(node('send-status').innerHTML, /nothing was sent/);
  context.setSendAsset('koin'); node('send-amount').value = '2'; prepAsset = undefined; signError = null;
  await click(); assert.equal(submitted, 2, 'Legacy KOIN responses still sign and submit');
  console.log('✓ VHP prepare/sign/submit, duplicate prevention, cancellation, and rejection of an accidental KOIN preparation');
})().catch(e => { console.error(e); process.exitCode = 1; });
