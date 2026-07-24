import { existsSync, readFileSync } from "node:fs";
import { createDecipheriv, timingSafeEqual } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { CliError } from "../errors.js";
import { isTestMode } from "../paths.js";
import { TEST_SIGNER_PRIVATE_KEY } from "../../testmode/world.js";

// The signer is an EXPLICIT bot capability: never engaged by the human swap
// funnel, never inferred from the mere presence of an env var by any read
// command. Raw keys stay out of argv, config, receipts, and logs.

export { EVM_CHAINS, type EvmChainInfo } from "../chains.js";
import { EVM_CHAINS, defaultKeystorePath } from "../chains.js";

interface KeystoreV3 {
  version: number;
  crypto: {
    cipher: string;
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: string;
    kdfparams: Record<string, unknown>;
    mac: string;
  };
}

// Standard Ethereum V3 keystore decryption (scrypt/pbkdf2 + aes-128-ctr + keccak MAC).
export function decryptKeystoreV3(json: string, password: string): Hex {
  let ks: KeystoreV3;
  try {
    ks = JSON.parse(json) as KeystoreV3;
  } catch {
    throw new CliError("SIGNER_UNAVAILABLE", "Keystore file is not valid JSON.");
  }
  const cryptoBlock = ks.crypto ?? (ks as unknown as { Crypto: KeystoreV3["crypto"] }).Crypto;
  if (ks.version !== 3 || !cryptoBlock) {
    throw new CliError("SIGNER_UNAVAILABLE", "Only version-3 Ethereum keystores are supported.");
  }
  const kp = cryptoBlock.kdfparams as {
    salt: string; dklen: number; n?: number; r?: number; p?: number; c?: number; prf?: string;
  };
  const salt = Buffer.from(kp.salt, "hex");
  let derived: Buffer;
  if (cryptoBlock.kdf === "scrypt") {
    // Bound the KDF params: a hostile keystore file could otherwise set a huge
    // N and turn "unlock wallet" into a memory/CPU denial of service.
    if (
      !Number.isInteger(kp.n) || kp.n! < 2 || kp.n! > 2 ** 21 ||
      !Number.isInteger(kp.r) || kp.r! < 1 || kp.r! > 32 ||
      !Number.isInteger(kp.p) || kp.p! < 1 || kp.p! > 16 ||
      !Number.isInteger(kp.dklen) || kp.dklen < 16 || kp.dklen > 64
    ) {
      throw new CliError("SIGNER_UNAVAILABLE", "Keystore scrypt parameters are missing or outside the supported range.");
    }
    // pure-JS scrypt: Node's OpenSSL binding rejects standard keystore params
    derived = Buffer.from(
      scrypt(Buffer.from(password, "utf8"), salt, { N: kp.n!, r: kp.r!, p: kp.p!, dkLen: kp.dklen })
    );
  } else if (cryptoBlock.kdf === "pbkdf2") {
    if (kp.prf && kp.prf !== "hmac-sha256") {
      throw new CliError("SIGNER_UNAVAILABLE", `Unsupported keystore PRF: ${kp.prf}`);
    }
    derived = Buffer.from(pbkdf2(sha256, Buffer.from(password, "utf8"), salt, { c: kp.c!, dkLen: kp.dklen }));
  } else {
    throw new CliError("SIGNER_UNAVAILABLE", `Unsupported keystore KDF: ${cryptoBlock.kdf}`);
  }
  const ciphertext = Buffer.from(cryptoBlock.ciphertext, "hex");
  const mac = Buffer.from(keccak_256(Buffer.concat([derived.subarray(16, 32), ciphertext])));
  const expected = Buffer.from(cryptoBlock.mac, "hex");
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new CliError("SIGNER_UNAVAILABLE", "Keystore password is incorrect (MAC mismatch).");
  }
  if (cryptoBlock.cipher !== "aes-128-ctr") {
    throw new CliError("SIGNER_UNAVAILABLE", `Unsupported keystore cipher: ${cryptoBlock.cipher}`);
  }
  const decipher = createDecipheriv(
    "aes-128-ctr",
    derived.subarray(0, 16),
    Buffer.from(cryptoBlock.cipherparams.iv, "hex")
  );
  const priv = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return `0x${priv.toString("hex")}` as Hex;
}

export interface LoadedSigner {
  account: PrivateKeyAccount;
  source: "env" | "keystore";
}

export function loadEvmSigner(opts: { passphrase?: string } = {}): LoadedSigner {
  // Test mode signs with the industry-standard burned key (anvil #0) and
  // NEVER touches real keystores or env keys — no passphrase prompts, no way
  // to leak a real key into a simulated flow.
  if (isTestMode()) {
    return { account: privateKeyToAccount(TEST_SIGNER_PRIVATE_KEY as Hex), source: "env" };
  }
  const envKey = (process.env.OPENSWAP_EVM_PRIVATE_KEY ?? process.env.LEOKIT_EVM_PRIVATE_KEY)?.trim();
  if (envKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(envKey)) {
      throw new CliError("SIGNER_UNAVAILABLE", "OPENSWAP_EVM_PRIVATE_KEY must be 0x + 64 hex characters.");
    }
    return { account: privateKeyToAccount(envKey as Hex), source: "env" };
  }
  let keystorePath = (process.env.OPENSWAP_EVM_KEYSTORE ?? process.env.LEOKIT_EVM_KEYSTORE)?.trim();
  if (!keystorePath && existsSync(defaultKeystorePath())) {
    keystorePath = defaultKeystorePath(); // written by `openswap wallet setup`
  }
  if (keystorePath) {
    const password =
      opts.passphrase ?? process.env.OPENSWAP_EVM_KEYSTORE_PASSWORD ?? process.env.LEOKIT_EVM_KEYSTORE_PASSWORD;
    if (password === undefined) {
      throw new CliError("SIGNER_UNAVAILABLE", "OPENSWAP_EVM_KEYSTORE is set but OPENSWAP_EVM_KEYSTORE_PASSWORD is not.");
    }
    let json: string;
    try {
      json = readFileSync(keystorePath, "utf8");
    } catch {
      throw new CliError("SIGNER_UNAVAILABLE", `Could not read keystore file at ${keystorePath}.`);
    }
    return { account: privateKeyToAccount(decryptKeystoreV3(json, password)), source: "keystore" };
  }
  throw new CliError(
    "SIGNER_UNAVAILABLE",
    "No signer configured. Set OPENSWAP_EVM_PRIVATE_KEY (hot key) or OPENSWAP_EVM_KEYSTORE + OPENSWAP_EVM_KEYSTORE_PASSWORD (encrypted keystore).",
    { actions: [{ label: "Read the bot security model", command: "openswap bot init" }] }
  );
}

export interface UnsignedEvmTx {
  to: string;
  data?: string;
  value?: string | number | bigint;
  gasLimit?: string | number;
  gas?: string | number;
  chainId?: number;
  [key: string]: unknown;
}

export interface ExecutionEvent {
  step: number;
  of: number;
  kind: "simulated" | "simulation-skipped" | "broadcast" | "confirmed";
  txHash?: string;
  to: string;
}

export interface ExecutionResult {
  live: boolean;
  txHashes: string[];
  simulatedOnly: boolean;
}

function normalizeValue(v: UnsignedEvmTx["value"]): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === "bigint") return v;
  const s = String(v);
  return s.startsWith("0x") ? BigInt(s) : BigInt(s.split(".")[0] ?? "0");
}

const APPROVE_SELECTOR = "0x095ea7b3";
const MAX_UINT256 = (1n << 256n) - 1n;

export interface ApprovalGuard {
  tokenAddress: string | null; // source token contract; null = native source
  amountBaseUnits: bigint; // the trade amount, from the local asset registry
}

// Pure pre-signing guards — every violation refuses the whole plan.
export function validateEvmPlan(
  txs: UnsignedEvmTx[],
  opts: { expectedChainId: number; chainLabel: string; maxValueBaseUnits: bigint; approvalGuard?: ApprovalGuard }
): void {
  let totalValue = 0n;
  const allowUnbounded = process.env.OPENSWAP_ALLOW_UNBOUNDED_APPROVALS === "1";
  for (const tx of txs) {
    if (!tx.to || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) {
      throw new CliError("VALIDATION", `Unsigned transaction has an invalid target address. Refusing to sign.`);
    }
    if (tx.chainId !== undefined && Number(tx.chainId) !== opts.expectedChainId) {
      throw new CliError(
        "VALIDATION",
        `Unsigned transaction targets chain ${tx.chainId} but the source chain is ${opts.expectedChainId} (${opts.chainLabel}). Refusing to sign.`
      );
    }
    // ERC-20 amounts live in calldata, outside the native-value ceiling — cap
    // approvals so a bad plan cannot pre-authorize draining the wallet.
    const data = typeof tx.data === "string" ? tx.data.toLowerCase() : "";
    if (!allowUnbounded && data.startsWith(APPROVE_SELECTOR) && data.length >= 138) {
      const approveAmount = BigInt(`0x${data.slice(74, 138)}`);
      if (approveAmount === MAX_UINT256) {
        throw new CliError(
          "VALIDATION",
          "The plan asks for an UNLIMITED token approval. Refusing to sign. (Override only if you fully trust the route: OPENSWAP_ALLOW_UNBOUNDED_APPROVALS=1)"
        );
      }
      const guard = opts.approvalGuard;
      if (
        guard?.tokenAddress &&
        tx.to.toLowerCase() === guard.tokenAddress.toLowerCase() &&
        approveAmount > guard.amountBaseUnits * 2n
      ) {
        throw new CliError(
          "VALIDATION",
          `The plan approves ${approveAmount} base units of the source token — more than double the trade amount (${guard.amountBaseUnits}). Refusing to sign.`
        );
      }
    }
    totalValue += normalizeValue(tx.value);
  }
  if (totalValue > opts.maxValueBaseUnits) {
    throw new CliError(
      "VALIDATION",
      `The plan's native value (${totalValue}) exceeds the approved amount (${opts.maxValueBaseUnits}). Refusing to sign.`
    );
  }
}

// Simulate every transaction; broadcast only when live=true. Transactions run
// sequentially (approval → swap) and each is confirmed before the next starts.
export async function executeEvmPlan(opts: {
  chain: string;
  txs: UnsignedEvmTx[];
  signer: LoadedSigner;
  live: boolean;
  maxValueBaseUnits: bigint; // ceiling for native value across the plan
  approvalGuard?: ApprovalGuard;
  onEvent?: (e: ExecutionEvent) => void;
}): Promise<ExecutionResult> {
  const info = EVM_CHAINS[opts.chain.toUpperCase()];
  if (!info) {
    throw new CliError("SIGNER_UNAVAILABLE", `No RPC configuration for chain "${opts.chain}". Set OPENSWAP_EVM_RPC_URL.`);
  }
  let rpcUrl = (process.env.OPENSWAP_EVM_RPC_URL ?? process.env.LEOKIT_EVM_RPC_URL)?.trim() || info.rpcUrl;
  if (isTestMode()) {
    // real signing, simulated chain — the burned test key only ever pairs
    // with the local RPC, and env overrides cannot redirect it
    const { ensureSimRpc } = await import("../../testmode/rpc.js");
    rpcUrl = await ensureSimRpc(info.chainId);
  }
  const transport = http(rpcUrl);
  const chain = {
    id: info.chainId,
    name: opts.chain,
    nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  } as const;
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account: opts.signer.account, chain, transport });

  validateEvmPlan(opts.txs, {
    expectedChainId: info.chainId,
    chainLabel: opts.chain,
    maxValueBaseUnits: opts.maxValueBaseUnits,
    ...(opts.approvalGuard ? { approvalGuard: opts.approvalGuard } : {})
  });

  const txHashes: string[] = [];
  for (let i = 0; i < opts.txs.length; i++) {
    const tx = opts.txs[i]!;
    const request = {
      account: opts.signer.account,
      to: tx.to as Hex,
      data: (tx.data as Hex | undefined) ?? undefined,
      value: normalizeValue(tx.value)
    };
    // Later steps depend on earlier ones landing on-chain (approval → swap).
    // In simulate-only mode nothing is broadcast, so simulating step 2+ against
    // current state reverts spuriously — validate structurally and say so.
    if (!opts.live && i > 0) {
      opts.onEvent?.({ step: i + 1, of: opts.txs.length, kind: "simulation-skipped", to: tx.to });
      continue;
    }
    try {
      await publicClient.call(request); // throws on revert — simulation gate
      opts.onEvent?.({ step: i + 1, of: opts.txs.length, kind: "simulated", to: tx.to });
      if (!opts.live) continue;
      const hash = await walletClient.sendTransaction(request);
      txHashes.push(hash);
      opts.onEvent?.({ step: i + 1, of: opts.txs.length, kind: "broadcast", txHash: hash, to: tx.to });
      await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      opts.onEvent?.({ step: i + 1, of: opts.txs.length, kind: "confirmed", txHash: hash, to: tx.to });
    } catch (err) {
      // Once anything has been broadcast, a failure here is NOT a clean
      // failure: a wait can time out on a slow chain and a later step can
      // revert, both while earlier transactions are already on-chain. Reporting
      // that as a generic error tells an agent it is safe to retry, and a retry
      // re-broadcasts. Name it, carry the hashes, and let the exit code say so.
      if (txHashes.length > 0) {
        throw new CliError(
          "BROADCAST_UNKNOWN",
          `Step ${i + 1} of ${opts.txs.length} failed after ${txHashes.length} transaction${txHashes.length === 1 ? "" : "s"} were already broadcast (${err instanceof Error ? err.message : String(err)}). Those may still land — verify on-chain before retrying.`,
          { cause: err, details: { tx_hashes: txHashes, failed_step: i + 1, of: opts.txs.length } }
        );
      }
      throw err;
    }
  }
  return { live: opts.live, txHashes, simulatedOnly: !opts.live };
}
