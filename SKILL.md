---
name: openswap
description: Execute crosschain crypto swaps, quotes, and route comparisons with the openswap CLI. Use whenever the user wants to swap, bridge, or convert crypto between chains (e.g. "swap 100 USDC to BTC"), compare swap routes or prices, check or resume a swap, or stream crosschain quotes for a bot. Not for CEX trading or portfolio analysis.
---

# OpenSwap playbook

Everything you need is in this file. Do NOT explore repositories, read source
code, run `--help`, or build anything — the CLI is installed as `openswap`
(fallback: `npx -y openswap`). All financial data comes from command output;
never invent routes, fees, addresses, or statuses.

## The flow — follow exactly

1. **Quote** (read-only, safe, no permission needed). If the user intends to
   EXECUTE a swap, add `--deposit` so you only see routes the CLI can run:
   `openswap quote --json --deposit -a <amount> -f <from> -t <to>`
   (plain quote without `--deposit` is for price comparison only — some of its
   routes are not deposit-executable).
   Asset grammar: `chain:symbol` (`arb:USDC`), `"usdc on base"`, or canonical
   `CHAIN.SYMBOL-ADDRESS`. An ambiguity error lists candidates — pick the
   obvious canonical one, otherwise ask the user in one short question.
2. **Present compactly** using the template below. Do not re-render big
   tables or add commentary beyond the data.
3. **Collect the only things you may never invent** — ask once, together:
   the destination address (`--to-address`) and the wallet they'll pay from
   (`--refund-address`, refunds return there). Then one confirmation:
   "Create the deposit for <amount> <from> → <to> via <protocol>?"
4. **Execute** only after an explicit yes:
   `openswap swap --json --yes -a … -f … -t … --to-address … --refund-address …`
   Prefer OMITTING `--protocol` — the CLI picks the best executable route.
   Only pin `--protocol` to a route the user chose FROM A `--deposit` QUOTE;
   never pin one from a plain quote (it may not be executable → exit 4).
5. **Hand off** from `data.payment_request`: show `deposit_address` (in FULL),
   `amount_display` + asset, `source_network`, expiry (relative), and
   `data.receipt_id`. Say: "Pay this from your wallet — I can track it."
6. **Track** on request: `openswap status <receipt_id> --json`
   (terminal states: success | failed | refunded).

## Quote JSON field map

`data.routes[]`: `protocol` · `expected_receive.display` (+ `.usd_estimate`) ·
`fees_total_usd` (null = partly unpriced — say "not fully priced", never $0) ·
`eta_seconds` · `recommendation` (why it leads) · `execution` — how this CLI
can run the route:
- `"deposit_address"` — default lane, works for everyone (user pays a minted
  address from any wallet).
- `"wallet_signed"` — executable ONLY if the user has configured a signing
  wallet (`openswap wallet setup`, or signer env vars). In machine mode you
  must ALSO pass `--signer`, and only with the user's explicit authorization —
  this lane broadcasts real transactions from their wallet. NEVER ask for or
  handle keys yourself; if no signer is configured, present deposit routes and
  SUGGEST the user run `openswap wallet setup` themselves (interactive-only).
- `"unsupported"` — quote-only from this CLI today.

## Presentation template

> **100 USDC (Arbitrum) → BTC** — 3 routes:
> 1. **rango** — 0.00152694 BTC (~$97.64) · fees $0.10 · ~3 min ← best receive
> 2. chainflip — 0.00151365 BTC (~$96.79) · fees $1.17 · ~7 min
> 3. mayachain — 0.00148161 BTC (~$94.74) · fees $3.18 · ~30 s ← fastest
>
> Which route? And I need two addresses: the **BTC address** to receive, and
> the **Arbitrum address** you'll pay from (also your refund address).

## Errors & safety

- `ok:false` → `error.message` says what happened; `error.actions[]` are
  runnable fixes — use them instead of diagnosing from scratch.
- Exit codes: 4 = no route/policy-rejected · 3 = auth (`openswap auth login`)
  · 5 = upstream, retry once · 130 = user cancelled.
- Quotes expire in ~30s. If more than ~1 minute passed before executing,
  re-quote — do not reuse stale numbers.
- `funds_may_have_moved: true` → STOP; check `status`; never re-run `swap`.
- Creating a deposit address is state-changing: explicit user go-ahead first.
  Never handle private keys or seed phrases.
- Bots: `openswap watch --jsonl` (price stream) · `openswap bot init|check|run`
  (policy-gated; simulates unless `--live`).
- Full machine contract any time: `openswap agent docs`.
