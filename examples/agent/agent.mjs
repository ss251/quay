#!/usr/bin/env node
// An agent account pays for storage, then the publish-only key deploys a page.
// The same key is refused when it tries to promote. Keys are read from the
// credentials folder and are not printed.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fundContract, main } from "quay-near";

const account = process.env.QUAY_ACCOUNT;
const payer = process.env.QUAY_AGENT;
if (!account || !payer) {
  console.error("Set QUAY_ACCOUNT and QUAY_AGENT. QUAY_AGENT is the account that pays for storage.");
  process.exit(1);
}

const credentials = join(homedir(), ".near-credentials", "testnet");
const payerFile = JSON.parse(readFileSync(join(credentials, `${payer}.json`), "utf8"));
const site = fileURLToPath(new URL("./site", import.meta.url));
const rpc = process.env.QUAY_RPC || "https://test.rpc.fastnear.com";

const funded = await fundContract({
  payerId: payer,
  secret: payerFile.private_key,
  rpc,
  contractId: account,
  yocto: 20_000_000_000_000_000_000_000n,
  memo: "agent storage",
});
console.log(`funded ${funded.hash}`);

const deployed = await main(["deploy", site, "--message", "agent page", "--ci", "--yes", "--account", account]);
if (deployed !== 0) process.exit(deployed);

const refused = await main(["promote", "1", "--ci", "--yes", "--account", account]);
if (refused !== 3) {
  console.error(`promote exited ${refused}. A publish-only key must exit 3.`);
  process.exit(refused || 1);
}
console.log("promote refused before a transaction was sent");
