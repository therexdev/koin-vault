'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const { once } = require('node:events');
const { Signer } = require('koilib');
const chain = require('../tools/chain');
const { NETWORKS } = require('../tools/rpc');
const read = file => fs.readFileSync(require('node:path').join(__dirname, '..', file), 'utf8');
const Portfolio = vm.runInNewContext(read('public/js/portfolio.js') + '\nPortfolio;');
const address = Signer.fromSeed('balance-refresh-fixture').getAddress();
const custom = Signer.fromSeed('balance-refresh-custom').getAddress();
const now = 100000000;
const leg = value => ({ value, at: now, source: 'fixture' });
function answer(koin = '100000000', vhp = '200000000') {
  return { address, network: 'mainnet', prices: { koinUsd: leg(2), vhpUsd: leg(1) },
    assets: [['koin', koin, 2], ['vhp', vhp, 1]].map(([id, sats, price]) => ({
      id, symbol: id.toUpperCase(), address: NETWORKS.mainnet[id + 'Contract'], decimals: 8, native: true,
      sats, amount: sats == null ? null : String(Number(sats) / 1e8),
      usd: sats == null ? null : Number(sats) / 1e8 * price, unavailable: sats == null,
    })), totalUsd: koin == null || vhp == null ? null : Number(koin) / 1e8 * 2 + Number(vhp) / 1e8,
    allPriced: koin != null && vhp != null };
}

async function modelChecks() {
  const good = Portfolio.retain(Portfolio.model(answer()), null, now);
  const missingKoin = Portfolio.model(answer(null, '300000000'));
  const partial = Portfolio.retain(missingKoin, good, now + 5000);
  assert.equal(partial.koin.amountText, '1'); assert.equal(partial.koin.unavailable, true);
  assert.equal(partial.koin.balanceStale, true); assert.equal(partial.koin.balanceAt, now);
  assert.equal(partial.vhp.amountText, '3'); assert.equal(partial.vhp.balanceAt, now + 5000);
  assert.equal(partial.totalUsd, 5, 'Do not shrink the total by treating missing KOIN as zero');
  assert.equal(missingKoin.koin.sats, null, 'Retention must not modify live balances used by Send all');
  const repeated = Portfolio.retain(Portfolio.model(answer(null, null)), partial, now + 10000);
  assert.equal(repeated.koin.balanceAt, now); assert.equal(repeated.vhp.balanceAt, now + 5000);
  const outage = Portfolio.retain({ address, network: 'mainnet', error: 'offline' }, repeated, now + 15000);
  assert.equal(outage.koin.amountText, '1'); assert.equal(outage.vhp.amountText, '3');
  assert.equal(outage.refreshFailed, true); assert.equal(outage.koin.balanceAt, now);
  const zero = Portfolio.retain(Portfolio.model(answer('0', '0')), outage, now + 20000);
  assert.equal(zero.koin.amountText, '0'); assert.equal(zero.totalUsdText, '$0.00');
  assert.equal(zero.balanceStale, false, 'A verified zero replaces the previous balance');
  const first = Portfolio.retain(Portfolio.model(answer(null, '200000000')), null, now);
  assert.equal(first.koin.amountText, '—'); assert.equal(first.partialTotal, true);
  for (const change of [{ address: 'different-wallet' }, { network: 'harbinger' }, { demo: true }]) {
    const switched = Portfolio.retain({ ...missingKoin, ...change }, good, now + 1);
    assert.equal(switched.koin.amountText, '—', 'Never reuse balances across wallet identities');
  }
  for (const current of [Portfolio.model(answer(null, null)), { address, network: 'mainnet', error: 'offline' }]) {
    const expired = Portfolio.retain(current, partial, now + 24 * 3600000 + 10000);
    assert.equal(expired.koin.amountText, '—'); assert.equal(expired.koin.balanceStale, false);
    assert.equal(expired.totalUsd, null, 'Old balances expire even during a total outage');
  }
  const withToken = answer(); withToken.assets.push({ id: custom, address: custom, symbol: 'TEST', sats: '100', amount: '1', decimals: 2, usd: null });
  const saved = Portfolio.retain(Portfolio.model(withToken), null, now);
  assert.equal(Portfolio.retain(Portfolio.model(answer()), saved, now + 1).others.length, 0, 'Removed tokens stay removed');
  const failed = { ...withToken, assets: withToken.assets.map(row => row.id === custom ? { ...row, sats: null, amount: null, unavailable: true } : row) };
  const retainedToken = Portfolio.retain(Portfolio.model(failed), saved, now + 1).others[0];
  assert.equal(retainedToken.amountText, '1'); assert.equal(retainedToken.unavailable, true);
  for (const body of [{}, { address, assets: [] }, { ...answer(), address: 'different' }]) {
    const invalid = await Portfolio.load(address, async () => body);
    assert.ok(invalid.error, 'Malformed responses must not overwrite the saved display');
  }
  console.log('✓ Partial/total outages retain exact amounts and original times; real zero, expiry, identity and token removal work');
}

async function apiChecks() {
  const source = read('server.js');
  let fail = true, calls = 0;
  const ctx = vm.createContext({ api: {}, DEMO: false, NETWORKS, CFG: { network: 'mainnet' },
    MAX_CLIENT_TOKENS: 12, WALLET_TOKENS: [], veive: { status() {} },
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    prices: { snapshot: async () => answer().prices },
    chain: { isAddr: chain.isAddr,
      koinBalanceSats: async () => { calls++; if (fail) throw new Error('RPC unavailable'); return '0'; },
      vhpBalanceSats: async () => '200000000',
      mana: async () => { if (fail) throw new Error('RPC unavailable'); return 0; },
    },
  });
  vm.runInContext(source.slice(source.indexOf('api.account ='), source.indexOf('/* ---------------- portfolio')), ctx);
  vm.runInContext(source.slice(source.indexOf('const fromSats ='), source.indexOf('api.transactions =')), ctx);
  vm.runInContext(source.slice(source.indexOf('api.portfolio ='), source.indexOf('/** Prepare the transaction')), ctx);
  const params = new URLSearchParams({ address });
  const account = await ctx.api.account(params);
  assert.equal(account.koin, null); assert.equal(account.koinSats, null); assert.equal(account.mana, null);
  assert.equal(calls, 1, 'Account needs only one exact KOIN read');
  const partial = await ctx.api.portfolio(params);
  assert.equal(partial.assets[0].unavailable, true); assert.equal(partial.assets[1].amount, '2');
  assert.equal(partial.allPriced, false, 'A missing token is never reported as a complete total');
  fail = false;
  const empty = await ctx.api.account(params);
  assert.equal(empty.koin, 0); assert.equal(empty.koinSats, '0'); assert.equal(empty.mana, 0);
  assert.equal((await ctx.api.portfolio(params)).allPriced, true);
  console.log('✓ Account failures stay null, genuine zeros stay zero, and partial portfolio totals are flagged');
}

function uiChecks() {
  const source = read('public/js/ui.js'), storage = new Map(), note = {};
  const context = vm.createContext({ Portfolio, CTX: { address, cfg: { network: 'mainnet' }, model: null, modelAt: null },
    LS_LAST: 'portfolio', CACHE_MAX_AGE: 24 * 3600000, byId: () => note, paintOffline() {},
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    fmtWhen: value => String(value), renderUnavailable() { context.empty = true; },
    renderModel(model, at) { context.CTX.model = model; context.CTX.modelAt = at; },
  });
  vm.runInContext(source.slice(source.indexOf('  function saveLast('), source.indexOf('  function renderUnavailable(')), context);
  context.paintPortfolio(Portfolio.model(answer()));
  const firstAt = context.CTX.model.koin.balanceAt;
  context.paintPortfolio(Portfolio.model(answer(null, '300000000')));
  assert.equal(context.CTX.model.koin.amountText, '1'); assert.equal(context.CTX.model.vhp.amountText, '3');
  assert.equal(note.hidden, false); assert.match(note.textContent, /Updating balances/);
  assert.equal(JSON.parse(storage.get('portfolio')).model.koin.balanceAt, firstAt, 'Persistence retains the original verification time');
  context.paintPortfolio({ address, error: 'offline' });
  assert.equal(context.CTX.model.koin.amountText, '1'); assert.equal(context.CTX.model.vhp.amountText, '3');
  context.paintPortfolio(Portfolio.model(answer('0', '0')));
  assert.equal(note.hidden, true); assert.equal(context.CTX.model.koin.amountText, '0');
  const cached = context.restoreLast(address);
  assert.equal(cached.model.koin.amountText, '0');
  context.CTX.cfg.network = 'harbinger';
  assert.equal(context.restoreLast(address), null, 'Persistent cache stays scoped to its network');
  console.log('✓ The UI and saved screen retain partial balances with an updating notice and clear it on recovery');
}

async function readerChecks() {
  const servers = [];
  const start = async handler => { const s = http.createServer(handler); servers.push(s); s.listen(0, '127.0.0.1'); await once(s, 'listening'); return `http://127.0.0.1:${s.address().port}`; };
  let backupReads = 0, primaryReads = 0, value = '24358978673';
  const encoded = value => {
    let n = BigInt(value); const b = [8];
    do { let byte = Number(n & 127n); n >>= 7n; b.push(byte | (n ? 128 : 0)); } while (n);
    return Buffer.from(b).toString('base64url');
  };
  try {
    const blocked = await start((_req, res) => { primaryReads++; res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Access denied' } })); });
    const healthy = await start(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      assert.equal(JSON.parse(body).method, 'chain.read_contract'); backupReads++;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result: { result: encoded(value) } }));
    });
    chain.configure({ network: 'mainnet', rpcs: [blocked, healthy] });
    const balances = await Promise.all([chain.koinBalanceSats(address), chain.koinBalance(address), chain.koinBalanceSats(address)]);
    assert.deepEqual(balances, ['24358978673', 243.58978673, '24358978673']);
    assert.equal(primaryReads, 1); assert.equal(backupReads, 1, 'Concurrent account/portfolio reads share one RPC');
    value = '0'; assert.equal(await chain.koinBalanceSats(address), '0');
    assert.equal(backupReads, 2, 'A later request fetches a fresh balance, never a cached spendable amount');
    let attempts = 0;
    const flaky = await start((_req, res) => {
      attempts++; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(attempts === 1 ? { error: { message: 'AMQP connection is not open' } } : { result: { result: encoded(7) } }));
    });
    chain.configure({ network: 'mainnet', rpcs: [flaky] });
    assert.equal(await chain.koinBalanceSats(address), '7'); assert.equal(attempts, 2);
    console.log('✓ Blocked nodes fail over, concurrent balance reads share work, later reads stay fresh, and single-node retries recover');
  } finally { for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
}

async function refreshChecks() {
  const source = read('public/js/app.js');
  const timers = new Map(), nodes = new Map(); let timerId = 0, accountFails = false, pendingAccount, model = Portfolio.model(answer()), painted;
  const ctx = vm.createContext({ ADDRESS: address, ACTIVE: true, PAINT_GEN: 0, RESUMING: false, RECOVERY: null, BALANCE_SATS: '', VHP_BALANCE_SATS: '', TOKEN_BALANCES: {},
    transactionFeed: null, cfg: {}, document: { hidden: false }, WalletClient: { canBuy: false },
    Passkey: { storedId: () => 'credential' }, UI: { setContext() {}, paintPortfolio: m => { painted = m; } },
    $: selector => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id),
    takeSmart() {}, Portfolio: { load: async () => model },
    api: async () => { if (pendingAccount) await pendingAccount; if (accountFails) throw new Error('offline'); return { koinSats: null, mana: null }; },
  });
  vm.runInContext(source.slice(source.indexOf('  let PAINTING ='), source.indexOf('  setInterval(() => { if (!$(\'#view-wallet\')')), ctx);
  let release; pendingAccount = new Promise(resolve => { release = resolve; });
  const painting = ctx.paint(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(painted, model, 'A successful portfolio paints while account status is still waiting');
  release(); await painting; pendingAccount = null;
  assert.equal(ctx.BALANCE_SATS, ''); assert.equal(nodes.get('#mana').textContent, '—');
  assert.equal([...timers.values()][0].ms, 5000, 'Unavailable account state retries quickly');
  accountFails = true; model = Portfolio.model(answer(null, null)); await ctx.paint();
  assert.equal(ctx.VHP_BALANCE_SATS, ''); assert.equal(ctx.BALANCE_SATS, ''); assert.equal(timers.size, 1);
  const retry = [...timers.values()][0].fn;
  vm.runInContext('PAINT_GEN++; ADDRESS = null;', ctx); const before = painted; retry();
  assert.equal(painted, before, 'A late retry cannot reopen a signed-out wallet');
  console.log('✓ Partial refreshes retry in five seconds, slow status does not block display, and unavailable spend balances stay empty');
}

(async () => { await modelChecks(); await apiChecks(); uiChecks(); await readerChecks(); await refreshChecks(); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
