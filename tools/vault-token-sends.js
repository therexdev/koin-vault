'use strict';
const crypto = require('node:crypto');
const TokenAmounts = require('../public/js/token-amounts');
const { NETWORKS, rpcCandidates } = require('./rpc');

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// A transfer-only service for the Vault host. Existing account records and
// funding workers stay with the account backend; authority comes from the chain.
function createTokenService({ chain, network, modules, sponsorWif, demo, rateLimited, maxTransfersPerDayAddr = 30, now = Date.now }) {
  const pending = new Map();
  const net = NETWORKS[network];
  let configured = false, configAt = null;
  if (!demo && net && sponsorWif && ['verifier', 'modSign', 'modValidation'].every(key => chain.isAddr(modules[key]))) {
    try {
      chain.configure({ network, modules, sponsorWif, rpcs: rpcCandidates(network) });
      chain.sponsorAddress(); // Validate locally; never probe RPCs during startup.
      configured = true;
    } catch (_) {
      // A bad transfer sponsor must not take account sign-in offline.
      console.warn('Vault token sending disabled: invalid sponsor configuration');
    }
  }
  const ready = () => configured && configAt !== null && now() - configAt < 5 * 60000;
  function configureResponse(data) {
    const matches = configured && data.ok === true && data.demo === false && data.network === network
      && ['verifier', 'modSign', 'modValidation'].every(key => data.modules?.[key] === modules[key]);
    configAt = matches ? now() : null;
    return { ...data, sendCustomTokens: matches };
  }
  function prune() {
    for (const [ref, item] of pending) if (item.expires <= now()) pending.delete(ref);
  }
  async function prepare(body, ip) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'A transfer request is required');
    if (!ready()) fail(503, 'Added-token sending is unavailable. Refresh the wallet; the Vault host needs its sponsor and matching chain configuration.');
    const { address, asset } = body;
    const to = String(body.to || '').trim();
    if (!chain.isAddr(asset) || asset === net.koinContract || asset === net.vhpContract) fail(400, 'Choose a valid added token contract');
    if (!chain.isAddr(address) || !chain.isAddr(to)) fail(400, 'Valid sender and destination addresses are required');
    if (address === to) fail(400, 'Choose a destination other than your own wallet');
    if (rateLimited('vault-token:addr:' + address, maxTransfersPerDayAddr, 86400000)
      || rateLimited('vault-token:ip:' + ip, maxTransfersPerDayAddr * 2, 86400000)) fail(429, 'Too many token transfers today');
    prune();
    if (pending.size >= 1000) fail(503, 'Too many pending transfers. Try again shortly.');
    const installed = await chain.accountModules(address);
    if (!installed?.includes(modules.modSign) || !installed.includes(modules.modValidation)) fail(409, 'This account is not ready for passkey transfers');
    const meta = await chain.tokenMeta(asset, { fresh: true });
    if (!TokenAmounts.validDecimals(meta.decimals)) fail(400, 'This token has unsupported decimals');
    let units;
    try { units = TokenAmounts.toUnits(String(body.amount || '').trim(), meta.decimals); }
    catch (error) { fail(400, error.message); }
    const balance = await chain.tokenBalanceSats(asset, address);
    if (BigInt(balance) < BigInt(units)) fail(400, `Not enough ${meta.symbol || 'tokens'} — you hold ${TokenAmounts.fromUnits(balance, meta.decimals)}`);
    const mana = BigInt(await chain.provider().getAccountRc(chain.sponsorAddress()));
    if (mana < BigInt(chain.K.rcLimitSmart)) fail(503, 'The Vault sponsor is recharging its mana. Try again shortly.');
    const op = await chain.opTokenTransfer(asset, address, to, units);
    const tx = await chain.prepareUserTx(address, [op], { rcLimit: chain.K.rcLimitSmart });
    const ref = crypto.randomBytes(24).toString('hex');
    pending.set(ref, { address, tx: structuredClone(tx), expires: now() + 10 * 60000 });
    return { ok: true, asset, ref, tx, transfer: { contract: asset, symbol: meta.symbol || '?', decimals: meta.decimals, units } };
  }
  async function submit(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'A signed transfer is required');
    prune();
    const ref = String(body.ref || ''), known = pending.get(ref), tx = body.transaction;
    if (!known) fail(400, 'This action expired or was already submitted — start it again');
    // Consume before any async verification: simultaneous submissions cannot
    // co-sign or broadcast the same prepared action twice.
    pending.delete(ref);
    if (!tx || tx.id !== known.tx.id || JSON.stringify(tx.header) !== JSON.stringify(known.tx.header)
      || JSON.stringify(tx.operations) !== JSON.stringify(known.tx.operations)) fail(400, 'Transaction changed after preparation');
    if (!Array.isArray(tx.signatures) || tx.signatures.length !== 1 || typeof tx.signatures[0] !== 'string') fail(400, 'Expected exactly one passkey signature');
    // No local credential database is needed. Fail closed unless the deployed
    // sign module confirms this account's registered credential and signature.
    const verdict = await chain.verifyPasskeyOnChain(known.address, tx.signatures[0], known.tx.id);
    if (verdict.ok !== true) fail(verdict.ok === false ? 403 : 503, verdict.ok === false
      ? 'The chain rejected this passkey signature' : 'Passkey verification is unavailable. Start the send again shortly.');
    const signed = { ...known.tx, signatures: tx.signatures.slice() };
    const txid = await chain.submitSmartCosigned(signed, known.tx.id, known.address);
    return { ok: true, txid, explorer: net.explorer ? `${net.explorer}/tx/${txid}` : null };
  }
  return { configureResponse, prepare, submit };
}

module.exports = { createTokenService };
