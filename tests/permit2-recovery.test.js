"use strict";
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { harness, A, RC, allowanceKey } = require("./fixtures/funding-v2-harness");
const swap = require("../tools/eth/eth-swap-exec");
const quotes = require("../tools/eth/eth-swap");
const ERROR_DATA = "0xd81b2f2e000000000000000000000000000000000000000000000000000000006ac09f93";
const permitKey = (h) => allowanceKey(h.wallets[h.account].address, RC.USDT, RC.UNIVERSAL_ROUTER);
const count = (h, state) => h.sends.filter(s => s.state === state).length;
const expire = (h) => h.permitAllowances.set(permitKey(h), {
  amount: BigInt(h.jobs[h.account].usdtSats), expiration: BigInt(Math.floor(Date.now() / 1000) - 1),
});
async function atSwap() {
  const h = harness({ own: "0.04" });
  await h.start("eth", "C", "0.02");
  await h.run(h.account, "swap_usdt_vkoin");
  return h;
}

(async () => {
  assert.equal(ethers.id("AllowanceExpired(uint256)").slice(0, 10), ERROR_DATA.slice(0, 10));
  assert.match(swap.describeRevert({ data: ERROR_DATA }), /AllowanceExpired.*approval expired/);
  const nested = ethers.id("ExecutionFailed(uint256,bytes)").slice(0, 10)
    + ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes"], [0, ERROR_DATA]).slice(2);
  assert.match(swap.describeRevert({ info: { error: { data: nested } } }), /AllowanceExpired.*approval expired/);
  console.log("✓ the reported direct and router-wrapped revert decode as expired Permit2 approval");

  for (const reason of ["expired", "expires before deadline", "amount too small"]) {
    const h = await atSwap(), j = h.jobs[h.account], plan = JSON.stringify(j.feePlan);
    const amount = BigInt(j.usdtSats), now = BigInt(Math.floor(Date.now() / 1000));
    h.permitAllowances.set(permitKey(h), {
      amount: reason === "amount too small" ? amount - 1n : amount,
      expiration: reason === "expired" ? now - 1n : reason === "expires before deadline" ? now + 300n : now + 3600n,
    });
    h.ctx.save(h.account, { ...j, status: "error", failedAt: "swap_usdt_vkoin", error: "old raw revert" });
    h.restart();
    await h.engine.resume(h.account);
    await h.engine.advance(h.account, h.jobs[h.account]);
    assert.equal(h.jobs[h.account].status, "approve_ur");
    assert.equal(count(h, "swap_usdt_vkoin"), 0, "no swap is sent with invalid approval");
    const done = await h.run();
    assert.equal(count(h, "approve_ur"), 2);
    assert.equal(count(h, "swap_eth_usdt"), 1, "the original ETH swap is never repeated");
    assert.equal(count(h, "swap_usdt_vkoin"), 1);
    assert.equal(count(h, "collect_fee"), 1);
    assert.equal(count(h, "front_gas"), 0);
    assert.equal(done.usdtSats, String(amount));
    assert.equal(JSON.stringify(done.feePlan), plan, "renewal never expands the accepted plan");
    assert.equal(A.costs(done).debt, 0n);
    console.log(`✓ ${reason}: Retry renews only the needed approval and completes the existing conversion`);
  }

  {
    const h = await atSwap();
    await h.run();
    assert.equal(count(h, "approve_ur"), 1, "a healthy approval is reused");
    console.log("✓ valid approvals do not trigger extra spending");
  }

  for (const interruptedFinish of [false, true]) {
    const h = await atSwap();
    await h.engine.advance(h.account, h.jobs[h.account]);
    assert.ok(h.jobs[h.account].pendingEth);
    if (interruptedFinish) {
      const original = swap.receivedInTx;
      swap.receivedInTx = () => { throw new Error("interrupted receipt read"); };
      try { await assert.rejects(h.engine.advance(h.account, h.jobs[h.account]), /interrupted receipt/); }
      finally { swap.receivedInTx = original; }
      assert.ok(h.jobs[h.account].confirmedEth);
    }
    expire(h);
    h.restart();
    await h.run();
    assert.equal(count(h, "approve_ur"), 1);
    assert.equal(count(h, "swap_usdt_vkoin"), 1);
    console.log(`✓ ${interruptedFinish ? "confirmed" : "pending"} swap reconciles before any approval check or repeat send`);
  }

  {
    const h = await atSwap();
    expire(h);
    await h.engine.advance(h.account, h.jobs[h.account]);
    h.opts.loseNextSend = true;
    await assert.rejects(h.engine.advance(h.account, h.jobs[h.account]), /network lost/);
    const { hash, raw } = h.jobs[h.account].pendingEth;
    h.restart();
    await h.engine.advance(h.account, h.jobs[h.account]);
    assert.equal(h.jobs[h.account].pendingEth.raw, raw);
    assert.equal(h.sends.filter(s => s.hash === hash).length, 1);
    await h.run();
    assert.equal(count(h, "approve_ur"), 2);
    console.log("✓ lost renewal response reuses the persisted transaction after restart");
  }

  {
    const h = await atSwap();
    expire(h);
    await h.engine.advance(h.account, h.jobs[h.account]);
    const j = h.jobs[h.account];
    // Model a job whose earlier retries have used up its original budget.
    j.feePlan.gasMaxWei = Object.values(j.ethReceipts).reduce((sum, r) => sum + BigInt(r.gasWei), 0n).toString();
    const sent = h.sends.length;
    await assert.rejects(h.engine.advance(h.account, j), /approved gas budget is exhausted/);
    assert.equal(h.sends.length, sent);
    console.log("✓ approval renewal cannot exceed the original total gas budget");
  }

  {
    const h = await atSwap();
    expire(h);
    await h.engine.advance(h.account, h.jobs[h.account]);
    await h.run(h.account, "swap_usdt_vkoin");
    quotes.quoteVkoinOut = async () => BigInt(h.jobs[h.account].feePlan.koinOutMin) - 1n;
    await assert.rejects(h.engine.advance(h.account, h.jobs[h.account]), /approved KOIN minimum/);
    assert.equal(count(h, "swap_usdt_vkoin"), 0);
    console.log("✓ a renewed approval cannot weaken the accepted output minimum");
  }

  {
    const h = await atSwap(), sent = h.sends.length;
    swap.permit2Allowance = async () => { throw new Error("RPC timeout"); };
    await assert.rejects(h.engine.advance(h.account, h.jobs[h.account]), /RPC timeout/);
    assert.equal(h.sends.length, sent);
    assert.equal(h.jobs[h.account].status, "swap_usdt_vkoin");
    console.log("✓ an unreadable allowance does not authorize a swap or renewal");
  }

  {
    const h = await atSwap(), sent = h.sends.length;
    h.wallets[h.account].estimateGas = async () => {
      throw Object.assign(new Error("execution reverted (unknown custom error) with huge calldata"), { code: "CALL_EXCEPTION", data: ERROR_DATA });
    };
    await assert.rejects(h.engine.advance(h.account, h.jobs[h.account]), e => {
      assert.match(e.message, /before sending: AllowanceExpired.*approval expired/);
      assert.doesNotMatch(e.message, /huge calldata|unknown custom error/);
      return true;
    });
    assert.equal(h.sends.length, sent);
    assert.equal(h.jobs[h.account].pendingEth, null);
    console.log("✓ estimation reverts show the decoded cause without sending or exposing a calldata dump");
  }
  console.log("\nALL PERMIT2 RECOVERY CHECKS PASSED");
})().catch(e => { console.error(e); process.exit(1); });
