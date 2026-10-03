'use strict';
// Reverse the same Vortex/KoinDX (B) and Vortex/Uniswap (C) buy routes.
// ABI references: VortexBridge/koinos-bridge-{contract,ethereum},
// Uniswap/v4-periphery IV4Quoter and swap-router-contracts IV3SwapRouter.
const { ethers } = require('ethers');
const { Contract } = require('koilib');
const chain = require('../chain');
const { BRIDGE } = require('./bridge-constants');
const RC = require('./route-constants');
const koindx = require('./koindx');
const swap = require('./eth-swap-exec');
const { computeQuorum } = require('./bridge');
const bridgeAbi = require('./abi/koinos-bridge-abi.json');
const tokenAbi = require('../../abi/token-abi.json');
const quotes = require('./eth-swap');
const cfg = BRIDGE.mainnet;
const ETH_BRIDGE_ABI = [
  'function completeTransfer(bytes,uint256,address,address,address,uint256,uint256,bytes[],string,uint256)',
  'function getValidatorsLength() view returns (uint256)',
  'function paused() view returns (bool)',
  'function chainId() view returns (uint32)',
];
const V3_ABI = [
  ...swap.SWAP_ROUTER_ABI,
  'function unwrapWETH9(uint256,address) payable',
  'function multicall(uint256,bytes[]) payable returns (bytes[])',
];
const uint = (v) => { if (!/^\d+$/.test(String(v))) throw new Error('Invalid bridge amount'); return BigInt(v); };
const bridge = () => new Contract({ id: cfg.koinosBridge, abi: bridgeAbi, provider: chain.provider() });
const ethBridge = p => new ethers.Contract(cfg.ethBridge, ETH_BRIDGE_ABI, p);

async function bridgeFee(route) {
  const b = bridge();
  const meta = (await b.functions.get_metadata({})).result;
  if (!meta || Number(meta.chainId) !== 1 || meta.paused) throw new Error('Koinos Vortex bridge is unavailable');
  const fn = route === 'B' ? b.functions.get_fee_wrapped_token : b.functions.get_fee_token;
  const { result } = await fn({ token: route === 'B' ? cfg.veth : cfg.koin });
  // No fee record represents zero in the bridge's storage implementation.
  return uint(result?.value || '0');
}
async function quoteUsdtEth(provider, amount) {
  const q = new ethers.Contract(RC.V3_QUOTER, quotes.V3_QUOTER_ABI, provider);
  const outcomes = await Promise.allSettled(RC.ETH_USDT_FEES.map(async fee => {
    const r = await q.quoteExactInputSingle.staticCall({ tokenIn: RC.USDT, tokenOut: RC.WETH,
      amountIn: amount, fee, sqrtPriceLimitX96: 0 });
    return { amount: BigInt(r[0]), fee };
  }));
  const valid = outcomes.filter(r => r.status === 'fulfilled' && r.value.amount > 0n).map(r => r.value);
  valid.sort((a, b) => a.amount > b.amount ? -1 : 1);
  if (!valid.length) throw new Error('No USDT to ETH liquidity');
  return valid[0];
}
async function quoteVkoinUsdt(provider, amount) {
  const q = new ethers.Contract(RC.V4_QUOTER, quotes.V4_QUOTER_ABI, provider);
  const { currency0, currency1, fee, tickSpacing, hooks } = RC.VKOIN_USDT_POOL;
  const r = await q.quoteExactInputSingle.staticCall({ poolKey: { currency0, currency1, fee, tickSpacing, hooks },
    zeroForOne: true, exactAmount: amount, hookData: '0x' });
  if (BigInt(r[0]) <= 0n) throw new Error('No vKOIN to USDT liquidity');
  return BigInt(r[0]);
}
async function quote(route, amount, slippageBps, provider) {
  if (!['B', 'C'].includes(route)) throw new Error('Only KOIN to ETH routes B and C are supported');
  const eth = ethBridge(provider);
  if (await eth.paused() || Number(await eth.chainId()) !== 2) throw new Error('Ethereum Vortex bridge is unavailable');
  const fee = await bridgeFee(route);
  if (route === 'B') {
    const q = await koindx.quoteSwap({ amountInSats: amount.toString(), slippageBps, provider: chain.provider(), reverse: true });
    if (BigInt(q.amountOutMin) <= fee) throw new Error('KoinDX output is below the Vortex bridge fee');
    return { route, bridgeFee: fee.toString(), swapMin: q.amountOutMin,
      grossWei: ((BigInt(q.amountOut) - fee) * 10000000000n).toString(),
      minWei: ((BigInt(q.amountOutMin) - fee) * 10000000000n).toString(),
      gasUnits: '400000', label: 'KOIN → vETH → ETH', via: 'KoinDX · Vortex' };
  }
  if (amount <= fee) throw new Error('Amount is below the Vortex bridge fee');
  const vkoin = amount - fee;
  const usdt = await quoteVkoinUsdt(provider, vkoin);
  const usdtMin = koindx.applySlippage(usdt, slippageBps);
  const out = await quoteUsdtEth(provider, usdt);
  const floor = await quoteUsdtEth(provider, usdtMin);
  return { route, bridgeFee: fee.toString(), bridgeAmount: vkoin.toString(), usdtMin: usdtMin.toString(),
    grossWei: out.amount.toString(), minWei: koindx.applySlippage(floor.amount, slippageBps).toString(),
    gasUnits: '1200000', label: 'KOIN → vKOIN → USDT → ETH', via: 'Vortex · Uniswap' };
}

async function bridgeOps(account, token, amount, recipient, metadata) {
  const b = bridge();
  const tokenContract = new Contract({ id: token, abi: tokenAbi, provider: chain.provider() });
  const { operation: approve } = await tokenContract.functions.approve({ owner: account, spender: cfg.koinosBridge, value: amount }, { onlyOperation: true });
  const { operation: transfer } = await b.functions.transfer_tokens({ from: account, token, amount, payment: '0',
    relayer: ethers.ZeroAddress, recipient, metadata, toChain: 2 }, { onlyOperation: true });
  return [await chain.opExecuteUser(account, approve), await chain.opExecuteUser(account, transfer)];
}
async function refreshOps(txId, opId) {
  const { operation } = await bridge().functions.request_new_signatures({ transactionId: txId, operationId: opId }, { onlyOperation: true });
  return [operation];
}

async function koinReceipt(txId) {
  const p = chain.provider();
  const { transactions } = await p.getTransactionsById([txId]);
  const ids = transactions?.[0]?.containing_blocks;
  if (!ids?.length) return null;
  const head = await p.getHeadInfo();
  const { block_items: items } = await p.getBlocksById(ids);
  for (const item of items || []) {
    const height = item.block?.header?.height || item.receipt?.height;
    if (!height) continue;
    const canonical = await p.getBlock(Number(height), { returnBlock: false, returnReceipt: false });
    if (canonical?.block_id !== item.block_id) continue;
    if (BigInt(height) > BigInt(head.last_irreversible_block)) return { pendingFinality: true };
    const receipt = item.receipt?.transaction_receipts?.find(r => r.id === txId);
    if (receipt) return receipt;
  }
  return null;
}
async function vethReceived(receipt, account) {
  const token = new Contract({ id: cfg.veth, abi: tokenAbi });
  let net = 0n;
  for (const e of receipt.events || []) {
    if (e.source !== cfg.veth || !/token\.transfer_event$/.test(e.name)) continue;
    const data = await token.serializer.deserialize(e.data, 'token.transfer_event');
    if (data.to === account) net += uint(data.value);
    if (data.from === account) net -= uint(data.value);
  }
  if (net <= 0n) throw new Error('The confirmed swap has no vETH delivery event');
  return net.toString();
}
async function lockedTransfer(receipt, job, account) {
  for (const event of receipt.events || []) {
    if (event.source !== cfg.koinosBridge || event.name !== 'bridge.tokens_locked_event') continue;
    const data = await bridge().serializer.deserialize(event.data, 'bridge.tokens_locked_event');
    const token = job.route === 'B' ? cfg.veth : cfg.koin;
    if (data.from !== account || data.token !== token || data.recipient.toLowerCase() !== job.from.toLowerCase()
      || data.metadata !== job.id || Number(data.chainId) !== 2 || uint(data.payment || '0') !== 0n) continue;
    return { opId: String(event.sequence), amount: uint(data.amount).toString() };
  }
  throw new Error('The confirmed bridge transaction has no matching transfer event');
}
async function record(job, provider) {
  const url = new URL(cfg.proxyUrl + '/GetKoinosTransaction');
  url.searchParams.set('TransactionId', job.bridgeTx); url.searchParams.set('OpId', job.opId);
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Vortex signatures are temporarily unavailable');
  const r = await response.json();
  const token = job.route === 'B' ? RC.WETH : RC.VKOIN;
  if (r.id !== job.bridgeTx || String(r.opId) !== job.opId || String(r.ethToken).toLowerCase() !== token.toLowerCase()
    || String(r.recipient).toLowerCase() !== job.from.toLowerCase() || r.metadata !== job.id
    || uint(r.amount) !== uint(job.bridgeAmount) || uint(r.payment || '0') !== 0n
    || (r.relayer && r.relayer.toLowerCase() !== ethers.ZeroAddress)) throw new Error('Vortex record does not match the approved transfer');
  const validators = Number(await ethBridge(provider).getValidatorsLength());
  if (!Number.isSafeInteger(Number(r.expiration)) || Number(r.expiration) <= Date.now() + 60000) return { expired: true };
  if (!Array.isArray(r.signatures) || new Set(r.signatures).size < computeQuorum(validators)) return null;
  return r;
}
function redeemTx(r) {
  return { to: cfg.ethBridge, value: 0n, data: new ethers.Interface(ETH_BRIDGE_ABI).encodeFunctionData('completeTransfer',
    [r.id, r.opId, r.ethToken, r.relayer || ethers.ZeroAddress, r.recipient, r.amount, r.payment || '0', r.signatures, r.metadata, r.expiration]) };
}
function vkoinUsdtTx(amount, minimum, deadline) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const k = RC.VKOIN_USDT_POOL;
  const params = coder.encode(['tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,bytes)'],
    [[[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks], true, amount, minimum, '0x']]);
  const input = coder.encode(['bytes', 'bytes[]'], ['0x060c0f', [params,
    coder.encode(['address', 'uint256'], [RC.VKOIN, amount]), coder.encode(['address', 'uint256'], [RC.USDT, minimum])]]);
  return { to: RC.UNIVERSAL_ROUTER, value: 0n,
    data: new ethers.Interface(swap.UR_ABI).encodeFunctionData('execute', ['0x10', [input], deadline]) };
}
function usdtEthTx(amount, minimum, fee, recipient, deadline) {
  const iface = new ethers.Interface(V3_ABI);
  return { to: RC.V3_SWAP_ROUTER, value: 0n, data: iface.encodeFunctionData('multicall', [deadline, [
    iface.encodeFunctionData('exactInputSingle', [{ tokenIn: RC.USDT, tokenOut: RC.WETH, fee,
      recipient: RC.V3_SWAP_ROUTER, amountIn: amount, amountOutMinimum: minimum, sqrtPriceLimitX96: 0 }]),
    iface.encodeFunctionData('unwrapWETH9', [minimum, recipient]),
  ]]) };
}
module.exports = { quote, bridgeFee, bridgeOps, refreshOps, koinReceipt, vethReceived, lockedTransfer,
  record, redeemTx, vkoinUsdtTx, usdtEthTx, quoteUsdtEth, quoteVkoinUsdt, ETH_BRIDGE_ABI, V3_ABI };
