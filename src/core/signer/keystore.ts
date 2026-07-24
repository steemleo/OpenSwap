import { createCipheriv, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { scrypt } from "@noble/hashes/scrypt.js";

// V3 keystore ENCRYPTION — the mirror of decryptKeystoreV3 in evm.ts.
// scrypt n=131072/r=8/p=1 (MetaMask-class hardness), aes-128-ctr, keccak MAC.
const SCRYPT = { N: 131072, r: 8, p: 1, dkLen: 32 };

export function encryptKeystoreV3(privateKey: string, password: string, address: string): string {
  const priv = Buffer.from(privateKey.replace(/^0x/, ""), "hex");
  if (priv.length !== 32) throw new Error("private key must be 32 bytes");
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derived = Buffer.from(scrypt(Buffer.from(password, "utf8"), salt, SCRYPT));
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(priv), cipher.final()]);
  const mac = Buffer.from(keccak_256(Buffer.concat([derived.subarray(16, 32), ciphertext])));
  return JSON.stringify(
    {
      version: 3,
      id: randomUUID(),
      address: address.replace(/^0x/, "").toLowerCase(),
      crypto: {
        cipher: "aes-128-ctr",
        cipherparams: { iv: iv.toString("hex") },
        ciphertext: ciphertext.toString("hex"),
        kdf: "scrypt",
        kdfparams: { dklen: SCRYPT.dkLen, n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("hex") },
        mac: mac.toString("hex")
      }
    },
    null,
    2
  );
}

export function keystoreAddress(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { address?: string };
    return parsed.address ? `0x${parsed.address.replace(/^0x/, "")}` : null;
  } catch {
    return null;
  }
}

export function macsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
