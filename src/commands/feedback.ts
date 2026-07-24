import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import {
  buildFeedbackReport,
  flushOutbox,
  readOutbox,
  saveToOutbox,
  submitFeedback,
  type FeedbackKind
} from "../core/feedback.js";
import { CliError } from "../core/errors.js";
import { emitData, failWith, resolveOutput } from "../render/output.js";
import { header } from "../render/components.js";
import { accent, bold, dim, ok } from "../render/theme.js";
import { guardCancel } from "./shared.js";

export default defineCommand({
  meta: {
    name: "feedback",
    description: "Send feedback (bug or idea) to the LeoKit team — straight to our Discord"
  },
  args: {
    message: { type: "string", alias: "m", description: "Feedback text (skips the prompt)" },
    kind: { type: "string", description: "bug | feature (default: bug)" },
    "no-diagnostics": { type: "boolean", description: "Send the message only, without environment diagnostics" },
    diagnostics: { type: "boolean", description: "Machine mode: opt IN to sending environment diagnostics (human mode asks interactively)" },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }
  },
  async run({ args }) {
    const ctx = resolveOutput("feedback", args);
    try {
      // retry anything that failed to send previously — feedback is never lost
      const flushed = await flushOutbox().catch(() => 0);
      if (flushed > 0 && ctx.mode === "human") {
        p.log.success(`Delivered ${flushed} previously saved feedback message${flushed === 1 ? "" : "s"}.`);
      }

      let kind = (typeof args.kind === "string" ? args.kind.toLowerCase() : "") as FeedbackKind | "";
      if (kind && kind !== "bug" && kind !== "feature") {
        throw new CliError("USAGE", `--kind must be "bug" or "feature" (got "${args.kind}").`);
      }
      let message = typeof args.message === "string" ? args.message : "";
      let includeDiagnostics = args["no-diagnostics"] !== true;

      if (ctx.noInput) {
        if (!message.trim()) {
          throw new CliError("USAGE", "Machine mode needs --message. Example: openswap feedback --json -m \"the QR is cut off on iTerm\"");
        }
        if (!kind) kind = "bug";
        // Human mode shows diagnostics and asks; machine mode can't consent,
        // so nothing beyond the message is sent unless explicitly requested.
        includeDiagnostics = args.diagnostics === true;
      } else {
        p.intro(header("feedback"));
        if (!kind) {
          kind = guardCancel(
            await p.select({
              message: "What kind of feedback?",
              options: [
                { value: "bug" as const, label: "Something's wrong", hint: "bug report" },
                { value: "feature" as const, label: "An idea", hint: "feature request" }
              ]
            })
          );
        }
        if (!message.trim()) {
          message = guardCancel(
            await p.text({
              message: kind === "bug" ? "What happened? (what you did, what you expected)" : "What should OpenSwap do?",
              placeholder: "be as specific as you like — it goes straight to the team",
              validate: (v) => ((v ?? "").trim().length >= 5 ? undefined : "A few more words helps us act on it")
            })
          );
        }
        // consent with full disclosure of exactly what ships
        const report = buildFeedbackReport({ kind, message, includeDiagnostics: true });
        if (includeDiagnostics && report.diagnostics) {
          const d = report.diagnostics;
          p.note(
            [
              `${dim("version")}   ${d.appVersion} on ${d.platform}`,
              `${dim("terminal")}  ${d.theme}`,
              ...d.logs.map((l) => `${dim(l.level.padEnd(6))} ${l.message}`)
            ].join("\n"),
            "Diagnostics that would be included (already redacted)"
          );
          includeDiagnostics = guardCancel(
            await p.confirm({ message: "Include these diagnostics? They help us debug.", initialValue: true })
          );
        }
      }

      const report = buildFeedbackReport({ kind: kind as FeedbackKind, message, includeDiagnostics });

      const spin = ctx.mode === "human" ? p.spinner() : null;
      spin?.start("Sending to the LeoKit team");
      try {
        const result = await submitFeedback(report);
        spin?.stop("Sent");
        if (ctx.mode === "json") {
          emitData(ctx, { delivered: true, reference: result.reference ?? null, kind, included_diagnostics: includeDiagnostics });
          return;
        }
        p.outro(`${ok("Thank you — the team reads every one.")}${result.reference ? ` ${dim(`(ref ${result.reference})`)}` : ""}`);
      } catch (err) {
        spin?.stop("Could not reach the feedback service", 1);
        saveToOutbox(report);
        if (ctx.mode === "json") {
          emitData(ctx, { delivered: false, saved_locally: true, retry_hint: "runs automatically on the next `openswap feedback`" });
          process.exitCode = 5;
          return;
        }
        p.outro(
          `${bold("Saved locally instead.")} ${dim(`It sends automatically next time you run ${accent("openswap feedback")} (${readOutbox().length} queued).`)}`
        );
        process.exitCode = 5;
      }
    } catch (err) {
      failWith(ctx, err);
    }
  }
});
