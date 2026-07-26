import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  // tsup 8.x strips the `node:` prefix by default. Without it a malicious
  // package named `fs` or `path` can shadow a builtin — not acceptable in a
  // CLI that handles keys and deposit addresses.
  removeNodeProtocol: false,
  splitting: false,
  clean: true,
  minify: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
  loader: { ".md": "text" }
});
