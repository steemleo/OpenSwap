import type { LeoKitApi } from "./api.js";
import type { NormalizedStatus, StatusImplausibility, SwapState, WireStatusCached, WireStatusLive } from "./types.js";
import { TERMINAL_STATES } from "./types.js";
import { CliError } from "./errors.js";
import { isTestMode } from "./paths.js";

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "pending",
  "confirming",
  "swapping",
  "sending",
  "success",
  "failed",
  "refunded"
]);

// /status returns two shapes: the live normalizer (scanner_url/native_scanner_url)
// and the DB-cached terminal row (scanner/native_scanner/hash). Fold both into one.
export function normalizeStatus(raw: WireStatusLive | WireStatusCached): NormalizedStatus {
  const rec = raw as Record<string, unknown>;
  const stateRaw = typeof rec.status === "string" ? rec.status.toLowerCase() : "pending";
  const state = (KNOWN_STATES.has(stateRaw) ? stateRaw : "pending") as SwapState;
  const str = (k: string): string | null => (typeof rec[k] === "string" && rec[k] !== "" ? (rec[k] as string) : null);
  const amt = (k: string): string | null => {
    const v = rec[k];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return null;
  };
  return {
    state,
    protocol: str("protocol"),
    inAmount: amt("in_amount"),
    outAmount: amt("out_amount"),
    fromToken: str("from_token"),
    toToken: str("to_token"),
    destTxHash: str("dest_tx_hash") ?? str("hash"),
    refundTxHash: str("refund_tx_hash"),
    error: str("error"),
    scannerUrl: str("scanner_url") ?? str("scanner"),
    nativeScannerUrl: str("native_scanner_url") ?? str("native_scanner"),
    raw: rec
  };
}

export function isTerminal(state: SwapState): boolean {
  return TERMINAL_STATES.has(state);
}

// What this swap was QUOTED to do — the yardstick a reported success is
// measured against.
export interface StatusExpectation {
  expectedOutDisplay: string | null;
  createdAt: number | null;
}

// A terminal "success" is only as trustworthy as its corroboration. Status
// sources can serve wrong or stale rows — a mixed-up identifier, a stale
// cache, an indexer fault — and this CLI moves other people's money, so a
// claim is validated against the swap's own receipt before it is endorsed.
// The contract says statuses are never invented; that cuts both ways: an
// uncorroborated success is reported as a claim, never presented as fact.
export function statusImplausibilities(
  s: NormalizedStatus,
  exp: StatusExpectation,
  now = Date.now()
): StatusImplausibility[] {
  if (s.state !== "success") return [];
  const found: StatusImplausibility[] = [];
  if (!s.destTxHash) {
    found.push({
      code: "SUCCESS_WITHOUT_DEST_TX",
      message: "The backend reports success but names no destination transaction."
    });
  }
  const reported = s.outAmount === null ? NaN : Number(s.outAmount);
  const expected = exp.expectedOutDisplay === null ? NaN : Number(exp.expectedOutDisplay);
  if (Number.isFinite(reported) && Number.isFinite(expected) && reported > 0 && expected > 0) {
    const ratio = reported / expected;
    const log = Math.log10(ratio);
    // A ratio that IS a power of ten is the precise fingerprint of an
    // unconverted base-unit value (the wrong-divisor bug). Anything else far
    // outside the band a real fill could produce is some other wrong entity.
    if (ratio >= 1e5 && Math.abs(log - Math.round(log)) < 0.01) {
      found.push({
        code: "OUT_AMOUNT_LOOKS_LIKE_BASE_UNITS",
        message: `The reported amount is 10^${Math.round(log)} times the quote — the shape of an unconverted base-unit value.`
      });
    } else if (ratio > 3 || ratio < 1 / 3) {
      found.push({
        code: "OUT_AMOUNT_FAR_FROM_QUOTE",
        message: `The reported amount is ${ratio > 1 ? `~${Math.round(ratio).toLocaleString("en-US")}x` : `~1/${Math.round(1 / ratio).toLocaleString("en-US")}th of`} the quoted ${exp.expectedOutDisplay} — not this swap's outcome.`
      });
    }
  }
  // No crosschain swap settles seconds after its deposit address was minted.
  // Skipped in test mode, where the simulated clock runs up to 1000x.
  if (exp.createdAt !== null && !isTestMode() && now - exp.createdAt < 10_000) {
    found.push({
      code: "SUCCESS_TOO_SOON",
      message: "Success was reported seconds after the deposit address was created — before any swap could settle."
    });
  }
  return found;
}

export interface PollOptions {
  quoteId: string;
  txId?: string;
  intervalMsStart?: number;
  intervalMsMax?: number;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  expectation?: StatusExpectation;
  onUpdate?: (status: NormalizedStatus) => void | Promise<void>;
}

// Bounded exponential backoff with jitter. Timeout is a CLI bound, not a
// protocol bound — expiring here yields state "unknown to the CLI", never "failed".
export async function pollStatus(api: LeoKitApi, opts: PollOptions): Promise<NormalizedStatus> {
  const start = Date.now();
  let interval = opts.intervalMsStart ?? 5000;
  const max = opts.intervalMsMax ?? 30000;
  let last: NormalizedStatus | null = null;
  let lastKey = "";
  let distrustedPolls = 0;

  let hardFailures = 0;
  while (true) {
    if (opts.signal?.aborted) {
      return last ?? normalizeStatus({ status: "pending" });
    }
    try {
      const raw = await api.getStatus({ quote_id: opts.quoteId, tx_id: opts.txId });
      hardFailures = 0;
      last = normalizeStatus(raw);
      last.implausible = opts.expectation ? statusImplausibilities(last, opts.expectation) : [];
      const key = `${last.state}|${last.destTxHash ?? ""}|${last.refundTxHash ?? ""}|${last.implausible.map((i) => i.code).join(",")}`;
      if (key !== lastKey) {
        lastKey = key;
        await opts.onUpdate?.(last);
      }
      if (isTerminal(last.state)) {
        // A terminal claim that fails plausibility gets a few more polls to
        // correct itself (the backend may be mid-index); then it is returned
        // WITH its flags so no surface can mistake it for a verified terminal.
        if (last.implausible.length === 0 || distrustedPolls >= 3) return last;
        distrustedPolls++;
      }
    } catch (err) {
      // transient status failures preserve the last known state — but a key
      // that is REJECTED (not flaky) can never succeed by polling harder;
      // three auth rejections with no successful poll between them means stop.
      if (err instanceof CliError && (err.code === "AUTH_INVALID" || err.code === "AUTH_REQUIRED")) {
        hardFailures += 1;
        if (hardFailures >= 3) throw err;
      }
    }
    if (opts.timeoutMs != null && Date.now() - start > opts.timeoutMs) {
      return last ?? normalizeStatus({ status: "pending" });
    }
    const jitter = interval * (0.8 + Math.random() * 0.4);
    await sleep(jitter, opts.signal);
    interval = Math.min(interval * 1.5, max);
  }
}

// The abort listener must be removed when the timer resolves normally —
// `once` only cleans up when abort actually fires, so a long watch would leak
// one listener per poll and trip Node's MaxListenersExceededWarning.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
