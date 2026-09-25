'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { NETWORKS } = require('../tools/rpc');
const ui = fs.readFileSync(path.join(__dirname, '../public/js/ui.js'), 'utf8');
const nodes = new Map();
const node = id => {
  if (!nodes.has(id)) nodes.set(id, {
    dataset: {}, hidden: false, textContent: '',
    removeAttribute(name) { delete this[name]; },
  });
  return nodes.get(id);
};
const owner = '1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW';
const otherOwner = '14f34kUNZugf2DK4hPJGy4AkmBM7Y4pvVu';
const context = vm.createContext({
  CTX: { address: owner, cfg: { explorer: NETWORKS.mainnet.explorer } },
  byId: node, canSendAsset: () => true, shortAddr: value => value,
  iconFor: row => ({ className: 'icon ' + row.id, textContent: row.symbol }),
  tokenOpen: null,
});
const explorerHelper = ui.split('\n').find(line => line.includes('const explorerAddr ='));
vm.runInContext(explorerHelper + '\n' + ui.slice(ui.indexOf('  function fillToken('),
  ui.indexOf('  /* ---------------- protection')), context);

for (const network of ['mainnet', 'harbinger']) {
  const net = NETWORKS[network];
  context.CTX.cfg.explorer = net.explorer;
  for (const token of [
    { id: 'koin', symbol: net.nativeSymbol, address: net.koinContract },
    { id: 'vhp', symbol: 'VHP', address: net.vhpContract },
    { id: 'custom', symbol: 'CUSTOM', address: NETWORKS.harbinger.koinContract },
  ]) {
    for (const account of [owner, otherOwner]) {
      context.CTX.address = account;
      context.fillToken(token);
      assert.equal(node('tok-explorer').href, `${net.explorer}/address/${account}`);
      assert.equal(node('tok-explorer').hidden, false);
      assert.equal(node('tok-contract').dataset.full, token.address, 'Copy retains the token contract');
    }
    context.CTX.address = null;
    context.fillToken(token);
    assert.equal(node('tok-explorer').hidden, true);
    assert.equal(node('tok-explorer').href, undefined, 'No stale account or contract link without a wallet');
  }
}
console.log('✓ KOIN, VHP and added-token explorer links follow the wallet account on each network');
