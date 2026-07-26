import { errorEnvelope, successEnvelope } from "./json.js";
import { errorBlock } from "./components.js";
import { asCliError } from "../core/errors.js";
import { dim, termCaps } from "./theme.js";
import { isTestMode } from "../core/paths.js";
import { pendingUpdateNotice, refreshUpdateCache } from "../core/update.js";

export type OutputMode = "human" | "plain" | "json" | "jsonl";

export interface OutputContext {
  mode: OutputMode;
  noInput: boolean;
  command: string;
}

export interface ModeFlags {
  json?: boolean;
  jsonl?: boolean;
  plain?: boolean;
  "no-input"?: boolean;
}

// --json/--jsonl imply --no-input. Non-TTY defaults to plain and never prompts.
export function resolveOutput(command: string, flags: ModeFlags): OutputContext {
  const caps = termCaps();
  let mode: OutputMode = caps.isTTY ? "human" : "plain";
  if (flags.plain) mode = "plain";
  if (flags.jsonl) mode = "jsonl";
  if (flags.json) mode = "json";
  const noInput = flags["no-input"] === true || mode === "json" || mode === "jsonl" || !caps.isTTY;
  // Machine modes get the test-mode signal in-band (meta.environment), but a
  // human eyeballing piped output deserves the loud version too — on stderr,
  // so the stdout contract stays byte-pure. Humans see the TEST header badge.
  if (mode !== "human" && isTestMode()) {
    process.stderr.write("[test mode] simulated environment — no real funds move\n");
  }
  // Humans get told when they are on a stale build; agents and pipes never do —
  // a version notice in machine output would break the envelope contract.
  // Prints from cache and refreshes in the background, so no command ever waits
  // on the registry. See core/update.ts for why this matters for npx.
  if (mode === "human" && !isTestMode()) {
    const notice = pendingUpdateNotice();
    if (notice) process.stderr.write(`${dim(notice)}\n`);
    refreshUpdateCache();
  }
  return { mode, noInput, command };
}

export function isMachine(ctx: OutputContext): boolean {
  return ctx.mode === "json" || ctx.mode === "jsonl";
}

// stdout: requested result. stderr: diagnostics. Machine output stays valid
// even when warnings occur mid-command.
export function emitData(ctx: OutputContext, data: unknown, opts: { warnings?: string[]; apiUrl?: string } = {}): void {
  if (ctx.mode === "json") {
    process.stdout.write(successEnvelope(ctx.command, data, opts) + "\n");
  }
}

export function emitDiagnostic(ctx: OutputContext, line: string): void {
  if (isMachine(ctx)) process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export function failWith(ctx: OutputContext, err: unknown): never {
  const cliErr = asCliError(err);
  if (ctx.mode === "json" || ctx.mode === "jsonl") {
    process.stdout.write(errorEnvelope(ctx.command, cliErr) + "\n");
  } else {
    process.stderr.write("\n" + errorBlock(cliErr).join("\n") + "\n");
  }
  process.exit(cliErr.exitCode);
}
