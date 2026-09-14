# KOIN Vault: both domains live

The original wallet at `wallet.usekoinos.com` remains the backend and sole owner
of the account and funding files. The new `koin-vault` repository serves
`koinvault.app` and forwards API requests to the original wallet over HTTPS.
This lets both sites run without two workers competing for one data directory.

## Deploy the fix

1. Deploy the latest `therexdev/koin-vault` `main` first. It defaults to
   `WALLET_BACKEND_URL=https://wallet.usekoinos.com`. Its frontend process no
   longer reads the data files or starts a funding worker, even if its existing
   `DATA_DIR` still points to the original folder.
2. Deploy the latest `therexdev/koinos-bio-wallet` `main`, then restart that
   application if Hostinger has retained a previous process.
3. Keep the original wallet's runtime environment and private `DATA_DIR`
   unchanged. Do not copy, clear, or delete the data or a running process's lock.
4. Check both `/api/health` endpoints: HTTP 200, `ok:true`, `demo:false`,
   `network:mainnet`. Both are answered by the original backend.
5. Check `/api/config` on the original domain retains its original RP ID (a
   null RP ID means the browser uses `wallet.usekoinos.com`). The new domain
   returns `rpId:koinvault.app`.
6. The original domain is sign-in only: choose **Sign In** and verify the
   existing wallet address. **Choose a saved passkey** opens the full picker.
   Missing accounts link to KOIN Vault for signup. Recovery files are opened
   at `https://koinvault.app/?open=recover`.
7. KOIN Vault keeps **Create Account or Sign In** and its recovery form.
   The original backend accepts its authenticated forwarded signup and
   recovery requests; retain the matching `SPONSOR_WIF` on both deployments.
   Users can still create and activate a recovery kit on the original site
   before using that file on KOIN Vault.

There is no new environment variable required for the standard two-domain
setup. `PUBLIC_URL=https://koinvault.app` and `PASSKEY_RPID=koinvault.app` remain
on the new frontend. The original server keeps its original domain settings.

If `WALLET_BACKEND_URL` is explicitly set to `local` or an empty value on the
new site, remove that override to use the shared backend. The original backend
must leave this variable unset or use `local`; do not point it back at the new
frontend, which would create a forwarding loop.

## Recovery capacity rollout

Deploy the shared backend in `therexdev/koinos-bio-wallet` and the frontend in
`therexdev/koin-vault`. Both repositories default `MAX_CREDENTIALS_PER_ACCOUNT`
to 32. If hosting explicitly sets that variable to 6, change it to 32 to gain the
extra slots. The new UI follows the limit returned by `/api/config`; while an
older backend is deployed it conservatively assumes six. The proxy preserves
the backend's capacity value. No account records or existing keys are replaced.

## VHP sending rollout

Deploy the shared backend in `therexdev/koinos-bio-wallet` first, then the
frontend in `therexdev/koin-vault`. `/api/config` advertises
`sendAssets: ["koin", "vhp"]`; the proxy preserves this field. VHP stays
disabled until the backend supports it, and the browser refuses to sign a
preparation that does not identify VHP as the selected asset. Older clients
that omit `asset` continue to prepare KOIN. No new contracts, account migration
or environment changes are required. Real-device passkey approval and an
on-chain VHP transfer remain the final manual smoke test.

## Account access
Existing account records stay in the original data folder. Original passkeys
continue to work at `wallet.usekoinos.com`. Passkeys created at `koinvault.app`
continue to work there. This service fix does not change an existing passkey,
account address, on-chain authority, or enable passkey reuse across domains.

A recovery kit is not required to keep using an original passkey on the original
site. If a user already has a registered kit and chooses to use it on the new
site, they may add a new-domain passkey to the same account through that flow.
Cross-domain reuse of an existing passkey is separate from serving both sites.

## Standalone deployments

`WALLET_BACKEND_URL=local` runs the complete backend in the new repository.
Only use this for an intentionally independent deployment with its own data, or
as a planned replacement after the original funding worker is retired. Never
run two workers against one data directory or copies of the same live funding
ledger. Do not switch to standalone mode to work around a connection error.

Install: `npm ci`. Start: `npm start`. Node.js 22 is recommended for the existing
Hostinger deployment. Hosting must keep runtime environment variables and
persistent data outside deployment-managed files. The server does not
automatically load a `.env` file.
