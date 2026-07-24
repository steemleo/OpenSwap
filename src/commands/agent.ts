import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { emitData, failWith, resolveOutput } from "../render/output.js";
import { header } from "../render/components.js";
import { accent, bold, dim, ok } from "../render/theme.js";
import { guardCancel } from "./shared.js";
import SKILL_BODY from "../../SKILL.md";
import AGENT_CONTRACT_BODY from "../../AGENT-CONTRACT.md";
import { CliError } from "../core/errors.js";

// The CLI itself is the agent surface: agents call `leokit … --json` and parse
// the envelope. This command installs a Claude Code skill teaching exactly that.

function skillPath(scope: "user" | "project"): string {
  const base = scope === "user" ? join(homedir(), ".claude") : join(process.cwd(), ".claude");
  return join(base, "skills", "openswap", "SKILL.md");
}

// pre-rename installs
function legacySkillPath(scope: "user" | "project"): string {
  const base = scope === "user" ? join(homedir(), ".claude") : join(process.cwd(), ".claude");
  return join(base, "skills", "leokit-swaps", "SKILL.md");
}

const setup = defineCommand({
  meta: { name: "setup", description: "Teach your AI agent to use LeoKit (installs a Claude Code skill)" },
  args: {
    scope: { type: "string", description: "user (all your projects) or project (this repo only)" },
    yes: { type: "boolean", description: "Skip the confirmation prompt" },
    json: { type: "boolean" }, "no-color": { type: "boolean" }, "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("agent setup", args);
    try {
      let scope = (args.scope as "user" | "project" | undefined) ?? undefined;
      if (scope !== "user" && scope !== "project") {
        if (ctx.noInput) throw new CliError("USAGE", "Pass --scope user or --scope project in non-interactive mode.");
        p.intro(header("connect an AI agent"));
        p.log.message(
          [
            "Installs a Claude Code skill that teaches agents to quote, swap, and",
            "track through this CLI's --json interface. Agents never see your API",
            "key — they run openswap, and openswap resolves credentials locally.",
          ].join("\n")
        );
        scope = guardCancel(
          await p.select({
            message: "Where should the skill live?",
            options: [
              { value: "user" as const, label: "User scope", hint: "~/.claude/skills — every project" },
              { value: "project" as const, label: "Project scope", hint: "./.claude/skills — this repo only" }
            ]
          })
        );
      }
      const path = skillPath(scope);
      const exists = existsSync(path);
      if (!args.yes && !ctx.noInput) {
        const confirmed = guardCancel(
          await p.confirm({ message: `${exists ? "Update" : "Write"} ${path}?`, initialValue: true })
        );
        if (!confirmed) {
          p.outro("Nothing written.");
          return;
        }
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, SKILL_BODY, { mode: 0o644 });
      // migrate a pre-rename install so agents don't load two skills
      const legacy = legacySkillPath(scope);
      let migrated = false;
      if (existsSync(legacy)) {
        try {
          rmSync(dirname(legacy), { recursive: true, force: true });
          migrated = true;
        } catch {
          // leave the legacy copy; setup still succeeded
        }
      }
      const data = { installed: path, scope, migrated_legacy: migrated, rollback: `rm ${path}` };
      if (ctx.mode === "json") {
        emitData(ctx, data);
        return;
      }
      p.log.success(`${ok("Installed.")} ${dim(path)}`);
      p.outro(
        [
          `Try it — ask your agent: ${bold('"swap 100 USDC on Arbitrum to native BTC"')}`,
          `   Remove any time: ${accent(`rm ${path}`)}`
        ].join("\n")
      );
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const status = defineCommand({
  meta: { name: "status", description: "Show which agent integrations are installed" },
  args: { json: { type: "boolean" }, "no-color": { type: "boolean" }, "no-input": { type: "boolean" } },
  async run({ args }) {
    const ctx = resolveOutput("agent status", args);
    try {
      const entries = (["user", "project"] as const).map((scope) => {
        const path = skillPath(scope);
        let installedVersionMatches = false;
        if (existsSync(path)) {
          try {
            installedVersionMatches = readFileSync(path, "utf8") === SKILL_BODY;
          } catch {
            installedVersionMatches = false;
          }
        }
        return { scope, path, installed: existsSync(path), current: installedVersionMatches, legacy_install: existsSync(legacySkillPath(scope)) };
      });
      if (ctx.mode === "json") {
        emitData(ctx, { integrations: entries });
        return;
      }
      process.stdout.write(header("agent integrations") + "\n\n");
      for (const e of entries) {
        const state = e.installed ? (e.current ? ok("installed") : accent("installed (outdated — rerun setup)")) : e.legacy_install ? accent("legacy leokit-swaps install — rerun setup to migrate") : dim("not installed");
        process.stdout.write(`${e.scope.padEnd(10)} ${state}  ${dim(e.path)}\n`);
      }
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const docs = defineCommand({
  meta: { name: "docs", description: "Print the full agent contract to stdout (self-bootstrap for any AI agent)" },
  args: {},
  async run() {
    // raw markdown, no ANSI — safe to pipe into any agent's context
    process.stdout.write(AGENT_CONTRACT_BODY + "\n");
  }
});

export default defineCommand({
  meta: { name: "agent", description: "Connect AI agents (Claude Code and compatible) to OpenSwap" },
  subCommands: { setup, status, docs }
});
