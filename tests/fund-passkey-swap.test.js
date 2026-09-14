'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Contract, Signer, Transaction, utils } = require('koilib');
const chain = require('../tools/chain');
const koindx = require('../tools/eth/koindx');
const funding = require('../tools/funding');
const { BRIDGE } = require('../tools/eth/bridge-constants');
const accountAbi = require('../contracts/vendor/account/account-abi.json');
const tokenAbi = require('../abi/token-abi.json');
const routerAbi = require('../tools/eth/abi/koindx-periphery-abi.json');

const account = Signer.fromSeed('fund-passkey-account').getAddress();
const sponsorKey = Signer.fromSeed('fund-passkey-sponsor');
const sponsor = sponsorKey.getAddress();
const amountIn = '341958', amountOut = '58757780000', minimum = '58170202200';
const b64 = bytes => utils.encodeBase64url(bytes);
async function decode(abi, method, op) {
  return new Contract({ id: account, abi }).serializer.deserialize(
    utils.decodeBase64url(op.call_contract.args), abi.methods[method].argument);
}

(async () => {
  chain.configure({ network: 'mainnet', rpcs: ['http://unused.invalid'], sponsorWif: sponsorKey.getPrivateKey('wif') });
  const ops = await koindx.opsKoindxSwap({ account, amountInSats: amountIn, amountOutMin: minimum });
  assert.equal(ops.length, 2);
  const inner = [];
  for (const op of ops) {
    assert.equal(op.call_contract.contract_id, account, 'the account must be the caller of both contracts');
    assert.equal(op.call_contract.entry_point, accountAbi.methods.execute_user.entry_point);
    inner.push({ call_contract: (await decode(accountAbi, 'execute_user', op)).operation });
  }
  assert.equal(inner[0].call_contract.contract_id, BRIDGE.mainnet.veth);
  assert.equal(inner[0].call_contract.entry_point, tokenAbi.methods.approve.entry_point);
  assert.deepEqual(await decode(tokenAbi, 'approve', inner[0]), {
    owner: account, spender: koindx.KOINDX.mainnet.router, value: amountIn,
  });
  assert.equal(inner[1].call_contract.contract_id, koindx.KOINDX.mainnet.router);
  assert.equal(inner[1].call_contract.entry_point, routerAbi.methods.swap_tokens_in.entry_point);
  assert.deepEqual(await decode(routerAbi, 'swap_tokens_in', inner[1]), {
    from: account, receiver: account, amountIn, amountOutMin: minimum, path: [BRIDGE.mainnet.veth, 'koin'],
  });
  await assert.rejects(chain.opExecuteUser(account, { upload_contract: {} }), /contract call/);
  await assert.rejects(koindx.opsKoindxSwap({ account, amountInSats: '0', amountOutMin: minimum }), /greater than 0/);
  await assert.rejects(koindx.opsKoindxSwap({ account, amountInSats: amountIn, amountOutMin: '0' }), /slippage floor/);

  // VortexBridge/assembly/Token.ts check_authority: without a caller it
  // recovers EVERY signature before checking the owner. A WebAuthn blob
  // cannot take that branch. With owner == caller, it returns beforehand.
  const txForRecovery = await Transaction.prepareTransaction({ header: {
    chain_id: b64(Buffer.from('1220' + 'ab'.repeat(32), 'hex')), nonce: 'CAE=', payer: sponsor, payee: account, rc_limit: koindx.DEFAULT_SWAP_RC,
  }, operations: ops });
  await sponsorKey.signTransaction(txForRecovery);
  const signatures = [...txForRecovery.signatures, b64(Buffer.concat([Buffer.from([255, 2]), Buffer.alloc(325)]))];
  const digest = Buffer.from(txForRecovery.id.slice(6), 'hex');
  assert.equal(Signer.recoverAddress(digest, utils.decodeBase64url(signatures[0])), sponsor);
  function legacyApproval(caller) {
    if (caller) return caller === account;
    const signers = signatures.map(sig => Signer.recoverAddress(digest, utils.decodeBase64url(sig)));
    return signers.includes(account);
  }
  assert.throws(() => legacyApproval(null), 'the old direct approval cannot recover a passkey signature');
  assert.equal(legacyApproval(ops[0].call_contract.contract_id), true);
  assert.equal(legacyApproval(sponsor), false, 'sponsorship alone must not authorize the token approval');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-fund-passkey-'));
  const originalQuote = koindx.quoteSwap;
  try {
    fs.writeFileSync(path.join(dir, 'funding.json'), JSON.stringify({ transit: {}, jobs: {
      [account]: { status: 'awaiting_swap', route: 'B', asset: 'eth', vethSats: amountIn,
        estKoinOut: amountOut, redeemId: 'existing-bridge-redeem',
        feePlan: { version: 2, koinOutMin: minimum } },
    } }));
    funding.configure({ dataDir: dir, demo: false, network: 'mainnet' });
    let quoteOut = amountOut;
    koindx.quoteSwap = async () => ({ amountOut: quoteOut, amountOutMin: '1' });
    const tap = await funding.prepareTapOps(account);
    assert.deepEqual(tap.ops, ops, 'existing jobs must get the new calls with their original approved minimum');
    quoteOut = '1';
    await assert.rejects(funding.prepareTapOps(account), /below your approved minimum/);
    assert.equal(funding.job(account).status, 'awaiting_swap');
    quoteOut = amountOut;

    let availableMana = 19, threshold = 1, submitted = 0, rejectSubmit = true;
    const prepared = new Map();
    const ctx = vm.createContext({ api: {}, DEMO: false, CFG: { minSponsorMana: 5 },
      PREPARED: prepared, structuredClone, fundAccount: () => account,
      veive: { ensureReady: async () => {}, credentialsFor: () => ['passkey'] }, funding,
      httpError: (status, message) => Object.assign(new Error(message), { status }),
      rememberPrepared: (txId, address, extra) => {
        const ref = String(prepared.size + 1);
        prepared.set(ref, { txId, address, expires: Date.now() + 60000, ...extra });
        return ref;
      }, explorerTx: id => 'https://example.com/' + id,
      chain: { K: chain.K, sponsorAddress: () => sponsor, mana: async () => availableMana,
        withRpcRetry: fn => fn(), humanChainError: e => e.message,
        validationThreshold: async () => ({ value: threshold }),
        ensureManaFor: async () => ({ toppedUp: false }),
        prepareUserTx: async (address, operations, { rcLimit }) => Transaction.prepareTransaction({
          header: { chain_id: b64(Buffer.from('1220' + 'ab'.repeat(32), 'hex')), nonce: 'CAE=', payer: sponsor, payee: address, rc_limit: rcLimit }, operations,
        }),
        prepareSelfPaidTx: async (address, operations, { rcLimit }) => Transaction.prepareTransaction({
          header: { chain_id: b64(Buffer.from('1220' + 'ab'.repeat(32), 'hex')), nonce: 'CAE=', payer: address, rc_limit: rcLimit }, operations,
        }),
        submitSmartCosigned: async tx => {
          submitted++;
          if (rejectSubmit) throw new Error('RPC rejected the transaction');
          return tx.id;
        },
      },
    });
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    vm.runInContext(source.slice(source.indexOf('api.fundPrepareStep ='), source.indexOf('/* Plain liveness,')), ctx);
    vm.runInContext(source.slice(source.indexOf('api.submit ='), source.indexOf('/** Demo-mode teeth:')), ctx);
    await assert.rejects(ctx.api.fundPrepareStep({}), /mana needed for this step/);
    assert.equal(prepared.size, 0, 'check the entire ceiling before asking for a passkey');
    availableMana = 20;
    const prep = await ctx.api.fundPrepareStep({});
    const signed = { ...prep.tx, signatures: ['test-passkey'] };
    await assert.rejects(ctx.api.submit({ ref: prep.ref, transaction: signed }), /RPC rejected/);
    assert.equal(funding.job(account).status, 'awaiting_swap', 'failure must keep the existing swap resumable');
    assert.equal(funding.job(account).redeemId, 'existing-bridge-redeem', 'never restart the ETH bridge');

    const tamper = await ctx.api.fundPrepareStep({});
    tamper.tx.operations[0].call_contract.contract_id = sponsor;
    await assert.rejects(ctx.api.submit({ ref: tamper.ref, transaction: tamper.tx }), /changed after preparation/);
    assert.equal(submitted, 1, 'altered nested calls must never reach the sponsor');
    const alteredHeader = await ctx.api.fundPrepareStep({});
    alteredHeader.tx.header.rc_limit = '1';
    await assert.rejects(ctx.api.submit({ ref: alteredHeader.ref, transaction: alteredHeader.tx }), /changed after preparation/);
    assert.equal(submitted, 1);

    threshold = 0;
    const selfPaid = await ctx.api.fundPrepareStep({});
    assert.equal(selfPaid.selfPaid, true);
    assert.equal(selfPaid.tx.header.payer, account);
    assert.deepEqual(selfPaid.tx.operations, ops, 'legacy self-paid accounts also use the wrapped calls');
    threshold = 1;
    rejectSubmit = false;
    const retry = await ctx.api.fundPrepareStep({});
    const result = await ctx.api.submit({ ref: retry.ref, transaction: { ...retry.tx, signatures: ['test-passkey'] } });
    assert.equal(funding.job(account).status, 'done');
    assert.equal(funding.job(account).swapId, result.txid);
    assert.equal(funding.job(account).redeemId, 'existing-bridge-redeem');
    assert.equal(submitted, 2);
    console.log('fund passkey swap: wrapped calls, exact amounts, slippage, mana, tamper rejection and existing-job retry passed');
  } finally {
    koindx.quoteSwap = originalQuote;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
