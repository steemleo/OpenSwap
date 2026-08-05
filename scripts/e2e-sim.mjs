#!/usr/bin/env node
// Simulated end-to-end gate: a full deposit-lane swap and a full signer-lane
// swap against the test-mode backend, through the real CLI binary. Run by CI
// on every push, and by anyone locally:
//
//   node scripts/e2e-sim.mjs
//
// Fails loudly on any deviation. Uses its own state dir — never touches the
// caller's receipts or test world.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "openswap-e2e-sim-"));
const env = {
  ...process.env,
  OPENSWAP_TEST_MODE: "1",
  OPENSWAP_TEST_TIMESCALE: "100",
  XDG_DATA_HOME: join(base, "data"),
  XDG_CONFIG_HOME: join(base, "config"),
  XDG_CACHE_HOME: join(base, "cache")
};

function cli(...args) {
  const out = execFileSync("node", ["dist/index.js", ...args], { env, encoding: "utf8", timeout: 120_000 });
  return JSON.parse(out.slice(out.indexOf("{")));
}

function fail(msg, extra) {
  console.error(`E2E-SIM FAIL: ${msg}`);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2).slice(0, 800));
  process.exit(1);
}

async function waitForState(receipt, want, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const s = cli("status", receipt, "--json");
    if (s.data?.state === want) return s;
    if (["failed", "refunded"].includes(s.data?.state) && want === "success") {
      fail(`swap ${receipt} ended ${s.data.state}, wanted ${want}`, s.data);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  fail(`swap ${receipt} never reached ${want}`);
}

const TO = "0x1111111111111111111111111111111111111111";
const REFUND = "0x2222222222222222222222222222222222222222";

// ── deposit lane: happy path ────────────────────────────────────────────
const dep = cli("swap", "--from", "eth:usdc", "--to", "base:usdc", "--amount", "25",
  "--to-address", TO, "--refund-address", REFUND, "--yes", "--json");
if (!dep.ok) fail("deposit-lane swap not ok", dep);
if (dep.meta.environment !== "simulated") fail("environment must be simulated", dep.meta);
if (!dep.data.receipt_id?.startsWith("ost_")) fail("simulated receipt must be ost_", dep.data);
if (!/^0x7e57/.test(dep.data.payment_request?.deposit_address ?? "")) fail("deposit address must be the 7e57 test pattern", dep.data);
const happy = await waitForState(dep.data.receipt_id, "success");
if ((happy.data.implausible ?? []).length > 0) {
  fail("a corroborated success must NOT be flagged unverified", happy.data);
}
console.log(`deposit lane ok  ${dep.data.receipt_id}`);

// ── deposit lane: magic-amount failure story ────────────────────────────
const bad = cli("swap", "--from", "eth:usdc", "--to", "base:usdc", "--amount", "25.13",
  "--to-address", TO, "--refund-address", REFUND, "--yes", "--json");
if (!bad.ok) fail("magic-amount swap not ok", bad);
await (async () => {
  for (let i = 0; i < 30; i++) {
    const s = cli("status", bad.data.receipt_id, "--json");
    if (s.data?.state === "failed") return;
    await new Promise((r) => setTimeout(r, 400));
  }
  fail("magic .13 swap never failed");
})();
console.log(`magic .13 ok     ${bad.data.receipt_id}`);

// ── deposit lane: phantom success (an unverifiable terminal claim) ──────
// The simulator answers the FIRST status poll with terminal success — unpaid,
// no dest hash, out_amount that is not this swap's outcome. The CLI must
// surface that as an unverified claim, never as a clean green result.
const phantom = cli("swap", "--from", "eth:usdc", "--to", "base:usdc", "--amount", "25.62",
  "--to-address", TO, "--refund-address", REFUND, "--yes", "--json");
if (!phantom.ok) fail("phantom swap creation not ok", phantom);
const ps = cli("status", phantom.data.receipt_id, "--json");
if (ps.data?.state === "success") fail("CLI endorsed an unverifiable success as success", ps.data);
if (ps.data?.claimed_state !== "success") fail("the backend's claim must stay visible as claimed_state", ps.data);
if (!Array.isArray(ps.data?.implausible) || ps.data.implausible.length === 0) {
  fail("terminal success with no dest hash and an implausible amount must carry implausible reasons", ps.data);
}
if (!(ps.warnings ?? []).length) fail("envelope warnings missing for unverified success", ps);
console.log(`phantom .62 ok   ${phantom.data.receipt_id}`);

// ── signer lane: real signing against the sim chain ─────────────────────
const signed = cli("swap", "--from", "eth:usdc", "--to", "base:usdc", "--amount", "30",
  "--to-address", TO, "--protocol", "rango", "--signer", "--yes", "--json");
if (!signed.ok) fail("signer-lane swap not ok", signed);
if (!signed.data.receipt_id?.startsWith("ost_")) fail("signer receipt must be ost_", signed.data);
console.log(`signer lane ok   ${signed.data.receipt_id}`);

// ── isolation: nothing simulated may exist outside test mode ────────────
const liveEnv = { ...env, OPENSWAP_TEST_MODE: "0" };
const receipts = JSON.parse(
  execFileSync("node", ["dist/index.js", "receipts", "list", "--json"], { env: liveEnv, encoding: "utf8", timeout: 60_000 })
    .replace(/^[^{]*/, "")
);
const leaked = (Array.isArray(receipts.data) ? receipts.data : receipts.data?.receipts ?? []).filter((r) =>
  String(r.receipt_id ?? "").startsWith("ost_")
);
if (leaked.length > 0) fail("simulated receipts leaked into live store", leaked);
console.log("isolation ok     no ost_ receipts outside test mode");

// ── QR renderer: exercised against the BUILT artifact ───────────────────
// renderQr swallows every error and simply shows no QR, so a broken renderer
// is invisible at runtime. `qrcode` is also CommonJS with a dynamic require of
// node builtins — the one dependency that does not survive bundling unaided.
// Test mode suppresses QRs in the swap flow, so `doctor` is where the renderer
// can be reached from the compiled bundle.
const health = cli("doctor", "--json");
const qrCheck = (health.data?.checks ?? []).find((c) => c.name === "QR renderer");
if (!qrCheck) fail("doctor no longer reports a QR renderer check", health.data);
if (qrCheck.state !== "ok") fail(`QR renderer is not ok: ${qrCheck.detail}`, qrCheck);
console.log(`qr renderer ok   ${qrCheck.detail}`);

console.log("E2E-SIM PASS");
