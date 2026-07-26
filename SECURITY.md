# Security Policy

OpenSwap moves real money on users' behalf. Security reports get priority over
everything else.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

Only the latest published `0.x` line receives security fixes.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for an exploitable
finding. Do not use `openswap feedback` — it is not a confidential channel.**

Report through either:

1. **GitHub private vulnerability reporting** (preferred) — the *Report a
   vulnerability* button on the [Security tab](https://github.com/steemleo/openswap/security/advisories/new).
   This opens a private advisory visible only to you and the maintainers.
2. **Email** `contact@leofinance.io` with `SECURITY` in the subject.

Please include the version (`openswap --version`), your OS, exact reproduction
steps, and the impact you believe it has. A proof of concept against **test
mode** (`OPENSWAP_TEST_MODE=1`) is ideal — never test against funds that are
not your own.

### What you can expect from us

| Stage | Target |
| ----- | ------ |
| Acknowledgement | 72 hours |
| Triage and severity assessment | 7 days |
| Fix or mitigation for funds-at-risk findings | 14 days |
| Fix for other findings | 90 days |
| Public advisory and credit | On release of the fix, coordinated with you |

We publish a GitHub Security Advisory for any finding that affects a released
version. You are credited by whatever name you choose, unless you'd rather not
be.

### Safe harbor

We will not pursue or support legal action against research conducted in good
faith under this policy: no privacy violations, no service disruption, no
access to accounts or funds that aren't yours, no data exfiltration, and a
reasonable disclosure window. If you're unsure whether something is in scope,
ask first at `contact@leofinance.io`.

We do not currently run a paid bounty program. Funds-at-risk findings are
rewarded at our discretion, and every valid report is publicly credited.

## Scope

**In scope** — this repository and the published `openswap` npm package:

- Anything that could redirect a payment: deposit-address integrity, QR and
  payment-URI construction, address validation, memo handling, amount math.
- Key material exposure: the V3 keystore, OS keychain handling, or secrets
  reaching argv, environment dumps, logs, receipts, or error output.
- Bypasses of the bot policy engine (allowlists, USD ceilings, fee caps,
  cooldowns, kill switch) or of the `--yes` / typed-`SWAP` confirmation gates.
- Terminal escape-sequence injection through upstream-controlled strings.
- Supply chain: our release pipeline, the published tarball contents, and
  build provenance.

**Out of scope**

- **The built-in community API key.** It ships in this source *by design* (see
  `src/core/credentials.ts`). It grants quote and swap preparation only — it
  cannot move funds, and it cannot read anything private. Extracting it is not
  a vulnerability. Demonstrating that it can do something **beyond**
  quote/prepare is very much in scope.
- The LeoKit API itself (`api.leokit.dev`). Report those to the same address,
  but they are not fixed in this repository.
- Third-party swap protocols (Chainflip, THORChain, Maya, NEAR, Relay, and
  others) and their liquidity or settlement behavior.
- Findings that require an already-compromised machine, a malicious local
  user, or a modified build.
- Dependency advisories with no reachable exploit path in this CLI. Tell us
  anyway — they are triaged as maintenance rather than as vulnerabilities.

## Security model

OpenSwap is noncustodial. In the default flow it mints deposit addresses and
never holds seeds or private keys; you pay from your own wallet.

The optional EVM signing lane is **disabled by default** and must be opted into
explicitly with `OPENSWAP_ENABLE_SIGNER=1`. When enabled, keys live only in an
encrypted V3 keystore you create locally. The full custody and credential model
is documented in [docs/security.md](docs/security.md).

## Verifying a release

Releases are published from GitHub Actions with npm provenance:

```bash
npm audit signatures
```

The provenance badge on [npmjs.com/package/openswap](https://www.npmjs.com/package/openswap)
links to the exact commit and workflow run that produced the published tarball.
