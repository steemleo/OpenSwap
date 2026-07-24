import { createServer, type Server } from "node:http";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { timescale } from "./world.js";

// A minimal EVM JSON-RPC node for the signer lane: enough for viem to fee-
// estimate, send, and confirm. Signing stays REAL (burned test key, client
// side); the "chain" accepts everything and mines instantly-ish. The chain id
// is carried in the URL path (/rpc/<chainId>) so one server serves any chain.

interface MinedTx {
  hash: string;
  minedAt: number;
}

let server: Server | null = null;
let baseUrl: string | null = null;
const nonces = new Map<string, number>();
const txs = new Map<string, MinedTx>();

const HEX_1_GWEI = "0x3b9aca00";
const MINE_MS = 1500;

// viem's receipt watcher only re-checks when the block number ADVANCES — a
// static block number stalls waitForTransactionReceipt forever. Two "blocks"
// per second keeps every watcher moving.
function currentBlock(): string {
  return `0x${Math.floor(Date.now() / 500).toString(16)}`;
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function handle(chainId: number, method: string, params: unknown[], id: unknown): string {
  switch (method) {
    case "eth_chainId":
      return rpcResult(id, `0x${chainId.toString(16)}`);
    case "net_version":
      return rpcResult(id, String(chainId));
    case "eth_blockNumber":
      return rpcResult(id, currentBlock());
    case "eth_getBlockByNumber":
    case "eth_getBlockByHash":
      return rpcResult(id, {
        number: currentBlock(),
        hash: `0x${"7e57".repeat(16)}`,
        parentHash: `0x${"00".repeat(32)}`,
        baseFeePerGas: HEX_1_GWEI,
        gasLimit: "0x1c9c380",
        gasUsed: "0x5208",
        timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
        transactions: []
      });
    case "eth_gasPrice":
      return rpcResult(id, "0x77359400");
    case "eth_maxPriorityFeePerGas":
      return rpcResult(id, HEX_1_GWEI);
    case "eth_estimateGas":
      return rpcResult(id, "0x186a0");
    case "eth_call":
      return rpcResult(id, "0x");
    case "eth_getTransactionCount": {
      // registering the address here is what lets sendRawTransaction bump the
      // right counter — viem always asks for the nonce before sending
      const addr = String((params[0] as string) ?? "").toLowerCase();
      if (!nonces.has(addr)) nonces.set(addr, 0);
      return rpcResult(id, `0x${(nonces.get(addr) ?? 0).toString(16)}`);
    }
    case "eth_sendRawTransaction": {
      const raw = String((params[0] as string) ?? "0x");
      const hash = `0x${Buffer.from(keccak_256(Buffer.from(raw.replace(/^0x/, ""), "hex"))).toString("hex")}`;
      txs.set(hash, { hash, minedAt: Date.now() + MINE_MS / timescale() });
      // single test signer: every registered sender's next nonce advances, so
      // a multi-step plan (approve → swap) sees 0 then 1
      for (const [addr, n] of nonces) nonces.set(addr, n + 1);
      return rpcResult(id, hash);
    }
    case "eth_getTransactionByHash": {
      // viem polls the TRANSACTION for replacement detection before it will
      // accept a receipt — answering null here stalls confirmation forever.
      const hash = String((params[0] as string) ?? "");
      const tx = txs.get(hash);
      if (!tx) return rpcResult(id, null);
      const mined = Date.now() >= tx.minedAt;
      return rpcResult(id, {
        hash,
        nonce: "0x0",
        from: `0x${"00".repeat(20)}`,
        to: `0x${"00".repeat(20)}`,
        value: "0x0",
        input: "0x",
        gas: "0x186a0",
        maxFeePerGas: "0x77359400",
        maxPriorityFeePerGas: HEX_1_GWEI,
        chainId: `0x${chainId.toString(16)}`,
        type: "0x2",
        v: "0x0",
        r: `0x${"11".repeat(32)}`,
        s: `0x${"11".repeat(32)}`,
        blockNumber: mined ? currentBlock() : null,
        blockHash: mined ? `0x${"7e58".repeat(16)}` : null,
        transactionIndex: mined ? "0x0" : null
      });
    }
    case "eth_getTransactionReceipt": {
      const hash = String((params[0] as string) ?? "");
      const tx = txs.get(hash);
      if (!tx || Date.now() < tx.minedAt) return rpcResult(id, null);
      return rpcResult(id, {
        transactionHash: hash,
        transactionIndex: "0x0",
        blockNumber: currentBlock(),
        blockHash: `0x${"7e58".repeat(16)}`,
        from: `0x${"00".repeat(20)}`,
        to: `0x${"00".repeat(20)}`,
        cumulativeGasUsed: "0x5208",
        gasUsed: "0x5208",
        effectiveGasPrice: HEX_1_GWEI,
        contractAddress: null,
        logs: [],
        logsBloom: `0x${"00".repeat(256)}`,
        status: "0x1",
        type: "0x2"
      });
    }
    default:
      return rpcResult(id, null);
  }
}

// Idempotent per process; nonce tracking must survive a whole plan (approve →
// swap), which it does because the server lives for the process lifetime.
export async function ensureSimRpc(chainId: number): Promise<string> {
  if (server && baseUrl) return `${baseUrl}/rpc/${chainId}`;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const pathChain = Number((req.url ?? "").split("/rpc/")[1] ?? chainId) || chainId;
      let out = "";
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
          | { method: string; params?: unknown[]; id?: unknown }
          | Array<{ method: string; params?: unknown[]; id?: unknown }>;
        out = Array.isArray(body)
          ? `[${body.map((b) => handle(pathChain, b.method, b.params ?? [], b.id)).join(",")}]`
          : handle(pathChain, body.method, body.params ?? [], body.id);
      } catch {
        out = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(out);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  server.unref(); // never keep the process alive on its own
  return `${baseUrl}/rpc/${chainId}`;
}
