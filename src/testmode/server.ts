import { toBaseUnits, fromBaseUnits } from "../core/amount.js";
import { SIM_PROVIDERS } from "./fixtures.js";
import {
  depositStatus,
  fixtureFor,
  loadDeposit,
  loadQuote,
  loadWorld,
  magicOutcome,
  mulberry32,
  newQuoteId,
  saveDeposit,
  saveQuote,
  simDepositAddress,
  timescale,
  type SimDeposit,
  type WorldState
} from "./world.js";

// The simulated LeoKit backend, mounted at the fetch boundary via
// LeoKitApi's fetchImpl. It speaks the production wire faithfully — same
// endpoints, same SSE framing, same >2^53 amounts emitted as UNQUOTED JSON
// numbers so the CLI's bigint-preserving parse runs for real. Providers use
// real protocol names on purpose: the deposit gauntlet, lane partition, and
// relay→relay-deposit mapping must behave exactly as in production.

const CHAIN_IDS: Record<string, number> = { ETH: 1, BASE: 8453, ARB: 42161, OP: 10, BSC: 56, AVAX: 43114, POL: 137 };
const EVM_CHAINS = new Set(Object.keys(CHAIN_IDS));
const QUOTE_TTL_MS = 60_000;

// Big base-unit integers must serialize as bare JSON numbers (like the real
// backend) — JSON.stringify would need BigInt support, so we splice tokens.
// The sentinel carries a per-process nonce so no user-supplied string (an
// address, a memo) can ever collide with it and corrupt the JSON.
const BIG_NONCE = Math.floor(Math.random() * 0xffffffff).toString(36);
const BIG = (v: string): string => `__BIG_${BIG_NONCE}_${v}__`;
const BIG_RE = new RegExp(`"__BIG_${BIG_NONCE}_(\\d+)__"`, "g");
function renderJson(value: unknown): string {
  return JSON.stringify(value).replace(BIG_RE, (_m, digits: string) => {
    // Production serializes these as JSON numbers, and JSON.stringify switches
    // to exponent form at >= 1e21 (22+ digits) — a 1000-unit payout of any
    // 18-decimal asset. Reproduce that exactly, or the simulator hides the
    // whole class of bug that only shows up on large amounts.
    if (digits.length >= 22) return String(Number(digits));
    return digits;
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(renderJson(value), { status, headers: { "content-type": "application/json" } });
}

interface QuoteMath {
  outBase: string;
  outUsd: number;
  inUsd: number;
  fees: Array<{ type: string; amount: string; asset: string; usd: number }>;
  totalUsd: number;
}

function priceQuote(world: WorldState, fromAsset: string, toAsset: string, amount: string, feeRate: number, flatFeeUsd: number): QuoteMath | null {
  const from = fixtureFor(fromAsset);
  const to = fixtureFor(toAsset);
  if (!from || !to) return null;
  const rand = mulberry32(world.seed + fromAsset.length + toAsset.length);
  const jitter = 1 + (rand() - 0.5) * 0.004; // ±0.2%, deterministic per pair
  const inUsd = Number(amount) * from.price_usd;
  const grossOutUsd = inUsd * jitter;
  const netOutUsd = Math.max(0, grossOutUsd * (1 - feeRate) - flatFeeUsd);
  const outDisplay = netOutUsd / to.price_usd;
  const outBase = toBaseUnits(outDisplay.toFixed(Math.min(to.decimals, 12)), to.decimals).toString();
  const protocolFeeUsd = grossOutUsd * feeRate;
  return {
    outBase,
    outUsd: netOutUsd,
    inUsd,
    fees: [
      { type: "protocol Fee", amount: (protocolFeeUsd / from.price_usd).toFixed(6), asset: fromAsset, usd: Number(protocolFeeUsd.toFixed(4)) },
      { type: "service Fee", amount: (flatFeeUsd / from.price_usd).toFixed(6), asset: fromAsset, usd: flatFeeUsd }
    ],
    totalUsd: Number((protocolFeeUsd + flatFeeUsd).toFixed(4))
  };
}

function offerData(world: WorldState, params: { from: string; to: string; amount: string }, provider: (typeof SIM_PROVIDERS)[number], now: number): Record<string, unknown> | null {
  const from = fixtureFor(params.from);
  const to = fixtureFor(params.to);
  if (!from || !to) return null;
  const math = priceQuote(world, params.from, params.to, params.amount, provider.feeRate, provider.flatFeeUsd);
  if (!math) return null;
  const outcome = magicOutcome(params.amount, world.scenario);
  const ttlMs = (outcome === "expire" ? 15_000 : QUOTE_TTL_MS) / timescale();
  return {
    protocol: provider.protocol,
    type: "REGULAR",
    expected_amount_out: BIG(math.outBase),
    expected_amount_out_usd: Number(math.outUsd.toFixed(2)),
    input_amount_usd: Number(math.inUsd.toFixed(2)),
    out_asset_decimal: to.decimals,
    in_asset_decimal: from.decimals,
    fees: math.fees,
    total_swap_seconds: provider.etaSeconds,
    expires_at: now + ttlMs,
    ttl_seconds: Math.round(ttlMs / 1000),
    route: [from.blockchain, to.blockchain],
    supports_deposit_address: provider.supportsDepositAddress,
    min_swap_amount: "0.5",
    recommended_slippage: 0.5
  };
}

function parseQuoteParams(url: URL): { from: string; to: string; amount: string } | null {
  const from = url.searchParams.get("from_asset");
  const to = url.searchParams.get("to_asset");
  const amount = url.searchParams.get("amount");
  if (!from || !to || !amount) return null;
  return { from, to, amount };
}

function registerQuote(params: { from: string; to: string; amount: string }): string {
  const quoteId = newQuoteId();
  saveQuote(quoteId, { from_asset: params.from, to_asset: params.to, amount: params.amount, created_at: Date.now() });
  return quoteId;
}

function providersFor(depositOnly: boolean): typeof SIM_PROVIDERS {
  return depositOnly ? SIM_PROVIDERS.filter((p) => p.supportsDepositAddress) : SIM_PROVIDERS;
}

function sseResponse(world: WorldState, params: { from: string; to: string; amount: string }): Response {
  const quoteId = registerQuote(params);
  const now = Date.now();
  const rand = mulberry32(world.seed + now % 1000);
  const events: Array<{ at: number; payload: string }> = [
    { at: 0, payload: JSON.stringify({ type: "init", quote_id: quoteId, timestamp: new Date(now).toISOString() }) }
  ];
  for (const provider of SIM_PROVIDERS) {
    const data = offerData(world, params, provider, now);
    if (!data) continue;
    const [lo, hi] = provider.sseDelayMs;
    const delay = (lo + rand() * (hi - lo)) / timescale();
    events.push({ at: delay, payload: renderJson({ type: "quote", protocol: provider.protocol, data }) });
  }
  events.sort((a, b) => a.at - b.at);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let sent = 0;
      const push = (): void => {
        if (sent >= events.length) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        const e = events[sent]!;
        controller.enqueue(encoder.encode(`data: ${e.payload}\n\n`));
        sent += 1;
        const nextDelay = sent < events.length ? Math.max(0, events[sent]!.at - e.at) : 0;
        setTimeout(push, nextDelay);
      };
      push();
    }
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function makeDeposit(world: WorldState, body: Record<string, unknown>): Response {
  const quoteId = String(body.quote_id ?? "");
  const requested = String(body.protocol ?? "");
  const quote = loadQuote(quoteId);
  if (!quote) return json({ error: "SELECTED_QUOTE_IS_NOT_SET", status: 400 }, 400);
  const from = fixtureFor(quote.from_asset);
  const to = fixtureFor(quote.to_asset);
  if (!from || !to) return json({ error: "UNSUPPORTED_PAIR", status: 400 }, 400);

  const provider = SIM_PROVIDERS.find((p) => p.protocol === requested || (requested === "relay-deposit" && p.protocol === "relay"));
  const math = priceQuote(world, quote.from_asset, quote.to_asset, quote.amount, provider?.feeRate ?? 0.004, provider?.flatFeeUsd ?? 0.25);
  if (!math) return json({ error: "UNSUPPORTED_PAIR", status: 400 }, 400);

  const outcome = magicOutcome(quote.amount, world.scenario);
  const now = Date.now();
  const rand = mulberry32(world.seed + now % 100000);
  const address = simDepositAddress(from.blockchain, rand);
  const raw = toBaseUnits(quote.amount, from.decimals).toString();
  const windowMs = (outcome === "expire" ? 15_000 : 30 * 60_000) / timescale();

  const dep: SimDeposit = {
    quote_id: quoteId,
    receipt_hint: null,
    protocol: requested,
    from_asset: quote.from_asset,
    to_asset: quote.to_asset,
    amount_display: quote.amount,
    deposit_address: address,
    network: from.blockchain,
    to_address: String(body.to_address ?? ""),
    from_address: body.from_address ? String(body.from_address) : null,
    created_at: now,
    expires_at: now + windowMs,
    paid_at: null,
    outcome,
    out_base_units: math.outBase,
    out_decimals: to.decimals
  };
  saveDeposit(dep);

  const chainId = CHAIN_IDS[from.blockchain];
  let paymentUri: string;
  if (EVM_CHAINS.has(from.blockchain)) {
    paymentUri = from.address
      ? `ethereum:${from.address}@${chainId}/transfer?address=${address}&uint256=${raw}`
      : `ethereum:${address}@${chainId}?value=${raw}`;
  } else {
    paymentUri = `${from.blockchain.toLowerCase() === "btc" ? "bitcoin" : from.blockchain.toLowerCase()}:${address}?amount=${quote.amount}`;
  }
  return json({
    deposit_address: address,
    amount: quote.amount,
    amount_raw: BIG(raw),
    decimals: from.decimals,
    network: from.blockchain,
    protocol: requested,
    payment_uri: paymentUri,
    expires_at: dep.expires_at,
    chainflip_channel_id: requested === "chainflip" ? 7357 : null
  });
}

function makeSignerPlan(world: WorldState, body: Record<string, unknown>): Response {
  const quoteId = String(body.quote_id ?? "");
  const quote = loadQuote(quoteId);
  if (!quote) return json({ error: "SELECTED_QUOTE_IS_NOT_SET", status: 400 }, 400);
  const from = fixtureFor(quote.from_asset);
  const to = fixtureFor(quote.to_asset);
  if (!from || !to || !EVM_CHAINS.has(from.blockchain)) return json({ error: "UNSUPPORTED_PAIR", status: 400 }, 400);
  const math = priceQuote(world, quote.from_asset, quote.to_asset, quote.amount, 0.003, 0.2);
  if (!math) return json({ error: "UNSUPPORTED_PAIR", status: 400 }, 400);

  const now = Date.now();
  const rand = mulberry32(world.seed + now % 99991);
  const router = simDepositAddress(from.blockchain, rand);
  const raw = toBaseUnits(quote.amount, from.decimals);
  const chainId = CHAIN_IDS[from.blockchain]!;
  const pad = (v: bigint | string): string => (typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "")).padStart(64, "0");

  const txs: Array<Record<string, unknown>> = [];
  if (from.address) {
    txs.push({ to: from.address, data: `0x095ea7b3${pad(router)}${pad(raw)}`, value: "0", chainId });
    txs.push({ to: router, data: `0x7e57c0de${pad(raw)}`, value: "0", chainId });
  } else {
    txs.push({ to: router, data: "0x7e57c0de", value: raw.toString(), chainId });
  }

  // a signer-lane swap is "paid" the moment the user broadcasts — model that
  const outcome = magicOutcome(quote.amount, world.scenario);
  saveDeposit({
    quote_id: quoteId,
    receipt_hint: null,
    protocol: String(body.protocol ?? "rango"),
    from_asset: quote.from_asset,
    to_asset: quote.to_asset,
    amount_display: quote.amount,
    deposit_address: router,
    network: from.blockchain,
    to_address: String(body.to_address ?? ""),
    from_address: body.from_address ? String(body.from_address) : null,
    created_at: now,
    expires_at: now + 30 * 60_000,
    paid_at: now,
    outcome: outcome === "expire" ? "happy" : outcome,
    out_base_units: math.outBase,
    out_decimals: to.decimals
  });
  return json({ unsigned_transactions: txs, protocol: body.protocol ?? "rango" });
}

function statusFor(quoteId: string): Response {
  const dep = loadDeposit(quoteId);
  if (!dep) return json({ status: "pending", protocol: null });
  const s = depositStatus(dep);
  return json({
    status: s.state,
    protocol: dep.protocol,
    in_amount: dep.amount_display,
    // A scenario may force its own out_amount (the phantom story returns raw
    // base-unit garbage a faulty status source might) — otherwise derive it.
    out_amount: s.out_amount ?? (s.state === "success" ? fromBaseUnits(dep.out_base_units, dep.out_decimals) : null),
    dest_tx_hash: s.dest_tx_hash,
    refund_tx_hash: s.refund_tx_hash,
    error: s.error,
    scanner_url: null,
    native_scanner_url: null
  });
}

function balancesFor(world: WorldState, wallets: Array<{ address: string; chain: string }>): Response {
  return json({
    wallets: wallets.map(({ address, chain }) => {
      const holdings = world.wallets[address] ?? world.wallets[address.toLowerCase()] ?? {};
      const balances = Object.entries(holdings)
        .filter(([key]) => key.toUpperCase().startsWith(`${chain.toUpperCase()}:`))
        .map(([key, amount]) => {
          const symbol = key.split(":")[1] ?? key;
          const fixture = fixtureFor(`${chain.toUpperCase()}.${symbol}`) ?? { price_usd: 0 };
          return { token_symbol: symbol, balance: amount, balance_usd: Number((Number(amount) * fixture.price_usd).toFixed(2)) };
        });
      return { chain, address, balances };
    })
  });
}

async function bodyJson(init?: RequestInit): Promise<Record<string, unknown> | Array<Record<string, unknown>>> {
  try {
    return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// The whole simulated backend as a fetch-compatible function.
export function simFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace(/^\/test-mode/, "");
    const world = loadWorld();

    if (path === "/health") return json({ ok: true, simulated: true });
    if (path === "/assets") {
      const { FIXTURE_ASSETS } = await import("./fixtures.js");
      return json({ tokens: FIXTURE_ASSETS.map((a) => ({ ...a, coingecko_id: null, protocols: SIM_PROVIDERS.map((p) => p.protocol) })) });
    }
    if (path === "/streaming-quotes") {
      const params = parseQuoteParams(url);
      if (!params) return json({ error: "MISSING_PARAMS", status: 400 }, 400);
      if (!fixtureFor(params.from) || !fixtureFor(params.to)) return json({ error: "NO_QUOTES_FOR_PAIR", status: 404 }, 404);
      return sseResponse(world, params);
    }
    if (path === "/quote" || path === "/quote-deposit") {
      const params = parseQuoteParams(url);
      if (!params) return json({ error: "MISSING_PARAMS", status: 400 }, 400);
      if (!fixtureFor(params.from) || !fixtureFor(params.to)) return json({ error: "NO_QUOTES_FOR_PAIR", status: 404 }, 404);
      const now = Date.now();
      const quoteId = registerQuote(params);
      const quotes = providersFor(path === "/quote-deposit")
        .map((p) => ({ protocol: p.protocol, data: offerData(world, params, p, now) }))
        .filter((q) => q.data !== null);
      return json({ quote_id: quoteId, timestamp: new Date(now).toISOString(), quotes });
    }
    if (path === "/deposit-address") return makeDeposit(world, (await bodyJson(init)) as Record<string, unknown>);
    if (path === "/deposit") return makeSignerPlan(world, (await bodyJson(init)) as Record<string, unknown>);
    if (path === "/status") {
      const body = (await bodyJson(init)) as Record<string, unknown>;
      return statusFor(String(body.quote_id ?? ""));
    }
    if (path === "/balances") {
      const body = await bodyJson(init);
      return balancesFor(world, Array.isArray(body) ? (body as Array<{ address: string; chain: string }>) : []);
    }
    if (path === "/save-transaction") return json({ saved: true });
    return json({ error: `Simulated backend has no route for ${path}`, status: 404 }, 404);
  }) as typeof fetch;
}
