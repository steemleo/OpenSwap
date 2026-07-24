<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/steemleo/OpenSwap/main/brand/banner-readme-dark.svg">
  <img alt="OpenSwap — open-source crosschain swaps, right from your terminal" src="https://raw.githubusercontent.com/steemleo/OpenSwap/main/brand/banner-readme-light.svg" width="100%">
</picture>

# OpenSwap CLI

**Open-source crosschain swaps, right from your terminal.** Quote, compare,
and swap across 30+ chains — BTC, ETH, SOL, and everything between — for
humans, AI agents, and trading bots.

By [LeoDex](https://leodex.io) · powered by the LeoKit API.

```bash
npx openswap
```

OpenSwap is noncustodial by design: it finds the route, mints a deposit
address, and you pay from any wallet you already trust (scan the terminal QR).
No seed phrases, no private keys, no browser extension.

New here? `openswap tour` walks you through a complete swap in 2 minutes —
real prices, simulated payment, nothing real moves. Want to actually drive?
`openswap test on` puts the whole CLI in a simulated sandbox: full swap
flows, simulated wallets and balances, zero risk.

## Swap in one line

```bash
openswap swap --amount 100 --from arb:USDC --to btc:BTC
```

Routes stream in live from every provider (Chainflip, THORChain, Maya, NEAR,
Relay, and more), every fee is shown honestly — including when one isn't
provided — then you get a deposit address, a QR, and a durable receipt. Close
the terminal any time; `openswap resume` picks the swap back up.

## Commands

| Command | What it does |
| --- | --- |
| `openswap tour` | 2-minute guided walkthrough — nothing real moves |
| `openswap test on` | Test mode: full swap flows against a simulated backend |
| `openswap quote` | Compare routes — read-only, no wallet needed |
| `openswap swap` | Full funnel: routes → review → deposit address + QR → tracking |
| `openswap status [id] --watch` | Track or resume any swap by receipt |
| `openswap history` | Browse every swap from this machine — inspect, track |
| `openswap assets search <q>` | Explore 7,000+ supported assets |
| `openswap balances <addr> --chains ETH,ARB` | Multi-chain balances |
| `openswap watch --jsonl` | Live streaming quotes (SSE) for bots |
| `openswap bot init` | Policy-gated automation scaffold |
| `openswap agent setup` | Teach Claude Code (and friends) to swap safely |
| `openswap auth login` | Store your API key in the OS keychain |
| `openswap feedback` | Bug or idea → straight to the team |
| `openswap doctor` | Check your setup |

## For agents

Every command takes `--json` and returns a versioned envelope with stable exit
codes. See [AGENT-CONTRACT.md](https://github.com/steemleo/OpenSwap/blob/main/AGENT-CONTRACT.md),
or run `openswap agent setup` to install the Claude Code skill.

## For bots

`openswap bot init` scaffolds a deterministic policy (allowlists, USD
ceilings, fee caps, cooldowns, a kill-switch file). A script or LLM may
*propose* a trade; only the policy can *authorize* it. `bot run` simulates by
default and broadcasts only with `--live`.
See [docs/bot-mode.md](https://github.com/steemleo/OpenSwap/blob/main/docs/bot-mode.md).

## Keys, fees — and forks

Works out of the box on a built-in community key. Using your own LeoKit API
key routes affiliate fees to **you** — which is also why we genuinely welcome
forks: see [docs/forking.md](https://github.com/steemleo/OpenSwap/blob/main/docs/forking.md).

## Privacy & network

The CLI talks to `api.leokit.dev` for quotes, deposit addresses, and swap
status — nothing else, and never in the background. There is **no telemetry**.
`openswap feedback` and the occasional satisfaction prompt send data only on
your explicit action, show you the exact payload first, and redact anything
secret-shaped. All state (receipts, config, cache) stays on your machine.

## Install & requirements

Node ≥ 20 on macOS or Linux (Windows works via WSL; the OS keychain
integration covers macOS and Linux, with a permission-locked file fallback).

```bash
npm install -g openswap   # or: npx openswap
```

Uninstall: `npm uninstall -g openswap`, then optionally remove local state at
`~/.local/share/openswap`, `~/.config/openswap`, `~/.cache/openswap`, and the
`openswap-cli` entry in your OS keychain. Something misbehaving?
`openswap doctor` diagnoses setup issues.

## Docs

[Getting started](https://github.com/steemleo/OpenSwap/blob/main/docs/getting-started.md) ·
[Commands](https://github.com/steemleo/OpenSwap/blob/main/docs/commands.md) ·
[Architecture](https://github.com/steemleo/OpenSwap/blob/main/docs/architecture.md) ·
[Security model](https://github.com/steemleo/OpenSwap/blob/main/docs/security.md) ·
[Bot mode](https://github.com/steemleo/OpenSwap/blob/main/docs/bot-mode.md) ·
[Brand](https://github.com/steemleo/OpenSwap/blob/main/brand/BRAND.md) ·
[Contributing](https://github.com/steemleo/OpenSwap/blob/main/CONTRIBUTING.md)

MIT © LeoFinance
