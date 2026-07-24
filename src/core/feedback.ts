import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { release } from "node:os";
import { VERSION } from "../version.js";
import { dataDir, ensureDir } from "./paths.js";
import { assetCacheAgeMs } from "./assets.js";
import { resolveCredential } from "./credentials.js";
import { listReceipts } from "./receipts.js";
import { termCaps } from "../render/theme.js";
import { assetSymbol } from "../render/money.js";
import { CliError } from "./errors.js";

// Feedback delivery, in order:
//   1. The LeoDex feedback relay — the webhook it forwards to lives
//      server-side, so no bearer credential ships in this repo (a Discord
//      webhook URL is also its own delete credential; embedding one would let
//      anyone spam or destroy the intake channel for every shipped build).
//   2. The local outbox when the relay is unreachable.
// Forks: set OPENSWAP_FEEDBACK_WEBHOOK to your own Discord webhook (used
// first when present) or OPENSWAP_FEEDBACK_RELAY_URL to your own relay.
const FEEDBACK_RELAY_URL = "https://leodex-feedback.kkazi32.workers.dev";

export function feedbackWebhookUrl(): string | null {
  return process.env.OPENSWAP_FEEDBACK_WEBHOOK?.trim() || null;
}

export function feedbackRelayUrl(): string {
  return (process.env.OPENSWAP_FEEDBACK_RELAY_URL ?? process.env.LEOKIT_FEEDBACK_RELAY_URL)?.trim() || FEEDBACK_RELAY_URL;
}

// Discord embed for a feedback report. Mentions are hard-disabled so a shipped
// webhook can never be used to ping the team; lengths respect Discord limits.
export function toDiscordPayload(report: FeedbackReport): Record<string, unknown> {
  const isPulse = report.message.startsWith("[pulse");
  const title = isPulse ? "📊 Pulse" : report.kind === "bug" ? "🐛 Bug report" : "💡 Feature idea";
  const color = isPulse ? 0xf59e0b : report.kind === "bug" ? 0xef4444 : 0x22c55e;
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  if (report.diagnostics) {
    const d = report.diagnostics;
    fields.push(
      { name: "Version", value: `${d.appVersion} · ${d.platform}`.slice(0, 1024), inline: true },
      { name: "Terminal", value: d.theme.slice(0, 1024), inline: true }
    );
    if (d.logs.length > 0) {
      const logText = d.logs.map((l) => `[${l.level}] ${l.message}`).join("\n");
      fields.push({ name: "Diagnostics", value: ("```\n" + logText.slice(0, 990) + "\n```").slice(0, 1024) });
    }
  }
  return {
    username: "OpenSwap CLI",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title,
        description: report.message.slice(0, 4000),
        color,
        fields,
        timestamp: new Date().toISOString()
      }
    ]
  };
}

async function postToWebhook(report: FeedbackReport): Promise<boolean> {
  const url = feedbackWebhookUrl();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toDiscordPayload(report)),
      signal: AbortSignal.timeout(10000)
    });
    return res.ok; // Discord returns 204 on success
  } catch {
    return false;
  }
}

export type FeedbackKind = "bug" | "feature";

export interface FeedbackLogEntry {
  level: "warn" | "error";
  message: string;
  timestamp: string;
}

export interface FeedbackDiagnostics {
  screen: string;
  activeCoin: string;
  theme: string;
  platform: string;
  userAgent: string;
  appVersion: string;
  logs: FeedbackLogEntry[];
}

export interface FeedbackReport {
  kind: FeedbackKind;
  message: string;
  includeDiagnostics: boolean;
  diagnostics?: FeedbackDiagnostics;
}

export interface FeedbackSubmitResult {
  delivered: boolean;
  reference?: string;
  message: string;
}

const MAX_MESSAGE_LENGTH = 4000;
const MAX_LOG_MESSAGE_LENGTH = 1200;

// Redaction patterns shared with the LeoDex apps
// (battle-tested; over-redaction is the accepted tradeoff).
const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(seed phrase|mnemonic|private key|spend key|view key|pin|password|api[ _-]?key)\s*[:=]\s*[^\n,;]+/gi, "$1: [redacted]"],
  [/\b0x[a-fA-F0-9]{16,}\b/g, "[redacted-hex]"],
  [/\b(?:bc1|tb1|ltc1|t1|t3|zs|u1|uview|xpub|xprv)[a-zA-Z0-9]{14,}\b/g, "[redacted-address]"],
  [/\b[13][a-km-zA-HJ-NP-Z1-9]{25,}\b/g, "[redacted-address]"],
  [/\b[XY7][1-9A-HJ-NP-Za-km-z]{25,34}\b/g, "[redacted-address]"],
  [/\b[48][0-9AB][1-9A-HJ-NP-Za-km-z]{90,}\b/g, "[redacted-address]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[redacted-uuid]"],
  [/\b[A-Za-z0-9+/]{48,}={0,2}\b/g, "[redacted-token]"],
  [/\b[A-Za-z0-9][A-Za-z0-9:_-]{63,}\b/g, "[redacted-token]"]
];

export function sanitizeFeedbackText(value: string): string {
  return REDACTIONS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), value);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function logEntry(level: FeedbackLogEntry["level"], message: string): FeedbackLogEntry {
  return {
    level,
    message: truncate(sanitizeFeedbackText(message), MAX_LOG_MESSAGE_LENGTH),
    timestamp: new Date().toISOString()
  };
}

// Diagnostics are built OFFLINE (no network) so feedback works when the API
// doesn't. Receipts contribute state summaries only — never addresses, and
// the credential contributes its SOURCE only — never the key.
export function buildCliDiagnostics(): FeedbackDiagnostics {
  const caps = termCaps();
  const logs: FeedbackLogEntry[] = [];

  const cred = resolveCredential();
  logs.push(logEntry("warn", `credential source: ${cred.source}`));

  const age = assetCacheAgeMs();
  logs.push(logEntry("warn", `asset cache: ${age === null ? "not built" : `${Math.round(age / 60000)}m old`}`));

  const receipts = listReceipts().slice(0, 5);
  for (const r of receipts) {
    logs.push(
      logEntry(
        r.last_state === "failed" ? "error" : "warn",
        `receipt ${r.receipt_id}: ${r.amount_display} ${assetSymbol(r.from_asset)}→${assetSymbol(r.to_asset)} via ${r.protocol} · ${r.last_state} · created ${r.created_at}${r.last_error ? ` · error: ${r.last_error}` : ""}`
      )
    );
  }

  const latestOpen = receipts.find((r) => !["success", "failed", "refunded", "expired"].includes(r.last_state));

  return {
    screen: "terminal",
    activeCoin: latestOpen ? `${assetSymbol(latestOpen.from_asset)}→${assetSymbol(latestOpen.to_asset)}` : "-",
    theme: `${caps.depth} color · ${caps.unicode ? "unicode" : "ascii"} · ${caps.columns} cols · ${caps.isTTY ? "tty" : "non-tty"}`,
    platform: sanitizeFeedbackText(`cli-${process.platform}-${process.arch}`),
    userAgent: sanitizeFeedbackText(`openswap-cli/${VERSION} node/${process.versions.node} ${process.platform} ${release()}`),
    appVersion: VERSION,
    logs
  };
}

export function buildFeedbackReport(opts: {
  kind: FeedbackKind;
  message: string;
  includeDiagnostics: boolean;
}): FeedbackReport {
  const message = truncate(sanitizeFeedbackText(opts.message.trim()), MAX_MESSAGE_LENGTH);
  if (!message) throw new CliError("VALIDATION", "Feedback message is empty.");
  return {
    kind: opts.kind,
    message,
    includeDiagnostics: opts.includeDiagnostics,
    ...(opts.includeDiagnostics ? { diagnostics: buildCliDiagnostics() } : {})
  };
}

export async function submitFeedback(report: FeedbackReport): Promise<FeedbackSubmitResult> {
  // fork override: a self-hosted webhook, when configured, is tried first
  if (await postToWebhook(report)) {
    return { delivered: true, message: "Delivered." };
  }
  // primary: the relay (holds the team webhook server-side). The source tag
  // lets the worker route CLI feedback to the OpenSwap channel.
  let response: Response;
  try {
    response = await fetch(feedbackRelayUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...report, source: "openswap-cli" }),
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    throw new CliError("NETWORK", "Could not reach the feedback service.", { retryable: true, cause: err });
  }
  const result = (await response.json().catch(() => null)) as FeedbackSubmitResult | null;
  if (!response.ok || !result?.delivered) {
    throw new CliError("UPSTREAM", result?.message ?? `Feedback service returned ${response.status}.`, {
      retryable: true,
      details: { status: response.status }
    });
  }
  return result;
}

// Offline outbox: a failed submission is saved locally and retried on the
// next `openswap feedback` run — feedback is never silently lost.
interface OutboxEntry {
  failed_at: string;
  report: FeedbackReport;
}

function outboxPath(): string {
  return join(dataDir(), "feedback-outbox.json");
}

export function readOutbox(): OutboxEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(outboxPath(), "utf8")) as OutboxEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveToOutbox(report: FeedbackReport): void {
  ensureDir(dataDir());
  const entries = [...readOutbox(), { failed_at: new Date().toISOString(), report }].slice(-10);
  const tmp = outboxPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, outboxPath());
}

export async function flushOutbox(): Promise<number> {
  const entries = readOutbox();
  if (entries.length === 0) return 0;
  const remaining: OutboxEntry[] = [];
  let sent = 0;
  for (const entry of entries) {
    try {
      await submitFeedback(entry.report);
      sent += 1;
    } catch {
      remaining.push(entry);
    }
  }
  if (remaining.length === 0) {
    try {
      unlinkSync(outboxPath());
    } catch {
      // nothing to remove
    }
  } else {
    ensureDir(dataDir());
    const tmp = outboxPath() + ".tmp";
    writeFileSync(tmp, JSON.stringify(remaining, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, outboxPath());
  }
  return sent;
}
