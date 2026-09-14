# KOIN Vault — Veive smart accounts

**Your wallet is your fingerprint — on-chain.** One button, one biometric scan
(face, fingerprint, or device PIN; the OS decides), and a **real smart
account** exists on Koinos: an on-chain contract, built from the
[Veive protocol](https://github.com/veive-io)'s audited contracts, whose only
registered authority is your passkey. Every transaction is authorized by a
WebAuthn assertion that **the blockchain itself verifies** (P-256, on-chain) —
there is no private key to steal, phish, or back up, anywhere, ever.

Production domain: **https://koinvault.app**.

This repository starts from the restored wallet snapshot
`therexdev/koinos-bio-wallet@29ad276` (the same source tree as `8de938b`).
The existing wallet logic, account storage, funding protections, and on-chain
contracts are preserved. Domain defaults, Android links, and deployment
documentation target koinvault.app.

**Start here: [Deployment and existing-wallet migration](docs/koinvault-deployment.md).**
Copy the existing data and environment at deployment time; neither belongs in Git.

**For website developers: [Add KOIN Vault to your website](docs/website-integration.md).**
Any HTTPS website can request a connection; the user decides in KOIN Vault.

## How an account is born

```
tap the button
   └─ WebAuthn create ceremony → a passkey with a P-256 keypair in secure hardware
        └─ the server bootstraps, mana-sponsored (two atomic transactions):
             tx1  upload Veive's Account contract to a fresh address,
                  all three authorize overrides on
             tx2  install mod-sign-webauthn (type 3)
                  register YOUR passkey's public key as the account's credential
                  install mod-validation-signature (type 1) with scopes
                  contract_call + contract_upload + transaction_application
                       └─ from this instant, only your passkey moves the account
```

The bootstrap is driven by a throwaway secp256k1 key that names the address;
once the validator module is live that key is powerless (the account routes
every authority check into passkey-signature validation). The server keeps it
only to heal interrupted bootstraps.

## How a send works

```
server prepares the exact transaction   (payer = sponsor, payee = you)
   └─ your passkey signs — the WebAuthn challenge IS the transaction id
        └─ the browser packs the assertion into the Veive signature format
             (0xFF02 ‖ protobuf authentication_data, see contracts/README.md)
             └─ the sponsor co-signs as mana payer and broadcasts
                  └─ ON-CHAIN: account → validator → sign module → P-256
                     verifier check the assertion against your registered
                     credential and the transaction id. The server never
                     could have forged it.
```

The signature packing is proven **byte-identical** to the reference vector
from Veive's own module test suite (`node tests/wire-format.test.js`), and our
packer fixes an upstream client bug: every DER signature is normalized so the
on-chain ASN.1 reader parses it correctly (~1 in 128 raw assertions would
otherwise fail).

## The contracts

See [contracts/README.md](contracts/README.md) for the full story. Short
version: three shared contracts are deployed once (Veive's P-256 verifier and
validation module as published; the WebAuthn sign module rebuilt from source
solely to point at our verifier — the rebuild is byte-identical to their npm
binary when built with their address), plus one 97KB Account contract per
user, uploaded at signup.

## Backups: more credentials, same account

The sign module keeps a **list** of credentials per account, and any
registered credential signs with full authority — so both backup paths are
the same mechanism, a `register` transaction authorized by a credential the
account already trusts:

- **Backup passkey** — two deliberate ceremonies: the NEW authenticator
  (another device, another ecosystem, a USB security key) creates its
  credential, then the CURRENT passkey confirms the registration. From then
  on losing the primary (a Google account, say) costs nothing — the backup
  opens the account.
- **Recovery kit** — a manual, offline fallback: the page generates a plain
  P-256 keypair with WebCrypto, the user downloads it as a small text file
  (account address + credential id + private key — the server never sees the
  key), and only after saving it is it registered on-chain. To sign, the kit
  builds a synthetic WebAuthn-shaped assertion — byte-for-byte what the
  deployed sign module verifies (`node tests/recovery-assertion.test.js`
  proves the whole pipeline, negatives included). Lose EVERY passkey and the
  kit still signs you in, re-keys the account with a fresh passkey, or moves
  the funds.

Registered credentials are capped per account (`MAX_CREDENTIALS_PER_ACCOUNT`,
default 32) and rate-limited. The API advertises the configured limit as
`maxCredentialsPerAccount`. The one truly fatal state left is losing every
passkey **and** the kit at once. (The module also has `unregister` for
retiring lost credentials — not yet surfaced in the UI.)

The Backups card keeps **Create another recovery kit** visible and shows capacity.
Each kit has a distinct filename containing its public credential ID; old files
remain valid after a new kit is activated. Downloading alone does not activate a
kit, and the server never stores the kit's private key. The default capacity was
raised from six to 32 so a lost file need not prevent creating another kit.

On desktop, **Use a phone or saved passkey** offers a discoverable saved-passkey
picker (including Google Password Manager) and a phone-preferred browser QR flow.
Creation leaves authenticator attachment unrestricted. A Google account can sync
an existing `koinvault.app` passkey; Google OAuth alone is not wallet authority.
The browser/OS generates the secure phone QR and needs compatible software and
Bluetooth on both devices. USB security keys are optional. Native phone pairing
requires real-device testing; automated tests cover WebAuthn request options and
ensure failed sign-in never creates a new account.

## Sending

Choose **KOIN**, **VHP**, or an added token in the send card, or open a token in the asset list and
tap **Send**. The balance, Send all, dollar estimate and confirmation follow
the selected asset. All use the existing passkey or recovery-key signing
flow, with sponsored mana. KOIN and VHP use eight decimal places; added
standard Koinos tokens use the decimals read from their own contract. The
form shows the token contract so tokens sharing a symbol can be distinguished.
Unpriced tokens have no dollar estimate. Unsupported contracts or unavailable
metadata cannot be sent, and the server rechecks the balance before preparing.

Deploy this change only to KOIN Vault. Added tokens use its own
`/api/token/prepare` and `/api/token/submit` routes, including in proxy mode;
the original wallet backend needs no update. Configure `SPONSOR_WIF`,
`KOINOS_NETWORK`, `VERIFIER_ADDR`, `MOD_SIGN_WEBAUTHN_ADDR`, and
`MOD_VALIDATION_SIGNATURE_ADDR` on the Vault host. The network and public
module addresses must match the existing account backend. These routes do
not open account files or start funding workers. The deployed sign module
must verify the passkey before Vault co-signs with its sponsor.

Until Vault has a live, matching configuration, `/api/config` keeps added
token sending disabled. Its sponsor needs at least 20 available mana for the
signed ceiling; only actual resource use is charged. A mismatched prepared
token or changed decimal count is rejected before the passkey prompt.

The send card takes an address by hand, or by camera. **Scan QR code** opens
the rear camera and fills the address in for you — reading a bare address, a
`koinos:<address>?amount=…` payment URI (the amount comes across too), or an
explorer link. Decoding uses the browser's native `BarcodeDetector` where it
exists (Chrome/Android) and falls back to a vendored jsQR everywhere else;
the fallback is 256KB, so it is fetched only when a scan actually needs it,
never at page load. A code that is not a Koinos address is rejected at the
camera rather than at the chain.

**Send all** fills in the entire balance, formatted from the chain's own
integer rather than the number on screen — a float rounds, and an "all" that
leaves dust behind is not all. Nothing is held back for fees because the
sponsor pays the mana.

## Fund with ETH · USDC · USDT · SOL

Every account gets a personal **Ethereum deposit address** and a personal
**Solana deposit address**. Send ETH, USDC or USDT to the first, or SOL to the
second, from any wallet or exchange; pick an amount, and one tap swaps it into
KOIN on the smart account — through the best of the routes ported from
[Koinos Node Desktop](https://github.com/therexdev/Koinos-Node)'s Fund-node
pipeline (every Ethereum calldata builder is proven **byte-identical** to
that battle-tested implementation: `node tests/eth-parity.test.js`):

| route | path | notes |
|---|---|---|
| B | ETH → Vortex (vETH) → KoinDX vETH/KOIN → KOIN | the original path; shallow pool |
| C | ETH → USDT → vKOIN (Uniswap v4) → Vortex 1:1 → KOIN | usually far more KOIN per ETH |
| S | SOL → vKOIN on Solana (Jupiter) → Wormhole → Ethereum → Vortex 1:1 → KOIN | short, but a small pool and it cannot pay its own gas |
| T | SOL → wETH on Solana (Jupiter) → Wormhole (unwraps to ether) → Route C's tail → KOIN | usually the best SOL route |

Route B's final approval and swap run through the smart account's
`execute_user` entry point. The legacy vETH token tries to recover all
top-level signatures as secp256k1; directly approving with a passkey blob
therefore fails with `unexpected signature length`. Calling through the
account lets the token recognize its owner as the caller, while the account
still validates the signed operation. Both calls remain in one transaction,
with the exact vETH allowance, original recipient and approved slippage floor.
An existing job at **vETH arrived** can be retried after a refresh; it does
not need another ETH deposit or bridge transfer. The sponsor must cover the
full 100-mana swap ceiling before the wallet asks for the passkey, and its
available mana is checked again inside the submission queue. This is a
maximum, not a fixed charge; ordinary transfers and bridge redeems retain
their existing limits. A resource-limit rejection keeps the pending job and
is reported separately from a sponsor that needs to regenerate mana.

USDC and USDT deposits ride Route C's tail (USDC adds one hop through the
deepest stable pair on Ethereum). The server quotes every route live, shows
the comparison, and executes the winner. Amounts are capped while the rails
are new (`FUND_MAX_ETH` 0.1, `FUND_MAX_STABLE` $150, `FUND_MAX_SOL` 1).

**Why SOL goes through Ethereum.** The vKOIN that trades on Solana (mint
`8AUxdPqYU4FBy5rZDhMJxTniPs7gtEfdHjP3UKM71m6G`, the Raydium KOIN/SOL pair) is
Vortex Koin **wrapped by Wormhole** — the mint is exactly the Wormhole token
bridge's wrapped-asset account for the Ethereum vKOIN contract (derive it and
see), and the Vortex bridge has no Solana side: its own interface offers
Koinos and Ethereum only. So a Solana deposit always comes home the way the
token came: across Wormhole to Ethereum, then through Vortex.

**Which leaves the fees, which the platform has to solve.** The route ends on
Ethereum, so somebody must pay Ethereum gas, and a person who deposited only
SOL has none. That is what Route T is for: it buys **wETH** instead of vKOIN,
and Wormhole's `completeTransferAndUnwrapETH` hands the deposit address
**native ether** — so the deposit pays for its own Ethereum legs, and it buys
its vKOIN from the deep Uniswap pool instead of the small Solana one. It wins
on both counts, which is why it is normally the best route; Route S stays
quoted beside it and is still chosen when it actually wins.

One transaction cannot be paid for out of the deposit: the redeem itself,
which is what creates the ether. A Wormhole VAA names its recipient, so
**anyone may submit it** and the money still lands where the guardians said —
so the sponsor (`ETH_GAS_SPONSOR_KEY`) can submit that transaction when the
deposit address lacks enough ETH. Route T then repays that gas in ETH and
pays for the remaining route. With sufficient user ETH, no sponsorship is
used. Without a sponsor, the quote requires the redemption gas budget at the
deposit address before any SOL moves. Route S requires the full route's ETH
budget because its redemption does not release native ETH.

Routes are compared after their Ethereum budgets and conversion fees,
including fees paid separately from existing ETH. The KOIN delivery figure
does not subtract those separately paid fees twice. The card shows each
route's expected and maximum Ethereum fees, payment sources, and Jupiter's
price impact. The Solana side keeps a separate reserve
(`SOL_RESERVE` 0.01) for fees and account rent and refuses trades under
`FUND_MIN_SOL` (0.05, because Ethereum gas sets the real floor); a quote that
cannot cover its own fees is refused with the numbers in the message. Each
Solana leg is one transaction tracked by its signature across restarts, and a
job that lost a reply is put back where the chains say it is
(`node tests/sol-rail.test.js`). The Solana packages (`@solana/web3.js` and
four `@wormhole-foundation/*` modules) are optional at boot: without them the
rail reports itself off and everything else runs as before.

**How custody works here — stated plainly:** the deposit address is a
*transit* address whose key the server holds (like the bootstrap key). The
server drives the Ethereum legs, then completes the Vortex bridge redeem
itself. That is possible because the Ethereum-side deposit names our sponsor
in the bridge's **relayer** field: the Koinos side refuses `complete_transfer`
with *"tokens can only be claimed by the recipient or relayer"*, and being the
relayer is what lets the sponsor submit it. It grants no claim on the money —
`complete_transfer` mints the amount to the **recipient** and only `payment`,
which is 0, to the relayer, and both names are sealed into the guardian-signed
record at deposit time. So the landing cannot be redirected, and asking the
user to tap for it would buy nothing.

A deposit bridged before that field was set carries an empty relayer and can
only be claimed by its recipient; those fall back to a **passkey** tap, and the
job says so rather than spending mana finding out. Route B's final KoinDX swap
always needs the passkey: it *spends* vETH from the account.
`node tests/redeem-fallback.test.js` pins every branch. Funds are custodial
only while in transit, and land on an account only the passkey can spend from.
Keep transit amounts modest.

Stablecoin-only deposits need a little ETH for Ethereum gas; set
`ETH_GAS_SPONSOR_KEY` (an Ethereum private key holding some ETH) and the app
funds only the shortfall needed to buy native ETH for the remaining gas and repayment.

Jobs persist and resume across restarts; every swap carries an on-chain
min-out. A mid-flow failure can leave native ETH, tokens, or an unfinished
bridge transfer; Retry reconciles the recorded transaction without raising
the accepted spending limits. The rail runs live only on mainnet (`KOINOS_NETWORK=mainnet` with the
chain configured) — everywhere else the card simulates.

### ETH gas recovery and fee estimates

New conversions use a versioned fee plan accepted with the displayed quote.
The quote shows estimated conversion/Ethereum fees, their maximum, expected
KOIN delivery, existing ETH used, and any token amount reserved to buy ETH.
Exchange fees are included in swap prices. Solana fees and account deposits
use the separately disclosed SOL reserve. Unused ETH remains available at
the deposit address rather than becoming an extra fee.

The user's confirmed ETH is used first. With too little ETH, a USDT or USDC
deposit receives only the bootstrap shortfall for necessary approvals and an
exact-output token-to-ETH swap. That swap atomically unwraps WETH, enforces a
maximum token input, and provides native ETH for repayment and the remaining
route. SOL route T sponsors only the Wormhole redeem if needed, then uses
the ETH it releases. Route S is available only when the user already has
ETH for its complete Ethereum tail; otherwise choose route T.

Before the remaining conversion proceeds, a confirmed ETH payment returns
all sponsor advances and sponsor-paid gas to the funding address recorded
on the job. It also pays the single platform fee and disclosed sponsorship
risk charge. An advance and the gas it funded are never charged as two
separate sponsor expenses. There is no new accumulation of USDT/vKOIN fees
and no dependency on a future token sweep.

The server reserves funds for admitted jobs, checks the funding wallet's
protected minimum before each sponsored send, and limits total outstanding
loans. Missing prices or an unprofitable recovery path prevent sponsorship.
An expired quote must be refreshed; later gas/price increases beyond accepted
limits pause the job rather than silently increasing the charge. Failed
transactions still burn gas, so a working ETH balance and a loss reserve are
required. The controls pause new sponsorship before the reserve is consumed;
they do not promise that every failed cross-chain attempt is lossless.

`/api/config` reports `float`: confirmed ETH, protected reserve, unspent
commitments, outstanding debt and available sponsorship capacity. Signed
Ethereum transactions are persisted before broadcast and replayed by the
same hash after lost replies. Actual receipt costs, including reverted gas,
are recorded exactly once. Reset preserves v2 job history and cannot erase
pending transactions or debt. Run one wallet process per data directory;
a process lock prevents two workers from allocating the same sponsor nonce.

See [the implementation and rollout notes](docs/eth-gas-recovery.md) for
configuration, existing-job handling and verification requirements.

## The app: one screen, three tabs

The wallet is laid out like a phone wallet and installs as one (manifest,
icons, a service worker that never caches `/api`). Everything signed-in
lives inside `#view-wallet`, so the landing and recovery views are unchanged
and `show()` still hides the lot with one attribute.

| tab | what is on it |
|---|---|
| **Home** | total in dollars, a KOIN tile and a VHP tile, your short address (tap to copy), the protection line, Receive · Send · Buy, the token list (KOIN, VHP, any token you add by contract address) and, once funding is on, the "Waiting to convert · Ethereum" rows |
| **Buy** | the Fund card as three steps — Deposit (QR + address + the custody note), Convert (amount, routes, best marked), Land (progress, the passkey landing button). A green dot on the tab while a job runs; it pulses when a tap is needed |
| **Security** | a Protection meter and checklist (passkey · backup passkey · recovery kit, each tappable), the Account card (full address, network, explorer, Show QR), Backups (unchanged), the App card (install / offline), the explainer and Sign out |

Four bottom sheets do the rest: **Token** (balance, price, mana for KOIN,
contract, explorer, Receive / Send), **Send** (To with Paste and Scan,
Amount with Send all, a live "You will sign" summary with the full grouped
address, then the passkey button), **Receive** (QR + address + copy/share,
optional amount), **Add token**. One sheet at a time; Escape, the scrim, the
handle, the X and Done all close it and hand focus back. The camera overlay
sits above the sheets so Scan works from inside Send.

Numbers never lie about money: an unknown price is "—" (never $0.00), the
hero shows the KOIN balance itself when there is no dollar price, a partial
total says so, stale prices carry a clock, and a failed refresh keeps the
last good screen with "showing balances from HH:MM". Demo mode tags the hero
with SAMPLE PRICES and the Buy tab with SIMULATED.

**Deep links** (the home-screen shortcuts): `/?open=receive`, `/?open=send`,
`/?tab=convert` — applied once the wallet is open, then scrubbed from the URL.

**Id contract.** `app.js` and `fund.js` look elements up by id at boot;
`tests/dom-ids.test.js` pins every one of them to exactly one element, the
script order (`webauthn-wire → passkey → recovery → fund → qr → receive →
portfolio → ui → app`) and the z-order tokens. `public/js/ui.js` owns the
shell (`UI.showTab`, `openSheet` / `closeSheet`, `toast`, `paintPortfolio`,
`paintProtection`, `applyIntent`, `setContext`); it never writes
`#btn-send.disabled` (that stays with `setStep`) and never invents a number
(`portfolio.js` formats them).

**Add to Home Screen.** The wallet is a PWA (manifest, icons, a service
worker that keeps the shell available offline and never caches `/api`). Opened
in a browser rather than from the home screen, it pops up an install sheet:
Chrome on Android and desktop get a real *Add to Home Screen* button that
triggers the native install dialog (`beforeinstallprompt`), iOS Safari (which
has no install API) gets the three-step Share → Add to Home Screen recipe, and
other Android browsers get the menu recipe. "Not now" is remembered for three
days (`bw_install_snooze`); an installed app never asks again
(`bw_installed`, or `display-mode: standalone`). The same button lives in
Security → App. It pops up on the landing page on purpose: an account created
inside the installed app has its passkey there from day one.

## Android app

The Android APK is a **Trusted Web Activity** at
`https://koinvault.app/android/`. It provides Home, Send, Receive and
Security, with no Buy or conversion functionality. The normal website and
installed PWA at `/` retain Buy. Both use the same origin and passkeys, so
existing accounts work in either version.

The server removes web-only markup and the funding script from the Android
page. Android requests use `/android/api/*`; funding routes and funding-step
submission are rejected on that surface. The launcher only accepts wallet
intents (Send, Receive, Security), and App Links claim only `/android/`.
Separate service workers prevent Android from showing the website Buy page
offline. No shared cookie or storage setting disables Buy in a browser/PWA.

Deploy the server changes before distributing the new APK/AAB. Users need the
new Android build; older builds can retain old pages or pinned shortcuts until
updated. The legacy `source=twa` entry redirects to `/android/`. Pending web
conversions remain available in the browser; the APK does not manage them.
See `android/README.md` for the release checks and `play/README.md` for listing
copy that matches the wallet-only build.

**Getting it on a phone.** Every successful build on `main` refreshes the
`android-latest` pre-release, so the newest APK is always at

    https://github.com/therexdev/koin-vault/releases/download/android-latest/bio-wallet.apk

Open that on the phone, allow installs from the browser when asked, done.
The `Android app` GitHub Actions workflow builds it: every push to `main`
that touches `android/` (or a manual run from the Actions tab) produces the
APK plus the `.aab` Play Console wants, both also attached to the run as an
artifact (a zip, so on a phone prefer the release link). Locally, with an
Android SDK: `cd android && gradle assembleRelease`.

**"App not installed".** Android's one-size message. In practice it means
one of: a build signed with a *different key* is already installed
(uninstall KOIN Vault first, then install; see signing below), you opened the
`.aab` (phones install the `.apk`), the download was cut short, or the phone
blocked the install (Settings → Apps → Special app access → Install unknown
apps). `adb install bio-wallet.apk` on a computer prints the exact reason.

**Signing.** With no secrets the build is signed by a *debug* key: installable
by hand, but **Play rejects it** ("signed in debug mode") and it does not match
the site's asset links. CI caches that key between runs so newer builds install
over older ones, but the cache can be evicted, after which phones must
uninstall once.

For a real key, make one **once** and keep it forever — losing it means a new
app identity on every phone, and an app on Play that can never be updated
again.

### Signing, in one command

In a codespace (Code → Codespaces → Create codespace on main):

```bash
bash android/tools/setup-signing.sh
```

It makes the key if there isn't a usable one, then writes all four secrets
to GitHub itself with `gh` — nothing is copied by hand, which is where every
previous attempt failed: 5,700 characters of base64 dragged out of a wrapped
terminal line (a short copy decodes with no error and yields a corrupt
keystore), and a password that arrived with a trailing newline. It decodes
its own base64 back into an identical keystore before sending, so CI is never
the first thing to discover a bad value.

If `gh` lacks permission to write secrets it says so and prints the one-time
`gh auth refresh -h github.com -s repo` to fix it.

**A new key is free until the first Play upload.** Only after the app is
published does the key become permanent — before that, a key whose password
is lost is replaced rather than recovered, and the script does exactly that.
Back up `~/koinos-bio-wallet-release.jks` and
`~/.koinos-bio-wallet-keystore-password` once you have published.

The manual route below still works and is what to read if you want to know
what the script is doing.

### Making the signing key by hand

You need a shell, and GitHub gives you one in the browser. Nothing is
installed locally.

1. Go to <https://github.com/therexdev/koin-vault>.
2. Green **Code** button → **Codespaces** tab → **Create codespace on main**.
   A VS Code window opens in the browser; give it a minute.
3. In the terminal panel at the bottom, type this and press Enter:

   ```bash
   bash android/tools/make-keystore.sh
   ```

4. It prints a numbered list. Follow it: four secrets to paste into
   **Settings → Secrets and variables → Actions**, then the file to download
   as your backup.

   Three of the four are short. The fourth, `ANDROID_KEYSTORE_BASE64`, is
   about 5,700 characters, so the script writes it to `KEYSTORE_BASE64.txt`
   rather than to the terminal: **open that file and press Ctrl-A, Ctrl-C**.
   Do not drag-select it. A base64 paste that stops short decodes with no
   error whatsoever into a corrupt keystore, and the build fails much later
   with `toDerInputStream rejects tag type -46`, which names nothing. `rm
   KEYSTORE_BASE64.txt` when the secret is saved; to get it back later,
   `bash android/tools/print-keystore-secret.sh`.

   The build now checks the decode before compiling anything and says which
   of the three it is — truncated paste, wrong password, or wrong alias.
5. Download the key. The Explorer panel only shows the repository folder,
   and the key is deliberately written *outside* it — so bring it in for a
   moment, download it, and put it back:

   ```bash
   cp ~/koinos-bio-wallet-release.jks .        # now visible in the Explorer
   ```

   Right-click it in the Explorer → **Download**. Then:

   ```bash
   rm koinos-bio-wallet-release.jks            # tidy up; the original is still in ~
   ```

   Copying it in is safe — `*.jks` is ignored at the repository root, so git
   will not track it (`git check-ignore -v koinos-bio-wallet-release.jks`
   proves it). Keep the downloaded file and its password somewhere you will
   still have in five years.
6. Delete the codespace when finished (github.com/codespaces → **...** →
   *Delete*). The key is already in the secrets and in your download.

The script writes the key **outside** the repository and refuses to write
inside it, because this repository is public and a committed keystore hands
the app's identity to anyone who looks. `*.jks`, `*.keystore` and `*.pepk` are
ignored at the root and in `android/` as a second line of defence.

The password is generated rather than chosen: it is only ever copied from that
output into a GitHub secret, so there is nothing to invent and nothing to
guess.

Adding `ANDROID_KEYSTORE_BASE64` is what flips the build — `HAS_RELEASE_KEY`
in the workflow is exactly `secrets.ANDROID_KEYSTORE_BASE64 != ''`.

**Losing the URL bar (Digital Asset Links).** Chrome hides the browser UI only
when the site vouches for the app: `/.well-known/assetlinks.json` must name
the package and the SHA-256 of the certificate that signed the installed
build. The workflow prints that fingerprint in its job summary; put it in
`ANDROID_SHA256_FINGERPRINTS` on the server (comma-separate several — the
upload key *and*, once published, the Play app-signing key from Play Console →
App integrity) and restart. Until then the app still works, just with the
URL bar. Check with `curl https://koinvault.app/.well-known/assetlinks.json`.

**Play Store.** Upload the AAB, fill in the listing (the app is a wallet, so
expect the finance/crypto questionnaire and a privacy policy URL), and add the
Play app-signing fingerprint to the variable above. `related_applications` in
the web manifest already points at the package, so Chrome can offer the Play
listing once it exists.

## Honest mana economics

| action | burns (≈) |
|---|---|
| shared infrastructure (once) | 160 mana |
| **each new account** | **85 mana** (the 97KB contract upload + module setup) |
| each passkey-verified transfer | 1–10 mana (on-chain P-256 costs more than a plain transfer) |
| registering a backup credential | 1–5 mana |

Mana regenerates ~20%/day of KOIN held. A sponsor holding **200 KOIN** can
mint 2 accounts immediately and roughly one more every two days sustained —
fine for a playground; scale the sponsor with adoption. Guardrails:
`MAX_ACCOUNTS_PER_DAY` per IP (default 3), `MAX_ACCOUNTS_PER_DAY_GLOBAL`
(default 20), `MIN_CREATE_MANA` floor (default 120), per-address/IP transfer
budgets, and a sponsor mana floor for sends.

## Run it

Node 20.19 or newer (the Solana rail's packages need it; `engines` says so).

```bash
npm install
npm start            # http://localhost:3000 — DEMO mode until configured
npm test             # wire format, recovery kit, ETH parity, pre-flight, gifts, send helpers
```

Demo mode is fully interactive: the passkey ceremonies and signature packing
are real (the server verifies every packed signature exactly like the live
path); only the chain is simulated.

### Go live (once)

```bash
# 1. Sponsor (mana sharer) — writes wallet.env, chmod 600
node tools/keygen.js                     # or SPONSOR_WIF=<wif> node tools/keygen.js
#    …fund the printed address: 150–200 KOIN recommended (see economics above)

# 2. Infrastructure keys — writes wallet-infra.env, chmod 600
node tools/infra-keygen.js

# 3. Build the sign module + deploy the three shared contracts (~160 mana)
cd contracts/mod-sign-webauthn-as && npm install && cd ../..
KOINOS_NETWORK=mainnet node tools/infra-deploy.js
#    …verifies itself: reads module manifests back and has the DEPLOYED
#    verifier verify a real WebAuthn assertion before declaring success.
#    Prints the three *_ADDR values for the server environment.
```

### Serve

```bash
KOINOS_NETWORK=mainnet \
SPONSOR_WIF=…            # from wallet.env
VERIFIER_ADDR=…          # the three addresses infra-deploy printed
MOD_SIGN_WEBAUTHN_ADDR=… \
MOD_VALIDATION_SIGNATURE_ADDR=… \
node server.js
```

### Environment variables

| var | default | meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `KOINOS_NETWORK` | `harbinger` | `harbinger` or `mainnet` |
| `KOINOS_RPC` | *(probe list)* | own RPC endpoint(s), comma-separated by priority |
| `SPONSOR_WIF` | — | the mana sharer — pays for bootstraps and transfers |
| `VERIFIER_ADDR` | — | deployed P-256 verifier (infra-deploy) |
| `MOD_SIGN_WEBAUTHN_ADDR` | — | deployed WebAuthn sign module (infra-deploy) |
| `MOD_VALIDATION_SIGNATURE_ADDR` | — | deployed signature validator (infra-deploy) |
| `PASSKEY_RPID` | `koinvault.app` | WebAuthn relying-party ID for this deployment. Existing old-domain passkeys require migration; see the deployment guide. |
| `DATA_DIR` | `./data` | account store location. Set `../bio-wallet-data` on Hostinger — a relative value resolves against the app folder, so that lands just OUTSIDE the checkout and survives redeploys |
| `TRUST_PROXY_HOPS` | `0` | proxy hops in front (Hostinger = 1) for real client IPs |
| `MAX_ACCOUNTS_PER_DAY` | `3` | account creations per IP per day |
| `MAX_ACCOUNTS_PER_DAY_GLOBAL` | `20` | account creations per day, total |
| `MAX_CREDENTIALS_PER_ACCOUNT` | `32` | passkeys + recovery kits per account |
| `MIN_CREATE_MANA` | `120` | refuse signups when sponsor mana is below this |
| `MAX_TRANSFERS_PER_DAY` | `30` | per-address daily transfer budget (per-IP is 2×) |
| `MIN_SPONSOR_MANA` | `5` | refuse transfers when sponsor mana is below this |
| `ETH_RPC` | *(public list)* | Ethereum RPC endpoint(s), comma-separated by priority |
| `ETH_GAS_SPONSOR_KEY` | — | Ethereum key that fronts gas for stablecoin-only and SOL deposits (optional) |
| `ETH_GAS_TOPUP` | `0.0015` | legacy setting; new jobs calculate the bootstrap shortfall |
| `FUND_MAX_ETH` | `0.1` | per-swap ETH cap on the funding rail |
| `FUND_MAX_STABLE` | `150` | per-swap USDC/USDT cap (USD) |
| `FUND_SLIPPAGE_BPS` | `150` | slippage floor for every funding swap (1.5%) |
| `SOLANA_RPC` | *(public list)* | Solana RPC endpoint(s), comma-separated by priority — the public one is rate-limited, set your own |
| `JUPITER_API` | *(lite, keyless)* | Jupiter swap API base; set with `JUPITER_API_KEY` for the keyed `api.jup.ag` tier |
| `JUPITER_API_KEY` | — | Jupiter API key (optional) |
| `FUND_FEE_PCT` | `1` | conversion fee, as a percentage of the amount |
| `FUND_FEE_BUFFER_PCT` | `20` | legacy fee accounting only; new plans explicitly budget recovery transactions |
| `FUND_FEE_WARN_USD` | `10` | a fee at or above this is flagged on the card, not just noted |
| `FUND_FEE_WARN_PCT` | `10` | so is one that is this share of the conversion |
| `FUND_FEE_MAX_SPONSORED_USD` | `20` | the float will not lend more than this to a single conversion; past it the deposit address must hold its own ether |
| `FUND_FEE_TREASURY` | *(the sponsor)* | ETH platform-fee recipient only when no sponsor is configured; sponsored jobs repay their pinned funding address |
| `FUND_SPONSOR_MIN_ETH` | `0.002` | protected ETH balance below which new sponsorship is refused |
| `FUND_SPONSOR_MAX_ETH` | `0.005` | maximum sponsor exposure for one accepted job, also subject to the USD cap |
| `FUND_SPONSOR_MAX_OUTSTANDING_ETH` | `0.02` | maximum total debt plus unspent sponsorship commitments |
| `FUND_SPONSOR_RISK_BPS` | `2000` | disclosed risk charge on actual sponsor cost (20%); separate from platform fee |
| `FUND_GAS_HEADROOM_BPS` | `2000` | gas-unit headroom (20%) within the accepted plan |
| `FUND_GAS_PRICE_HEADROOM_BPS` | `2500` | gas-price headroom (25%) in the quote ceiling |
| `FUND_QUOTE_TTL_SECONDS` | `60` | time to accept an initial fee quote |
| `FUND_ETH_CONFIRMATIONS` | `2` | confirmations before recording Ethereum delivery and repayment |
| `FUND_MAX_SOL` | `1` | per-swap SOL cap on the Solana rail |
| `FUND_MIN_SOL` | `0.05` | smallest SOL swap the rail accepts (Ethereum gas sets the floor) |
| `SOL_RESERVE` | `0.01` | SOL held back at the deposit address for fees and account rent |
| `DEMO_MODE` | — | `1` forces demo mode |
| `ANDROID_SHA256_FINGERPRINTS` | — | SHA-256 fingerprint(s) of the Android app's signing certificate, comma-separated — serves `/.well-known/assetlinks.json` (see **Android app**) |
| `ANDROID_PACKAGE` | `wallet.koinos.app` | the Android app's package name |
| `DAPP_SPONSOR_MANA_PER_DAY` | `5000` | shared UTC daily dApp sponsorship ceiling, in whole mana |
| `DAPP_SPONSOR_MANA_PER_ACCOUNT_DAY` | `500` | per-account UTC daily sponsorship ceiling |
| `DAPP_SPONSOR_MANA_PER_SITE_DAY` | `1000` | per-origin UTC daily sponsorship ceiling |
| `PUBLIC_URL` | `https://koinvault.app` | canonical wallet origin used in connection QR codes (recommended behind a proxy) |

## Connect to Koinos apps

Connection approvals require a fresh WebAuthn assertion, checked for origin, relying-party ID, user presence and user verification. The server reads the account's registered public key from the blockchain and verifies the P-256 signature locally: running the WASM signature verifier in a public RPC read can exceed its compute limit. Browser-supplied or cached keys are never accepted. Transaction signatures still receive on-chain verification. Challenges expire after two minutes and can be used only once. Read failures refuse the connection. Existing connections must be paired again after this update. Opening the wallet starts at the passkey unlock screen; restoring an address does not unlock it. New transaction requests open the Security tab and focus the approval card while the wallet is visible. Browsers cannot automatically foreground a closed or background mobile app: reopen KOIN Vault to receive pending requests. Recovery mode cannot connect or approve dApp requests.

The Home screen's **Connect** button scans an expiring QR code from any HTTPS
website. The QR contains a random session ID and bearer secret, never a key or
reusable signature. The user sees the exact origin and decides whether to share
an address and allow transaction requests. This does not endorse the website.

KOIN Vault decodes operations itself, showing full contract and recipient
addresses, amounts, spending permissions, the configured network, mana payer
and signed maximum. Site-provided descriptions cannot replace this review.
Unfamiliar actions show their raw arguments and require acknowledgement;
spending permissions warn that later token spends may not need another passkey.
Each requested transaction requires a fresh passkey assertion.

Native KOIN/VHP actions using the connected account's authority and supported
PoB combinations are eligible for capped sponsorship. Arbitrary/custom contract
calls use the user's own mana and receive no Vault sponsor signature. Native
requests also require freshly verified standard account code and modules;
modified accounts use their own mana. The signed account nonce is rechecked.
Native requests also use the user's mana if sponsor capacity or daily budgets are
unavailable. The payer is chosen before signing and never silently changed
later. The persistent daily budget charges each signed maximum, including
failed or uncertain submissions. See the integration guide for exact limits.

Sessions last 30 minutes and requests at most 10 minutes. The user can reject,
disconnect, or block a site's exact origin for the current wallet on this device.
Blocked sites persist locally and can be unblocked under Security; they do not
sync across devices.
Wallet-side disconnect revokes the relay session before reporting success. A failed
network request keeps the connection available for retry. OURO and Trade Koinos
check their active sessions every two seconds and on tab focus, visibility return,
or network reconnection, clearing the website's wallet address and session when
revoked. Suspended tabs update when reopened. Other integrations should check
`GET /api/dapp/status` with their session ID and secret: HTTP 404/410, a disconnected
session, or a changed address ends the connection. Network errors and 5xx responses
should be retried without treating them as a user-requested disconnect. The shared
backend's existing revocation API is unchanged.


OURO paid launches use the separate `/api/dapp/launch` endpoint. Only OURO's
allowed origins can request this flow. It accepts exactly a KOIN launch-fee
transfer and a new collection upload, already signed by the collection key.
Vault checks the network, transaction hash/operation commitment, fee owner,
collection signer and a maximum 200-mana ceiling paid by OURO. The approval
card shows the exact fee, recipient and collection. A fresh registered
passkey signs the transaction; Vault returns that signature without sending
the transaction. OURO independently verifies it, adds its sponsor signature,
and broadcasts fee and upload together. Ordinary dApp requests still reject
contract uploads. Deploy both repositories before testing a paid launch.

The old `DAPP_ORIGINS` setting is no longer used. CORS reflects valid HTTPS
origins for website endpoints; wallet approval endpoints remain wallet-only.
Session secrets, matching origins and passkey verification are required independently.

Missing sponsor **or** module addresses ⇒ the app boots in demo mode and says
why on `/api/config`.

### Deploy at koinvault.app (Hostinger)

Follow [the deployment guide](docs/koinvault-deployment.md). For this migration,
reuse the existing environment secrets, contract addresses, and account data.
Set the new domain defaults and a separate persistent DATA_DIR. Do not generate
new keys or redeploy contracts. Exclude the old process lock when copying data
while the old deployment is stopped.

**Redeploying, and checking what is actually live.** Nothing in this repo
pushes to the host; Hostinger pulls. So after a push, redeploy there — and
when a release adds dependencies (the Solana rail added five), the deploy must
run `npm install` and then RESTART the Node app, or the old process keeps
serving. `/api/config` reports what is running:

| field | meaning |
|---|---|
| `version` | the `package.json` version of the running code |
| `commit` | the commit it was built from (absent if the deploy strips `.git`) |
| `solRail` | whether the optional Solana packages are installed here |

**The Solana side needs no packages.** The transfer instruction, the
transaction, the signature and the VAA are all built directly, in
`tools/sol/*-lite.js`, on plain JSON-RPC and Node's own crypto. The Solana and
Wormhole libraries are devDependencies used only to check that work: the tests
generate the same instructions, transactions and VAAs both ways and require
the bytes to be identical. So the rail runs on any Node 18 and cannot be
switched off by an install that skipped something — which is what kept it dark
in production for a day.

`SOLANA_RPC` is effectively required: the public endpoint refuses datacenter
traffic (HTTP 403) and rate-limits the rest, so without your own endpoint the
SOL balance cannot be read. The wallet says exactly that on the card rather
than showing nothing.

### Checking the settings actually took

    https://<host>/api/health?rail=1

The `rail.caps` field reports the active per-swap ETH, stablecoin and SOL limits,
including any `FUND_MAX_*` environment overrides.

Both RPC settings fall back to public endpoints when they fail. That is right
for a deposit that must not go dark, and it makes a mistyped key invisible:
the wallet keeps working on public nodes until they start refusing traffic,
and the only symptom is intermittent failure weeks later. So this probes each
endpoint you configured **on its own** — a healthy fallback cannot disguise a
broken setting — and reports for each of `ETH_RPC`, `SOLANA_RPC` and
`ETH_GAS_SPONSOR_KEY`:

* whether you set it at all, or the rail is quietly on the public list;
* whether your endpoint answered, and how fast;
* for the sponsor: its **address**, its balance, what the float needs, and
  whether it is healthy — the address is reported even when the node read
  fails, because that is when you most need to know where to send ether.

No passkey: checking your own deploy should not need an account. Nothing
secret is in the answer either — an RPC key lives inside the URL and RPC
errors love to echo the URL back, so only the **host** is ever reported and
every message is stripped of anything URL-shaped first. `tests/rail-health.test.js`
serves the 403 from a stand-in that echoes a key-bearing URL and asserts none
of it survives.

A server in demo mode says so here instead, because in demo no setting means
anything — which is also the fastest answer to "why am I seeing sample
prices".

The deposit address is an ed25519 public key in base58, which Node's own
crypto makes (`tools/sol/keys.js`), so every account has one from birth and
the Buy tab always shows it.

If `commit` does not match `git rev-parse HEAD`, the deploy did not take. The
service worker is network-first and never caches `/api`, so a stale screen is
always the server, never the browser cache. The Solana rail needs Node 20.19+
for its Wormhole packages; everything else runs on Node 18, and where the
packages are missing or unusable the rail reports itself off and the rest of
the wallet is unaffected.

WebAuthn requires HTTPS (any real domain qualifies; `localhost` works for dev).

## Security model

- **Your authority**: a P-256 keypair inside your device's secure hardware,
  registered on-chain as the account's credential. Assertions are verified by
  the chain; the server's checks are merely a courtesy pre-flight.
- **The server holds**: the sponsor key, and each account's bootstrap key
  (`data/accounts.json`, mode 600) — powerless after bootstrap, kept to heal
  interrupted signups. It cannot move an active account: with the validator
  installed, the chain accepts only passkey-signed transactions.
- **Recovery**: passkeys sync via iCloud Keychain / Google Password Manager,
  and the account survives any single loss once a backup passkey or the
  recovery kit is registered (see *Backups* above). Nudge users to add one —
  a single credential is a single point of failure.
- **Send-path hardening** (learned on mainnet): ambiguous node replies are
  arbitrated by a mined-poll; RPC failover; error bodies unwrapped; and the
  sponsor's signature is ordered BEFORE the WebAuthn blob — the chain's payer
  check walks signatures in order and must match the sponsor before touching
  the non-secp entry.

## What happened to v1 (PRF wallets)?

v1 derived a secp256k1 key from the passkey's PRF extension. This rework
replaces it with the real thing — accounts as contracts, per the Veive
concept. If you made a v1 wallet: the same passkey still opens that same
PRF wallet on [usekoinos.com](https://usekoinos.com) (shared salt + apex
rpId), or import the WIF you exported. This app's passkeys are now scoped to
its own hostname and its accounts live on-chain.


### Independent KOIN Vault backend

KOIN Vault now runs its own account, token, app-connection and funding APIs by
 default. It does not require the old wallet deployment or repository.
Use `WALLET_BACKEND_URL=local` and a dedicated persistent `DATA_DIR`.
Existing registered Vault passkeys and activated recovery kits can rediscover
accounts through the blockchain's credential index using the same network and
smart-account module addresses. Old-domain passkeys remain domain-bound.

See [standalone deployment](docs/koinvault-deployment.md) before switching hosting.
An explicitly configured HTTPS `WALLET_BACKEND_URL` still enables legacy proxy
mode; remove that override or set it to `local` to complete the separation.

The **Create Account or Sign In** button opens the remembered passkey or creates
a wallet when none is remembered. **Choose a saved passkey** opens the picker
for an existing wallet on another device. Failed sign-in never switches to
account creation. Recovery kits download as `.txt` files, with a persistent
download link for the same kit until activation or discard. A configuration
outage displays a retrying connection message instead of claiming the wallet
is in demo mode. Public Koinos and ETH health probes no longer
block local initialization or sign-in configuration.


## Installation and phone passkeys

The landing page includes **Install KOIN Vault**, available before sign-in.
The browser's install event is captured in the head script so slow application
startup cannot lose it. Automatic navigation no longer snoozes the install
sheet; only an explicit dismissal does. Historical `bw_installed` flags do not
permanently hide the offer after uninstalling. When no native prompt is
available, the button shows the browser's installation instructions. APK and
standalone app windows do not show the PWA offer.

**Use a phone** opens sign-in and account-creation choices. The app requests
WebAuthn hybrid authentication so a supporting browser can display its phone
pairing QR code. Keep Bluetooth enabled on both devices and use the phone's
camera to scan the browser's code. Browser/OS support and wording vary; some
platforms require selecting **Use a phone or tablet** first. The QR code and
pairing are managed by the browser. No private key is copied to the desktop.

A missing local authenticator no longer disables WebAuthn. Phone-backed
credentials continue to request phone approval for transactions, with user
verification required. Unknown or cancelled phone sign-in never falls back to
creating another account. The main combined account button remains available.

References: [PWA installation](https://web.dev/learn/pwa/installation-prompt),
[WebAuthn hybrid hints](https://developer.chrome.com/blog/passkeys-updates-chrome-129).

### Koinos AI producer signing

Koinos AI Test can pair with Koin Vault using **Connect App** and a QR code.
Its origin is `https://koinosai.com`; no manual origin approval is required.
`/api/config` advertises `features.kaiProducer` when Vault uses live Mainnet.

KAI requests only PoB hot-key registration, a burn to the connected wallet's
own VHP, or a KOIN/VHP transfer. The backend decodes the actual operations to
show the producer, full hot public key, amount and recipient before passkey
approval. It rejects unrelated calls and excessive burn allowances. Wallet
approval uses capped sponsorship when available, otherwise the wallet's own
mana, with the payer shown before signing. The phone never exports a private key. Disconnecting cancels unsubmitted
requests, but cannot undo transactions already submitted to the chain.

### Use Koinos QR connection

Both `https://usekoinos.com` and `https://www.usekoinos.com` can request
connections without configuration. Each origin creates and uses its own sessions.
Deploy the updated standalone Vault backend for open connections; a frontend
proxy cannot add this behavior to an unchanged upstream.
The browser first calls `/api/dapp/create`, then renders the returned pairing URI
as a local QR code, just like OURO and Trade Koinos. A preflight response without
`Access-Control-Allow-Origin` for the requesting site produces “Failed to fetch”
before the QR can appear. Do not solve this with a wildcard or by substituting
another application's Origin.
