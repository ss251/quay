#!/usr/bin/env node
// An agent account funds Quay, publishes with the publish-only key, then
// shows that the same key is rejected on promote. Nothing here is a secret.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ACCOUNT = "quay-bb.testnet";
const AGENT = "agent.quay-bb.testnet";
const NETWORK = "testnet";
const NEAR = process.env.NEAR_BIN || "near";
const PUBLISH_KEY = join(homedir(), ".near-credentials", NETWORK, `${ACCOUNT}.publish.json`);

function env() {
  return {
    ...process.env,
    PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH || ""}`,
  };
}

function run(args, { allowFail = false } = {}) {
  const result = spawnSync(NEAR, args, { env: env(), encoding: "utf8", timeout: 180_000 });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0 && !allowFail) {
    console.error(output.trim());
    process.exit(result.status || 1);
  }
  return { status: result.status, output };
}

function tx(output) {
  const match = output.match(/Transaction ID:\s*(\S+)/);
  return match ? match[1] : null;
}

if (!existsSync(PUBLISH_KEY)) {
  console.error(`missing publish key file: ${PUBLISH_KEY}`);
  process.exit(1);
}

console.log(`fund ${AGENT} -> ${ACCOUNT}`);
const fund = run([
  "tokens",
  AGENT,
  "send-near",
  ACCOUNT,
  "0.05 NEAR",
  "network-config",
  NETWORK,
  "sign-with-legacy-keychain",
  "send",
]);
const fundTx = tx(fund.output);
if (fundTx) console.log(`fund tx ${fundTx}`);

console.log("publish with the publish-only key");
const published = spawnSync(process.execPath, [join(ROOT, "cli", "quay.mjs"), "publish", join(ROOT, "site", "agent.html")], {
  env: env(),
  encoding: "utf8",
  timeout: 180_000,
});
process.stdout.write(published.stdout || "");
if (published.status !== 0) {
  process.stderr.write(published.stderr || "");
  process.exit(published.status || 1);
}

console.log("promote with the publish-only key");
const refused = run([
  "contract",
  "call-function",
  "as-transaction",
  ACCOUNT,
  "promote",
  "json-args",
  '{"id":"1"}',
  "prepaid-gas",
  "30 Tgas",
  "attached-deposit",
  "0 NEAR",
  "sign-as",
  ACCOUNT,
  "network-config",
  NETWORK,
  "sign-with-access-key-file",
  PUBLISH_KEY,
  "send",
], { allowFail: true });
const refusedTx = tx(refused.output);
if (refused.status === 0) {
  console.error("publish key was able to promote");
  process.exit(1);
}
console.log("promote rejected");
if (refusedTx) console.log(`rejected tx ${refusedTx}`);
const line = refused.output.split("\n").find((item) => /not allowed|MethodNotAllowed|permission|AccessKey|yoctoNEAR|panic/i.test(item));
if (line) console.log(line.trim());
