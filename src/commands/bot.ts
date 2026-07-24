import { defineCommand, runCommand } from "citty";
import { writeFileSync, existsSync } from "node:fs";
import { buildApi } from "../cli-context.js";
import { loadAssets, resolveAsset } from "../core/assets.js";
import { parseDecimalInput } from "../core/amount.js";
import { fetchQuotes, signerLaneEnabled, SIGNER_LANE_DISABLED_REASON } from "../core/quotes.js";
import { EXAMPLE_POLICY, evaluatePolicy, loadPolicy } from "../core/policy.js";
import { CliError } from "../core/errors.js";
import { emitData, failWith, resolveOutput } from "../render/output.js";
import { currentEnvironment } from "../render/json.js";
import { header } from "../render/components.js";
import { accent, bad, bold, dim, glyph, ok } from "../render/theme.js";
import type { RouteOffer } from "../core/types.js";

// check/init must predict run: evaluate the best route the policy's protocol
// allowlist permits — judging a disallowed global-best route would report a
// rejection that run (which filters first) would never hit.
function pickPolicyRoute(
  policy: { protocols: { allow: string[] } },
  offers: RouteOffer[]
): { offer: RouteOffer } | null {
  const allowed = offers.filter((o) => policy.protocols.allow.some((p) => p === "*" || p === o.protocol));
  if (allowed.length === 0) return null;
  return { offer: allowed[0]! };
}

function noAllowedRouteMessage(policy: { protocols: { allow: string[] } }, offers: RouteOffer[]): string {
  const returned = [...new Set(offers.map((o) => o.protocol))].join(", ");
  return `${offers.length} route${offers.length === 1 ? "" : "s"} exist for this pair (${returned}), but none are in this policy's protocols.allow (${policy.protocols.allow.join(", ")}). Widen the allowlist or pick a different pair.`;
}

const init = defineCommand({
  meta: { name: "init", description: "Build a bot policy — guided in the terminal, scaffold in machine mode" },
  args: {
    force: { type: "boolean", description: "Overwrite an existing openswap-policy.json" },
    json: { type: "boolean" }, "no-color": { type: "boolean" }, "no-input": { type: "boolean" },
    "api-url": { type: "string" }
  },
  async run({ args }) {
    const ctx = resolveOutput("bot init", args);
    try {
      // machine mode keeps the plain scaffold
      if (ctx.noInput) {
        const path = "openswap-policy.json";
        if (existsSync(path) && !args.force) {
          throw new CliError("USAGE", `${path} already exists. Pass --force to overwrite it.`);
        }
        writeFileSync(path, JSON.stringify(EXAMPLE_POLICY, null, 2) + "\n", { mode: 0o600 });
        emitData(ctx, { created: path, policy: EXAMPLE_POLICY });
        return;
      }

      // ── guided wizard: build the policy together, then test it live ──
      const p2 = await import("@clack/prompts");
      const { guardCancel, loadAssetsWithSpinner, resolveAssetOrPrompt } = await import("./shared.js");
      const { validateAddressForChain } = await import("../core/deposit.js");
      const { resolve } = await import("node:path");

      p2.intro(header("bot mode"));
      p2.log.message(
        [
          "Let's build your trading policy — the deterministic gate that decides",
          "which trades your bot may execute. Your script (or an LLM) proposes;",
          "only this policy authorizes. Press Enter to accept any default."
        ].join("\n")
      );

      const { api } = buildApi(args);
      const tokens = await loadAssetsWithSpinner(ctx, api);

      const name = guardCancel(
        await p2.text({ message: "Name this strategy", placeholder: "my-strategy", defaultValue: "my-strategy" })
      ).trim();
      const fromToken = await resolveAssetOrPrompt(ctx, tokens, undefined, "Which asset will the bot SEND (sell)?");
      const toToken = await resolveAssetOrPrompt(ctx, tokens, undefined, "Which asset should it RECEIVE?");
      const toAddress = guardCancel(
        await p2.text({
          message: `Destination ${toToken.symbol} address on ${toToken.blockchain} (the ONLY address this bot may pay out to)`,
          validate: (v) => {
            const check = validateAddressForChain(toToken.blockchain, (v ?? "").trim());
            return check.ok ? undefined : check.reason;
          }
        })
      ).trim();

      const num = async (message: string, dflt: number): Promise<number> => {
        const v = guardCancel(
          await p2.text({
            message,
            defaultValue: String(dflt),
            placeholder: String(dflt),
            validate: (s) => (!s || (Number.isFinite(Number(s)) && Number(s) > 0) ? undefined : "Enter a positive number")
          })
        );
        return Number(v || dflt);
      };
      const maxTrade = await num("Max USD per trade", 250);
      const maxDaily = await num("Max USD per rolling 24h", Math.max(1000, maxTrade * 4));
      const maxFee = await num("Max total fees per trade (USD)", Math.max(5, Math.round(maxTrade * 0.02)));
      const cooldown = await num("Cooldown between trades (seconds)", 60);

      const protoChoice = guardCancel(
        await p2.multiselect({
          message: "Which routes may it use? (space to toggle, enter to confirm)",
          options: [
            { value: "chainflip", label: "Chainflip" },
            { value: "near", label: "NEAR Intents" },
            { value: "relay", label: "Relay" },
            { value: "*", label: "Any route", hint: "including future ones" }
          ],
          initialValues: ["chainflip", "near", "relay"],
          required: true
        })
      ) as string[];
      const protocols = protoChoice.includes("*") ? ["*"] : protoChoice;

      const mode = guardCancel(
        await p2.select({
          message: "Enforcement mode",
          options: [
            { value: "enforce" as const, label: "Enforce", hint: "violations block the trade (recommended)" },
            { value: "monitor" as const, label: "Monitor", hint: "violations only log — for shakedown runs" }
          ]
        })
      );

      const policy = {
        version: 1 as const,
        name: name || "my-strategy",
        mode,
        assets: { allow_from: [fromToken.identifier], allow_to: [toToken.identifier] },
        protocols: { allow: protocols },
        destinations: { allow: [toAddress] },
        limits: {
          max_trade_usd: maxTrade,
          max_daily_volume_usd: maxDaily,
          max_total_fee_usd: maxFee,
          max_quote_age_seconds: 20,
          cooldown_seconds: cooldown
        },
        kill_switch_file: "./STOP"
      };

      const path = guardCancel(
        await p2.text({ message: "Save policy as", defaultValue: "openswap-policy.json", placeholder: "openswap-policy.json" })
      ).trim() || "openswap-policy.json";
      if (existsSync(path) && !args.force) {
        const overwrite = guardCancel(await p2.confirm({ message: `${path} exists — overwrite it?`, initialValue: false }));
        if (!overwrite) throw new CliError("INTERRUPTED", "Kept the existing policy file.");
      }
      writeFileSync(path, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600 });
      p2.log.success(`Saved ${resolve(path)}`);

      // ── continuation: never exit with homework ──
      const hasSigner = Boolean(
        process.env.OPENSWAP_EVM_PRIVATE_KEY || process.env.LEOKIT_EVM_PRIVATE_KEY ||
        process.env.OPENSWAP_EVM_KEYSTORE || process.env.LEOKIT_EVM_KEYSTORE
      );
      while (true) {
        const next = guardCancel(
          await p2.select({
            message: "What next?",
            options: [
              { value: "check", label: "Test this policy against live routes now", hint: "read-only, nothing trades" },
              { value: "loop", label: "Show my bot loop", hint: "the 4 commands, with YOUR values filled in" },
              { value: "done", label: "Done for now" }
            ]
          })
        );
        if (next === "done") break;
        if (next === "loop") {
          p2.note(
            [
              `1. stream prices   ${accent(`openswap watch -a ${Math.min(100, maxTrade)} -f ${fromToken.identifier} -t ${toToken.identifier} --jsonl`)}`,
              `2. gate a trade    ${accent(`openswap bot check --policy ${path} -a ${Math.min(100, maxTrade)} -f ${fromToken.identifier} -t ${toToken.identifier} --to-address ${toAddress} --json`)}`,
              `3. execute         ${accent(`openswap bot run --policy ${path} -a ${Math.min(100, maxTrade)} -f ${fromToken.identifier} -t ${toToken.identifier} --to-address ${toAddress} --json --live`)}`,
              `4. track           ${accent("openswap status <receipt> --json")}`,
              "",
              `${dim("bot run simulates without --live · touch STOP to halt everything · exit 4 = policy said no")}`
            ].join("\n"),
            "Your bot loop"
          );
          continue;
        }
        // live policy check with the freshly built policy
        const testAmount = await num("Test with what trade size (USD-ish amount of " + fromToken.symbol + ")?", Math.min(50, maxTrade));
        const spin = p2.spinner();
        spin.start("Quoting live routes and evaluating your policy");
        try {
          // No depositOnly here: bot run executes via the signer over the FULL
          // route set — the live check must look at the same routes run will.
          const set = await fetchQuotes(api, {
            from_asset: fromToken.identifier,
            to_asset: toToken.identifier,
            amount: String(testAmount)
          });
          const picked = pickPolicyRoute(policy, set.offers);
          if (!picked) {
            spin.stop("Routes exist — your policy allows none of them", 1);
            p2.log.warn(noAllowedRouteMessage(policy, set.offers));
            continue;
          }
          const offer = picked.offer;
          const verdict = evaluatePolicy(policy, {
            fromAsset: fromToken.identifier,
            toAsset: toToken.identifier,
            amountDisplay: String(testAmount),
            inputUsd: offer.inputUsd,
            toAddress,
            offer
          });
          spin.stop(verdict.allowed ? "Policy check passed" : "Policy would block this trade");
          if (verdict.allowed) {
            p2.log.success(`${offer.protocol} route · expected ${offer.expectedOutDisplay} ${toToken.symbol} — your policy allows it.`);
          } else {
            p2.log.warn("Violations (each names the limit to adjust):");
            for (const v of verdict.violations) p2.log.message(`  ${glyph("middot")} ${v}`);
          }
          p2.log.message(
            hasSigner
              ? dim("Signer detected in this shell — bot run can execute (simulates until you pass --live).")
              : dim("No signer configured yet. To execute for real: export OPENSWAP_EVM_PRIVATE_KEY=… (hot key)\nor OPENSWAP_EVM_KEYSTORE + OPENSWAP_EVM_KEYSTORE_PASSWORD (encrypted keystore).")
          );
        } catch (err) {
          spin.stop("Live check hit a problem", 1);
          p2.log.warn(err instanceof CliError ? err.message : String(err));
          if (err instanceof CliError && err.code === "NO_ROUTE") {
            const restart = guardCancel(
              await p2.confirm({
                message: "Restart the wizard with a different pair?",
                initialValue: true
              })
            );
            if (restart) {
              const cmd = (await import("./bot.js")).default;
              await runCommand(cmd, { rawArgs: ["init", "--force"] });
              return;
            }
          }
        }
      }
      p2.outro(`Policy ready: ${accent(path)} ${dim("· rerun any time: openswap bot init")}`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const check = defineCommand({
  meta: { name: "check", description: "Evaluate a proposed trade against a policy (no side effects)" },
  args: {
    policy: { type: "string", required: true, description: "Path to openswap-policy.json" },
    amount: { type: "string", alias: "a", required: true },
    from: { type: "string", alias: "f", required: true },
    to: { type: "string", alias: "t", required: true },
    "to-address": { type: "string", required: true },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }, "api-url": { type: "string" }
  },
  async run({ args }) {
    const ctx = resolveOutput("bot check", args);
    try {
      const policy = loadPolicy(String(args.policy));
      const { api, apiUrl } = buildApi(args);
      const tokens = await loadAssets(api);
      const fromRes = resolveAsset(tokens, String(args.from));
      const toRes = resolveAsset(tokens, String(args.to));
      if (!("token" in fromRes) || !("token" in toRes)) {
        throw new CliError("VALIDATION", "Ambiguous asset — bots must use chain:symbol or full identifiers.");
      }
      const amount = parseDecimalInput(String(args.amount));
      // Full route set — bot run signs over any route; check must predict run.
      const set = await fetchQuotes(api, {
        from_asset: fromRes.token.identifier,
        to_asset: toRes.token.identifier,
        amount
      });
      const picked = pickPolicyRoute(policy, set.offers);
      if (!picked) {
        throw new CliError("POLICY_REJECTED", noAllowedRouteMessage(policy, set.offers), {
          details: { returned_protocols: set.offers.map((o) => o.protocol), allowed: policy.protocols.allow }
        });
      }
      const offer = picked.offer;
      const verdict = evaluatePolicy(policy, {
        fromAsset: fromRes.token.identifier,
        toAsset: toRes.token.identifier,
        amountDisplay: amount,
        inputUsd: offer.inputUsd,
        toAddress: String(args["to-address"]),
        offer
      });
      const data = {
        allowed: verdict.allowed,
        mode: verdict.mode,
        violations: verdict.violations,
        evaluated_route: { protocol: offer.protocol, expected_receive_display: offer.expectedOutDisplay, input_usd: offer.inputUsd, fees_total_usd: offer.feesTotalUsd },
        quote_id: set.quoteId
      };
      const rejected = !verdict.allowed && verdict.mode === "enforce";
      if (ctx.mode === "json") {
        // A rejection has to read as a rejection. This used to emit ok:true
        // alongside exit 4, so anything branching on `ok` — the obvious thing
        // to branch on — saw approval on the money gate.
        if (rejected) {
          throw new CliError("POLICY_REJECTED", `Policy rejected this trade: ${verdict.violations.join("; ")}`, {
            details: data,
            actions: [{ label: "Re-check after adjusting the policy", command: "openswap bot check --policy <path>" }]
          });
        }
        emitData(ctx, data, { apiUrl });
      } else {
        process.stdout.write(header("policy check") + "\n\n");
        if (verdict.allowed) {
          process.stdout.write(`${ok(glyph("check"))} ${bold("Allowed")} — ${offer.protocol}, expected ${offer.expectedOutDisplay}\n`);
        } else {
          process.stdout.write(`${bad(glyph("cross"))} ${bold("Rejected")}\n`);
          for (const v of verdict.violations) process.stdout.write(`  ${bad("·")} ${v}\n`);
        }
        if (rejected) process.exitCode = 4;
      }
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

const run = defineCommand({
  meta: {
    name: "run",
    description: "Execute one policy-gated swap with the bot signer (simulates by default; --live broadcasts)"
  },
  args: {
    policy: { type: "string", required: true, description: "Path to openswap-policy.json" },
    amount: { type: "string", alias: "a", required: true },
    from: { type: "string", alias: "f", required: true },
    to: { type: "string", alias: "t", required: true },
    "to-address": { type: "string", required: true },
    live: { type: "boolean", description: "Actually sign and broadcast (default: simulate only)" },
    "idempotency-key": { type: "string", description: "Replay protection key (auto-derived when omitted)" },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }, "api-url": { type: "string" }
  },
  async run({ args }) {
    const ctx = resolveOutput("bot run", args);
    try {
      // Fail before a signer is even loaded. Simulation stays available (it
      // broadcasts nothing and is how operators validate a policy); only live
      // execution is withheld while the signing lane is hardened.
      if (args.live === true && !signerLaneEnabled()) {
        throw new CliError("SIGNER_UNAVAILABLE", SIGNER_LANE_DISABLED_REASON, {
          actions: [{ label: "Validate the policy without broadcasting", command: "openswap bot run --policy <path>" }]
        });
      }
      const [{ loadEvmSigner, executeEvmPlan, EVM_CHAINS }, { deriveIdempotencyKey, findIdempotentResult, saveIdempotentResult, reserveIdempotentKey, releaseIdempotentKey }, { logFlight }, { toBaseUnits }, { newReceiptId, writeReceipt }] =
        await Promise.all([
          import("../core/signer/evm.js"),
          import("../core/idempotency.js"),
          import("../core/flightlog.js"),
          import("../core/amount.js"),
          import("../core/receipts.js")
        ]);

      const policy = loadPolicy(String(args.policy));
      const { api, apiUrl } = buildApi(args);
      const tokens = await loadAssets(api);
      const fromRes = resolveAsset(tokens, String(args.from));
      const toRes = resolveAsset(tokens, String(args.to));
      if (!("token" in fromRes) || !("token" in toRes)) {
        throw new CliError("VALIDATION", "Ambiguous asset — bots must use chain:symbol or full identifiers.");
      }
      const fromToken = fromRes.token;
      const toToken = toRes.token;
      if (!EVM_CHAINS[fromToken.blockchain.toUpperCase()]) {
        throw new CliError("SIGNER_UNAVAILABLE", `bot run currently signs on EVM source chains only (got ${fromToken.blockchain}). Use the deposit-address flow for other chains.`);
      }
      const amount = parseDecimalInput(String(args.amount));
      const toAddress = String(args["to-address"]).trim();
      const signer = loadEvmSigner();
      if (signer.source === "env" && args.live) {
        process.stderr.write("warning: signing with a raw env private key — prefer OPENSWAP_EVM_KEYSTORE for live funds\n");
      }

      const idemKey =
        (args["idempotency-key"] as string | undefined) ??
        deriveIdempotencyKey({
          policy: policy.name,
          from: fromToken.identifier,
          to: toToken.identifier,
          amount,
          to_address: toAddress,
          window: Math.floor(Date.now() / 300000)
        });
      const replay = findIdempotentResult(idemKey);
      if (replay !== undefined) {
        emitData(ctx, { replayed: true, idempotency_key: idemKey, result: replay }, { apiUrl });
        if (ctx.mode !== "json") process.stdout.write("Replayed a previous identical run — no new trade submitted.\n");
        return;
      }

      const set = await fetchQuotes(api, {
        from_asset: fromToken.identifier,
        to_asset: toToken.identifier,
        amount,
        destination: toAddress,
        origin: signer.account.address
      });
      const pickedRun = pickPolicyRoute(policy, set.offers);
      if (!pickedRun) {
        throw new CliError("POLICY_REJECTED", noAllowedRouteMessage(policy, set.offers), {
          details: { returned_protocols: set.offers.map((o) => o.protocol), allowed: policy.protocols.allow }
        });
      }
      const offer = pickedRun.offer;
      const verdict = evaluatePolicy(policy, {
        fromAsset: fromToken.identifier,
        toAsset: toToken.identifier,
        amountDisplay: amount,
        inputUsd: offer.inputUsd,
        toAddress,
        offer
      });
      if (!verdict.allowed && verdict.mode === "enforce") {
        throw new CliError("POLICY_REJECTED", `Policy "${policy.name}" rejected this trade: ${verdict.violations.join("; ")}`, {
          details: { violations: verdict.violations }
        });
      }

      const depositRes = await api.createDeposit({
        quote_id: set.quoteId,
        protocol: offer.protocol,
        to_address: toAddress,
        from_address: signer.account.address
      });
      const txs = (depositRes.unsigned_transactions ?? depositRes.transactions ?? depositRes.txs) as
        | import("../core/signer/evm.js").UnsignedEvmTx[]
        | undefined;
      if (!Array.isArray(txs) || txs.length === 0) {
        throw new CliError("UPSTREAM", `The ${offer.protocol} deposit did not return unsigned EVM transactions this CLI can sign.`, {
          details: { keys: Object.keys(depositRes) }
        });
      }

      // native sends may carry the swap amount as value; token swaps only dust.
      // Ceilings derive from the LOCAL asset registry, never the quote wire.
      const registryDecimals = fromToken.decimals ?? 18;
      const isNativeSource = fromToken.address === null;
      const maxValue = isNativeSource
        ? (toBaseUnits(amount, registryDecimals) * 101n) / 100n
        : 10_000_000_000_000_000n; // 0.01 native units of headroom for router fees

      // Reserve the idempotency key immediately before anything irreversible:
      // a crash mid-broadcast or a concurrent identical run finds the pending
      // marker and refuses, instead of trading the same intent twice.
      let reserved = false;
      if (args.live === true) {
        const reservation = reserveIdempotentKey(idemKey);
        if (reservation.state === "done") {
          emitData(ctx, { replayed: true, idempotency_key: idemKey, result: reservation.result }, { apiUrl });
          if (ctx.mode !== "json") process.stdout.write("Replayed a previous identical run — no new trade submitted.\n");
          return;
        }
        if (reservation.state === "pending") {
          throw new CliError(
            "BROADCAST_UNKNOWN",
            `An identical run reserved this trade ${Math.round((Date.now() - reservation.since) / 1000)}s ago and never recorded a result — it may be in flight or may have crashed after broadcasting. Verify on-chain before retrying.`,
            {
              details: { idempotency_key: idemKey },
              actions: [{ label: "Check recent receipts", command: "openswap receipts list" }]
            }
          );
        }
        reserved = true;
      }

      const events: Array<Record<string, unknown>> = [];
      let result;
      try {
        result = await executeEvmPlan({
          chain: fromToken.blockchain,
          txs,
          signer,
          live: args.live === true,
          maxValueBaseUnits: maxValue,
          approvalGuard: { tokenAddress: fromToken.address, amountBaseUnits: toBaseUnits(amount, registryDecimals) },
          onEvent: (e) => {
            events.push({ ...e });
            if (ctx.mode !== "json") process.stderr.write(`${e.kind} ${e.step}/${e.of}${e.txHash ? ` ${e.txHash}` : ""}\n`);
          }
        });
      } catch (err) {
        if (reserved) {
          const broadcastHappened = events.some((e) => e.kind === "broadcast" || e.kind === "confirmed");
          // Free the key only when the failure is PROVABLY pre-send (our own
          // validation guards). A raw send error with no broadcast event could
          // still have propagated the tx — those keep the pending marker.
          const provenPreSend =
            err instanceof CliError && (err.code === "VALIDATION" || err.code === "SIGNER_UNAVAILABLE");
          if (!broadcastHappened && provenPreSend) releaseIdempotentKey(idemKey);
        }
        throw err;
      }

      const receiptId = newReceiptId();
      if (result.live) {
        writeReceipt({
          schema_version: "1",
          receipt_id: receiptId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          environment: currentEnvironment(),
          api_url: apiUrl,
          quote_id: set.quoteId,
          protocol: offer.protocol,
          from_asset: fromToken.identifier,
          to_asset: toToken.identifier,
          amount_display: amount,
          amount_base_units: toBaseUnits(amount, registryDecimals).toString(),
          expected_out_display: offer.expectedOutDisplay,
          expected_out_usd: offer.expectedOutUsd,
          destination_address: toAddress,
          refund_address: signer.account.address,
          deposit: null,
          tx_hashes: { source: result.txHashes[result.txHashes.length - 1] ?? null, destination: null, refund: null },
          last_state: "pending",
          last_checked_at: null,
          last_error: null,
          notes: `bot run · policy ${policy.name}`
        });
        logFlight({ type: "trade_executed", receipt_id: receiptId, quote_id: set.quoteId, usd: offer.inputUsd ?? 0, protocol: offer.protocol, idempotency_key: idemKey });
        const lastHash = result.txHashes[result.txHashes.length - 1];
        if (lastHash) {
          try {
            await api.saveTransaction({ quote_id: set.quoteId, tx_hash: lastHash });
          } catch {
            process.stderr.write("warning: save-transaction failed — status tracking may lag; keep the tx hash\n");
          }
        }
      }

      const data = {
        state: result.live ? "executed" : "simulated",
        effects_performed: result.live ? ["transactions_broadcast", "receipt_written", "transaction_saved"] : [],
        idempotency_key: idemKey,
        receipt_id: result.live ? receiptId : null,
        quote_id: set.quoteId,
        protocol: offer.protocol,
        signer_address: signer.account.address,
        tx_hashes: result.txHashes,
        events,
        policy: { name: policy.name, violations: verdict.violations },
        track_command: result.live ? `openswap status ${receiptId} --json` : null
      };
      if (result.live) saveIdempotentResult(idemKey, data);
      if (ctx.mode === "json") emitData(ctx, data, { apiUrl });
      else process.stdout.write(`${result.live ? "Executed" : "Simulated"} ${offer.protocol} swap · ${result.txHashes.length} tx${result.txHashes.length === 1 ? "" : "s"}\n`);
    } catch (err) {
      failWith(ctx, err);
    }
  }
});

export default defineCommand({
  meta: { name: "bot", description: "Deterministic, policy-gated automation" },
  subCommands: { init, check, run }
});
