# Wallet transaction feed

Open a token on the website, installed PWA, or Android wallet to see its Activity
below the Send/Receive buttons and contract address. The token panel omits network
and decimals details. There is no account-wide feed or filter control.

Each successful token movement has Sent or Received on the left, the exact token
amount on the right, and a small to/from address underneath when the receipt
provides one. Node rewards and burns have small secondary labels. Mint/burn events
do not invent a counterparty. A self transfer is Sent to the wallet's own address
with a small Self transfer label. Dates are shown when available; tapping an entry
opens its transaction or block on the configured explorer.

Activity is selected by contract address, not ticker, so KOIN, VHP, and added
tokens stay separate even when symbols are identical. Each movement in a
transaction becomes its own row for the relevant token. Amounts retain all digits
and use thousands separators without floating-point conversion.

History is fetched only while a token is open, newest first. Each load scans up
to three account-history pages of 20 records to find 20 token movements, stopping
earlier at the end of history. Load more continues from the remaining cursor,
including when those pages contained only other tokens. Requests are bounded;
an empty partial scan does not claim the token has no older activity.

The first batch refreshes every 30 seconds while the token and wallet are visible,
and after app approvals or completed conversions. Automatic refresh pauses after
Load more to preserve the reading position; reopening the token loads the latest
activity. Closing a token, switching tokens/accounts, or signing out clears the
feed and invalidates in-flight responses. Read failures retain the previous list
and provide a Try again button that retries the failed page batch. History is not
persisted in the browser or cached by either service worker.

## Data and availability

`GET /api/transactions?address=<address>&cursor=<optional-sequence>` returns
`{ ok, address, network, items, nextCursor, fetchedAt }`. Android uses the same
route under `/android/api/transactions`. Addresses and cursors are validated.
This is a public, read-only chain-data endpoint with the existing API rate limit;
it neither signs nor submits transactions.

The independent backend (`WALLET_BACKEND_URL=local`, the default) uses
`account_history.get_account_history`. `KOINOS_HISTORY_RPC` optionally selects
history-capable RPC nodes. Otherwise the existing `KOINOS_RPC` setting or network
defaults apply. A custom node must enable account history and index the requested
accounts. Both public mainnet defaults currently provide this RPC. No API key,
database migration or new contract deployment is required.

The account-history cursor is inclusive, so the next cursor is the oldest
returned sequence minus one. Sequence numbers and amounts retain integer
precision. A short, bounded server cache coalesces repeated reads. RPC fallback,
bounded metadata fan-out, and a 48-second request budget keep history independent
of balance and signing operations.

Only successful receipt events count as token movements. The API retains failed
and generic contract records, but token feeds omit them because they contain no
successful token movement. Inclusion in history does not claim irreversibility.
Unmined or rejected submissions are not indexed by this feed. Nonstandard token
event formats cannot be decoded into token activity.

Transaction dates use batched transaction-store and block-store reads. If a date
cannot be determined, the feed omits the date. Missing token metadata
shows exact raw units rather than assuming decimals. A history outage displays
an error and preserves previously loaded activity, clearly marked. Demo mode
does not query live history or present sample transfers as real ones.

External ETH/SOL deposits and intermediate funding-rail transactions remain in
the Buy screen. Their resulting Koinos transfers appear in this feed.

## Verification

`npm test` includes `tests/transactions.test.js` for receipt decoding, precision,
pagination, RPC failure, stale responses, and account switching, plus
`tests/transactions-http.test.js` for live/demo routes, validation, Android, and
cache headers. The existing send, session, DOM and offline-shell checks also run.

Protocol references:

- [Koinos account history guide](https://docs.koinos.io/exchanges/account-history/)
- [Account history RPC schema](https://github.com/koinos/koinos-proto/blob/master/koinos/rpc/account_history/account_history_rpc.proto)
- [Account history implementation](https://github.com/koinos/koinos-account-history/blob/master/src/koinos/account_history/account_history.cpp)
