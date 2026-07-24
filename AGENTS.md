# OpenSwap CLI — contributor & coding-agent guide

Terminal-first crosschain swaps (npm: `openswap`). TypeScript, Node ≥ 20,
self-contained: it talks HTTP to the public LeoKit API — no SDK dependency,
no wallet custody, no signing in the default flow.

> **Driving the CLI as an agent rather than developing it?** This file is not
> for you. [AGENT-CONTRACT.md](AGENT-CONTRACT.md) is the machine contract —
> JSON envelopes, frozen exit codes, financial rules. Run `openswap agent docs`
> to print it; you never need to read this repository.

## Read before changing anything

- [docs/README.md](docs/README.md) — public doc index
- [docs/architecture.md](docs/architecture.md) — layers and file map
- [AGENT-CONTRACT.md](AGENT-CONTRACT.md) — the machine/agent output contract
  (frozen exit codes)
- [brand/BRAND.md](brand/BRAND.md) — brand kit. Assets are GENERATED: edit
  `brand/otto.pixels.json`, run `npm run brand`, commit outputs (tests enforce
  freshness). Otto appears only on the bare `openswap` menu — never add the
  mascot to subcommands or machine output.

## Commands

```bash
bun install          # or npm install
bun run typecheck    # tsc --noEmit — must stay clean
bun run test         # vitest unit suite — must stay green
bun run build        # tsup → dist/index.js
node dist/index.js   # run the built CLI (targets Node)
```

## Non-negotiable rules

- **Money math**: decimal strings + BigInt only — never float arithmetic on
  amounts. Quote responses go through `parseJsonPreservingBigInts` (base-unit
  amounts exceed 2^53 in production, and arrive in exponent form above 1e21).
- **Never fabricate financial data**: no invented minimums, no totals from
  partially priced fees, no guessed statuses. `null` renders as "not provided",
  and a `usd: 0` fee against a non-zero amount means *unpriced*, never free.
- **Secrets**: never in argv, URLs, config files, receipts, logs, or errors.
  Credentials resolve only in `src/core/credentials.ts` (env → OS keychain →
  the intentionally public community key).
- **State-changing calls** (`/deposit-address`, `/deposit`, broadcast) are
  never auto-retried and never happen under `--dry-run`; receipts are written
  BEFORE payment instructions render.
- **Payment URIs are built locally** from a validated address — never rendered
  from a server-supplied string.
- Renderers contain no business logic; upstream strings are untrusted —
  `sanitize()` everything user-visible.
- Machine contract is frozen: envelope shape and exit codes only change with
  a documented deprecation (see [AGENT-CONTRACT.md](AGENT-CONTRACT.md)).
- Copy rules: "crosschain" (one word); "Expected receive" (never "You will
  receive" for an estimate); never "best" without naming the criterion.

## API behavior worth knowing

Quotes expire in ~30 seconds. Deposit-bound quotes need `origin` +
`destination` at quote time, and `/deposit-address` needs both `to_address`
and `from_address` (the payer/refund wallet). `/deposit` returns
`unsigned_transactions`. `/status` has two response shapes — always go through
`normalizeStatus`. Route discovery uses the SSE stream so every provider gets
its window; don't replace it with one-shot quote calls.

## Verifying a change

Test mode runs the whole CLI against a simulated backend through the unchanged
production code paths, so a full swap can be verified without funds:

```bash
OPENSWAP_TEST_MODE=1 OPENSWAP_TEST_TIMESCALE=100 node dist/index.js swap \
  -a 25 -f eth:usdc -t base:usdc \
  --to-address 0x1111111111111111111111111111111111111111 \
  --refund-address 0x2222222222222222222222222222222222222222 --yes --json
```

`node scripts/e2e-sim.mjs` runs the same lanes non-interactively and is what CI
gates on. See [docs/test-mode.md](docs/test-mode.md).

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Never open a
public issue for an exploitable finding, and never route one through
`openswap feedback`.
