'use strict';
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { quote, amountWei } = require('../tools/eth/withdrawal');
const from = new ethers.Wallet('0x' + '11'.repeat(32)).address;
const to = new ethers.Wallet('0x' + '22'.repeat(32)).address;
const one = ethers.parseEther('1');
const provider = {
  getNetwork: async () => ({ chainId: 1n }), getBalance: async () => one,
  getFeeData: async () => ({ gasPrice: 1000000000n }), getCode: async () => '0x',
  getTransactionCount: async () => 7, estimateGas: async () => 21000n,
};
(async () => {
  const q = await quote({ provider, from, to, max: true });
  const gas = 21000n * 1200000000n;
  assert.equal(ethers.parseEther(q.amountEth), one - gas);
  assert.equal(ethers.parseEther(q.totalEth), one);
  assert.equal(q.request.type, 0); assert.equal(q.request.nonce, 7); assert.equal(q.mayLeaveDust, false);
  const manual = await quote({ provider, from, to, amount: '0.5' });
  assert.equal(manual.amountEth, '0.5'); assert.equal(ethers.parseEther(manual.totalEth), one / 2n + gas);
  for (const value of ['0', '-1', '1e-3', 'NaN', 'Infinity', '0.1234567890123456789', '.2']) assert.throws(() => amountWei(value));
  for (const address of ['garbage', ethers.ZeroAddress, from]) await assert.rejects(quote({ provider, from, to: address, max: true }));
  await assert.rejects(quote({ provider, from, to, amount: '1' }), /gas/);
  await assert.rejects(quote({ provider: { ...provider, getBalance: async () => gas }, from, to, max: true }), /gas/);
  await assert.rejects(quote({ provider: { ...provider, getNetwork: async () => ({ chainId: 11155111n }) }, from, to, max: true }), /mainnet/);
  await assert.rejects(quote({ provider: { ...provider, getFeeData: async () => ({ gasPrice: 0n }) }, from, to, max: true }), /gas price/);
  await assert.rejects(quote({ provider: { ...provider, getTransactionCount: async (_, tag) => tag === 'pending' ? 8 : 7 }, from, to, max: true }), /pending/);
  const contract = await quote({ provider: { ...provider, getCode: async () => '0x1234', estimateGas: async () => 50000n }, from, to, max: true });
  assert.equal(contract.request.gasLimit, '60000'); assert.equal(contract.mayLeaveDust, true);
  const reduced = await quote({ provider: { ...provider, getBalance: async (_, tag) => tag === 'pending' ? one / 2n : one }, from, to, max: true });
  assert.equal(ethers.parseEther(reduced.totalEth), one / 2n);
  await assert.rejects(quote({ provider: { ...provider, estimateGas: async () => { throw new Error('recipient reverts'); } }, from, to, max: true }), /reverts/);
  console.log('ETH withdrawals: exact Max, precision, gas reserve, pending nonce, mainnet, contracts and recipient validation passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
