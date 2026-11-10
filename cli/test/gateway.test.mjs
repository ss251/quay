import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run, status } from "../src/app.mjs";
import { DEFAULT_RPC } from "../src/config.mjs";
import { localCommand, rpcList } from "../src/gateway.mjs";
import { parseArgs } from "../src/text.mjs";

const bin = fileURLToPath(new URL("../bin/quay.js", import.meta.url));
const HTML = "<!doctype html><p id=release>5</p>";
const DEPRECATED = JSON.stringify({
  jsonrpc: "2.0",
  error: { code: -429, message: "WARNING! THIS ENDPOINT IS DEPRECATED!" },
  id: "1",
});

function streams() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (chunk) => out.push(String(chunk)) },
    stderr: { write: (chunk) => err.push(String(chunk)) },
    text: () => out.join(""),
    err: () => err.join(""),
  };
}

// Answers web4_get with HTML for any account, like a working RPC.
function rpcFetch(url, init) {
  if (init?.method !== "POST") return new Response("", { status: 404 });
  const value = {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: Buffer.from(HTML).toString("base64"),
  };
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "quay",
      result: { result: [...Buffer.from(JSON.stringify(value))], logs: [] },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function config(account = "demo.testnet") {
  return {
    account,
    network: "testnet",
    rpc: DEFAULT_RPC,
    gateway: `https://${account.replace(/\.testnet$/, "")}.testnet.page`,
  };
}

test("quay gateway serves the account locally until stopped", async () => {
  const io = streams();
  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const parsed = parseArgs([
    "gateway",
    "--port",
    "0",
    "--rpc",
    "https://rpc-a.test",
    "--rpc",
    "https://rpc.testnet.near.org",
  ]);
  const done = run(
    {
      ...io,
      config: config(),
      fetch: rpcFetch,
      gatewayStop: stopped,
      onGatewayReady: ready,
    },
    parsed,
  );
  const { url } = await started;
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-quay-rpc"), "https://rpc-a.test");
  assert.equal(await res.text(), HTML);
  stop();
  assert.equal(await done, 0);
  assert.match(
    io.text(),
    /serving demo\.testnet at http:\/\/127\.0\.0\.1:\d+\//,
  );
  assert.match(io.text(), /Ctrl-C stops it/);
  assert.match(io.err(), /skipping https:\/\/rpc\.testnet\.near\.org/);
  assert.match(io.err(), /GET \/ 200/);
});

test("quay gateway needs an account and a valid port", async () => {
  const io = streams();
  await assert.rejects(
    run(
      { ...io, config: { ...config(), account: undefined } },
      parseArgs(["gateway"]),
    ),
    /no account/,
  );
  await assert.rejects(
    run({ ...io, config: config() }, parseArgs(["gateway", "--port", "nope"])),
    /--port needs a number/,
  );
});

test("the RPC list: flags in order, else quay.json first, never the deprecated host", () => {
  const flags = parseArgs([
    "gateway",
    "--rpc",
    "https://a.test,https://b.test",
    "--rpc=https://c.test",
  ]).flags;
  assert.deepEqual(rpcList(flags, config()).urls, [
    "https://a.test",
    "https://b.test",
    "https://c.test",
  ]);
  const custom = rpcList({}, { rpc: "https://mine.test" }).urls;
  assert.equal(custom[0], "https://mine.test");
  assert.equal(custom.length, 4);
  const deprecated = rpcList({}, { rpc: "https://rpc.testnet.near.org" });
  assert.deepEqual(deprecated.dropped, ["https://rpc.testnet.near.org"]);
  assert.ok(deprecated.urls.length >= 3);
});

test("quay status reports the public gateway and the local command", async () => {
  const chain = {
    view: async () => ({
      version: "2.0.0",
      production: "5",
      previous: "4",
      release_count: 5,
      stored_bytes: "17717",
      max_bytes: "2000000",
    }),
  };
  const down = streams();
  await status({
    ...down,
    config: config("quay-65nqd3rn.testnet"),
    chain,
    fetch: async () => new Response(DEPRECATED, { status: 400 }),
  });
  assert.match(
    down.text(),
    /gateway {6}https:\/\/quay-65nqd3rn\.testnet\.page {2}down: 400 deprecated RPC, \d+ ms/,
  );
  assert.match(
    down.text(),
    /local {8}quay gateway --account quay-65nqd3rn\.testnet/,
  );
  const up = streams();
  await status({
    ...up,
    json: true,
    config: config("quay-65nqd3rn.testnet"),
    chain,
    fetch: async () => new Response("<html>", { status: 200 }),
  });
  const payload = JSON.parse(up.text());
  assert.equal(payload.gateway_health.ok, true);
  assert.equal(payload.gateway_health.status, 200);
  assert.equal(payload.local_gateway, localCommand("quay-65nqd3rn.testnet"));
});

test("the quay binary stops the gateway on SIGINT", async () => {
  const child = spawn(
    process.execPath,
    [
      bin,
      "gateway",
      "--account",
      "demo.testnet",
      "--port",
      "0",
      "--rpc",
      "http://127.0.0.1:9",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  const url = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (match) resolve(match[1]);
    });
    child.once("exit", () => reject(new Error(`exited early: ${out}${err}`)));
  });
  const res = await fetch(url, { headers: { accept: "text/html" } });
  assert.equal(res.status, 502);
  const html = await res.text();
  assert.match(html, /Every RPC endpoint failed/);
  assert.doesNotMatch(html, /jsonrpc/);
  const code = await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGINT");
  });
  assert.equal(code, 0);
  assert.match(err, /gateway stopped/);
});
