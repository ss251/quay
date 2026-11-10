import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, QuayError } from "../src/index.mjs";
import { verifySignIn } from "../src/verify.mjs";
import { decodeSignedDelegate, base58Encode, verifySignedDelegate } from "../src/encoding.mjs";
import { checkDelegate, memoryStore } from "../src/relay-core.mjs";
import { fakeFetch, viewResult, SITE } from "./helpers.mjs";

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), m }; };
const DOC = { collection: "posts", id: "1", seq: "1", owner: "a.board.testnet", data: { t: "x" } };

function readRpc(handlers = {}) {
  return {
    query: (p) => {
      assert.equal(p.request_type, "call_function");
      assert.equal(p.account_id, SITE);
      const args = JSON.parse(atob(p.args_base64));
      const h = handlers[p.method_name];
      assert.ok(h, `no stub for ${p.method_name}`);
      return viewResult(h(args));
    },
  };
}

test("reads call db_list / db_get with the documented arguments", async () => {
  const seen = [];
  const fetch = fakeFetch({ rpc: readRpc({
    db_list: (a) => (seen.push(["list", a]), { docs: [DOC], next: null }),
    db_get: (a) => (seen.push(["get", a]), a.id === "1" ? DOC : null),
    list_members: (a) => (seen.push(["members", a]), { members: [], next: null }),
  }) });
  const quay = connect({ site: SITE, fetch, storage: mem() });
  const page = await quay.db.collection("posts").list({ limit: 20, order: "desc" });
  assert.equal(page.docs[0].id, "1");
  assert.deepEqual(await quay.db.collection("posts").get(1), DOC);
  assert.equal(await quay.db.collection("posts").get("zzz"), null);
  await quay.members.list({ limit: 5 });
  assert.deepEqual(seen[0], ["list", { collection: "posts", query: { limit: 20, order: "desc" } }]);
  assert.deepEqual(seen[1], ["get", { collection: "posts", id: "1" }]);
  assert.deepEqual(seen[3], ["members", { from_index: 0, limit: 5 }]);
  assert.equal(fetch.calls[0].url, "https://test.rpc.fastnear.com");
});

test("view errors surface", async () => {
  const fetch = fakeFetch({ rpc: { query: () => ({ error: "wasm execution failed", logs: [] }) } });
  await assert.rejects(connect({ site: SITE, fetch }).db.collection("posts").list(), /wasm execution failed/);
});

test("writes need a sign-in", async () => {
  const quay = connect({ site: SITE, fetch: fakeFetch(), storage: mem() });
  await assert.rejects(quay.db.collection("posts").add({ a: 1 }), (e) => e.code === "not_signed_in");
});

test("functions.call is not configured", async () => {
  const quay = connect({ site: SITE, fetch: fakeFetch(), storage: mem() });
  await assert.rejects(quay.functions.call("preview", {}), (e) => e instanceof QuayError && e.code === "not_configured" && /not configured/.test(e.message));
});

// ---------- wallet ----------
function stubWallet({ accountId = "alice.testnet" } = {}) {
  const log = { sent: [], signed: [], opts: null };
  class NearConnector {
    constructor(o) { log.opts = o; }
    on() {}
    async connect() {}
    async disconnect() { log.disconnected = true; }
    async wallet() {
      return {
        async signMessage(p) { log.signed.push(p); return { accountId, publicKey: "ed25519:11111111111111111111111111111111", signature: "AAAA" }; },
        async signAndSendTransaction(tx) {
          log.sent.push(tx);
          return { transaction: { hash: "TX" }, status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { executor_id: SITE, status: { SuccessValue: btoa('"42"') } } }] };
        },
      };
    }
  }
  return { module: { NearConnector }, log };
}

test("wallet sign-in asks for testnet + signMessage wallets and signs a NEP-413 message", async () => {
  const w = stubWallet();
  const quay = connect({ site: SITE, fetch: fakeFetch(), storage: mem(), wallet: w.module, now: () => Date.parse("2026-11-10T00:00:00Z") });
  const proof = await quay.auth.signIn({ mode: "wallet" });
  assert.equal(w.log.opts.network, "testnet");
  assert.equal(w.log.opts.features.testnet, true);
  assert.equal(w.log.opts.features.signMessage, true);
  assert.equal(quay.auth.account, "alice.testnet");
  const s = w.log.signed[0];
  assert.equal(s.recipient, SITE);
  assert.equal(s.nonce.length, 32);
  assert.match(s.message, new RegExp(`${SITE}[\\s\\S]*Issued: 2026-11-10T00:00:00.000Z`));
  assert.equal(proof.recipient, SITE);
  assert.equal(proof.message, s.message);
});

test("wallet signature in ed25519:base58 form is normalized to base64", async () => {
  const w = stubWallet();
  const orig = w.module.NearConnector.prototype.wallet;
  w.module.NearConnector.prototype.wallet = async function () {
    const x = await orig.call(this);
    x.signMessage = async () => ({ accountId: "a.testnet", publicKey: "ed25519:11111111111111111111111111111111", signature: `ed25519:${base58Encode(new Uint8Array(64).fill(1))}` });
    return x;
  };
  const quay = connect({ site: SITE, fetch: fakeFetch(), storage: mem(), wallet: w.module });
  const proof = await quay.auth.signIn({ mode: "wallet" });
  assert.equal(Buffer.from(proof.signature, "base64").length, 64);
});

test("wallet writes: add returns the id from the outcome, deposit and gas are passed as strings", async () => {
  const w = stubWallet();
  const quay = connect({ site: SITE, fetch: fakeFetch(), storage: mem(), wallet: w.module });
  await quay.auth.signIn({ mode: "wallet" });
  const id = await quay.db.collection("posts").add({ title: "hi" }, { deposit: "1230000000000000000000" });
  assert.equal(id, "42");
  const tx = w.log.sent[0];
  assert.equal(tx.signerId, "alice.testnet");
  assert.equal(tx.receiverId, SITE);
  const p = tx.actions[0].params;
  assert.equal(p.methodName, "db_add");
  assert.deepEqual(p.args, { collection: "posts", data: '{"title":"hi"}' });
  assert.equal(p.deposit, "1230000000000000000000");
  assert.equal(typeof p.gas, "string");
  assert.equal(await quay.db.collection("posts").add({ a: 1 }, { id: "mine" }), "mine");
  assert.equal(w.log.sent[1].actions[0].params.args.id, "mine");
  await quay.db.collection("posts").update("1", { a: 2 });
  await quay.db.collection("posts").remove("1");
  assert.deepEqual(w.log.sent.slice(2).map((t) => t.actions[0].params.methodName), ["db_update", "db_remove"]);
});

test("wallet write surfaces an inner receipt failure", async () => {
  const w = stubWallet();
  const base = w.module.NearConnector.prototype.wallet;
  w.module.NearConnector.prototype.wallet = async function () {
    const x = await base.call(this);
    x.signAndSendTransaction = async () => ({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: "storage pool is empty" } } } }] });
    return x;
  };
  const quay = connect({ site: SITE, fetch: fakeFetch(), storage: mem(), wallet: w.module });
  await quay.auth.signIn({ mode: "wallet" });
  await assert.rejects(quay.db.collection("posts").add({ a: 1 }), (e) => e.code === "call_failed" && /storage pool is empty/.test(e.message));
});

test("signOut clears the account and disconnects the wallet", async () => {
  const w = stubWallet();
  const quay = connect({ site: SITE, fetch: fakeFetch(), storage: mem(), wallet: w.module });
  await quay.auth.signIn({ mode: "wallet" });
  await quay.auth.signOut();
  assert.equal(quay.auth.account, null);
  assert.equal(w.log.disconnected, true);
});

test("pay reads the product price and attaches it", async () => {
  const w = stubWallet();
  const fetch = fakeFetch({ rpc: readRpc({ get_product: (a) => (a.id === "pin" ? { price_yocto: "100000000000000000000000" } : null) }) });
  const quay = connect({ site: SITE, fetch, storage: mem(), wallet: w.module });
  await quay.auth.signIn({ mode: "wallet" });
  await quay.pay("pin", { ref: "posts/12" });
  const p = w.log.sent[0].actions[0].params;
  assert.deepEqual([p.methodName, p.deposit, p.args], ["pay", "100000000000000000000000", { product: "pin", ref: "posts/12" }]);
  await assert.rejects(quay.pay("nope"), /unknown product/);
});

// ---------- member ----------
function relayStub(site = SITE) {
  const state = { joined: [], relayed: [], keys: new Map(), height: 5000 };
  const routes = {
    "POST /join": (b) => {
      if (b.name === "taken") return { status: 409, body: { error: "name is taken" } };
      state.joined.push(b);
      state.keys.set(`${b.name}.${site}`, b.public_key);
      return { account: `${b.name}.${site}`, hash: "J" };
    },
    "POST /relay": (b) => { state.relayed.push(b.signed_delegate); return { hash: "R1" }; },
  };
  const rpc = {
    query: (p) => {
      if (p.request_type === "view_access_key") return { permission: "FullAccess", nonce: 41 };
      return viewResult(null);
    },
    block: () => ({ header: { height: state.height } }),
    EXPERIMENTAL_tx_status: (p) => {
      assert.equal(p.tx_hash, "R1");
      assert.equal(p.sender_account_id, `relay.${site}`);
      return { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { executor_id: site, status: { SuccessValue: btoa('"7"') } } }] };
    },
  };
  return { state, fetch: fakeFetch({ routes, rpc }) };
}

test("member sign-in joins through the relay, stores the key, and the proof verifies", async () => {
  const r = relayStub();
  const storage = mem();
  const quay = connect({ site: SITE, fetch: r.fetch, storage, relay: "https://relay.example/", now: () => Date.now() });
  const proof = await quay.auth.signIn({ mode: "member", name: "alice" });
  assert.equal(quay.auth.account, `alice.${SITE}`);
  assert.equal(r.state.joined.length, 1);
  assert.match(r.state.joined[0].public_key, /^ed25519:/);
  const saved = JSON.parse(storage.m.get(`quay:${SITE}:session`));
  assert.equal(saved.accountId, `alice.${SITE}`);
  assert.equal(saved.publicKey, r.state.joined[0].public_key);
  assert.equal(proof.publicKey, saved.publicKey);
  const verdict = await verifySignIn(proof, { site: SITE, fetch: r.fetch });
  assert.deepEqual([verdict.ok, verdict.accountId], [true, `alice.${SITE}`]);
  assert.ok(r.fetch.calls.some((c) => c.url === "https://relay.example/join"));
});

test("member sign-in picks a name when none is given, reuses the key on the next sign-in", async () => {
  const r = relayStub();
  const storage = mem();
  const q1 = connect({ site: SITE, fetch: r.fetch, storage, relay: "https://relay.example" });
  await q1.auth.signIn({ mode: "member" });
  const account = q1.auth.account;
  assert.match(account, new RegExp(`^u[0-9a-f]{8}\\.${SITE.replace(".", "\\.")}$`));
  const q2 = connect({ site: SITE, fetch: r.fetch, storage, relay: "https://relay.example" });
  assert.equal(q2.auth.account, account, "a reload resumes the member");
  await q2.auth.signOut();
  assert.equal(q2.auth.account, null);
  assert.equal(connect({ site: SITE, fetch: r.fetch, storage }).auth.account, null, "signed out stays signed out");
  await q2.auth.signIn({ mode: "member" });
  assert.equal(q2.auth.account, account);
  assert.equal(r.state.joined.length, 1, "no second join");
  await assert.rejects(q2.auth.signIn({ mode: "member", name: "someone-else" }), (e) => e.code === "session_exists");
  q2.auth.forget();
  assert.equal(storage.getItem(`quay:${SITE}:session`), null);
});

test("a refused join stores nothing and shows the relay reason", async () => {
  const r = relayStub();
  const storage = mem();
  const quay = connect({ site: SITE, fetch: r.fetch, storage, relay: "https://relay.example" });
  await assert.rejects(quay.auth.signIn({ mode: "member", name: "taken" }), /name is taken/);
  assert.equal(storage.getItem(`quay:${SITE}:session`), null);
  assert.equal(quay.auth.account, null);
});

test("member sign-in without a relay says so", async () => {
  const quay = connect({ site: SITE, fetch: relayStub().fetch, storage: mem() });
  await assert.rejects(quay.auth.signIn({ mode: "member", name: "alice" }), (e) => e.code === "no_relay");
});

test("member writes become delegates the relay core accepts", async () => {
  const r = relayStub();
  const quay = connect({ site: SITE, fetch: r.fetch, storage: mem(), relay: "https://relay.example" });
  await quay.auth.signIn({ mode: "member", name: "alice" });
  const id = await quay.db.collection("posts").add({ title: "hello" });
  assert.equal(id, "7", "id comes from the inner receipt");
  assert.equal(r.state.relayed.length, 1);
  const verdict = await checkDelegate(r.state.relayed[0], { site: SITE, store: memoryStore() }, { ms: Date.now(), height: 5000 });
  assert.equal(verdict.ok, true, verdict.reason);
  const dec = decodeSignedDelegate(Buffer.from(r.state.relayed[0], "base64"));
  assert.equal(dec.delegate.senderId, `alice.${SITE}`);
  assert.equal(dec.delegate.receiverId, SITE);
  assert.equal(dec.delegate.nonce, 42n, "access key nonce + 1");
  assert.equal(dec.delegate.maxBlockHeight, 5120n);
  assert.equal(dec.delegate.actions[0].methodName, "db_add");
  assert.equal(dec.delegate.actions[0].deposit, 0n);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(dec.delegate.actions[0].args)), { collection: "posts", data: '{"title":"hello"}' });
  assert.equal(await verifySignedDelegate(dec.delegate, dec.signature), true);
});

test("member writes with an explicit id skip the receipt lookup; update and remove relay too", async () => {
  const r = relayStub();
  const quay = connect({ site: SITE, fetch: r.fetch, storage: mem(), relay: "https://relay.example" });
  await quay.auth.signIn({ mode: "member", name: "alice" });
  assert.equal(await quay.db.collection("posts").add({ a: 1 }, { id: "mine" }), "mine");
  await quay.db.collection("posts").update("mine", { a: 2 });
  await quay.db.collection("posts").remove("mine");
  assert.deepEqual(r.state.relayed.length, 3);
});

test("a member write that attaches a deposit is refused with a clear error", async () => {
  const r = relayStub();
  const quay = connect({ site: SITE, fetch: r.fetch, storage: mem(), relay: "https://relay.example" });
  await quay.auth.signIn({ mode: "member", name: "alice" });
  await assert.rejects(quay.db.collection("posts").add({ a: 1 }, { deposit: 1n }), (e) => e.code === "deposit_needs_wallet" && /wallet/.test(e.message));
  await assert.rejects(quay.pay("pin", { ref: "posts/1", deposit: "5" }), (e) => e.code === "deposit_needs_wallet");
  assert.equal(r.state.relayed.length, 0);
});

test("a relay refusal reaches the caller with its reason", async () => {
  const fetch = fakeFetch({ rpc: { query: () => ({ permission: "FullAccess", nonce: 1 }), block: () => ({ header: { height: 1 } }) }, routes: {
    "POST /join": () => ({ account: `alice.${SITE}` }),
    "POST /relay": () => ({ status: 429, body: { error: "account_rate_limit" } }),
  } });
  const quay = connect({ site: SITE, fetch, storage: mem(), relay: "https://relay.example" });
  await quay.auth.signIn({ mode: "member", name: "alice" });
  await assert.rejects(quay.db.collection("posts").remove("1"), /account_rate_limit/);
});

test("an unknown mode is refused", async () => {
  await assert.rejects(connect({ site: SITE, fetch: fakeFetch(), storage: mem() }).auth.signIn({ mode: "x" }), /unknown sign-in mode/);
});

test("connect requires a site", () => {
  assert.throws(() => connect({}), /site/);
});
