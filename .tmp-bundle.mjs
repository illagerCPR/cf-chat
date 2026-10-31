import { build } from "esbuild";
await build({
  entryPoints: ["src/providers/workers-ai.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: "/tmp/wai.mjs",
  logLevel: "error",
});
