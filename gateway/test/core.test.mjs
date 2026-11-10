import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanRpcUrls,
  createGateway,
  DEFAULT_RPC_URLS,
  probeGateway,
} from "../src/core.mjs";
import { createLru } from "../src/lru.mjs";
import {
  b64,
  DEPRECATED_BODY,
  fakeNet,
  json,
  page,
  RPC_A,
  RPC_B,
  rpcHandlerError,
} from "./helpers.mjs";

const HOME = "<!doctype html><title>demo</title><p id=release>5</p>";

function demo(extra = {}) {
  return {
    "demo.testnet": {
      web4_get({ request }) {
        const { path } = request;
        if (path === "/")
          return page(HOME, {
            cacheControl: "public, max-age=0, must-revalidate",
          });
        if (path === "/r/1/")
          return page("<p id=release>1</p>", {
            cacheControl: "public, max-age=31536000, immutable",
          });
        if (path === "/r/2/missing")
          return { status: 404, contentType: "text/html", body: b64("gone") };
        if (path === "/chart.svg")
          return { contentType: "image/svg+xml", body: b64("<svg/>") };
        if (path === "/missing")
          return {
            status: 404,
            contentType: "text/html; charset=utf-8",
            body: b64("Not on this release"),
          };
        if (path === "/query") return page(JSON.stringify(request.query));
        if (path === "/plain")
          return { contentType: "text/plain", body: b64("plain") };
        return extra[path]
          ? extra[path](request)
          : { status: 404, contentType: "text/plain", body: b64("no") };
      },
    },
  };
}

function gateway(options = {}) {
  const fetch =
    options.fetch ??
    fakeNet({ accounts: options.accounts ?? demo(options.paths) });
  const handler = createGateway({
    account: "demo.testnet",
    rpcUrls: [RPC_A, RPC_B],
    nearfsGateways: ["https://nearfs.test"],
    ipfsGateways: ["https://ipfs-one.test", "https://ipfs-two.test"],
    timeoutMs: 200,
    fetch,
    ...options.gateway,
  });
  return { handler, fetch };
}

const get = (handler, path, init = {}, host = "http://127.0.0.1:8787") =>
  handler(new Request(`${host}${path}`, init));

test("serves html with status, content type, etag, and quay headers", async () => {
  const { handler } = gateway();
  const res = await get(handler, "/");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(
    res.headers.get("cache-control"),
    "public, max-age=0, must-revalidate",
  );
  assert.equal(res.headers.get("x-quay-gateway"), "quay");
  assert.equal(res.headers.get("x-quay-rpc"), RPC_A);
  assert.match(res.headers.get("etag"), /^"[A-Za-z0-9_-]{43}"$/);
  assert.equal(res.headers.get("content-length"), String(HOME.length));
  assert.equal(await res.text(), HOME);
});

test("passes the contract's status, type, and query through", async () => {
  const { handler, fetch } = gateway();
  const missing = await get(handler, "/missing");
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Not on this release");
  const svg = await get(handler, "/chart.svg");
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.equal(await svg.text(), "<svg/>");
  const query = await get(handler, "/query?from=40&tag=a&tag=b");
  assert.deepEqual(JSON.parse(await query.text()), {
    from: ["40"],
    tag: ["a", "b"],
  });
  const sent = fetch.rpcCalls().at(-1);
  assert.equal(sent.finality, "optimistic");
  assert.equal(sent.method_name, "web4_get");
  const args = JSON.parse(Buffer.from(sent.args_base64, "base64").toString());
  assert.deepEqual(args, {
    request: {
      accountId: null,
      path: "/query",
      query: { from: ["40"], tag: ["a", "b"] },
    },
  });
});

test("answers If-None-Match with 304 and HEAD with headers only", async () => {
  const { handler } = gateway();
  const first = await get(handler, "/");
  const etag = first.headers.get("etag");
  const again = await get(handler, "/", {
    headers: { "if-none-match": `W/"x", ${etag}` },
  });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  assert.equal(again.headers.get("etag"), etag);
  const head = await get(handler, "/", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(HOME.length));
  assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await head.text(), "");
});

test("release paths are immutable and served from the LRU the second time", async () => {
  const { handler, fetch } = gateway({
    accounts: {
      "demo.testnet": {
        web4_get: ({ request }) =>
          page(`release ${request.path}`, { cacheControl: "no-store" }),
      },
    },
  });
  const one = await get(handler, "/r/1/");
  assert.equal(
    one.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(one.headers.get("x-quay-cache"), null);
  const two = await get(handler, "/r/1/");
  assert.equal(two.headers.get("x-quay-cache"), "hit");
  assert.equal(await two.text(), "release /r/1/");
  assert.equal(fetch.rpcCalls().length, 1);
  const prod = await get(handler, "/about/");
  assert.equal(prod.headers.get("cache-control"), "no-store");
  await get(handler, "/about/");
  assert.equal(fetch.rpcCalls().length, 3);
  const cond = await get(handler, "/r/1/", {
    headers: { "if-none-match": one.headers.get("etag") },
  });
  assert.equal(cond.status, 304);
});

test("bodyUrl: relative paths resolve on this gateway", async () => {
  const { handler } = gateway({
    paths: {
      "/big": () => ({ contentType: "text/plain", bodyUrl: "/plain" }),
    },
  });
  const res = await get(handler, "/big");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain");
  assert.equal(await res.text(), "plain");
});

test("bodyUrl: ipfs tries NEARFS first, then public gateways, and uses the CID as ETag", async () => {
  const order = [];
  const fetch = fakeNet({
    accounts: demo({
      "/media/a.jpg": () => ({
        contentType: "image/jpeg",
        bodyUrl: "ipfs://bafyabc",
      }),
    }),
    urls: {
      "https://nearfs.test/ipfs/bafyabc": () => {
        order.push("nearfs");
        return new Response("down", { status: 502 });
      },
      "https://ipfs-one.test/ipfs/bafyabc": () => {
        order.push("one");
        throw new TypeError("fetch failed");
      },
      "https://ipfs-two.test/ipfs/bafyabc": () => {
        order.push("two");
        return new Response("JPEG", {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "4",
          },
        });
      },
    },
  });
  const { handler } = gateway({ fetch });
  const res = await get(handler, "/media/a.jpg");
  assert.equal(res.status, 200);
  assert.deepEqual(order, ["nearfs", "one", "two"]);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(res.headers.get("etag"), '"bafyabc"');
  assert.equal(await res.text(), "JPEG");
  const cached = await get(handler, "/media/a.jpg", {
    headers: { "if-none-match": '"bafyabc"' },
  });
  assert.equal(cached.status, 304);
  assert.deepEqual(
    order,
    ["nearfs", "one", "two"],
    "a 304 does not fetch the body",
  );
});

test("bodyUrl: ipfs with a path keeps the path", async () => {
  const fetch = fakeNet({
    accounts: demo({
      "/doc": () => ({
        contentType: "text/plain",
        bodyUrl: "ipfs://bafyabc/dir/a.txt",
      }),
    }),
    urls: {
      "https://nearfs.test/ipfs/bafyabc/dir/a.txt": () => new Response("A"),
    },
  });
  const { handler } = gateway({ fetch });
  const res = await get(handler, "/doc");
  assert.equal(await res.text(), "A");
  assert.equal(res.headers.get("etag"), '"bafyabc/dir/a.txt"');
});

test("bodyUrl: https is streamed; when every place fails the page says so", async () => {
  const fetch = fakeNet({
    accounts: demo({
      "/ok": () => ({
        contentType: "text/css",
        bodyUrl: "https://cdn.test/a.css",
      }),
      "/bad": () => ({
        contentType: "text/css",
        bodyUrl: "https://cdn.test/gone.css",
      }),
      "/ipfs-bad": () => ({
        contentType: "text/css",
        bodyUrl: "ipfs://bafynone",
      }),
    }),
    urls: {
      "https://cdn.test/a.css": () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("body{}"));
              c.close();
            },
          }),
          { headers: { etag: '"up1"' } },
        ),
      "https://cdn.test/gone.css": () => new Response("x", { status: 500 }),
    },
  });
  const { handler } = gateway({ fetch });
  const ok = await get(handler, "/ok");
  assert.equal(ok.headers.get("content-type"), "text/css");
  assert.equal(ok.headers.get("etag"), '"up1"');
  assert.equal(await ok.text(), "body{}");
  const bad = await get(handler, "/bad");
  assert.equal(bad.status, 502);
  const html = await bad.text();
  assert.match(html, /Could not fetch the file body/);
  assert.match(html, /https:\/\/cdn.test\/gone.css: HTTP 500/);
  const ipfsBad = await get(handler, "/ipfs-bad");
  assert.equal(ipfsBad.status, 502);
  const text = await ipfsBad.text();
  for (const host of ["nearfs.test", "ipfs-one.test", "ipfs-two.test"])
    assert.match(text, new RegExp(host));
});

test("preloadUrls: fetches views and calls web4_get again with the preloads", async () => {
  const seen = [];
  const accounts = {
    "demo.testnet": {
      get_post({ id, opts }) {
        seen.push({ id, opts });
        return { id, title: "Hello" };
      },
      web4_get({ request }) {
        const url =
          "/web4/contract/demo.testnet/get_post?id=12&opts.json=%7B%22full%22%3Atrue%7D";
        if (!request.preloads) return { preloadUrls: [url] };
        const post = JSON.parse(
          Buffer.from(request.preloads[url].body, "base64").toString(),
        );
        assert.match(request.preloads[url].contentType, /application\/json/);
        return page(`<h1>${post.title} ${post.id}</h1>`);
      },
    },
  };
  const { handler, fetch } = gateway({ accounts });
  const res = await get(handler, "/posts/12");
  assert.equal(await res.text(), "<h1>Hello 12</h1>");
  assert.deepEqual(seen, [{ id: "12", opts: { full: true } }]);
  assert.equal(fetch.rpcCalls().length, 3);
});

test("the view endpoint returns JSON and JSON errors", async () => {
  const accounts = {
    "demo.testnet": { get_status: () => ({ production: "5" }) },
  };
  const { handler } = gateway({ accounts });
  const res = await get(handler, "/web4/contract/demo.testnet/get_status");
  assert.equal(
    res.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.deepEqual(await res.json(), { production: "5" });
  const bad = await get(
    handler,
    "/web4/contract/demo.testnet/get_status?x.json=nope",
  );
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.kind, "bad_request");
  const none = await get(handler, "/web4/contract/ghost.testnet/get_status");
  assert.equal(none.status, 404);
  assert.equal((await none.json()).error.account, "ghost.testnet");
});

test("falls back to the next RPC on 429, 5xx, deprecated 400, network error, and timeout", async () => {
  const failures = {
    429: () => new Response("slow down", { status: 429 }),
    503: () => new Response("<html>bad gateway</html>", { status: 503 }),
    deprecated: () => new Response(DEPRECATED_BODY, { status: 400 }),
    network: () => {
      throw new TypeError("fetch failed");
    },
    timeout: () => new Promise(() => {}),
    transient: () => json(rpcHandlerError("TIMEOUT_ERROR", "")),
  };
  for (const [name, fail] of Object.entries(failures)) {
    const fetch = fakeNet({ accounts: demo(), rpc: { [RPC_A]: fail } });
    const { handler } = gateway({ fetch, gateway: { timeoutMs: 50 } });
    const res = await get(handler, "/");
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get("x-quay-rpc"), RPC_B, name);
    assert.equal(await res.text(), HOME, name);
  }
});

test("a failed RPC moves to the back for a while", async () => {
  let calls = 0;
  const fetch = fakeNet({
    accounts: demo(),
    rpc: {
      [RPC_A]: () => {
        calls += 1;
        return new Response("", { status: 502 });
      },
    },
  });
  const { handler } = gateway({ fetch });
  await get(handler, "/");
  await get(handler, "/");
  assert.equal(calls, 1);
});

const ERROR_CASES = [
  [
    "rpc",
    502,
    {
      rpc: {
        [RPC_A]: () => new Response(DEPRECATED_BODY, { status: 400 }),
        [RPC_B]: () => new Response("", { status: 429 }),
      },
    },
    "/",
    /Every RPC endpoint failed/,
  ],
  ["no_account", 404, { accounts: {} }, "/", /does not exist on testnet/],
  [
    "no_contract",
    404,
    { accounts: { "demo.testnet": "no-code" } },
    "/",
    /no contract is deployed/,
  ],
  [
    "no_web4",
    404,
    { accounts: { "demo.testnet": {} } },
    "/",
    /without a web4_get method/,
  ],
  [
    "panic",
    500,
    {
      accounts: {
        "demo.testnet": {
          web4_get: () => ({
            rpc: {
              jsonrpc: "2.0",
              id: "q",
              result: {
                error:
                  'wasm execution failed with error: HostError(GuestPanic { panic_msg: "release \\"9\\" is missing" })',
                logs: [],
              },
            },
          }),
        },
      },
    },
    "/r/9/a.css",
    /release &quot;9&quot; is missing/,
  ],
  [
    "bad_response",
    502,
    { accounts: { "demo.testnet": { web4_get: () => "just a string" } } },
    "/",
    /not a web4 response/,
  ],
  [
    "hops",
    502,
    {
      accounts: {
        "demo.testnet": {
          web4_get: () => ({ preloadUrls: ["/web4/contract/demo.testnet/x"] }),
          x: () => 1,
        },
      },
    },
    "/",
    /preloads 5 times/,
  ],
];

test("every failure is a clean HTML page with the right status, never the RPC's JSON", async () => {
  for (const [kind, status, net, path, message] of ERROR_CASES) {
    const fetch = fakeNet(net);
    const { handler } = gateway({ fetch, gateway: { timeoutMs: 50 } });
    const res = await get(handler, path, {
      headers: { accept: "text/html,*/*" },
    });
    assert.equal(res.status, status, kind);
    assert.equal(
      res.headers.get("content-type"),
      "text/html; charset=utf-8",
      kind,
    );
    assert.equal(res.headers.get("cache-control"), "no-store", kind);
    assert.match(
      res.headers.get("content-security-policy"),
      /default-src 'none'/,
      kind,
    );
    const html = await res.text();
    assert.match(html, /^<!doctype html>/, kind);
    assert.match(html, message, kind);
    assert.match(html, new RegExp(`${status} · ${kind}`), kind);
    assert.match(html, /demo\.testnet/, kind);
    assert.ok(html.includes(path.replace(/&/g, "&amp;")), kind);
    assert.doesNotMatch(html, /jsonrpc|DEPRECATED|HANDLER_ERROR|"error"/, kind);
    assert.doesNotMatch(
      html,
      /https?:\/\/(?!rpc-[ab]\.test)[^"\s<]+\.(css|js|woff2?|png)/,
      `${kind} loads nothing`,
    );
    if (path.startsWith("/r/9/"))
      assert.match(
        html,
        /href="\/r\/9\/"/,
        `${kind} links back to the release`,
      );
    const api = await get(handler, path, {
      headers: { accept: "application/json" },
    });
    assert.equal(api.status, status, kind);
    const body = await api.json();
    assert.equal(body.error.kind, kind);
    assert.equal(body.error.path, path);
    assert.doesNotMatch(JSON.stringify(body), /jsonrpc|DEPRECATED/, kind);
  }
});

test("the RPC failure page lists each endpoint and why", async () => {
  const fetch = fakeNet({
    rpc: {
      [RPC_A]: () => new Response(DEPRECATED_BODY, { status: 400 }),
      [RPC_B]: () => new Promise(() => {}),
    },
  });
  const { handler } = gateway({ fetch, gateway: { timeoutMs: 30 } });
  const res = await get(handler, "/");
  const html = await res.text();
  assert.match(html, /rpc-a\.test: HTTP 400, deprecated endpoint/);
  assert.match(html, /rpc-b\.test: timeout after 30 ms/);
  const api = await get(handler, "/api/posts");
  assert.equal(
    api.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal((await api.json()).error.attempts.length, 2);
});

test("POST is refused with 405 and Allow", async () => {
  const { handler } = gateway();
  const res = await get(handler, "/", { method: "POST", body: "x" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD");
});

test("host routing maps <name>.<domain> to <name>.testnet", async () => {
  const fetch = fakeNet({
    accounts: {
      "demo.testnet": demo()["demo.testnet"],
      "a.demo.testnet": { web4_get: () => page("sub") },
    },
  });
  const handler = createGateway({
    domain: "example.com",
    rpcUrls: [RPC_A],
    fetch,
  });
  assert.equal(
    await (await get(handler, "/", {}, "https://demo.example.com")).text(),
    HOME,
  );
  assert.equal(
    await (await get(handler, "/", {}, "https://a.demo.example.com")).text(),
    "sub",
  );
  const apex = await get(handler, "/", {}, "https://example.com");
  assert.equal(apex.status, 404);
  assert.match(await apex.text(), /No site on this host/);
  const other = await get(handler, "/", {}, "https://demo.other.org");
  assert.equal(other.status, 404);
  const single = createGateway({
    account: "demo.testnet",
    rpcUrls: [RPC_A],
    fetch,
  });
  assert.equal(
    await (await get(single, "/", {}, "https://anything.example.org")).text(),
    HOME,
  );
});

test("/_quay/health reports the RPC and latency", async () => {
  const { handler } = gateway();
  const res = await get(handler, "/_quay/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.account, "demo.testnet");
  assert.equal(body.rpc, RPC_A);
  assert.equal(typeof body.latency_ms, "number");
  const down = gateway({
    fetch: fakeNet({
      rpc: {
        [RPC_A]: () => new Response("", { status: 500 }),
        [RPC_B]: () => new Response("", { status: 500 }),
      },
    }),
  });
  const bad = await get(down.handler, "/_quay/health");
  assert.equal(bad.status, 503);
  const badBody = await bad.json();
  assert.equal(badBody.ok, false);
  assert.equal(badBody.rpc, null);
  const ghost = gateway({ accounts: {} });
  assert.equal(
    (await (await get(ghost.handler, "/_quay/health")).json()).ok,
    false,
  );
});

test("rpc.testnet.near.org is never used", () => {
  assert.ok(!DEFAULT_RPC_URLS.some((url) => url.includes("near.org")));
  const { urls, dropped } = cleanRpcUrls([
    "https://rpc.testnet.near.org",
    "https://a.test/",
    "https://a.test",
  ]);
  assert.deepEqual(urls, ["https://a.test"]);
  assert.deepEqual(dropped, ["https://rpc.testnet.near.org"]);
  assert.throws(
    () =>
      createGateway({
        account: "demo.testnet",
        rpcUrls: ["https://rpc.testnet.near.org"],
      }),
    /no usable RPC/,
  );
});

test("the LRU is bounded in bytes and evicts the oldest", () => {
  const lru = createLru(100);
  assert.equal(lru.set("a", 1, 20), true);
  lru.set("b", 2, 20);
  lru.set("c", 3, 20);
  lru.get("a");
  lru.set("d", 4, 25);
  lru.set("e", 5, 25);
  assert.equal(lru.bytes <= 100, true);
  assert.equal(lru.get("b"), undefined);
  assert.equal(lru.get("a"), 1);
  assert.equal(lru.set("huge", 0, 26), false);
});

test("probeGateway classifies the public gateway", async () => {
  const at = (response) => () =>
    typeof response === "function" ? response() : response;
  const deprecated = await probeGateway("https://x.testnet.page/", {
    fetch: at(new Response(DEPRECATED_BODY, { status: 400 })),
  });
  assert.deepEqual(
    [deprecated.ok, deprecated.status, deprecated.reason],
    [false, 400, "400 deprecated RPC"],
  );
  const ok = await probeGateway("https://x.testnet.page/", {
    fetch: at(new Response("<html>", { status: 200 })),
  });
  assert.equal(ok.ok, true);
  const notFound = await probeGateway("https://x.testnet.page/", {
    fetch: at(new Response("<html>404", { status: 404 })),
  });
  assert.equal(
    notFound.ok,
    true,
    "a contract 404 still means the gateway answered",
  );
  const broken = await probeGateway("https://x.testnet.page/", {
    fetch: at(new Response("", { status: 502 })),
  });
  assert.equal(broken.reason, "502 gateway error");
  const offline = await probeGateway("https://x.testnet.page/", {
    fetch: () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND" },
      });
    },
  });
  assert.equal(offline.reason, "network error ENOTFOUND");
  const slow = await probeGateway("https://x.testnet.page/", {
    fetch: () => new Promise(() => {}),
    timeoutMs: 20,
  });
  assert.equal(slow.reason, "timeout after 20 ms");
});
