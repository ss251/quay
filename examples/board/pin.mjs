// Pay for a pin with an explicit key (the Node path of @quay/client). Used to seed
// the live board's pins from a funded throwaway buyer account.
//
//   node pin.mjs <posts/id> [--token] [--buyer <account>]
//
// The buyer's key is read from ~/.near-credentials/testnet/<buyer>.json and never printed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { connect } from "../../client/src/index.mjs";

const args = process.argv.slice(2);
const ref = args.find((a) => /^posts\/[A-Za-z0-9_-]+$/.test(a));
if (!ref) {
  console.error("usage: node pin.mjs posts/<id> [--token] [--buyer <account>]");
  process.exit(1);
}
const at = args.indexOf("--buyer");
const buyer = at === -1 ? "buyer.harbour-board.testnet" : args[at + 1];
const project = JSON.parse(
  readFileSync(new URL("./quay.json", import.meta.url), "utf8"),
);
const key = JSON.parse(
  readFileSync(
    join(homedir(), ".near-credentials", "testnet", `${buyer}.json`),
    "utf8",
  ),
);
const quay = connect({
  site: project.account,
  key: { accountId: buyer, secretKey: key.private_key },
});
const token = args.includes("--token");
await quay.pay("pin", { ref, token });
const doc = await quay.db.collection("posts").get(ref.split("/")[1]);
console.log(
  `${buyer} paid ${token ? "in test USDC" : "in NEAR"} for ${ref}; pinned_until ${doc?.pinned_until}`,
);
