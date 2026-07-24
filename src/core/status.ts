import type { LeoKitApi } from "./api.js";
import type { NormalizedStatus, SwapState, WireStatusCached, WireStatusLive } from "./types.js";
import { TERMINAL_STATES } from "./types.js";
import { CliError } from "./errors.js";

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

export interface PollOptions {
  quoteId: string;
  txId?: string;
  intervalMsStart?: number;
  intervalMsMax?: number;
  timeoutMs?: number | null;
  signal?: AbortSignal;
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

  let hardFailures = 0;
  while (true) {
    if (opts.signal?.aborted) {
      return last ?? normalizeStatus({ status: "pending" });
    }
    try {
      const raw = await api.getStatus({ quote_id: opts.quoteId, tx_id: opts.txId });
      hardFailures = 0;
      last = normalizeStatus(raw);
      const key = `${last.state}|${last.destTxHash ?? ""}|${last.refundTxHash ?? ""}`;
      if (key !== lastKey) {
        lastKey = key;
        await opts.onUpdate?.(last);
      }
      if (isTerminal(last.state)) return last;
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
