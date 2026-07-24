import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, isTestMode, receiptsDir } from "./paths.js";
import { CliError } from "./errors.js";
import type { ReceiptV1 } from "./types.js";

export function newReceiptId(): string {
  // sortable: timestamp base36 + random suffix ("os_"; pre-rename "lk_" stays
  // readable; "ost_" marks simulated receipts so they can never be mistaken)
  const prefix = isTestMode() ? "ost_" : "os_";
  return `${prefix}${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

function receiptPath(id: string): string {
  return join(receiptsDir(), `${id}.json`);
}

// Receipts are financial records: atomic tmp+rename writes, private dir, never
// any credential material inside.
export function writeReceipt(receipt: ReceiptV1): void {
  ensureDir(receiptsDir());
  const path = receiptPath(receipt.receipt_id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function readReceipt(id: string): ReceiptV1 {
  try {
    const parsed = JSON.parse(readFileSync(receiptPath(id), "utf8")) as ReceiptV1;
    if (parsed.schema_version !== "1" || !parsed.receipt_id) {
      throw new CliError("INTERNAL", `Receipt ${id} has an unrecognized format.`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError("RECEIPT_NOT_FOUND", `No receipt found for "${id}".`, {
      actions: [{ label: "List saved receipts", command: "openswap receipts list" }]
    });
  }
}

export function updateReceipt(id: string, patch: Partial<ReceiptV1>): ReceiptV1 {
  const current = readReceipt(id);
  const next: ReceiptV1 = { ...current, ...patch, updated_at: new Date().toISOString() };
  writeReceipt(next);
  return next;
}

export function listReceipts(): ReceiptV1[] {
  let files: string[];
  try {
    files = readdirSync(receiptsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const receipts: ReceiptV1[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(receiptsDir(), f), "utf8")) as ReceiptV1;
      if (parsed.schema_version === "1" && parsed.receipt_id) receipts.push(parsed);
    } catch {
      // skip unreadable entries — list must not fail on one bad file
    }
  }
  receipts.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return receipts;
}

export function latestOpenReceipt(): ReceiptV1 | null {
  const open = listReceipts().filter(
    (r) => !["success", "failed", "refunded", "expired"].includes(r.last_state)
  );
  return open[0] ?? null;
}
