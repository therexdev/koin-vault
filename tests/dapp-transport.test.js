'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/js/app'), 'utf8');
const parseSource = source.slice(source.indexOf('  function parseConnect('), source.indexOf('  async function connectDapp('));
const bootstrap = source.slice(source.indexOf('  let PENDING_INTENT = null;'), source.indexOf('  const VIEWS ='));
const origin = 'https://koinvault.app';
for (const separator of ['?', '#']) {
  const location = new URL(origin + '/' + separator + 'connect=session&secret=fixture');
  const scrubbed = [];
  const context = vm.createContext({ location, URL, URLSearchParams, history: { replaceState: (...args) => scrubbed.push(args[2]) } });
  vm.runInContext(parseSource + bootstrap, context);
  const pair = vm.runInContext('PENDING_CONNECT', context);
  assert.equal(pair.sessionId, 'session'); assert.equal(pair.secret, 'fixture');
  assert.deepEqual(scrubbed, ['/']);
  assert.equal(context.parseConnect(location.href).secret, 'fixture');
  for (const invalid of [origin + '/?connect=x&secret=y#connect=session&secret=fixture',
    origin + '/#connect=session', 'https://evil.example/#connect=session&secret=fixture',
    'https://user@koinvault.app/#connect=session&secret=fixture']) {
    assert.throws(() => context.parseConnect(invalid));
  }
  const calls = [];
  Object.assign(context, { UI: { showTab() {} }, ADDRESS: 'account', ACTIVE: true, RECOVERY: false,
    api: async (path, body) => { calls.push({ path, body }); return { origin: 'https://app.example', name: 'App' }; },
    isDappBlocked: () => false, confirm: () => false });
  vm.runInContext(source.slice(source.indexOf('  async function connectDapp('), source.indexOf('  async function scanDapp(')), context);
  // Stop before approval; observe the real client status request.
  context.connectDapp(pair).then(() => {
    assert.equal(calls[0].path, '/api/dapp/status');
    assert.equal(calls[0].body.secret, 'fixture');
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
console.log('✓ Fragment and legacy pairing links parse and scrub; ambiguous and foreign links fail; status credentials use request bodies');
