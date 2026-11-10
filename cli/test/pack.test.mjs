import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("..", import.meta.url));

// Starts the packed `quay gateway` against an RPC that refuses connections and
// expects the clean 502 page, so the vendored gateway core is in the tarball.
async function packedGateway(bin) {
  const child = spawn(
    bin,
    [
      "gateway",
      "--account",
      "demo.testnet",
      "--port",
      "0",
      "--rpc",
      "http://127.0.0.1:9",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  const url = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (match) resolve(match[1]);
    });
    child.once("exit", () => reject(new Error(`gateway exited: ${out}`)));
  });
  const res = await fetch(url);
  const html = await res.text();
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGINT");
  });
  return { status: res.status, html };
}

test("npm pack installs a quay binary that prints help", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quay-pack-"));
  try {
    const name = execFileSync("npm", ["pack", "--pack-destination", dir], {
      cwd: cli,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .pop();
    const prefix = join(dir, "prefix");
    execFileSync("npm", ["install", "--prefix", prefix, join(dir, name)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const bin = join(prefix, "node_modules", ".bin", "quay");
    const help = execFileSync(bin, ["--help"], { encoding: "utf8" });
    assert.match(help, /init\s+Create or adopt/);
    assert.match(help, /deploy\s+Upload a folder/);
    const deployHelp = execFileSync(bin, ["deploy", "--help"], {
      encoding: "utf8",
    });
    assert.match(deployHelp, /--message/);
    assert.match(deployHelp, /--json/);
    const served = await packedGateway(bin);
    assert.equal(served.status, 502);
    assert.match(served.html, /Every RPC endpoint failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
