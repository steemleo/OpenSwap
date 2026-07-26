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
  // Bundle every dependency into the single output file. `npx openswap`
  // otherwise installs ~90 MB across 46 packages to run a 350 KB CLI, and
  // that download IS the cold start for a tool whose whole pitch is "one
  // command, no install". It also removes 46 transitive packages of
  // supply-chain surface from a machine that may hold private keys.
  noExternal: [/.*/],
  splitting: false,
  clean: true,
  minify: false,
  sourcemap: false,
  banner: {
    // `qrcode` is CommonJS and dynamically requires builtins (`require("fs")`
    // inside its PNG renderer). esbuild replaces `require` with a shim that
    // resolves BUNDLED modules but refuses builtins, so bundling needs a real
    // require restored here. Bundled modules still go through esbuild's shim.
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);"
    ].join("\n")
  },
  loader: { ".md": "text" }
});
