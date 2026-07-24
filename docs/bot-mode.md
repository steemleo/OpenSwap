# Bot mode

The core rule: **a script or an LLM may propose a trade; only your
deterministic policy may authorize one unattended.** Rejections are typed
(`POLICY_REJECTED`, exit 4) — treat exit 4 as a normal "no trade" outcome in
your loop, and exit 5 as backoff-and-retry.

## Policy file

`openswap bot init` walks you through building the policy interactively —
assets, the one destination address it may pay, USD ceilings, allowed routes —
then offers to test it against live routes on the spot. (In `--json`/CI mode it
scaffolds a template instead.) The result looks like:

```jsonc
{
  "version": 1,
  "name": "my-strategy",
  "mode": "enforce",                    // "monitor" logs violations without blocking
  "assets":       { "allow_from": ["ARB.USDC-0x…"], "allow_to": ["BTC.BTC"] },
  "protocols":    { "allow": ["chainflip", "near"] },
  "destinations": { "allow": ["bc1q…"] },
  "limits": {
    "max_trade_usd": 250,
    "max_daily_volume_usd": 1000,       // rolling 24h, tracked locally
    "max_total_fee_usd": 5,
    "max_quote_age_seconds": 20,
    "cooldown_seconds": 60
  },
  "kill_switch_file": "./STOP"          // touch this file → everything halts
}
```

Unknown values always fail closed: a trade with an unknown USD value or
unpriced fees is a violation when a limit depends on it.

## The loop

```bash
openswap watch -a 100 -f arb:USDC -t btc:BTC --jsonl        # 1. price feed (SSE)
openswap bot check --policy p.json … --json                  # 2. side-effect-free gate
openswap bot run   --policy p.json … --json                  # 3. SIMULATES by default
openswap bot run   --policy p.json … --json --live           # 4. executes
openswap status <receipt> --json                             # 5. track to terminal state
```

`bot run` quotes with your signer address bound, filters to allowed
protocols, evaluates the policy, fetches unsigned transactions, **simulates
every transaction**, and only broadcasts with `--live` — sequentially, waiting
for each receipt. Idempotency keys (auto-derived or `--idempotency-key`) make
retries replay the stored result instead of trading twice.

## Signer (opt-in, EVM)

| Env | Meaning |
| --- | --- |
| `OPENSWAP_EVM_PRIVATE_KEY` | Hot key (warned on `--live`) |
| `OPENSWAP_EVM_KEYSTORE` + `OPENSWAP_EVM_KEYSTORE_PASSWORD` | Encrypted V3 keystore — preferred for live funds |
| `OPENSWAP_EVM_RPC_URL` | Your RPC (serious bots should set this) |

Pre-signing guards refuse malformed targets, chain-id mismatches, and plans
whose native value exceeds the approved amount. Non-EVM source chains use the
deposit-address flow instead.

## Deposit-address bots

`openswap swap --policy p.json --json --yes …` applies the same policy gate to
the deposit-address flow — for automation that pays from external wallet
infrastructure rather than the built-in signer.
