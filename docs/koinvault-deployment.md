# Deploy KOIN Vault at koinvault.app

The source is copied from the restored wallet version `29ad276` / `8de938b`.
The startup and diagnostic changes made during the earlier domain troubleshooting
are not included. This is a separate repository and deployment.

## Hosting settings

- Repository: `therexdev/koin-vault`, branch `main`.
- Node.js 22; install with `npm ci`; start with `npm start` (entry `server.js`).
- This is a Node.js app, not a static frontend deployment. No frontend build is needed.
- Route `koinvault.app` to this application; Hostinger must enable HTTPS.
- Copy the existing environment variables, including the sponsor key, module
  addresses, funding credentials, and Android certificate fingerprints.
- Set `PUBLIC_URL=https://koinvault.app`, `PASSKEY_RPID=koinvault.app`,
  `KOINOS_NETWORK=mainnet`, and `DEMO_MODE=0`.
- Set `DATA_DIR` to this deployment's own persistent directory, such as
  `../koin-vault-data`. Relative paths resolve from the application's folder.
  Do not point two running deployments at one data directory.
- Keep the existing Android application ID and signing key when updating an
  installed APK. The source links now use koinvault.app; an APK rebuild is needed
  to change installed apps. Hostinger does not build the APK.

`.env.example` lists the domain-specific settings; it is not a complete copy of
all existing funding settings. The server does not automatically load `.env`.

## Copy the existing wallet data

1. Back up the existing data folder and environment privately.
2. Before shutting down the old wallet, register and save a recovery kit for any
   account that needs to move. Downloading a kit alone is not sufficient: finish
   its passkey-approved on-chain registration in the wallet's Backups screen.
3. Stop the old wallet deployment before taking the final data copy. Do not run
   two funding workers from separate copies of the same live ledger.
4. Copy the full data folder to the new persistent DATA_DIR, preserving file
   contents and ensuring the new Node.js process can read and write it.
   **Exclude `funding-worker.lock`.** It identifies the old process and is not
   account data. The new process creates its own lock. Never remove a lock from
   a live deployment to allow a second worker.
5. Start exactly one instance of the new wallet. No contract deployments or new
   sponsor keys are required. Keep the backup intact until migration is verified.
6. Check `/api/health` returns `ok: true`, `demo: false`, `network: mainnet` and
   `/api/config` returns the same sponsor and module addresses, with
   `rpId: koinvault.app`. Do not create replacement accounts if startup fails.

## Existing passkeys and account addresses

Copying account records preserves the wallet addresses and server-side records.
Balances remain on-chain. Browser passkeys are scoped to the domain where they
were created: a wallet.usekoinos.com passkey cannot be used directly by
koinvault.app. Copying the data folder does not change that browser restriction.

For each existing account, open koinvault.app, choose **Recover with your kit**,
and use the already registered recovery kit. Verify that the address matches
before doing anything else. Use the recovery screen's **new passkey** action to
create and register a koinvault.app passkey for that same account. Sign out and
sign back in using the new passkey. Do not use Create Account as a migration step.

If an account has no registered recovery kit, obtain one through the old wallet
before shutting it down; this repository does not silently rekey accounts or
bypass their existing authority. Do not enter a recovery kit in a support chat,
GitHub, or a hosting environment variable: it is used locally in the wallet.

## Connected apps

This repository accepts the same Trade Koinos and OURO origins as the restored
wallet. It generates connection QR URLs for koinvault.app by default. Existing
relay sessions are temporary and are not transferred with the data folder.

Other repositories and live websites are unchanged by this copy. After this
wallet is healthy, their connection URLs must be updated and users must reconnect:

- Trade Koinos: `VITE_BIO_WALLET_API=https://koinvault.app`, then rebuild its frontend.
- Use Koinos: `BIO_WALLET_URL=https://koinvault.app` plus its static wallet-page link.
- OURO: wallet relay and approval links, plus the paid-launch proof verifier's
  expected origin and RP ID, must use koinvault.app.

Do not switch the apps before the new wallet is ready. Existing on-chain accounts
and contracts do not need replacing for these URL changes.
