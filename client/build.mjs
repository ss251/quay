import { build } from "esbuild";
import { statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const url = new URL("./dist/quay.js", import.meta.url);
await build({
  entryPoints: [new URL("./src/index.mjs", import.meta.url).pathname],
  outfile: url.pathname,
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  external: ["near-api-js"], // only the Node explicit-key path imports it, lazily
  legalComments: "none",
});
const size = statSync(url).size;
console.log(`client/dist/quay.js ${size} bytes (${(size / 1024).toFixed(1)} KB), gzip ${gzipSync(readFileSync(url)).length} bytes`);
