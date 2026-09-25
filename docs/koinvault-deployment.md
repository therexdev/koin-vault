# Independent KOIN Vault deployment

KOIN Vault defaults to a standalone backend. No old-wallet code change is needed.

## Hosting cutover

1. Back up hosting configuration and any existing Vault persistent data.
2. Set `WALLET_BACKEND_URL=local`, `PUBLIC_URL=https://koinvault.app`,
   `PASSKEY_RPID=koinvault.app`, `KOINOS_NETWORK=mainnet`, and `DEMO_MODE=0`.
3. Set `DATA_DIR` to a dedicated persistent directory such as `../koin-vault-data`.
   Do not share the old wallet directory or copy its active funding ledger.
4. Configure `SPONSOR_WIF`, `VERIFIER_ADDR`, `MOD_SIGN_WEBAUTHN_ADDR`, and
   `MOD_VALIDATION_SIGNATURE_ADDR`. Use the same deployed mainnet module
   addresses as the old backend: recovery discovers credentials through them.
   The sponsor must have available mana. Do not put secrets in Git.
5. Review buy/funding configuration separately. Old transit addresses, pending
   swaps and funding jobs remain owned by the old backend; recovery kits do not
   migrate them. Keep that service available until outstanding jobs are settled.
   Do not run independent funding ledgers against the same funding wallets.
6. Deploy and restart Vault. Verify `/api/health` returns `ok:true`, `demo:false`,
   and `network:mainnet`, and `/api/config` reports `rpId:koinvault.app`.
7. Test existing Vault sign-in, activated-kit recovery, new passkey registration,
   token sending, and a Use Koinos QR approval on a real device.

Any HTTPS website can request a user-approved connection. `DAPP_ORIGINS` is no
longer read; remove that obsolete environment setting. See the
[website integration guide](website-integration.md) for the API and examples.

After this update, verify `/api/config` reports `features.openDappConnections:true`
and `features.dappReviewVersion:1`, then pair again. Old sessions expire on restart.
Sponsorship defaults to 5,000 mana/day shared, 500/account/day and 1,000/site/day.
Override these positive whole-mana ceilings with `DAPP_SPONSOR_MANA_PER_DAY`,
`DAPP_SPONSOR_MANA_PER_ACCOUNT_DAY`, and `DAPP_SPONSOR_MANA_PER_SITE_DAY`.
Keep `DATA_DIR/dapp-sponsorship.json` on persistent storage: it charges the signed
maximum before submission, including failed or uncertain submissions. Deleting
it resets the budget. Only one wallet backend process may own this data directory.
Unfamiliar/custom contract calls use the user's own mana and receive no sponsor
signature. Eligible native actions also fall back to the user's mana when the
budget or capacity is unavailable; the user reviews the chosen payer before signing.
Sponsorship requires fresh RPC verification of the account's bytecode hash,
authorization flags, standard modules and signed nonce. Modified accounts or
unavailable metadata reads do not qualify; standard pairing still works.

## Hosting restarts and multiple processes

Live Vault processes now elect one account/funding worker per canonical
`DATA_DIR` on the same host. Other HTTP processes forward API requests to that
worker over an authenticated loopback connection. The active process owns the
account store, funding ledger, signing requests and dapp sessions. The operating
system releases its listener when it exits; a remaining process then takes over
automatically and reloads the persistent data. No new package or environment
variable is required.

The public HTTP listener uses the hosting launcher normally. The private
loopback listener uses Node's underlying TCP listener because managed launchers
such as LiteSpeed and Passenger intercept `http.Server.listen()` and may ignore
or reject a second call. Repeated restarts cannot repair that incompatibility.
Startup verifies the private address before claiming ownership and reports a
bounded failure if binding cannot finish. `/api/health` and `/api/config` return
specific error codes on failure: `WALLET_WORKER_START_FAILED`,
`WALLET_WORKER_UNREACHABLE`, or `WALLET_WORKER_IDENTITY`. The runtime log records
the corresponding bind/connect error without recording request bodies or keys.
`WALLET_WORKER_RESPONSE_LOST` means a request's result is uncertain; a forwarded
POST is never replayed automatically.

For the first deployment of this change:

1. Stop the existing **KOIN Vault** app processes in Hostinger. The old release
   cannot participate in worker coordination. Do not stop the old wallet site
   or delete either site's data directory or funding lock while a worker lives.
2. Deploy the latest `main` and start KOIN Vault with its existing environment
   and dedicated `DATA_DIR`.
3. Check for `active wallet worker` in the runtime log. Additional processes may
   report `forwarding to active wallet worker`; this is normal. Both log their
   PID and resolved data directory. `waiting for previous worker pid=...` means
   an old process still owns the directory and must finish exiting.
4. Confirm `/api/health` returns HTTP 200 with `ok:true`, `demo:false`, and
   `network:mainnet`. Check KOIN and VHP activity and each account explorer link.

The coordinator never retries a forwarded POST after an uncertain response.
An owner restart can still invalidate pending, in-memory signing or dapp
requests; reopen or reconnect if requested. Account records, deposit keys and
funding jobs remain in the existing persistent files.

This is single-host coordination, not multi-host storage support. Keep separate
deployments on separate directories and funding wallets. A conflicting service
on the derived private port or mismatched site/network/signing configuration is
rejected rather than receiving wallet requests. Linux process start identity
also distinguishes a stale lock from a later process that reused its PID;
unknown or legacy live owners remain protected.

## Existing accounts

An empty account store can discover registered credentials through the on-chain
reverse index. The existing `/api/whoami` flow persists the discovered account
locally; the account address and on-chain balances do not change. The recovery
private key stays in the browser and signs transactions there.

An activated recovery kit can be restored at `https://koinvault.app/?open=recover`.
An unactivated download cannot recover an account. Existing Vault passkeys can
also rediscover their accounts. Old-domain passkeys cannot authenticate at Vault;
those users need their activated recovery kit and then a new Vault passkey.

The old deployment can be retired after users have their recovery kits and its
funding jobs are settled. This repository does not shut down that host.
