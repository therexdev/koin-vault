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
