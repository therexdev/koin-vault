'use strict';
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const RC = require('../tools/eth/route-constants');
const swap = require('../tools/eth/eth-swap-exec');
const quotes = require('../tools/eth/eth-swap');
const { harness, A } = require('./fixtures/funding-v2-harness');
const coder = ethers.AbiCoder.defaultAbiCoder();
const k = RC.VKOIN_USDC_POOL;
assert.equal(ethers.keccak256(coder.encode(['address','address','uint24','int24','address'],
  [k.currency0,k.currency1,k.fee,k.tickSpacing,k.hooks])), k.id);
const ethTx = swap.buildEthToUsdtTx({recipient:RC.VKOIN,amountWei:1000n,fee:500,minUsdtOut:1n,stableAsset:'usdc'});
const v3 = new ethers.Interface(['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns(uint256)']);
assert.equal(v3.decodeFunctionData('exactInputSingle',ethTx.data)[0][1], RC.USDC);
const tx = swap.buildUsdtToVkoinTx({usdtAmount:1000000n,minVkoinOut:1000n,deadline:2000000000,stableAsset:'usdc'});
const ur = new ethers.Interface(['function execute(bytes,bytes[],uint256) payable']);
const [commands,inputs] = ur.decodeFunctionData('execute',tx.data);
assert.equal(commands,'0x10');
const [actions,params] = coder.decode(['bytes','bytes[]'],inputs[0]);
assert.equal(actions,'0x060c0f');
const [single] = coder.decode(['tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,bytes)'],params[0]);
assert.equal(single[0][0],RC.USDC); assert.equal(single[0][1],RC.VKOIN); assert.equal(single[1],true);
assert.equal(single[2],1000000n); assert.equal(single[3],1000n);
assert.equal(coder.decode(['address','uint256'],params[1])[0],RC.USDC);
assert.equal(coder.decode(['address','uint256'],params[2])[0],RC.VKOIN);
assert.throws(()=>swap.buildUsdtToVkoinTx({usdtAmount:1,minVkoinOut:1,deadline:1,stableAsset:'invalid'}),/Unsupported/);
(async()=>{
  for (const [asset,own,input] of [['eth','0.04','0.02'],['usdc','0','100']]) {
    const h=harness({own}); await h.start(asset,'D',input); await h.run();
    assert.equal(h.jobs[h.account].feePlan.stableAsset,'usdc');
    assert.equal(h.sends.filter(s=>s.state==='swap_usdt_vkoin').length,1);
    assert.equal(h.sends.filter(s=>s.state==='bridge_token').length,1);
    assert.equal(h.sends.filter(s=>s.state==='swap_usdc_usdt').length,0);
    assert.equal(A.costs(h.jobs[h.account]).debt,0n);
    if(asset==='usdc') assert.ok(h.sends.some(s=>s.state==='front_gas'));
  }
  const h=harness({own:'0.04'}), original=quotes.quoteEthToVkoin;
  quotes.quoteEthToVkoin=async args=>{
    if(args.stableAsset==='usdc') throw new Error('No USDC pool liquidity');
    return original(args);
  };
  let q=await h.engine.quote(h.account,'eth',ethers.parseEther('0.02'));
  assert.equal(q.routes.find(r=>r.id==='D').quoteId,undefined);
  assert.notEqual(q.best.id,'D');
  quotes.quoteEthToVkoin=async args=>{
    const result=await original(args);
    return args.stableAsset==='usdc' ? {...result,koinOut:String(BigInt(result.koinOut)*2n),koinOutMin:String(BigInt(result.koinOutMin)*2n)} : result;
  };
  try {
    q=await h.engine.quote(h.account,'eth',ethers.parseEther('0.02'));
    assert.equal(q.best.id,'D');
    await assert.rejects(h.engine.start(h.account,{asset:'eth',amount:ethers.parseEther('0.02'),route:'C',quoteId:q.best.quoteId},{}),/does not match/);
    assert.equal(h.sends.length,0);
  } finally {quotes.quoteEthToVkoin=original;}
  console.log('✓ direct USDC pool key, swap direction, calldata, approvals, gas recovery, bridge, net ranking and route binding');
})().catch(e=>{console.error(e);process.exit(1)});
