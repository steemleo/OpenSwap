import { defineCommand } from "citty";
import { readConfig, setConfigValue } from "../core/config.js";
import { emitData, failWith, resolveOutput } from "../render/output.js";
import { header } from "../render/components.js";
import { dim } from "../render/theme.js";
import { CliError } from "../core/errors.js";

const list = defineCommand({
  meta: { name: "list", description: "Show non-secret configuration" },
  args: { json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" }, "no-input": { type: "boolean" } },
  async run({ args }) {
    const ctx = resolveOutput("config list", args);
    try {
      const config = readConfig();
      if (ctx.mode === "json") {
        emitData(ctx, config);
        return;
      }
      if (ctx.mode === "human") process.stdout.write(header("config") + "\n\n");
      const entries = Object.entries(config);
      if (entries.length === 0) {
        process.stdout.write(dim("No configuration set. Keys: api_url, default_slippage_bps, default_from, default_to\n"));
        return;
      }
      for (const [k, v] of entries) process.stdout.write(`${k.padEnd(24)} ${String(v)}\n`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const get = defineCommand({
  meta: { name: "get", description: "Read one configuration value" },
  args: {
    key: { type: "positional", required: true },
    json: { type: "boolean" }, "no-color": { type: "boolean" }, "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("config get", args);
    try {
      const config = readConfig() as Record<string, unknown>;
      const value = config[String(args.key)];
      if (ctx.mode === "json") {
        emitData(ctx, { key: args.key, value: value ?? null });
        return;
      }
      if (value === undefined) {
        throw new CliError("USAGE", `"${args.key}" is not set.`);
      }
      process.stdout.write(String(value) + "\n");
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const set = defineCommand({
  meta: { name: "set", description: "Set one configuration value (never secrets)" },
  args: {
    key: { type: "positional", required: true },
    value: { type: "positional", required: true },
    json: { type: "boolean" }, "no-color": { type: "boolean" }, "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("config set", args);
    try {
      const config = setConfigValue(String(args.key), String(args.value));
      if (ctx.mode === "json") {
        emitData(ctx, config);
        return;
      }
      process.stdout.write(`${args.key} = ${String(args.value)}\n`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

export default defineCommand({
  meta: { name: "config", description: "Non-secret CLI configuration" },
  subCommands: { list, get, set }
});
