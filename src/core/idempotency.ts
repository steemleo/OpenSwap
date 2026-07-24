import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { dataDir, ensureDir } from "./paths.js";

// The only defense against double-submitting an irreversible swap on retry:
// a persisted key → result map. Same key = replay the stored result, never a
// second trade. Entries expire after 24h.
//
// A key is RESERVED (status "pending") immediately before broadcast and
// completed after — so a crash mid-broadcast, or a concurrent identical run,
// finds the pending marker and refuses instead of trading twice.
const TTL_MS = 24 * 60 * 60 * 1000;

interface Entry {
  at: number;
  status?: "pending" | "done"; // absent on legacy entries = done
  result?: unknown;
}

function storePath(): string {
  return join(dataDir(), "idempotency.json");
}

function readStore(): Record<string, Entry> {
  try {
    return JSON.parse(readFileSync(storePath(), "utf8")) as Record<string, Entry>;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, Entry>): void {
  ensureDir(dataDir());
  const tmp = storePath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  renameSync(tmp, storePath());
}

export function deriveIdempotencyKey(parts: Record<string, string | number>): string {
  const canonical = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k]}`)
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function findIdempotentResult(key: string, now = Date.now()): unknown | undefined {
  const store = readStore();
  const entry = store[key];
  if (!entry || now - entry.at > TTL_MS) return undefined;
  if (entry.status === "pending") return undefined;
  return entry.result;
}

export type ReservationState =
  | { state: "reserved" }
  | { state: "pending"; since: number }
  | { state: "done"; result: unknown };

export function reserveIdempotentKey(key: string, now = Date.now()): ReservationState {
  const store = readStore();
  for (const [k, v] of Object.entries(store)) {
    if (now - v.at > TTL_MS) delete store[k];
  }
  const entry = store[key];
  if (entry) {
    if (entry.status === "pending") return { state: "pending", since: entry.at };
    return { state: "done", result: entry.result };
  }
  store[key] = { at: now, status: "pending" };
  writeStore(store);
  return { state: "reserved" };
}

// Only for failures PROVEN pre-broadcast — a reservation whose broadcast may
// have happened must stay pending until the window expires.
export function releaseIdempotentKey(key: string): void {
  const store = readStore();
  if (store[key]?.status === "pending") {
    delete store[key];
    writeStore(store);
  }
}

export function saveIdempotentResult(key: string, result: unknown, now = Date.now()): void {
  const store = readStore();
  for (const [k, v] of Object.entries(store)) {
    if (now - v.at > TTL_MS) delete store[k];
  }
  store[key] = { at: store[key]?.at ?? now, status: "done", result };
  writeStore(store);
}
