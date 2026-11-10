import { test } from "node:test";
import assert from "node:assert/strict";
import { autoId, fastdataCollection, keyOf, FASTDATA_GAS, FASTDATA_METHOD, toDoc } from "../src/fastdata.mjs";
import { connect } from "../src/index.mjs";
import { checkDelegate, memoryStore, relay, RelayError } from "../src/relay-core.mjs";
import { decodeSignedDelegate } from "../src/encoding.mjs";
import { fakeFetch, memberKey, mkDelegate, SITE, MEMBER } from "./helpers.mjs";

const KV = "https://kv.test.fastnear.com";
const entry = (id, over = {}) => ({
  receipt_id: "r", tx_hash: "TX", predecessor_id: MEMBER, current_account_id: SITE, block_height: 100, block_timestamp: 1794345089221990211,
  key: `quay/guestbook/${id}`, value: { data: { text: id }, at: 1794345088610 }, ...over,
});

function kvFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? "GET", body });
    const r = await handler(url, body, init);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  };
  f.calls = calls;
  return f;
}

test("keys and automatic ids: quay/<collection>/<id>, newest sorts first, ids are url safe", () => {
  assert.equal(keyOf("guestbook", "a1"), "quay/guestbook/a1");
  const older = autoId(1_700_000_000_000, new Uint8Array([1, 2, 3]));
  const newer = autoId(1_700_000_005_000, new Uint8Array([1, 2, 3]));
  assert.ok(newer < older, "a later write sorts first in key order");
  assert.match(older, /^[0-9a-z]{15}$/);
});

test("add writes { data, at } under quay/<collection>/<id> with an empty deposit and returns the id", async () => {
  const sent = [];
  const col = fastdataCollection("guestbook", { site: SITE, fetch: kvFetch(() => ({ body: {} })), now: () => 1234, write: async (a) => sent.push(a) });
  const id = await col.add({ text: "hi" }, { id: "mine" });
  assert.equal(id, "mine");
  assert.deepEqual(sent[0], { "quay/guestbook/mine": { data: { text: "hi" }, at: 1234 } });
  const auto = await col.add({ text: "auto" });
  assert.equal(Object.keys(sent[1])[0], `quay/guestbook/${auto}`);
  await col.update("mine", { text: "edited" });
  assert.equal(sent[2]["quay/guestbook/mine"].data.text, "edited");
  await col.remove("mine");
  assert.deepEqual(sent[3], { "quay/guestbook/mine": null }, "a tombstone");
});

test("input checks: names, ids, and docs must be objects", async () => {
  const mk = (n) => fastdataCollection(n, { site: SITE, fetch: kvFetch(() => ({ body: {} })), write: async () => {} });
  assert.throws(() => mk("Bad Name"), /collection name/);
  assert.throws(() => mk(""), /collection name/);
  const col = mk("guestbook");
  for (const id of ["", "a/b", "a b", "x".repeat(65)]) await assert.rejects(async () => col.add({ a: 1 }, { id }), (e) => e.code === "bad_id", id);
  for (const d of [null, [], "text", 5]) await assert.rejects(col.add(d), (e) => e.code === "bad_doc");
  assert.equal(await col.add({ a: 1 }, { id: "12" }), "12", "digit ids are fine here: there are no automatic sequence ids");
});

test("list reads /v0/latest/<site> with the collection prefix and returns the DocPage shape", async () => {
  const f = kvFetch(() => ({ body: { entries: [entry("a"), entry("b", { predecessor_id: "bob.board.testnet", block_timestamp: 1700000000000 })], page_token: "TOK" } }));
  const col = fastdataCollection("guestbook", { site: SITE, fetch: f, write: async () => {} });
  const page = await col.list({ limit: 2 });
  assert.equal(f.calls[0].url, `${KV}/v0/latest/${SITE}`);
  assert.deepEqual(f.calls[0].body, { key_prefix: "quay/guestbook/", include_metadata: true, limit: 2 });
  assert.equal(page.next, "TOK");
  assert.equal(page.docs[0].id, "a");
  assert.equal(page.docs[0].owner, MEMBER, "owner is the predecessor");
  assert.deepEqual(page.docs[0].data, { text: "a" });
  assert.equal(page.docs[0].created, String(BigInt(1794345089221990211)), "JSON numbers keep about 16 digits, so nanoseconds are approximate");
  assert.equal(page.docs[1].created, "1700000000000000000", "millisecond stamps are widened to nanoseconds");
  assert.equal(page.docs[0].backend, "fastdata");
  assert.equal(page.docs[0].hidden, false);
});

test("list skips tombstones and foreign prefixes, passes the cursor, owner and prefix filters, clamps limit", async () => {
  const f = kvFetch(() => ({ body: { entries: [entry("a"), entry("gone", { value: null }), entry("x", { key: "quay/other/x" })] } }));
  const col = fastdataCollection("guestbook", { site: SITE, fetch: f, write: async () => {} });
  const page = await col.list({ from: "CUR", owner: MEMBER, prefix: "p-", limit: 999 });
  assert.deepEqual(page.docs.map((d) => d.id), ["a"]);
  assert.equal(page.next, null);
  assert.equal(f.calls[0].url, `${KV}/v0/latest/${SITE}/${MEMBER}`);
  assert.deepEqual(f.calls[0].body, { key_prefix: "quay/guestbook/p-", include_metadata: true, limit: 200, page_token: "CUR" });
});

test("list order asc reads every page and flips them", async () => {
  let n = 0;
  const f = kvFetch(() => ({ body: n++ === 0 ? { entries: [entry("a"), entry("b")], page_token: "T2" } : { entries: [entry("c")] } }));
  const col = fastdataCollection("guestbook", { site: SITE, fetch: f, write: async () => {} });
  const page = await col.list({ order: "asc", limit: 10 });
  assert.deepEqual(page.docs.map((d) => d.id), ["c", "b", "a"]);
  assert.equal(f.calls[1].body.page_token, "T2");
});

test("get with an owner uses the exact-key GET; without one the earliest write wins and tombstones are null", async () => {
  const f = kvFetch((url) => {
    if (url.includes(`/${MEMBER}/quay/`)) return { body: { entries: [entry("a")] } };
    return { body: { entries: [entry("a", { predecessor_id: "late.board.testnet", block_height: 300 }), entry("a", { block_height: 200 }), entry("ab", { block_height: 1 })] } };
  });
  const col = fastdataCollection("guestbook", { site: SITE, fetch: f, write: async () => {} });
  assert.equal((await col.get("a", { owner: MEMBER })).owner, MEMBER);
  assert.equal(f.calls[0].url, `${KV}/v0/latest/${SITE}/${MEMBER}/quay/guestbook/a`);
  assert.equal((await col.get("a")).owner, MEMBER, "block 200 beats block 300; the longer id ab is not a match");
  const none = fastdataCollection("guestbook", { site: SITE, fetch: kvFetch(() => ({ body: { entries: [entry("a", { value: null })] } })), write: async () => {} });
  assert.equal(await none.get("a"), null);
  const missing = fastdataCollection("guestbook", { site: SITE, fetch: kvFetch(() => ({ status: 404, body: {} })), write: async () => {} });
  assert.equal(await missing.get("a", { owner: MEMBER }), null);
});

test("read errors name FastData", async () => {
  const col = fastdataCollection("guestbook", { site: SITE, fetch: kvFetch(() => ({ status: 500, body: { error: "boom" } })), write: async () => {} });
  await assert.rejects(col.list(), (e) => e.code === "fastdata_read_failed" && /FastData read failed: boom/.test(e.message));
});

test("toDoc handles a bare value", () => {
  const d = toDoc("guestbook", entry("z", { value: "plain" }));
  assert.equal(d.data, "plain");
  assert.equal(d.id, "z");
});

// ---------- through connect() ----------
function stubWallet(outcomeFor) {
  const sent = [];
  class NearConnector {
    on() {}
    async connect() {}
    async wallet() {
      return {
        signMessage: async () => ({ accountId: "alice.testnet", publicKey: "ed25519:11111111111111111111111111111111", signature: "AAAA" }),
        signAndSendTransaction: async (tx) => (sent.push(tx), outcomeFor(tx)),
      };
    }
  }
  return { module: { NearConnector }, sent };
}
const failedOutcome = (kind) => ({ transaction: { hash: "TX" }, status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { index: 0, kind } } } } }] });

test("connect: a fastdata collection sends __fastdata_kv to the site with 0 deposit and tolerates the by-design failure", async () => {
  for (const kind of [{ FunctionCallError: { MethodResolveError: "MethodNotFound" } }, { AccountDoesNotExist: { account_id: SITE } }, { FunctionCallError: { ExecutionError: "Exceeded the prepaid gas." } }]) {
    const w = stubWallet(() => failedOutcome(kind));
    const quay = connect({ site: SITE, fetch: kvFetch(() => ({ body: {} })), storage: memStore(), wallet: w.module });
    await quay.auth.signIn({ mode: "wallet" });
    const id = await quay.db.collection("guestbook", { backend: "fastdata" }).add({ text: "hi" });
    const tx = w.sent[0];
    assert.equal(tx.receiverId, SITE);
    const p = tx.actions[0].params;
    assert.equal(p.methodName, FASTDATA_METHOD);
    assert.equal(p.deposit, "0");
    assert.equal(p.gas, String(FASTDATA_GAS));
    assert.deepEqual(Object.keys(p.args), [`quay/guestbook/${id}`]);
  }
});

test("connect: any other failure of a fastdata write is still an error", async () => {
  const w = stubWallet(() => failedOutcome({ FunctionCallError: { ExecutionError: "Smart contract panicked: no" } }));
  const quay = connect({ site: SITE, fetch: kvFetch(() => ({ body: {} })), storage: memStore(), wallet: w.module });
  await quay.auth.signIn({ mode: "wallet" });
  await assert.rejects(quay.db.collection("guestbook", { backend: "fastdata" }).add({ a: 1 }), (e) => e.code === "call_failed");
});

test("connect: reads, remove and an unknown backend", async () => {
  const w = stubWallet(() => failedOutcome({ FunctionCallError: { MethodResolveError: "MethodNotFound" } }));
  const f = kvFetch(() => ({ body: { entries: [entry("a")] } }));
  const quay = connect({ site: SITE, fetch: f, storage: memStore(), wallet: w.module, fastdata: { kv: "https://kv.example/" } });
  const col = quay.db.collection("guestbook", { backend: "fastdata" });
  assert.equal(col.backend, "fastdata");
  assert.equal((await col.list()).docs[0].id, "a");
  assert.equal(f.calls[0].url, `https://kv.example/v0/latest/${SITE}`);
  await quay.auth.signIn({ mode: "wallet" });
  await col.remove("a");
  assert.deepEqual(w.sent[0].actions[0].params.args, { "quay/guestbook/a": null });
  assert.throws(() => quay.db.collection("x", { backend: "mongo" }), /unknown backend/);
});

function memStore() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}

// ---------- relay policy ----------
const NOW = { ms: Date.parse("2026-11-12T00:00:00Z"), height: 1000n };
const fd = (args, over = {}) => ({ actions: [{ methodName: FASTDATA_METHOD, args, gas: FASTDATA_GAS, deposit: 0n }], maxBlockHeight: 1100n, ...over });
const policy = (o = {}) => ({ site: SITE, store: memoryStore(), ...o });

test("relay policy: __fastdata_kv is refused unless the site opts in", async () => {
  const k = await memberKey();
  const m = await mkDelegate(k, fd({ "quay/guestbook/a": { data: {}, at: 1 } }));
  assert.equal((await checkDelegate(m.b64, policy(), NOW)).code, "method_not_allowed");
  assert.equal((await checkDelegate(m.b64, policy({ fastdata: true }), NOW)).ok, true);
});

test("relay policy: fastdata args must be a small object of quay/ keys; other rules still apply", async () => {
  const k = await memberKey();
  const check = async (args, over, p = policy({ fastdata: true })) => checkDelegate((await mkDelegate(k, fd(args, over))).b64, p, NOW);
  assert.equal((await check({ "other/key": 1 })).code, "bad_fastdata_args");
  assert.equal((await check({})).code, "bad_fastdata_args");
  assert.equal((await check([1])).code, "bad_fastdata_args");
  assert.equal((await check(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`quay/c/${i}`, 1])))).code, "bad_fastdata_args");
  assert.equal((await check(Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`quay/c/${i}`, 1])))).ok, true);
  assert.equal((await check({ "quay/c/a": 1 }, { actions: [{ methodName: FASTDATA_METHOD, args: { "quay/c/a": 1 }, gas: FASTDATA_GAS, deposit: 1n }] })).code, "deposit_not_allowed");
  assert.equal((await check({ "quay/c/a": 1 }, { receiverId: "evil.testnet" })).code, "receiver_not_allowed");
  assert.equal((await check({ "quay/c/a": 1 }, { actions: [{ methodName: "set_collection", args: {}, gas: 1n, deposit: 0n }] })).code, "method_not_allowed");
  const m = await mkDelegate(k, { ...fd({ "quay/c/a": 1 }), actions: [{ methodName: FASTDATA_METHOD, args: new TextEncoder().encode("nope"), gas: FASTDATA_GAS, deposit: 0n }] });
  assert.equal((await checkDelegate(m.b64, policy({ fastdata: true }), NOW)).code, "bad_fastdata_args");
});

test("relay(): only a FastData-only delegate may fail by design", async () => {
  const k = await memberKey();
  const byDesign = { ActionError: { index: 0, kind: { FunctionCallError: { MethodResolveError: "MethodNotFound" } } } };
  const account = (f) => ({ relayMetaTransaction: async () => ({ transaction: { hash: "H" }, status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: f } } }] }) });
  const fdBytes = (await mkDelegate(k, fd({ "quay/c/a": 1 }))).bytes;
  assert.equal((await relay(fdBytes, { account: account(byDesign) })).hash, "H");
  await assert.rejects(relay(fdBytes, { account: account({ ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked" } } } }) }), RelayError);
  const plain = (await mkDelegate(k)).bytes;
  await assert.rejects(relay(plain, { account: account(byDesign) }), (e) => e.code === "inner_failure", "db_add must not fail with MethodNotFound");
  assert.equal(decodeSignedDelegate(fdBytes).delegate.actions[0].methodName, FASTDATA_METHOD);
});

test("the member relayed path: a fastdata add becomes a delegate to the site that the opt-in relay accepts", async () => {
  const relayed = [];
  const fetch = fakeFetch({
    rpc: {
      query: (p) => (p.request_type === "view_access_key" ? { permission: "FullAccess", nonce: 41 } : { result: [] }),
      block: () => ({ header: { height: 5000 } }),
      EXPERIMENTAL_tx_status: () => ({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { MethodResolveError: "MethodNotFound" } } } } } } }] }),
    },
    routes: {
      "POST /join": (b) => ({ account: `${b.name}.${SITE}`, hash: "J" }),
      "POST /relay": (b) => (relayed.push(b.signed_delegate), { hash: "R1" }),
    },
  });
  const quay = connect({ site: SITE, fetch, storage: memStore(), relay: "https://relay.example" });
  await quay.auth.signIn({ mode: "member", name: "alice" });
  const id = await quay.db.collection("guestbook", { backend: "fastdata" }).add({ text: "hello" });
  const v = await checkDelegate(relayed[0], policy({ fastdata: true }), { ms: Date.now(), height: 5000 });
  assert.equal(v.ok, true, v.reason);
  const dec = decodeSignedDelegate(Buffer.from(relayed[0], "base64"));
  assert.equal(dec.delegate.receiverId, SITE);
  assert.equal(dec.delegate.actions[0].deposit, 0n);
  assert.equal(dec.delegate.actions[0].gas, FASTDATA_GAS);
  assert.ok(`quay/guestbook/${id}` in JSON.parse(new TextDecoder().decode(dec.delegate.actions[0].args)));
});
