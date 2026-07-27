# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project adheres to [Semantic Versioning](https://semver.org/). While on 0.x,
minor versions may include breaking changes.

## [Unreleased]

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
