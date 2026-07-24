import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { CliError } from "./errors.js";
import { readRecentTrades } from "./flightlog.js";
import type { RouteOffer } from "./types.js";

// An LLM or strategy script may PROPOSE a swap. Only this deterministic policy
// may authorize one unattended. Rejections are typed results, never prose.
export const PolicyV1Schema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  mode: z.enum(["enforce", "monitor"]).default("enforce"),
  assets: z.object({
    allow_from: z.array(z.string()).min(1),
    allow_to: z.array(z.string()).min(1)
  }),
  protocols: z.object({ allow: z.array(z.string()).min(1) }),
  destinations: z.object({ allow: z.array(z.string()).min(1) }),
  limits: z.object({
    max_trade_usd: z.number().positive(),
    max_daily_volume_usd: z.number().positive(),
    max_total_fee_usd: z.number().positive().optional(),
    max_fee_pct: z.number().positive().max(100).optional(),
    max_quote_age_seconds: z.number().positive().default(20),
    cooldown_seconds: z.number().nonnegative().default(30),
    min_expected_out_usd_ratio: z.number().positive().max(1).optional()
  }),
  kill_switch_file: z.string().optional()
});

export type PolicyV1 = z.infer<typeof PolicyV1Schema>;

export function loadPolicy(path: string): PolicyV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CliError("CONFIG", `Could not read policy file "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = PolicyV1Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new CliError("CONFIG", `Policy file "${path}" is invalid: ${issues}`);
  }
  return parsed.data;
}

export interface SwapProposal {
  fromAsset: string;
  toAsset: string;
  amountDisplay: string;
  inputUsd: number | null;
  toAddress: string;
  offer: RouteOffer;
  now?: number;
}

export interface PolicyVerdict {
  allowed: boolean;
  mode: PolicyV1["mode"];
  violations: string[];
}

function assetMatches(allow: string[], asset: string): boolean {
  return allow.some((a) => a === "*" || a.toLowerCase() === asset.toLowerCase());
}

export function evaluatePolicy(policy: PolicyV1, proposal: SwapProposal): PolicyVerdict {
  const violations: string[] = [];
  const now = proposal.now ?? Date.now();

  if (policy.kill_switch_file && existsSync(policy.kill_switch_file)) {
    violations.push(`kill switch engaged (${policy.kill_switch_file} exists)`);
  }
  if (!assetMatches(policy.assets.allow_from, proposal.fromAsset)) {
    violations.push(`source asset ${proposal.fromAsset} is not in assets.allow_from`);
  }
  if (!assetMatches(policy.assets.allow_to, proposal.toAsset)) {
    violations.push(`destination asset ${proposal.toAsset} is not in assets.allow_to`);
  }
  if (!policy.protocols.allow.some((p) => p === "*" || p === proposal.offer.protocol)) {
    violations.push(`protocol ${proposal.offer.protocol} is not in protocols.allow`);
  }
  if (!policy.destinations.allow.some((d) => d === "*" || d.toLowerCase() === proposal.toAddress.toLowerCase())) {
    violations.push(`destination address is not in destinations.allow`);
  }

  if (proposal.inputUsd === null) {
    violations.push("trade USD value is unknown — cannot verify limits");
  } else {
    if (proposal.inputUsd > policy.limits.max_trade_usd) {
      violations.push(`trade $${proposal.inputUsd.toFixed(2)} exceeds max_trade_usd $${policy.limits.max_trade_usd}`);
    }
    const recent = readRecentTrades(24 * 60 * 60 * 1000, now);
    const dayVolume = recent.reduce((acc, t) => acc + t.usd, 0);
    if (dayVolume + proposal.inputUsd > policy.limits.max_daily_volume_usd) {
      violations.push(
        `daily volume $${(dayVolume + proposal.inputUsd).toFixed(2)} would exceed max_daily_volume_usd $${policy.limits.max_daily_volume_usd}`
      );
    }
    const last = recent[recent.length - 1];
    if (last && now - last.at < policy.limits.cooldown_seconds * 1000) {
      violations.push(`cooldown: last trade was ${Math.round((now - last.at) / 1000)}s ago (< ${policy.limits.cooldown_seconds}s)`);
    }
  }

  const quoteAgeOk = proposal.offer.expiresAt > now;
  if (!quoteAgeOk) violations.push("quote is expired");
  const quoteRemainingS = (proposal.offer.expiresAt - now) / 1000;
  if (quoteRemainingS > 0 && proposal.offer.ttlSeconds > 0) {
    const age = proposal.offer.ttlSeconds - quoteRemainingS;
    if (age > policy.limits.max_quote_age_seconds) {
      violations.push(`quote is ${Math.round(age)}s old (> max_quote_age_seconds ${policy.limits.max_quote_age_seconds})`);
    }
  }

  if (policy.limits.max_total_fee_usd !== undefined) {
    if (proposal.offer.feesTotalUsd === null) {
      violations.push("fees are not fully priced — cannot verify max_total_fee_usd");
    } else if (proposal.offer.feesTotalUsd > policy.limits.max_total_fee_usd) {
      violations.push(`fees $${proposal.offer.feesTotalUsd.toFixed(2)} exceed max_total_fee_usd $${policy.limits.max_total_fee_usd}`);
    }
  }
  if (policy.limits.max_fee_pct !== undefined && proposal.inputUsd !== null && proposal.inputUsd > 0) {
    if (proposal.offer.feesTotalUsd === null) {
      violations.push("fees are not fully priced — cannot verify max_fee_pct");
    } else {
      const pct = (proposal.offer.feesTotalUsd / proposal.inputUsd) * 100;
      if (pct > policy.limits.max_fee_pct) {
        violations.push(`fees ${pct.toFixed(2)}% exceed max_fee_pct ${policy.limits.max_fee_pct}%`);
      }
    }
  }
  if (policy.limits.min_expected_out_usd_ratio !== undefined && proposal.inputUsd !== null && proposal.inputUsd > 0) {
    if (proposal.offer.expectedOutUsd === null) {
      violations.push("expected output USD is unknown — cannot verify min_expected_out_usd_ratio");
    } else {
      const ratio = proposal.offer.expectedOutUsd / proposal.inputUsd;
      if (ratio < policy.limits.min_expected_out_usd_ratio) {
        violations.push(
          `expected out/in ratio ${ratio.toFixed(4)} below min_expected_out_usd_ratio ${policy.limits.min_expected_out_usd_ratio}`
        );
      }
    }
  }

  return { allowed: violations.length === 0, mode: policy.mode, violations };
}

export const EXAMPLE_POLICY: PolicyV1 = {
  version: 1,
  name: "example-arb-policy",
  mode: "enforce",
  assets: {
    allow_from: ["ARB.USDC-0xaf88d065e77c8cc2239327c5edb3a432268e5831"],
    allow_to: ["BTC.BTC"]
  },
  protocols: { allow: ["chainflip", "near"] },
  destinations: { allow: ["bc1q-your-address-here"] },
  limits: {
    max_trade_usd: 250,
    max_daily_volume_usd: 1000,
    max_total_fee_usd: 5,
    max_quote_age_seconds: 20,
    cooldown_seconds: 60
  },
  kill_switch_file: "./STOP"
};
