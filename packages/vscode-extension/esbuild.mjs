import esbuild from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes("--production");

// Map workspace packages directly to their TypeScript source,
// bypassing pnpm symlinks and the need for pre-built dist/ files.
const alias = {
  "@thtml/core": resolve(__dirname, "../core/src/index.ts"),
};

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  alias,
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
await esbuild.build({
  ...shared,
  entryPoints: [resolve(__dirname, "../language-server/src/server.ts")],
  outfile: "dist/server.js",
});