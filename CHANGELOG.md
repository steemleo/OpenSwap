# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project adheres to [Semantic Versioning](https://semver.org/). While on 0.x,
minor versions may include breaking changes.

## [Unreleased]

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
