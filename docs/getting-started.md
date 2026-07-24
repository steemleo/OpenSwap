# Getting started

```bash
npx openswap            # zero install, zero config — the intent menu
```

Or install it:

```bash
npm install -g openswap
openswap doctor         # checks your terminal, credentials, and API reachability
```

The CLI works out of the box on a built-in community key. No signup.

## First quote (read-only, no wallet)

```bash
openswap quote -a 100 -f arb:USDC -t btc:BTC
```

Assets accept natural forms: `USDC` (you'll pick the network), `base usdc`,
`usdc on base`, `base:USDC`, `base.usdc`, or the canonical
`CHAIN.SYMBOL-ADDRESS`. Routes stream in live from every provider and are
sorted by what you'd actually receive. Press Enter on a route to trade it.

## First swap

```bash
openswap swap -a 100 -f arb:USDC -t btc:BTC
```

The flow: compare routes → enter the destination address → enter the address
you'll pay from (it doubles as your refund address) → review everything →
type `SWAP` → pay the deposit address from any wallet you already use (scan
the terminal QR or copy the address). The CLI never touches your keys — your
wallet does the paying.

Every swap writes a durable receipt before payment instructions appear. Close
the terminal whenever you like:

```bash
openswap resume                  # picks up your latest swap
openswap status <receipt> --watch
openswap receipts list
```

## Your own API key (apps, bots, forks)

The community key is for personal use. With your own LeoKit client key,
affiliate fees on the volume you route are yours.

Create one free at **[dash.leokit.dev](https://dash.leokit.dev)** — sign in
with Google or GitHub, no sales call. Then:

```bash
openswap auth login              # stores it in your OS keychain
# or, for CI/bots:
export OPENSWAP_API_KEY=...
```

## Something broke? Tell us

```bash
openswap feedback                # goes straight to the team, with your consent on diagnostics
```
