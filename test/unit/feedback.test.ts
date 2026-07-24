import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFeedbackReport,
  readOutbox,
  saveToOutbox,
  sanitizeFeedbackText
} from "../../src/core/feedback.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "leokit-fb-"));
  process.env.XDG_DATA_HOME = tempDir;
  process.env.XDG_CONFIG_HOME = tempDir;
  process.env.XDG_CACHE_HOME = tempDir;
});

afterEach(() => {
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CACHE_HOME;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("sanitizeFeedbackText (desktop-parity redactions)", () => {
  it("redacts secrets, keys, addresses, uuids", () => {
    expect(sanitizeFeedbackText("my private key: 0xabc123seekrit")).toContain("[redacted]");
    expect(sanitizeFeedbackText("sent to 0x2222222222222222222222222222222222222222")).toContain("[redacted-hex]");
    expect(sanitizeFeedbackText("btc bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toContain("[redacted-address]");
    expect(sanitizeFeedbackText("key 0af0a156-32ad-4a4c-88a8-ee7c8b132648 leaked")).toContain("[redacted-uuid]");
  });
  it("leaves ordinary feedback alone", () => {
    const text = "The QR is cut off on iTerm2 at 80 cols";
    expect(sanitizeFeedbackText(text)).toBe(text);
  });
});

describe("buildFeedbackReport", () => {
  it("builds a relay-compatible shape with diagnostics", () => {
    const report = buildFeedbackReport({ kind: "bug", message: "  spinner froze  ", includeDiagnostics: true });
    expect(report.kind).toBe("bug");
    expect(report.message).toBe("spinner froze");
    expect(report.includeDiagnostics).toBe(true);
    expect(report.diagnostics?.appVersion).toBeTruthy();
    expect(report.diagnostics?.platform).toMatch(/^cli-/);
    expect(Array.isArray(report.diagnostics?.logs)).toBe(true);
    // credential value never appears; only its source
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
  it("omits diagnostics when not consented and rejects empty messages", () => {
    const report = buildFeedbackReport({ kind: "feature", message: "add TRON", includeDiagnostics: false });
    expect(report.diagnostics).toBeUndefined();
    expect(() => buildFeedbackReport({ kind: "bug", message: "   ", includeDiagnostics: false })).toThrow();
  });
});

describe("outbox", () => {
  it("persists failed reports and caps at 10", () => {
    for (let i = 0; i < 12; i++) {
      saveToOutbox({ kind: "bug", message: `m${i}`, includeDiagnostics: false });
    }
    const entries = readOutbox();
    expect(entries.length).toBe(10);
    expect(entries[entries.length - 1]!.report.message).toBe("m11");
  });
});

describe("toDiscordPayload", () => {
  it("formats bug/feature/pulse embeds with mentions disabled", async () => {
    const { toDiscordPayload } = await import("../../src/core/feedback.js");
    const bug = toDiscordPayload({ kind: "bug", message: "spinner froze", includeDiagnostics: false }) as never as {
      allowed_mentions: { parse: unknown[] }; embeds: Array<{ title: string; description: string; color: number }>;
    };
    expect(bug.allowed_mentions.parse).toEqual([]);
    expect(bug.embeds[0]!.title).toContain("Bug");
    const pulse = toDiscordPayload({ kind: "feature", message: "[pulse 3/3 v0.1.0 darwin] love it", includeDiagnostics: false }) as never as {
      embeds: Array<{ title: string }>;
    };
    expect(pulse.embeds[0]!.title).toContain("Pulse");
  });
  it("truncates long content within Discord limits", async () => {
    const { toDiscordPayload, buildFeedbackReport } = await import("../../src/core/feedback.js");
    const report = buildFeedbackReport({ kind: "bug", message: "x".repeat(5000), includeDiagnostics: true });
    const payload = toDiscordPayload(report) as never as {
      embeds: Array<{ description: string; fields: Array<{ value: string }> }>;
    };
    expect(payload.embeds[0]!.description.length).toBeLessThanOrEqual(4000);
    for (const f of payload.embeds[0]!.fields) expect(f.value.length).toBeLessThanOrEqual(1024);
  });
});
