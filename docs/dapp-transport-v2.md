# DApp credentials: protocol 2 rollout

New clients send `protocolVersion: 2` in the JSON body of `POST /api/dapp/create`. The response includes `protocolVersion: 2` and a wallet URL in the form `https://koinvault.app/#connect=SESSION&secret=SECRET`. The browser fragment is not sent in the HTTP request. The wallet validates the link and removes it from browser history after reading it. The frontend proxy preserves the fragment when rewriting the wallet origin.

Poll these endpoints with `Content-Type: application/json` and credentials in the body:

| Endpoint | Fields | Existing policy retained |
| --- | --- | --- |
| `POST /api/dapp/status` | `sessionId`, `secret` | Session secret and matching website/wallet origin |
| `POST /api/dapp/request-status` | `sessionId`, `secret`, `requestId` | Session/origin checks and request ownership |
| `POST /api/dapp/pending` | `sessionId`, `secret` | Wallet-only origin and session secret |

Responses remain `Cache-Control: no-store`. Passkey consent, per-transaction approval, expiry, revocation, and transaction request limits are unchanged. Body credentials remain sensitive: do not log request/response bodies, capture pairing fragments in analytics, or share a connection QR.

Deploy the backend and the proxy/wallet frontend before the Trade client that requires protocol 2. Test through the actual public wallet domain, including a real phone/passkey connection, an approved transaction, a denial, expiry, disconnect, and a network interruption. A proxy or backend that has not been updated must not trigger a fallback to query credentials.

Existing clients that omit `protocolVersion` continue to receive the legacy query link, and the GET polling routes remain available during migration. Those clients still expose bearer credentials in URLs; this change does not close that exposure ecosystem-wide. Inventory all clients, migrate their polling and QR parsers, set a retirement date, then remove legacy creation/GET access. Review existing proxy logs and revoke/expire previously exposed sessions as part of rollout. The relay's existing sessions are in memory and expire after 30 minutes.

Validation: `npm run pretest` runs 17 test programs, including the fragment/parser test and real local HTTP backend/proxy tests for protocol 2, wrong origins, missing credentials, wallet-only pending access, and legacy compatibility. External blockchain calls are fixtures. Runtime deployment and browser/passkey smoke tests remain release gates.
