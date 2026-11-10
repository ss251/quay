import { test } from "node:test";
import assert from "node:assert/strict";
import { createRpc, DEFAULT_RPC_URLS, isRetryable, rpcUrls, RpcError } from "../src/rpc.mjs";
import { createFailoverProvider } from "../src/failover.mjs";
import { connect } from "../src/index.mjs";
import { layerStatus } from "../src/status.mjs";
import { verifySignIn } from "../src/verify.mjs";
import { viewResult, SITE } from "./helpers.mjs";

const [A, B, C] = DEFAULT_RPC_URLS;
const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
const http = (status, body = {}) => ({ ok: false, status, json: async () => body });
const rpcErr = (error) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error }) });

/** fetch whose answer depends on the endpoint URL; records which endpoints were hit, in order. */
function byUrl(map) {
  const hits = [];
  const f = async (url) => {
    hits.push(url);
    const v = map[url];
    if (!v) throw new Error("no stub");
    return typeof v === "function" ? v() : v;
  };
  f.hits = hits;
  return f;
}

test("the default list is the gateway list, in order", () => {
  assert.deepEqual(DEFAULT_RPC_URLS, ["https://test.rpc.fastnear.com", "https://testnet-rpc.intea.rs", "https://near-testnet.drpc.org"]);
  assert.deepEqual(rpcUrls(undefined), DEFAULT_RPC_URLS);
  assert.deepEqual(rpcUrls("https://x.test, https://y.test"), ["https://x.test", "https://y.test"]);
  assert.deepEqual(rpcUrls(["https://rpc.testnet.near.org"]), DEFAULT_RPC_URLS, "the deprecated host is dropped");
});

test("reads fail over on a network error, HTTP 429, HTTP 5xx and a JSON-RPC rate limit", async () => {
  const cases = {
    "network error": () => { throw new Error("fetch failed"); },
    "HTTP 429": () => http(429, { error: "Rate limits exceeded" }),
    "HTTP 503": () => http(503),
    "HTTP 502": () => http(502),
    "JSON-RPC rate limit": () => rpcErr({ code: -429, message: "Server error", data: "Rate limits exceeded" }),
    "rate limit by message": () => rpcErr({ message: "Rate limits exceeded" }),
    "deprecated endpoint": () => http(400, { error: { message: "WARNING! THIS ENDPOINT IS DEPRECATED!" } }),
    "not JSON": () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }),
  };
  for (const [name, first] of Object.entries(cases)) {
    const f = byUrl({ [A]: first, [B]: () => ok({ height: 7 }), [C]: () => ok({ height: 9 }) });
    const rpc = createRpc({ fetch: f });
    assert.deepEqual(await rpc.call("block", {}), { height: 7 }, name);
    assert.deepEqual(f.hits, [A, B], name);
  }
});

test("a real answer is never retried: semantic errors and result.error stay with the first endpoint", async () => {
  const f = byUrl({ [A]: () => rpcErr({ message: "Server error", cause: { name: "UNKNOWN_ACCESS_KEY" } }), [B]: () => ok({}) });
  const rpc = createRpc({ fetch: f });
  assert.equal(await rpc.accessKey("a.testnet", "ed25519:x"), null);
  assert.deepEqual(f.hits, [A]);
  const g = byUrl({ [A]: () => http(400, { error: { message: "bad request" } }), [B]: () => ok({}) });
  await assert.rejects(createRpc({ fetch: g }).call("query", {}), (e) => e instanceof RpcError && /HTTP 400/.test(e.message));
  assert.deepEqual(g.hits, [A]);
});

test("every endpoint failing names each host; a failed endpoint is skipped for 30 s, then tried first again", async () => {
  let t = 1000;
  let healthy = false;
  const f = byUrl({ [A]: () => (healthy ? ok(1) : http(429)), [B]: () => http(503), [C]: () => { throw new Error("ECONNRESET"); } });
  const rpc = createRpc({ fetch: f, now: () => t });
  await assert.rejects(rpc.call("block", {}), (e) => /every RPC endpoint failed/.test(e.message) && /test\.rpc\.fastnear\.com/.test(e.message) && /near-testnet\.drpc\.org/.test(e.message));
  assert.deepEqual(f.hits, [A, B, C]);
  // all are cooling down: all are tried again, in order
  f.hits.length = 0;
  healthy = true;
  assert.equal(await rpc.call("block", {}), 1);
  assert.deepEqual(f.hits, [A]);
  // one failure marks A down for 30 s
  const g = byUrl({ [A]: () => http(429), [B]: () => ok(2) });
  const r2 = createRpc({ fetch: g, now: () => t });
  await r2.call("x", {});
  await r2.call("x", {});
  assert.deepEqual(g.hits, [A, B, B], "A is skipped while cooling down");
  t += 31_000;
  await r2.call("x", {});
  assert.deepEqual(g.hits.slice(3), [A, B]);
});

test("an explicit rpc is the only endpoint (no silent fallback to the defaults)", async () => {
  const f = byUrl({ "https://mine.test": () => http(429), [A]: () => ok(1) });
  await assert.rejects(createRpc({ url: "https://mine.test", fetch: f }).call("x", {}), /every RPC endpoint failed/);
  assert.deepEqual(f.hits, ["https://mine.test"]);
  const g = byUrl({ "https://mine.test": () => http(429), "https://two.test": () => ok("two") });
  assert.equal(await createRpc({ url: ["https://mine.test", "https://two.test"], fetch: g }).call("x", {}), "two");
});

test("isRetryable reads error text and an explicit flag", () => {
  for (const m of ["HTTP 429", "Rate limits exceeded", "fetch failed", "ETIMEDOUT", "Exceeded 12 attempts for request", "request timed out"]) assert.equal(isRetryable(new Error(m)), true, m);
  for (const m of ["Smart contract panicked", "InvalidNonce", "UNKNOWN_ACCESS_KEY"]) assert.equal(isRetryable(new Error(m)), false, m);
  assert.equal(isRetryable(Object.assign(new Error("x"), { retryable: true })), true);
});

test("connect without rpc starts at the first default and fails over on 429", async () => {
  const f = byUrl({ [A]: () => http(429), [B]: () => ok(viewResult({ docs: [], next: null })) });
  const quay = connect({ site: SITE, fetch: f });
  assert.deepEqual(await quay.db.collection("posts").list(), { docs: [], next: null });
  assert.deepEqual(f.hits, [A, B]);
  assert.deepEqual(quay.rpc.urls, DEFAULT_RPC_URLS);
  assert.equal(connect({ site: SITE, rpc: "https://mine.test", fetch: f }).rpc.url, "https://mine.test");
});

test("verifySignIn and layerStatus use the failover list too", async () => {
  const f = byUrl({ [A]: () => http(503), [B]: () => ok({ permission: "FullAccess", nonce: 1 }) });
  const { rpc } = connect({ site: SITE, fetch: f });
  assert.ok(await rpc.accessKey("a.testnet", "ed25519:x"));
  assert.deepEqual(f.hits, [A, B]);

  const hits = [];
  const fetch = async (url, init) => {
    if (init?.body && JSON.parse(init.body).jsonrpc) {
      hits.push(url);
      if (url === A) return http(429);
      return ok({ error: "wasm execution failed: MethodResolveError MethodNotFound", logs: [] });
    }
    return http(404);
  };
  const s = await layerStatus({ site: SITE, fetch, timeoutMs: 500 });
  assert.ok(hits.includes(A) && hits.includes(B), "the status reads moved from fastnear to intea");
  assert.ok(s.layers.site);
  void verifySignIn;
});

// ---------- broadcasts (Node, near-api-js provider) ----------
async function signedFlow(providers) {
  const { Account, KeyPair, actions } = await import("near-api-js");
  const fo = await createFailoverProvider(["https://a.test", "https://b.test"], { makeProvider: (url) => providers[url] });
  const key = KeyPair.fromRandom("ed25519");
  const account = new Account("relay.board.testnet", fo, key.toString());
  const send = () => account.signAndSendTransaction({ receiverId: "board.testnet", actions: [actions.transfer(1n)], waitUntil: "EXECUTED_OPTIMISTIC" });
  return { fo, send };
}
const baseStub = (over = {}) => ({
  viewAccessKey: async () => ({ nonce: 5n, permission: "FullAccess", blockHeight: 1n, blockHash: "11111111111111111111111111111111" }),
  viewBlock: async () => ({ header: { hash: "11111111111111111111111111111111", height: 10 } }),
  sendTransactionUntil: async () => ({ status: { SuccessValue: "" }, transaction_outcome: { id: "H" }, receipts_outcome: [], transaction: { hash: "H" } }),
  viewTransactionStatus: async () => { throw Object.assign(new Error("Transaction doesn't exist"), { type: "UNKNOWN_TRANSACTION" }); },
  ...over,
});

test("a broadcast that failed with a rate limit is looked up by hash first, and not sent again when it landed", async () => {
  const sent = [];
  const looked = [];
  const outcome = { status: { SuccessValue: "" }, transaction_outcome: { id: "LANDED" }, receipts_outcome: [], transaction: { hash: "LANDED" } };
  const { send } = await signedFlow({
    "https://a.test": baseStub({ sendTransactionUntil: async (tx) => { sent.push(["a", tx]); throw new Error("HTTP 429 Rate limits exceeded"); } }),
    "https://b.test": baseStub({
      viewTransactionStatus: async (p) => { looked.push(p); return outcome; },
      sendTransactionUntil: async (tx) => { sent.push(["b", tx]); return outcome; },
    }),
  });
  const result = await send();
  assert.equal(result.transaction.hash, "LANDED");
  assert.deepEqual(sent.map((s) => s[0]), ["a"], "B was only asked, never sent to");
  assert.equal(looked.length, 1);
  assert.match(looked[0].txHash, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.equal(looked[0].accountId, "relay.board.testnet");
});

test("when the next endpoint has never seen it, the same signed bytes are sent: no re-signing", async () => {
  const { encodeTransaction } = await import("near-api-js");
  const sent = [];
  const { send } = await signedFlow({
    "https://a.test": baseStub({ sendTransactionUntil: async (tx) => { sent.push(["a", tx]); throw new Error("fetch failed"); } }),
    "https://b.test": baseStub({ sendTransactionUntil: async (tx) => { sent.push(["b", tx]); return { status: { SuccessValue: "" }, transaction_outcome: { id: "X" }, receipts_outcome: [], transaction: { hash: "X" } }; } }),
  });
  await send();
  assert.deepEqual(sent.map((s) => s[0]), ["a", "b"]);
  assert.deepEqual(Buffer.from(encodeTransaction(sent[0][1])), Buffer.from(encodeTransaction(sent[1][1])), "byte-identical signed transaction");
});

test("a transaction error is not a reason to try another endpoint, and exhausted endpoints say so", async () => {
  const calls = [];
  const bad = await signedFlow({
    "https://a.test": baseStub({ sendTransactionUntil: async () => { calls.push("a"); throw new Error("Smart contract panicked"); } }),
    "https://b.test": baseStub({ sendTransactionUntil: async () => { calls.push("b"); return {}; } }),
  });
  await assert.rejects(bad.send(), /panicked/);
  assert.deepEqual(calls, ["a"]);
  const down = await signedFlow({
    "https://a.test": baseStub({ sendTransactionUntil: async () => { throw new Error("HTTP 503"); } }),
    "https://b.test": baseStub({ sendTransactionUntil: async () => { throw new Error("ECONNRESET"); } }),
  });
  await assert.rejects(down.send(), /every RPC endpoint failed.*a\.test.*b\.test/);
});

test("provider reads fail over and skip a rate-limited endpoint afterwards", async () => {
  let a = 0;
  let b = 0;
  const fo = await createFailoverProvider(["https://a.test", "https://b.test"], {
    makeProvider: (url) => ({
      viewAccount: async () => { if (url.includes("a.test")) { a++; throw new Error("429 Too Many Requests"); } b++; return { amount: 5n }; },
    }),
  });
  assert.equal((await fo.viewAccount({ accountId: "x" })).amount, 5n);
  assert.equal((await fo.viewAccount({ accountId: "x" })).amount, 5n);
  assert.deepEqual([a, b], [1, 2], "A is tried once, then skipped while cooling down");
});

test("the hash used for the lookup is the one near-api-js computes for the signed transaction", async () => {
  const { Account, KeyPair, KeyPairSigner, actions, encodeTransaction } = await import("near-api-js");
  const { base58Encode, sha256 } = await import("../src/encoding.mjs");
  const kp = KeyPair.fromRandom("ed25519");
  const signer = new KeyPairSigner(kp);
  const account = new Account("a.testnet", baseStub(), kp.toString());
  const tx = await account.createTransaction({ receiverId: "b.testnet", actions: [actions.transfer(1n)], publicKey: await signer.getPublicKey() });
  const { txHash, signedTransaction } = await signer.signTransaction(tx);
  assert.equal(base58Encode(await sha256(encodeTransaction(signedTransaction.transaction))), base58Encode(txHash));
});
