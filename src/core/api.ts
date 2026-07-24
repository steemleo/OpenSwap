import { CliError } from "./errors.js";
import { COMMUNITY_API_KEY } from "./credentials.js";
import { parseJsonPreservingBigInts } from "./amount.js";
import { DEFAULT_API_URL, USER_AGENT } from "../version.js";
import type {
  WireDepositAddressResponse,
  WireQuoteResponse,
  WireStatusCached,
  WireStatusLive
} from "./types.js";

// Fields that arrive as JSON numbers but must survive as exact strings.
const BIGINT_FIELDS = ["expected_amount_out", "amount_raw"];

export interface QuoteParams {
  from_asset: string;
  to_asset: string;
  amount: string; // display units — verified contract
  slippage_bps?: number;
  destination?: string;
  origin?: string;
  refund_address?: string;
}

export interface ApiOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  bigintFields?: string[];
}

// The backend serves 401/403/404/5xx as PLAINTEXT bodies mislabeled
// application/json ("Error 401: Something went wrong.") and has two JSON error
// envelopes ({error,status,code} and {error,status_code}). Parse defensively.
function parseErrorBody(status: number, text: string): { message: string; code?: string } {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message =
      (typeof parsed.error === "string" && parsed.error) ||
      (typeof parsed.message === "string" && parsed.message) ||
      text.slice(0, 300);
    const code = typeof parsed.code === "string" ? parsed.code : undefined;
    return { message, code };
  } catch {
    return { message: text.replace(/\s+/g, " ").trim().slice(0, 300) || `HTTP ${status}` };
  }
}

function mapHttpError(status: number, text: string, opts: { community?: boolean } = {}): CliError {
  const { message, code } = parseErrorBody(status, text);
  if (status === 401 || status === 403) {
    // Community access can be deliberately paused (abuse brake) — say so,
    // and point at the way that always works: a personal key.
    if (opts.community) {
      return new CliError(
        "AUTH_INVALID",
        "Community access is temporarily paused (heavy load or abuse protection). Your own free API key keeps working and earns you affiliate fees.",
        {
          details: { status, upstream_message: message, upstream_code: code },
          actions: [
            { label: "Create a free key at https://dash.leokit.dev, then store it", command: "openswap auth login" },
            { label: "Check back shortly — pauses are usually brief" }
          ]
        }
      );
    }
    return new CliError("AUTH_INVALID", "LeoKit rejected the API key for this request.", {
      details: { status, upstream_message: message, upstream_code: code },
      actions: [
        { label: "Store a valid key in your OS keychain", command: "openswap auth login" },
        { label: "Check what credential is being used", command: "openswap auth status" }
      ]
    });
  }
  if (status === 404) {
    return new CliError("UPSTREAM", `LeoKit API returned 404 for this request.`, {
      details: { status, upstream_message: message }
    });
  }
  if (status === 429) {
    return new CliError("UPSTREAM", "LeoKit API rate limit reached. Try again shortly.", {
      retryable: true,
      details: { status }
    });
  }
  if (status >= 500) {
    return new CliError("UPSTREAM", "LeoKit API had a server-side problem.", {
      retryable: true,
      details: { status, upstream_message: message, upstream_code: code }
    });
  }
  return new CliError("UPSTREAM", message, { details: { status, upstream_code: code } });
}

export class LeoKitApi {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const method = opts.method ?? "GET";
    const retries = opts.retries ?? (method === "GET" ? 2 : 0);
    let lastError: CliError | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1) + Math.random() * 200));
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            "Api-Key": this.apiKey,
            "User-Agent": USER_AGENT,
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {})
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs)
        });
        const text = await res.text();
        if (!res.ok) {
          const err = mapHttpError(res.status, text, { community: this.apiKey === COMMUNITY_API_KEY });
          if (err.retryable && attempt < retries) {
            lastError = err;
            continue;
          }
          throw err;
        }
        try {
          return parseJsonPreservingBigInts(text, opts.bigintFields ?? BIGINT_FIELDS) as T;
        } catch (parseErr) {
          throw new CliError("UPSTREAM", "LeoKit API returned a response that could not be parsed.", {
            details: { path, parse_error: String(parseErr), body_head: text.slice(0, 200) }
          });
        }
      } catch (err) {
        if (err instanceof CliError) {
          if (err.retryable && attempt < retries) {
            lastError = err;
            continue;
          }
          throw err;
        }
        const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
        const netErr = new CliError(
          isTimeout ? "TIMEOUT" : "NETWORK",
          isTimeout
            ? `LeoKit API did not respond within ${(opts.timeoutMs ?? this.timeoutMs) / 1000}s.`
            : "Could not reach the LeoKit API. Check your connection.",
          { retryable: true, cause: err, details: { path } }
        );
        if (attempt < retries) {
          lastError = netErr;
          continue;
        }
        throw netErr;
      }
    }
    throw lastError ?? new CliError("INTERNAL", "Request loop exited unexpectedly.");
  }

  async getAssetsRaw(): Promise<{ tokens: unknown[] }> {
    // ~27MB live — callers cache via assets.ts, never hold this on the hot path.
    return this.request<{ tokens: unknown[] }>("/assets", { timeoutMs: 120000, bigintFields: [] });
  }

  async getQuote(params: QuoteParams): Promise<WireQuoteResponse> {
    return this.request<WireQuoteResponse>("/quote", { query: { ...params } });
  }

  async getQuoteDeposit(params: QuoteParams): Promise<WireQuoteResponse> {
    return this.request<WireQuoteResponse>("/quote-deposit", { query: { ...params } });
  }

  async createDepositAddress(body: {
    quote_id: string;
    protocol: string;
    to_address: string;
    from_address?: string;
  }): Promise<WireDepositAddressResponse> {
    return this.request<WireDepositAddressResponse>("/deposit-address", { method: "POST", body });
  }

  async createDeposit(body: {
    quote_id: string;
    protocol: string;
    to_address: string;
    from_address?: string;
    [key: string]: unknown;
  }): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/deposit", { method: "POST", body });
  }

  async getStatus(body: { quote_id: string; tx_id?: string }): Promise<WireStatusLive | WireStatusCached> {
    return this.request<WireStatusLive | WireStatusCached>("/status", { method: "POST", body });
  }

  async getBalances(wallets: Array<{ address: string; chain: string }>): Promise<Record<string, unknown>> {
    // the handler expects a raw [{chain, address}] array body
    return this.request<Record<string, unknown>>("/balances", {
      method: "POST",
      body: wallets,
      timeoutMs: 60000
    });
  }

  async saveTransaction(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/save-transaction", { method: "POST", body });
  }

  // SSE over fetch — the backend streams quote events; key stays in the header
  // (never the URL). Yields parsed events until the stream ends or signal aborts.
  async *streamQuotes(params: QuoteParams, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}/streaming-quotes`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { "Api-Key": this.apiKey, "User-Agent": USER_AGENT, Accept: "text/event-stream" },
        signal
      });
    } catch (err) {
      // the one-shot path maps connection failures in request(); the SSE path
      // must give the same friendly NETWORK error, not a raw "fetch failed"
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new CliError("NETWORK", "Could not reach the LeoKit API. Check your connection.", {
        retryable: true,
        cause: err,
        details: { path: "/streaming-quotes" }
      });
    }
    if (!res.ok || !res.body) {
      throw mapHttpError(res.status, await res.text().catch(() => ""), { community: this.apiKey === COMMUNITY_API_KEY });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const dataLines = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());
          if (dataLines.length === 0) continue;
          const payload = dataLines.join("\n");
          if (payload === "[DONE]") return;
          try {
            yield parseJsonPreservingBigInts(payload, BIGINT_FIELDS) as Record<string, unknown>;
          } catch {
            // Non-JSON keepalive/comment frames are expected — skip silently.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
