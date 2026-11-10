import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { QuayError } from "../src/errors.mjs";
import { buildFile, LEAF_BYTES } from "../src/stores/cid.mjs";
import { filebaseStore, signV4 } from "../src/stores/filebase.mjs";
import { makeStore, verifyExternal } from "../src/stores/index.mjs";
import { batchBlocks, nearfsStore } from "../src/stores/nearfs.mjs";
import { pinataStore } from "../src/stores/pinata.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("an empty file is the known raw leaf", async () => {
  const built = await buildFile(new Uint8Array(0));
  assert.equal(
    built.root,
    "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
  );
  assert.equal(built.blocks.length, 1);
});

test("a file up to one chunk is one raw leaf", async () => {
  const built = await buildFile(new Uint8Array(LEAF_BYTES).fill(7));
  assert.equal(built.blocks.length, 1);
  assert.match(built.root, /^bafkrei/);
});

test("300000 bytes are two leaves under a 108 byte dag-pb root", async () => {
  const built = await buildFile(new Uint8Array(300_000));
  assert.deepEqual(
    built.blocks.map((block) => block.bytes.length),
    [262_144, 37_856, 108],
  );
  assert.equal(
    built.root,
    "bafybeieb4dp5tj5rew3jhfqqsoyfx77y3ovw2xcdhelmp5hyot3xi3wjwu",
  );
  assert.match(built.root, /^bafybei/);
});

test("batches hold at most 7 blocks and 256 KiB", () => {
  const block = (size) => ({ bytes: new Uint8Array(size) });
  const small = batchBlocks(Array.from({ length: 15 }, () => block(10)));
  assert.deepEqual(
    small.map((batch) => batch.length),
    [7, 7, 1],
  );
  const big = batchBlocks([block(262_144), block(262_144), block(108)]);
  assert.deepEqual(
    big.map((batch) => batch.length),
    [1, 1, 1],
  );
  const mixed = batchBlocks([block(200_000), block(50_000), block(20_000)]);
  assert.deepEqual(
    mixed.map((batch) => batch.length),
    [2, 1],
  );
  for (const batch of [...small, ...big, ...mixed]) {
    assert.ok(
      batch.reduce((sum, item) => sum + item.bytes.length, 0) <= 262_144,
    );
  }
});

test("nearfs sends each block as an fs_store call to the signer", async () => {
  const sent = [];
  const store = nearfsStore({
    chain: {
      async sendBatch(calls) {
        sent.push(calls);
        return { hash: `tx${sent.length}` };
      },
    },
  });
  const bytes = new Uint8Array(300_000).fill(1);
  const uploaded = await store.upload({ path: "big.bin", bytes });
  assert.equal(uploaded.cid, (await buildFile(bytes)).root);
  assert.equal(sent.length, 2);
  assert.ok(sent.flat().every((call) => call.method === "fs_store"));
  assert.equal(sent[0][0].args.length, 262_144);
  assert.deepEqual(uploaded.transactions, ["tx1", "tx2"]);
  assert.equal(sent[1].length, 2);
  assert.equal(
    store.gatewayUrl(uploaded.cid),
    `https://ipfs.web4.testnet.page/ipfs/${uploaded.cid}`,
  );
});

test("verify retries a 404 then accepts matching bytes", async () => {
  const bytes = Buffer.from("hello");
  let tries = 0;
  const store = { name: "nearfs", gatewayUrl: (cid) => `https://gw/${cid}` };
  const result = await verifyExternal(store, "bafx", sha(bytes), {
    fetch: async () => {
      tries += 1;
      return tries < 3
        ? { ok: false, status: 404 }
        : { ok: true, arrayBuffer: async () => bytes };
    },
    sleep: async () => {},
    verifyTimeoutMs: 60_000,
  });
  assert.equal(tries, 3);
  assert.equal(result.bytes, 5);
});

test("verify fails on different bytes and on a store that never serves", async () => {
  const store = { name: "nearfs", gatewayUrl: (cid) => `https://gw/${cid}` };
  await assert.rejects(
    verifyExternal(store, "bafx", sha("a"), {
      fetch: async () => ({
        ok: true,
        arrayBuffer: async () => Buffer.from("b"),
      }),
      sleep: async () => {},
    }),
    /different bytes/,
  );
  await assert.rejects(
    verifyExternal(store, "bafx", sha("a"), {
      fetch: async () => ({ ok: false, status: 404 }),
      sleep: async () => {},
      verifyTimeoutMs: 0,
    }),
    /did not serve bafx.*--no-verify/,
  );
});

test("pinata needs PINATA_JWT and reads the cid from the v3 response", async () => {
  assert.throws(() => pinataStore({ env: {} }), /PINATA_JWT/);
  let seen;
  const store = pinataStore({
    env: { PINATA_JWT: "jwt-secret-value" },
    fetch: async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ data: { cid: "bafybeipinata", size: 3 } }),
      };
    },
  });
  const out = await store.upload({
    path: "media/a.jpg",
    bytes: Buffer.from("abc"),
    contentType: "image/jpeg",
  });
  assert.equal(out.cid, "bafybeipinata");
  assert.equal(seen.url, "https://uploads.pinata.cloud/v3/files");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.authorization, "Bearer jwt-secret-value");
  assert.equal(seen.init.body.get("network"), "public");
  assert.equal(seen.init.body.get("file").name, "a.jpg");
  assert.equal(
    store.gatewayUrl("bafy"),
    "https://gateway.pinata.cloud/ipfs/bafy",
  );
});

test("pinata errors do not leak the key", async () => {
  const store = pinataStore({
    env: { PINATA_JWT: "jwt-secret-value" },
    fetch: async () => ({
      ok: false,
      status: 401,
      text: async () => "bad token",
    }),
  });
  await assert.rejects(
    store.upload({
      path: "a",
      bytes: Buffer.from("x"),
      contentType: "text/plain",
    }),
    (error) =>
      error instanceof QuayError &&
      /401/.test(error.message) &&
      !/jwt-secret-value/.test(error.message),
  );
});

test("SigV4 matches the AWS GET Object example", () => {
  const headers = signV4({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    headers: {
      range: "bytes=0-9",
      "x-amz-content-sha256":
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    payloadHash:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    region: "us-east-1",
    key: "AKIAIOSFODNN7EXAMPLE",
    secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    date: new Date("2013-05-24T00:00:00Z"),
  });
  assert.match(
    headers.authorization,
    /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
  );
  assert.match(
    headers.authorization,
    /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date/,
  );
});

test("filebase signs a PUT and reads the cid header", async () => {
  assert.throws(() => filebaseStore({ env: {} }), /FILEBASE_KEY/);
  let seen;
  const store = filebaseStore({
    env: {
      FILEBASE_KEY: "k",
      FILEBASE_SECRET: "s",
      FILEBASE_BUCKET: "site-media",
    },
    now: () => new Date("2026-11-10T00:00:00Z"),
    fetch: async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "x-amz-meta-cid": "bafybeifilebase" }),
      };
    },
  });
  const bytes = Buffer.from("abc");
  const out = await store.upload({
    path: "media/a.jpg",
    bytes,
    contentType: "image/jpeg",
    sha256: sha(bytes),
  });
  assert.equal(out.cid, "bafybeifilebase");
  assert.match(
    seen.url,
    /^https:\/\/s3\.filebase\.com\/site-media\/[0-9a-f]{16}-a\.jpg$/,
  );
  assert.match(
    seen.init.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=k\/20261110\/us-east-1\/s3\/aws4_request/,
  );
  assert.equal(seen.init.headers["x-amz-content-sha256"], sha(bytes));
  assert.equal(seen.init.headers.host, undefined);
});

test("an unknown store is a usage error", () => {
  assert.throws(() => makeStore("ipfs-magic", {}), /unknown store/);
});
