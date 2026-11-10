import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("..", import.meta.url));

test("npm pack installs a quay binary that prints help", () => {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
