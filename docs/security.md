# Security model

## Custody: the CLI never holds funds

The default execution model is **deposit-address handoff**: LeoKit quotes the
route and mints a deposit address; you pay it from any wallet you already
trust. No seed phrases, no private keys, no browser extension — the CLI has
nothing to steal. The only signing capability is the explicitly opt-in bot
signer (see [bot-mode.md](bot-mode.md)), which is never engaged by the human
flow.

## API keys

Resolution ladder: `OPENSWAP_API_KEY` env → OS keychain (`openswap auth login`,
stored via macOS Keychain / Linux Secret Service with the secret passed over
stdin, never argv) → the built-in **community key**. The community key is
intentionally public: it grants quotes and swap preparation only — it cannot
move funds, and it cannot read anything private. Keys are never accepted as
command-line flags, never written to config files, receipts, or logs, and the
CLI refuses to send your key to any endpoint other than the official API (or
localhost for development).

## The funnel's safety gauntlet

- Destination and refund addresses are format-validated per chain family, and
  known placeholder addresses are rejected.
- The quote is re-minted bound to your real destination before review, and the
  review restates everything; execution requires typing `SWAP` (machine mode
  requires explicit `--yes`).
- Deposit amounts are recomputed with exact integer math; the payment URI/QR
  must agree with the validated address and amount or it is not shown.
- Routes that require metadata a plain address can't carry are refused on the
  QR path rather than risking a mis-send.
- A receipt is written before payment instructions render; every swap is
  resumable; a swap whose outcome is unknown is never retried blindly
  (`funds_may_have_moved` errors say so explicitly).
- All upstream strings are sanitized before rendering (terminal-escape
  injection defense); child processes use argument arrays, never shell
  interpolation.

## The signing wallet (optional)

`openswap wallet setup` recommends **creating a dedicated signing wallet**
rather than importing your main one — generated locally, encrypted to a V3
keystore (scrypt + AES-128-CTR), passphrase required at every signing, never
stored. Machine/bot use requires explicit env configuration plus the
`--signer` flag. Keep only active trading balances on it.

## Feedback & privacy

`openswap feedback` shows you the exact diagnostics before sending (with
consent) and redacts keys/addresses/tokens client-side. Delivery posts to the
team's feedback relay — the Discord webhook it forwards to lives server-side,
so no write credential ships in this repo. Undeliverable feedback lands in a
local outbox and retries next run. Receipts and logs stay on your machine
(`~/.local/share/openswap`, `0600`), contain no credentials, and nothing is
collected in the background: the CLI has **no telemetry**.

## Reporting a vulnerability

See **[SECURITY.md](../SECURITY.md)** — it is the single source of truth for
disclosure, scope, and our response commitments.

Never open a public issue for an exploitable finding, and never send one
through `openswap feedback`: that path posts to a team chat channel and is
**not** a confidential disclosure channel.
