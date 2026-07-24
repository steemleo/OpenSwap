import { defineCommand, runCommand, runMain, showUsage as cittyShowUsage } from "citty";
import { VERSION } from "./version.js";
import { termCaps } from "./render/theme.js";

// Subcommands are lazy — npx cold-start stays fast because a `openswap quote`
// run never loads the swap funnel, bot engine, or QR renderer.
const main = defineCommand({
  meta: {
    name: "openswap",
    version: VERSION,
    description: "OpenSwap CLI — open-source crosschain swaps, right from your terminal"
  },
  subCommands: {
    quote: () => import("./commands/quote.js").then((m) => m.default),
    tour: () => import("./commands/tour.js").then((m) => m.default),
    test: () => import("./commands/test.js").then((m) => m.default),
    swap: () => import("./commands/swap.js").then((m) => m.default),
    status: () => import("./commands/status.js").then((m) => m.default),
    resume: () => import("./commands/resume.js").then((m) => m.default),
    receipts: () => import("./commands/receipts.js").then((m) => m.default),
    history: () => import("./commands/history.js").then((m) => m.default),
    assets: () => import("./commands/assets.js").then((m) => m.default),
    balances: () => import("./commands/balances.js").then((m) => m.default),
    watch: () => import("./commands/watch.js").then((m) => m.default),
    bot: () => import("./commands/bot.js").then((m) => m.default),
    feedback: () => import("./commands/feedback.js").then((m) => m.default),
    wallet: () => import("./commands/wallet.js").then((m) => m.default),
    auth: () => import("./commands/auth.js").then((m) => m.default),
    doctor: () => import("./commands/doctor.js").then((m) => m.default),
    config: () => import("./commands/config.js").then((m) => m.default),
    agent: () => import("./commands/agent.js").then((m) => m.default)
  },
  async run({ args }) {
    // Bare `openswap` in an interactive terminal → calm intent menu.
    // Non-TTY or flags → citty renders usage instead.
    if (args._.length === 0 && termCaps().isTTY) {
      const { intentMenu } = await import("./commands/menu.js");
      await intentMenu();
    }
  }
});

// Anything that escapes a command's own try/failWith (arg-parse throws,
// surprises in the bare-menu path) must still exit as a readable sentence,
// never a raw stack trace.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`Something went wrong: ${msg}\nThis is a bug worth reporting: openswap feedback\n`);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`Something went wrong: ${err.message}\nThis is a bug worth reporting: openswap feedback\n`);
  process.exit(1);
});

// When an argument is missing or invalid, citty renders usage to STDOUT and
// exits 1. For a machine caller that breaks the contract twice over: prose
// lands on the channel reserved for exactly one envelope, and the exit code
// says "internal" (1) where the frozen table says "usage/validation" (2).
// `showUsage` is citty's only hook into that path — an explicit --help still
// gets the real usage text, and --version is untouched.
const machineMode = process.argv.includes("--json");
const helpRequested = process.argv.includes("--help") || process.argv.includes("-h");

runMain(main, {
  async showUsage(cmd, parent) {
    if (!machineMode || helpRequested) return cittyShowUsage(cmd, parent);
    const spec = (cmd?.args ?? {}) as Record<string, { required?: boolean; alias?: string }>;
    const missing = Object.entries(spec)
      .filter(([name, s]) => s?.required && !process.argv.includes(`--${name}`) && !(s.alias && process.argv.includes(`-${s.alias}`)))
      .map(([name]) => `--${name}`);
    const command = process.argv.slice(2).filter((a) => !a.startsWith("-")).join(" ") || "openswap";
    const [{ errorEnvelope }, { CliError }] = await Promise.all([
      import("./render/json.js"),
      import("./core/errors.js")
    ]);
    process.stdout.write(
      errorEnvelope(
        command,
        new CliError(
          "USAGE",
          missing.length > 0
            ? `Missing required argument${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`
            : "Missing or invalid arguments.",
          { actions: [{ label: "Show the full argument list", command: `openswap ${command} --help` }] }
        )
      ) + "\n"
    );
    process.exit(2);
  }
});

export { runCommand };
