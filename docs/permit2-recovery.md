# Recover an expired Uniswap approval

The reported Ethereum `estimateGas` revert `0xd81b2f2e` decodes to
`AllowanceExpired(uint256)`. In the ETH → USDT → vKOIN → KOIN route, the
USDT → vKOIN step was trying to use an expired Permit2 allowance. The
reported swap failed before broadcast; earlier route transactions can
already have completed and must not be restarted.

Both the current funding engine and legacy saved jobs now read the Permit2
amount and expiration immediately before a new USDT → vKOIN swap. If the
approval cannot cover the exact input through the swap's deadline plus a
60-second buffer, the job returns to its approval step. That step renews
only the existing input amount for one hour, waits for its receipt, and
then resumes the swap. Existing pending and confirmed transactions are
reconciled before these checks, so renewal does not replay a completed swap.

Current jobs retain their original quote, minimum output, per-step gas
limits, total gas budget and fee history. Renewal cannot raise a budget or
obtain another automatic gas advance. If the original limits no longer
allow execution, the job pauses with the applicable reason. Contract
reverts during estimation are decoded into a readable message instead of
displaying the raw transaction calldata.

## Deployment and recovery

Deploy the updated server to the process that owns the funding worker.
When the frontend forwards to a separate wallet backend, update that
backend too. Preserve the existing `DATA_DIR`, environment and
`funding.json`; no key rotation or data migration is required.

After deployment and restart, open the existing conversion and press
**Retry** once. It resumes the saved conversion, renews its approval if
needed, and proceeds with the remaining route. Use the existing job rather
than **New swap**; do not delete its history or fund another conversion to
work around the old error. The deployed application must perform this
recovery; changing the repository alone does not resume a live job.

## Verification

`npm test` includes `tests/permit2-recovery.test.js` and the legacy cases in
`tests/stale-read.test.js`. Coverage includes the exact reported selector,
expired/near-expiry/insufficient allowances, unchanged input and price
limits, bounded gas spending, pending and confirmed swaps, a lost renewal
broadcast response, restarts, unreadable allowances and readable estimation
errors. The simulator uses real Ethereum calldata builders and signatures.
No real swap, approval or withdrawal was broadcast during these checks.

The error and approval behavior were verified against Uniswap's
[Permit2 implementation](https://github.com/Uniswap/permit2/blob/main/src/AllowanceTransfer.sol)
and [interface](https://github.com/Uniswap/permit2/blob/main/src/interfaces/IAllowanceTransfer.sol).
