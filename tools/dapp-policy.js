'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WEBSITE_ROUTES = new Set(['create', 'status', 'request', 'request-status', 'disconnect', 'launch']);
const WALLET_ROUTES = new Set(['challenge', 'connect', 'pending', 'approve', 'reject']);
const fail = (status, message) => Object.assign(new Error(message), { status });
const ACCOUNT_CODE_HASH = '0x1220' + crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(__dirname, '../contracts/vendor/account/Account.wasm'))).digest('hex');

// Origin is a browser boundary, not proof that a server owns a domain.
// Session secrets and wallet signatures remain mandatory independently.
function websiteOrigin(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.origin === raw && !url.username && !url.password ? url.origin : null;
  } catch (_) { return null; }
}

function access(route, rawOrigin, walletUrl) {
  const wallet = new URL(walletUrl).origin;
  if (rawOrigin === wallet) return { wallet: true, origin: wallet };
  if (!WEBSITE_ROUTES.has(route)) throw fail(403, 'Open KOIN Vault to review or approve this request');
  const origin = websiteOrigin(rawOrigin);
  if (!origin) throw fail(403, 'Connect from an HTTPS website');
  return { wallet: false, origin };
}

// Same-origin browser GETs normally omit Origin. Only infer the wallet for
// those reads, from browser-controlled fetch metadata or an exact referrer.
// Never turn an originless POST or a cross-site navigation into wallet access.
function requestOrigin(req, walletUrl) {
  if (req.headers.origin) return req.headers.origin;
  if (req.method !== 'GET') return null;
  const wallet = new URL(walletUrl).origin;
  if (req.headers['sec-fetch-site'] === 'same-origin') return wallet;
  if (!req.headers['sec-fetch-site']) {
    try { if (new URL(req.headers.referer).origin === wallet) return wallet; } catch (_) {}
  }
  return null;
}

function positive(value, fallback) {
  const input = String(value ?? fallback);
  if (!/^[1-9][0-9]{0,12}$/.test(input)) throw new Error('DApp sponsorship limits must be positive whole mana amounts');
  return BigInt(input) * 100000000n;
}

// Even a native transfer can invoke the source account's authorize callback.
// Do not expose the sponsor's ECDSA authority to replaced account code or an
// arbitrary installed module. Read uncached, bracket the reads with the signed
// account nonce, and require the standard Vault account and only its two modules.
async function assertSponsorAccount(chain, address, transaction) {
  const provider = chain.provider();
  const expectedModules = [chain.K.modules.modSign, chain.K.modules.modValidation];
  if (expectedModules.some(m => !m) || address === chain.sponsorAddress()) throw fail(403, 'This account must use its own mana');
  async function checkNonce() {
    if (transaction && (transaction.header.payee !== address
        || transaction.header.payer !== chain.sponsorAddress()
        || await provider.getNextNonce(address) !== transaction.header.nonce)) {
      throw fail(409, 'Wallet state changed. Create a fresh transaction request.');
    }
  }
  await checkNonce();
  const { value } = await provider.invokeGetContractMetadata(address);
  if (!value || value.hash !== ACCOUNT_CODE_HASH || value.system
      || value.authorizes_call_contract !== true || value.authorizes_transaction_application !== true
      || value.authorizes_upload_contract !== true) throw fail(403, 'Modified wallet code must use its own mana');
  const modules = await chain.accountModules(address);
  if (!Array.isArray(modules) || modules.length !== 2 || expectedModules.some(m => !modules.includes(m))) {
    throw fail(403, 'Custom wallet modules must use the wallet\u2019s own mana');
  }
  await checkNonce();
}

// Charge the signed ceiling, not an estimate. Persist before the sponsor signs.
// Failed/ambiguous submissions keep their charge; reconnects and process
// restarts cannot reset a day's budget. Single-process wallet backend.
function createBudget({ file, globalMana, accountMana, siteMana, now = Date.now } = {}) {
  const limits = { global: positive(globalMana, 5000), account: positive(accountMana, 500), site: positive(siteMana, 1000) };
  let state = { day: '', spent: {} };
  if (file) {
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof state.day !== 'string' || !state.spent || Array.isArray(state.spent)
          || Object.values(state.spent).some(v => !/^\d+$/.test(v))) throw new Error('Invalid sponsorship budget file');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
  const keys = (address, origin) => ({ global: 'global', account: 'account:' + hash(address), site: 'site:' + hash(origin) });
  function snapshot() {
    const day = new Date(now()).toISOString().slice(0, 10);
    return day === state.day ? state : { day, spent: {} };
  }
  function check(address, origin, ceiling) {
    const amount = BigInt(ceiling), current = snapshot(), bucketKeys = keys(address, origin);
    if (amount <= 0n) throw new Error('Invalid sponsored mana ceiling');
    for (const [kind, key] of Object.entries(bucketKeys)) {
      if (BigInt(current.spent[key] || '0') + amount > limits[kind]) {
        throw fail(429, `The ${kind === 'global' ? 'shared' : kind} daily sponsorship budget is used. You can request a transaction using your wallet\u2019s own mana.`);
      }
    }
    return { current, bucketKeys, amount };
  }
  function spend(address, origin, ceiling) {
    const { current, bucketKeys, amount } = check(address, origin, ceiling);
    const next = { day: current.day, spent: { ...current.spent } };
    for (const key of Object.values(bucketKeys)) next.spent[key] = (BigInt(next.spent[key] || '0') + amount).toString();
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temporary, file);
    }
    state = next;
  }
  return { check, spend };
}

module.exports = { websiteOrigin, access, requestOrigin, WEBSITE_ROUTES, WALLET_ROUTES, createBudget, assertSponsorAccount, ACCOUNT_CODE_HASH };
