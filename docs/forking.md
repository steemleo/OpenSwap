# Fork this

Yes, really. This CLI is MIT-licensed and we *want* you to build on it —
white-label it, embed it, strip it for parts, ship your own swap tool.

## The one thing to know

Get your own LeoKit API key at **[dash.leokit.dev](https://dash.leokit.dev)**
(free, self-serve) and put it in your fork — or let your users `auth login`
with theirs. Here's why that's good for you:

- **Affiliate fees on the volume your fork routes are yours.** The LeoKit API
  pays integrators per-swap; your key = your revenue. The built-in community
  key routes those fees to LeoKit instead — fine for personal use, a waste if
  you're distributing.
- Your key gets your own fee configuration and support relationship.

Swap one constant (`COMMUNITY_API_KEY` in `src/core/credentials.ts`) or set
`OPENSWAP_API_KEY` at build/runtime, and everything else just works. For
feedback, set `OPENSWAP_FEEDBACK_WEBHOOK` to your own Discord webhook (or
`OPENSWAP_FEEDBACK_RELAY_URL` to your own relay) so your users' feedback
reaches YOUR channel, not ours — never commit a raw webhook URL to a public
repo; it doubles as its own delete credential.

## What you inherit

Exact BigInt money math, the deposit-validation gauntlet, streamed route
discovery, durable receipts + resume, the policy engine, the agent surface
(AGENT-CONTRACT.md / SKILL.md), and a frozen JSON + exit-code contract to build
against. Please keep the safety behaviors (validation, receipts-before-payment,
no-blind-retry) intact — they protect your users.

## What we ask (not require)

Rename your distribution if it diverges (the `openswap` npm name and wordmark
stay with us), keep the MIT license text, and upstream fixes that would help
everyone — especially anything in the deposit-validation path.

Rebranding is easy by design: `brand/otto.pixels.json` +
`scripts/gen-brand.mjs` are a complete pixel-mascot pipeline — draw your own
12×12 grid, pick a palette, run `npm run brand`, and your fork gets its own
mascot, lockups, favicons, social card, and terminal banner in one step
(see [brand/BRAND.md](../brand/BRAND.md)).
