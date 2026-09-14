'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const status = { hidden: false, textContent: '' }, delays = [];
  let attempts = 0, resolved = false;
  const configContext = vm.createContext({
    $: () => status,
    api: async () => { attempts++; if (attempts === 1) throw new Error('HTTP 503'); if (attempts === 2) return {}; return { ok: true, demo: false, rpId: 'wallet.usekoinos.com' }; },
    setTimeout: callback => delays.push(callback),
  });
  vm.runInContext(source.slice(source.indexOf('  async function waitForConfig()'), source.indexOf('  // A failed request')), configContext);
  const ready = vm.runInContext('waitForConfig()', configContext).then(value => { resolved = true; return value; });
  await tick(); assert.equal(resolved, false); assert.match(status.textContent, /unavailable/);
  delays.shift()(); await tick(); assert.equal(resolved, false, 'Malformed configuration must not become demo mode');
  delays.shift()(); const config = await ready;
  assert.equal(config.demo, false); assert.equal(status.hidden, true);
  configContext.api = async () => ({ ok: true, demo: true });
  assert.equal((await vm.runInContext('waitForConfig()', configContext)).demo, true, 'An explicitly configured demo remains supported');

  const elements = new Map(), calls = [], identified = [], addresses = [];
  let failLookup = false, remembered = true, creations = 0, local = true, capable = true;
  let creationError = null, signInCancelled = false, selectedCredential = 'original-credential', holdCreation = null;
  const phoneOptions = [], sheets = [], busy = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, { hidden: true, disabled: false, textContent: '', listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, insertAdjacentElement() {} });
    return elements.get(id);
  }
  const context = vm.createContext({
    $: element, document: { createElement: () => ({}) },
    ADDRESS: null, RECOVERY: null,
    UI: { openSheet: id => sheets.push(id), closeSheet() {}, setPasskeyBusy: value => busy.push(value) },
    Passkey: { supported: () => capable, platformReady: async () => local, remembered: () => remembered,
      identify: async (choose, options) => {
        identified.push(choose); phoneOptions.push(options);
        if (signInCancelled) { const err = new Error('Prompt closed'); err.name = 'NotAllowedError'; throw err; }
        return selectedCredential;
      },
      createCredential: async options => {
        phoneOptions.push(options);
        if (creationError) throw creationError;
        if (holdCreation) await holdCreation;
        creations++; remembered = true; return { credentialId: 'new-credential', publicKey: 'fixture' };
      },
      forget: () => { throw new Error('Sign-in must not discard a passkey or switch to creation'); } },
    api: async (route, body) => { calls.push({ route, body });
      if (route === '/api/whoami' && failLookup) { const err = new Error('Not found'); err.status = 404; throw err; }
      return { address: route === '/api/whoami' ? (body.credentialId === 'other-credential' ? 'other-account' : 'original-account') : 'new-account', step: 'active' }; },
    storeAddr: address => addresses.push(address), takeSmart() {}, pollStatus() {}, show() {},
  });
  const start = source.indexOf('  /* ---------------- landing:');
  const end = source.indexOf('  /* ---------------- recovery flow');
  await vm.runInContext('(async () => {\n' + source.slice(start, end) + '\nglobalThis.refresh = refreshLandingSupport;\n})()', context);
  const click = id => element(id).listeners.click({ preventDefault() {} });
  // A remembered account, missing storage, and desktop/mobile support all
  // open the same choices before any browser ceremony or account request.
  for (const hasLocal of [true, false]) {
    for (const hasRemembered of [true, false]) {
      local = hasLocal; remembered = hasRemembered;
      await context.refresh();
      await click('#btn-go');
      assert.equal(sheets.at(-1), 'sheet-phone');
      assert.equal(identified.length, 0, 'Opening choices must not auto-select a wallet');
      assert.equal(creations, 0, 'Opening choices must not create a wallet');
      assert.equal(calls.length, 0);
    }
  }
  local = true; remembered = true;
  await click('#btn-saved-signin');
  assert.equal(identified.at(-1), true, 'Sign-in ignores the remembered credential');
  assert.equal(addresses.at(-1), 'original-account'); assert.equal(creations, 0);
  selectedCredential = 'other-credential';
  await click('#btn-go'); await click('#btn-saved-signin');
  assert.equal(calls.at(-1).body.credentialId, 'other-credential');
  assert.equal(addresses.at(-1), 'other-account', 'The selected passkey determines the wallet');
  selectedCredential = 'original-credential';
  await click('#btn-unlock-existing'); assert.equal(identified.at(-1), true);
  failLookup = true;
  await click('#btn-saved-signin'); await click('#btn-saved-signin');
  assert.equal(creations, 0, 'Repeated failed sign-in never creates a replacement wallet');
  remembered = false; failLookup = false;
  await click('#btn-unlock-existing'); assert.equal(addresses.at(-1), 'original-account');
  assert.equal(creations, 0, 'The saved-passkey picker must work without a remembered credential');
  signInCancelled = true;
  await click('#btn-saved-signin'); assert.equal(creations, 0, 'Cancelled sign-in must not become signup');
  signInCancelled = false; remembered = true;
  for (const name of ['NotAllowedError', 'InvalidStateError']) {
    creationError = Object.assign(new Error('Passkey creation failed'), { name });
    const signIns = identified.length, openedAccounts = addresses.length;
    await click('#btn-phone-create');
    assert.equal(creations, 0, 'Failed creation must not deploy an account');
    assert.equal(identified.length, signIns, 'Failed creation must not sign into the previous wallet');
    assert.equal(addresses.length, openedAccounts);
  }
  creationError = null;
  let releaseCreation;
  holdCreation = new Promise(resolve => { releaseCreation = resolve; });
  const creating = click('#btn-phone-create');
  const prompts = phoneOptions.length, openedSheets = sheets.length;
  await click('#btn-phone-create'); await click('#btn-go'); await click('#btn-saved-signin');
  assert.equal(phoneOptions.length, prompts, 'Double clicks cannot open another ceremony');
  assert.equal(sheets.length, openedSheets, 'The chooser cannot reopen during a ceremony');
  releaseCreation(); await creating; holdCreation = null;
  assert.equal(creations, 1); assert.equal(addresses.at(-1), 'new-account');
  assert.equal(calls.filter(c => c.route === '/api/create-account').length, 1);
  const signInsAfterCreation = identified.length;
  await click('#btn-go');
  assert.equal(sheets.at(-1), 'sheet-phone');
  assert.equal(identified.length, signInsAfterCreation, 'After creation the button still offers a choice');
  assert.equal(creations, 1);
  remembered = false; local = false;
  // Refresh the real capability handler without a local authenticator.
  await context.refresh();
  const beforePhone = creations;
  await click('#btn-go');
  assert.equal(element('#btn-go').disabled, false, 'A desktop without biometrics still supports phone passkeys');
  assert.equal(sheets.at(-1), 'sheet-phone');
  assert.equal(creations, beforePhone, 'Opening phone choices does not create an account');
  await click('#btn-phone-signin');
  assert.equal(phoneOptions.at(-1).usePhone, true); assert.equal(identified.at(-1), true);
  assert.equal(creations, beforePhone);
  await click('#btn-saved-signin');
  assert.equal(phoneOptions.at(-1).usePhone, false, 'Saved sign-in opens all providers without a phone hint');
  assert.equal(identified.at(-1), true);
  assert.equal(creations, beforePhone, 'Saved sign-in cannot create a wallet');
  failLookup = true;
  await click('#btn-phone-signin'); assert.equal(creations, beforePhone, 'Unknown phone passkeys never trigger signup');
  failLookup = false;
  await click('#btn-phone-create'); assert.equal(creations, beforePhone + 1);
  assert.equal(phoneOptions.at(-1).usePhone, false, 'Creation allows the browser to offer Google Password Manager and phones');
  assert.equal(busy.at(-1), false);
  capable = false;
  await context.refresh();
  assert.equal(element('#btn-go').disabled, true, 'Browsers without WebAuthn remain unsupported');
  const supportedSheets = sheets.length;
  await click('#btn-go'); assert.equal(sheets.length, supportedSheets);
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /id="btn-go"[^>]*>Create Account or Sign In<\/button>/);
  assert.ok(!html.includes('id="btn-create-account"'), 'Only one account entry button');
  console.log('✓ Account choices on every visit, selected wallet lookup, explicit creation, cancellation/error isolation, duplicate-click guard, phone options and config retries');
})().catch(e => { console.error(e); process.exitCode = 1; });
