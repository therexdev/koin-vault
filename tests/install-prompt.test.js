'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const client = read('public/js/client.js'), ui = read('public/js/ui.js');
function setup({ ua = 'Android Mobile', standalone = false, android = false, event } = {}) {
  const storage = new Map([['bw_installed', '1'], ['bw_install_snooze', String(Date.now() + 86400000)]]);
  const nodes = new Map(), handlers = new Map(), timers = [], opened = [], clicks = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, hidden: true, textContent: '', lastChild: { nodeType: 3, textContent: '' } });
    return nodes.get(id);
  };
  const context = vm.createContext({
    Event: class { constructor(type) { this.type = type; } },
    window: { addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
      dispatchEvent(event) { for (const fn of handlers.get(event.type) || []) fn(event); },
      matchMedia: () => ({ matches: standalone }) },
    document: { documentElement: { dataset: { walletClient: android ? 'android' : '' } }, querySelector: () => null },
    navigator: { userAgent: ua }, location: { pathname: android ? '/android/' : '/' },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    byId: node, sheetEl: null, passkeyBusy: false, tokenOpen: null,
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); }, toast() {},
    openSheet: id => { context.sheetEl = node(id); node(id).hidden = false; opened.push(id); },
    closeSheet: (opts = {}) => {
      const sheet = context.sheetEl; context.sheetEl = null;
      if (sheet) { sheet.hidden = true; context.onSheetClose(sheet.id, opts); }
    },
    on: (id, fn) => clicks.set(id, fn),
  });
  vm.runInContext(client, context);
  if (event) context.window.dispatchEvent(event); // Event arrives before ui.js.
  vm.runInContext('var installation = WalletClient.installation;', context);
  vm.runInContext(ui.slice(ui.indexOf('  function onSheetClose('), ui.indexOf('  /* ---------------- toast')), context);
  vm.runInContext(ui.slice(ui.indexOf('  /* ---------------- install /'), ui.indexOf('  /* ---------------- wiring')), context);
  vm.runInContext(ui.slice(ui.indexOf('    /* install prompt */'), ui.indexOf('    /* offline */')), context);
  context.paintInstall();
  return { context, storage, node, clicks, opened, timers };
}
function promptEvent(outcome = 'dismissed', reject = false) {
  return { type: 'beforeinstallprompt', prevented: false, calls: 0,
    preventDefault() { this.prevented = true; },
    prompt() { this.calls++; return reject ? Promise.reject(new Error('Browser blocked the prompt')) : Promise.resolve(); },
    userChoice: Promise.resolve({ outcome }),
  };
}
(async () => {
  const event = promptEvent();
  const s = setup({ event });
  assert.equal(event.prevented, true);
  assert.equal(s.context.installOffer(), 'prompt', 'Capture native install events before UI initialization');
  assert.equal(s.node('btn-install-landing').hidden, false, 'Historical installed flags do not permanently hide installation');
  s.context.promptInstall(); assert.equal(s.opened.at(-1), 'sheet-install');
  s.context.closeSheet({ immediate: true }); // app.js completes configuration and shows landing.
  assert.equal(s.storage.has('kv_install_snooze_v2'), false, 'Programmatic closure must not snooze installation');
  s.context.promptInstall(); assert.equal(s.opened.length, 2, 'Startup closure must allow the popup to return');
  s.context.closeSheet({ dismissed: true });
  s.context.promptInstall(); assert.equal(s.opened.length, 2, 'User dismissal must suppress automatic reopening');
  await s.clicks.get('btn-install-landing')();
  assert.equal(event.calls, 1, 'The manual button still opens the native prompt while snoozed');
  assert.equal(s.context.installOffer(), 'android', 'Consumed install events are never reused');
  await s.clicks.get('btn-install-landing')();
  assert.equal(event.calls, 1); assert.equal(s.opened.at(-1), 'sheet-install');
  assert.equal(s.node('install-steps-android').hidden, false);
  s.context.window.dispatchEvent({ type: 'appinstalled' });
  assert.equal(s.node('btn-install-landing').hidden, true);
  assert.equal(s.context.installOffer(), null);

  const failed = promptEvent('accepted', true), f = setup({ event: failed });
  await f.context.runInstallPrompt();
  assert.equal(f.node('install-steps-android').hidden, false, 'A rejected native prompt offers browser-menu instructions');
  assert.equal(f.context.installation.installed, false, 'An attempted install is not proof of installation');
  assert.equal(f.context.installation.busy, false);
  const a = setup({ event: promptEvent('accepted') });
  await a.context.runInstallPrompt();
  assert.equal(a.context.installation.installed, false, 'Wait for appinstalled before declaring the app installed');

  const ios = setup({ ua: 'iPhone' });
  ios.context.promptInstall(); assert.equal(ios.node('install-steps-ios').hidden, false);
  const desktop = setup({ ua: 'Windows' });
  desktop.context.promptInstall(); assert.equal(desktop.opened.length, 0);
  await desktop.clicks.get('btn-install-landing')(); assert.equal(desktop.node('install-steps-desktop').hidden, false);
  for (const env of [{ standalone: true }, { android: true }]) {
    const installed = setup(env); installed.context.promptInstall();
    assert.equal(installed.opened.length, 0); assert.equal(installed.node('btn-install-landing').hidden, true);
  }
  const busy = setup(); busy.context.setPasskeyBusy(true); busy.context.promptInstall();
  assert.equal(busy.opened.length, 0, 'Do not interrupt a passkey ceremony with installation');
  busy.context.setPasskeyBusy(false); busy.context.promptInstall(); assert.equal(busy.opened.length, 1);
  const recovery = setup(); recovery.node('view-recover').hidden = false; recovery.context.promptInstall();
  assert.equal(recovery.opened.length, 0, 'Do not interrupt recovery-file entry');
  console.log('✓ Early install events, startup navigation, stale flags, manual install, dismissal, rejection, installed apps and browser instructions');
})().catch(error => { console.error(error); process.exitCode = 1; });
