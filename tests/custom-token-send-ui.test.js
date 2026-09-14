'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Signer } = require('koilib');
const TokenAmounts = require('../public/js/token-amounts');
const read = path => fs.readFileSync(require('node:path').join(__dirname, '..', path), 'utf8');
const app = read('public/js/app.js'), ui = read('public/js/ui.js');
const token = Signer.fromSeed('send-ui-token').getAddress(), other = Signer.fromSeed('send-ui-other-token').getAddress();
const nodes = new Map(), handlers = new Map();
function element(text = '') {
  return { value: '', hidden: false, disabled: false, textContent: text, innerHTML: '', dataset: {}, children: [],
    focus() {}, appendChild(child) { child.parent = this; this.children.push(child); return child; },
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
    querySelectorAll() { return this.children.filter(child => child.dataset.customToken); },
  };
}
function node(id) {
  if (!nodes.has(id)) {
    const el = element(); el.addEventListener = (event, fn) => handlers.set(id + ':' + event, fn); nodes.set(id, el);
  }
  return nodes.get(id);
}
const row = { id: token, address: token, symbol: 'KCT', decimals: 6, amountText: '9,007,199,254.740993', sats: '9007199254740993' };
const ctx = vm.createContext({
  cfg: { network: 'mainnet' },
  byId: node, $: selector => node(selector.slice(1)), el: (_tag, _class, text) => element(text),
  shortAddr: value => value.slice(0, 6) + '…' + value.slice(-4),
  TokenAmounts, TOKEN_BALANCES: { [token]: row.sats }, BALANCE_SATS: '999999999999999', VHP_BALANCE_SATS: '0',
  CTX: { cfg: { sendAssets: ['koin', 'vhp'] }, model: {
    koin: { sats: '999999999999999', amountText: '9,999,999.99999999' }, vhp: {},
    koinUsd: 100, vhpUsd: 50, others: [row, { ...row, id: other, address: other }],
  } },
  sym: () => 'KOIN', netLabel: () => 'Koinos', groups: value => value,
  QR: { looksLikeAddress: () => true }, Portfolio: { fmtUsd: value => '$' + value },
  sendAsset: 'koin', sendBusy: false, ADDRESS: 'wallet-owner', ACTIVE: true, RECOVERY: null, SENDING: false,
  openSheet: id => { ctx.opened = id; }, paint() {}, document: { createElement: () => element() },
});
vm.runInContext(ui.slice(ui.indexOf('  function sendRow('), ui.indexOf('  function paintOffline(')), ctx);
vm.runInContext('var UI = { sendAsset: () => sendAsset, sendSymbol, sendDecimals, canSendAsset, setSendBusy };', ctx);
vm.runInContext(app.slice(app.indexOf('  function sendAllBalance('), app.indexOf("  $('#btn-send-all')")), ctx);
vm.runInContext(app.slice(app.indexOf("  $('#btn-send').addEventListener"), app.indexOf('  /* ---------------- scan a QR code')), ctx);

(async () => {
  assert.equal(ctx.canSendAsset(token), false, 'An old backend must keep custom transfers disabled');
  ctx.CTX.cfg.sendCustomTokens = true; ctx.syncSendAssets();
  assert.equal(ctx.canSendAsset(token), true);
  const options = node('send-asset').children;
  assert.equal(options.length, 2); assert.notEqual(options[0].textContent, options[1].textContent, 'Contracts distinguish duplicate symbols');
  node('send-amount').value = '50'; ctx.openSend(token);
  assert.equal(ctx.opened, 'sheet-send'); assert.equal(node('send-amount').value, '');
  assert.equal(ctx.UI.sendAsset(), token); assert.equal(node('send-asset').value, token);
  assert.equal(ctx.UI.sendDecimals(), 6); assert.equal(ctx.UI.sendSymbol(), 'KCT');
  node('send-to').value = 'recipient'; node('send-amount').value = '1.234567'; ctx.renderSendSummary();
  assert.equal(node('ss-amount').textContent, '1.234567 KCT');
  assert.equal(node('send-usd').textContent, '', 'Unpriced tokens never inherit KOIN USD pricing');
  assert.equal(node('ss-contract').textContent, token); assert.equal(node('ss-contract-row').hidden, false);
  assert.equal(ctx.sendAllAmount(), '9007199254.740993');
  ctx.TOKEN_BALANCES = {}; assert.equal(ctx.sendAllAmount(), null, 'A failed token read never falls back to the KOIN balance');
  ctx.TOKEN_BALANCES[token] = '0'; assert.equal(ctx.sendAllAmount(), null);
  ctx.TOKEN_BALANCES[token] = row.sats;
  ctx.CTX.model.others = []; ctx.syncSendAssets();
  assert.equal(ctx.UI.sendAsset(), token); assert.equal(node('send-asset').value, token); assert.equal(ctx.canSendAsset(token), false);
  assert.equal(node('send-asset').children[0].disabled, true, 'Removal cannot silently select a different currency');
  ctx.CTX.model.others = [row]; ctx.syncSendAssets();
  row.unavailable = true; assert.equal(ctx.canSendAsset(token), false); delete row.unavailable;
  row.decimals = -1; assert.equal(ctx.canSendAsset(token), false); row.decimals = 6;
  ctx.CTX.cfg.demo = true; assert.equal(ctx.canSendAsset(token), false); ctx.CTX.cfg.demo = false;

  let prepareCount = 0, signed = 0, submitted = 0, change = value => value, signError, release;
  let liveConfig = { demo: false, sendCustomTokens: true, network: 'mainnet' };
  ctx.api = async (url, body) => {
    if (url === '/api/config') return liveConfig;
    if (url === '/api/token/prepare') {
      prepareCount++; assert.equal(body.asset, token);
      return change({ asset: token, ref: 'ref', transfer: { contract: token, symbol: row.symbol, decimals: 6, units: '1234567' },
        tx: { id: 'tx', header: { payee: ctx.ADDRESS }, operations: [{ call_contract: { contract_id: token, entry_point: 0x27f576ca, args: 'fixture' } }] } });
    }
    assert.equal(url, '/api/token/submit');
    submitted++; assert.equal(body.transaction.signatures[0], 'passkey-blob'); return { txid: 'tx' };
  };
  ctx.signPrepared = async () => { signed++; if (signError) throw signError; if (release) await release.promise; return 'passkey-blob'; };
  const click = handlers.get('btn-send:click');
  node('send-amount').value = '0.0000001'; await click();
  assert.equal(prepareCount, 0, 'Overprecision fails in the form before preparing a transaction');
  node('send-amount').value = '1.234567';
  for (const bad of [{ demo: true, sendCustomTokens: true, network: 'mainnet' }, { demo: false, sendCustomTokens: false, network: 'mainnet' }, { demo: false, sendCustomTokens: true, network: 'harbinger' }]) {
    const saved = liveConfig; liveConfig = bad; await click(); liveConfig = saved;
    assert.equal(prepareCount, 0, 'Refresh configuration before custom preparation; stale capability or network changes must stop it');
  }
  for (const mutate of [
    prep => ({ ...prep, asset: 'koin' }),
    prep => ({ ...prep, transfer: { ...prep.transfer, decimals: 8 } }),
    prep => ({ ...prep, transfer: { ...prep.transfer, units: '1234568' } }),
    prep => ({ ...prep, transfer: { ...prep.transfer, contract: other } }),
    prep => ({ ...prep, transfer: { ...prep.transfer, symbol: 'OTHER' } }),
    prep => { prep.tx.operations[0].call_contract.contract_id = other; return prep; },
    prep => { prep.tx.operations[0].call_contract.entry_point = 1; return prep; },
    prep => { prep.tx.operations.push(prep.tx.operations[0]); return prep; },
    prep => { prep.tx.header.payee = 'other-owner'; return prep; },
  ]) {
    change = mutate; await click();
    assert.equal(signed, 0, 'Mismatched prepared transfers must not open the passkey prompt');
    assert.equal(submitted, 0); assert.equal(ctx.sendBusy, false);
  }
  change = value => value;
  let resolve; release = { promise: new Promise(r => { resolve = r; }) };
  const pending = click(); await new Promise(r => setImmediate(r));
  const before = prepareCount; await click(); assert.equal(prepareCount, before, 'Repeated click cannot prepare another transfer');
  ctx.setSendAsset('koin'); assert.equal(ctx.UI.sendAsset(), token, 'Currency is locked while signing');
  resolve(); await pending; release = null;
  assert.equal(signed, 1); assert.equal(submitted, 1); assert.equal(node('send-amount').value, '');
  assert.equal(node('send-status').textContent, 'Sent KCT ✓'); assert.equal(ctx.sendBusy, false);
  node('send-to').value = 'recipient'; node('send-amount').value = '1.234567';
  signError = Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }); await click();
  assert.equal(submitted, 1); assert.match(node('send-status').textContent, /nothing was sent/); signError = null;
  row.symbol = '<img src=x onerror=alert(1)>'; await click();
  assert.equal(node('send-status').textContent, 'Sent ' + row.symbol + ' ✓');
  assert.equal(node('send-status').innerHTML, '', 'Contract-controlled symbols never enter innerHTML');
  console.log('✓ Custom token selection, duplicate symbols, contract display, exact Send all and honest unpriced amounts');
  console.log('✓ Precision checks, prepared-token mismatch rejection, passkey submission, cancellation and safe status text');
})().catch(e => { console.error(e); process.exitCode = 1; });
