import esbuild from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes("--production");

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

// Bundle the extension entry point (vscode API is provided by the host).
await esbuild.build({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"],
});

// Bundle the language server into a self-contained file so it can be
// spawned as a child process without any node_modules present.
// NOTE: @thtml/core must be built before this step (dist/index.js must exist).
await esbuild.build({
  ...shared,
  entryPoints: [resolve(__dirname, "../language-server/src/server.ts")],
  outfile: "dist/server.js",
});
