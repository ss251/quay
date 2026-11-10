import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createGateway } from "../src/core.mjs";
import { serve } from "../src/node.mjs";
import { b64, page, rpcServer } from "./helpers.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const bundle = here("../dist/quay-gateway.mjs");
const HTML = "<!doctype html><p id=release>7</p>";
const ACCOUNTS = {
  "demo.testnet": {
    web4_get: ({ request }) =>
      request.path === "/big"
        ? { contentType: "text/plain", body: b64("x".repeat(300_000)) }
        : page(HTML),
  },
};

function has(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

// Starts a runner, waits for the line with its URL, returns { url, stop }.
function start(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} did not start: ${out}${err}`));
    }, 20_000);
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (!match) return;
      clearTimeout(timer);
      resolve({
        url: match[1],
        output: () => out + err,
        stop: () =>
          new Promise((done) => {
            child.once("exit", done);
            child.kill("SIGINT");
          }),
      });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${command} exited ${code}: ${out}${err}`));
    });
  });
}

test("the Node adapter streams responses and handles HEAD", async () => {
  const rpc = await rpcServer(ACCOUNTS);
  const server = await serve(
    createGateway({ account: "demo.testnet", rpcUrls: [rpc.url] }),
    { port: 0 },
  );
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-quay-gateway"), "quay");
    assert.equal(await res.text(), HTML);
    const big = await fetch(`${base}/big`);
    assert.equal((await big.text()).length, 300_000);
    const head = await fetch(`${base}/`, { method: "HEAD" });
    assert.equal(head.headers.get("content-length"), String(HTML.length));
    const health = await (await fetch(`${base}/_quay/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.rpc, rpc.url);
  } finally {
    await server.close();
    await rpc.close();
  }
});

const RUNTIMES = [
  ["node", [bundle]],
  ["deno", ["run", "-A", bundle]],
  ["bun", [bundle]],
];

for (const [command, prefix] of RUNTIMES) {
  test(
    `dist/quay-gateway.mjs serves a site under ${command}`,
    { skip: has(command) ? false : `${command} is not installed` },
    async () => {
      const rpc = await rpcServer(ACCOUNTS);
      let runner = null;
      try {
        runner = await start(command, [
          ...prefix,
          "--account",
          "demo.testnet",
          "--port",
          "0",
          "--rpc",
          rpc.url,
        ]);
        const res = await fetch(runner.url);
        assert.equal(res.status, 200);
        assert.equal(await res.text(), HTML);
        const missing = await fetch(`${runner.url}r/1/`, {
          headers: { accept: "application/json" },
        });
        assert.equal(missing.status, 200);
      } finally {
        await runner?.stop();
        await rpc.close();
      }
    },
  );
}

test("worker/worker.mjs answers Requests with DOMAIN and ACCOUNT", async () => {
  const rpc = await rpcServer(ACCOUNTS);
  try {
    const worker = (await import("../worker/worker.mjs")).default;
    const routed = await worker.fetch(
      new Request("https://demo.example.com/"),
      {
        DOMAIN: "example.com",
        RPC_URLS: rpc.url,
      },
    );
    assert.equal(routed.status, 200);
    assert.equal(await routed.text(), HTML);
    const single = await worker.fetch(
      new Request("https://www.custom.example/"),
      { ACCOUNT: "demo.testnet", RPC_URLS: rpc.url },
    );
    assert.equal(await single.text(), HTML);
    const none = await worker.fetch(new Request("https://example.com/"), {
      DOMAIN: "example.com",
      RPC_URLS: rpc.url,
    });
    assert.equal(none.status, 404);
    const bad = await worker.fetch(new Request("https://x.example.com/"), {});
    assert.equal(bad.status, 500);
  } finally {
    await rpc.close();
  }
});

test("the worker bundle uses no Node built-ins", () => {
  const text = readFileSync(here("../worker/worker.mjs"), "utf8");
  assert.doesNotMatch(text, /from\s+["']node:|require\(/);
});

test("dist, worker, and cli/vendor/gateway match gateway/src", async (t) => {
  try {
    await import("esbuild");
  } catch {
    t.skip("esbuild is not installed; run npm install at the repo root");
    return;
  }
  execFileSync(process.execPath, [here("../build.mjs"), "--check"], {
    stdio: "pipe",
  });
});

test(
  "live: serves quay-65nqd3rn.testnet locally (QUAY_LIVE=1)",
  { skip: process.env.QUAY_LIVE === "1" ? false : "set QUAY_LIVE=1" },
  async () => {
    const server = await serve(
      createGateway({ account: "quay-65nqd3rn.testnet" }),
      { port: 0 },
    );
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const checks = [
        ["/", 'id="release">5'],
        ["/berth/", "Berth"],
        ["/chart.svg", "<svg"],
        ["/r/1/", 'id="release">1'],
      ];
      for (const [path, expected] of checks) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 200, path);
        assert.ok((await res.text()).includes(expected), path);
        assert.ok(res.headers.get("x-quay-rpc"), path);
      }
    } finally {
      await server.close();
    }
  },
);
