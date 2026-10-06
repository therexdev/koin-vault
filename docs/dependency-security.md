# Dependency patch — 2026-10-06

The six Hostinger findings are addressed in the root dependency tree:

- `toml` 3.0.0 → 4.2.0 covers CVE-2026-77465 and CVE-2026-63376.
- `uuid` versions below 11.1.1 → 11.1.1 covers CVE-2026-41907; the existing
  14.0.2 dependency remains unchanged.
- `jayson` 4.3.0 → 5.0.0 removes `stream-json` and its dependency chain,
  addressing CVE-2026-104182, CVE-2026-104183 and CVE-2026-71429 without
  forcing a CommonJS consumer to load the ESM-only stream-json 3.x API.

These dependencies come from the development/reference Solana and Wormhole
SDKs. Live Solana operations use the existing lightweight implementations.
The regenerated lockfile also corrects stale production/development markings
so it agrees with package.json. Ethereum and Koinos runtime versions remain
unchanged. The 10,000 KOIN sale limit and all transaction code are unchanged.

Use Node 22 as already configured on production. `npm ci --omit=dev
--ignore-scripts` installs the production dependency set. Full SDK installs
use `npm ci --include=dev --ignore-scripts`; native install scripts are not
needed for reference tests. CI validates SDK imports, a mocked Solana RPC
request, UUID bounds, TOML parsing and byte-for-byte Solana/Wormhole parity,
in addition to the existing complete wallet suite.

`npm audit --omit=dev` reports zero vulnerabilities for this patch. Full audit
still reports GHSA-3gc7-fjrx-p6mg in dev-only `bigint-buffer` 1.1.5 (plus its
five dependent packages); npm reports no upstream fix. This is separate from
the six Hostinger findings. It is excluded from production-only installation;
the reference CI job disables native install scripts and uses the JavaScript
fallback. This is not a claim that the development dependency is patched.

After deployment, Hostinger must run a new vulnerability scan to replace its
previous findings. A scanner result is not proof of wallet exploitation.
