import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, ensureDir } from "./paths.js";

// JSONL flight recorder: one line per lifecycle boundary, keyed by receipt.
// Never contains credentials; addresses/hashes only (already public on-chain).
function logPath(): string {
  return join(dataDir(), "flight-log.jsonl");
}

export interface FlightEvent {
  type: string;
  receipt_id?: string;
  quote_id?: string;
  usd?: number;
  [key: string]: unknown;
}

export function logFlight(event: FlightEvent): void {
  ensureDir(dataDir());
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  appendFileSync(logPath(), line + "\n", { mode: 0o600 });
}

export interface TradeRecord {
  at: number;
  usd: number;
}

// Trades executed in the trailing window — powers daily-volume + cooldown limits.
export function readRecentTrades(windowMs: number, now = Date.now()): TradeRecord[] {
  let text: string;
  try {
    text = readFileSync(logPath(), "utf8");
  } catch {
    return [];
  }
  const out: TradeRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { at?: string; type?: string; usd?: number };
      if (parsed.type !== "trade_executed" && parsed.type !== "deposit_address_created") continue;
      const at = Date.parse(parsed.at ?? "");
      if (Number.isNaN(at) || now - at > windowMs) continue;
      out.push({ at, usd: typeof parsed.usd === "number" ? parsed.usd : 0 });
    } catch {
      // tolerate partial lines from crashes
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}
