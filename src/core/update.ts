import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { cacheDir, ensureDir } from "./paths.js";
import { VERSION } from "../version.js";

// npx caches by package name and NEVER invalidates: a user who runs
// `npx openswap` once keeps getting that exact build forever, even after a
// newer one is published (npm/cli#6179, #2329). For most tools that is an
// annoyance. Here it means someone can stay pinned to a build with a known
// fund-loss bug and never find out — so the CLI has to tell them itself.
//
// Design: never block a command. We print from the LAST cached answer and
// refresh in the background, the update-notifier pattern. A user who is
// offline, rate-limited, or behind a proxy sees nothing at all.

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
const REGISTRY_URL = "https://registry.npmjs.org/openswap/latest";

interface UpdateCache {
  latest: string | null;
  checked_at: number;
}

function cachePath(): string {
  return join(cacheDir(), "update-check.json");
}

function readCache(): UpdateCache {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as UpdateCache;
    if (typeof parsed.checked_at === "number") return parsed;
  } catch {
    // no cache yet, unreadable, or corrupt — all mean "check again"
  }
  return { latest: null, checked_at: 0 };
}

function writeCache(state: UpdateCache): void {
  try {
    ensureDir(cacheDir());
    const tmp = `${cachePath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, cachePath());
  } catch {
    // a failed cache write must never affect the command being run
  }
}

// Semver compare limited to what we publish: numeric x.y.z, optional
// prerelease suffix which is always treated as OLDER than the release.
// Returns true when `candidate` is strictly newer than `current`.
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string): [number[], boolean] => {
    const [core = "", pre = ""] = v.trim().replace(/^v/, "").split("-", 2);
    const nums = core.split(".").map((n) => Number.parseInt(n, 10));
    if (nums.length !== 3 || nums.some((n) => !Number.isInteger(n) || n < 0)) return [[], false];
    return [nums, pre === ""];
  };
  const [a, aRelease] = parse(candidate);
  const [b, bRelease] = parse(current);
  if (a.length !== 3 || b.length !== 3) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return aRelease && !bRelease; // 1.0.0 beats 1.0.0-rc.1
}

// The notice for the CURRENTLY cached answer. Cheap, synchronous, no network.
export function pendingUpdateNotice(): string | null {
  if (process.env.OPENSWAP_NO_UPDATE_CHECK === "1") return null;
  const { latest } = readCache();
  if (!latest || !isNewer(latest, VERSION)) return null;
  return `OpenSwap ${latest} is available (you have ${VERSION}) — run: npx openswap@latest`;
}

// Fire-and-forget refresh. Deliberately not awaited: the result lands in the
// cache for the NEXT run, so no command ever waits on the registry.
export function refreshUpdateCache(): void {
  if (process.env.OPENSWAP_NO_UPDATE_CHECK === "1") return;
  const state = readCache();
  if (Date.now() - state.checked_at < CHECK_INTERVAL_MS) return;
  // Stamp the attempt BEFORE the request so a hard-failing network cannot
  // produce a fetch on every single invocation.
  writeCache({ latest: state.latest, checked_at: Date.now() });
  void (async () => {
    try {
      const res = await fetch(REGISTRY_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: "application/vnd.npm.install-v1+json" }
      });
      if (!res.ok) return;
      const body = (await res.json()) as { version?: unknown };
      if (typeof body.version === "string" && /^\d+\.\d+\.\d+/.test(body.version)) {
        writeCache({ latest: body.version, checked_at: Date.now() });
      }
    } catch {
      // offline, proxied, rate-limited, DNS-blocked — all silent by design
    }
  })();
}
