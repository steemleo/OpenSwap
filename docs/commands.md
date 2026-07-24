# Command reference

## Output modes (every command)

| Flag | Behavior |
| --- | --- |
| *(none, TTY)* | Interactive human mode |
| *(none, piped)* | Auto-degrades to plain text; never prompts |
| `--plain` | Deterministic TSV-ish text, no ANSI |
| `--json` | Exactly ONE versioned envelope on stdout; implies `--no-input` |
| `--jsonl` | One JSON object per line (streaming commands) |
| `--no-input` | Never prompt; missing input is a usage error |
| `--no-color` / `NO_COLOR` / `TERM=dumb` | No ANSI anywhere |

JSON envelope: `{schema_version:"1", command, ok, data|error, warnings, meta}`
(`warnings` on success envelopes). Errors carry `code`, `message`, `retryable`,
`funds_may_have_moved`, and `actions[]` (safe next commands).

## Exit codes (frozen — script against these)

`0` success · `1` internal · `2` usage/validation · `3` auth/config ·
`4` no-route or policy rejection · `5` retryable network/upstream ·
`6` signer · `7` broadcast · `130` interrupted.

## Commands

### `openswap` — intent menu (TTY)

### `openswap tour`
The 2-minute guided walkthrough: real streamed quotes (read-only, free)
followed by a clearly simulated payment card and tracking timeline — no
deposit address is created, nothing is saved, no funds can move. Interactive
only (machine modes get exit 2 with a pointer to `quote --json`). First-run
users see it at the top of the menu.

### `openswap test on|off|status|pay|fund|scenario|reset`
Test mode: the entire CLI runs against a simulated backend — simulated
wallets, balances, deposits, and tracking — through the unchanged production
code paths. `on`/`off` toggle it (env override `OPENSWAP_TEST_MODE=1|0`);
`pay` simulates paying a deposit; magic amounts (`.13` fail, `.19` refund,
`.07` short window, `.23` slow) steer outcomes; `OPENSWAP_TEST_TIMESCALE`
accelerates the story for CI/agents. Simulated receipts are `ost_` with
`environment: "simulated"`. See [test-mode.md](test-mode.md).

### `openswap history`
The human-first swap ledger: every swap started from this machine, newest
first, with an interactive pick into full details and live tracking. Machine
modes return the same records as JSON. (`receipts` remains the low-level
store view.)

### `openswap quote -a <amount> -f <asset> -t <asset>`
Read-only route comparison. Routes stream in live from every provider; the
set is sorted by amount received, with honest fee labels (`null` fees are
"not priced", never zero). Interactive mode ends with Enter-to-trade.
Flags: `--slippage-bps N`, `--refresh` (asset cache).

### `openswap swap -a … -f … -t … [--to-address A --refund-address B]`
The full funnel. Human mode prompts for anything missing and requires a typed
`SWAP` confirmation. Machine mode requires `--to-address`,
`--refund-address`, and explicit `--yes` (creating a deposit address is
state-changing), and returns `data.payment_request` + `receipt_id`.
`--dry-run` performs zero state-changing calls. `--protocol P` preselects a
route (soft fallback in human mode). `--policy file` gates the trade through
a policy first. **Two execution lanes**: deposit-address (default — pay a
minted address from any wallet) and **wallet-signed** (routes whose source
chain is EVM execute via your configured signer — `OPENSWAP_EVM_PRIVATE_KEY`
or keystore; machine mode requires an explicit `--signer` flag; simulated
before broadcast). Route JSON carries `execution` so agents pick correctly. If a route refreshes away mid-funnel, the CLI re-presents
current options — nothing is ever paid without a fresh review.

### `openswap status [id] [--watch]` · `openswap resume [id]`
Track by receipt (`os_…`) or quote id; defaults to your latest swap.
Terminal states: `success`, `failed`, `refunded`. Unpaid expired deposits are
reported distinctly (`deposit_expired`).

### `openswap receipts list|show|export <id>`
Durable local records of every swap you started
(`~/.local/share/openswap/receipts`, atomic writes, no secrets ever).

### `openswap assets list [--chain C] [--all] [--limit N]` · `assets search <q>`
7,000+ assets, cached locally for 24h.

### `openswap balances <address> --chains A,B,C`

### `openswap watch -a … -f … -t … [--jsonl] [--once]`
Live streaming quotes over SSE — the bot price feed.

### `openswap bot init|check|run`
Policy-gated automation — see [bot-mode.md](bot-mode.md). `init` is a guided
wizard in a terminal (template scaffold in machine mode); `check` is a
side-effect-free gate probe; `run` simulates by default; `--live` broadcasts.

### `openswap auth login|status|logout`
Your API key, stored in the OS keychain (macOS Keychain / Secret Service;
0600-file fallback). Never accepted as a flag. `OPENSWAP_API_KEY` env for CI.

### `openswap wallet setup` · `wallet status`
The optional **signing wallet** — unlocks routes with no deposit-address
support (bob, rango, deBridge, 1inch, Across…). The guided setup's
recommended path **creates a fresh dedicated wallet** (generated locally,
encrypted V3 keystore at `~/.config/openswap/signer.keystore.json`, passphrase
asked at each signing and never stored) — your main wallet's key never enters
the CLI. Import and env-var options exist for power users. The swap funnel
shows locked routes with an inline "unlock" option.

### `openswap doctor`
Runtime, terminal, credential validity, API reachability, storage checks.

### `openswap config list|get|set`
Non-secret configuration only — secret-looking keys are refused.

### `openswap agent setup [--scope user|project]` · `agent status` · `agent docs`
Installs the Agent Skills playbook (Claude Code, Codex, Cursor, Gemini CLI all
read the same spec). `agent docs` prints the complete machine contract to
stdout — any agent self-bootstraps with one command, no repo exploration.

Occasionally (after 5–10 successful interactive commands, never more than
once per 48h, never for agents/JSON modes) the CLI asks a one-keypress
"How's OpenSwap doing?" pulse — Enter skips, "Don't ask again" is permanent.

### `openswap feedback [-m "…"] [--kind bug|feature] [--no-diagnostics]`
Sends feedback to the team (via a relay — no webhook in this code). Shows you
the exact redacted diagnostics before asking consent. Offline? It saves to a
local outbox and retries next run.

## Compatibility promises

Additive JSON fields only; no field ever changes unit or type in place;
`schema_version` bumps on breaking changes; exit codes are frozen; renamed
commands/flags get a deprecation window with stderr warnings.
