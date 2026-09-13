'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, textContent: '', appendChild() {} });
  return elements.get(id);
};
const credentials = Array.from({ length: 6 }, (_, i) => ({ id: 'fixture-credential-' + i, kind: i < 4 ? 'passkey' : 'recovery' }));
const context = vm.createContext({
  $: element, cfg: { maxCredentialsPerAccount: 32 }, CREDENTIALS: credentials,
  PENDING_KIT: null, PENDING_BACKUP: null, GENERATING_KIT: false, RECOVERY: null, ACTIVE: true,
  Passkey: { storedId: () => credentials[0].id }, UI: { paintProtection() {} },
  document: { createElement: () => ({ querySelector: () => ({ textContent: '' }) }) },
});
vm.runInContext(source.slice(source.indexOf('  function credentialLimit()'), source.indexOf('  const bsay =')), context);
const paint = () => vm.runInContext('renderCredentials()', context);
paint();
assert.equal(element('#btn-make-kit').hidden, false);
assert.equal(element('#btn-make-kit').disabled, false, 'Six existing credentials still allow another kit');
assert.equal(element('#kit-create-label').textContent, 'Create another recovery kit');
assert.match(element('#credential-capacity').textContent, /6 of 32/);
assert.match(element('#kit-armed').textContent, /2 recovery kits are active/);
context.PENDING_KIT = {}; paint();
assert.equal(element('#btn-make-kit').hidden, false, 'Pending kits keep the button visible');
assert.equal(element('#btn-make-kit').disabled, true);
context.PENDING_KIT = null; context.GENERATING_KIT = true; paint();
assert.equal(element('#btn-make-kit').disabled, true, 'A background repaint cannot enable a competing generation');
context.GENERATING_KIT = false; context.CREDENTIALS = Array.from({ length: 32 }, (_, i) => ({ id: 'fixture-' + i, kind: 'passkey' }));
paint();
assert.equal(element('#btn-make-kit').hidden, false, 'At capacity the button must explain the limit instead of disappearing');
assert.equal(element('#btn-make-kit').disabled, true);
assert.match(element('#credential-capacity').textContent, /reached the configured limit/);
context.CREDENTIALS = credentials; context.cfg = {}; paint();
assert.equal(element('#btn-make-kit').disabled, true, 'Do not promise extra capacity before an older backend is updated');
context.cfg = { maxCredentialsPerAccount: 8 }; paint();
assert.equal(element('#btn-make-kit').disabled, false);
assert.match(element('#credential-capacity').textContent, /6 of 8/);
console.log('✓ Recovery creation stays visible; server capacity, existing kits, pending kits and background repaints are respected');
