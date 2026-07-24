import { defineCommand, runCommand } from "citty";

// `openswap resume` is the friendly name for `openswap status --watch`.
export default defineCommand({
  meta: { name: "resume", description: "Resume watching your latest (or a specific) swap" },
  args: {
    id: { type: "positional", description: "Receipt (os_…) or quote ID", required: false },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }, "api-url": { type: "string" }
  },
  async run({ args }) {
    const status = (await import("./status.js")).default;
    const rawArgs = ["--watch"];
    if (args.id) rawArgs.unshift(String(args.id));
    if (args.json) rawArgs.push("--json");
    if (args.plain) rawArgs.push("--plain");
    if (args["no-color"]) rawArgs.push("--no-color");
    if (args["api-url"]) rawArgs.push("--api-url", String(args["api-url"]));
    await runCommand(status, { rawArgs });
  }
});
