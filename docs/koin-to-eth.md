# KOIN sales and Ethereum withdrawals

The existing Trade surface now holds the Ethereum balance, its unchanged
deposit address/QR, a Withdraw Ethereum button, and KOIN → native ETH sales.
There is no additional wallet tab. The Android wallet-only surface excludes
these controls, scripts and APIs.

## Routes and fees

- B: KOIN → vETH on KoinDX, then Vortex → native ETH. The user approves the
  KoinDX transaction and then bridges exactly the vETH received by that
  transaction. Pre-existing vETH is not swept into the sale.
- C: KOIN → vKOIN through Vortex, then vKOIN → USDT on Uniswap v4, then
  USDT → WETH on Uniswap v3 with an atomic unwrap to native ETH.

Only ETH is a sell destination. Quotes compare the same two markets used
for buying, including the on-chain bridge fee. Each quote expires after two
minutes. It fixes swap minimums, the platform fee, fee recipient and a gas
budget. The existing FUND_FEE_PCT configuration sets the quoted platform
fee, which is paid once in ETH. The server caps each sale at **10,000 KOIN** during live testing.
The existing FUND_MAX_ETH also limits the ETH value of a sale. These withdrawals have no platform withdrawal fee.

Sales require enough native ETH at the existing Ethereum address upfront
for the complete Ethereum gas budget. They do not borrow from the gas
sponsor. Quote output is after the conversion fee; Ethereum gas is shown
separately and paid from the existing balance. Price/gas changes beyond the
approved limits pause the sale. Retry retains those limits. Reaching the
total gas budget requires operator review; Retry cannot silently increase it.

## Withdrawal behavior

The popup accepts an Ethereum mainnet recipient and an amount or Max.
The review shows the full recipient, amount, maximum gas and total. Changing
an input invalidates the review. Approval requires a fresh passkey or a
registered recovery credential, verified against the current on-chain key.
The server retains the exact approved transaction; submitted browser fields
cannot change the recipient or amount.

Max subtracts only the withdrawal gas, not the buy-flow conversion reserve.
For a standard 21,000-gas ETH send, a fixed legacy gas price lets the
transaction empty the balance known at review. Concurrent incoming funds
remain in the wallet. For contract recipients, an estimated gas limit with
headroom can leave a small refund. The recipient must accept a plain ETH
transfer. ENS resolution and arbitrary transaction data are not supported.

## Persistence and recovery

- The existing Ethereum key/address is reused, without rotation. Balances
  and sale proceeds at this address remain server-custodied until withdrawal
  or conversion. Koinos smart-account authority remains with its credentials.
- The private funding.json ledger stores trade jobs and history alongside
  existing transit keys and buy jobs. It uses the existing atomic/fsync
  persistence and single-worker coordination. Keep DATA_DIR and its backups.
- Buys, sales and withdrawals cannot concurrently use an account's transit
  balance. Unresolved buy errors must be resumed or safely reset first.
- Ethereum transactions are signed and persisted before broadcast. A lost
  response or restart rebroadcasts identical bytes and the same nonce/hash.
  Three canonical Ethereum confirmations are required before advancing.
- Signed Koinos operations are persisted before broadcast, including the
  sponsor signature where applicable. The worker waits for a canonical,
  irreversible receipt, reads the actual vETH or bridge event, and uses the
  event sequence as Vortex OpId. It never infers delivery from a balance delta.
- Vortex records must match the transaction, event, destination, token,
  amount, zero relayer payment and job metadata. Quorum comes from Ethereum's
  validator count. Expired records require a new Koinos signature-refresh tap.
- A failed Ethereum receipt records gas exactly once. A withdrawal that
  reverts releases its reservation after confirmation; a paused sale retains
  its intermediate funds and can retry the same step. Only an unstarted sale
  can be cancelled. Private keys, raw signed transactions and guardian records
  are omitted from public trade status.

## Validation and rollout

`npm test` covers the existing wallet behavior; `npm run test:trade` runs
the new amount, authentication, replay, nonce, concurrency, restart, receipt,
ABI, guardian and full reverse-route simulations.

On 2026-10-03 both reverse routes returned read-only quotes from deployed
mainnet Vortex, KoinDX and Uniswap contracts. Mobile Chromium tests covered
the quote cards, withdrawal Max/review/confirmation, changed recipients,
pending-state controls and sign-out cleanup. Mobile and desktop layouts were
inspected. No funded sell or withdrawal has been broadcast during development.

The owner authorized deploying to main for live testing on 2026-10-06 with
the 10,000 KOIN per-sale cap. The owner will perform a funded sale through each route and a
small withdrawal followed by Max from a dedicated test account. Confirm
receipts, balances, the fee payment and resume after a worker restart. This
requires an account owner's explicit signing approval; the development
checks do not stand in for a mainnet money-moving rehearsal.

Deploy the frontend and owning funding worker together. A forwarding-only
frontend requires its owner backend to run these new endpoints too. Do not
roll back to a version without trade reservations while a new trade is
pending: finish/reconcile trades first. Never delete funding.json or replace
its keys to recover a failed job.

Bridge ABI/semantics were checked against the official repositories:
[Koinos bridge](https://github.com/VortexBridge/koinos-bridge-contract),
[Ethereum bridge](https://github.com/VortexBridge/koinos-bridge-ethereum), and
[Vortex UI](https://github.com/VortexBridge/interface-bridge).

### Live testing rollout, 2026-10-06

The owner authorized deployment to `main` for funded testing, with a hard
10,000 KOIN per-sale limit. Quote creation, approval preparation and submission
each enforce the cap. Max chooses the smaller of the available KOIN balance
and 10,000 KOIN. The existing ETH-value ceiling may impose a lower limit.
Withdrawals retain their existing balance and network-gas checks.

This includes the deployed worker recovery, Permit2 renewal and explicit buy
requote fixes. Hostinger uses Node 22, `npm start`, existing environment settings
and DATA_DIR. No real sale or withdrawal is broadcast by development tooling.
The owner performs funded tests after deployment, as described above.
