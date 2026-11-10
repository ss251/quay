// Prepare site/ for `quay up`: copy the client bundle and write assets/config.json.
// Run from anywhere: node examples/board/build.mjs
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const bundle = join(root, "client", "dist", "quay.js");

if (!existsSync(bundle) || process.argv.includes("--rebuild")) {
  const built = spawnSync("node", ["build.mjs"], {
    cwd: join(root, "client"),
    stdio: "inherit",
  });
  if (built.status !== 0)
    throw new Error("could not build client/dist/quay.js");
}
copyFileSync(bundle, join(here, "site", "assets", "quay.js"));
// quay.js loads these on demand (FastData, functions and checkout), so they sit next to it.
for (const extra of ["extras.mjs", "fastdata.mjs"]) {
  const from = join(root, "client", "dist", extra);
  if (existsSync(from)) copyFileSync(from, join(here, "site", "assets", extra));
}
// The hero photo is large, so quay deploy stores it off chain (files.external_over).
copyFileSync(
  join(here, "art", "harbour.png"),
  join(here, "site", "assets", "img", "harbour.png"),
);

const project = JSON.parse(readFileSync(join(here, "quay.json"), "utf8"));
const local = existsSync(join(here, "board.json"))
  ? JSON.parse(readFileSync(join(here, "board.json"), "utf8"))
  : {};
const config = {
  site: project.account,
  relay: local.relay ?? null,
  rpc: local.rpc ?? null,
};
writeFileSync(
  join(here, "site", "assets", "config.json"),
  `${JSON.stringify(config)}\n`,
);
console.log(
  `site/assets/quay.js and config.json written for ${config.site}${config.relay ? ` (relay ${config.relay})` : " (no relay set: copy board.example.json to board.json)"}`,
);
