'use strict';
// Reads an existing ledger only. Never uses the funding worker or wallet keys,
// writes the ledger, prepares a transaction, or submits one.
const fs = require('node:fs');
const path = require('node:path');
const amount = value => /^\d+$/.test(String(value ?? '')) ? BigInt(value) : null;
const format = n => `${n / 100000000n}.${String(n % 100000000n).padStart(8, '0')}`.replace(/\.?0+$/, '');

function records(history, current) {
  const byId = new Map();
  for (const [account, entry] of [...Object.entries(history || {}), ...Object.entries(current || {})]) {
    if (!entry || typeof entry.id !== 'string') continue;
    const j = { ...entry, account: entry.account || entry.koinosRecipient || account };
    const prior = byId.get(j.id);
    if (!prior || Number(j.updatedAt || 0) >= Number(prior.updatedAt || 0)) byId.set(j.id, j);
  }
  return [...byId.values()].filter(j => j.status === 'done' && !j.demo
    && ![j.id, j.redeemId, j.swapId, j.ethTxHash].some(id => /^0xdemo/.test(String(id || ''))));
}

async function summarize(ledger, verifyBuy) {
  let bought = 0n, verifiedBought = 0n, sold = 0n;
  let missingBuys = 0, verifiedBuys = 0, missingSales = 0;
  // Multiple jobs that refer to the same final delivery count once.
  const deliveries = new Set();
  const buys = records(ledger.history, ledger.jobs).filter(j => {
    const tx = j.swapId || j.redeemId;
    if (!/^0x1220[0-9a-f]{64}$/i.test(tx || '')) return true;
    if (deliveries.has(tx)) return false;
    deliveries.add(tx); return true;
  });
  for (const j of buys) {
    const recorded = amount(j.koinReceived);
    if (recorded != null) bought += recorded; else missingBuys++;
    if (verifyBuy) {
      try {
        const actual = amount(await verifyBuy(j));
        if (actual != null && actual > 0n) { verifiedBought += actual; verifiedBuys++; }
      } catch (_) { /* Unavailable receipts remain explicitly unverified. */ }
    }
  }
  const sales = records(ledger.tradeHistory, ledger.trades).filter(j => j.kind === 'sell');
  for (const j of sales) {
    const value = amount(j.amount);
    if (value != null && value > 0n) sold += value; else missingSales++;
  }
  return { scope: 'Completed real trades retained in this server ledger',
    buys: { completed: buys.length, koinRecorded: format(bought), missingRecordedAmounts: missingBuys,
      koinVerified: format(verifiedBought), verified: verifiedBuys, unverified: buys.length - verifiedBuys,
      koinTotal: verifiedBuys === buys.length ? format(verifiedBought) : null },
    sells: { completed: sales.length, koinTotal: missingSales ? null : format(sold),
      koinRecorded: format(sold), missingAmounts: missingSales } };
}

async function receiptVerifier() {
  const chain = require('./chain');
  const { Contract } = require('koilib');
  const { rpcCandidates, NETWORKS } = require('./rpc');
  const { koinReceipt } = require('./eth/sell-routes');
  chain.configure({ network: 'mainnet', rpcs: rpcCandidates('mainnet') });
  const koin = NETWORKS.mainnet.koinContract;
  const token = new Contract({ id: koin, abi: require('../abi/token-abi.json') });
  return async j => {
    const tx = j.swapId || j.redeemId;
    if (!/^0x1220[0-9a-f]{64}$/i.test(tx || '')) return null;
    const receipt = await koinReceipt(tx);
    if (!receipt || receipt.pendingFinality || receipt.reverted) return null;
    let delivered = 0n;
    for (const event of receipt.events || []) {
      if (event.source !== koin || !/token\.transfer_event$/.test(event.name)) continue;
      const transfer = await token.serializer.deserialize(event.data, 'token.transfer_event');
      const value = amount(transfer.value);
      if (value == null) throw new Error('Invalid transfer amount');
      if (transfer.to === j.account) delivered += value;
      if (transfer.from === j.account) delivered -= value;
    }
    return delivered > 0n ? delivered.toString() : null;
  };
}

async function main() {
  const args = process.argv.slice(2), verify = args.includes('--verify');
  if (args.includes('--help')) {
    console.log('Usage: node tools/trade-totals.js [--verify] [path/to/funding.json]\nUses the app DATA_DIR when no path is supplied. --verify checks final KOIN receipts using read-only mainnet RPC calls. Output contains totals only; no keys or wallet addresses.');
    return;
  }
  const files = args.filter(a => a !== '--verify');
  if (files.length > 1 || files.some(a => a.startsWith('-'))) throw new Error('Use --help for command options');
  const file = files[0] || path.join(path.resolve(__dirname, '..', process.env.DATA_DIR || 'data'), 'funding.json');
  let raw, ledger;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (_) { throw new Error('Cannot read funding.json. Supply its existing path or use the same DATA_DIR as the app.'); }
  try { ledger = JSON.parse(raw); }
  catch (_) { throw new Error('The ledger is not valid JSON; no data was changed'); }
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) throw new Error('Invalid ledger; no data was changed');
  console.log(JSON.stringify(await summarize(ledger, verify ? await receiptVerifier() : null), null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { summarize, receiptVerifier };
