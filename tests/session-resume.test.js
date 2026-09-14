'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const tick = () => new Promise(resolve => setImmediate(resolve));
const saved = () => new Map([['bw_smart_addr', 'wallet-a'], ['bw_smart_cred', 'passkey-a']]);
const account = (address = 'wallet-a', id = 'passkey-a', step = 'active') => ({
  address, step, credentials: [{ id, kind: 'passkey' }],
});

function open(storage = saved(), options = {}) {
  const nodes = new Map(), requests = [], views = [], timers = [], intervals = new Map(), signatures = [];
  const effects = { fund: 0, dapp: 0, intent: 0, connect: 0, paint: 0 };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, disabled: false, textContent: '', className: '',
      addEventListener(type, fn) { this[type] = fn; } });
    return nodes.get(id);
  };
  const context = vm.createContext({
    LS_ADDR: 'bw_smart_addr', ADDRESS: null, ACTIVE: false, RECOVERY: null, RESUMING: null,
    CREDENTIALS: [], PENDING_BACKUP: null, POLL: null, DAPP: null,
    PAINT_GEN: 0, PAINTING: false, PAINT_AGAIN: false, BALANCE_SATS: '', VHP_BALANCE_SATS: '', TOKEN_BALANCES: {},
    OPEN_RECOVERY: !!options.recover, PENDING_INTENT: options.intent || null, PENDING_CONNECT: options.connect || null,
    $: node, document: { addEventListener() {} }, confirm: () => true,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    Passkey: {
      storedId: () => storage.get('bw_smart_cred') || null,
      identify: () => { throw new Error('Reload must not open a passkey prompt'); },
      createCredential: () => { throw new Error('Reload must not create a wallet'); },
      assert: async (challenge, allow) => { signatures.push({ challenge, allow }); return { credentialId: allow[0] }; },
    },
    WebauthnWire: { challengeForTxId: id => 'challenge:' + id, packSignatureBlob: value => 'signed:' + value.credentialId },
    Recovery: { signTx: () => { throw new Error('Recovery secrets must not be restored from storage'); } },
    api: async (route, body) => {
      requests.push({ route, body });
      assert.equal(route, '/api/whoami', 'Restoration only looks up public account metadata');
      return options.respond ? options.respond() : account();
    },
    UI: { onView: view => views.push(view), applyIntent: () => effects.intent++, reset() {} },
    WalletClient: { canBuy: true }, Fund: { refresh: () => effects.fund++, stop() {}, forget() {} },
    paint: () => effects.paint++, renderCredentials() {}, refreshLandingSupport() {}, clearPendingKit() {},
    pollDapp() {}, stopDappPoll() {}, startDappPoll: () => effects.dapp++,
    connectDapp: async () => effects.connect++, dappSay() {}, paintDappRequest() {},
    loadDapp: () => options.dapp || null, saveDapp: value => { context.DAPP = value; },
    alertLine: message => { context.alert = message; },
    setTimeout: callback => { timers.push(callback); },
    setInterval: callback => { const id = Symbol(); intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id), encodeURIComponent,
  });
  vm.runInContext(part('  const storeAddr =', '  /* ---------------- api'), context);
  vm.runInContext(part('  const VIEWS =', '  /* ---------------- connected apps'), context);
  vm.runInContext(part("  $('#btn-signout').addEventListener", '  /* ---------------- fund card'), context);
  vm.runInContext(source.slice(source.indexOf('  /* ---------------- resume'), source.lastIndexOf('})();')), context);
  return { context, storage, requests, views, nodes, timers, intervals, signatures, effects, signout: () => node('#btn-signout').click() };
}

(async () => {
  const storage = saved();
  for (let reload = 0; reload < 3; reload++) {
    const page = open(storage); await tick();
    assert.equal(page.context.ADDRESS, 'wallet-a');
    assert.equal(page.context.ACTIVE, true);
    assert.ok(page.views.every(view => view === '#view-wallet'), 'Refresh never goes through sign-in');
    assert.equal(page.requests.length, 1);
    assert.equal(page.requests[0].body.credentialId, 'passkey-a');
    assert.equal(page.signatures.length, 0, 'Reopening never grants transaction approval');
    assert.equal(page.storage.size, 2, 'Only the existing public address and credential ID are persisted');
  }

  const signing = open(); await tick();
  await vm.runInContext("signPrepared({ id: 'tx-one' })", signing.context);
  await vm.runInContext("signPrepared({ id: 'tx-two' })", signing.context);
  assert.equal(signing.signatures.length, 2, 'Every transaction still requests its own assertion');
  assert.deepEqual(signing.signatures.map(s => s.challenge), ['challenge:tx-one', 'challenge:tx-two']);
  assert.equal(signing.signatures[0].allow[0], 'passkey-a');
  signing.signout();
  assert.equal(signing.storage.has('bw_smart_addr'), false);
  assert.equal(signing.storage.get('bw_smart_cred'), 'passkey-a', 'Signing out does not delete the passkey');
  const signedOutReload = open(signing.storage); await tick();
  assert.deepEqual(signedOutReload.views, ['#view-landing']); assert.equal(signedOutReload.requests.length, 0);

  for (const storage of [new Map(), new Map([['bw_smart_cred', 'passkey-a']]), new Map([['bw_smart_addr', 'wallet-a']])]) {
    const page = open(storage); await tick();
    assert.deepEqual(page.views, ['#view-landing']); assert.equal(page.requests.length, 0);
  }
  const switched = open(new Map([['bw_smart_addr', 'wallet-b'], ['bw_smart_cred', 'passkey-b']]), {
    respond: () => account('wallet-b', 'passkey-b'),
  }); await tick();
  assert.equal(switched.context.ADDRESS, 'wallet-b'); assert.equal(switched.context.CREDENTIALS[0].id, 'passkey-b');

  const recovering = open(saved(), { recover: true }); await tick();
  assert.deepEqual(recovering.views, ['#view-recover']); assert.equal(recovering.requests.length, 0);
  assert.equal(recovering.context.RECOVERY, null, 'Recovery private keys are never persisted');

  let unavailable = true;
  const outage = open(saved(), { respond: () => {
    if (unavailable) throw Object.assign(new Error('Temporary outage'), { status: 503 });
    return account();
  } }); await tick();
  assert.equal(outage.context.ADDRESS, 'wallet-a'); assert.equal(outage.context.ACTIVE, false);
  assert.equal(outage.storage.get('bw_smart_addr'), 'wallet-a'); assert.equal(outage.effects.fund, 0);
  await assert.rejects(vm.runInContext("signPrepared({ id: 'not-ready' })", outage.context), /reconnecting/);
  assert.match(outage.nodes.get('#activation').textContent, /Reconnecting/);
  unavailable = false; outage.timers.shift()(); await tick();
  assert.equal(outage.context.ACTIVE, true); assert.equal(outage.context.RESUMING, null);
  assert.ok(outage.views.every(view => view === '#view-wallet'));

  for (const respond of [() => ({}), () => { throw new TypeError('Network error'); }]) {
    const page = open(saved(), { respond }); await tick();
    assert.equal(page.storage.get('bw_smart_addr'), 'wallet-a'); assert.equal(page.timers.length, 1);
    page.signout(); page.timers.shift()(); await tick();
    assert.equal(page.requests.length, 1, 'A queued retry cannot run after sign-out');
  }
  for (const respond of [() => account('other-wallet', 'other-key'), () => { throw Object.assign(new Error('Missing'), { status: 404 }); }]) {
    const page = open(saved(), { respond }); await tick();
    assert.equal(page.context.ADDRESS, null); assert.equal(page.context.ACTIVE, false);
    assert.equal(page.context.CREDENTIALS.length, 0, 'Unmatched wallet metadata must not enter this session');
    assert.equal(page.views.at(-1), '#view-landing');
  }

  let finish;
  const waiting = open(saved(), { respond: () => new Promise(resolve => { finish = resolve; }) });
  waiting.signout(); finish(account()); await tick();
  assert.equal(waiting.context.ADDRESS, null); assert.equal(waiting.views.at(-1), '#view-landing');
  assert.equal(waiting.storage.has('bw_smart_addr'), false, 'A late response must not undo sign-out');

  const pending = open(saved(), { respond: () => account('wallet-a', 'passkey-a', 'pending') }); await tick();
  assert.equal(pending.context.ACTIVE, false); assert.equal(pending.intervals.size, 1, 'Unfinished wallet setup resumes polling');
  let finishPoll;
  pending.context.api = () => new Promise(resolve => { finishPoll = resolve; });
  const polling = [...pending.intervals.values()][0]();
  pending.signout(); finishPoll(account()); await polling;
  assert.equal(pending.context.ACTIVE, false, 'Late activation cannot undo sign-out');

  const linked = open(saved(), { intent: { open: 'send' }, connect: { sessionId: 'new' }, dapp: { address: 'wallet-a', sessionId: 'saved' } });
  assert.equal(linked.effects.intent, 0); assert.equal(linked.effects.connect, 0); assert.equal(linked.effects.dapp, 0);
  await tick();
  assert.equal(linked.effects.intent, 1); assert.equal(linked.effects.connect, 1); assert.equal(linked.effects.dapp, 1);
  console.log('✓ Repeated reloads retain the wallet; sign-out, account switching, recovery links, reconnects, late replies and per-transaction passkey approvals stay correct');
})().catch(error => { console.error(error); process.exitCode = 1; });
