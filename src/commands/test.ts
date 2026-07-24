import { defineCommand, runCommand } from "citty";
import * as p from "@clack/prompts";
import { unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir, isTestMode, testModeMarkerPath } from "../core/paths.js";
import { CliError } from "../core/errors.js";
import { emitData, failWith, resolveOutput } from "../render/output.js";
import { header } from "../render/components.js";
import { accent, bold, dim, glyph, ok, warn } from "../render/theme.js";
import { guardCancel } from "./shared.js";

// Test mode: the dry-run harness. Everything below only manipulates the
// marker file and the simulated world — the world itself lives in
// src/testmode/ and is served to the unchanged production code paths.

function requireTestMode(): void {
  if (!isTestMode()) {
    throw new CliError("USAGE", "This command needs test mode. Turn it on first: openswap test on", {
      actions: [{ label: "Enter test mode", command: "openswap test on" }]
    });
  }
}

const on = defineCommand({
  meta: { name: "on", description: "Enter test mode — full swap flows against a simulated backend, no real funds" },
  args: {
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("test on", args);
    try {
      const marker = testModeMarkerPath();
      ensureDir(dirname(marker));
      writeFileSync(marker, `entered ${new Date().toISOString()}\n`, { mode: 0o600 });
      if (ctx.mode !== "human") {
        emitData(ctx, { test_mode: true, environment: "simulated" });
        return;
      }
      // Otto hops into his sandbox — a two-frame dig, then the briefing.
      const { renderSandboxAnsi } = await import("../render/otto.js");
      const { termCaps } = await import("../render/theme.js");
      const frames: string[][] = [renderSandboxAnsi(termCaps(), 0), renderSandboxAnsi(termCaps(), 1)];
      if (process.stdout.isTTY && frames[0]!.length > 0) {
        process.stdout.write("\n");
        for (let i = 0; i < 6; i++) {
          const f = frames[(i % 2) as 0 | 1]!;
          if (i > 0) process.stdout.write(`\x1b[${f.length}A`);
          process.stdout.write(f.map((l) => `  ${l}`).join("\n") + "\n");
          if (i < 5) await new Promise((r) => setTimeout(r, 280));
        }
        process.stdout.write("\n");
      }
      p.intro(header("test mode"));
      p.note(
        [
          `Every command now runs against a ${bold("simulated")} backend:`,
          "real streaming quotes UX, deposit addresses, receipts, tracking —",
          "with simulated wallets and balances. No real funds can move, and",
          `your real receipts/state are untouched. Every screen shows ${warn(bold("TEST"))}.`,
          "",
          `Deposits auto-pay in a few seconds (or ${accent("openswap test pay <receipt>")}).`,
          `Magic amounts steer outcomes — see ${accent("openswap test status")}.`
        ].join("\n"),
        "You're in the sandbox"
      );
      const next = guardCancel(
        await p.select({
          message: "Where to first?",
          options: [
            { value: "swap", label: "Make a simulated swap", hint: "the full funnel, zero risk" },
            { value: "quote", label: "Stream simulated quotes" },
            { value: "tour", label: "Take the guided tour first" },
            { value: "done", label: "I'll explore on my own" }
          ]
        })
      );
      if (next === "swap") await runCommand((await import("./swap.js")).default, { rawArgs: [] });
      else if (next === "quote") await runCommand((await import("./quote.js")).default, { rawArgs: [] });
      else if (next === "tour") await runCommand((await import("./tour.js")).default, { rawArgs: [] });
      else p.outro(`Leave any time: ${accent("openswap test off")}`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const off = defineCommand({
  meta: { name: "off", description: "Leave test mode — back to real routes and real funds" },
  args: {
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("test off", args);
    try {
      try {
        unlinkSync(testModeMarkerPath());
      } catch {
        // already off
      }
      if (ctx.mode !== "human") {
        emitData(ctx, { test_mode: false, environment: "mainnet" });
        return;
      }
      p.intro(header());
      p.outro(`Test mode is ${bold("off")} — you're back on live routes. ${dim("Simulated receipts stay under `openswap test on` only.")}`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const status = defineCommand({
  meta: { name: "status", description: "Test-mode state: scenario, seed, simulated balances, magic amounts" },
  args: {
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("test status", args);
    try {
      if (!isTestMode()) {
        if (ctx.mode !== "human") {
          emitData(ctx, { test_mode: false });
          return;
        }
        process.stdout.write(`Test mode is ${bold("off")}. Enter it with ${accent("openswap test on")}\n`);
        return;
      }
      const { loadWorld, listDeposits, MAGIC_AMOUNTS, TEST_SIGNER_ADDRESS } = await import("../testmode/world.js");
      const world = loadWorld();
      const open = listDeposits().filter((d) => Date.now() < d.expires_at + 120_000);
      if (ctx.mode !== "human") {
        emitData(ctx, {
          test_mode: true,
          environment: "simulated",
          seed: world.seed,
          scenario: world.scenario,
          test_signer: TEST_SIGNER_ADDRESS,
          wallets: world.wallets,
          open_deposits: open.length,
          magic_amounts: MAGIC_AMOUNTS
        });
        return;
      }
      process.stdout.write(header("test mode") + "\n\n");
      process.stdout.write(`${ok(glyph("check"))} Test mode is ON ${dim(`· scenario "${world.scenario}" · seed ${world.seed}`)}\n\n`);
      process.stdout.write(`${bold("Simulated wallet")}  ${TEST_SIGNER_ADDRESS} ${dim("(signs with the burned anvil test key)")}\n`);
      for (const [addr, holdings] of Object.entries(world.wallets)) {
        for (const [key, amount] of Object.entries(holdings)) {
          process.stdout.write(`  ${dim(addr === TEST_SIGNER_ADDRESS ? "" : addr)}${key.padEnd(12)} ${amount}\n`);
        }
      }
      process.stdout.write(`\n${bold("Magic amounts")} ${dim("(the cents pick the story — great for scripted runs)")}\n`);
      for (const [suffix, cfg] of Object.entries(MAGIC_AMOUNTS)) {
        process.stdout.write(`  amount ending ${accent(suffix)}  ${cfg.label}\n`);
      }
      process.stdout.write(`\n${dim("Change the default:")} ${accent("openswap test scenario <happy|refund|fail|expire|slow>")}\n`);
      if (open.length > 0) process.stdout.write(`${dim("Open simulated deposits:")} ${open.length} ${dim("· pay one:")} ${accent("openswap test pay <receipt>")}\n`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const pay = defineCommand({
  meta: { name: "pay", description: "Simulate paying a deposit (instead of waiting for auto-pay)" },
  args: {
    id: { type: "positional", description: "Receipt (ost_…) or quote ID — latest open deposit when omitted", required: false },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("test pay", args);
    try {
      requireTestMode();
      const { listDeposits, loadDeposit, saveDeposit } = await import("../testmode/world.js");
      let quoteId = String(args.id ?? "").trim();
      if (quoteId.startsWith("ost_") || quoteId.startsWith("os_")) {
        const { readReceipt } = await import("../core/receipts.js");
        quoteId = readReceipt(quoteId).quote_id;
      }
      if (!quoteId) {
        const open = listDeposits()
          .filter((d) => d.paid_at === null && Date.now() < d.expires_at)
          .sort((a, b) => b.created_at - a.created_at);
        if (open.length === 0) throw new CliError("VALIDATION", "No open simulated deposit to pay. Start one: openswap swap");
        quoteId = open[0]!.quote_id;
      }
      const dep = loadDeposit(quoteId);
      if (!dep) throw new CliError("RECEIPT_NOT_FOUND", `No simulated deposit found for ${quoteId}.`);
      if (dep.paid_at !== null) {
        emitData(ctx, { paid: true, already: true, quote_id: quoteId });
        if (ctx.mode === "human") process.stdout.write(`Already paid ${dim(`(${new Date(dep.paid_at).toLocaleTimeString()})`)}\n`);
        return;
      }
      dep.paid_at = Date.now();
      saveDeposit(dep);
      if (ctx.mode !== "human") {
        emitData(ctx, { paid: true, quote_id: quoteId, amount: dep.amount_display, network: dep.network });
        return;
      }
      process.stdout.write(`${ok(glyph("check"))} Simulated payment sent: ${bold(`${dep.amount_display} on ${dep.network}`)} ${dim(`→ ${dep.deposit_address.slice(0, 10)}…`)}\n`);
      process.stdout.write(`${dim("Watch it land:")} ${accent(`openswap status --watch`)}\n`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const fund = defineCommand({
  meta: { name: "fund", description: "Adjust a simulated wallet balance" },
  args: {
    asset: { type: "positional", description: "CHAIN:SYMBOL, e.g. BASE:USDC", required: true },
    amount: { type: "positional", description: "New balance in display units", required: true },
    address: { type: "string", description: "Wallet address (default: the test signer)" },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("test fund", args);
    try {
      requireTestMode();
      const { loadWorld, saveWorld, TEST_SIGNER_ADDRESS } = await import("../testmode/world.js");
      const key = String(args.asset).toUpperCase();
      if (!/^[A-Z0-9]+:[A-Z0-9]+$/.test(key)) throw new CliError("USAGE", "Asset must be CHAIN:SYMBOL, e.g. BASE:USDC");
      const amount = String(args.amount);
      if (!/^\d+(\.\d+)?$/.test(amount)) throw new CliError("USAGE", "Amount must be a positive number.");
      const address = String(args.address ?? TEST_SIGNER_ADDRESS);
      const world = loadWorld();
      world.wallets[address] = { ...(world.wallets[address] ?? {}), [key]: amount };
      saveWorld(world);
      emitData(ctx, { funded: true, address, asset: key, balance: amount });
      if (ctx.mode === "human") process.stdout.write(`${ok(glyph("check"))} ${bold(key)} balance for ${dim(address)} is now ${bold(amount)}\n`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const scenario = defineCommand({
  meta: { name: "scenario", description: "Set the default outcome for simulated swaps" },
  args: {
    name: { type: "positional", description: "happy | refund | fail | expire | slow", required: true },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("test scenario", args);
    try {
      requireTestMode();
      const { loadWorld, saveWorld, SCENARIOS } = await import("../testmode/world.js");
      const name = String(args.name).toLowerCase();
      if (!(SCENARIOS as string[]).includes(name)) {
        throw new CliError("USAGE", `Unknown scenario "${name}". One of: ${SCENARIOS.join(", ")}`);
      }
      const world = loadWorld();
      world.scenario = name as (typeof SCENARIOS)[number];
      saveWorld(world);
      emitData(ctx, { scenario: name });
      if (ctx.mode === "human") process.stdout.write(`${ok(glyph("check"))} Default scenario is now ${bold(name)} ${dim("(magic amounts still override per swap)")}\n`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const reset = defineCommand({
  meta: { name: "reset", description: "Wipe the simulated world back to a fresh state" },
  args: {
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("test reset", args);
    try {
      requireTestMode();
      const { resetWorld } = await import("../testmode/world.js");
      const world = resetWorld();
      emitData(ctx, { reset: true, seed: world.seed, scenario: world.scenario });
      if (ctx.mode === "human") process.stdout.write(`${ok(glyph("check"))} Fresh simulated world ${dim(`(seed ${world.seed})`)}\n`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

export default defineCommand({
  meta: { name: "test", description: "Test mode — the full swap experience against a simulated backend, no real funds" },
  subCommands: { on, off, status, pay, fund, scenario, reset }
});
