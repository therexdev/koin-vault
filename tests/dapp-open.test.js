'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { Contract, Signer, utils } = require('koilib');
const policy = require('../tools/dapp-policy');
const review = require('../tools/dapp-review');
const relay = require('../tools/dapp-relay');
const auth = require('../tools/dapp-auth');
const realChain = require('../tools/chain');
const wire = require('../public/js/webauthn-wire');
const net = require('../tools/rpc').NETWORKS.mainnet;
const wallet = 'https://koinvault.app', site = 'https://new-site.example';
const address = Signer.fromSeed('open-connect-owner').getAddress();
const recipient = Signer.fromSeed('open-connect-recipient').getAddress();
const custom = Signer.fromSeed('open-connect-token').getAddress();
const sponsor = Signer.fromSeed('open-connect-sponsor').getAddress();
const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const key = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const req = origin => ({ headers: { origin }, socket: { encrypted: true } });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-dapp-open-'));
const tokenAbi = JSON.parse(JSON.stringify(require('../abi/token-abi.json')));
const types = tokenAbi.koilib_types.nested.koinos?.nested;
if (types) { delete types.btype; delete types._btype; }
const operation = async (id, name, args) => (await new Contract({ id, abi: tokenAbi }).functions[name](args, { onlyOperation: true })).operation;

function signature(challenge, origin = wallet) {
  const data = Buffer.alloc(37); data[32] = 5;
  crypto.createHash('sha256').update(new URL(origin).hostname).digest().copy(data);
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', origin, challenge: Buffer.from(challenge).toString('base64url') }));
  const sig = crypto.sign('sha256', Buffer.concat([data, crypto.createHash('sha256').update(client).digest()]), pair.privateKey);
  return wire.packSignatureBlob({ credentialId: 'fixture', signature: sig, authenticatorData: data, clientDataJSON: client });
}

(async () => {
  for (const origin of [site, 'https://example.com:8443', 'https://xn--bcher-kva.example']) assert.equal(policy.websiteOrigin(origin), origin);
  for (const origin of ['', 'null', '*', 'http://example.com', 'https://example.com/', 'https://example.com/path',
    'https://example.com?query', 'https://user@example.com', 'https://example.com#fragment', 'https://EXAMPLE.com', 'https://example.com https://other.com']) {
    assert.equal(policy.websiteOrigin(origin), null, origin);
  }
  for (const route of policy.WALLET_ROUTES) assert.throws(() => policy.access(route, site, wallet), /KOIN Vault/);
  for (const route of policy.WEBSITE_ROUTES) assert.equal(policy.access(route, site, wallet).origin, site);
  assert.throws(() => policy.access('approve', wallet + '.evil.example', wallet));
  assert.equal(policy.requestOrigin({ method: 'GET', headers: { 'sec-fetch-site': 'same-origin' } }, wallet), wallet);
  assert.equal(policy.requestOrigin({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }, wallet), null);
  assert.equal(policy.requestOrigin({ method: 'GET', headers: { origin: site, 'sec-fetch-site': 'same-origin' } }, wallet), site);
  assert.equal(policy.requestOrigin({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site', referer: wallet } }, wallet), null);

  let now = Date.UTC(2026, 8, 14);
  const file = path.join(temp, 'budget.json');
  let budget = policy.createBudget({ file, globalMana: 300, accountMana: 100, siteMana: 200, now: () => now });
  budget.spend(address, site, '10000000000');
  assert.throws(() => budget.spend(address, 'https://another.example', '1'), /account/);
  budget = policy.createBudget({ file, globalMana: 300, accountMana: 100, siteMana: 200, now: () => now });
  assert.throws(() => budget.check(address, site, '1'), /account/, 'restart does not reset budget');
  budget.spend(recipient, site, '10000000000');
  assert.throws(() => budget.spend(custom, site, '1'), /site/);
  budget.spend(custom, 'https://another.example', '10000000000');
  assert.throws(() => budget.check(sponsor, 'https://third.example', '1'), /shared/);
  now += 86400000; budget.check(address, site, '10000000000');
  assert.throws(() => policy.createBudget({ globalMana: 'NaN' }));
  fs.writeFileSync(path.join(temp, 'corrupt.json'), 'bad');
  assert.throws(() => policy.createBudget({ file: path.join(temp, 'corrupt.json') }));

  const submitted = [], prepared = [];
  let blockPrepare = null, holdProof = null, holdSubmit = null;
  let sponsorRc = '1000000000000', walletRc = '1000000000000';
  const chain = {
    K: { ...realChain.K, modules: {} }, net: () => net, isAddr: realChain.isAddr,
    modSignSerializer: realChain.modSignSerializer,
    accountCredentials: async account => { assert.equal(account, address); if (holdProof) await holdProof;
      return [{ credential_id: 'fixture', public_key: key }]; },
    tokenMeta: async () => ({ symbol: 'KOIN', decimals: 6 }), sponsorAddress: () => sponsor,
    provider: () => ({ getAccountRc: async account => account === sponsor ? sponsorRc : walletRc }),
    prepareUserTx: async (user, ops, options) => prepare(user, ops, options, true),
    prepareSelfPaidTx: async (user, ops, options) => prepare(user, ops, options, false),
    submitSmartCosigned: async tx => { submitted.push('sponsor'); if (holdSubmit) await holdSubmit; return tx.id; },
    submitSelfPaid: async tx => { submitted.push('wallet'); return tx.id; },
  };
  async function prepare(user, ops, options, sponsored) {
    prepared.push(sponsored ? 'sponsor' : 'wallet');
    if (blockPrepare) await blockPrepare;
    return { id: '0x1220' + crypto.randomBytes(32).toString('hex'),
      header: { payer: sponsored ? sponsor : user, payee: user, rc_limit: options.rcLimit }, operations: ops };
  }
  const context = vm.createContext({
    api: {}, DEMO: false, CFG: { network: 'mainnet', publicUrl: wallet, passkeyRpId: 'koinvault.app', minCreateMana: 120 },
    dappPolicy: policy, dappReview: review, dappRelay: relay, dappAuth: auth,
    dappProducer: require('../tools/dapp-producer'), dappLaunch: require('../tools/dapp-launch'),
    walletBackend: require('../tools/wallet-backend'),
    dappBudget: policy.createBudget(), dappReservedMana: 0n,
    veive: { status: () => ({ address, step: 'active' }), ensureReady: async () => {}, credentialsFor: () => ['fixture'] },
    chain, isDeepStrictEqual: require('node:util').isDeepStrictEqual,
    rateLimited: () => false, httpError: (status, message) => Object.assign(new Error(message), { status }),
    explorerTx: id => 'https://example.com/tx/' + id, Date, BigInt, URL,
  });
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function dappSession('), source.indexOf('/** What is actually running here.')), context);
  const api = context.api;
  async function connect(origin = site) {
    const session = await api.dappCreate({ name: 'A new app' }, 'ip', null, req(origin));
    const initial = await api.dappStatus(new URLSearchParams(session), null, req(origin));
    assert.equal(initial.connected, false);
    await assert.rejects(api.dappChallenge({ ...session, address }, null, null, req(origin)), /KOIN Vault/);
    const proof = await api.dappChallenge({ ...session, address }, null, null, req(wallet));
    await api.dappConnect({ ...session, address, credentialId: 'fixture', challenge: proof.challenge, signature: signature(proof.challenge) }, null, null, req(wallet));
    return session;
  }
  async function ask(session, operations, extra = {}) {
    const result = await api.dappRequest({ ...session, operations, summary: { title: 'Receive a free gift', detail: 'No tokens leave', network: 'FAKE' }, ...extra }, 'ip', null, req(site));
    return relay.request(relay.get(session.sessionId, session.secret), result.requestId);
  }
  async function approve(session, request, extra = {}, origin = wallet) {
    return api.dappApprove({ ...session, requestId: request.id,
      transaction: { ...request.transaction, signatures: [signature(request.transaction.id)] }, ...extra }, null, null, req(origin));
  }
  const native = await operation(net.koinContract, 'transfer', { from: address, to: recipient, value: '123456789' });
  const session = await connect();
  await assert.rejects(api.dappStatus(new URLSearchParams(session), null, req('https://other.example')), /origin/);
  const first = await ask(session, [native]);
  assert.equal(first.review.sponsorEligible, true);
  assert.equal(first.funding.payer, 'sponsor');
  assert.equal(first.funding.maxMana, '20');
  assert.match(first.review.actions[0].detail, /1\.23456789 KOIN/);
  assert.ok(first.review.actions[0].detail.includes(recipient));
  assert.ok(!JSON.stringify(first.review).includes('free gift'));
  assert.equal(first.review.network, 'mainnet');
  await assert.rejects(approve(session, first, {}, site), /KOIN Vault/);
  await assert.rejects(approve(session, first, { transaction: { ...first.transaction, id: 'changed', signatures: ['invalid'] } }), /changed/);
  await assert.rejects(approve(session, first, { transaction: { ...first.transaction, signatures: [signature(first.transaction.id, site)] } }), /match/);
  assert.equal(first.status, 'pending'); assert.equal(submitted.length, 0);
  const races = await Promise.allSettled([approve(session, first), approve(session, first)]);
  assert.equal(races.filter(x => x.status === 'fulfilled').length, 1);
  assert.deepEqual(submitted, ['sponsor']);

  const stranger = { call_contract: { contract_id: custom, entry_point: 777, args: 'AQ' } };
  const unknown = await ask(session, [stranger]);
  assert.equal(unknown.funding.payer, 'wallet'); assert.equal(unknown.review.requiresAcknowledgement, true);
  await assert.rejects(approve(session, unknown), /acknowledge/);
  await approve(session, unknown, { acknowledged: true });
  assert.deepEqual(submitted, ['sponsor', 'wallet']);
  const tokenOp = await operation(custom, 'transfer', { from: address, to: recipient, value: '123456789' });
  const tokenReview = await review.review(relay.validateOperations([tokenOp]), address, 'mainnet', chain);
  assert.equal(tokenReview.sponsorEligible, false);
  assert.match(tokenReview.actions[0].detail, /123\.456789/);
  assert.ok(tokenReview.warnings.some(w => w.includes('not verified')));
  assert.equal((await review.review(relay.validateOperations([native, stranger]), address, 'mainnet', chain)).sponsorEligible, false);
  const grant = await operation(net.koinContract, 'approve', { owner: address, spender: custom, value: '18446744073709551615' });
  const permission = await review.review(relay.validateOperations([grant]), address, 'mainnet', chain);
  assert.ok(permission.warnings.some(w => w.includes('maximum')));
  assert.ok(permission.actions[0].detail.includes(custom));
  const drain = await operation(net.koinContract, 'transfer', { from: sponsor, to: recipient, value: '1' });
  assert.equal((await review.review(relay.validateOperations([drain]), address, 'mainnet', chain)).sponsorEligible, false);
  const malformed = structuredClone(native);
  malformed.call_contract.args = Buffer.concat([Buffer.from(native.call_contract.args, 'base64url'), Buffer.from([0x80, 0x06, 0x01])]).toString('base64url');
  await assert.rejects(review.review([malformed], address, 'mainnet', chain));
  assert.throws(() => relay.validateOperations([{ call_contract: { ...native.call_contract, hidden: true } }]), /fields/);

  const paid = await ask(session, [native], { mana: 'wallet' });
  assert.equal(paid.funding.payer, 'wallet');
  await approve(session, paid);
  let finish;
  blockPrepare = new Promise(resolve => { finish = resolve; });
  const preparing = ask(session, [native]);
  while (prepared.length < 4) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(ask(session, [native]), /pending/);
  await api.dappDisconnect(session, null, null, req(site)); finish();
  await assert.rejects(preparing, /expired/); blockPrepare = null;

  const next = await connect(), pending = await ask(next, [native]);
  holdProof = new Promise(resolve => { finish = resolve; });
  const approving = approve(next, pending);
  await api.dappDisconnect(next, null, null, req(wallet)); finish();
  await assert.rejects(approving, /expired/); holdProof = null;
  assert.deepEqual(submitted, ['sponsor', 'wallet', 'wallet']);

  const finalSession = await connect();
  sponsorRc = '0';
  const fallback = await ask(finalSession, [native]);
  assert.equal(fallback.funding.payer, 'wallet', 'No sponsor capacity selects own mana before signing');
  await api.dappReject({ ...finalSession, requestId: fallback.id }, null, null, req(wallet));
  walletRc = '0';
  await assert.rejects(ask(finalSession, [stranger]), /available mana/);
  sponsorRc = walletRc = '1000000000000';
  context.dappBudget = policy.createBudget({ accountMana: 20 });
  const budgetRace = await ask(finalSession, [native]);
  context.dappBudget.spend(address, site, '2000000000');
  await assert.rejects(approve(finalSession, budgetRace), /daily sponsorship/);
  assert.equal(budgetRace.status, 'failed');
  assert.equal(submitted.length, 3, 'An exhausted budget never reaches sponsor signing');
  const spentFallback = await ask(finalSession, [native]);
  assert.equal(spentFallback.funding.payer, 'wallet');
  await api.dappReject({ ...finalSession, requestId: spentFallback.id }, null, null, req(wallet));
  context.dappBudget = policy.createBudget();

  const inFlight = await ask(finalSession, [native]);
  holdSubmit = new Promise(resolve => { finish = resolve; });
  const broadcasting = approve(finalSession, inFlight);
  while (submitted.length < 4) await new Promise(resolve => setTimeout(resolve, 1));
  await api.dappDisconnect(finalSession, null, null, req(wallet));
  const reconnected = await connect();
  await assert.rejects(ask(reconnected, [native]), /pending/, 'Disconnect cannot release an in-flight account nonce');
  finish(); await broadcasting; holdSubmit = null;
  const afterSubmit = await ask(reconnected, [native]);
  assert.equal(afterSubmit.status, 'pending', 'Submission releases the account lock');
  console.log('✓ Open HTTPS connections: real passkey consent, isolated sessions, decoded reviews, acknowledgement, safe payer selection, persistent budgets, concurrent/revoked requests');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { relay._sessions.clear(); fs.rmSync(temp, { recursive: true, force: true }); });
