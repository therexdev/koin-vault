'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const parse = source.slice(source.indexOf('  let PENDING_INTENT = null;'), source.indexOf('  const VIEWS ='));
const resume = source.slice(source.indexOf('  // Remembering an address is not an unlock.'), source.lastIndexOf('})();'));
for (const [pathname, search, view] of [
  ['/', '?open=recover', '#view-recover'],
  ['/android/', '?open=recover', '#view-recover'],
  ['/', '', '#view-landing'],
  ['/', '?open=send', '#view-landing'],
]) {
  const changes = [], views = [];
  const context = vm.createContext({
    URLSearchParams, location: { pathname, search },
    history: { replaceState: (...args) => changes.push(args) },
    show: value => views.push(value),
    document: { addEventListener() {} },
  });
  vm.runInContext(parse + resume, context);
  assert.deepEqual(views, [view]);
  if (search) assert.equal(changes[0][2], pathname, 'Remove the recovery link parameter after opening it');
  if (view === '#view-recover') assert.equal(vm.runInContext('PENDING_INTENT', context), null, 'Recovery is not a send intent');
}
console.log('✓ Recovery links open the existing kit form on web and Android; ordinary sign-in and send links remain available');
