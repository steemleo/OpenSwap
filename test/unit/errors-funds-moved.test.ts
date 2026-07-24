import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliError } from "../../src/core/errors.js";
import { errorEnvelope } from "../../src/render/json.js";

// funds_may_have_moved was declared, rendered, documented as the primary agent
// safety rule in AGENT-CONTRACT.md — and never set true anywhere in the codebase. It
// read `false` even on BROADCAST_UNKNOWN, whose own message says a transaction
// may already be on-chain. Nothing failed, because nothing asserted it.
describe("funds_may_have_moved", () => {
  it("is true by construction for BROADCAST_UNKNOWN", () => {
    const err = new CliError("BROADCAST_UNKNOWN", "may have crashed after broadcasting");
    expect(err.fundsMayHaveMoved).toBe(true);
    expect(err.exitCode).toBe(7);
  });

  it("reaches the machine envelope agents actually read", () => {
    const env = JSON.parse(errorEnvelope("swap", new CliError("BROADCAST_UNKNOWN", "x"))) as {
      error: { funds_may_have_moved: boolean; code: string };
    };
    expect(env.error.funds_may_have_moved).toBe(true);
    expect(env.error.code).toBe("BROADCAST_UNKNOWN");
  });

  it("stays false for errors where nothing was submitted", () => {
    expect(new CliError("VALIDATION", "bad input").fundsMayHaveMoved).toBe(false);
    expect(new CliError("NO_ROUTE", "no route").fundsMayHaveMoved).toBe(false);
    expect(new CliError("NETWORK", "offline").fundsMayHaveMoved).toBe(false);
  });

  it("can still be forced on for a non-broadcast code", () => {
    expect(new CliError("INTERNAL", "x", { fundsMayHaveMoved: true }).fundsMayHaveMoved).toBe(true);
  });

  // The original defect was reachability, not logic: guard the property itself.
  it("is set somewhere in src/ — the field must not go dead again", () => {
    const root = join(import.meta.dirname, "../../src");
    const files = ["core/errors.ts", "core/signer/evm.ts", "commands/swap.ts", "commands/bot.ts"];
    const anySet = files.some((f) => {
      try {
        return /fundsMayHaveMoved[^\n]*(?:true|BROADCAST_UNKNOWN)/.test(readFileSync(join(root, f), "utf8"));
      } catch {
        return false;
      }
    });
    expect(anySet, "no source file ever sets fundsMayHaveMoved").toBe(true);
  });
});
