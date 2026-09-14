'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/js/app.js'), 'utf8');
const start = source.indexOf("  $('#btn-dapp-disconnect').addEventListener");
const end = source.indexOf('  /* ---------------- landing', start);
function setup() {
  const button = { disabled: false, hidden: false, addEventListener(_type, fn) { this.click = fn; } };
  const calls = [], messages = [];
  let stopped = 0;
  const context = vm.createContext({
    DAPP: { sessionId: 'old', secret: 'fixture', address: 'account' },
    $: () => button, confirm: () => true,
    api: async (route, pair) => { calls.push({ route, pair }); },
    saveDapp: value => { context.DAPP = value; },
    stopDappPoll: () => { stopped++; }, paintDappRequest() {},
    dappSay: (message, kind) => messages.push({ message, kind }),
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, button, calls, messages, stopped: () => stopped };
}
(async () => {
  const c = setup(); await c.button.click();
  assert.equal(c.calls[0].route, '/api/dapp/disconnect');
  assert.equal(c.context.DAPP, null); assert.equal(c.button.hidden, true); assert.equal(c.stopped(), 1);
  const failed = setup(); failed.context.api = async () => { throw Object.assign(new Error('Unavailable'), { status: 503 }); };
  await failed.button.click();
  assert.ok(failed.context.DAPP, 'A failed revocation must retain the session for retry');
  assert.equal(failed.button.disabled, false); assert.equal(failed.button.hidden, false);
  assert.equal(failed.messages.at(-1).kind, 'err');
  failed.context.api = async () => {}; await failed.button.click(); assert.equal(failed.context.DAPP, null);
  for (const status of [404, 410]) {
    const gone = setup(); gone.context.api = async () => { throw Object.assign(new Error('Gone'), { status }); };
    await gone.button.click(); assert.equal(gone.context.DAPP, null, 'An already-revoked session can be cleared');
  }
  const stale = setup(); let finish;
  stale.context.api = () => new Promise(resolve => { finish = resolve; });
  const pending = stale.button.click();
  stale.context.DAPP = { sessionId: 'new', secret: 'new-fixture', address: 'account' };
  finish(); await pending;
  assert.equal(stale.context.DAPP.sessionId, 'new', 'A late disconnect response cannot remove a new pairing');
  assert.equal(stale.stopped(), 0);
  // The same stale-session guard must apply to background poll failures.
  const pollContext = vm.createContext({
    DAPP: { sessionId: 'old', secret: 'fixture', address: 'account' }, ADDRESS: 'account',
    RESUMING: null, DAPP_BUSY: false, DAPP_POLLING: false, document: { hidden: false }, URLSearchParams,
    api: () => new Promise((_resolve, reject) => { finish = reject; }),
    saveDapp() { throw new Error('Stale poll cleared a new session'); },
    stopDappPoll() { throw new Error('Stale poll stopped a new session'); }, dappSay() {},
  });
  vm.runInContext(source.slice(source.indexOf('  async function pollDapp()'), source.indexOf('  function startDappPoll()')), pollContext);
  const polling = vm.runInContext('pollDapp()', pollContext);
  pollContext.DAPP = { sessionId: 'new', secret: 'new-fixture', address: 'account' };
  finish(Object.assign(new Error('gone'), { status: 404 })); await polling;
  assert.equal(pollContext.DAPP.sessionId, 'new');
  // Real block handlers persist per wallet/device before attempting revocation.
  const storage = new Map(), nodes = new Map(), notices = [];
  const node = () => ({ children: [], disabled: false,
    addEventListener(type, fn) { this[type] = fn; }, append(...items) { this.children.push(...items); },
    replaceChildren() { this.children = []; } });
  const blocked = vm.createContext({
    ADDRESS: 'wallet-a', ACTIVE: true, RECOVERY: false,
    DAPP: { sessionId: 'blocked', secret: 'fixture', address: 'wallet-a', origin: 'https://unfamiliar.example' },
    $: id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    document: { createElement: node }, window: { addEventListener() {} },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    confirm: () => true, UI: { showTab() {} }, URLSearchParams,
    api: async () => { throw new Error('Offline'); },
    dappSay: message => notices.push(message), stopDappPoll() {}, paintDappRequest() {},
    saveDapp: value => { blocked.DAPP = value; },
  });
  vm.runInContext(source.slice(source.indexOf('  function blockedDapps()'), source.indexOf('  function parseConnect(')), blocked);
  vm.runInContext(source.slice(source.indexOf("  $('#btn-dapp-block').addEventListener"), start), blocked);
  await nodes.get('#btn-dapp-block').click();
  assert.ok(blocked.DAPP, 'Offline block retains the session for server revocation retry');
  assert.equal(vm.runInContext("isDappBlocked('https://unfamiliar.example')", blocked), true);
  blocked.ADDRESS = 'wallet-b';
  assert.equal(vm.runInContext("isDappBlocked('https://unfamiliar.example')", blocked), false);
  blocked.ADDRESS = 'wallet-a';
  assert.equal(vm.runInContext("isDappBlocked('https://unfamiliar.example')", blocked), true, 'Block survives restoring this wallet');
  blocked.api = async () => ({ origin: 'https://unfamiliar.example' });
  vm.runInContext(source.slice(source.indexOf('  async function connectDapp('), source.indexOf('  async function scanDapp(')), blocked);
  await assert.rejects(vm.runInContext('connectDapp(DAPP)', blocked), /blocked this site/);
  await nodes.get('#btn-dapp-block').click();
  assert.equal(blocked.DAPP, null, 'Online retry revokes and clears the session');
  const unblock = nodes.get('#dapp-blocked-list').children[0].children[1];
  unblock.click();
  assert.equal(vm.runInContext("isDappBlocked('https://unfamiliar.example')", blocked), false);
  console.log('✓ Wallet disconnect confirms revocation, permits retry on outages, and ignores stale disconnect/poll replies');
})().catch(error => { console.error(error); process.exitCode = 1; });
