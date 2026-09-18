"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const bridge = require("../tools/eth/koinos-bridge");
const readValidatorCount = bridge.readValidatorCount;
let validators = 3;
bridge.readValidatorCount = async () => validators;
bridge.opCompleteTransfer = async () => ({ call_contract: { contract_id: "bridge", entry_point: 1, args: "redeem" } });
let record;
require("../tools/eth/bridge").fetchEthDepositRecord = async () => record;
const chain = require("../tools/chain");
const funding = require("../tools/funding");
const ACCOUNT = "1QuorumTestAccount";
const HASH = "0x" + "ab".repeat(32);
chain.configure({ network: "mainnet", rpcs: ["http://stub.invalid"],
  sponsorWif: require("koilib").Signer.fromSeed("quorum-test").getPrivateKey("wif") });
let sends = 0, rejection = null;
chain.sendAsSponsorFor = async () => { sends++; if (rejection) throw new Error(rejection); return "confirmed-redeem"; };
const dirs = [];
function parked(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-quorum-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "funding.json"), JSON.stringify({ transit: {}, jobs: {
    [ACCOUNT]: { route: "B", status: "awaiting_signatures", ethTxHash: HASH,
      startedAt: Date.now(), sigStartedAt: Date.now(), ...extra },
  } }));
  funding.configure({ dataDir: dir, demo: false, network: "mainnet" });
}

(async () => {
  // Exercise the real ABI and entry point, including fail-closed metadata.
  assert.equal(await readValidatorCount({ provider: { readContract: async (op) => {
    assert.equal(op.contract_id, "1aqHtNRDkiAZeFtuM8fRFuurcje6eHqF8");
    assert.equal(op.entry_point, 4244088463);
    return { result: "CAEQBRgBIAM=" }; // initialized, nonce 5, chain 1, three validators
  } } }), 3);
  await assert.rejects(readValidatorCount({ provider: { readContract: async () => ({}) } }), /validator count/);

  // Regression: validators in the response are SIGNERS, not the full set.
  record = { id: HASH, recipient: ACCOUNT, relayer: chain.sponsorAddress(),
    koinosToken: "1Veth", amount: "1290000", validators: ["guardianA"],
    signatures: ["sigA"], expiration: String(Date.now() + 3600000) };
  parked();
  await funding.tick();
  assert.equal(funding.job(ACCOUNT).status, "awaiting_signatures");
  assert.equal(funding.job(ACCOUNT).guardianSignatures, 1);
  assert.equal(funding.job(ACCOUNT).guardianQuorum, 2);
  assert.equal(sends, 0);
  record = { ...record, validators: ["guardianA", "guardianB"], signatures: ["sigA", "sigB"] };
  await funding.tick();
  assert.equal(funding.job(ACCOUNT).status, "awaiting_redeem");
  await funding.tick();
  assert.equal(funding.job(ACCOUNT).status, "awaiting_swap");
  assert.equal(funding.job(ACCOUNT).vethSats, "1290000");
  assert.equal(funding.job(ACCOUNT).ethTxHash, HASH);
  assert.equal(sends, 1);

  // A restored job must re-check its cached record before submitting or signing.
  validators = 7;
  parked({ status: "awaiting_redeem", record });
  await funding.tick();
  assert.equal(funding.job(ACCOUNT).status, "awaiting_signatures");
  assert.equal(sends, 1);
  parked({ status: "awaiting_redeem", needsTap: true, record });
  await assert.rejects(funding.prepareTapOps(ACCOUNT), /more bridge guardian signatures/);
  assert.equal(funding.job(ACCOUNT).needsTap, false);
  assert.equal(sends, 1);

  validators = 3;
  rejection = "quorum not met";
  parked({ status: "awaiting_redeem", record });
  await funding.tick();
  assert.equal(funding.job(ACCOUNT).status, "awaiting_signatures");
  assert.equal(funding.job(ACCOUNT).ethTxHash, HASH);
  rejection = null;

  record = { ...record, validators: ["guardianA"], signatures: ["sigA"] };
  parked({ sigStartedAt: Date.now() - 31 * 60000 });
  await funding.tick();
  assert.equal(funding.job(ACCOUNT).status, "error");
  assert.match(funding.job(ACCOUNT).error, /1 of 2/);
  assert.throws(() => funding.reset(ACCOUNT), /existing bridge transfer/);

  // Retry in the fee-budgeted engine must fetch new signatures without any send.
  const { harness } = require("./fixtures/funding-v2-harness");
  const h = harness();
  h.jobs[h.account] = { id: "retry-quorum", status: "error", failedAt: "awaiting_redeem",
    ethTxHash: HASH, record, needsTap: true, sigStartedAt: 1 };
  await h.engine.resume(h.account);
  assert.equal(h.jobs[h.account].status, "awaiting_signatures");
  assert.equal(h.jobs[h.account].ethTxHash, HASH);
  assert.equal(h.jobs[h.account].record, null);
  assert.equal(h.jobs[h.account].needsTap, false);
  assert.equal(h.sends.length, 0);

  // Test the actual browser rendering helpers, without changing their public API.
  const src = fs.readFileSync(path.join(__dirname, "../public/js/fund.js"), "utf8")
    .replace("return { mount, refresh, stop, forget };", "return { bridgeNotice, stepLabel };");
  const ui = vm.runInNewContext(src + "\nFund;", {});
  const job = { route: "B", status: "awaiting_redeem", recordAmount: "1290000", estKoinOut: "210369830000" };
  assert.match(ui.bridgeNotice(job), /0.0129 vETH/);
  assert.doesNotMatch(ui.bridgeNotice(job), /0.0129 KOIN/);
  assert.match(ui.bridgeNotice({ ...job, status: "error", failedAt: "awaiting_redeem" }), /0.0129 vETH/);
  assert.match(ui.bridgeNotice({ ...job, recordAmount: undefined }), /KOIN estimated/);
  assert.match(ui.bridgeNotice({ ...job, status: "awaiting_swap" }), /arrived on your account/);
  assert.match(ui.bridgeNotice({ ...job, route: "C", recordAmount: "210369830000" }), /2,103.6983 KOIN/);
  assert.match(ui.stepLabel({ status: "awaiting_signatures", guardianSignatures: 1, guardianQuorum: 2 }), /1 of 2/);
  console.log("ALL BRIDGE QUORUM AND BALANCE CHECKS PASSED");
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
