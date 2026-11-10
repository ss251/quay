import assert from "node:assert/strict";
import test from "node:test";

import {
  actions,
  createTransaction,
  KeyPair,
  Signature,
  SignedTransaction,
} from "near-api-js";

import { resolveConfig } from "../src/config.mjs";
import {
  createFailoverProvider,
  DEFAULT_RPC_URLS,
  isRetriable,
} from "../src/failover.mjs";
import { QuayError } from "../src/errors.mjs";

const URLS = ["https://a.rpc", "https://b.rpc", "https://c.rpc"];

function rpcFetch(handlers) {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const host = new URL(url).host;
    seen.push(host);
    return handlers[host](JSON.parse(init.body));
  };
  return {
    seen,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const ok = (result) => ({
  status: 200,
  json: async () => ({ jsonrpc: "2.0", id: "1", result }),
  text: async () => "",
});

test("a 429 moves to the next URL and the next call starts there", async (t) => {
  const stub = rpcFetch({
    "a.rpc": () => ({ status: 429, text: async () => "Rate limits exceeded" }),
    "b.rpc": () => ok({ chain_id: "testnet" }),
    "c.rpc": () => ok({ chain_id: "never" }),
  });
  t.after(stub.restore);
  const provider = createFailoverProvider(URLS);
  const status = await provider.viewNodeStatus();
  assert.equal(status.chain_id, "testnet");
  assert.ok(stub.seen.includes("a.rpc"));
  stub.seen.length = 0;
  await provider.viewNodeStatus();
  assert.deepEqual(stub.seen, ["b.rpc"]);
});

test("a network error and a 503 also fail over", async (t) => {
  const stub = rpcFetch({
    "a.rpc": () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNRESET" },
      });
    },
    "b.rpc": () => ({ status: 503, text: async () => "" }),
    "c.rpc": () => ok({ chain_id: "testnet" }),
  });
  t.after(stub.restore);
  const status = await createFailoverProvider(URLS).viewNodeStatus();
  assert.equal(status.chain_id, "testnet");
});

test("a JSON-RPC error that is not a rate limit is returned as is, from the first node only", async (t) => {
  const stub = rpcFetch({
    "a.rpc": () => ({
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: "1",
        error: {
          name: "HANDLER_ERROR",
          cause: { name: "UNKNOWN_ACCOUNT", info: {} },
          code: -32000,
          message: "Server error",
          data: "account does not exist",
        },
      }),
    }),
    "b.rpc": () => ok({}),
    "c.rpc": () => ok({}),
  });
  t.after(stub.restore);
  await assert.rejects(
    createFailoverProvider(URLS).viewNodeStatus(),
    (error) => !(error instanceof QuayError),
  );
  assert.deepEqual([...new Set(stub.seen)], ["a.rpc"]);
});

test("when every endpoint fails the error names each one", async (t) => {
  const stub = rpcFetch({
    "a.rpc": () => ({ status: 429, text: async () => "Rate limits exceeded" }),
    "b.rpc": () => ({ status: 429, text: async () => "Rate limits exceeded" }),
    "c.rpc": () => ({ status: 429, text: async () => "Rate limits exceeded" }),
  });
  t.after(stub.restore);
  await assert.rejects(
    createFailoverProvider(URLS).viewNodeStatus(),
    (error) =>
      error instanceof QuayError &&
      error.code === 2 &&
      /every RPC endpoint failed/.test(error.message) &&
      /a\.rpc/.test(error.message) &&
      /c\.rpc/.test(error.message) &&
      /--rpc/.test(error.message),
  );
});

test("retriable errors are told apart from contract errors", () => {
  assert.equal(
    isRetriable(Object.assign(new Error("x"), { cause: 429 })),
    true,
  );
  assert.equal(
    isRetriable(Object.assign(new Error("x"), { cause: 502 })),
    true,
  );
  assert.equal(isRetriable(new Error("Rate limits exceeded")), true);
  assert.equal(isRetriable(new TypeError("fetch failed")), true);
  assert.equal(
    isRetriable(new Error("Smart contract panicked: only this account")),
    false,
  );
  assert.equal(
    isRetriable(Object.assign(new Error("bad"), { cause: 400 })),
    false,
  );
});

function signedTx() {
  const key = KeyPair.fromRandom("ed25519");
  const transaction = createTransaction(
    "a.testnet",
    key.getPublicKey(),
    "b.testnet",
    1n,
    [actions.transfer(1n)],
    new Uint8Array(32),
  );
  return new SignedTransaction({
    transaction,
    signature: new Signature({ keyType: 0, data: new Uint8Array(64) }),
  });
}

function nodes(script) {
  const calls = [];
  const make = (url) => ({
    async sendTransactionUntil(signed, until) {
      calls.push({ url, op: "send", signed });
      return script[url].send(signed, until);
    },
    async viewTransactionStatus(params) {
      calls.push({ url, op: "status", params });
      return script[url].status(params);
    },
  });
  return { calls, make };
}

test("a send is re-sent as the same signed transaction after asking the next node by hash", async () => {
  const signed = signedTx();
  const { calls, make } = nodes({
    "https://a.rpc": {
      send: async () => {
        throw Object.assign(new Error("x"), { cause: 429 });
      },
    },
    "https://b.rpc": {
      status: async () => {
        throw new Error("UNKNOWN_TRANSACTION");
      },
      send: async () => ({ transaction: { hash: "H" }, status: {} }),
    },
  });
  const provider = createFailoverProvider(URLS.slice(0, 2), {
    makeProvider: make,
  });
  const out = await provider.sendTransactionUntil(signed, "EXECUTED");
  assert.equal(out.transaction.hash, "H");
  assert.deepEqual(
    calls.map((call) => `${call.url.slice(8, 9)}:${call.op}`),
    ["a:send", "b:status", "b:send"],
  );
  assert.equal(calls[2].signed, signed);
  assert.match(calls[1].params.txHash, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.equal(calls[1].params.accountId, "a.testnet");
});

test("a send the next node already has is not sent again", async () => {
  const { calls, make } = nodes({
    "https://a.rpc": {
      send: async () => {
        throw new Error("socket hang up");
      },
    },
    "https://b.rpc": {
      status: async () => ({
        transaction: { hash: "SEEN" },
        status: { SuccessValue: "" },
      }),
      send: async () => {
        throw new Error("must not send");
      },
    },
  });
  const out = await createFailoverProvider(URLS.slice(0, 2), {
    makeProvider: make,
  }).sendTransactionUntil(signedTx(), "EXECUTED");
  assert.equal(out.transaction.hash, "SEEN");
  assert.equal(calls.filter((call) => call.op === "send").length, 1);
});

test("a send that fails for a contract reason is not re-sent anywhere", async () => {
  const { calls, make } = nodes({
    "https://a.rpc": {
      send: async () => {
        throw new Error("InvalidNonce");
      },
    },
    "https://b.rpc": { status: async () => null, send: async () => ({}) },
  });
  await assert.rejects(
    createFailoverProvider(URLS.slice(0, 2), {
      makeProvider: make,
    }).sendTransactionUntil(signedTx(), "EXECUTED"),
    /InvalidNonce/,
  );
  assert.equal(calls.length, 1);
});

test("config: no rpc set uses the failover list, a given rpc is the only one", () => {
  const prior = process.env.QUAY_RPC;
  delete process.env.QUAY_RPC;
  try {
    const none = resolveConfig({}, "/");
    assert.deepEqual(none.rpcUrls, DEFAULT_RPC_URLS);
    assert.equal(none.rpcExplicit, false);
    const flag = resolveConfig({ rpc: "https://mine.rpc" }, "/");
    assert.deepEqual(flag.rpcUrls, ["https://mine.rpc"]);
    assert.equal(flag.rpcExplicit, true);
    const many = resolveConfig(
      { rpc: "https://x.rpc", rpcList: ["https://x.rpc", "https://y.rpc"] },
      "/",
    );
    assert.deepEqual(many.rpcUrls, ["https://x.rpc", "https://y.rpc"]);
    process.env.QUAY_RPC = "https://env.rpc";
    assert.deepEqual(resolveConfig({}, "/").rpcUrls, ["https://env.rpc"]);
  } finally {
    if (prior === undefined) delete process.env.QUAY_RPC;
    else process.env.QUAY_RPC = prior;
  }
});
