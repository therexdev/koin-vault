# KAI Test: VHP production allowance

KAI's hot-key registration alone does not make a passkey account's validator
usable during block application. The reported node logs reach VHP burning and
fail inside the signature validator. The VHP contract checks a caller allowance
before falling back to account authority. A finite allowance to the canonical
PoB contract avoids that signature path during production without changing
account modules or giving the hot key transfer authority.

This companion change accepts only one canonical VHP approve operation, with
the connected account as owner and the fixed Mainnet PoB contract as spender.
It rejects the maximum uint64 allowance. The existing wallet review decodes the
actual owner, spender and amount and requires the user's normal passkey approval.
No approval is submitted automatically.

KAI Test probes VHP allowance support, limits the requested amount to the current
VHP balance, and checks `features.kaiProductionAllowance` before preparing. Entering
0 revokes the allowance; a positive value replaces its remaining amount. A user
must renew it if production exhausts it. Tokens added later do not increase it.

Release this wallet backend change before using the new action in KAI Test.
Existing accounts do not need a contract upload, module replacement or new key.
They must approve their own allowance on their phone. The KAI live alpha does not
need to be changed. No blockchain transaction was submitted during development;
real production still needs verification after the owner's approval.

Reference: https://github.com/koinos/koinos-contracts-as/blob/master/contracts/vhp/assembly/Vhp.ts
(`burn` and `_check_authority`). The runtime probe is required because source code
alone is not proof of which interface is deployed on a network.

## Manual burn with full allowance

KAI Test's manual Koin Vault burn now offers an enabled-by-default, visible
option to approve the full VHP balance including the newly burned amount. It
uses `[KOIN approve (if required), PoB burn, VHP approve]` in one atomic transaction.
The final approval must use the connected wallet and canonical PoB spender.
The wallet decodes both the burn amount and the exact replacement allowance.
The `kaiBurnFullVhp` feature flag prevents sending this to an older backend.

The total is a snapshot read during preparation, plus the KOIN burn amount.
Production or deposits while the phone review is open can change the balance;
the signed amount remains fixed. Burns outside this KAI flow and later deposits
do not automatically change permissions. The separate allowance action can be
used with “Use full VHP balance” to refresh the allowance without a burn.
