import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDelegate, memoryStore, relay, failures, RelayError, DEFAULT_POLICY, hourBucket } from "../src/relay-core.mjs";
import { base64Encode } from "../src/encoding.mjs";
import { Account, KeyPairSigner, actions, memberKey, mkDelegate, SITE, MEMBER } from "./helpers.mjs";

const NOW = { ms: Date.parse("2026-11-10T12:00:00Z"), height: 1000n };
const policy = (over = {}) => ({ site: SITE, store: memoryStore(), ...over });
const act = (over = {}) => ({ methodName: "db_add", args: { collection: "posts", data: "{}" }, gas: 10n * 10n ** 12n, deposit: 0n, ...over });
const T = 10n ** 12n;

async function check(key, over, pol, now = NOW) {
  const m = await mkDelegate(key, over);
  return checkDelegate(m.b64, pol ?? policy(), now);
}

test("accepts a normal relayed write and exposes its facts", async () => {
  const k = await memberKey();
  const r = await check(k, { maxBlockHeight: 1120n });
  assert.equal(r.ok, true);
  assert.equal(r.sender, MEMBER);
  assert.equal(r.receiver, SITE);
  assert.equal(r.gas, 10n * T);
  assert.match(r.digest, /^[0-9a-f]{64}$/);
});

test("accepts raw bytes as well as base64", async () => {
  const k = await memberKey();
  const m = await mkDelegate(k);
  assert.equal((await checkDelegate(m.bytes, policy(), NOW)).ok, true);
});

const rejects = [
  ["malformed base64", async () => checkDelegate("%%%", policy(), NOW), "malformed"],
  ["malformed bytes", async () => checkDelegate(base64Encode(new Uint8Array([1, 2, 3])), policy(), NOW), "malformed"],
  ["no actions", (k) => check(k, { actions: [] }), "no_actions"],
  ["non-FunctionCall action", async (k) => {
    // a Transfer action built by near-api-js, signed with the member key
    const { buildDelegateAction, encodeSignedDelegate } = await import("near-api-js");
    const signer = new KeyPairSigner(k.kp);
    const da = buildDelegateAction({ senderId: MEMBER, receiverId: SITE, nonce: 1n, maxBlockHeight: 1100n, publicKey: await signer.getPublicKey(), actions: [actions.transfer(1n)] });
    const { signedDelegate } = await signer.signDelegateAction(da);
    return checkDelegate(base64Encode(encodeSignedDelegate(signedDelegate)), policy(), NOW);
  }, "action_not_allowed"],
  ["bad signature", async (k) => {
    const m = await mkDelegate(k);
    const b = Uint8Array.from(m.bytes);
    b[b.length - 1] ^= 1;
    return checkDelegate(b, policy(), NOW);
  }, "bad_signature"],
  ["signature over different content", async (k) => {
    const a = await mkDelegate(k, { nonce: 1n });
    const b = await mkDelegate(k, { nonce: 2n });
    const forged = Uint8Array.from(b.bytes);
    forged.set(a.bytes.slice(-64), forged.length - 64);
    return checkDelegate(forged, policy(), NOW);
  }, "bad_signature"],
  ["deposit of 1 NEAR", (k) => check(k, { actions: [act({ deposit: 10n ** 24n })] }), "deposit_not_allowed"],
  ["deposit of 1 yocto", (k) => check(k, { actions: [act({ deposit: 1n })] }), "deposit_not_allowed"],
  ["deposit in a later action", (k) => check(k, { actions: [act(), act({ deposit: 1n })] }), "deposit_not_allowed"],
  ["gas over the limit", (k) => check(k, { actions: [act({ gas: 301n * T })] }), "gas_too_high"],
  ["gas summed over actions", (k) => check(k, { actions: [act({ gas: 160n * T }), act({ gas: 160n * T })] }), "gas_too_high"],
  ["sender not a member", (k) => check(k, { senderId: "bob.testnet" }), "sender_not_member"],
  ["other receiver", (k) => check(k, { receiverId: "evil.testnet" }), "receiver_not_allowed"],
  ["self receiver when uploads are off", (k) => check(k, { receiverId: MEMBER, actions: [act({ methodName: "fs_store" })] }), "receiver_not_allowed"],
  ["method not on the list", (k) => check(k, { actions: [act({ methodName: "set_collection" })] }), "method_not_allowed"],
  ["one bad method among good ones", (k) => check(k, { actions: [act(), act({ methodName: "join" })] }), "method_not_allowed"],
  ["upload receiver with another method", (k) => check(k, { receiverId: MEMBER, actions: [act({ methodName: "db_add" })] }, policy({ allowUploads: true })), "method_not_allowed"],
  ["already expired", (k) => check(k, { maxBlockHeight: 1000n }), "expired"],
  ["expiry in the past", (k) => check(k, { maxBlockHeight: 5n }), "expired"],
  ["expiry too far ahead", (k) => check(k, { maxBlockHeight: 1201n }), "expiry_too_far"],
];
for (const [name, run, code] of rejects) {
  test(`rejects: ${name}`, async () => {
    const k = await memberKey();
    const r = await run(k);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, code);
    assert.ok(r.reason.length > 5);
  });
}

test("boundary: expiry exactly 200 blocks ahead is fine, 1 block ahead is fine", async () => {
  const k = await memberKey();
  assert.equal((await check(k, { maxBlockHeight: 1200n })).ok, true);
  assert.equal((await check(k, { maxBlockHeight: 1001n })).ok, true);
});

test("boundary: gas exactly at the limit is fine", async () => {
  const k = await memberKey();
  assert.equal((await check(k, { maxBlockHeight: 1100n, actions: [act({ gas: 300n * T })] })).ok, true);
});

test("uploads: self receiver with fs_store passes only when allowed", async () => {
  const k = await memberKey();
  const over = { receiverId: MEMBER, actions: [act({ methodName: "fs_store" })] };
  assert.equal((await check(k, over, policy({ allowUploads: true }))).ok, true);
  assert.equal((await check(k, over, policy({ allowUploads: false }))).code, "receiver_not_allowed");
});

test("memberOnly can be turned off", async () => {
  const k = await memberKey();
  assert.equal((await check(k, { senderId: "bob.testnet" }, policy({ memberOnly: false }))).ok, true);
});

test("custom method list", async () => {
  const k = await memberKey();
  const over = { actions: [act({ methodName: "pay" })] };
  assert.equal((await check(k, over)).code, "method_not_allowed");
  assert.equal((await check(k, over, policy({ methods: ["pay"] }))).ok, true);
});

test("per-account hourly limit, counted only after commit, reset next hour", async () => {
  const k = await memberKey();
  const pol = policy({ perAccountPerHour: 2 });
  for (let i = 0; i < 2; i++) {
    const r = await check(k, { nonce: BigInt(i + 1) }, pol);
    assert.equal(r.ok, true);
    await r.commit();
  }
  const third = await check(k, { nonce: 3n }, pol);
  assert.equal(third.code, "account_rate_limit");
  const other = await memberKey();
  assert.equal((await check(other, { senderId: `carol.${SITE}` }, pol)).ok, true);
  assert.equal((await check(k, {}, pol, { ms: NOW.ms + 3_600_000, height: NOW.height })).ok, true);
  assert.equal(hourBucket(NOW.ms) + 1, hourBucket(NOW.ms + 3_600_000));
});

test("a check that is not committed does not spend budget", async () => {
  const k = await memberKey();
  const pol = policy({ perAccountPerHour: 1 });
  for (let i = 0; i < 5; i++) assert.equal((await check(k, {}, pol)).ok, true);
});

test("daily gas budget in Tgas, resets on the next UTC day", async () => {
  const k = await memberKey();
  const pol = policy({ dailyTgas: 25 });
  const a = await check(k, {}, pol);
  await a.commit();
  const b = await check(k, {}, pol);
  await b.commit();
  assert.equal((await check(k, {}, pol)).code, "daily_budget");
  assert.equal((await check(k, {}, pol, { ms: NOW.ms + 86_400_000, height: NOW.height })).ok, true);
});

test("defaults match the frozen spec", () => {
  assert.deepEqual(DEFAULT_POLICY.methods, ["db_add", "db_update", "db_remove", "fn_call"]);
  assert.equal(DEFAULT_POLICY.maxGas, 300n * T);
  assert.equal(DEFAULT_POLICY.maxBlockHeightAhead, 200n);
  assert.equal(DEFAULT_POLICY.perAccountPerHour, 30);
  assert.equal(DEFAULT_POLICY.dailyTgas, 30000);
});

test("argument errors", async () => {
  await assert.rejects(checkDelegate("", { store: memoryStore() }, NOW), /site/);
  await assert.rejects(checkDelegate("", { site: SITE }, NOW), /store/);
  await assert.rejects(checkDelegate("", policy(), { ms: 1 }), /now/);
});

test("failures() finds outer, transaction and inner receipt failures", () => {
  assert.deepEqual(failures({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] }), []);
  assert.equal(failures({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: "x" } } } } }] }).length, 1);
  assert.equal(failures({ status: { Failure: "boom" } })[0], "boom");
});

test("relay() wraps the delegate in a relayer transaction and returns the hash", async () => {
  const k = await memberKey();
  const m = await mkDelegate(k);
  let seen;
  const account = {
    relayMetaTransaction: async (sd) => {
      seen = sd;
      return { transaction: { hash: "H1" }, status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] };
    },
  };
  const out = await relay(m.b64, { account });
  assert.equal(out.hash, "H1");
  assert.equal(seen.delegateAction.senderId, MEMBER);
  assert.equal(seen.delegateAction.actions[0].functionCall.methodName, "db_add");
});

test("relay() throws with the reason when an inner receipt failed", async () => {
  const k = await memberKey();
  const m = await mkDelegate(k);
  const account = {
    relayMetaTransaction: async () => ({
      transaction: { hash: "H2" },
      status: { SuccessValue: "" },
      receipts_outcome: [
        { outcome: { status: { SuccessValue: "" } } },
        { outcome: { status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: storage pool is empty" } } } } } } },
      ],
    }),
  };
  await assert.rejects(relay(m.bytes, { account }), (e) => {
    assert.ok(e instanceof RelayError);
    assert.equal(e.code, "inner_failure");
    assert.match(e.message, /storage pool is empty/);
    assert.equal(e.outcome.transaction.hash, "H2");
    return true;
  });
});

test("relay() throws when the outer transaction failed", async () => {
  const k = await memberKey();
  const m = await mkDelegate(k);
  const account = { relayMetaTransaction: async () => ({ status: { Failure: { ActionError: "no balance" } }, receipts_outcome: [] }) };
  await assert.rejects(relay(m.b64, { account }), /no balance/);
});
