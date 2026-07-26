# Contributing

Thanks for helping make crosschain swaps feel native to the terminal.

## Setup

```bash
git clone https://github.com/steemleo/openswap.git && cd OpenSwap
bun install            # or npm install
bun run typecheck && bun run test && bun run build
node dist/index.js doctor
```

Node ≥ 20. The CLI works against the live LeoKit API out of the box (built-in
community key); `OPENSWAP_API_KEY` overrides it.

## Ground rules

Read [AGENTS.md](AGENTS.md) (they apply to humans too): exact BigInt money
math, no fabricated financial data, no secrets in argv/config/logs/receipts,
no auto-retry of state-changing calls, sanitized upstream strings, frozen
JSON/exit-code contract.

## Pull requests

- `bun run typecheck` + `bun run test` green; add tests for logic, or a note
  on how you verified behavior for orchestration changes.
- Keep JSON output additive; document command/flag changes in
  `docs/commands.md` (and `AGENT-CONTRACT.md` if agent-facing) in the same PR.
- Changes in the deposit-validation path (`src/core/deposit.ts`,
  `src/core/amount.ts`) get extra scrutiny — say clearly what you tested.
- One concern per PR beats a grab-bag.

## Security issues

Privately please — see [SECURITY.md](SECURITY.md). Never open a public issue
for an exploitable finding, and never route one through `openswap feedback`.
