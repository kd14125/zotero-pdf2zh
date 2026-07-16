import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const outputDirectory = resolve("build/mcp");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve("src/mcp/index.ts")],
  outfile: resolve(outputDirectory, "server.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  minify: false,
});
await copyFile(process.execPath, resolve(outputDirectory, "pdf2zh-mcp.exe"));
