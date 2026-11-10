import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySignIn } from "../src/verify.mjs";
import { base64Encode, nep413Sign, randomBytes } from "../src/encoding.mjs";
import { fakeFetch, memberKey, rpcErr, MEMBER, SITE } from "./helpers.mjs";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const full = (k) => ({ viewAccessKey: { permission: "FullAccess", nonce: 3 }, k });

async function proof(k, over = {}) {
  const nonce = randomBytes(32);
  const message = over.message ?? `Sign in to ${SITE}\nSite: ${SITE}\nIssued: ${new Date(NOW - 1000).toISOString()}`;
  const recipient = over.recipient ?? SITE;
  const sig = await nep413Sign(k.secretKey, { message, nonce, recipient });
  return { accountId: MEMBER, publicKey: k.pub, signature: base64Encode(sig), message, nonce: base64Encode(nonce), recipient, ...over.fields };
}
const rpcWith = (permission) =>
  fakeFetch({ rpc: { query: (p) => { assert.equal(p.request_type, "view_access_key"); if (!permission) throw rpcErr("UNKNOWN_ACCESS_KEY"); return { permission, nonce: 1 }; } } });

test("accepts a valid proof", async () => {
  const k = await memberKey();
  const r = await verifySignIn(await proof(k), { site: SITE, now: NOW, fetch: rpcWith("FullAccess") });
  assert.equal(r.ok, true);
  assert.equal(r.accountId, MEMBER);
});

test("rejects a tampered message", async () => {
  const k = await memberKey();
  const p = await proof(k);
  const r = await verifySignIn({ ...p, message: p.message + " " }, { site: SITE, now: NOW, fetch: rpcWith("FullAccess") });
  assert.deepEqual([r.ok, r.reason], [false, "bad signature"]);
});

test("rejects the wrong recipient, even when signed for it", async () => {
  const k = await memberKey();
  const r = await verifySignIn(await proof(k, { recipient: "evil.testnet" }), { site: SITE, now: NOW, fetch: rpcWith("FullAccess") });
  assert.deepEqual([r.ok, r.reason], [false, "wrong recipient"]);
});

test("rejects stale and future proofs", async () => {
  const k = await memberKey();
  const old = await proof(k, { message: `Sign in\nIssued: ${new Date(NOW - 10 * 60_000).toISOString()}` });
  assert.equal((await verifySignIn(old, { site: SITE, now: NOW, fetch: rpcWith("FullAccess") })).reason, "stale");
  assert.equal((await verifySignIn(old, { site: SITE, now: NOW, maxAgeMs: 3_600_000, fetch: rpcWith("FullAccess") })).ok, true);
  const future = await proof(k, { message: `Sign in\nIssued: ${new Date(NOW + 10 * 60_000).toISOString()}` });
  assert.equal((await verifySignIn(future, { site: SITE, now: NOW, fetch: rpcWith("FullAccess") })).reason, "timestamp is in the future");
  const none = await proof(k, { message: "Sign in" });
  assert.equal((await verifySignIn(none, { site: SITE, now: NOW, fetch: rpcWith("FullAccess") })).reason, "message has no timestamp");
});

test("rejects a function-call key", async () => {
  const k = await memberKey();
  const r = await verifySignIn(await proof(k), { site: SITE, now: NOW, fetch: rpcWith({ FunctionCall: { receiver_id: "x.testnet", method_names: [], allowance: "1" } }) });
  assert.deepEqual([r.ok, r.reason], [false, "key is not full access"]);
});

test("rejects a key that is not on the account", async () => {
  const k = await memberKey();
  const r = await verifySignIn(await proof(k), { site: SITE, now: NOW, fetch: rpcWith(null) });
  assert.deepEqual([r.ok, r.reason], [false, "key is not on the account"]);
});

test("rejects malformed proofs without calling the network", async () => {
  const f = fakeFetch();
  const k = await memberKey();
  const p = await proof(k);
  for (const bad of [null, {}, { ...p, signature: "" }, { ...p, signature: "AAAA" }, { ...p, nonce: base64Encode(new Uint8Array(5)) }, { ...p, signature: "***" }]) {
    assert.equal((await verifySignIn(bad, { site: SITE, now: NOW, fetch: f })).ok, false);
  }
  assert.equal(f.calls.length, 0);
});

test("reports rpc failures as a rejection", async () => {
  const k = await memberKey();
  const r = await verifySignIn(await proof(k), { site: SITE, now: NOW, fetch: fakeFetch() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /rpc error/);
});

test("requires a site", async () => {
  await assert.rejects(verifySignIn({}, {}), /site/);
});

test("a node that answers an unknown key with result.error is treated as a missing key", async () => {
  const k = await memberKey();
  const fetch = fakeFetch({ rpc: { query: () => ({ error: "access key ed25519:xyz does not exist while viewing", logs: [] }) } });
  const r = await verifySignIn(await proof(k), { site: SITE, now: NOW, fetch });
  assert.deepEqual([r.ok, r.reason], [false, "key is not on the account"]);
});
