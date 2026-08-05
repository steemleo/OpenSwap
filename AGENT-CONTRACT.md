# OpenSwap CLI — agent contract

You are driving `openswap`, an open-source crosschain swap CLI (30+ chains)
by LeoDex, powered by the LeoKit API. This file is the complete machine
contract — print it any time with `openswap agent docs`.

## Invocation & environment

- The binary is `openswap` on PATH (or `npx -y openswap@latest`). Never build from
  source, never explore a repository to "find" the CLI, never run bare
  `--help` exploration — this contract is complete.
- Zero-config: a built-in community key works immediately. A user's own key
  (env `OPENSWAP_API_KEY`, or `openswap auth login`) routes affiliate fees
  to them; they create one free at https://dash.leokit.dev. Never send a user
  to leodex.io for a key — that is the consumer swap app, not the API console.

## Output contract

Every command accepts `--json`: exactly one envelope on stdout, diagnostics on
stderr. Envelope: `{schema_version: "1", command, ok, data | error, warnings, meta}`
(`warnings` on success envelopes). On `ok: false`, `error` has `code`,
`message`, `retryable`, `funds_may_have_moved`, and `actions[]` — runnable
next commands; use them instead of diagnosing from scratch.

**`watch` is the one exception**, because it is a live feed rather than a
request: under either `--json` or `--jsonl` it streams one JSON object per
line — `{type:"stream_init"}`, then a `{type:"quote"}` per route, then
`{type:"stream_done"}`. Read it line by line; do not wait for a single
envelope, because there isn't one. Every other command, including a failing
`watch` invocation, follows the envelope rule above.

Exit codes (frozen): `0` success · `1` internal · `2` usage/validation ·
`3` auth/config · `4` no-route or policy rejection · `5` retryable upstream ·
`6` signer · `7` broadcast · `130` interrupted.

## Financial rules (non-negotiable)

1. Never invent routes, fees, prices, statuses, or addresses — only report
   fields returned in `data`. A `null` fee is "not priced", never zero.
2. Amounts are decimal strings ("100"), never base units, never floats.
3. Assets: `chain:symbol` (`base:USDC`), natural speech (`"usdc on base"`),
   or canonical `CHAIN.SYMBOL-ADDRESS`. Ambiguity errors list candidates.
4. Quotes expire in ~30 seconds — re-quote rather than reuse stale data.
5. `openswap swap` creates a real deposit address (state-changing): get the
   user's explicit confirmation of amount + destination first, then pass
   `--yes`. `--to-address` and `--refund-address` must come from the user.
6. `supports_deposit_address` in quote output is tri-state: `null` means
   "determined at swap time" — never claim a route can't execute based on null.
   For execution, quote with `--deposit` (executable routes only) and prefer
   omitting `--protocol` on `swap` so the CLI picks an executable route;
   pinning a protocol from a plain quote can exit 4 (cleanly, nothing paid).
7. The user pays from their own wallet. You never touch keys or seeds.
8. `funds_may_have_moved: true` → stop, run `status`, never blindly retry.

## Presentation contract

Be compact. One line per route: `protocol — receive (~$usd) · fees $x · ~eta`,
mark the leader, then ask ONE question collecting route choice + both
addresses. After `swap`, always show: full `deposit_address`, exact
`amount_display` + asset, `source_network`, expiry, `receipt_id`, and the
track command. Do not re-render large tables or add editorial commentary.

## Test mode (verify without funds)

Set `OPENSWAP_TEST_MODE=1` and every command runs against a simulated
backend through the unchanged production code paths — same JSON envelopes,
same exit codes, `meta.environment: "simulated"`, receipts prefixed `ost_`.
Deposits auto-pay in seconds; `OPENSWAP_TEST_TIMESCALE=100` compresses a full
paid-to-success story to under a second; magic amounts steer outcomes
deterministically (`.13` → failed, `.19` → refunded, `.07` → short deposit
window, `.62` → the backend claims an unverifiable success and status
reports it as `pending` with `claimed_state`/`implausible` set). Use it to
verify a full swap end to end before touching real funds:

```bash
OPENSWAP_TEST_MODE=1 OPENSWAP_TEST_TIMESCALE=100 openswap swap \
  -a 25 -f eth:usdc -t base:usdc \
  --to-address 0x1111111111111111111111111111111111111111 \
  --refund-address 0x2222222222222222222222222222222222222222 --yes --json
# then: openswap status <receipt_id> --json   → data.state: "success"
```

Never claim a REAL swap happened from a simulated run: check
`meta.environment` before reporting.

## Recipes

```bash
# Compare routes (read-only, safe). Add --deposit when the goal is to
# EXECUTE: it filters to routes the swap command can actually run.
openswap quote --json --deposit -a 100 -f arb:USDC -t btc:BTC

# Execute after user confirmation (returns payment_request + receipt_id)
openswap swap --json --yes -a 100 -f arb:USDC -t btc:BTC \
  --to-address <USER_DEST> --refund-address <USER_SOURCE_WALLET>

# Track (terminal states: success | failed | refunded | deposit_expired)
# deposit_expired = the payment window closed unpaid. It is terminal and
# sticky, so stop polling; if the user paid late, `status --watch` picks it up.
# A backend-reported terminal that fails the CLI's corroboration checks is
# NOT emitted as terminal: data.state stays "pending" with the claim under
# data.claimed_state and reasons under data.implausible (stable codes) plus
# envelope warnings. Keep polling or escalate — never report it as success.
openswap status <receipt_id> --json

# Live prices for strategies
openswap watch -a 100 -f arb:USDC -t btc:BTC --jsonl

# Policy-gated automation (simulates unless --live)
openswap bot check --policy openswap-policy.json --json -a 100 -f arb:USDC -t btc:BTC --to-address <DEST>
openswap bot run   --policy openswap-policy.json --json -a 100 -f arb:USDC -t btc:BTC --to-address <DEST> --live

# Discovery / diagnostics / feedback
openswap assets search usdc --json
openswap balances <address> --chains ETH,ARB,BASE --json
openswap doctor --json
openswap feedback --json --kind bug -m "<the user's own description>"
```

## Quote JSON field map

`data.routes[]` → `protocol` · `expected_receive.{display, usd_estimate,
base_units}` · `fees[]` + `fees_total_usd` (nullable) · `eta_seconds` ·
`expires_at` · `recommendation` · `supports_deposit_address` (tri-state).
Route `execution` field: `deposit_address` (default lane) · `wallet_signed`
(requires the user's signing wallet — suggest `openswap wallet setup`, an
interactive human-only flow; machine mode additionally requires
`--signer`; broadcasts real transactions — explicit user authorization only;
never handle keys) · `unsupported` (quote-only).
Deposit-lane swap result → `data.payment_request.{deposit_address, amount_display,
asset, source_network, expires_at, uri, memo}` + `data.receipt_id` +
`data.track_command`. Wallet-signed result → `data.{state:"executed", tx_hashes,
signer_address, receipt_id, track_command}`.
