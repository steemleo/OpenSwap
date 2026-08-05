# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project adheres to [Semantic Versioning](https://semver.org/). While on 0.x,
minor versions may include breaking changes.

## [Unreleased]

### Fixed
- **A swap status the CLI cannot corroborate is no longer presented as a
  completed swap.** This CLI moves other people's money, so a reported
  "success" is now validated against the swap's own receipt before it is
  endorsed: is a destination transaction named, is the amount within range
  of the quote, has enough time passed for a crosschain swap to settle. A
  claim that fails those checks is reported as exactly that — a claim: the
  timeline paints no unproven progress, the human output says "the CLI
  could not verify that" with each reason, machine output keeps
  `state: "pending"` with the claim under `claimed_state` and stable reason
  codes under `implausible` plus envelope warnings, the receipt stays open
  and resumable, and the watch keeps polling awhile instead of stopping on
  the first uncorroborated answer. Test mode gained magic amount `.62` — a
  status source that claims instant, unverifiable success — so the e2e gate
  proves the CLI refuses to endorse it.

### Added
- **"No route" now suggests a pair that does route.** A user asking to receive
  Zcash was told the pair was unsupported and stopped there — while the same
  coin quoted fine on Solana and BNB Chain, which nothing in the output
  revealed. `quote` and `swap` now answer a dead end with alternatives, for
  every pair rather than a curated list. Two distinct dead ends are covered: a
  pair no provider quotes, and an asset named on a chain that does not carry it
  (`DOT.DOT` → "available on ETH, BSC"). Suggestions vary one side at a time so
  they stay close to what was asked, keeping the user's own coin wherever
  possible, and are offered only after being proven to quote — a suggestion
  that also failed would be worse than none. Each carries a runnable command,
  and machine consumers get the same list under `error.details.alternatives`.
  Where genuinely nothing routes the CLI still says so rather than inventing a
  near-miss. The search is bounded and runs in parallel, so a failing quote is
  no slower than before.
- **Asset dead ends recover instead of exiting.** A `--from`/`--to` naming a
  chain that does not carry the coin used to print an error and quit, even in a
  terminal where the CLI already knew the answer. Interactive sessions now turn
  that into a picker of the chains that do carry it; machine modes get the same
  suggestions rewritten as complete, runnable commands (the user's own
  invocation with the failed side swapped) instead of bare identifiers.
- **A connection blip no longer reads as "no routes".** The streaming quote
  path failed hard on a single transient network error, reporting a dead end
  for a pair that quotes fine a second later — while the one-shot request path
  already retried. The stream now silently retries once, but only before
  anything has arrived (a second round mid-stream would swap the quote_id),
  and the spinner says "Could not fetch routes" instead of "No routes" when
  the failure was the connection, not the pair.
- **Typos find the coin anyway.** `USCD` returned zero results everywhere.
  Asset search now falls back to close misspellings of a symbol — swapped
  letters count as one edit — but only when nothing real matched, so exact and
  prefix matches keep their behaviour, and only against symbols, never long
  contract identifiers where near-misses are noise.

## [0.1.1] - 2026-07-27

### Fixed
- **Relay fees were displayed roughly double.** Some providers report a fee both
  as a subtotal and again as its components — Relay lists `relayer Fee`
  alongside `relayerGas Fee` and `relayerService Fee`, which sum to it exactly.
  Adding every line counted the relayer fee twice: a funded swap showed $0.07
  against the $0.031 actually charged. Component lines are now detected and
  excluded from the total while staying visible, each labelled with the fee it
  belongs to. Detection requires two independent signals — the components must
  sum to the parent exactly *and* their names must extend the parent's — so it
  works for any provider using this shape without a coincidence ever qualifying.
  Overstating a fee is the safer direction to fail, but it made the most
  competitive route look twice as expensive as it is.

### Changed
- The project is named consistently as **OpenSwap by LeoDex**. The package
  author, LICENSE holder, and README footer previously carried an older name
  while everything else already said LeoDex.
- `vitest` updated to 4.x, clearing five development-only advisories (one
  critical). No effect on the published package: it ships `dist/` plus docs and
  has zero runtime dependencies, so `npm audit --omit=dev` was — and remains —
  clean for anyone installing this CLI.

### Added
- CI verifies commit authorship on every push and pull request, so the single
  maintainer of record is enforced by the pipeline rather than by convention.

## [0.1.0] - 2026-07-21

### Added
- Initial public release: crosschain quote/swap/status/receipts with
  streaming route discovery (SSE), deposit-address funnel with local QR +
  clipboard handoff, durable resumable receipts.
- `openswap tour` — 2-minute guided walkthrough (real prices, simulated
  payment, nothing real moves).
- Policy-gated bot mode (`bot init/check/run`) with allowlists, USD ceilings,
  fee caps, cooldowns, and a kill-switch file; simulate-first execution.
- Optional EVM signer (encrypted V3 keystore or env key) unlocking
  wallet-signed routes.
- Agent surface: `--json` envelopes with frozen exit codes, AGENT-CONTRACT.md
  contract, installable Claude Code skill (`openswap agent setup`).
- Otto the Otter brand system with a fork-friendly asset pipeline
  (`npm run brand`).
