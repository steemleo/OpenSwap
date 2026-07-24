import { SCHEMA_VERSION } from "../version.js";
import { isTestMode } from "../core/paths.js";
import type { CliError } from "../core/errors.js";

// "simulated" tells agents and scripts, in-band, that no real funds moved.
export function currentEnvironment(): "mainnet" | "simulated" {
  return isTestMode() ? "simulated" : "mainnet";
}

// The versioned machine envelope. stdout carries exactly one JSON document (or
// JSONL stream); diagnostics go to stderr. Crypto quantities are strings.
export interface JsonEnvelopeMeta {
  generated_at: string;
  environment: "mainnet" | "simulated";
  api_url?: string;
}

export function successEnvelope(
  command: string,
  data: unknown,
  opts: { warnings?: string[]; apiUrl?: string } = {}
): string {
  return JSON.stringify(
    {
      schema_version: SCHEMA_VERSION,
      command,
      ok: true,
      data,
      warnings: opts.warnings ?? [],
      meta: {
        generated_at: new Date().toISOString(),
        environment: currentEnvironment(),
        ...(opts.apiUrl ? { api_url: opts.apiUrl } : {})
      }
    },
    null,
    2
  );
}

export function errorEnvelope(command: string, err: CliError): string {
  return JSON.stringify(
    {
      schema_version: SCHEMA_VERSION,
      command,
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        funds_may_have_moved: err.fundsMayHaveMoved,
        actions: err.actions,
        ...(err.details ? { details: err.details } : {})
      },
      meta: { generated_at: new Date().toISOString(), environment: currentEnvironment() }
    },
    null,
    2
  );
}

export function jsonlEvent(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ schema_version: SCHEMA_VERSION, type, ts: new Date().toISOString(), ...payload });
}
