import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelayServer, defaultOrigins, originAllowed } from "../src/relay-server.mjs";
import { RelayError } from "../src/relay-core.mjs";
import { memberKey, mkDelegate, SITE, MEMBER } from "./helpers.mjs";

const T = 10n ** 12n;

function stubChain(over = {}) {
  const calls = { relay: [], join: [] };
  return {
    calls,
    height: async () => 1000n,
    balance: async () => (10n ** 24n).toString(),
    join: async (name, pk) => (calls.join.push([name, pk]), { hash: `J-${name}` }),
    relay: async (bytes) => (calls.relay.push(bytes), { hash: "R1" }),
    ...over,
  };
}

async function start(over = {}) {
  const chain = over.chain ?? stubChain();
  const logs = [];
  const r = createRelayServer({ site: SITE, relayer: `relay.${SITE}`, chain, log: (l) => logs.push(l), ...over, chain });
  const url = await r.listen(0);
  return { r, url, chain, logs, close: () => r.close() };
}
const post = (url, path, body, headers = {}) =>
  fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("health reports site, relayer, balance and policy", async () => {
  const s = await start();
  const res = await fetch(`${s.url}/health`);
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.site, SITE);
  assert.equal(j.relayer, `relay.${SITE}`);
  assert.equal(j.balance, (10n ** 24n).toString());
  assert.equal(j.balance_near, "1.0000");
  assert.equal(j.ok, true);
  assert.deepEqual(j.policy.methods, ["db_add", "db_update", "db_remove", "fn_call"]);
  assert.equal(j.policy.max_gas, String(300n * T));
  assert.equal(j.policy.deposit, "0");
  await s.close();
});

test("relay accepts a valid delegate, sends it once, logs hash and sender only", async () => {
  const s = await start();
  const k = await memberKey();
  const m = await mkDelegate(k, { maxBlockHeight: 1100n });
  const res = await post(s.url, "/relay", { signed_delegate: m.b64 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { hash: "R1" });
  assert.equal(s.chain.calls.relay.length, 1);
  assert.deepEqual(Buffer.from(s.chain.calls.relay[0]), Buffer.from(m.bytes));
  const line = s.logs.join("\n");
  assert.match(line, new RegExp(`relay R1 ${MEMBER} ${SITE}`));
  assert.ok(!line.includes(k.secretKey));
  assert.ok(!line.includes(m.b64));
  await s.close();
});

test("relay refusals name the rule and send nothing", async () => {
  const s = await start();
  const k = await memberKey();
  const cases = [
    [{ actions: [{ methodName: "db_add", args: {}, gas: T, deposit: 1n }], maxBlockHeight: 1100n }, 422, "deposit_not_allowed"],
    [{ actions: [{ methodName: "set_collection", args: {}, gas: T, deposit: 0n }], maxBlockHeight: 1100n }, 422, "method_not_allowed"],
    [{ receiverId: "evil.testnet", maxBlockHeight: 1100n }, 422, "receiver_not_allowed"],
    [{ maxBlockHeight: 900n }, 422, "expired"],
    [{ maxBlockHeight: 5000n }, 422, "expiry_too_far"],
    [{ actions: [{ methodName: "db_add", args: {}, gas: 301n * T, deposit: 0n }], maxBlockHeight: 1100n }, 422, "gas_too_high"],
  ];
  for (const [over, status, code] of cases) {
    const m = await mkDelegate(k, over);
    const res = await post(s.url, "/relay", { signed_delegate: m.b64 });
    const j = await res.json();
    assert.equal(res.status, status);
    assert.equal(j.error, code);
    assert.ok(j.reason);
  }
  assert.equal(s.chain.calls.relay.length, 0);
  await s.close();
});

test("relay accepts fn_call and 300 Tgas by default", async () => {
  const s = await start();
  const k = await memberKey();
  const m = await mkDelegate(k, { maxBlockHeight: 1100n, actions: [{ methodName: "fn_call", args: {}, gas: 300n * T, deposit: 0n }] });
  assert.equal((await post(s.url, "/relay", { signed_delegate: m.b64 })).status, 200);
  await s.close();
});

test("per-account limit gives 429 and only successful relays count", async () => {
  const s = await start({ policy: { perAccountPerHour: 2 } });
  const k = await memberKey();
  const ok = async (n) => post(s.url, "/relay", { signed_delegate: (await mkDelegate(k, { nonce: BigInt(n), maxBlockHeight: 1100n })).b64 });
  assert.equal((await ok(1)).status, 200);
  assert.equal((await ok(2)).status, 200);
  const third = await ok(3);
  assert.equal(third.status, 429);
  assert.equal((await third.json()).error, "account_rate_limit");
  await s.close();
});

test("a chain failure is a 502 with the inner reason and still spends budget (the relayer paid gas)", async () => {
  let n = 0;
  const chain = stubChain({ relay: async () => { if (n++ === 0) throw new RelayError("relayed call failed: storage pool is empty", { code: "inner_failure" }); return { hash: "R2" }; } });
  const s = await start({ chain, policy: { perAccountPerHour: 1 } });
  const k = await memberKey();
  const m = async (nonce) => (await mkDelegate(k, { nonce, maxBlockHeight: 1100n })).b64;
  const bad = await post(s.url, "/relay", { signed_delegate: await m(1n) });
  assert.equal(bad.status, 502);
  const j = await bad.json();
  assert.equal(j.error, "inner_failure");
  assert.match(j.reason, /storage pool is empty/);
  // a failed relay still cost the relayer gas, so it counts: otherwise delegates that
  // fail on chain could be sent without limit
  assert.equal((await post(s.url, "/relay", { signed_delegate: await m(2n) })).status, 429, "the failed relay was charged");
  await s.close();
});

test("relays are sent one at a time", async () => {
  let active = 0;
  let peak = 0;
  const chain = stubChain({ relay: async () => { peak = Math.max(peak, ++active); await new Promise((r) => setTimeout(r, 15)); active--; return { hash: "R" }; } });
  const s = await start({ chain });
  const k = await memberKey();
  const reqs = await Promise.all([1n, 2n, 3n].map(async (nonce) => post(s.url, "/relay", { signed_delegate: (await mkDelegate(k, { nonce, maxBlockHeight: 1100n })).b64 })));
  assert.deepEqual(reqs.map((r) => r.status), [200, 200, 200]);
  assert.equal(peak, 1);
  await s.close();
});

test("a nearly empty relayer refuses with 503", async () => {
  const s = await start({ chain: stubChain({ balance: async () => "1000" }) });
  const k = await memberKey();
  const res = await post(s.url, "/relay", { signed_delegate: (await mkDelegate(k, { maxBlockHeight: 1100n })).b64 });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "relayer_empty");
  assert.equal((await post(s.url, "/join", { name: "alice", public_key: k.pub })).status, 503);
  const h = await (await fetch(`${s.url}/health`)).json();
  assert.equal(h.ok, false);
  await s.close();
});

test("bad bodies: json, missing field, size", async () => {
  const s = await start();
  assert.equal((await (await post(s.url, "/relay", "not json")).json()).error, "bad_json");
  assert.equal((await (await post(s.url, "/relay", "[1]")).json()).error, "bad_json");
  assert.equal((await (await post(s.url, "/relay", {})).json()).error, "malformed");
  assert.equal((await (await post(s.url, "/relay", { signed_delegate: "%%%" })).json()).error, "malformed");
  const big = await post(s.url, "/relay", { signed_delegate: "A".repeat(70_000) });
  assert.equal(big.status, 413);
  await s.close();
});

test("join calls the contract from the relayer and returns the account", async () => {
  const s = await start();
  const k = await memberKey();
  const res = await post(s.url, "/join", { name: "alice", public_key: k.pub });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { account: MEMBER, hash: "J-alice" });
  assert.deepEqual(s.chain.calls.join[0], ["alice", k.pub]);
  assert.match(s.logs.join("\n"), /join J-alice alice\.board\.testnet/);
  await s.close();
});

test("join validates name and key before touching the chain", async () => {
  const s = await start();
  const k = await memberKey();
  for (const [body, code] of [
    [{ name: "a", public_key: k.pub }, "bad_name"],
    [{ name: "Alice", public_key: k.pub }, "bad_name"],
    [{ name: "x".repeat(33), public_key: k.pub }, "bad_name"],
    [{ name: "alice.bob", public_key: k.pub }, "bad_name"],
    [{ name: "relay", public_key: k.pub }, "reserved_name"],
    [{ name: "admin", public_key: k.pub }, "reserved_name"],
    [{ name: "alice", public_key: "secp256k1:abc" }, "bad_public_key"],
    [{ name: "alice", public_key: "ed25519:short" }, "bad_public_key"],
    [{ name: "alice" }, "bad_public_key"],
  ]) {
    const res = await post(s.url, "/join", body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, code);
  }
  assert.equal(s.chain.calls.join.length, 0);
  await s.close();
});

test("join is rate limited per client address and per day", async () => {
  const s = await start({ joinPerIpPerDay: 2, joinsPerDay: 3 });
  const k = await memberKey();
  const join = (name, ip) => post(s.url, "/join", { name, public_key: k.pub }, ip ? { "x-forwarded-for": ip } : {});
  assert.equal((await join("aa1")).status, 200);
  assert.equal((await join("aa2")).status, 200);
  const limited = await join("aa3");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "join_rate_limit");
  await s.close();

  const t = await start({ joinPerIpPerDay: 10, joinsPerDay: 2, trustProxy: true });
  assert.equal((await post(t.url, "/join", { name: "bb1", public_key: k.pub }, { "x-forwarded-for": "1.1.1.1" })).status, 200);
  assert.equal((await post(t.url, "/join", { name: "bb2", public_key: k.pub }, { "x-forwarded-for": "2.2.2.2" })).status, 200);
  const day = await post(t.url, "/join", { name: "bb3", public_key: k.pub }, { "x-forwarded-for": "3.3.3.3" });
  assert.equal((await day.json()).error, "join_daily_limit");
  await t.close();
});

test("a taken name is a 409; other chain failures are 502", async () => {
  const k = await memberKey();
  let msg = "join failed: Smart contract panicked: name already taken";
  const s = await start({ chain: stubChain({ join: async () => { throw new Error(msg); } }) });
  const a = await post(s.url, "/join", { name: "alice", public_key: k.pub });
  assert.equal(a.status, 409);
  assert.equal((await a.json()).error, "name_taken");
  msg = "join failed: members are closed";
  const b = await post(s.url, "/join", { name: "alice", public_key: k.pub });
  assert.equal(b.status, 502);
  assert.equal((await b.json()).error, "join_failed");
  await s.close();
});

test("CORS: site origin, localhost with any port, preflight, and refusal of others", async () => {
  const s = await start();
  for (const origin of [`https://${SITE}.page`, "http://127.0.0.1:5173", "http://localhost:3000"]) {
    const res = await fetch(`${s.url}/health`, { headers: { origin } });
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.equal(res.headers.get("vary"), "Origin");
    const pre = await fetch(`${s.url}/relay`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), origin);
    assert.match(pre.headers.get("access-control-allow-headers"), /content-type/);
  }
  const evil = await fetch(`${s.url}/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  assert.equal((await evil.json()).error, "origin_not_allowed");
  const none = await fetch(`${s.url}/health`);
  assert.equal(none.status, 200, "non-browser clients send no Origin");
  await s.close();
});

test("origin patterns and defaults", () => {
  assert.deepEqual(defaultOrigins("board.testnet"), ["https://board.testnet.page", "http://127.0.0.1:*", "http://localhost:*"]);
  assert.equal(originAllowed("http://127.0.0.1:8080", ["http://127.0.0.1:*"]), true);
  assert.equal(originAllowed("http://127.0.0.1", ["http://127.0.0.1:*"]), false);
  assert.equal(originAllowed("http://127.0.0.1:80.evil.com", ["http://127.0.0.1:*"]), false);
  assert.equal(originAllowed("https://x.example", ["https://x.example"]), true);
  assert.equal(originAllowed("https://y.example", ["*"]), true);
});

test("custom origins replace the defaults", async () => {
  const s = await start({ origins: ["https://app.example"] });
  assert.equal((await fetch(`${s.url}/health`, { headers: { origin: "http://localhost:1" } })).status, 403);
  assert.equal((await fetch(`${s.url}/health`, { headers: { origin: "https://app.example" } })).status, 200);
  await s.close();
});

test("unknown paths and wrong methods", async () => {
  const s = await start();
  assert.equal((await fetch(`${s.url}/nope`)).status, 404);
  assert.equal((await fetch(`${s.url}/relay`)).status, 405);
  await s.close();
});

test("createRelayServer needs its parts", () => {
  assert.throws(() => createRelayServer({ site: SITE }), /needs/);
});

test("the sender's key and nonce are checked on chain before anything is sent", async () => {
  const keys = new Map();
  const chain = stubChain({ accessKey: async (account, pk) => keys.get(`${account} ${pk}`) ?? null });
  const s = await start({ chain });
  const k = await memberKey();
  const m = await mkDelegate(k, { nonce: 5n, maxBlockHeight: 1100n });
  const unknown = await post(s.url, "/relay", { signed_delegate: m.b64 });
  assert.equal(unknown.status, 422);
  assert.equal((await unknown.json()).error, "unknown_key");
  keys.set(`${MEMBER} ${k.pub}`, { nonce: 5, permission: "FullAccess" });
  const replay = await post(s.url, "/relay", { signed_delegate: m.b64 });
  assert.equal((await replay.json()).error, "nonce_used");
  assert.equal(chain.calls.relay.length, 0);
  keys.set(`${MEMBER} ${k.pub}`, { nonce: 4, permission: "FullAccess" });
  assert.equal((await post(s.url, "/relay", { signed_delegate: m.b64 })).status, 200);
  await s.close();
});

test("parallel relays cannot pass the per-account limit together", async () => {
  let sent = 0;
  const chain = stubChain({ relay: async () => (sent++, await new Promise((r) => setTimeout(r, 10)), { hash: "R" }) });
  const s = await start({ chain, policy: { perAccountPerHour: 1 } });
  const k = await memberKey();
  const reqs = await Promise.all([1n, 2n, 3n, 4n].map(async (nonce) => post(s.url, "/relay", { signed_delegate: (await mkDelegate(k, { nonce, maxBlockHeight: 1100n })).b64 })));
  await s.close();
  assert.deepEqual(reqs.map((r) => r.status).sort(), [200, 429, 429, 429]);
  assert.equal(sent, 1);
});

test("trustProxy uses the address the proxy appended, not one the client wrote", async () => {
  // A proxy appends the peer to X-Forwarded-For; the client controls everything before it.
  const s = await start({ joinPerIpPerDay: 1, joinsPerDay: 100, trustProxy: true });
  const k = await memberKey();
  const first = await post(s.url, "/join", { name: "cc1", public_key: k.pub }, { "x-forwarded-for": "1.1.1.1, 5.5.5.5" });
  assert.equal(first.status, 200);
  const spoofed = await post(s.url, "/join", { name: "cc2", public_key: k.pub }, { "x-forwarded-for": "2.2.2.2, 5.5.5.5" });
  assert.equal(spoofed.status, 429);
  assert.equal((await spoofed.json()).error, "join_rate_limit");
  await s.close();
});
