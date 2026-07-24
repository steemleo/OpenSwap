import { defineCommand } from "citty";
import { buildApi } from "../cli-context.js";
import { CliError } from "../core/errors.js";
import { validateAddressForChain } from "../core/deposit.js";
import { emitData, failWith, resolveOutput } from "../render/output.js";
import { header } from "../render/components.js";
import { bold, dim } from "../render/theme.js";
import { sanitize } from "../render/money.js";
import { formatUsd } from "../core/amount.js";

interface BalanceRowish {
  token_symbol?: string;
  asset?: string;
  symbol?: string;
  identifier?: string;
  amount?: number | string;
  balance?: number | string;
  balance_usd?: number;
  usd?: number;
  usd_value?: number;
  [key: string]: unknown;
}

// Live shape: { wallets: [{ chain, balances: [{token_symbol, balance, balance_usd, price}] }] }
// — flattened here, with fallbacks kept for older/alternate shapes.
function collectRows(data: unknown): BalanceRowish[] {
  if (Array.isArray(data)) return data as BalanceRowish[];
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    if (Array.isArray(rec.wallets)) {
      const rows: BalanceRowish[] = [];
      for (const w of rec.wallets as Array<Record<string, unknown>>) {
        if (Array.isArray(w.balances)) rows.push(...(w.balances as BalanceRowish[]));
      }
      return rows;
    }
    for (const key of ["balances", "tokens", "result"]) {
      if (Array.isArray(rec[key])) return rec[key] as BalanceRowish[];
    }
  }
  return [];
}

export default defineCommand({
  meta: { name: "balances", description: "Read balances for an address across chains" },
  args: {
    address: { type: "positional", description: "Wallet address", required: true },
    chains: { type: "string", alias: "c", description: "Comma-separated chains (e.g. ETH,ARB,BASE)", required: true },
    json: { type: "boolean" }, plain: { type: "boolean" }, "no-color": { type: "boolean" },
    "no-input": { type: "boolean" }, "api-url": { type: "string" }
  },
  async run({ args }) {
    const ctx = resolveOutput("balances", args);
    try {
      const { api, apiUrl } = buildApi(args);
      const chains = String(args.chains)
        .split(",")
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean);
      if (chains.length === 0 || chains.length > 10) {
        throw new CliError("USAGE", "Provide between 1 and 10 chains, e.g. --chains ETH,ARB,BASE");
      }
      const address = String(args.address).trim();
      for (const chain of chains) {
        const check = validateAddressForChain(chain, address);
        if (!check.ok) {
          throw new CliError("ADDRESS_INVALID", `That address doesn't look valid for ${chain}: ${check.reason ?? "unrecognized format"}`);
        }
      }
      const wallets = chains.map((chain) => ({ address, chain }));
      const raw = await api.getBalances(wallets);
      if (ctx.mode === "json") {
        emitData(ctx, raw, { apiUrl });
        return;
      }
      const rows = collectRows(raw);
      if (ctx.mode === "human") process.stdout.write(header("balances") + "\n\n");
      if (rows.length === 0) {
        process.stdout.write(
          dim(
            `No balances found for this address on ${chains.join(", ")} — either the wallet is empty there, or the chain code isn't one LeoKit indexes (see openswap assets list for chain codes).\n`
          )
        );
        return;
      }
      for (const r of rows) {
        const asset = sanitize(String(r.token_symbol ?? r.identifier ?? r.asset ?? r.symbol ?? "?"));
        const amount = String(r.balance ?? r.amount ?? "?");
        const usd =
          typeof r.balance_usd === "number" ? r.balance_usd
          : typeof r.usd === "number" ? r.usd
          : typeof r.usd_value === "number" ? r.usd_value
          : null;
        const usdStr = formatUsd(usd);
        process.stdout.write(`${bold(asset.padEnd(52))} ${amount.padStart(20)}${usdStr ? `  ${dim(`≈ ${usdStr}`)}` : ""}\n`);
      }
    } catch (err) {
      failWith(ctx, err);
    }
  }
});
