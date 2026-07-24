import { LeoKitApi } from "./core/api.js";
import { readConfig } from "./core/config.js";
import { isTestMode } from "./core/paths.js";
import { simFetch } from "./testmode/server.js";
import { requireCredential, resolveCredential, type ResolvedCredential } from "./core/credentials.js";
import { CliError } from "./core/errors.js";
import { DEFAULT_API_URL } from "./version.js";

export interface SharedFlags {
  "api-url"?: string;
  [key: string]: unknown;
}

// localhost may carry a path prefix — the dev server mounts the API under
// /leokit while the public domain serves it at the root.
const ALLOWED_API_HOSTS = [/^https:\/\/api\.leokit\.dev$/, /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[A-Za-z0-9./_-]*)?$/];

export function resolveApiUrl(flags: SharedFlags): string {
  const url = (typeof flags["api-url"] === "string" && flags["api-url"]) || readConfig().api_url || DEFAULT_API_URL;
  const normalized = url.replace(/\/+$/, "");
  if (!ALLOWED_API_HOSTS.some((re) => re.test(normalized))) {
    throw new CliError(
      "CONFIG",
      `Refusing to send the API key to unrecognized endpoint "${normalized}". Allowed: the official LeoKit API or localhost for development.`
    );
  }
  return normalized;
}

export interface ApiContext {
  api: LeoKitApi;
  credential: ResolvedCredential;
  apiUrl: string;
}

export function buildApi(flags: SharedFlags): ApiContext {
  const credential = requireCredential();
  // Test mode swaps the backend at the fetch boundary: every production code
  // path (SSE parsing, bigint amounts, the deposit gauntlet) runs unchanged
  // against the in-process simulated LeoKit. Zero contact with the live API.
  if (isTestMode()) {
    const apiUrl = "http://127.0.0.1/test-mode";
    return { api: new LeoKitApi({ apiKey: credential.key, baseUrl: apiUrl, fetchImpl: simFetch() }), credential, apiUrl };
  }
  const apiUrl = resolveApiUrl(flags);
  return { api: new LeoKitApi({ apiKey: credential.key, baseUrl: apiUrl }), credential, apiUrl };
}

export function credentialStatus(): ResolvedCredential {
  return resolveCredential();
}
