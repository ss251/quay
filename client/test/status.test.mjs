import assert from "node:assert/strict";
import { test } from "node:test";
import { LAYERS, layerStatus, samplePath } from "../src/status.mjs";

const SITE = "board.testnet";
const NOW = Date.parse("2026-11-11T09:00:00Z");
const ns = (ms) => String(BigInt(ms) * 1_000_000n);
const yocto = (near) => String(BigInt(Math.round(near * 10000)) * 10n ** 20n);
const bytes = (v) => [...new TextEncoder().encode(JSON.stringify(v))];

const V3 = {
  get_status: { version: "3.0.0", production: "7", previous: "6", release_count: 7, stored_bytes: "52000", max_bytes: "2000000", chunk_bytes: "200000" },
  get_version: { version: "3.0.0", standard: "quay" },
  list_collections: [
    { name: "posts", write: "members", max_doc_bytes: 2000, moderated: true, payer: "site", max_docs_per_account: 50, on_add: null, count: "12", bytes: "3400", next_seq: "13" },
  ],
  get_pool: { balance: yocto(1), reserved: yocto(0.2) },
  fn_list: [{ name: "preview", project: "board.testnet/preview", call: "anyone", payer: "site" }],
  fn_results: { docs: [{ id: "preview-3", data: { name: "preview", ok: true } }, { id: "preview-2", data: { name: "preview", ok: true } }], next: null },
  get_release: { id: "7", files: [{ path: "index.html" }, { path: "templates/post.html" }], routes: [{ pattern: "/posts/:id", kind: "doc", collection: "posts", template: "templates/post.html" }] },
  cron_status: { armed: true, hops: 10, last_tick: ns(NOW - 3 * 60000), started: ns(NOW - 86400000) },
  cron_list: [{ name: "digest", every_minutes: 30, fn: "digest", input: "{}", last_run: null, next_due: null }],
};
const V2 = { get_status: { ...V3.get_status, version: "2.0.0" }, get_version: { version: "2.0.0", standard: "quay" } };
const KEYS = { keys: [{ public_key: "ed25519:aaa", access_key: { permission: "FullAccess" } }, { public_key: "ed25519:bbb", access_key: { permission: { FunctionCall: { method_names: ["put_chunk", "seal"] } } } }] };

/** A stub fetch: views is {method: value | fn}, accounts is {id: view_account}, hosts is {url: [status, body] | Error}. */
function stub({ views = V3, keys = KEYS, accounts = {}, hosts = {}, delay = {} } = {}) {
  const f = async (url, init = {}) => {
    if (init.body && JSON.parse(init.body).jsonrpc) {
      const p = JSON.parse(init.body).params;
      const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "quay", result }) });
      if (p.request_type === "view_access_key_list") return reply(keys);
      if (p.request_type === "view_account") {
        if (!accounts[p.account_id]) return { ok: true, status: 200, json: async () => ({ error: { name: "HANDLER_ERROR", data: `account ${p.account_id} does not exist while viewing` } }) };
        return reply(accounts[p.account_id]);
      }
      const method = p.method_name;
      if (delay[method]) await new Promise((r) => setTimeout(r, delay[method]));
      if (!(method in views)) return reply({ error: `wasm execution failed with error: MethodResolveError(MethodNotFound)`, logs: [] });
      const v = views[method];
      return reply({ result: bytes(typeof v === "function" ? v(JSON.parse(atob(p.args_base64))) : v), logs: [] });
    }
    const h = hosts[url];
    if (h instanceof Error) throw h;
    const [status, body] = h ?? [404, "not found"];
    return { ok: status < 400, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body };
  };
  return f;
}
const run = (fetch, extra = {}) => layerStatus({ site: SITE, rpc: "http://rpc.test", fetch, now: NOW, timeoutMs: 500, ...extra });
const PUB = `https://board.testnet.page/`;
const pubOk = { [PUB]: [200, "<html>"] };

test("a healthy v3 site reports eight layers", async () => {
  const s = await run(stub({ hosts: pubOk, accounts: { [`relay.${SITE}`]: { amount: yocto(2) } } }));
  assert.deepEqual(Object.keys(s.layers), LAYERS);
  assert.equal(s.measured_at, "2026-11-11T09:00:00Z");
  for (const [name, l] of Object.entries(s.layers)) {
    assert.deepEqual(Object.keys(l), ["state", "summary", "metrics", "links", "error"], name);
    assert.equal(l.state, "ok", `${name}: ${l.summary} ${l.error}`);
  }
  assert.equal(s.layers.site.summary, "Production is release 7 of 7");
  assert.equal(s.layers.data.metrics.docs, 12);
  assert.equal(s.layers.routes.metrics.doc, 1);
  assert.equal(s.layers.routes.links[0].href, `https://board.testnet.page/posts/1`);
  assert.equal(s.layers.cron.metrics.idle_minutes, 3);
  assert.equal(s.layers.keys.metrics.full_access, 1);
});

test("a v2 contract is off for the v3 layers and ok for site and keys", async () => {
  const s = await run(stub({ views: V2, hosts: pubOk }));
  for (const n of ["data", "functions", "routes", "relay", "cron"]) assert.equal(s.layers[n].state, "off", n);
  assert.match(s.layers.data.summary, /before v3/);
  assert.equal(s.layers.site.state, "ok");
  assert.equal(s.layers.keys.state, "ok");
});

test("site: no production is a warning; an unreachable RPC is down and hides nothing else", async () => {
  const noProd = { ...V3, get_status: { ...V3.get_status, production: null } };
  assert.equal((await run(stub({ views: noProd, hosts: pubOk }))).layers.site.state, "warn");
  const dead = async (url) => {
    if (url.startsWith("http://rpc")) throw new Error("connection refused");
    return { ok: true, status: 200, text: async () => "ok", json: async () => ({}) };
  };
  const s = await run(dead);
  assert.equal(s.layers.site.state, "down");
  assert.match(s.layers.site.error, /connection refused/);
  assert.equal(s.layers.gateway.state, "ok");
});

test("a missing account is down with a plain summary", async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ error: { name: "HANDLER_ERROR", data: "account board.testnet does not exist" } }) });
  const s = await run(f);
  assert.equal(s.layers.site.state, "down");
  assert.equal(s.layers.site.summary, "board.testnet does not exist on testnet");
});

test("gateway: public ok, non-2xx, deprecated RPC body, timeout and thrown error", async () => {
  const g = async (hosts, extra) => (await run(stub({ hosts }), extra)).layers.gateway;
  assert.equal((await g(pubOk)).state, "ok");
  assert.equal((await g({ [PUB]: [502, "bad gateway"] })).state, "down");
  const dep = await g({ [PUB]: [200, { error: "rpc.testnet.near.org is deprecated, use another" }] });
  assert.equal(dep.state, "down");
  assert.match(dep.error, /deprecated/);
  assert.equal((await g({ [PUB]: new Error("fetch failed") })).state, "down");
  const hang = stub({ hosts: pubOk });
  const slow = (url, init) => (url === PUB ? new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) : hang(url, init));
  const t = (await run(slow, { timeoutMs: 50 })).layers.gateway;
  assert.equal(t.state, "down");
  assert.ok(t.error);
});

test("gateway: self-hosted health, and mirror and public are reported separately", async () => {
  const hosts = { "http://127.0.0.1:8787/_quay/health": [200, { ok: true, rpc: "https://test.rpc.fastnear.com" }] };
  const local = (await run(stub({ hosts }), { gateway: "http://127.0.0.1:8787" })).layers.gateway;
  assert.equal(local.state, "ok");
  assert.equal(local.metrics.local, "ok");
  const bad = (await run(stub({ hosts: { "http://127.0.0.1:8787/_quay/health": [503, { ok: false, error: "no rpc" }] } }), { gateway: "http://127.0.0.1:8787" })).layers.gateway;
  assert.equal(bad.state, "down");

  const mirror = "https://board.example.workers.dev/_quay/health";
  const opt = { mirror: "https://board.example.workers.dev" };
  const both = (await run(stub({ hosts: { ...pubOk, [mirror]: [200, { ok: true, rpc: "https://rpc.example" }] } }), opt)).layers.gateway;
  assert.equal(both.state, "ok");
  assert.deepEqual([both.metrics.mirror, both.metrics.public, both.metrics.rpc], ["ok", "ok", "https://rpc.example"]);
  const half = (await run(stub({ hosts: { [PUB]: [502, "x"], [mirror]: [200, { ok: true }] } }), opt)).layers.gateway;
  assert.equal(half.state, "warn");
  assert.deepEqual([half.metrics.mirror, half.metrics.public], ["ok", "down"]);
  assert.match(half.error, /Public testnet\.page: HTTP 502/);
});

test("gateway: a host without CORS falls back to a no-cors reach check", async () => {
  const base = stub({ hosts: pubOk });
  const modes = [];
  const f = async (url, init = {}) => {
    if (url === PUB) {
      modes.push(init.mode ?? "cors");
      if (!init.mode) throw new TypeError("Failed to fetch");
      return { type: "opaque", ok: false, status: 0, text: async () => "", json: async () => null };
    }
    return base(url, init);
  };
  const g = (await run(f)).layers.gateway;
  assert.deepEqual(modes, ["cors", "no-cors"]);
  assert.equal(g.state, "ok");
  assert.match(g.summary, /status unreadable/);
  // a network error in both modes is down
  const dead = async (url, init) => {
    if (url === PUB) throw new TypeError("Failed to fetch");
    return base(url, init);
  };
  assert.equal((await run(dead)).layers.gateway.state, "down");
});

test("data: warns when a site-paid collection cannot be covered; off when empty", async () => {
  const low = { ...V3, get_pool: { balance: yocto(0.001), reserved: "0" } };
  const w = (await run(stub({ views: low, hosts: pubOk }))).layers.data;
  assert.equal(w.state, "warn");
  assert.match(w.error, /pool/);
  const none = (await run(stub({ views: { ...V3, list_collections: [] }, hosts: pubOk }))).layers.data;
  assert.equal(none.state, "off");
  assert.match(none.summary, /quay db collection set/);
});

test("functions: warn when the last run failed, off when none", async () => {
  const failed = { ...V3, fn_results: { docs: [{ id: "preview-4", data: { name: "preview", ok: false } }, { id: "preview-3", data: { ok: true } }] } };
  const w = (await run(stub({ views: failed, hosts: pubOk }))).layers.functions;
  assert.deepEqual([w.state, w.metrics.recent_failed], ["warn", 1]);
  const none = (await run(stub({ views: { ...V3, fn_list: [] }, hosts: pubOk }))).layers.functions;
  assert.equal(none.state, "off");
  // fn_list may be a name map
  const map = (await run(stub({ views: { ...V3, fn_list: { preview: { call: "anyone" } } }, hosts: pubOk }))).layers.functions;
  assert.equal(map.metrics.functions, 1);
});

test("routes: warn on a missing template, off with no routes", async () => {
  const miss = { ...V3, get_release: { ...V3.get_release, files: [{ path: "index.html" }] } };
  const w = (await run(stub({ views: miss, hosts: pubOk }))).layers.routes;
  assert.equal(w.state, "warn");
  assert.match(w.error, /templates\/post\.html/);
  const none = (await run(stub({ views: { ...V3, get_release: { id: "7", files: [] } }, hosts: pubOk }))).layers.routes;
  assert.equal(none.state, "off");
});

test("relay: no relayer account is off; account only is ok; URL health; low balance; unreachable; OutLayer", async () => {
  const bare = (await run(stub({ hosts: pubOk }))).layers.relay;
  assert.equal(bare.state, "off");
  assert.match(bare.summary, /quay relay deploy/);
  const acct = (await run(stub({ hosts: pubOk, accounts: { [`relay.${SITE}`]: { amount: yocto(1.5) } } }))).layers.relay;
  assert.deepEqual([acct.state, acct.metrics.balance_near, acct.metrics.checked], ["ok", "1.5000", false]);

  const health = (body, status = 200) => ({ ...pubOk, "http://relay.test/health": [status, body] });
  const ok = (await run(stub({ hosts: health({ site: SITE, relayer: `relay.${SITE}`, balance: yocto(2), ok: true, policy: { per_account_per_hour: 30, daily_tgas: 30000 } }) }), { relay: "http://relay.test" })).layers.relay;
  assert.deepEqual([ok.state, ok.metrics.checked, ok.metrics.per_account_per_hour], ["ok", true, 30]);
  const low = (await run(stub({ hosts: health({ relayer: `relay.${SITE}`, balance: yocto(0.01) }) }), { relay: "http://relay.test" })).layers.relay;
  assert.equal(low.state, "warn");
  const dead = (await run(stub({ hosts: health({}, 503) }), { relay: "http://relay.test" })).layers.relay;
  assert.equal(dead.state, "down");

  const ol = "https://testnet-api.outlayer.ai/call/board.testnet/relay";
  const adapter = (await run(stub({ hosts: { ...pubOk, [ol]: [200, { status: "completed", output: JSON.stringify({ relayer: `relay.${SITE}`, balance: yocto(3), ok: true }) }] } }), { relay: { outlayer: { owner: SITE, paymentKey: "k:1:s" } } })).layers.relay;
  assert.deepEqual([adapter.state, adapter.metrics.balance_near], ["ok", "3.0000"]);
});

test("cron: armed ok, stopped warn, stale tick warn, no jobs off", async () => {
  const c = async (st, jobs = V3.cron_list) => (await run(stub({ views: { ...V3, cron_status: st, cron_list: jobs }, hosts: pubOk }))).layers.cron;
  assert.equal((await c(V3.cron_status)).state, "ok");
  const stopped = await c({ armed: false, hops: 440, last_tick: ns(NOW - 3600000) });
  assert.equal(stopped.state, "warn");
  assert.match(stopped.error, /quay cron arm/);
  const stale = await c({ armed: true, hops: 4, last_tick: ns(NOW - 100 * 60000) });
  assert.equal(stale.state, "warn");
  assert.equal(stale.metrics.idle_minutes, 100);
  assert.equal((await c(V3.cron_status, [])).state, "off");
});

test("keys: warns unless there is exactly one full-access key", async () => {
  const two = { keys: [KEYS.keys[0], { public_key: "ed25519:c", access_key: { permission: "FullAccess" } }] };
  assert.equal((await run(stub({ keys: two, hosts: pubOk }))).layers.keys.state, "warn");
  assert.equal((await run(stub({ keys: { keys: [] }, hosts: pubOk }))).layers.keys.state, "warn");
});

test("each layer has its own timeout", async () => {
  const s = await run(stub({ hosts: pubOk, delay: { cron_status: 400 } }), { timeoutMs: 100 });
  assert.equal(s.layers.cron.state, "down");
  assert.match(s.layers.cron.error, /no answer/);
  assert.equal(s.layers.site.state, "ok");
  assert.equal(s.layers.keys.state, "ok");
});

test("samplePath", () => {
  assert.equal(samplePath("/posts/:id"), "/posts/1");
  assert.equal(samplePath("/api/:collection/:id"), "/api/1/1");
  assert.equal(samplePath("/files/*rest"), "/files/");
  assert.equal(samplePath("/*rest"), "/");
});

test("manifest: a node relay URL is health-checked; an OutLayer relay reads chain balance and says why", async () => {
  const manifestAt = (url, body) => ({ [url]: [200, body] });
  const node = { site: SITE, relay: { host: "node", url: "http://relay.test" }, functions_https: false, version: "3.0.0" };
  const ok = (await run(stub({ hosts: { ...pubOk, ...manifestAt(`${PUB}quay-site.json`, node), "http://relay.test/health": [200, { relayer: `relay.${SITE}`, balance: yocto(2), ok: true }] } }))).layers.relay;
  assert.deepEqual([ok.state, ok.metrics.checked, ok.metrics.host], ["ok", true, "node"]);

  const outlayer = { site: SITE, relay: { host: "outlayer", owner: SITE, project: "relay" }, functions_https: true, version: "3.0.0" };
  const mirrorManifest = "https://m.example/quay-site.json";
  const ol = (await run(stub({ hosts: { ...pubOk, [mirrorManifest]: [200, outlayer] }, accounts: { [`relay.${SITE}`]: { amount: yocto(1.2) } } }), { mirror: "https://m.example" })).layers.relay;
  assert.equal(ol.state, "ok");
  assert.match(ol.summary, /health check needs a payment key/);
  assert.doesNotMatch(ol.summary, /no health URL/);
  assert.equal(ol.metrics.balance_near, "1.2000");

  const none = (await run(stub({ hosts: { ...pubOk, ...manifestAt(`${PUB}quay-site.json`, { site: SITE, relay: null, functions_https: false }) } }))).layers.relay;
  assert.equal(none.state, "off");
  assert.match(none.summary, /publishes no relay/);

  // an explicit manifest option skips the fetch
  const given = (await run(stub({ hosts: pubOk }), { manifest: { relay: null } })).layers.relay;
  assert.equal(given.state, "off");
});
