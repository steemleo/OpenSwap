import * as p from "@clack/prompts";
import { runCommand } from "citty";
import { isFirstRun } from "../core/paths.js";
import { header } from "../render/components.js";
import { bannerLines } from "../render/otto.js";
import { accent, dim } from "../render/theme.js";
import { guardCancel } from "./shared.js";

// One calm question. Personas map to commands — swappers and bots ride the
// default credential; app developers get guided toward their own key.
export async function intentMenu(): Promise<void> {
  // Otto greets at the front door only; degraded terminals get the text header.
  const banner = bannerLines();
  if (banner.length > 0) {
    process.stdout.write(`\n${banner.join("\n")}\n\n`);
    p.intro(header());
  } else {
    p.intro(header("open-source crosschain swaps · by LeoDex"));
  }
  // First-time users (no receipts, no saved config) get the tour up top —
  // everyone else keeps quote/swap first.
  const firstRun = isFirstRun();
  const tourOption = {
    value: "tour",
    label: "Watch how a swap works",
    hint: firstRun ? "2-minute tour, nothing real moves — great first step" : "2-minute tour, nothing real moves"
  };
  const choice = guardCancel(
    await p.select({
      message: "What do you want to do?",
      options: [
        ...(firstRun ? [tourOption] : []),
        { value: "quote", label: "Get a quote", hint: "see a price — no wallet needed" },
        { value: "swap", label: "Make a swap", hint: "pay from any wallet you already use" },
        ...(firstRun ? [] : [tourOption]),
        { value: "status", label: "Check a swap", hint: "track or resume by receipt" },
        { value: "history", label: "My swap history", hint: "every swap started from this machine" },
        { value: "app", label: "Add swaps to an app", hint: "SDK + your own key" },
        { value: "bot", label: "Build an automated strategy", hint: "policy-gated bot mode" },
        { value: "agent", label: "Connect an AI agent", hint: "Claude Code and friends" },
        { value: "doctor", label: "Check my setup", hint: "verify keys, API reach, and cache" },
        { value: "wallet", label: "Set up a signing wallet", hint: "unlocks routes without deposit-address support" },
        { value: "feedback", label: "Send feedback", hint: "bug or idea → straight to the team" }
      ]
    })
  );

  switch (choice) {
    case "tour": {
      const cmd = (await import("./tour.js")).default;
      await runCommand(cmd, { rawArgs: [] });
      return;
    }
    case "quote": {
      const cmd = (await import("./quote.js")).default;
      await runCommand(cmd, { rawArgs: [] });
      return;
    }
    case "swap": {
      const cmd = (await import("./swap.js")).default;
      await runCommand(cmd, { rawArgs: [] });
      return;
    }
    case "status": {
      const cmd = (await import("./status.js")).default;
      await runCommand(cmd, { rawArgs: [] });
      return;
    }
    case "history": {
      const cmd = (await import("./history.js")).default;
      await runCommand(cmd, { rawArgs: [] });
      return;
    }
    case "doctor": {
      const cmd = (await import("./doctor.js")).default;
      await runCommand(cmd, { rawArgs: [] });
      return;
    }
    case "wallet": {
      const cmd = (await import("./wallet.js")).default;
      await runCommand(cmd, { rawArgs: ["setup"] });
      return;
    }
    case "feedback": {
      const cmd = (await import("./feedback.js")).default;
      await runCommand(cmd, { rawArgs: [] });
      return;
    }
    case "app": {
      p.note(
        [
          "OpenSwap is powered by the LeoKit API — an HTTP API + TypeScript SDK.",
          "Your app keeps custody; the API quotes, prepares, and tracks. With",
          `your own API key, ${dim("affiliate fees on your app's volume are yours.")}`
        ].join("\n"),
        "Add swaps to an app"
      );
      const next = guardCancel(
        await p.select({
          message: "Where do you want to start?",
          options: [
            { value: "login", label: "Store my API key now", hint: "openswap auth login — free keys at dash.leokit.dev" },
            { value: "quote", label: "Explore the API from the terminal", hint: "run a JSON quote to see the data shape" },
            { value: "agent", label: "Let my coding agent integrate it", hint: "installs the Claude Code skill" },
            { value: "done", label: "Just show me the pointers" }
          ]
        })
      );
      if (next === "login") {
        const cmd = (await import("./auth.js")).default;
        await runCommand(cmd, { rawArgs: ["login"] });
      } else if (next === "quote") {
        const cmd = (await import("./quote.js")).default;
        await runCommand(cmd, { rawArgs: [] });
      } else if (next === "agent") {
        const cmd = (await import("./agent.js")).default;
        await runCommand(cmd, { rawArgs: ["setup"] });
      } else {
        // No `npm install leokit-sdk` here: that package is unregistered on
        // npm, and telling users to install a name anyone could claim is an
        // invitation to squat it.
        p.outro(`Docs: README · AGENT-CONTRACT.md · SKILL.md ${dim("· keys: https://dash.leokit.dev")}`);
      }
      return;
    }
    case "bot": {
      const cmd = (await import("./bot.js")).default;
      await runCommand(cmd, { rawArgs: ["init"] });
      return;
    }
    case "agent": {
      const cmd = (await import("./agent.js")).default;
      await runCommand(cmd, { rawArgs: ["setup"] });
      return;
    }
  }
}
