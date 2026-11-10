import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bundleRelay, VENDORED } from "../build.mjs";

test("cli/vendor/relay/server.mjs matches client/src (run `node client/build.mjs`)", async () => {
  assert.equal(readFileSync(VENDORED, "utf8"), await bundleRelay());
});
