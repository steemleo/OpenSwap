# Contributing

Thanks for helping make crosschain swaps feel native to the terminal.

## Setup

```bash
git clone https://github.com/steemleo/openswap.git && cd openswap
npm install
npm run typecheck && npm test && npm run build
node dist/index.js doctor
```

Node ≥ 20.19. The CLI works against the live LeoKit API out of the box (built-in
community key); `OPENSWAP_API_KEY` overrides it.

## Where things live

- [docs/architecture.md](docs/architecture.md) — layers and file map
- [docs/README.md](docs/README.md) — doc index
- [AGENT-CONTRACT.md](AGENT-CONTRACT.md) — the machine/agent output contract
  (frozen exit codes). This ships in the npm package and is what
  `openswap agent docs` prints.
- [brand/BRAND.md](brand/BRAND.md) — brand kit. Assets are **generated**: edit
  `brand/otto.pixels.json`, run `npm run brand`, commit the outputs (tests
  enforce freshness). Otto appears only on the bare `openswap` menu — never on
  subcommands or machine output.

## Non-negotiable rules

These exist because the CLI moves real money.

- **Money math**: decimal strings and BigInt only — never float arithmetic on
  amounts. Quote responses go through `parseJsonPreservingBigInts`; base-unit
  amounts exceed 2^53 in production and arrive in exponent form above 1e21.
- **Never fabricate financial data**: no invented minimums, no totals derived
  from partially priced fees, no guessed statuses. `null` renders as "not
  provided", and a `usd: 0` fee against a non-zero amount means *unpriced*,
  never free.
- **Secrets** never appear in argv, URLs, config files, receipts, logs, or
  errors. Credentials resolve only in `src/core/credentials.ts` (env → OS
  keychain → the intentionally public community key).
- **State-changing calls** (`/deposit-address`, `/deposit`, broadcast) are never
  auto-retried and never happen under `--dry-run`. Receipts are written *before*
  payment instructions render.
- **Payment URIs are built locally** from a validated address — never rendered
  from a server-supplied string.
- Renderers hold no business logic, and upstream strings are untrusted:
  `sanitize()` everything user-visible.
- **The machine contract is frozen.** Envelope shape and exit codes change only
  with a documented deprecation.
- Copy rules: "crosschain" is one word; "Expected receive", never "You will
  receive", for an estimate; never "best" without naming the criterion.

## API behavior worth knowing

Quotes expire in ~30 seconds. Deposit-bound quotes need `origin` and
`destination` at quote time, and `/deposit-address` needs both `to_address` and
`from_address` (the payer/refund wallet). `/deposit` returns
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

## Pull requests

- `npm run typecheck` and `npm test` green. Add tests for logic, or say how you
  verified behavior for orchestration changes.
- Keep JSON output additive; document command and flag changes in
  `docs/commands.md` (and `AGENT-CONTRACT.md` if agent-facing) in the same PR.
- Changes in the deposit-validation path (`src/core/deposit.ts`,
  `src/core/amount.ts`) get extra scrutiny — state clearly what you tested.
- One concern per PR beats a grab-bag.

## Security issues

Privately please — see [SECURITY.md](SECURITY.md). Never open a public issue for
an exploitable finding, and never route one through `openswap feedback`.
