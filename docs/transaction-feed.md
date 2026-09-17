# Wallet transaction feed

The home screen shows Transactions below Tokens on the website, installed PWA,
and Android wallet. It loads the current wallet's Koinos account history, newest
first. Incoming and outgoing standard token transfers, mint/burn events, node
rewards, and other contract activity appear together. Added tokens are decoded
using each emitting contract's symbol and decimals; adding a token to the balance
list is not required for its standard transfer events to appear.

Use All activity, Received or Sent to filter the loaded entries. Load more reads
the next 20 history records. Expand an entry for full addresses, exact amounts,
token contract, transaction/block ID, and its explorer link. Some history records
contain several token movements; these stay grouped under one transaction.

The first page refreshes every 30 seconds while the wallet is visible, and after
wallet sends, app approvals and completed conversions. Once older history is
loaded, automatic refresh pauses for the feed to preserve the reading position;
Refresh returns to the latest page. Signing out or changing accounts clears the
feed and invalidates in-flight responses. History is not persisted in the browser
or cached by either service worker.

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

Only successful receipt events count as token movements. Reverted receipts
appear as Failed without claiming funds moved. Confirmed means included in the
history service's current chain; it does not claim irreversibility. Unmined or
rejected submissions are not indexed by this feed. Standard token event formats
are decoded; nonstandard calls remain generic activity.

Transaction dates use batched transaction-store and block-store reads. If a date
cannot be determined, the feed says Date unavailable. Missing token metadata
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
