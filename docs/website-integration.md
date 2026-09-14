# Add KOIN Vault to your website

Connect a user's Koinos smart account and request transactions that they review
and approve in [KOIN Vault](https://koinvault.app/) with a passkey, fingerprint,
face recognition, or device PIN. Your website never receives the user's private
key or passkey. Each transaction requires a separate approval.

This guide documents the existing KOIN Vault HTTP connection API. It does not
require WalletConnect, a browser extension, or a KOIN Vault npm package.

## Before you start

1. Ask the KOIN Vault maintainer to approve your website's exact HTTPS origin,
   for example `https://example.com`. Production, staging, and `www` origins
   are separate. Provide your app name, origins, and intended contract actions
   through the [repository issue tracker](https://github.com/therexdev/koin-vault/issues).
   Domain approval is currently a manual configuration step; it is not automatic
   when you install code. A development origin also needs explicit approval.
2. Use `https://koinvault.app` as the API base and wallet destination. Make calls
   from your approved website. The browser supplies the `Origin` header; do not
   attempt to set it in JavaScript. CORS permits `Content-Type` on these routes.
3. Use an active KOIN Vault account with a registered passkey. Recovery mode
   cannot approve app connections or app transactions. Demo mode cannot complete
   the live connection approval flow.
4. Confirm the wallet deployment's Koinos network with the maintainer. Requests
   use that configured network. A `summary.network` label does not select or
   change the blockchain.

For maintainers: add the origin to `DAPP_ORIGINS` on the server that actually
handles `/api/dapp/*`, preserving the existing entries. If this deployment
proxies the wallet API, changing only the frontend configuration is insufficient.
Keep `PUBLIC_URL` set to `https://koinvault.app` for the public Vault frontend.
This guide requires no changes to the legacy wallet's source code.

## Connection flow

1. Your **Connect KOIN Vault** button creates a session.
2. Show the returned wallet link and a QR code encoding that exact link.
3. The user opens the link on their phone, or scans the QR using **Connect** in
   KOIN Vault. They unlock the wallet and approve your website with a passkey.
4. Your website polls the session status until it reports a connected address.
5. Your website can now request contract calls. The user approves each request
   in KOIN Vault; the wallet prepares, sponsors, signs, and submits the transaction.
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
    id: '15DJN4a8SgrbGhhGksSBASiSYjGnMU8dGL',
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
async function requestTransaction(session, operations, summary) {
  return vaultApi('request', {
    body: { ...sessionCredentials(session), operations, summary },
  });
}

async function transactionStatus(session, requestId, signal) {
  return vaultApi('request-status', {
    query: { ...sessionCredentials(session), requestId },
    signal,
  });
}
```

Example `summary`: `{ title: 'Send KOIN', detail: 'Send the reviewed amount to the selected recipient', network: 'Mainnet' }`.
Titles are limited to 80 characters, details to 300, and the network label to 30.
These are app-supplied descriptions, not proof of what the encoded operations
do. Keep them accurate. Koin Vault prepares the actual transaction using its
configured network, the connected smart account, and its mana sponsor.

The request response contains `ok`, `requestId`, and `expiresAt`. Save the ID and
poll `request-status` while continuing session checks. Serialize requests: the
relay rejects another request while one is pending, and your UI should wait
through submission before allowing another action.

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

## Disconnect from either side

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
transaction that was already submitted.

## Website API reference

All paths below are relative to `https://koinvault.app`. Send POST data as JSON
with `Content-Type: application/json`; encode GET parameters with `URLSearchParams`.
Successful responses have `ok: true`. Error responses normally contain `error`.

| Method and path | Input | Successful output |
| --- | --- | --- |
| `POST /api/dapp/create` | `name`, optional HTTPS `icon`; approved browser Origin | `sessionId`, `secret`, `uri`, `expiresAt` |
| `GET /api/dapp/status` | Query: `sessionId`, `secret` | `id`, `name`, `origin`, `icon`, `connected`, `address`, `connectedAt`, `expiresAt` |
| `POST /api/dapp/request` | `sessionId`, `secret`, `operations`, optional `summary`; Origin must match session | `requestId`, `expiresAt` |
| `GET /api/dapp/request-status` | Query: `sessionId`, `secret`, `requestId` | `status`, `txid`, `error`; specialized launch flow may include `signedTransaction` |
| `POST /api/dapp/disconnect` | `sessionId`, `secret` | `ok: true` |

Connection challenges, passkey approval, pending-request display, and rejection
are handled by Koin Vault. Your website should not reproduce the wallet's
`challenge`, `connect`, `pending`, `approve`, or `reject` flow or request users'
WebAuthn credentials. The OURO `/api/dapp/launch` endpoint has separate validation
and origin restrictions; it is not a general contract-upload API.

## Current limits and troubleshooting

| Situation | Explanation or next step |
| --- | --- |
| CORS failure or "this app origin is not allowed" | Ask the maintainer to approve the exact origin on the authoritative API server. A wildcard is not the setup. |
| "connection origin does not match" | Create and use the session from the same approved website origin. |
| Session expired or disappeared | Sessions last 30 minutes from creation and are held in server memory. Server restarts also clear them. Pair again; polling does not renew them. |
| Request disappeared | Requests last 10 minutes at most, and cannot outlive their session. There is no returned `expired` status; reads return 404 after removal. |
| "finish the pending wallet request first" | Resolve the existing request in the wallet before creating another. |
| Sponsor mana unavailable | Ordinary dApp preparation currently requires 100 available sponsor mana for the signed ceiling. This is not a 100-KOIN charge. Wait for capacity; actual resource consumption depends on the calls. |
| HTTP 429 | Back off. Source defaults limit all API calls to 240/minute/IP and signing requests to 30/minute/address and 60/minute/IP. Limits may change by deployment. |
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
- [Wallet approval UI and connection-link handling](../public/js/app.js)
- [Backend forwarding](../tools/wallet-backend.js)
- [koilib operation building](https://github.com/joticajulian/koilib)
- Existing integrations: [Trade Koinos](https://github.com/therexdev/Token-Trading),
  [OURO](https://github.com/therexdev/marketplace), and
  [Koinos AI Test](https://github.com/therexdev/kaiapp).

API behavior reviewed against KOIN Vault commit `bc74eeb4d43d75284a2e2a729c22d811e65b4af8`.
