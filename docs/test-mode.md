# Test mode — the dry-run harness

Test mode is the full OpenSwap experience against a **simulated backend**:
real streaming-quote UX, deposit addresses, receipts, tracking — with
simulated wallets and balances. No real funds can move. It exists so you can
try the CLI risk-free, and so we (and CI, and AI agents) can run thousands of
end-to-end swap cycles when hardening a release.

```bash
openswap test on      # every command now runs simulated (TEST badge everywhere)
openswap swap         # the full funnel — deposits auto-pay after a few seconds
openswap test off     # back to live routes
```

`OPENSWAP_TEST_MODE=1` (or `=0`) overrides the toggle per invocation — handy
for scripts and CI without touching your interactive state.

## How faithful is it?

The CLI's production code paths run **unmodified** — the simulation happens at
the exact boundary where the real world begins. Quotes stream over the same
SSE framing, amounts arrive as the same >2^53 base-unit numbers, deposit
addresses pass the same validation gauntlet, and the wallet-signed lane does
**real keystore signing** against a local simulated chain (using the
industry-standard burned anvil test key — it never pairs with a real RPC).
Prices are a static snapshot with deterministic jitter, never live.

## What keeps it safely separate

- Simulated receipts are prefixed `ost_` with `environment: "simulated"`
  (JSON `meta.environment` says the same), and ALL test state lives in its
  own directory namespace — your real receipts and cache are untouchable.
- Every screen carries a **TEST** badge; the payment screen says SIMULATED
  and renders no QR (a scannable code for a fake address is the one artifact
  someone could actually pay).
- Test mode never contacts `api.leokit.dev`.

## Steering outcomes

Deposits auto-pay after ~8 seconds, or pay explicitly:

```bash
openswap test pay <receipt>       # simulate the user paying now
```

**Magic amounts** pick the story per swap (great for scripted runs):

| Amount ends in | Outcome |
| --- | --- |
| `.13` | protocol failure after payment |
| `.19` | swap refunds to sender |
| `.07` | short 15s deposit window |
| `.23` | slow confirmations |

Or set a default for every swap: `openswap test scenario refund` (one of
`happy`, `refund`, `fail`, `expire`, `slow`).

## The rest of the toolbox

```bash
openswap test status              # scenario, seed, balances, cheatsheet
openswap test fund BASE:USDC 500  # set a simulated balance
openswap test reset               # fresh world (respects OPENSWAP_TEST_SEED)
```

`OPENSWAP_TEST_TIMESCALE=50` runs the simulation 50× faster — a full
paid-to-success story compresses to under a second, which is how our CI runs
whole swap fleets. `OPENSWAP_TEST_SEED` makes **outcomes and amounts**
reproducible (addresses and stream timing intentionally vary). Simulated
swaps are stored one file per swap, so parallel fleet workers sharing one
machine won't clobber each other — though for fully isolated runs, give each
worker its own `XDG_DATA_HOME`.

## For agents

Machine mode works identically in test mode (`--json --yes`), every envelope
carries `meta.environment: "simulated"`, and outcomes are deterministic via
magic amounts. Before reporting a change "done", agents can self-verify the
full funnel end to end:

```bash
OPENSWAP_TEST_MODE=1 OPENSWAP_TEST_TIMESCALE=100 openswap swap \
  --from eth:usdc --to base:usdc --amount 25 \
  --to-address 0x1111111111111111111111111111111111111111 \
  --refund-address 0x2222222222222222222222222222222222222222 --yes --json
# then poll: openswap status <receipt> --json  →  state: success
```
