import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ensureSimRpc } from "../../src/testmode/rpc.js";
import { TEST_SIGNER_PRIVATE_KEY } from "../../src/testmode/world.js";

describe("sim RPC serves a full viem send/confirm round-trip", () => {
  it("estimates, sends, and confirms with real signing", async () => {
    const url = await ensureSimRpc(1);
    const chain = {
      id: 1,
      name: "test",
      nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [url] } }
    } as const;
    const account = privateKeyToAccount(TEST_SIGNER_PRIVATE_KEY as `0x${string}`);
    const publicClient = createPublicClient({ chain, transport: http(url), pollingInterval: 100 });
    const walletClient = createWalletClient({ account, chain, transport: http(url), pollingInterval: 100 });

    await publicClient.call({ account, to: "0x7e57000000000000000000000000000000000001", data: "0x7e57c0de" });
    const hash = await walletClient.sendTransaction({
      to: "0x7e57000000000000000000000000000000000001",
      data: "0x7e57c0de",
      value: 0n
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 10_000, pollingInterval: 100 });
    expect(receipt.status).toBe("success");
  }, 20_000);
});
