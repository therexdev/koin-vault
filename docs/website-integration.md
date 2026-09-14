# Add KOIN Vault to your website

Connect a user's Koinos smart account and request transactions that they review
and approve in [KOIN Vault](https://koinvault.app/) with a passkey, fingerprint,
face recognition, or device PIN. Your website never receives the user's private
key or passkey. Each requested transaction requires a separate approval. A spending permission
can authorize later token spends without another fingerprint; the wallet warns
about this before approval.

This guide documents the existing KOIN Vault HTTP connection API. It does not
require WalletConnect, a browser extension, or a KOIN Vault npm package.

## Before you start

1. Serve your website over HTTPS. No registration or maintainer approval is
   required. Production, staging, `www`, subdomains and nondefault ports are
   separate origins. For development, use a trusted HTTPS local server or HTTPS
   preview. Plain HTTP, opaque (`null`) origins and sandboxed file pages cannot connect.
2. Use `https://koinvault.app` as the API base and wallet destination. The browser
   supplies `Origin`; do not try to set it in JavaScript. CORS allows JSON requests
   from HTTPS sites, without cookies or wildcard origins.
3. Use an active KOIN Vault account with a registered passkey. Recovery mode
   cannot approve app connections or app transactions. Demo mode cannot complete
   the live connection approval flow.
4. Read `/api/config` from the wallet deployment to confirm its configured
   network and `features.openDappConnections: true`, `features.dappReviewVersion: 1`.
   Site-provided labels cannot select the network. Configuration reads are
   same-origin; developers can inspect that URL directly or from their backend.

KOIN Vault shows the full website origin and asks the user to connect. Connection
shares an address and permits requests; it grants no automatic signing authority.
The site name is supplied by the website and is not a verification badge.

For maintainers: deploy this update to the backend that handles `/api/dapp/*`.
The standalone default is `WALLET_BACKEND_URL=local`; a frontend proxy cannot
provide open connections against an unchanged backend. `DAPP_ORIGINS` is obsolete.
Keep `PUBLIC_URL=https://koinvault.app` and preserve the persistent `DATA_DIR`.

## Connection flow

1. Your **Connect KOIN Vault** button creates a session.
2. Show the returned wallet link and a QR code encoding that exact link.
3. The user opens the link on their phone, or scans the QR using **Connect** in
   KOIN Vault. They unlock the wallet and approve your website with a passkey.
4. Your website polls the session status until it reports a connected address.
5. Your website can now request contract calls. The user approves each request
   in KOIN Vault; the wallet prepares the transaction, displays its mana payer,
   obtains a passkey signature, and submits it.
6. Continue checking the session while connected so wallet-side disconnects
   also clear the address and transaction controls on your website.

## JavaScript building blocks

The following snippets belong in the same JavaScript module. Connect them to
your website's buttons and state management. They are API examples, not a
complete UI or a backend login system.

### API helper

No cookies or authorization header are required by this API. After creation,
the session ID and session secret identify the connection.

```js
const VAULT = 'https://koinvault.app';

async function vaultApi(path, { body, query, signal } = {}) {
  const url = new URL('/api/dapp/' + path, VAULT);
  if (query) url.search = new URLSearchParams(query).toString();
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal,
  });
  const data = await response.json();
  if (!response.ok || data.ok !== true) {
    const error = new Error(data.error || `KOIN Vault returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function sessionCredentials(session) {
  return { sessionId: session.sessionId, secret: session.secret };
}
```

Catch rejected promises at your UI boundary. Network failures and non-JSON
hosting errors may not have an HTTP status attached. Treat them as a temporary
connection problem, not as proof of a disconnect or a failed transaction.

### Create a session and display its link

Call this once in response to the user's Connect action, and disable the button
while it runs. Do not create a fresh session on every status check.

```js
async function createConnection() {
  const session = await vaultApi('create', {
    body: { name: 'My Koinos App', icon: 'https://example.com/icon.png' },
  });
  const link = new URL(session.uri);
  if (link.origin !== VAULT || link.pathname !== '/') {
    throw new Error('Unexpected wallet destination');
  }
  return session;
}
```

The response is shaped like this. IDs and secrets below are placeholders, and
`expiresAt` is a Unix timestamp in milliseconds.

```json
{
  "ok": true,
  "sessionId": "SESSION_ID",
  "secret": "SESSION_SECRET",
  "expiresAt": 1800000000000,
  "uri": "https://koinvault.app/?connect=SESSION_ID&secret=SESSION_SECRET"
}
```

Set an **Open KOIN Vault** anchor's `href` to `session.uri` and use
`target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"`.
Using an explicit link avoids popup blockers after an asynchronous API call.
Render `session.uri` with a QR library running on your website; do not send this
secret-bearing URL to an external QR-image service.

Keep the session in memory, or use `sessionStorage` if your app needs to survive
a page refresh. Always revalidate restored sessions before using an address.
Keep secrets and complete pairing URLs out of analytics, logs, screenshots,
public posts, and error reports. Treat them as credentials.

### Check connection status

```js
async function connectionStatus(session, signal) {
  return vaultApi('status', { query: sessionCredentials(session), signal });
}
```

Before approval, the response includes `connected: false` and `address: null`.
After approval, it includes `connected: true`, the Koinos `address`, the
recorded app `origin`, `name`, `connectedAt`, and `expiresAt`. The status response
calls the session identifier `id`; keep the original `sessionId` for API calls.

Schedule one status request at a time, approximately every two seconds. Also
check on window focus, `visibilitychange` when visible, and the `online` event.
Use this state handling:

| Result | Website behavior |
| --- | --- |
| Not yet connected during initial pairing | Keep showing the QR/link and waiting for approval. |
| First connected address | Store that address and enable the wallet controls. |
| Same address still connected | Keep the connection active. |
| A different address, or no longer connected after approval | Clear the old address and pending UI; require a new connection. |
| Session status HTTP 404, or local session expiry | Clear the session and offer a new connection. Handle HTTP 410 the same way if a deployment returns it. |
| Network failure, HTTP 429, or HTTP 5xx | Keep the session, show that connectivity is unavailable, disable new requests, and retry status reads with backoff. |

Stop polling when a session is removed. Cancel requests or ignore responses
belonging to a previous session so a late response cannot undo a disconnect.
Checking an address supplied by your own frontend is not sufficient to authorize
private backend data. If your website has a separate login system, it must verify
the approved relay session independently and bind it to its own user session;
do not trust a client-posted address alone.

## Request a transaction

Send an array of encoded Koinos `call_contract` operations. The ordinary API
accepts between one and six operations, up to 48 KiB for the JSON-encoded
operations array. Each operation must contain only `call_contract`, with
`contract_id`, a numeric entry point, and protobuf arguments encoded as base64
or base64url. The complete ordinary request body is limited to 64 KiB.

Use the contract's correct ABI to encode its arguments. Do not put a plain JSON
arguments object into `args` or supply a private key. For example, an app that
already uses [koilib](https://github.com/joticajulian/koilib) can build a Mainnet
KOIN transfer without signing or broadcasting it:

```js
import { Contract, utils } from 'koilib';

async function buildKoinTransfer(from, to, amount) {
  const koin = new Contract({
    id: '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK',
    abi: utils.tokenAbi,
  });
  const { operation } = await koin.functions.transfer({
    from, // the address returned by the approved connection
    to,   // the full recipient address selected by the user
    value: utils.parseUnits(amount, 8), // amount is a decimal string
  }, { onlyOperation: true });
  return operation;
}
```

Use the correct contract and decimal precision for VHP or another token. This
example's contract address is Mainnet KOIN; do not reuse it for another network.
Confirm the amount and recipient in your own UI before creating a request.

```js
async function requestTransaction(session, operations, mana = 'auto') {
  return vaultApi('request', {
    body: { ...sessionCredentials(session), operations, mana },
  });
}

async function transactionStatus(session, requestId, signal) {
  return vaultApi('request-status', {
    query: { ...sessionCredentials(session), requestId },
    signal,
  });
}
```

`mana` is optional: `auto` is the default, or use `wallet` to request your
user's own mana explicitly. It never authorizes automatic approval.

KOIN Vault builds the review from the actual encoded operations, using its own
schemas. A legacy `summary` field is accepted for compatibility but ignored.
The wallet displays amounts, full recipients and contracts, token permissions,
and the configured network. Unknown methods show their exact contract, entry
point and encoded arguments with a required acknowledgement. Custom token names
and decimals are labelled as contract-provided; decoding is not a contract audit.

The response contains `ok`, `requestId`, `expiresAt`, and `funding`:

```json
{
  "payer": "sponsor",
  "address": "ACTUAL_MANA_PAYER_ADDRESS",
  "maxMana": "20",
  "rcLimit": "2000000000"
}
```

`payer` is `sponsor` or `wallet`; `maxMana` is a decimal string, while `rcLimit`
is in base units. Save the request ID and poll `request-status` while continuing
session checks. Serialize requests: only one pending/preparing/submitting request
is allowed per connected account, including across website sessions.

### Mana and sponsorship

Eligible native KOIN/VHP transfers, allowances and burns must name the connected
account as the source/owner. Supported Mainnet proof-of-burn combinations can
also qualify. Other calls, including custom tokens, wallet authority changes and
unrecognized contracts, use the connected account's own mana and receive no
KOIN Vault sponsor signature. A mixed request qualifies only if every action is eligible.

Sponsorship also requires the standard Vault account bytecode and only the
configured signing and validation modules. The backend checks these again
before co-signing, along with the prepared account nonce. Modified accounts
and accounts whose configuration cannot be verified use their own mana.

The signed ceiling is 20 mana for one eligible native-token operation and 100
mana for other ordinary requests. Mana is a regenerating resource; the ceiling
is not a KOIN fee and only actual execution consumption is used. The payer must
have enough available mana for the whole signed ceiling when prepared.

By default, sponsorship has daily ceilings of 5,000 mana shared, 500 per account,
and 1,000 per website origin. These reset at UTC midnight and conservatively
charge each signed maximum, including failed or ambiguous submissions. They
persist across restarts and reconnects. Deployment values can differ.

With `auto`, unavailable sponsorship falls back to the wallet's own mana before
preparation. If that is insufficient too, the request returns HTTP 409 with an
explanation. Show this error without repeatedly posting the transaction.
The approval screen shows the chosen payer, its full address and maximum mana.
If sponsorship runs out after preparation, approval fails; the server does not
change the payer under an existing signature. Create a fresh request only after
the user reviews the failure and any known on-chain outcome.

For approval after pairing, offer a plain **Open KOIN Vault** link to
`https://koinvault.app/`. The original pairing URL is for initial connection;
opening it again tries to approve an already connected session. Ask users to
keep the wallet open, or reopen it to see the pending approval. Browsers cannot
guarantee that a background or closed mobile wallet opens automatically. There
is currently no documented automatic return-to-app callback; users return to
your website after approval.

| Request status | Meaning and required handling |
| --- | --- |
| `pending` | Waiting for wallet approval. Do not report success. |
| `submitting` | Submission is in progress. Continue checking; do not resubmit. |
| `approved` | The wallet reports transaction submission success and returns `txid`. Check chain inclusion/result before treating a payment or contract action as final. |
| `rejected` | The user declined. Stop waiting and leave any retry to the user. |
| `failed` | The wallet returned an `error`. Show it. If submission may have reached the chain, reconcile on-chain state before retrying. |
| `signed` | Reserved for the separate OURO launch flow; it does not mean broadcast or confirmation. Ordinary requests should not expect this status. |

A request-status response includes `ok`, `status`, `txid`, and `error`; `txid`
and `error` may be null. Ordinary requests return no raw signature or full signed
transaction. Never broadcast the same action again merely because your polling
timed out. There is no idempotency key or request lookup-by-operation endpoint.
If the initial request POST has an uncertain outcome, inspect the wallet and
session rather than retrying that POST automatically.

HTTP 404 on `request-status` can mean the request expired, or the session was
removed. Check session status to distinguish these. Neither proves a submitted
transaction failed. Preserve any known transaction ID for chain reconciliation.

## Disconnect or block a site

```js
async function disconnectConnection(session) {
  try {
    await vaultApi('disconnect', { body: sessionCredentials(session) });
  } catch (error) {
    if (error.status !== 404 && error.status !== 410) throw error;
  }
  // Caller now clears its stored session, address, timers, and pending UI.
}
```

If revocation fails because of a network error, keep the session available for
retry and do not claim the wallet connection was revoked. If the user disconnects
inside KOIN Vault, your session checks detect the removal and clear your website.
Suspended browser tabs catch up when visible again. Disconnect cannot reverse a
transaction that was already submitted. It also cannot undo a spending allowance
already granted on-chain.

Users can choose **Block this site** in Security. This saves the exact origin
for this wallet in the current browser/device and revokes its session. Future
pairing is refused locally until the user unblocks it in **Blocked sites**.
Blocking is not synced across devices and clearing browser storage removes it.
A network outage can delay server revocation; the wallet retains the block and
retries disconnection when online.

## Website API reference

All paths below are relative to `https://koinvault.app`. Send POST data as JSON
with `Content-Type: application/json`; encode GET parameters with `URLSearchParams`.
Successful responses have `ok: true`. Error responses normally contain `error`.

| Method and path | Input | Successful output |
| --- | --- | --- |
| `POST /api/dapp/create` | `name`, optional HTTPS `icon`; HTTPS browser Origin | `sessionId`, `secret`, `uri`, `expiresAt` |
| `GET /api/dapp/status` | Query: `sessionId`, `secret` | `id`, `name`, `origin`, `icon`, `connected`, `address`, `connectedAt`, `expiresAt` |
| `POST /api/dapp/request` | `sessionId`, `secret`, `operations`, optional `mana` (`auto` or `wallet`); Origin must match session | `requestId`, `expiresAt`, `funding` |
| `GET /api/dapp/request-status` | Query: `sessionId`, `secret`, `requestId` | `status`, `txid`, `error`; specialized launch flow may include `signedTransaction` |
| `POST /api/dapp/disconnect` | `sessionId`, `secret` | `ok: true` |

All website session reads, requests and disconnects must use the original
website origin and session secret. Origins are a browser boundary, not server
identity or authentication: an HTTP client can forge an Origin header, but it
still needs a session secret and a valid wallet signature for approval.

Connection challenges, passkey approval, pending-request display, and rejection
are wallet-origin-only and handled by KOIN Vault. Your website must not reproduce the wallet's
`challenge`, `connect`, `pending`, `approve`, or `reject` flow or request users'
WebAuthn credentials. The OURO `/api/dapp/launch` endpoint has separate validation
and origin restrictions; it is not a general contract-upload API.

## Current limits and troubleshooting

| Situation | Explanation or next step |
| --- | --- |
| CORS failure or "Connect from an HTTPS website" | Use a real HTTPS origin and confirm the deployed backend advertises open connections. Do not use a wildcard, opaque origin or a forged Origin header. |
| "connection origin does not match" | Create and use the session from the same website origin. |
| Session expired or disappeared | Sessions last 30 minutes from creation and are held in server memory. Server restarts also clear them. Pair again; polling does not renew them. |
| Request disappeared | Requests last 10 minutes at most, and cannot outlive their session. There is no returned `expired` status; reads return 404 after removal. |
| "finish the pending wallet request first" | Resolve the existing request in the wallet before creating another. |
| Wallet mana unavailable | Wait for mana to regenerate or hold sufficient KOIN in the connected account. Custom/unknown calls are self-paid; see the mana rules above. |
| HTTP 429 | Back off. Defaults: all API calls 240/minute/IP; session creation 12/minute/IP and 240/minute shared; signing requests 30/minute/account and 60/minute/IP. At most 2,000 sessions shared, 100 per origin, and 60 retained requests per session. Limits may change by deployment. |
| Wallet shows a different app | The current wallet UI keeps one active app connection locally. Pair again with the intended app and revalidate your website session. |
| Need a message signature for login | There is no general `signMessage` or `signHash` endpoint. KOIN Vault smart accounts do not use the conventional recovered-address login assumption. |
| Need a contract upload or other operation type | Ordinary requests support contract calls only. Coordinate a specifically supported flow with the maintainer. |

Read balances and contract state through your own Koinos RPC integration.
The connection API does not provide a general wallet provider, network-switching
interface, or arbitrary JSON-RPC tunnel. Display site-provided names and error
messages as text, not HTML.

Before release, verify pairing on a desktop/phone combination and on a single
phone, an approved transaction and a rejection, wallet-side disconnect, page
refresh, expiration, network interruption, and server restart. Confirm the
transaction's on-chain result. This documentation was checked against repository
source; it is not a certification of every deployed website or phone flow.

## Implementation references

- [Server endpoints and CORS](../server.js)
- [Session and request limits](../tools/dapp-relay.js)
- [Origin policy and persistent sponsorship budgets](../tools/dapp-policy.js)
- [Wallet-owned transaction decoding](../tools/dapp-review.js)
- [Wallet approval UI and connection-link handling](../public/js/app.js)
- [Backend forwarding](../tools/wallet-backend.js)
- [koilib operation building](https://github.com/joticajulian/koilib)
- Existing integrations: [Trade Koinos](https://github.com/therexdev/Token-Trading),
  [OURO](https://github.com/therexdev/marketplace), and
  [Koinos AI Test](https://github.com/therexdev/kaiapp).

This guide describes the open-connections implementation in this source tree.
Check the deployed feature flags before relying on it in production.
