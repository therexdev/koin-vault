'use strict';
const assert = require('node:assert/strict');
const { Contract, Signer, utils } = require('koilib');
const { reviewProducer, CONTRACTS } = require('../tools/dapp-producer');
const relay = require('../tools/dapp-relay');
const cleanAbi = input => { const a = JSON.parse(JSON.stringify(input)); const n = a.koilib_types?.nested?.koinos?.nested; if (n) { delete n.btype; delete n._btype; } return a; };
const pob = new Contract({ id: CONTRACTS.pob, abi: cleanAbi(require('../abi/pob-abi.json')) });
const koin = new Contract({ id: CONTRACTS.koin, abi: cleanAbi(require('../abi/token-abi.json')) });
const vhp = new Contract({ id: CONTRACTS.vhp, abi: cleanAbi(require('../abi/token-abi.json')) });
const address = Signer.fromSeed('test producer wallet').getAddress(), to = Signer.fromSeed('recipient').getAddress();
const key = utils.encodeBase64url(Signer.fromSeed('test node hot key').publicKey);
const op = async (c, name, args) => (await c.functions[name](args, { onlyOperation: true })).operation;
(async () => {
  const register = await op(pob, 'register_public_key', { producer: address, public_key: key });
  const summary = await reviewProducer(relay.validateOperations([register]), address, 'mainnet');
  assert.ok(summary.detail.includes(address) && summary.detail.includes(key));
  assert.ok(summary.detail.length <= 300, 'complete public key fits wallet review');
  await assert.rejects(reviewProducer([register], to, 'mainnet'), /connected/);
  await assert.rejects(reviewProducer([register], address, 'harbinger'), /Mainnet/);
  const approve = await op(koin, 'approve', { owner: address, spender: CONTRACTS.pob, value: '100000000' });
  const burn = await op(pob, 'burn', { burn_address: address, vhp_address: address, token_amount: '100000000' });
  assert.match((await reviewProducer([approve, burn], address, 'mainnet')).detail, /1.00000000 KOIN/);
  const excess = await op(koin, 'approve', { owner: address, spender: CONTRACTS.pob, value: '200000000' });
  await assert.rejects(reviewProducer([excess, burn], address, 'mainnet'), /exactly/);
  const diverted = await op(pob, 'burn', { burn_address: address, vhp_address: to, token_amount: '100000000' });
  await assert.rejects(reviewProducer([diverted], address, 'mainnet'), /destination/);
  for (const c of [koin, vhp]) {
    const transfer = await op(c, 'transfer', { from: address, to, value: '123456789' });
    const s = await reviewProducer([transfer], address, 'mainnet');
    assert.ok(s.detail.includes('1.23456789') && s.detail.includes(to));
    await assert.rejects(reviewProducer([transfer], to, 'mainnet'), /connected/);
    await assert.rejects(reviewProducer([approve, transfer], address, 'mainnet'), /combination/);
  }
  await assert.rejects(reviewProducer([approve], address, 'mainnet'), /combination/);
  const extra = structuredClone(register); extra.call_contract.unexpected = 'field';
  await assert.rejects(reviewProducer([extra], address, 'mainnet'), /Noncanonical/);
  for (const value of ['100000000', '0']) {
    const allowance = await op(vhp, 'approve', { owner: address, spender: CONTRACTS.pob, value });
    const reviewed = await reviewProducer([allowance], address, 'mainnet');
    assert.match(reviewed.title, value === '0' ? /Revoke/ : /Allow VHP/);
    assert.ok(reviewed.detail.includes(CONTRACTS.pob));
    assert.match(reviewed.detail, /Hot key gains no transfer authority/);
    await assert.rejects(reviewProducer([allowance], to, 'mainnet'), /connected wallet/);
    await assert.rejects(reviewProducer([allowance, register], address, 'mainnet'), /combination/);
  }
  const wrongSpender = await op(vhp, 'approve', { owner: address, spender: to, value: '100000000' });
  await assert.rejects(reviewProducer([wrongSpender], address, 'mainnet'), /official PoB/);
  const unlimited = await op(vhp, 'approve', { owner: address, spender: CONTRACTS.pob, value: '18446744073709551615' });
  await assert.rejects(reviewProducer([unlimited], address, 'mainnet'), /limited/);
  const full = await op(vhp, 'approve', { owner: address, spender: CONTRACTS.pob, value: '1100000000' });
  const combined = await reviewProducer([approve, burn, full], address, 'mainnet');
  assert.match(combined.detail, /11.00000000 VHP/);
  assert.match(combined.detail, /Both changes succeed together/);
  await assert.rejects(reviewProducer([approve, burn, wrongSpender], address, 'mainnet'), /combination/);
  await assert.rejects(reviewProducer([approve, burn, unlimited], address, 'mainnet'), /amount/);
  await assert.rejects(reviewProducer([full, approve, burn], address, 'mainnet'), /combination/);
  await assert.rejects(reviewProducer([excess, burn, full], address, 'mainnet'), /exactly/);
  console.log('✓ KAI producer approvals decode exact amounts, accounts and hot keys and reject unrelated or excessive authority');
})().catch(e => { console.error(e); process.exitCode = 1; });
