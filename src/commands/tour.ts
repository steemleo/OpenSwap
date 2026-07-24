import { defineCommand, runCommand } from "citty";
import * as p from "@clack/prompts";
import { buildApi } from "../cli-context.js";
import { streamQuoteSet, executionLane } from "../core/quotes.js";
import { CliError } from "../core/errors.js";
import { resolveOutput, failWith } from "../render/output.js";
import { box, header, routeCard, timeline } from "../render/components.js";
import { accent, accentBold, bold, dim, glyph, ok, warn } from "../render/theme.js";
import { sanitize } from "../render/money.js";
import { guardCancel } from "./shared.js";

// The 2-minute tour: a real quote round (read-only, free) followed by a
// clearly simulated payment + tracking stage. Design rules:
//   - nothing state-changing is ever called (no deposit address, no receipt)
//   - the simulated card must be UNMISTAKABLY fake: no plausible address, no
//     QR, no clipboard copy — teaching the shape, never a payable target
//   - it ends with a continuation choice, never homework
const TOUR_FROM = "ETH.USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOUR_TO = "BASE.USDC-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOUR_AMOUNT = "100";

const SIM_STATES = ["pending", "confirming", "swapping", "sending", "success"] as const;
const SIM_LABELS: Record<(typeof SIM_STATES)[number], string> = {
  pending: "Deposit detected on the source chain",
  confirming: "Source network confirmations",
  swapping: "Crosschain swap in progress",
  sending: "Destination delivery",
  success: "Complete"
};

// Exported for tests: the simulated card must never contain anything that
// pattern-matches a payable address.
export function tourPaymentCardLines(expectedOut: string): string[] {
  return [
    `Send exactly     ${accentBold("100 USDC")}   ${warn("← simulated, do not send anything")}`,
    "Network          ETH",
    "",
    "Deposit address",
    `  ${dim("[ in a real swap, a payable address appears here — with a QR and your clipboard filled ]")}`,
    "",
    `Memo required    ${dim("none — the address alone routes this swap")}`,
    `Pay within       ${dim("real swaps show a live countdown here")}`,
    "",
    `Expected receive ${ok(`${expectedOut} USDC on BASE`)}`
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default defineCommand({
  meta: { name: "tour", description: "A 2-minute guided walkthrough of a swap — nothing real moves" },
  args: {
    "api-url": { type: "string", description: "Override the API base URL" }
  },
  async run({ args }) {
    const ctx = resolveOutput("tour", args as Record<string, unknown>);
    try {
      if (ctx.mode !== "human") {
        throw new CliError("VALIDATION", "The tour is interactive — run `openswap tour` in a terminal.", {
          actions: [{ label: "Machine-readable exploration instead", command: "openswap quote --json" }]
        });
      }
      p.intro(header("tour · nothing real moves"));
      p.note(
        [
          "You'll watch a complete swap, start to finish, in about 2 minutes.",
          `The prices are ${bold("real")} (quotes are free and read-only).`,
          `The payment and tracking are ${bold("simulated")} — no deposit address`,
          "is created, no funds move, nothing is saved."
        ].join("\n"),
        "The 2-minute tour"
      );

      // ── Act 1: real route discovery ──
      p.log.step(`${bold("Step 1 — routes.")} Watch providers compete for a real trade: ${accent("100 USDC on ETH → USDC on BASE")}`);
      const { api } = buildApi(args);
      const spin = p.spinner();
      spin.start("Streaming routes from every provider");
      let set;
      try {
        set = await streamQuoteSet(
          api,
          { from_asset: TOUR_FROM, to_asset: TOUR_TO, amount: TOUR_AMOUNT },
          { onOffer: (o, n) => spin.message(`Streaming routes — ${n} found (${sanitize(o.protocol)} just arrived)`) }
        );
      } catch (err) {
        spin.stop("Couldn't stream routes right now", 1);
        throw err;
      }
      spin.stop(`${set.offers.length} routes found`);
      const top = set.offers.slice(0, 3);
      const lines: string[] = [];
      top.forEach((offer, i) => {
        lines.push(...routeCard(offer, { index: i + 1, selected: i === 0, toSymbol: "USDC" }));
        if (i < top.length - 1) lines.push("");
      });
      process.stdout.write("\n" + lines.join("\n") + "\n\n");
      p.log.message(
        dim("Each card shows the expected receive, total fees, speed, and how long the price is guaranteed. The ") +
          accent(glyph("pointer")) +
          dim(" marks the best receive.")
      );

      // ── Act 2: how routes execute ──
      const depositable = set.offers.filter((o) => executionLane(o, TOUR_FROM) === "deposit_address").length;
      const signable = set.offers.filter((o) => executionLane(o, TOUR_FROM) === "wallet_signed").length;
      p.log.step(
        `${bold("Step 2 — two ways to pay.")} ${depositable} of these routes take a plain deposit: OpenSwap mints an address, you pay it from any wallet you already use. ${signable > 0 ? `${signable} more unlock with an optional signing wallet.` : ""}`
      );
      guardCancel(await p.select({ message: "Ready to see the payment step?", options: [{ value: "go", label: "Show me" }] }));

      // ── Act 3: simulated payment card ──
      const expectedOut = top[0]?.expectedOutDisplay ?? "99.7";
      process.stdout.write("\n" + `${warn(glyph("caution"))} ${bold("PRACTICE — everything below is a simulation. Nothing was created.")}` + "\n");
      process.stdout.write(box(tourPaymentCardLines(expectedOut), { accented: true }).join("\n") + "\n\n");
      p.log.message(
        dim("In a real swap you'd also get a receipt (" ) + accent("os_…") + dim(") — your permanent claim ticket. Every swap is resumable with it, even after closing the terminal.")
      );
      guardCancel(await p.select({ message: "Simulate paying it?", options: [{ value: "go", label: "Pretend I paid" }] }));

      // ── Act 4: simulated tracking ──
      process.stdout.write("\n" + dim("Watching for your payment (simulated) …") + "\n\n");
      for (let i = 0; i < SIM_STATES.length; i++) {
        const steps = SIM_STATES.map((s, j) => ({
          label: SIM_LABELS[s],
          state: (j < i ? "done" : j === i ? (s === "success" ? "done" : "active") : "todo") as "done" | "active" | "todo"
        }));
        process.stdout.write(timeline(steps).join("\n") + "\n\n");
        await sleep(i === 0 ? 900 : 700);
      }
      process.stdout.write(`${ok(glyph("check"))} ${bold("Swap complete (simulated).")} ${dim(`You'd have received ~${expectedOut} USDC on BASE.`)}\n\n`);

      // ── continuation: never homework ──
      const next = guardCancel(
        await p.select({
          message: "That's the whole flow. What next?",
          options: [
            { value: "quote", label: "Get a real quote", hint: "still free — no wallet needed" },
            { value: "swap", label: "Make a real swap" },
            { value: "wallet", label: "Set up a signing wallet", hint: "unlocks wallet-signed routes" },
            { value: "done", label: "Done for now" }
          ]
        })
      );
      if (next === "quote") {
        await runCommand((await import("./quote.js")).default, { rawArgs: [] });
      } else if (next === "swap") {
        await runCommand((await import("./swap.js")).default, { rawArgs: [] });
      } else if (next === "wallet") {
        await runCommand((await import("./wallet.js")).default, { rawArgs: ["setup"] });
      } else {
        p.outro(`Any time: ${accent("openswap")} for the menu · ${accent("openswap tour")} to rewatch`);
      }
    } catch (err) {
      failWith(ctx, err);
    }
  }
});
