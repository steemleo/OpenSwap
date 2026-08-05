import { defineCommand, runCommand } from "citty";
import * as p from "@clack/prompts";
import { buildApi } from "../cli-context.js";
import { copyToClipboard } from "../core/clipboard.js";
import { isTestMode } from "../core/paths.js";
import { currentEnvironment } from "../render/json.js";
import {
  executionLane,
  msUntilExpiry,
  recommendationReason,
  signerConfigured,
  signerLaneEnabled,
  SIGNER_LANE_DISABLED_REASON,
  streamQuoteSet
} from "../core/quotes.js";
import { toBaseUnits } from "../core/amount.js";
import { prepareDepositAddress, validateAddressForChain, DEPOSIT_QR_SAFE_PROTOCOLS, type PreparedDeposit } from "../core/deposit.js";
import { newReceiptId, updateReceipt, writeReceipt } from "../core/receipts.js";
import { isTerminal, pollStatus } from "../core/status.js";
import { CliError } from "../core/errors.js";
import { formatAmountForDisplay, formatUsd } from "../core/amount.js";
import { emitData, failWith, resolveOutput, type OutputContext } from "../render/output.js";
import { box, header, keyValueRows, routeCard, timeline } from "../render/components.js";
import { accent, accentBold, bad, bold, dim, glyph, ok, termCaps, warn } from "../render/theme.js";
import { assetSymbol, emphasizeAddress, formatCountdown, formatDuration, sanitize } from "../render/money.js";
import { renderQr } from "../render/qr.js";
import { amountOrPrompt, guardCancel, loadAssetsWithSpinner, resolveAssetOrPrompt } from "./shared.js";
import { enrichNoRoute } from "../core/alternatives.js";
import { renderSwapTimeline, stateSteps, finalStateBlock } from "./status-render.js";
import { persistedState, unverifiedSuccess } from "./status.js";
import type { LeoKitApi } from "../core/api.js";
import type { AssetToken, ReceiptV1, RouteOffer } from "../core/types.js";
import { sharedQuoteArgs } from "./quote.js";

interface ReboundQuote {
  quoteId: string;
  offer: RouteOffer;
  switched: boolean;
  payable: RouteOffer[];
}

// Quotes live ~30s and providers flicker between calls. Re-quote and
// reconcile with what the user selected: keep their protocol when it is still
// offered (retrying once — flicker usually self-heals), otherwise return the
// fresh payable set with switched=true so callers can re-approve. Never a
// dead-end error while alternatives exist.
async function rebindQuote(
  api: LeoKitApi,
  params: { from_asset: string; to_asset: string; amount: string; slippage_bps?: number; destination?: string; origin?: string },
  wanted: { protocol: string; variant: string | null },
  opts: { retries?: number; depositOnly?: boolean; onOffer?: (offer: RouteOffer, count: number) => void } = {}
): Promise<ReboundQuote> {
  const retries = opts.retries ?? 1;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2500));
    let set;
    try {
      set = await streamQuoteSet(api, params, { depositOnly: opts.depositOnly ?? true, onOffer: opts.onOffer });
    } catch (err) {
      if (err instanceof CliError && err.code === "NO_ROUTE" && attempt < retries) continue;
      throw err;
    }
    const payable = (opts.depositOnly ?? true)
      ? set.offers.filter((o) => DEPOSIT_QR_SAFE_PROTOCOLS.has(o.protocol))
      : set.offers;
    if (payable.length === 0) {
      if (attempt < retries) continue;
      throw new CliError(
        "NO_ROUTE",
        "No deposit-payable route is available for this pair right now. Routes refresh every ~30 seconds — trying again usually works. Nothing was paid.",
        { retryable: true, actions: [{ label: "Try again", command: "openswap swap" }] }
      );
    }
    const match =
      payable.find((o) => o.protocol === wanted.protocol && o.variant === wanted.variant) ??
      payable.find((o) => o.protocol === wanted.protocol);
    if (match) return { quoteId: set.quoteId, offer: match, switched: false, payable };
    if (attempt < retries) continue; // give the wanted protocol one chance to flicker back
    return { quoteId: set.quoteId, offer: payable[0]!, switched: true, payable };
  }
  throw new CliError("INTERNAL", "Quote rebind loop exited unexpectedly.");
}

async function selectFromPayable(
  payable: RouteOffer[],
  toSymbol: string,
  message: string
): Promise<RouteOffer> {
  process.stdout.write("\n");
  payable.forEach((o, i) => {
    process.stdout.write(routeCard(o, { index: i + 1, selected: i === 0, toSymbol }).join("\n") + "\n\n");
  });
  const chosen = guardCancel(
    await p.select({
      message,
      options: payable.map((o, i) => ({
        value: i,
        label: `${o.protocol}${o.variant && o.variant !== "REGULAR" ? ` (${o.variant})` : ""} — ${formatAmountForDisplay(o.expectedOutDisplay)} ${toSymbol}`,
        hint: recommendationReason(o, payable.length)
      }))
    })
  );
  return payable[chosen as number]!;
}

function materialChangePct(before: RouteOffer, after: RouteOffer): number | null {
  try {
    const b = BigInt(before.expectedOutBase);
    const a = BigInt(after.expectedOutBase);
    if (b === 0n) return null;
    const diff = a > b ? a - b : b - a;
    return Number((diff * 10000n) / b) / 100;
  } catch {
    return null;
  }
}

function reviewRows(opts: {
  amount: string;
  fromToken: AssetToken;
  toToken: AssetToken;
  offer: RouteOffer;
  toAddress: string;
  refundAddress: string | null;
}): Array<[string, string] | null> {
  const { amount, fromToken, toToken, offer, toAddress, refundAddress } = opts;
  const inUsd = formatUsd(offer.inputUsd);
  const outUsd = formatUsd(offer.expectedOutUsd);
  const rows: Array<[string, string] | null> = [
    ["You send", `${bold(`${formatAmountForDisplay(amount)} ${sanitize(fromToken.symbol)}`)} on ${sanitize(fromToken.blockchain)}${inUsd ? `  ${dim(`≈ ${inUsd}`)}` : ""}`],
    ["Expected receive", `${bold(ok(`${formatAmountForDisplay(offer.expectedOutDisplay)} ${sanitize(toToken.symbol)}`))} on ${sanitize(toToken.blockchain)}${outUsd ? `  ${dim(`≈ ${outUsd}`)}` : ""}`],
    [
      "Minimum receive",
      offer.recommendedSlippageBps !== null
        ? `not guaranteed ${dim(`· route suggests ≤ ${(offer.recommendedSlippageBps / 100).toFixed(2)}% slippage`)}`
        : dim("not guaranteed by this route")
    ],
    ["Route", `${sanitize(offer.protocol)}${offer.variant && offer.variant !== "REGULAR" ? ` ${dim(sanitize(offer.variant))}` : ""}${offer.route.length > 1 ? `  ${dim(offer.route.map(sanitize).join(` ${glyph("arrow")} `))}` : ""}`]
  ];
  rows.push(["", ""]); // breathing room between money and route detail
  if (offer.fees.length > 0) {
    offer.fees.forEach((f, i) => {
      const usd = formatUsd(f.usd);
      rows.push([
        i === 0 ? "Fees" : "",
        // A component line's value is already inside its parent. Say so, or the
        // list visibly fails to add up to the total and reads as a bug.
        `${dim(glyph("middot"))} ${sanitize(f.type)}${f.amount !== null && f.amount !== undefined ? `  ${f.amount} ${assetSymbol(sanitize(f.asset))}` : ""}${usd ? ` ${dim(`≈ ${usd}`)}` : f.usd === null ? ` ${dim("(not priced)")}` : ""}${f.component_of ? ` ${dim(`(part of ${sanitize(f.component_of)})`)}` : ""}`
      ]);
    });
    rows.push([
      "Total fees",
      offer.feesTotalUsd !== null ? bold(`${formatUsd(offer.feesTotalUsd)}`) : dim("cannot be totaled — some components unpriced")
    ]);
  } else {
    rows.push(["Fees", dim("not provided by this route")]);
  }
  rows.push(["Estimated time", formatDuration(offer.etaSeconds)]);
  rows.push(["", ""]); // breathing room before the addresses
  rows.push(["Destination", emphasizeAddress(toAddress, (s) => bold(s))]);
  rows.push(["Pay from / refund", refundAddress ? emphasizeAddress(refundAddress, (s) => bold(s)) : dim("not set")]);
  return rows;
}

// Routes that exist but can't be executed must never dead-end the terminal:
// show what exists, say exactly why it's locked, and offer a way forward that
// keeps the user's inputs (their asset, their amount).
async function offerDeadEndRecovery(d: {
  offers: RouteOffer[];
  signable: RouteOffer[];
  signerOk: boolean;
  laneEnabled: boolean;
  fromToken: AssetToken;
  toToken: AssetToken;
  amount: string;
  args: Record<string, unknown>;
}): Promise<void> {
  const toSym = assetSymbol(d.toToken.identifier);
  process.stdout.write("\n");
  d.offers.slice(0, 3).forEach((o, i) => {
    process.stdout.write(routeCard(o, { index: i + 1, selected: false, toSymbol: toSym }).join("\n") + "\n\n");
  });
  // Only offer the wallet route when it can actually run — a setup wizard that
  // unlocks nothing is worse than an honest dead end.
  const canUnlock = d.signable.length > 0 && !d.signerOk && d.laneEnabled;
  if (d.signable.length > 0 && !d.laneEnabled) {
    p.log.warn(`These routes execute by signing transactions. ${SIGNER_LANE_DISABLED_REASON}`);
  } else if (canUnlock) {
    p.log.warn("These routes exist — but they execute by signing transactions, and no signing wallet is set up yet.");
  } else {
    p.log.warn(
      `${d.offers.length} route${d.offers.length === 1 ? "" : "s"} exist for this pair, but none can be executed from this CLI: ${sanitize(d.fromToken.blockchain)} isn't a chain this CLI can sign on, and none of these routes mint a deposit address.`
    );
    p.log.message(
      dim(`From ${sanitize(d.fromToken.blockchain)}, destinations on ETH, ARB, or SOL usually offer deposit-payable routes (Chainflip, NEAR) — same asset, different chain often works.`)
    );
  }
  const choice = guardCancel(
    await p.select({
      message: "How do you want to continue?",
      options: [
        ...(canUnlock
          ? [{ value: "wallet" as const, label: "Set up a signing wallet now", hint: "guided, ~2 minutes — unlocks these routes" }]
          : []),
        {
          value: "dest" as const,
          label: `Keep sending ${sanitize(d.fromToken.symbol)} — pick a different destination`,
          ...(canUnlock ? {} : { hint: `e.g. ${toSym} on ETH or ARB instead` })
        },
        { value: "source" as const, label: `Keep receiving ${toSym} — pick a different source` },
        { value: "done" as const, label: "Done for now" }
      ]
    })
  );
  const base = ["--amount", d.amount];
  const keep = (flag: string): string[] =>
    typeof d.args[flag] === "string" && d.args[flag] ? [`--${flag}`, String(d.args[flag])] : [];
  const swapCmd = async () => (await import("./swap.js")).default;
  if (choice === "wallet") {
    const { setupWalletInteractive } = await import("./wallet.js");
    const configured = await setupWalletInteractive();
    if (configured) {
      await runCommand(await swapCmd(), {
        rawArgs: ["--from", d.fromToken.identifier, "--to", d.toToken.identifier, ...base, ...keep("to-address"), ...keep("refund-address")]
      });
      return;
    }
    p.outro(`No changes made. Compare any pair any time: ${accent("openswap quote")}`);
    return;
  }
  if (choice === "dest") {
    await runCommand(await swapCmd(), {
      rawArgs: ["--from", d.fromToken.identifier, ...base, ...keep("refund-address")]
    });
    return;
  }
  if (choice === "source") {
    await runCommand(await swapCmd(), {
      rawArgs: ["--to", d.toToken.identifier, ...base, ...keep("to-address")]
    });
    return;
  }
  p.outro(`Nothing was created. Compare any pair any time: ${accent("openswap quote")}`);
}

async function renderPaymentScreen(prepared: PreparedDeposit, receipt: ReceiptV1, fromToken: AssetToken): Promise<void> {
  const copied = await copyToClipboard(prepared.depositAddress);
  const lines: string[] = [];
  const amountStr = `${formatAmountForDisplay(prepared.amountDisplay)} ${sanitize(fromToken.symbol)}`;
  lines.push(`Send exactly     ${accentBold(amountStr)}`);
  lines.push(`Network          ${bold(sanitize(prepared.network || fromToken.blockchain))}`);
  lines.push("");
  lines.push(`Deposit address${copied ? dim("   (copied to your clipboard)") : ""}`);
  lines.push(`  ${emphasizeAddress(prepared.depositAddress, bold)}`);
  lines.push("");
  lines.push(`Memo required    ${prepared.memo ? bad(bold(prepared.memo)) : dim("none — the address alone routes this swap")}`);
  if (prepared.expiresAt) {
    lines.push(`Pay within       ${warn(bold(formatCountdown(prepared.expiresAt - Date.now())))} ${dim(`(until ${new Date(prepared.expiresAt).toLocaleTimeString()}) — live countdown below`)}`);
  }
  process.stdout.write("\n" + box(lines, { accented: true }).join("\n") + "\n");
  if (prepared.expiresAt) {
    process.stdout.write(dim("If the window closes before you pay, nothing is lost — you'll be offered a fresh address.") + "\n");
  }
  process.stdout.write("\n");

  if (isTestMode()) {
    // No QR in test mode — a scannable code for a format-valid fake address
    // is the one artifact someone could actually pay. The flow stays intact.
    process.stdout.write(
      `${warn(glyph("caution"))} ${bold("SIMULATED")} ${dim(`— do not send real funds. This deposit auto-pays in a few seconds, or run: `)}${accent(`openswap test pay ${receipt.receipt_id}`)}\n\n`
    );
  } else {
    // The QR payload is either the bare deposit address or a URI this CLI built
    // itself from that same validated address (see buildPaymentUri) — a server
    // string is never encoded here. EVM always gets the bare address: wallets
    // parse EIP-681 /transfer syntax inconsistently, and one was verified live
    // mangling the recipient AND zeroing the amount.
    const qrContent = prepared.paymentUri ?? prepared.depositAddress;
    const qr = await renderQr(qrContent);
    if (qr.ok) {
      process.stdout.write(qr.lines.map((l) => `   ${l}`).join("\n") + "\n\n");
      if (qrContent === prepared.depositAddress) {
        process.stdout.write(
          dim(`   The QR is the deposit address. In your wallet: pick ${sanitize(fromToken.symbol)} on ${sanitize(prepared.network || fromToken.blockchain)}, send ${amountStr}, and confirm the recipient reads `) +
            bold(`${prepared.depositAddress.slice(0, 6)}…${prepared.depositAddress.slice(-4)}`) +
            dim(" before you approve.") +
            "\n\n"
        );
      } else {
        process.stdout.write(dim(`   Scan with a wallet on ${sanitize(prepared.network || fromToken.blockchain)} — address and exact amount arrive prefilled. Your wallet must show ${amountStr} before you approve.`) + "\n\n");
      }
    }
  }
  for (const w of prepared.warnings) process.stdout.write(`${warn(glyph("caution"))} ${w}\n`);
  process.stdout.write(`${dim("Receipt")}  ${accent(receipt.receipt_id)}  ${dim(`· resume any time: openswap status ${receipt.receipt_id} --watch`)}\n`);
}


interface SignerLaneDeps {
  ctx: import("../render/output.js").OutputContext;
  api: LeoKitApi;
  apiUrl: string;
  quoteId: string;
  offer: RouteOffer;
  fromToken: AssetToken;
  toToken: AssetToken;
  amount: string;
  toAddress: string;
  signer: import("../core/signer/evm.js").LoadedSigner;
  machineWarnings: string[];
  noTrack: boolean;
}

// Wallet-signed execution: /deposit unsigned transactions → validate → simulate
// → sign+broadcast with the configured signer → receipt → save → track. Reuses
// the bot-mode primitives with the human funnel's consent already given.
async function runSignerLane(d: SignerLaneDeps): Promise<void> {
  // Last line of defence. Route selection already refuses to offer this lane
  // when it is off; nothing should reach here, and if anything ever does it
  // must not sign.
  if (!signerLaneEnabled()) {
    throw new CliError("VALIDATION", SIGNER_LANE_DISABLED_REASON);
  }
  const { executeEvmPlan } = await import("../core/signer/evm.js");
  const { logFlight } = await import("../core/flightlog.js");

  const spin = d.ctx.mode === "human" ? p.spinner() : null;
  spin?.start("Building the on-chain transactions");
  let depositRes: Record<string, unknown>;
  try {
    depositRes = await d.api.createDeposit({
      quote_id: d.quoteId,
      protocol: d.offer.protocol,
      to_address: d.toAddress,
      from_address: d.signer.account.address
    });
    spin?.stop("Transactions built");
  } catch (err) {
    spin?.stop("Could not build the transactions", 1);
    throw err;
  }
  const txs = (depositRes.unsigned_transactions ?? depositRes.transactions) as
    | import("../core/signer/evm.js").UnsignedEvmTx[]
    | undefined;
  if (!Array.isArray(txs) || txs.length === 0) {
    throw new CliError(
      "UPSTREAM",
      `The ${d.offer.protocol} route did not return EVM transactions this CLI can sign. Nothing was broadcast.`,
      { details: { keys: Object.keys(depositRes) } }
    );
  }

  // Ceilings derive from the local asset registry, never the per-quote wire
  // response — a backend that misstated decimals could otherwise inflate them.
  const registryDecimals = d.fromToken.decimals ?? 18;
  const isNativeSource = d.fromToken.address === null;
  const maxValue = isNativeSource
    ? (toBaseUnits(d.amount, registryDecimals) * 101n) / 100n
    : 10_000_000_000_000_000n; // 0.01 native headroom for router fees on token swaps

  if (d.ctx.mode === "human") {
    process.stdout.write(dim(`${txs.length} transaction${txs.length === 1 ? "" : "s"} to sign (simulated first, broadcast sequentially).`) + "\n");
  }
  const events: Array<Record<string, unknown>> = [];
  const result = await executeEvmPlan({
    chain: d.fromToken.blockchain,
    txs,
    signer: d.signer,
    live: true,
    maxValueBaseUnits: maxValue,
    approvalGuard: { tokenAddress: d.fromToken.address, amountBaseUnits: toBaseUnits(d.amount, registryDecimals) },
    onEvent: (e) => {
      events.push({ ...e });
      if (d.ctx.mode === "human") {
        const label = e.kind === "simulated" ? "simulated" : e.kind === "broadcast" ? "broadcast" : "confirmed";
        process.stdout.write(`${ok(glyph("check"))} ${label} ${e.step}/${e.of}${e.txHash ? ` ${dim(e.txHash)}` : ""}\n`);
      } else {
        process.stderr.write(`${e.kind} ${e.step}/${e.of}${e.txHash ? ` ${e.txHash}` : ""}\n`);
      }
    }
  });
  const sourceTx = result.txHashes[result.txHashes.length - 1] ?? null;

  const receiptId = newReceiptId();
  const receipt: ReceiptV1 = {
    schema_version: "1",
    receipt_id: receiptId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    environment: currentEnvironment(),
    api_url: d.apiUrl,
    quote_id: d.quoteId,
    protocol: d.offer.protocol,
    from_asset: d.fromToken.identifier,
    to_asset: d.toToken.identifier,
    amount_display: d.amount,
    amount_base_units: toBaseUnits(d.amount, registryDecimals).toString(),
    expected_out_display: d.offer.expectedOutDisplay,
    expected_out_usd: d.offer.expectedOutUsd,
    destination_address: d.toAddress,
    refund_address: d.signer.account.address,
    deposit: null,
    tx_hashes: { source: sourceTx, destination: null, refund: null },
    last_state: "pending",
    last_checked_at: null,
    last_error: null,
    notes: `wallet-signed via ${d.offer.protocol}`
  };
  writeReceipt(receipt);
  logFlight({ type: "trade_executed", receipt_id: receiptId, quote_id: d.quoteId, usd: d.offer.inputUsd ?? 0, protocol: d.offer.protocol, lane: "wallet_signed" });
  if (sourceTx) {
    try {
      await d.api.saveTransaction({ quote_id: d.quoteId, tx_hash: sourceTx });
    } catch {
      d.machineWarnings.push("save-transaction failed — status tracking may lag; keep the tx hash");
    }
  }

  if (d.ctx.mode === "json" || d.ctx.mode === "plain") {
    const data = {
      state: "executed",
      execution: "wallet_signed",
      effects_performed: ["transactions_broadcast", "receipt_written", ...(sourceTx ? ["transaction_saved"] : [])],
      receipt_id: receiptId,
      quote_id: d.quoteId,
      protocol: d.offer.protocol,
      signer_address: d.signer.account.address,
      tx_hashes: result.txHashes,
      events,
      expected_receive: { display: d.offer.expectedOutDisplay, usd_estimate: d.offer.expectedOutUsd, asset: d.toToken.identifier },
      destination_address: d.toAddress,
      warnings: d.machineWarnings,
      track_command: `openswap status ${receiptId} --json`
    };
    if (d.ctx.mode === "json") emitData(d.ctx, data, { apiUrl: d.apiUrl });
    else process.stdout.write(`receipt\t${receiptId}\nsource_tx\t${sourceTx ?? ""}\ntrack\topenswap status ${receiptId} --json\n`);
    return;
  }

  process.stdout.write(`\n${ok(glyph("check"))} ${bold("Broadcast complete.")} ${dim(`Receipt ${receiptId}`)}\n`);
  if (d.noTrack) {
    p.outro(`Track with ${accent(`openswap status ${receiptId} --watch`)}`);
    return;
  }
  process.stdout.write("\n" + dim("Tracking the swap — you can close this terminal safely at any time.") + "\n\n");
  const abort = new AbortController();
  const onSigint = (): void => {
    abort.abort();
    process.stdout.write(`\n\nStill running. Resume any time: ${accent(`openswap status ${receiptId} --watch`)}\n`);
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  const final = await pollStatus(d.api, {
    quoteId: d.quoteId,
    signal: abort.signal,
    timeoutMs: null,
    expectation: { expectedOutDisplay: d.offer.expectedOutDisplay, createdAt: null },
    onUpdate: (status) => {
      updateReceipt(receiptId, {
        last_state: persistedState(status),
        last_checked_at: new Date().toISOString(),
        last_error: status.error,
        tx_hashes: { source: sourceTx, destination: status.destTxHash, refund: status.refundTxHash }
      });
      process.stdout.write(renderSwapTimeline(stateSteps(status.state, { unverified: unverifiedSuccess(status) })) + "\n");
    }
  });
  process.removeListener("SIGINT", onSigint);
  process.stdout.write("\n" + finalStateBlock(final, receiptId, d.toToken.symbol, d.signer.account.address) + "\n");
  if (final.state === "success" && !unverifiedSuccess(final)) p.outro(`Swap complete. Receipt: ${accent(receiptId)}`);
}

export default defineCommand({
  meta: {
    name: "swap",
    description: "Swap crosschain by paying a deposit address from any wallet you already use"
  },
  args: {
    ...sharedQuoteArgs,
    "to-address": { type: "string", description: "Destination address that will receive the swapped funds" },
    "refund-address": { type: "string", description: "The address you pay from on the source chain — refunds return there" },
    protocol: { type: "string", description: "Route protocol to use (skips route selection)" },
    policy: { type: "string", description: "Policy file — the trade is evaluated and rejected on any violation" },
    yes: { type: "boolean", alias: "y", description: "Authorize deposit-address creation without prompting (machine modes)" },
    signer: { type: "boolean", description: "Allow wallet-signed execution via the configured EVM signer (machine modes; human mode auto-detects)" },
    "dry-run": { type: "boolean", description: "Validate and show the plan without creating anything" },
    "no-track": { type: "boolean", description: "Exit after showing payment details instead of tracking" }
  },
  async run({ args }) {
    const ctx = resolveOutput("swap", args);
    try {
      const { api, apiUrl } = buildApi(args);
      if (ctx.mode === "human") {
        p.intro(header("swap"));
        const { isFirstRun } = await import("../core/paths.js");
        if (isFirstRun()) {
          p.log.message(dim(`First time? ${accent("openswap tour")} ${dim("walks a complete swap with nothing real — this flow will still be here.")}`));
        }
      }

      const tokens = await loadAssetsWithSpinner(ctx, api);
      const fromToken = await resolveAssetOrPrompt(ctx, tokens, args.from, "What do you want to send?", {
        side: "from", amount: args.amount, other: args.to
      });
      const toToken = await resolveAssetOrPrompt(ctx, tokens, args.to, "What do you want to receive?", {
        side: "to", amount: args.amount, other: fromToken.identifier
      });
      const amount = await amountOrPrompt(ctx, args.amount, fromToken);
      const slippage = args["slippage-bps"] ? Number(args["slippage-bps"]) : undefined;
      const quoteParams = { from_asset: fromToken.identifier, to_asset: toToken.identifier, amount, slippage_bps: slippage };

      // 1 — stream ALL routes, then partition by how this CLI can execute them
      const spin = ctx.mode === "human" ? p.spinner() : null;
      spin?.start("Streaming routes from every provider");
      let set;
      try {
        set = await streamQuoteSet(api, quoteParams, {
          onOffer: (o, n) => spin?.message(`Streaming routes — ${n} found (${sanitize(o.protocol)} just arrived)`),
          onRetry: () => spin?.message("Connection hiccup — retrying")
        });
      } catch (err) {
        const noRoute = err instanceof Error && "code" in err && err.code === "NO_ROUTE";
        spin?.stop(noRoute ? "No routes" : "Could not fetch routes", 1);
        throw await enrichNoRoute(err, {
          api,
          tokens,
          from: fromToken,
          to: toToken,
          amount,
          command: "swap",
          onStart: () => spin?.start("Looking for a pair that does route"),
          onDone: (n) => spin?.stop(n > 0 ? `${n} alternative${n === 1 ? "" : "s"} found` : "No alternative found", n > 0 ? 0 : 1)
        });
      }
      const laneOf = (o: RouteOffer): ReturnType<typeof executionLane> => executionLane(o, fromToken.identifier);
      const payable = set.offers.filter((o) => laneOf(o) === "deposit_address");
      const signable = set.offers.filter((o) => laneOf(o) === "wallet_signed");
      const laneEnabled = signerLaneEnabled();
      const signerOk = signerConfigured();
      // Human mode auto-selects the signer lane when a key is present, so the
      // release gate has to sit here too — not only behind the --signer flag.
      const signerAllowed = laneEnabled && signerOk && (ctx.mode === "human" ? true : args.signer === true);
      const signableNote = !laneEnabled ? " (wallet signing off in this release)" : signerOk ? "" : " (signer not configured)";
      spin?.stop(
        `${payable.length} deposit-payable route${payable.length === 1 ? "" : "s"}${signable.length > 0 ? ` · ${signable.length} wallet-signed${signableNote}` : ""}`
      );
      const selectable = [...payable, ...(signerAllowed ? signable : [])];
      if (selectable.length === 0) {
        // Interactive terminals get recovery, not an exit: the machine-mode
        // typed errors below stay exactly as they are.
        if (ctx.mode === "human" && !ctx.noInput && set.offers.length > 0) {
          await offerDeadEndRecovery({
            offers: set.offers,
            signable,
            signerOk,
            laneEnabled,
            fromToken,
            toToken,
            amount,
            args: args as Record<string, unknown>
          });
          return;
        }
        // Checked before the signer-configured branches: when the lane is off,
        // telling someone to set up a wallet would send them down a dead end.
        if (signable.length > 0 && !laneEnabled) {
          throw new CliError(
            "DEPOSIT_UNSUPPORTED",
            `Only wallet-signed routes exist for this pair (${signable.map((o) => o.protocol).join(", ")}). ${SIGNER_LANE_DISABLED_REASON}`,
            {
              actions: [
                { label: "Find a pair with deposit-payable routes", command: "openswap quote --deposit" },
                { label: "Browse assets with deposit support", command: "openswap assets search" }
              ]
            }
          );
        }
        if (signable.length > 0 && !signerOk) {
          throw new CliError(
            "DEPOSIT_UNSUPPORTED",
            `No deposit-payable route for this pair, but ${signable.length} route${signable.length === 1 ? " is" : "s are"} executable with the wallet signer (${signable.map((o) => o.protocol).join(", ")}).`,
            {
              actions: [
                { label: "Set up a signing wallet (guided, ~2 min)", command: "openswap wallet setup" },
                { label: "Or swap from a chain with deposit routes", command: "openswap quote --deposit" }
              ]
            }
          );
        }
        if (signable.length > 0 && !signerAllowed) {
          throw new CliError(
            "DEPOSIT_UNSUPPORTED",
            `Only wallet-signed routes exist for this pair (${signable.map((o) => o.protocol).join(", ")}). Pass --signer to authorize signing with the configured signer.`,
            { actions: [{ label: "Authorize wallet-signed execution (add --signer to the same command)" }] }
          );
        }
        throw new CliError(
          "DEPOSIT_UNSUPPORTED",
          set.offers.length === 0
            ? "No provider quoted this pair right now — it may not be supported. This is about the pair, not the amount."
            : `${set.offers.length} route${set.offers.length === 1 ? "" : "s"} exist for this pair, but none can be executed from this CLI (non-EVM source without deposit-address support).`,
          { actions: [{ label: "Compare quotes anyway", command: "openswap quote" }] }
        );
      }

      // 2 — route selection
      const machineWarnings: string[] = [];
      let offer: RouteOffer;
      const toSym = assetSymbol(toToken.identifier);
      if (args.protocol) {
        const found = selectable.find((o) => o.protocol === String(args.protocol));
        const foundUnallowed = !found && signable.find((o) => o.protocol === String(args.protocol));
        if (foundUnallowed && ctx.noInput) {
          throw new CliError(
            "NO_ROUTE",
            `Protocol "${args.protocol}" executes via the wallet signer. ${signerOk ? "Pass --signer to authorize it." : "Configure OPENSWAP_EVM_PRIVATE_KEY (or a keystore), then pass --signer."}`,
            { actions: [{ label: "Authorize wallet-signed execution (add --signer to the same command)" }] }
          );
        }
        if (found) {
          offer = found;
        } else if (ctx.mode === "human" && !ctx.noInput) {
          // soft fallback: the preferred route may have flickered out — offer
          // what IS executable instead of erroring
          p.log.warn(`The ${sanitize(String(args.protocol))} route isn't executable right now.`);
          offer = await selectFromPayable(selectable, toSym, "These routes are — continue with one?");
        } else {
          throw new CliError("NO_ROUTE", `Protocol "${args.protocol}" is not available for deposit-address payment on this pair. Available: ${payable.map((o) => o.protocol).join(", ")}`, {
            actions: [
              { label: "Let the CLI pick an executable route (drop --protocol from the same command)" },
              { label: "See executable routes first", command: "openswap quote --deposit --json" }
            ]
          });
        }
      } else if (ctx.noInput) {
        offer = selectable[0]!;
      } else {
        let currentSelectable = selectable;
        let unlocked = signerOk;
        while (true) {
          if (signable.length > 0 && !unlocked) {
            p.note(
              [
                ...signable.map(
                  (o) =>
                    `${dim("🔒")} ${sanitize(o.protocol)} — ${formatAmountForDisplay(o.expectedOutDisplay)} ${toSym}${o.expectedOutUsd ? ` ${dim(`≈ $${o.expectedOutUsd.toFixed(2)}`)}` : ""}`
                ),
                "",
                dim("These routes have no deposit-address support — they execute by"),
                dim("signing transactions, which needs a signing wallet (2-min setup).")
              ].join("\n"),
              `${signable.length} more route${signable.length === 1 ? "" : "s"} available with a signing wallet`
            );
          }
          const pick = guardCancel(
            await p.select({
              message: "Choose a route",
              options: [
                ...currentSelectable.map((o, i) => ({
                  value: i as number | "unlock",
                  label: `${o.protocol}${o.variant && o.variant !== "REGULAR" ? ` (${o.variant})` : ""} — ${formatAmountForDisplay(o.expectedOutDisplay)} ${toSym}${laneOf(o) === "wallet_signed" ? " · wallet-signed" : ""}`,
                  hint: recommendationReason(o, currentSelectable.length)
                })),
                ...(signable.length > 0 && !unlocked
                  ? [{ value: "unlock" as const, label: `Unlock ${signable.length} more route${signable.length === 1 ? "" : "s"} — set up a signing wallet`, hint: "guided, ~2 minutes" }]
                  : [])
              ]
            })
          );
          if (pick === "unlock") {
            const { setupWalletInteractive } = await import("./wallet.js");
            const done = await setupWalletInteractive();
            if (done) {
              unlocked = true;
              currentSelectable = [...payable, ...signable];
              p.log.success("Signing wallet ready — wallet-signed routes are now selectable.");
            }
            continue;
          }
          offer = currentSelectable[pick as number]!;
          break;
        }
      }
      const lane = laneOf(offer);

      // 3 — destination + refund addresses
      let toAddress = typeof args["to-address"] === "string" ? args["to-address"].trim() : "";
      if (toAddress) {
        const check = validateAddressForChain(toToken.blockchain, toAddress);
        if (!check.ok) throw new CliError("ADDRESS_INVALID", `Destination address rejected: ${check.reason}`);
      } else {
        if (ctx.noInput) throw new CliError("USAGE", "Missing required --to-address (the address that receives the swapped funds).");
        toAddress = guardCancel(
          await p.text({
            message: `Destination ${sanitize(toToken.symbol)} address on ${sanitize(toToken.blockchain)}`,
            placeholder: "the wallet that will receive the funds — double-check it",
            validate: (v) => {
              const check = validateAddressForChain(toToken.blockchain, (v ?? "").trim());
              return check.ok ? undefined : check.reason;
            }
          })
        ).trim();
      }

      // The paying wallet's address is required: the protocol stores it as the
      // refund destination if the swap cannot complete. In the wallet-signed
      // lane the signer wallet IS the payer, so it is derived, not asked.
      let signerHandle: import("../core/signer/evm.js").LoadedSigner | null = null;
      if (lane === "wallet_signed") {
        const { ensureSignerPassphrase } = await import("./wallet.js");
        const passphrase = await ensureSignerPassphrase(ctx);
        const { loadEvmSigner } = await import("../core/signer/evm.js");
        signerHandle = loadEvmSigner({ passphrase });
      }
      let refundAddress = typeof args["refund-address"] === "string" ? args["refund-address"].trim() : "";
      if (signerHandle) refundAddress = signerHandle.account.address;
      if (signerHandle) {
        // derived from the signer — no prompt, no validation needed
      } else if (refundAddress) {
        const check = validateAddressForChain(fromToken.blockchain, refundAddress);
        if (!check.ok) throw new CliError("ADDRESS_INVALID", `Pay-from/refund address rejected: ${check.reason}`);
      } else {
        if (ctx.noInput) {
          throw new CliError(
            "USAGE",
            "Missing required --refund-address: the address you will pay FROM on the source chain (refunds return there if the swap cannot complete)."
          );
        }
        refundAddress = guardCancel(
          await p.text({
            message: `Which ${sanitize(fromToken.blockchain)} address will you pay from?`,
            placeholder: "used as your refund address if the swap cannot complete",
            validate: (v) => {
              const check = validateAddressForChain(fromToken.blockchain, (v ?? "").trim());
              return check.ok ? undefined : check.reason;
            }
          })
        ).trim();
      }

      // 3.5 — deterministic policy gate (bots and cautious humans)
      if (args.policy) {
        const { loadPolicy, evaluatePolicy } = await import("../core/policy.js");
        const policy = loadPolicy(String(args.policy));
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
        if (!verdict.allowed && ctx.mode === "human") {
          for (const v of verdict.violations) p.log.warn(`policy (monitor): ${v}`);
        }
      }

      // 4 — re-quote bound to the real destination (the discovery quote used
      // none; the deposit path rejects quotes without real addresses)
      const boundParams = {
        ...quoteParams,
        destination: toAddress,
        ...(refundAddress ? { origin: refundAddress } : {})
      };
      const bindSpin = ctx.mode === "human" ? p.spinner() : null;
      bindSpin?.start("Locking the quote to your destination address");
      let rebound: ReboundQuote;
      try {
        rebound = await rebindQuote(api, boundParams, { protocol: offer.protocol, variant: offer.variant }, {
          depositOnly: lane === "deposit_address",
          onOffer: (o, n) => bindSpin?.message(`Locking the quote — ${n} route${n === 1 ? "" : "s"} confirmed (${sanitize(o.protocol)})`)
        });
      } catch (err) {
        bindSpin?.stop("Could not refresh the quote", 1);
        throw err;
      }
      bindSpin?.stop(rebound.switched ? "Routes changed while locking your quote" : "Quote locked to your destination");
      if (rebound.switched) {
        if (ctx.mode === "human" && !ctx.noInput) {
          p.log.warn(
            `The ${sanitize(offer.protocol)} route refreshed away — routes update every ~30 seconds. Nothing was paid. Here's what's available now:`
          );
          rebound.offer = await selectFromPayable(rebound.payable, toSym, "Continue with one of these?");
        } else if (args.protocol) {
          throw new CliError(
            "NO_ROUTE",
            `Protocol "${args.protocol}" is no longer available for this pair (routes refresh ~30s). Available now: ${rebound.payable.map((o) => o.protocol).join(", ")}. Nothing was paid.`,
            {
              retryable: true,
              actions: [{ label: "Let the CLI pick an executable route (drop --protocol and re-run)" }]
            }
          );
        } else {
          machineWarnings.push(
            `route_switched: ${offer.protocol} was no longer offered at preparation time; continued with ${rebound.offer.protocol}`
          );
        }
      } else {
        const delta = materialChangePct(offer, rebound.offer);
        if (delta !== null && delta > 1 && ctx.mode === "human") {
          p.log.warn(`The expected receive moved ${delta.toFixed(2)}% since you first saw this route.`);
        }
      }
      offer = rebound.offer;
      let quoteId = rebound.quoteId;

      // 5 — review
      const rows = reviewRows({ amount, fromToken, toToken, offer, toAddress, refundAddress: refundAddress || null });
      if (lane === "wallet_signed" && signerHandle) {
        rows.push(["Execution", `${accent("wallet-signed")} — your ${signerHandle.source === "keystore" ? "keystore" : "env-key"} signer broadcasts the transactions from ${refundAddress.slice(0, 6)}…${refundAddress.slice(-4)}`]);
      }

      if (args["dry-run"]) {
        const planData = {
          state: "dry_run",
          effects_performed: [],
          confirmation_required: true,
          quote_id: quoteId,
          protocol: offer.protocol,
          from_asset: fromToken.identifier,
          to_asset: toToken.identifier,
          amount_display: amount,
          expected_receive_display: offer.expectedOutDisplay,
          to_address: toAddress,
          refund_address: refundAddress || null,
          quote_expires_at: offer.expiresAt,
          execution: lane
        };
        if (ctx.mode === "json") {
          emitData(ctx, planData, { apiUrl });
        } else {
          process.stdout.write("\n" + box(keyValueRows(rows), {}).join("\n") + "\n");
          process.stdout.write(dim("\nDry run: no deposit address was created, nothing was paid.\n"));
        }
        return;
      }

      if (ctx.mode === "human") {
        process.stdout.write("\n" + `${accent(glyph("diamond"))}  ${bold("Review — paying this deposit is irreversible")}` + "\n");
        process.stdout.write(box(keyValueRows(rows), {}).join("\n") + "\n");
        process.stdout.write(`${bad(glyph("caution"))} ${dim("Funds sent to the deposit address are committed to this swap. Verify the destination above.")}\n`);
        const expiryMs = msUntilExpiry(offer);
        process.stdout.write(
          `${dim(
            expiryMs > 0
              ? `Quote expires in ${formatCountdown(expiryMs)} — confirming refreshes it if needed.`
              : "This quote has expired — confirming fetches a fresh one automatically."
          )}\n`
        );
        if (lane === "wallet_signed") {
          // The CLI itself broadcasts real funds on this lane — the typed
          // confirmation is the point of no return and earns its friction.
          const typed = guardCancel(
            await p.text({
              message: `Type ${bold("SWAP")} to sign and broadcast, or press Ctrl-C to cancel`,
              validate: (v) => (v === "SWAP" ? undefined : v === "" ? "Type SWAP to continue, Ctrl-C to cancel" : `Type SWAP exactly (you typed "${v}")`)
            })
          );
          if (typed !== "SWAP") throw new CliError("INTERRUPTED", "Cancelled before anything was broadcast.");
        } else {
          // Creating a deposit address costs nothing and commits nothing —
          // the commitment happens when the user PAYS it, in their own wallet
          // with its own confirmation. Enter is enough here.
          process.stdout.write(
            `${dim("Deposit windows can be short (sometimes under a minute) — have the wallet you'll pay from open.")}\n\n`
          );
          const go = guardCancel(
            await p.confirm({
              message: "Create the deposit address? (free — paying it is what commits the swap)",
              initialValue: true
            })
          );
          if (go !== true) throw new CliError("INTERRUPTED", "Cancelled before anything was created.");
        }
      } else if (!args.yes) {
        throw new CliError(
          "VALIDATION",
          lane === "wallet_signed"
            ? "Wallet-signed execution broadcasts real transactions. Pass --yes (with --signer) to authorize it in machine mode."
            : "Creating a deposit address is a state-changing step. Pass --yes to authorize it in machine mode.",
          { details: { confirmation_required: true } }
        );
      }

      if (lane === "wallet_signed") {
        await runSignerLane({
          ctx, api, apiUrl, quoteId, offer, fromToken, toToken, amount, toAddress,
          signer: signerHandle!, machineWarnings, noTrack: args["no-track"] === true
        });
        return;
      }

      // 6 — prepare (re-fresh if the confirm took past expiry)
      if (msUntilExpiry(offer) < 3000) {
        const refetched = await rebindQuote(api, boundParams, { protocol: offer.protocol, variant: offer.variant });
        if (refetched.switched) {
          // the user typed SWAP against specific numbers — a protocol switch
          // here always requires fresh approval
          if (ctx.mode === "human" && !ctx.noInput) {
            p.log.warn(`While you confirmed, the ${sanitize(offer.protocol)} route refreshed away. Nothing was paid.`);
            offer = await selectFromPayable(refetched.payable, toSym, "Continue with one of these instead?");
            quoteId = refetched.quoteId;
            const again = guardCancel(
              await p.confirm({
                message: `Create the deposit for ${sanitize(offer.protocol)} — expected ${formatAmountForDisplay(offer.expectedOutDisplay)} ${sanitize(toToken.symbol)}?`,
                initialValue: false
              })
            );
            if (!again) throw new CliError("INTERRUPTED", "Cancelled — nothing was created.");
          } else {
            throw new CliError("QUOTE_EXPIRED", `The ${offer.protocol} route expired during confirmation. Re-run to get a fresh quote. Nothing was paid.`, { retryable: true });
          }
        } else {
          const delta2 = materialChangePct(offer, refetched.offer);
          offer = refetched.offer;
          quoteId = refetched.quoteId;
          if (delta2 !== null && delta2 > 1) {
            if (ctx.mode === "human") {
              p.log.warn(`While you confirmed, the expected receive moved ${delta2.toFixed(2)}%. New expected: ${formatAmountForDisplay(offer.expectedOutDisplay)} ${sanitize(toToken.symbol)}.`);
              const again = guardCancel(await p.confirm({ message: "Continue with the refreshed quote?", initialValue: false }));
              if (!again) throw new CliError("INTERRUPTED", "Cancelled — nothing was created.");
            } else {
              throw new CliError("QUOTE_EXPIRED", `Quote moved ${delta2.toFixed(2)}% during confirmation. Re-run to get a fresh quote.`);
            }
          }
        }
      }

      const prepSpin = ctx.mode === "human" ? p.spinner() : null;
      prepSpin?.start("Creating your deposit address");
      let prepared: PreparedDeposit;
      try {
        const { checkDepositThrottle } = await import("../core/throttle.js");
        checkDepositThrottle();
        prepared = await prepareDepositAddress(api, {
          quoteId,
          offer,
          amountDisplay: amount,
          toAddress,
          fromAddress: refundAddress || undefined,
          sourceChain: fromToken.blockchain
        });
        prepSpin?.stop("Deposit address ready");
      } catch (err) {
        prepSpin?.stop("Could not create the deposit address", 1);
        throw err;
      }

      // 7 — durable receipt BEFORE any payment instructions are shown
      const receiptId = newReceiptId();
      const receipt: ReceiptV1 = {
        schema_version: "1",
        receipt_id: receiptId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        environment: currentEnvironment(),
        api_url: apiUrl,
        quote_id: quoteId,
        protocol: prepared.protocol,
        from_asset: fromToken.identifier,
        to_asset: toToken.identifier,
        amount_display: amount,
        amount_base_units: prepared.amountBaseUnits,
        expected_out_display: offer.expectedOutDisplay,
        expected_out_usd: offer.expectedOutUsd,
        destination_address: toAddress,
        refund_address: refundAddress || null,
        deposit: {
          deposit_address: prepared.depositAddress,
          payment_uri: prepared.paymentUri,
          memo: prepared.memo,
          network: prepared.network,
          expires_at: prepared.expiresAt,
          chainflip_channel_id: prepared.chainflipChannelId
        },
        tx_hashes: { source: null, destination: null, refund: null },
        last_state: "awaiting_payment",
        last_checked_at: null,
        last_error: null,
        notes: null
      };
      try {
        writeReceipt(receipt);
      } catch (err) {
        // The deposit address already exists upstream. Losing the local record
        // must never mean losing the address: print it before failing, or the
        // user is left with a minted address they cannot recover and we have no
        // record that they hold one. (No funds have moved — nothing is paid yet.)
        process.stderr.write(
          `\n${bold("A deposit address was created, but it could not be saved on this machine.")}\n` +
            dim("Copy these down now — they are not stored anywhere else:\n\n") +
            `  Deposit address  ${prepared.depositAddress}\n` +
            `  Exact amount     ${prepared.amountDisplay} ${fromToken.symbol}\n` +
            `  Network          ${prepared.network || fromToken.blockchain}\n` +
            `  Quote ID         ${quoteId}\n\n`
        );
        throw new CliError(
          "CONFIG",
          `The deposit address was created but the receipt could not be written (${err instanceof Error ? err.message : String(err)}). The payment details are shown above — save them, or the swap cannot be tracked.`,
          {
            cause: err,
            details: {
              deposit_address: prepared.depositAddress,
              amount_display: prepared.amountDisplay,
              amount_base_units: prepared.amountBaseUnits,
              network: prepared.network || fromToken.blockchain,
              quote_id: quoteId,
              receipt_id: receiptId
            },
            actions: [{ label: "Check where receipts are written", command: "openswap doctor" }]
          }
        );
      }
      const { logFlight } = await import("../core/flightlog.js");
      logFlight({ type: "deposit_address_created", receipt_id: receiptId, quote_id: quoteId, usd: offer.inputUsd ?? 0, protocol: prepared.protocol });

      if (ctx.mode === "json" || ctx.mode === "plain") {
        const data = {
          state: "awaiting_external_payment",
          effects_performed: ["deposit_address_created", "receipt_written"],
          receipt_id: receiptId,
          quote_id: quoteId,
          protocol: prepared.protocol,
          payment_request: {
            uri: prepared.paymentUri,
            deposit_address: prepared.depositAddress,
            source_network: prepared.network,
            asset: fromToken.identifier,
            amount_display: prepared.amountDisplay,
            amount_base_units: prepared.amountBaseUnits,
            decimals: prepared.decimals,
            memo: prepared.memo,
            expires_at: prepared.expiresAt
          },
          expected_receive: { display: offer.expectedOutDisplay, usd_estimate: offer.expectedOutUsd, asset: toToken.identifier },
          destination_address: toAddress,
          refund_address: refundAddress || null,
          warnings: [...machineWarnings, ...prepared.warnings],
          track_command: `openswap status ${receiptId} --watch`
        };
        if (ctx.mode === "json") emitData(ctx, data, { apiUrl });
        else {
          process.stdout.write(`receipt\t${receiptId}\ndeposit_address\t${prepared.depositAddress}\namount\t${prepared.amountDisplay}\nnetwork\t${prepared.network}\nexpires_at\t${prepared.expiresAt ?? ""}\ntrack\topenswap status ${receiptId} --watch\n`);
        }
        return;
      }

      await renderPaymentScreen(prepared, receipt, fromToken);

      if (args["no-track"]) {
        p.outro(`Waiting for your payment. Track with ${accent(`openswap status ${receiptId} --watch`)}`);
        return;
      }

      // 8 — track until terminal, resumable at every step
      process.stdout.write("\n" + dim("Watching for your payment — you can close this terminal safely at any time.") + "\n\n");
      const abort = new AbortController();
      const onSigint = (): void => {
        abort.abort();
        process.stdout.write(`\n\nStill running. Resume any time: ${accent(`openswap status ${receiptId} --watch`)}\n`);
        process.exit(130);
      };
      process.on("SIGINT", onSigint);

      // A dead deposit must not be watched forever: past expiry (plus a grace
      // window for a last-second payment to be detected) stop polling and offer
      // a fresh address. Any sign of payment cancels the deadline — from that
      // point the swap is live and expiry is meaningless.
      const EXPIRY_GRACE_MS = 90_000;
      let expiryStopped = false;
      let expiryTimer: NodeJS.Timeout | null = null;
      if (prepared.expiresAt) {
        expiryTimer = setTimeout(
          () => {
            expiryStopped = true;
            abort.abort();
          },
          Math.max(0, prepared.expiresAt + EXPIRY_GRACE_MS - Date.now())
        );
      }

      // The watch view REDRAWS in place on a TTY (cursor-up + erase): a live
      // pay-within countdown ticks every second above the timeline, and state
      // changes update the same lines instead of stacking new blocks.
      let watchHeight = 0;
      let watchState: import("../core/types.js").SwapState = "pending";
      let watchUnverified = false;
      const paintWatch = (): void => {
        if (!process.stdout.isTTY) return;
        const lines: string[] = [];
        if (watchState === "pending" && prepared.expiresAt) {
          const ms = prepared.expiresAt - Date.now();
          lines.push(
            ms > 0
              ? `${warn(bold(`Pay within ${formatCountdown(ms)}`))} ${dim(`· address in your clipboard · until ${new Date(prepared.expiresAt).toLocaleTimeString()}`)}`
              : `${dim("Deposit window closed — checking for a last-second payment…")}`
          );
          lines.push("");
        }
        lines.push(renderSwapTimeline(stateSteps(watchState, { unverified: watchUnverified })));
        const block = lines.join("\n");
        if (watchHeight > 0) process.stdout.write(`\x1b[${watchHeight}A\x1b[0J`);
        process.stdout.write(block + "\n");
        watchHeight = block.split("\n").length;
      };
      paintWatch();
      const ticker = process.stdout.isTTY ? setInterval(paintWatch, 1000) : null;
      ticker?.unref();

      const final = await pollStatus(api, {
        quoteId,
        signal: abort.signal,
        timeoutMs: null,
        expectation: {
          expectedOutDisplay: receipt.expected_out_display,
          createdAt: Date.parse(receipt.created_at) || null
        },
        onUpdate: (status) => {
          if (status.state !== "pending" && expiryTimer) {
            clearTimeout(expiryTimer);
            expiryTimer = null;
          }
          updateReceipt(receiptId, {
            last_state: persistedState(status),
            last_checked_at: new Date().toISOString(),
            last_error: status.error,
            tx_hashes: {
              source: receipt.tx_hashes.source,
              destination: status.destTxHash,
              refund: status.refundTxHash
            }
          });
          watchState = status.state;
          watchUnverified = unverifiedSuccess(status);
          if (process.stdout.isTTY) paintWatch();
          else process.stdout.write(renderSwapTimeline(stateSteps(status.state, { unverified: watchUnverified })) + "\n");
        }
      });
      if (ticker) clearInterval(ticker);
      if (expiryTimer) clearTimeout(expiryTimer);
      process.removeListener("SIGINT", onSigint);

      if (expiryStopped && !isTerminal(final.state)) {
        updateReceipt(receiptId, { last_state: "expired" });
        process.stdout.write(`\n${warn(glyph("caution"))} ${bold("The deposit window closed before a payment was seen.")}\n`);
        process.stdout.write(dim("Nothing was taken — and late payments are often still honored by the protocol.\n") + "\n");
        const next = guardCancel(
          await p.select({
            message: "What now?",
            options: [
              { value: "fresh" as const, label: "Get a fresh deposit address for this same swap", hint: "current rate" },
              { value: "track" as const, label: "I already paid (maybe late) — keep watching this deposit" },
              { value: "done" as const, label: "Done for now" }
            ]
          })
        );
        if (next === "fresh") {
          const rawArgs = [
            "--from", fromToken.identifier,
            "--to", toToken.identifier,
            "--amount", amount,
            "--to-address", toAddress
          ];
          if (refundAddress) rawArgs.push("--refund-address", refundAddress);
          const cmd = (await import("./swap.js")).default;
          await runCommand(cmd, { rawArgs });
          return;
        }
        if (next === "track") {
          const cmd = (await import("./status.js")).default;
          await runCommand(cmd, { rawArgs: [receiptId, "--watch"] });
          return;
        }
        p.outro(`Check any time: ${accent(`openswap status ${receiptId}`)}`);
        return;
      }

      process.stdout.write("\n" + finalStateBlock(final, receiptId, toToken.symbol, refundAddress || null) + "\n");
      if (final.state === "success" && !unverifiedSuccess(final)) {
        p.outro(`Swap complete. Receipt: ${accent(receiptId)}`);
      }
    } catch (err) {
      failWith(ctx, err);
    }
  }
});
