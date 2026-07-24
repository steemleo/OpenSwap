import { fromBaseUnits } from "./amount.js";
import { CliError } from "./errors.js";
import {
  isEvmChain,
  signerConfigured,
  signerLaneEnabled,
  SIGNER_LANE_DISABLED_REASON,
  type ExecutionLane
} from "./chains.js";
import type { LeoKitApi, QuoteParams } from "./api.js";
import type { QuoteSet, RouteOffer, WireFee, WireOfferData, WireQuoteResponse } from "./types.js";

// A route we refused to trust. Dropping one silently is what let an unreadable
// amount masquerade as "this pair is not supported" — always carry the reason.
export interface DroppedOffer {
  protocol: string;
  reason: string;
}

// The wire signals "could not price this fee" with usd: 0, not null, so a zero
// against a real amount means UNKNOWN, not free. Only a fee whose amount is
// itself zero is genuinely free. Getting this backwards understated live
// debridge fees ~8.6x and handed "cheapest" to the least-known route.
function pricedFeeUsd(f: WireFee): number | null {
  if (typeof f.usd !== "number" || !Number.isFinite(f.usd)) return null;
  if (f.usd !== 0) return f.usd;
  const amt = f.amount;
  if (amt === null || amt === undefined) return 0;
  const n = typeof amt === "number" ? amt : Number(amt);
  return Number.isFinite(n) && n === 0 ? 0 : null;
}

// Server-provided ranking flags are not always reliable for partially priced
// fees, so all three flags are recomputed locally from canonical per-offer data.
export function normalizeWireOffer(
  q: { protocol?: unknown; data?: unknown },
  drops?: DroppedOffer[]
): RouteOffer | null {
  const d = q.data as WireOfferData | undefined;
  if (!d || typeof d !== "object") return null;
  const arr = normalizeOffers([{ protocol: String(q.protocol ?? d.protocol ?? "unknown"), data: d }], drops);
  return arr[0] ?? null;
}

function normalizeOffers(
  quotes: Array<{ protocol: string; data: WireOfferData }>,
  drops?: DroppedOffer[]
): RouteOffer[] {
  const offers: RouteOffer[] = [];
  for (const q of quotes) {
    const d = q.data;
    if (!d || typeof d !== "object") continue;
    const outDecimals = typeof d.out_asset_decimal === "number" ? d.out_asset_decimal : null;
    const expectedOutRaw = d.expected_amount_out;
    if (outDecimals === null || expectedOutRaw === undefined || expectedOutRaw === null) {
      drops?.push({ protocol: q.protocol, reason: "the quote carried no readable output amount or decimals" });
      continue;
    }

    // expected_amount_out is base units; big values arrive as strings via the
    // bigint-preserving parse, small ones as numbers.
    let expectedOutBase: string;
    if (typeof expectedOutRaw === "string") {
      expectedOutBase = expectedOutRaw.includes(".") ? expectedOutRaw.split(".")[0]! : expectedOutRaw;
    } else {
      expectedOutBase = String(Math.round(expectedOutRaw));
    }
    if (!/^\d+$/.test(expectedOutBase)) {
      drops?.push({
        protocol: q.protocol,
        reason: `its output amount (${String(expectedOutRaw)}) could not be read as an exact whole number`
      });
      continue;
    }

    // Normalize the fee list once, here, so nothing downstream — totals, the
    // cheapest badge, the JSON envelope — can read an unpriced fee as free.
    // `raw` below still carries the untouched wire response.
    const fees: WireFee[] = (Array.isArray(d.fees) ? d.fees : []).map((f) => ({ ...f, usd: pricedFeeUsd(f) }));
    const feesComplete = fees.length > 0 && fees.every((f) => f.usd !== null);
    const feesTotalUsd = feesComplete ? fees.reduce<number>((acc, f) => acc + (f.usd ?? 0), 0) : null;

    const recSlip = d.recommended_slippage;
    let recommendedSlippageBps: number | null = null;
    if (recSlip !== undefined && recSlip !== null) {
      const n = Number(recSlip);
      // upstream value is percent (e.g. 0.5 = 0.5%) — convert to bps
      if (Number.isFinite(n) && n >= 0) recommendedSlippageBps = Math.round(n * 100);
    }

    offers.push({
      protocol: typeof q.protocol === "string" ? q.protocol : String(d.protocol ?? "unknown"),
      variant: typeof d.type === "string" && d.type ? d.type : null,
      expectedOutBase,
      expectedOutDisplay: fromBaseUnits(expectedOutBase, outDecimals),
      expectedOutUsd: numOrNull(d.expected_amount_out_usd),
      inputUsd: numOrNull(d.input_amount_usd),
      outDecimals,
      inDecimals: typeof d.in_asset_decimal === "number" ? d.in_asset_decimal : 0,
      feesTotalUsd,
      feesComplete,
      fees,
      etaSeconds: numOrNull(d.total_swap_seconds),
      expiresAt: typeof d.expires_at === "number" ? d.expires_at : 0,
      ttlSeconds: typeof d.ttl_seconds === "number" ? d.ttl_seconds : 0,
      route: Array.isArray(d.route) ? d.route.map(String) : [],
      supportsDepositAddress:
        d.supports_deposit_address === undefined ? null : d.supports_deposit_address === true,
      minInputDisplay: d.min_swap_amount !== undefined && d.min_swap_amount !== null ? String(d.min_swap_amount) : null,
      recommendedSlippageBps,
      flags: { bestOutput: false, fastest: false, cheapest: false },
      raw: d as WireOfferData
    });
  }

  return offers;
}

export function finalizeOffers(offers: RouteOffer[]): RouteOffer[] {
  computeFlags(offers);
  sortOffers(offers);
  return offers;
}

// The backend genuinely not quoting a pair and us refusing to read the quotes it
// sent are different failures with different fixes. Never report them alike.
export function noRouteError(fromAsset: string, toAsset: string, drops: DroppedOffer[]): CliError {
  if (drops.length > 0) {
    const detail = drops.map((d) => `${d.protocol} — ${d.reason}`).join("; ");
    return new CliError(
      "UPSTREAM",
      `${drops.length} route${drops.length === 1 ? " was" : "s were"} returned for this pair but could not be read, so none are safe to show: ${detail}.`,
      {
        retryable: true,
        details: { dropped: drops },
        actions: [
          { label: "Try a smaller amount", command: "openswap quote" },
          { label: "Report this — it is a bug, not your input", command: "openswap feedback" }
        ]
      }
    );
  }
  return new CliError(
    "NO_ROUTE",
    `No provider quoted ${fromAsset} → ${toAsset} right now — this pair may not be supported. This is about the pair, not the amount.`,
    { retryable: true, actions: [{ label: "Search supported assets", command: "openswap assets search" }] }
  );
}

export function normalizeQuoteResponse(
  wire: WireQuoteResponse,
  request: { fromAsset: string; toAsset: string; amountDisplay: string },
  drops?: DroppedOffer[]
): QuoteSet {
  const offers = finalizeOffers(
    normalizeOffers(
      (wire.quotes ?? []).map((q) => ({
        protocol: typeof q.protocol === "string" ? q.protocol : String(q.data?.protocol ?? "unknown"),
        data: q.data
      })),
      drops
    )
  );
  return {
    quoteId: typeof wire.quote_id === "string" ? wire.quote_id : "",
    timestamp: wire.timestamp,
    fromAsset: request.fromAsset,
    toAsset: request.toAsset,
    amountDisplay: request.amountDisplay,
    offers
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function computeFlags(offers: RouteOffer[]): void {
  if (offers.length === 0) return;
  let bestOut = offers[0]!;
  for (const o of offers) {
    if (BigInt(o.expectedOutBase) > BigInt(bestOut.expectedOutBase)) bestOut = o;
  }
  bestOut.flags.bestOutput = true;

  const withEta = offers.filter((o) => o.etaSeconds !== null);
  if (withEta.length > 0) {
    withEta.reduce((min, o) => (o.etaSeconds! < min.etaSeconds! ? o : min)).flags.fastest = true;
  }
  // Only offers with COMPLETE fee data may win cheapest (planning-pack rule).
  const withFees = offers.filter((o) => o.feesTotalUsd !== null);
  if (withFees.length > 0) {
    withFees.reduce((min, o) => (o.feesTotalUsd! < min.feesTotalUsd! ? o : min)).flags.cheapest = true;
  }
}

// Default ranking: highest expected output (exact bigint compare), fees and
// speed as stable tie-breakers.
function sortOffers(offers: RouteOffer[]): void {
  offers.sort((a, b) => {
    const av = BigInt(a.expectedOutBase);
    const bv = BigInt(b.expectedOutBase);
    if (av !== bv) return bv > av ? 1 : -1;
    const af = a.feesTotalUsd ?? Number.POSITIVE_INFINITY;
    const bf = b.feesTotalUsd ?? Number.POSITIVE_INFINITY;
    if (af !== bf) return af - bf;
    return (a.etaSeconds ?? Number.POSITIVE_INFINITY) - (b.etaSeconds ?? Number.POSITIVE_INFINITY);
  });
}

export function recommendationReason(offer: RouteOffer, offerCount: number): string {
  const parts: string[] = [];
  if (offer.flags.bestOutput) parts.push(`highest expected receive of the ${offerCount} routes returned`);
  if (offer.flags.fastest) parts.push("fastest estimated completion");
  if (offer.flags.cheapest) parts.push("lowest total priced fees");
  if (parts.length === 0) return "meets your selection";
  return parts.join(" · ");
}

export async function fetchQuotes(
  api: LeoKitApi,
  params: QuoteParams,
  opts: { depositOnly?: boolean } = {}
): Promise<QuoteSet> {
  let wire;
  try {
    wire = opts.depositOnly ? await api.getQuoteDeposit(params) : await api.getQuote(params);
    // The API may briefly serve a cached response without a quote_id. A set
    // without an id cannot prepare a deposit — wait out the window and refetch.
    if (typeof wire.quote_id !== "string" || wire.quote_id.trim() === "") {
      await new Promise((r) => setTimeout(r, 2200));
      wire = opts.depositOnly ? await api.getQuoteDeposit(params) : await api.getQuote(params);
      if (typeof wire.quote_id !== "string" || wire.quote_id.trim() === "") {
        throw new CliError("UPSTREAM", "LeoKit returned a quote without an id twice in a row.", { retryable: true });
      }
    }
  } catch (err) {
    // the backend answers "no quotes for this pair" with a 404
    if (err instanceof CliError && err.code === "UPSTREAM" && err.details?.status === 404) {
      throw new CliError(
        "NO_ROUTE",
        `No provider quoted ${params.from_asset} → ${params.to_asset} right now — this pair may not be supported. This is about the pair, not the amount.`,
        { actions: [{ label: "Search supported assets", command: "openswap assets search" }] }
      );
    }
    throw err;
  }
  const set = normalizeQuoteResponse(wire, {
    fromAsset: params.from_asset,
    toAsset: params.to_asset,
    amountDisplay: params.amount
  });
  if (set.offers.length === 0) {
    throw new CliError(
      "NO_ROUTE",
      opts.depositOnly
        ? "No deposit-payable route exists for this pair right now — any remaining routes execute by signing transactions. This is about the pair, not the amount."
        : "No provider quoted this pair right now — it may not be supported. This is about the pair, not the amount.",
      {
        actions: opts.depositOnly
          ? [
              { label: "See every route for this pair", command: "openswap quote" },
              { label: "Set up a signing wallet (2 minutes)", command: "openswap wallet setup" }
            ]
          : [{ label: "Search supported assets", command: "openswap assets search" }]
      }
    );
  }
  return set;
}

export function msUntilExpiry(offer: RouteOffer, now = Date.now()): number {
  return offer.expiresAt > 0 ? offer.expiresAt - now : 0;
}

const DEPOSIT_SAFE = new Set(["chainflip", "near", "relay", "relay-deposit"]);

// How a route can actually be executed by this CLI:
//   deposit_address — pay a minted address from any wallet (default lane)
//   wallet_signed   — /deposit unsigned txs signed by the configured EVM signer
//   unsupported     — quote-only from this CLI today (non-EVM source, no deposit)
export function executionLane(offer: RouteOffer, fromAsset: string): ExecutionLane {
  if (DEPOSIT_SAFE.has(offer.protocol) || offer.supportsDepositAddress === true) return "deposit_address";
  const chain = fromAsset.split(".")[0] ?? "";
  if (isEvmChain(chain)) return "wallet_signed";
  return "unsupported";
}

export { signerConfigured, signerLaneEnabled, SIGNER_LANE_DISABLED_REASON };

// Streaming route discovery. The one-shot quote endpoint applies a settle
// deadline, so slower providers can be missing from any given response. The
// SSE stream gives every provider its window, emits offers as they settle,
// and persists the complete round under its own quote_id — so a route
// selected from a streamed set cannot vanish at deposit time.
export interface StreamQuoteOptions {
  depositOnly?: boolean;
  timeoutMs?: number;
  onOffer?: (offer: RouteOffer, count: number) => void;
}

export async function streamQuoteSet(
  api: LeoKitApi,
  params: QuoteParams,
  opts: StreamQuoteOptions = {}
): Promise<QuoteSet> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 25000);
  const byKey = new Map<string, RouteOffer>();
  const drops: DroppedOffer[] = [];
  let quoteId = "";
  let timestamp = new Date().toISOString();

  const streamParams = {
    ...params,
    ...(opts.depositOnly ? { use_deposit_address: "true" } : {})
  } as QuoteParams & { use_deposit_address?: string };

  try {
    for await (const event of api.streamQuotes(streamParams, abort.signal)) {
      const type = event.type;
      if (type === "init") {
        if (typeof event.quote_id === "string") quoteId = event.quote_id;
        if (typeof event.timestamp === "string") timestamp = event.timestamp;
        continue;
      }
      if (type !== "quote") continue;
      const offer = normalizeWireOffer(event as { protocol?: unknown; data?: unknown }, drops);
      if (!offer) continue;
      const key = `${offer.protocol}|${offer.variant ?? ""}`;
      const isNew = !byKey.has(key);
      byKey.set(key, offer); // later events win (they may carry enriched data)
      if (isNew) opts.onOffer?.(offer, byKey.size);
    }
  } catch (err) {
    // an aborted stream is the timeout boundary, not a failure — keep what we have
    if (!(abort.signal.aborted && byKey.size > 0)) {
      if (byKey.size === 0) {
        // the backend answers "no quotes for this pair" with a 404 — surface
        // it as the friendly NO_ROUTE, exactly like the one-shot path
        if (err instanceof CliError && err.code === "UPSTREAM" && err.details?.status === 404) {
          throw noRouteError(params.from_asset, params.to_asset, drops);
        }
        throw err;
      }
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }

  const collected = finalizeOffers([...byKey.values()]);
  let offers = collected;
  if (opts.depositOnly) {
    offers = offers.filter(
      (o) => o.supportsDepositAddress || ["chainflip", "near", "relay"].includes(o.protocol)
    );
    // every route in a deposit-only set is executable by definition
    for (const o of offers) o.supportsDepositAddress = true;
    finalizeOffers(offers);
  }
  if (offers.length === 0) {
    // Name the actual cause — "no route" reads as transient when the real
    // problem is the pair (retrying a different SIZE can never help).
    if (opts.depositOnly && collected.length > 0) {
      throw new CliError(
        "NO_ROUTE",
        `${collected.length} route${collected.length === 1 ? "" : "s"} exist for this pair, but none can be paid by deposit address — they execute by signing transactions.`,
        {
          retryable: true,
          actions: [
            { label: "Set up a signing wallet to unlock them (2 minutes)", command: "openswap wallet setup" },
            { label: "See every route for this pair", command: "openswap quote" }
          ]
        }
      );
    }
    throw noRouteError(params.from_asset, params.to_asset, drops);
  }
  if (!quoteId) {
    throw new CliError("UPSTREAM", "The quote stream did not provide a quote id.", { retryable: true });
  }
  return {
    quoteId,
    timestamp,
    fromAsset: params.from_asset,
    toAsset: params.to_asset,
    amountDisplay: params.amount,
    offers
  };
}

// Machine shape for --json. Crypto quantities are strings; nothing is invented:
// absent fees stay absent, incomplete totals stay null.
export function quoteSetToJson(set: QuoteSet): Record<string, unknown> {
  return {
    quote_id: set.quoteId,
    timestamp: set.timestamp,
    request: {
      from_asset: set.fromAsset,
      to_asset: set.toAsset,
      amount_display: set.amountDisplay
    },
    routes: set.offers.map((o) => ({
      protocol: o.protocol,
      variant: o.variant,
      expected_receive: {
        display: o.expectedOutDisplay,
        base_units: o.expectedOutBase,
        decimals: o.outDecimals,
        usd_estimate: o.expectedOutUsd
      },
      fees: o.fees.map((f) => ({ type: f.type, asset: f.asset, amount: f.amount, usd: f.usd })),
      fees_total_usd: o.feesTotalUsd,
      fees_complete: o.feesComplete,
      eta_seconds: o.etaSeconds,
      expires_at: o.expiresAt,
      ttl_seconds: o.ttlSeconds,
      route: o.route,
      supports_deposit_address: o.supportsDepositAddress,
      min_input_display: o.minInputDisplay,
      recommended_slippage_bps: o.recommendedSlippageBps,
      flags: o.flags,
      recommendation: recommendationReason(o, set.offers.length),
      execution: executionLane(o, set.fromAsset)
    }))
  };
}
