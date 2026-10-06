'use strict';
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { Contract, Signer } = require('koilib');
const chain = require('../tools/chain');
const routes = require('../tools/eth/sell-routes');
const koindx = require('../tools/eth/koindx');
const swap = require('../tools/eth/eth-swap-exec');
const { BRIDGE } = require('../tools/eth/bridge-constants');
const RC = require('../tools/eth/route-constants');
const accountAbi = require('../contracts/vendor/account/account-abi.json');
const tokenAbi = require('../abi/token-abi.json');
const routerAbi = require('../tools/eth/abi/koindx-periphery-abi.json');
const bridgeAbi = require('../tools/eth/abi/koinos-bridge-abi.json');
const account = Signer.fromSeed('sell-routes-account').getAddress();
const ethAddress = new ethers.Wallet('0x' + '11'.repeat(32)).address;
const decoder = abi => new Contract({ id: account, abi }).serializer;
const decode = (abi, method, operation) => decoder(abi).deserialize(operation.call_contract.args, abi.methods[method].argument);
async function unwrap(operation) { return { call_contract: (await decode(accountAbi, 'execute_user', operation)).operation }; }
const event = async (abi, source, name, data, sequence = 9) => ({ source, name, sequence, data: Buffer.from(await decoder(abi).serialize(data, name)).toString('base64url') });
(async () => {
  chain.configure({ network: 'mainnet', rpcs: ['https://unused.invalid'] });
  const ops = await koindx.opsKoindxSwap({ account, amountInSats: '10000000000', amountOutMin: '64371', reverse: true });
  const [approval, trade] = await Promise.all(ops.map(unwrap));
  assert.equal(approval.call_contract.contract_id, BRIDGE.mainnet.koin);
  assert.equal((await decode(tokenAbi, 'approve', approval)).value, '10000000000');
  const args = await decode(routerAbi, 'swap_tokens_in', trade);
  assert.deepEqual(args.path, ['koin', BRIDGE.mainnet.veth]); assert.equal(args.amountOutMin, '64371');
  const bops = await routes.bridgeOps(account, BRIDGE.mainnet.veth, '64371', ethAddress, 'job-id');
  const [ba, bt] = await Promise.all(bops.map(unwrap));
  assert.equal((await decode(tokenAbi, 'approve', ba)).spender, BRIDGE.mainnet.koinosBridge);
  assert.deepEqual(await decode(bridgeAbi, 'transfer_tokens', bt), {
    from: account, token: BRIDGE.mainnet.veth, amount: '64371', payment: '0',
    relayer: ethers.ZeroAddress, recipient: ethAddress, metadata: 'job-id', toChain: 2,
  });
  const txid = '0x1220' + 'ab'.repeat(32);
  const r = { id: txid, opId: '9', ethToken: RC.WETH, recipient: ethAddress, amount: '64371',
    signatures: ['0x' + '11'.repeat(65), '0x' + '22'.repeat(65)], metadata: 'job-id', expiration: Date.now() + 3600000 };
  const redeem = routes.redeemTx(r);
  const ra = new ethers.Interface(routes.ETH_BRIDGE_ABI).decodeFunctionData('completeTransfer', redeem.data);
  assert.equal(redeem.to, BRIDGE.mainnet.ethBridge); assert.equal(ra[0], txid); assert.equal(ra[1], 9n);
  assert.equal(ra[2], RC.WETH); assert.equal(ra[4], ethAddress); assert.equal(ra[5], 64371n);
  const ur = new ethers.Interface(swap.UR_ABI).decodeFunctionData('execute', routes.vkoinUsdtTx('100000000', '1000000', 2000000000).data);
  assert.equal(ur[0], '0x10');
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const [actions, inputs] = coder.decode(['bytes', 'bytes[]'], ur[1][0]);
  assert.equal(actions, '0x060c0f');
  const [params] = coder.decode(['tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,bytes)'], inputs[0]);
  assert.equal(params[1], true); assert.equal(params[2], 100000000n); assert.equal(params[3], 1000000n);
  assert.equal(coder.decode(['address', 'uint256'], inputs[1])[0], RC.VKOIN);
  assert.equal(coder.decode(['address', 'uint256'], inputs[2])[0], RC.USDT);
  const v3 = new ethers.Interface(routes.V3_ABI);
  const multicall = v3.decodeFunctionData('multicall', routes.usdtEthTx('1000000', '10000000000000', 500, ethAddress, 2000000000).data);
  const sale = v3.decodeFunctionData('exactInputSingle', multicall[1][0])[0];
  const unwrapEth = v3.decodeFunctionData('unwrapWETH9', multicall[1][1]);
  assert.equal(sale.tokenIn, RC.USDT); assert.equal(sale.tokenOut, RC.WETH); assert.equal(sale.recipient, RC.V3_SWAP_ROUTER);
  assert.equal(unwrapEth[0], sale.amountOutMinimum); assert.equal(unwrapEth[1], ethAddress);
  const received = await event(tokenAbi, BRIDGE.mainnet.veth, 'token.transfer_event', { from: BRIDGE.mainnet.koinosBridge, to: account, value: '64371' });
  assert.equal(await routes.vethReceived({ events: [received] }, account), '64371');
  await assert.rejects(routes.vethReceived({ events: [{ ...received, source: BRIDGE.mainnet.koin }] }, account), /no vETH/);
  const locked = await event(bridgeAbi, BRIDGE.mainnet.koinosBridge, 'bridge.tokens_locked_event', {
    from: account, token: BRIDGE.mainnet.veth, amount: '64371', payment: '0', relayer: ethers.ZeroAddress,
    recipient: ethAddress, metadata: 'job-id', chainId: 2,
  });
  const job = { id: 'job-id', route: 'B', from: ethAddress, bridgeTx: txid, opId: '9', bridgeAmount: '64371' };
  assert.deepEqual(await routes.lockedTransfer({ events: [locked] }, job, account), { opId: '9', amount: '64371' });
  await assert.rejects(routes.lockedTransfer({ events: [locked] }, { ...job, id: 'other' }, account), /no matching/);
  const provider = { call: async () => coder.encode(['uint256'], [3]) };
  let record = r;
  global.fetch = async url => { assert.equal(new URL(url).searchParams.get('OpId'), '9'); return { ok: true, json: async () => record }; };
  assert.equal((await routes.record(job, provider)).amount, '64371');
  for (const fields of [{ recipient: ethers.ZeroAddress }, { ethToken: RC.VKOIN }, { opId: '8' }, { amount: '1' }, { payment: '1' }, { metadata: 'other' }, { relayer: ethAddress }]) {
    record = { ...r, ...fields }; await assert.rejects(routes.record(job, provider), /does not match/);
  }
  record = { ...r, signatures: [r.signatures[0]] }; assert.equal(await routes.record(job, provider), null);
  record = { ...r, signatures: [r.signatures[0], r.signatures[0]] }; assert.equal(await routes.record(job, provider), null);
  record = { ...r, expiration: Date.now() - 1 }; assert.deepEqual(await routes.record(job, provider), { expired: true });
  let lib = '99', canonical = 'block';
  chain.provider = () => ({ getTransactionsById: async () => ({ transactions: [{ containing_blocks: ['block'] }] }),
    getHeadInfo: async () => ({ last_irreversible_block: lib }),
    getBlocksById: async () => ({ block_items: [{ block_id: 'block', block: { header: { height: '100' } }, receipt: { transaction_receipts: [{ id: txid, reverted: false }] } }] }),
    getBlock: async () => ({ block_id: canonical }) });
  assert.deepEqual(await routes.koinReceipt(txid), { pendingFinality: true });
  lib = '100'; assert.equal((await routes.koinReceipt(txid)).id, txid);
  canonical = 'fork'; assert.equal(await routes.koinReceipt(txid), null);
  console.log('Sell route ABIs, wrapped smart-account calls, exact native ETH unwrap, event amounts, guardian binding/quorum and Koinos finality passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
