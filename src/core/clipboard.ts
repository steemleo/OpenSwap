import { spawn } from "node:child_process";
import { childEnv } from "./paths.js";

// Best-effort clipboard write for the deposit handoff — resolves false on any
// failure (missing binary, headless session, timeout) and never throws, so the
// payment flow can only be helped by it, never blocked.
export async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["-ib"]]
          ];
  for (const [cmd, args] of candidates) {
    if (await attempt(cmd, args, text)) return true;
  }
  return false;
}

function attempt(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean): void => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], env: childEnv() });
      const timer = setTimeout(() => {
        child.kill();
        finish(false);
      }, 1500);
      child.on("error", () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(text);
    } catch {
      finish(false);
    }
  });
}
