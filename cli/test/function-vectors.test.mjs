// Cross-check vectors for the Rust functions in functions/.
// The JS side (client/src encoders and near-api-js) builds each vector here;
// the Rust tests read the same JSON files and must produce the same bytes.
// QUAY_WRITE_VECTORS=1 rewrites the files.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  KeyPair,
  SCHEMA,
  Signature,
  SignedTransaction,
  actions,
  createTransaction,
  encodeTransaction,
} from "near-api-js";

import { ed25519 } from "../../client/src/ed.mjs";
import {
  base58Encode,
  base64Encode,
  encodeSignedDelegate,
  formatPublicKey,
  formatSecretKey,
  hex,
  nep413Payload,
  nep413Sign,
  signDelegate,
} from "../../client/src/encoding.mjs";
import { verifySignIn } from "../../client/src/verify.mjs";

const NEP413_FILE = new URL(
  "../../functions/quay-fn/tests/vectors/nep413.json",
  import.meta.url,
);
const RELAY_FILE = new URL(
  "../../functions/relay/tests/vectors/relay.json",
  import.meta.url,
);

const seedOf = (byte) => new Uint8Array(32).fill(byte);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();

async function keyOf(byte) {
  const seed = seedOf(byte);
  const pub = await ed25519.getPublicKey(seed);
  return {
    seed,
    pub,
    publicKey: formatPublicKey(pub),
    secret: formatSecretKey(seed, pub),
  };
}

function check(file, fresh) {
  if (process.env.QUAY_WRITE_VECTORS === "1")
    writeFileSync(file, `${JSON.stringify(fresh, null, 2)}\n`);
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(stored, fresh);
}

async function nep413Vector() {
  const key = await keyOf(1);
  const site = "board.testnet";
  const nonce = new Uint8Array(32).map((_, i) => i);
  const issued = "2026-11-11T10:00:00.000Z";
  const message = `Sign in to ${site}\nSite: ${site}\nIssued: ${issued}`;
  const payload = { message, nonce, recipient: site };
  const signature = await nep413Sign(key.secret, payload);
  return {
    note: "Built by cli/test/function-vectors.test.mjs from client/src/encoding.mjs",
    now_ms: Date.parse(issued) + 30_000,
    proof: {
      accountId: "alice.board.testnet",
      publicKey: key.publicKey,
      signature: base64Encode(signature),
      message,
      nonce: base64Encode(nonce),
      recipient: site,
    },
    payload_hex: hex(nep413Payload(payload)),
    with_callback_hex: hex(
      nep413Payload({ ...payload, callbackUrl: "https://board.testnet.page/" }),
    ),
  };
}

function borshDeserialize() {
  const fromNear = createRequire(
    createRequire(import.meta.url).resolve("near-api-js"),
  );
  return import(pathToFileURL(fromNear.resolve("borsh")).href);
}

async function relayVector() {
  const member = await keyOf(4);
  const relayer = await keyOf(3);
  const delegate = {
    senderId: "alice.board.testnet",
    receiverId: "board.testnet",
    actions: [
      {
        methodName: "db_add",
        args: { collection: "posts", data: '{"title":"hi"}' },
        gas: 100_000_000_000_000n,
        deposit: 0n,
      },
    ],
    nonce: 12n,
    maxBlockHeight: 1000n,
    publicKey: member.publicKey,
  };
  const signedDelegate = encodeSignedDelegate(
    await signDelegate(delegate, member.secret),
  );

  // near-api-js builds the outer transaction from the same delegate bytes.
  const { deserialize } = await borshDeserialize();
  const sd = deserialize(SCHEMA.SignedDelegate, signedDelegate);
  const relayerKey = KeyPair.fromString(relayer.secret);
  const blockHash = new Uint8Array(32).fill(5);
  const tx = createTransaction(
    "relay.board.testnet",
    relayerKey.getPublicKey(),
    delegate.senderId,
    77n,
    [actions.signedDelegate(sd)],
    blockHash,
  );
  const txBytes = encodeTransaction(tx);
  const txHash = sha256(txBytes);
  const signed = new SignedTransaction({
    transaction: tx,
    signature: new Signature({
      keyType: 0,
      data: relayerKey.sign(txHash).signature,
    }),
  }).encode();

  const join = createTransaction(
    "relay.board.testnet",
    relayerKey.getPublicKey(),
    "board.testnet",
    78n,
    [
      actions.functionCall(
        "join",
        { name: "alice", public_key: member.publicKey },
        100_000_000_000_000n,
        0n,
      ),
    ],
    blockHash,
  );
  return {
    note: "Built by cli/test/function-vectors.test.mjs with near-api-js 7.4.0",
    relayer_account: "relay.board.testnet",
    relayer_seed_hex: hex(relayer.seed),
    relayer_public_key: relayer.publicKey,
    member_public_key: member.publicKey,
    nonce: 77,
    block_hash: base58Encode(blockHash),
    signed_delegate_base64: base64Encode(signedDelegate),
    tx_hex: hex(txBytes),
    tx_hash: base58Encode(txHash),
    signed_tx_hex: hex(signed),
    join_nonce: 78,
    join_tx_hex: hex(encodeTransaction(join)),
  };
}

test("nep413 vector matches client/src/encoding.mjs and verifySignIn accepts it", async () => {
  const fresh = await nep413Vector();
  check(NEP413_FILE, fresh);
  const rpc = {
    accessKey: async () => ({ nonce: 1, permission: "FullAccess" }),
  };
  const ok = await verifySignIn(fresh.proof, {
    site: "board.testnet",
    rpc,
    now: fresh.now_ms,
  });
  assert.equal(ok.ok, true);
  const bad = await verifySignIn(
    { ...fresh.proof, message: `${fresh.proof.message} ` },
    { site: "board.testnet", rpc, now: fresh.now_ms },
  );
  assert.deepEqual(bad, { ok: false, reason: "bad signature" });
});

test("relay vector: near-api-js wraps the delegate the way the Rust relay must", async () => {
  check(RELAY_FILE, await relayVector());
});
