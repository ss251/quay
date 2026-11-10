// quay functions, quay secrets, quay relay deploy, and the OutLayer client,
// against a fake chain, a fake OutLayer API and a fake keystore.
import assert from "node:assert/strict";
import {
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { run } from "../src/app.mjs";
import { deployFunctions, normalizeSpec } from "../src/functions.mjs";
import {
  createOutlayer,
  encryptSecrets,
  fastfsPayload,
  fastfsUrl,
  parsePaymentKey,
  PLACEHOLDER,
} from "../src/outlayer.mjs";
import { deployRelay } from "../src/relay.mjs";
import { parseArgs } from "../src/text.mjs";
import { baseCtx, fakeChain, streams, tempDir, writeTree } from "./helpers.mjs";

const SITE = "board.testnet";
const SECRET_VALUE = "sk-live-THIS-MUST-NEVER-LEAK-0123456789";
const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 7, 7, 7]);
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** A keystore whose private key the test holds, so ciphertext can be checked. */
function keystore() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return {
    hex: raw.toString("hex"),
    decrypt(b64) {
      const blob = Buffer.from(b64, "base64");
      assert.equal(blob[0], 1);
      const eph = blob.subarray(1, 33);
      const nonce = blob.subarray(33, 45);
      const body = blob.subarray(45);
      const shared = diffieHellman({
        privateKey,
        publicKey: createPublicKey({
          key: { kty: "OKP", crv: "X25519", x: eph.toString("base64url") },
          format: "jwk",
        }),
      });
      const key = Buffer.from(
        hkdfSync(
          "sha256",
          shared,
          Buffer.alloc(0),
          Buffer.from("outlayer-keystore-v1"),
          32,
        ),
      );
      const d = createDecipheriv("chacha20-poly1305", key, nonce, {
        authTagLength: 16,
      });
      d.setAuthTag(body.subarray(body.length - 16));
      return Buffer.concat([
        d.update(body.subarray(0, body.length - 16)),
        d.final(),
      ]).toString("utf8");
    },
  };
}

/** Fake OutLayer: chain views/calls plus the HTTPS API and FastFS. */
function fakeOutlayer({ fnSupport = false } = {}) {
  const ks = keystore();
  const state = {
    projects: new Map(),
    rows: new Map(),
    fastfs: new Map(),
    nonce: 1,
    registered: false,
  };
  const calls = [];
  const requests = [];
  const near = {
    async view(contract, method, args) {
      if (method === "get_project")
        return state.projects.get(args.project_id) ?? null;
      if (method === "list_user_projects") return [...state.projects.values()];
      if (method === "estimate_storage_cost") return "5000000000000000000000";
      if (method === "estimate_execution_cost") return "1000000000000000000000";
      if (method === "get_next_payment_key_nonce") return state.nonce;
      if (method === "get_secrets") {
        const id = args.accessor.Project?.project_id;
        return state.rows.get(id) ?? null;
      }
      if (method === "storage_balance_of")
        return state.registered ? { total: "1" } : null;
      throw new Error(`unexpected view ${contract}.${method}`);
    },
    async call(receiver, method, args, opts = {}) {
      calls.push({ receiver, method, args, ...opts });
      const hash = `tx${calls.length}`;
      if (method === "__fastdata_fastfs") {
        const bytes = Buffer.from(args);
        const len = bytes.readUInt32LE(1);
        const rel = bytes.subarray(5, 5 + len).toString();
        state.fastfs.set(rel, bytes.subarray(bytes.length - WASM.length));
      }
      if (method === "create_project") {
        const id = `${SITE}/${args.name}`;
        state.projects.set(id, {
          name: args.name,
          project_id: id,
          active_version: args.source.WasmUrl.hash,
        });
      }
      if (method === "add_version") {
        const p = state.projects.get(`${SITE}/${args.project_name}`);
        p.active_version = args.source.WasmUrl.hash;
      }
      if (method === "delete_project")
        state.projects.delete(`${SITE}/${args.project_name}`);
      if (method === "store_secrets" && args.accessor.Project)
        state.rows.set(args.accessor.Project.project_id, {
          updated_at: "1794392430456000000",
          access: args.access,
        });
      if (method === "store_secrets" && args.accessor.System) state.nonce += 1;
      if (method === "delete_secrets")
        state.rows.delete(args.accessor.Project.project_id);
      if (method === "storage_deposit") state.registered = true;
      return { hash, failures: [], logs: [], value: null };
    },
  };
  const fetch = async (url, init = {}) => {
    requests.push({ url, init });
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.endsWith("/secrets/pubkey")) return json({ pubkey: ks.hex });
    if (url.startsWith("https://test.fastfs.io/")) {
      const rel = url.split("/").at(-1);
      const bytes = state.fastfs.get(rel);
      return bytes
        ? new Response(bytes)
        : new Response("not found", { status: 404 });
    }
    if (url.includes("/call/")) {
      if (state.failCall) return json({ error: "insufficient balance" }, 402);
      const body = JSON.parse(init.body);
      return json({
        call_id: "c-1",
        status: "completed",
        output: { echo: body.input, secrets: Boolean(body.secrets_ref) },
        compute_cost: "1001",
        time_ms: 1200,
        attestation_url: "/attestations/by-call/c-1",
      });
    }
    if (url.includes("/usage"))
      return json({ calls: [{ project_id: `${SITE}/preview`, cost: "1001" }] });
    if (url.includes("/balance")) return json({ balance: "49000" });
    return json({ error: "unknown" }, 404);
  };
  const client = createOutlayer({
    account: SITE,
    near,
    fetch,
    sleep: async () => {},
  });
  return { client, calls, requests, state, ks, fnSupport };
}

function everythingSent(fake) {
  return JSON.stringify({
    calls: fake.calls.map((c) => ({
      ...c,
      args:
        c.args instanceof Uint8Array
          ? Buffer.from(c.args).toString("latin1")
          : c.args,
      gas: String(c.gas),
      deposit: String(c.deposit),
    })),
    requests: fake.requests.map((r) => ({
      url: r.url,
      body: r.init.body ?? null,
      headers: r.init.headers ?? null,
    })),
  });
}

function fnChain(fnSupport) {
  const chain = fakeChain();
  const view = chain.view.bind(chain);
  const send = chain.send.bind(chain);
  chain.fns = new Map();
  chain.view = async (method, args) => {
    if (method === "fn_list") {
      if (!fnSupport) throw new Error("MethodNotFound");
      return [...chain.fns.entries()].map(([name, spec]) => ({
        name,
        ...spec,
      }));
    }
    if (method === "fn_get") return chain.fns.get(args.name) ?? null;
    if (method === "fn_results")
      return {
        docs: [
          {
            id: `${args.query.prefix}1`,
            data: { ok: true, output: { title: "x" } },
          },
        ],
        next: null,
      };
    return view(method, args);
  };
  chain.send = async (method, args, options = {}) => {
    const sent = await send(method, args, options);
    if (method === "fn_set") chain.fns.set(args.name, args.spec);
    if (method === "fn_call")
      return { ...sent, value: JSON.stringify({ hide: false }) };
    return sent;
  };
  return chain;
}

async function exec(
  argv,
  {
    fake = fakeOutlayer(),
    chain = fnChain(false),
    ctx = {},
    credentialsDir = tempDir(),
  } = {},
) {
  const io = streams();
  const secrets = [];
  const full = baseCtx(io, {
    chain,
    outlayer: fake.client,
    credentialsDir,
    secrets,
    buildFunction: async (dir) => ({ path: join(dir, "x.wasm"), bytes: WASM }),
    ...ctx,
  });
  const parsed = parseArgs(argv);
  full.json = Boolean(parsed.flags.json);
  full.dryRun = Boolean(parsed.flags["dry-run"]);
  full.yes = true;
  let error = null;
  try {
    await run(full, parsed);
  } catch (e) {
    error = e;
  }
  return { io, chain, fake, error, credentialsDir, ctx: full };
}

// ---------- OutLayer client ----------

test("encryptSecrets produces ECIES v1 the keystore can open", () => {
  const ks = keystore();
  const blob = encryptSecrets(ks.hex, JSON.stringify({ A: "1" }));
  assert.equal(ks.decrypt(blob), '{"A":"1"}');
  assert.throws(() => encryptSecrets("nope", "x"), /no usable key/);
});

test("storeSecrets sends placeholders to /secrets/pubkey and only ciphertext on chain", async () => {
  const fake = fakeOutlayer();
  await fake.client.storeSecrets("moderate", { MOD_API_KEY: SECRET_VALUE });
  const pub = fake.requests.find((r) => r.url.endsWith("/secrets/pubkey"));
  const body = JSON.parse(pub.init.body);
  assert.deepEqual(JSON.parse(body.secrets_json), { MOD_API_KEY: PLACEHOLDER });
  assert.deepEqual(body.accessor, {
    type: "Project",
    project_id: `${SITE}/moderate`,
  });
  assert.equal(body.profile, "default");
  const store = fake.calls.find((c) => c.method === "store_secrets");
  assert.deepEqual(store.args.accessor, {
    Project: { project_id: `${SITE}/moderate` },
  });
  assert.deepEqual(store.args.access, {
    Predecessor: { condition: { Whitelist: { accounts: [SITE] } } },
  });
  assert.equal(store.args.vault_id, null);
  assert.equal(
    store.deposit,
    5_000_000_000_000_000_000_000n + 1_000_000_000_000_000_000_000n,
  );
  assert.deepEqual(
    JSON.parse(fake.ks.decrypt(store.args.encrypted_secrets_base64)),
    { MOD_API_KEY: SECRET_VALUE },
  );
  assert.ok(
    !everythingSent(fake).includes(SECRET_VALUE),
    "a secret value left the process in clear",
  );
});

test("upload sends a FastFS payload with gas 1 and waits for the served hash", async () => {
  const fake = fakeOutlayer();
  const up = await fake.client.upload(WASM);
  assert.equal(up.sha256, sha(WASM));
  assert.equal(up.url, fastfsUrl(SITE, sha(WASM)));
  const call = fake.calls[0];
  assert.equal(call.method, "__fastdata_fastfs");
  assert.equal(call.gas, 1n);
  assert.equal(call.allowFailure, true);
  assert.deepEqual(
    Buffer.from(call.args),
    Buffer.from(fastfsPayload(WASM, `${sha(WASM)}.wasm`)),
  );
  const again = await fake.client.upload(WASM);
  assert.equal(again.reused, true);
  assert.equal(fake.calls.length, 1);
});

test("deployProject creates, then adds a version, then leaves an unchanged build alone", async () => {
  const fake = fakeOutlayer();
  const first = await fake.client.deployProject("preview", {
    url: "https://x/a.wasm",
    sha256: "a".repeat(64),
  });
  assert.equal(first.created, true);
  assert.deepEqual(fake.calls[0].args.source, {
    WasmUrl: {
      url: "https://x/a.wasm",
      hash: "a".repeat(64),
      build_target: "wasm32-wasip2",
    },
  });
  const second = await fake.client.deployProject("preview", {
    url: "https://x/b.wasm",
    sha256: "b".repeat(64),
  });
  assert.equal(fake.calls[1].method, "add_version");
  assert.equal(fake.calls[1].args.set_active, true);
  assert.equal(second.created, false);
  const third = await fake.client.deployProject("preview", {
    url: "https://x/b.wasm",
    sha256: "b".repeat(64),
  });
  assert.equal(third.unchanged, true);
  assert.equal(fake.calls.length, 2);
});

test("createPaymentKey saves before storing and never sends the key in clear", async () => {
  const fake = fakeOutlayer();
  let saved = null;
  const made = await fake.client.createPaymentKey({
    projects: [`${SITE}/preview`],
    maxPerCall: "10000",
    save: async (key) => {
      saved = key;
      assert.equal(fake.calls.length, 0, "saved after the transaction");
    },
  });
  assert.equal(saved, made.key);
  const secret = parsePaymentKey(made.key).secret;
  const pub = JSON.parse(fake.requests[0].init.body);
  assert.deepEqual(pub.accessor, { type: "System", PaymentKey: {} });
  assert.equal(JSON.parse(pub.secrets_json).key, "0".repeat(64));
  const store = fake.calls[0];
  assert.deepEqual(store.args.accessor, { System: "PaymentKey" });
  assert.equal(store.args.profile, "1");
  const blob = JSON.parse(fake.ks.decrypt(store.args.encrypted_secrets_base64));
  assert.deepEqual(blob, {
    key: secret,
    project_ids: [`${SITE}/preview`],
    max_per_call: "10000",
    initial_balance: "0",
  });
  assert.ok(!everythingSent(fake).includes(secret));
});

test("topUp registers, mints test USDC and credits the key", async () => {
  const fake = fakeOutlayer();
  await fake.client.topUp(3, 50000n);
  assert.deepEqual(
    fake.calls.map((c) => `${c.receiver}.${c.method}`),
    [
      "usdc.fakes.testnet.storage_deposit",
      "usdc.fakes.testnet.mint",
      "usdc.fakes.testnet.ft_transfer_call",
    ],
  );
  const t = fake.calls[2];
  assert.equal(t.deposit, 1n);
  assert.deepEqual(t.args, {
    receiver_id: "outlayer.testnet",
    amount: "50000",
    msg: '{"action":"top_up_payment_key","nonce":3}',
  });
});

test("callHttps sends the payment key header and secrets_ref, and errors never carry the key", async () => {
  const fake = fakeOutlayer();
  const key = `${SITE}:1:${"ab".repeat(32)}`;
  const res = await fake.client.callHttps(
    "preview",
    { url: "https://a" },
    { paymentKey: key },
  );
  assert.deepEqual(res.output, { echo: { url: "https://a" }, secrets: true });
  const req = fake.requests[0];
  assert.equal(req.url, `https://testnet-api.outlayer.ai/call/${SITE}/preview`);
  assert.equal(req.init.headers["x-payment-key"], key);
  assert.deepEqual(JSON.parse(req.init.body).secrets_ref, {
    profile: "default",
    account_id: SITE,
  });
  fake.state.failCall = true;
  await assert.rejects(
    () => fake.client.callHttps("preview", {}, { paymentKey: key }),
    (e) =>
      /HTTP 402: insufficient balance/.test(e.message) &&
      !e.message.includes("abab"),
  );
  assert.throws(() => parsePaymentKey("nope"), /owner:nonce:secret/);
});

// ---------- quay secrets ----------

test("secrets set reads the value from stdin, stores it encrypted, prints only names", async () => {
  const credentialsDir = tempDir();
  const r = await exec(["secrets", "set", "MOD_API_KEY", "--fn", "moderate"], {
    credentialsDir,
    ctx: { stdin: Readable.from([`${SECRET_VALUE}\n`]) },
  });
  assert.equal(r.error, null);
  const store = r.fake.calls.find((c) => c.method === "store_secrets");
  assert.deepEqual(
    JSON.parse(r.fake.ks.decrypt(store.args.encrypted_secrets_base64)),
    { MOD_API_KEY: SECRET_VALUE },
  );
  assert.match(r.io.text(), /stored MOD_API_KEY for board\.testnet\/moderate/);
  for (const out of [r.io.text(), r.io.err(), everythingSent(r.fake)])
    assert.ok(!out.includes(SECRET_VALUE));
  const ledger = JSON.parse(
    readFileSync(join(credentialsDir, `${SITE}.quay-secrets.json`), "utf8"),
  );
  assert.deepEqual(ledger.moderate.names, ["MOD_API_KEY"]);
  assert.ok(!JSON.stringify(ledger).includes(SECRET_VALUE));
  assert.equal(
    statSync(join(credentialsDir, `${SITE}.quay-secrets.json`)).mode & 0o777,
    0o600,
  );
  assert.ok(
    r.ctx.secrets.includes(SECRET_VALUE),
    "value is registered for redaction",
  );

  // a second set that would drop MOD_API_KEY is refused, --replace allows it
  const again = await exec(["secrets", "set", "OTHER", "--fn", "moderate"], {
    credentialsDir,
    fake: r.fake,
    ctx: { stdin: Readable.from(["v2-value-xyz"]) },
  });
  assert.match(again.error.message, /also holds MOD_API_KEY/);
  const both = await exec(
    ["secrets", "set", "MOD_API_KEY", "MOD_API_URL", "--fn", "moderate"],
    {
      credentialsDir,
      fake: r.fake,
      ctx: {
        stdin: Readable.from([
          `${SECRET_VALUE}\nhttps://mod.example/v1/moderations\n`,
        ]),
      },
    },
  );
  assert.equal(both.error, null);
  const last = both.fake.calls
    .filter((c) => c.method === "store_secrets")
    .at(-1);
  assert.deepEqual(
    JSON.parse(both.fake.ks.decrypt(last.args.encrypted_secrets_base64)),
    {
      MOD_API_KEY: SECRET_VALUE,
      MOD_API_URL: "https://mod.example/v1/moderations",
    },
  );
});

test("secrets set refuses values on the command line and bad names", async () => {
  const r = await exec([
    "secrets",
    "set",
    `MOD_API_KEY=${SECRET_VALUE}`,
    "--fn",
    "moderate",
  ]);
  assert.match(r.error.message, /never go on the command line/);
  assert.ok(!r.error.message.includes(SECRET_VALUE));
  assert.equal(r.fake.calls.length, 0);
  assert.match(
    (await exec(["secrets", "set", "lower", "--fn", "x"])).error.message,
    /not a secret name/,
  );
  const empty = await exec(["secrets", "set", "A", "--fn", "x"], {
    ctx: { stdin: Readable.from(["\n"]) },
  });
  assert.match(empty.error.message, /empty/);
  const lines = await exec(["secrets", "set", "A", "B", "--fn", "x"], {
    ctx: { stdin: Readable.from(["one\n"]) },
  });
  assert.match(lines.error.message, /1 lines for 2 names/);
});

test("secrets set picks functions from quay.json and errors keep values out", async () => {
  const root = writeTree(tempDir(), {
    "quay.json": JSON.stringify({
      account: SITE,
      functions: {
        moderate: { dir: "fn/moderate", secrets: ["MOD_API_KEY"] },
        preview: {},
      },
    }),
  });
  const fake = fakeOutlayer();
  fake.client.storeSecrets = async () => {
    throw new Error("store_secrets failed");
  };
  const r = await exec(["secrets", "set", "MOD_API_KEY"], {
    fake,
    ctx: {
      config: { account: SITE, rpc: "x", path: join(root, "quay.json") },
      readSecret: async () => SECRET_VALUE,
    },
  });
  assert.match(r.error.message, /store_secrets failed/);
  assert.ok(!r.error.message.includes(SECRET_VALUE));
  assert.ok(
    !r.io.text().includes(SECRET_VALUE) && !r.io.err().includes(SECRET_VALUE),
  );
});

test("secrets list shows names only; rm deletes the profile", async () => {
  const credentialsDir = tempDir();
  const fake = fakeOutlayer();
  await exec(["secrets", "set", "MOD_API_KEY", "--fn", "moderate"], {
    credentialsDir,
    fake,
    ctx: { readSecret: async () => SECRET_VALUE },
  });
  const listed = await exec(["secrets", "list", "--json"], {
    credentialsDir,
    fake,
  });
  const out = JSON.parse(listed.io.text());
  assert.deepEqual(out.secrets.find((s) => s.fn === "moderate").names, [
    "MOD_API_KEY",
  ]);
  assert.equal(out.secrets.find((s) => s.fn === "moderate").stored, true);
  assert.ok(!listed.io.text().includes(SECRET_VALUE));
  const removed = await exec(["secrets", "rm", "--fn", "moderate"], {
    credentialsDir,
    fake,
  });
  assert.equal(removed.error, null);
  assert.equal(fake.calls.at(-1).method, "delete_secrets");
  assert.equal(fake.state.rows.size, 0);
});

// ---------- quay functions ----------

test("normalizeSpec fills defaults and rejects unknown keys", () => {
  assert.deepEqual(normalizeSpec("preview", {}), {
    dir: "functions/preview",
    call: "anyone",
    payer: "caller",
    secrets: [],
    store: "fastfs",
    deposit: "5000000000000000000000",
    max_instructions: "2000000000",
    max_seconds: 30,
  });
  assert.throws(
    () => normalizeSpec("preview", { dri: "x" }),
    /unknown key dri/,
  );
  assert.throws(() => normalizeSpec("Bad Name", {}), /not a function name/);
  assert.throws(() => normalizeSpec("p", { payer: "me" }), /payer/);
});

test("functions deploy uploads to FastFS and registers; fn_set is pending without contract support", async () => {
  const dir = tempDir();
  const r = await exec([
    "functions",
    "deploy",
    dir,
    "--name",
    "preview",
    "--json",
  ]);
  assert.equal(r.error, null);
  const out = JSON.parse(r.io.text());
  assert.equal(out.project, `${SITE}/preview`);
  assert.equal(out.sha256, sha(WASM));
  assert.equal(out.wasm_url, fastfsUrl(SITE, sha(WASM)));
  assert.equal(out.registered, "pending");
  assert.deepEqual(
    r.fake.calls.map((c) => c.method),
    ["__fastdata_fastfs", "create_project"],
  );
  assert.equal(r.chain.calls.length, 0);
});

test("functions deploy calls fn_set with the FunctionSpec when the contract has it", async () => {
  const root = writeTree(tempDir(), {
    "quay.json": JSON.stringify({
      account: SITE,
      functions: {
        moderate: {
          dir: "fn/moderate",
          call: "members",
          payer: "site",
          secrets: ["MOD_API_KEY"],
        },
      },
    }),
  });
  const chain = fnChain(true);
  const r = await exec(["functions", "deploy", "moderate", "--json"], {
    chain,
    ctx: { config: { account: SITE, rpc: "x", path: join(root, "quay.json") } },
  });
  assert.equal(r.error, null);
  const out = JSON.parse(r.io.text());
  assert.equal(out.registered, true);
  assert.deepEqual(out.missing_secrets, ["MOD_API_KEY"]);
  const fnSet = chain.calls.find((c) => c.method === "fn_set");
  assert.equal(fnSet.deposit, 1n);
  assert.deepEqual(fnSet.args, {
    name: "moderate",
    spec: {
      project: `${SITE}/moderate`,
      call: "members",
      payer: "site",
      deposit: "5000000000000000000000",
      max_instructions: "2000000000",
      max_seconds: 30,
      secrets: true,
    },
  });
});

test("deployFunctions (quay up) returns one result per function", async () => {
  const io = streams();
  const fake = fakeOutlayer();
  const ctx = baseCtx(io, {
    chain: fnChain(false),
    outlayer: fake.client,
    credentialsDir: tempDir(),
    cwd: tempDir(),
    buildFunction: async () => ({ path: "x.wasm", bytes: WASM }),
  });
  const results = await deployFunctions(ctx, {
    preview: {},
    digest: { call: "owner" },
  });
  assert.deepEqual(
    results.map((r) => [r.name, r.project, r.sha256]),
    [
      ["preview", `${SITE}/preview`, sha(WASM)],
      ["digest", `${SITE}/digest`, sha(WASM)],
    ],
  );
  assert.ok(results.every((r) => r.wasm_url && "hash" in r));
});

test("functions key saves an owner-only key file and never prints the key", async () => {
  const credentialsDir = tempDir();
  const fake = fakeOutlayer();
  fake.state.projects.set(`${SITE}/preview`, {
    name: "preview",
    project_id: `${SITE}/preview`,
  });
  const r = await exec(["functions", "key", "--usd", "0.02", "--json"], {
    credentialsDir,
    fake,
  });
  assert.equal(r.error, null);
  const out = JSON.parse(r.io.text());
  assert.deepEqual(out.projects, [`${SITE}/preview`]);
  assert.equal(out.usd, "20000");
  const file = join(credentialsDir, `${SITE}.paykey-1.json`);
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const secret = parsePaymentKey(saved.key).secret;
  assert.ok(!r.io.text().includes(secret) && !r.io.err().includes(secret));
  assert.ok(!everythingSent(fake).includes(secret));
  assert.deepEqual(saved.projects, [`${SITE}/preview`]);
});

test("functions invoke goes over HTTPS with the saved key when the contract has no fn_call", async () => {
  const credentialsDir = tempDir();
  const fake = fakeOutlayer();
  fake.state.projects.set(`${SITE}/preview`, {
    name: "preview",
    project_id: `${SITE}/preview`,
  });
  await exec(["functions", "key"], { credentialsDir, fake });
  const r = await exec(
    [
      "functions",
      "invoke",
      "preview",
      '{"url":"https://example.com"}',
      "--json",
    ],
    { credentialsDir, fake },
  );
  assert.equal(r.error, null);
  const out = JSON.parse(r.io.text());
  assert.equal(out.mode, "https");
  assert.deepEqual(out.output.echo, { url: "https://example.com" });
  assert.equal(out.output.secrets, false, "no secret row, no secrets_ref");
  assert.equal(
    out.attestation_url,
    "https://testnet-api.outlayer.ai/attestations/by-call/c-1",
  );
  const none = await exec(["functions", "invoke", "preview", "{}"], { fake });
  assert.match(none.error.message, /no payment key/);
});

test("functions invoke uses fn_call when the contract has functions", async () => {
  const chain = fnChain(true);
  chain.fns.set("moderate", {
    project: `${SITE}/moderate`,
    payer: "caller",
    deposit: "5000000000000000000000",
  });
  const r = await exec(
    ["functions", "invoke", "moderate", '{"data":{"title":"hi"}}', "--json"],
    { chain },
  );
  assert.equal(r.error, null);
  const out = JSON.parse(r.io.text());
  assert.equal(out.mode, "contract");
  assert.deepEqual(out.output, { hide: false });
  const call = chain.calls.find((c) => c.method === "fn_call");
  assert.deepEqual(call.args, {
    name: "moderate",
    input: '{"data":{"title":"hi"}}',
  });
  assert.equal(call.deposit, 5_000_000_000_000_000_000_000n);
});

test("functions list, logs and rm", async () => {
  const credentialsDir = tempDir();
  const fake = fakeOutlayer();
  await exec(["functions", "deploy", tempDir(), "--name", "preview"], {
    fake,
    credentialsDir,
  });
  await exec(["functions", "key"], { credentialsDir, fake });
  const listed = JSON.parse(
    (await exec(["functions", "list", "--json"], { fake })).io.text(),
  );
  assert.deepEqual(
    listed.functions.map((f) => [f.name, f.registered]),
    [["preview", "pending"]],
  );
  const logs = JSON.parse(
    (
      await exec(["functions", "logs", "preview", "--json"], {
        fake,
        credentialsDir,
      })
    ).io.text(),
  );
  assert.equal(logs.results, null);
  assert.equal(logs.usage[0].usage.calls[0].cost, "1001");
  const withContract = JSON.parse(
    (
      await exec(["functions", "logs", "preview", "--json"], {
        fake,
        credentialsDir,
        chain: fnChain(true),
      })
    ).io.text(),
  );
  assert.equal(withContract.results[0].id, "preview-1");
  const removed = await exec(["functions", "rm", "preview"], {
    fake,
    credentialsDir,
  });
  assert.equal(removed.error, null);
  assert.equal(fake.calls.at(-1).method, "delete_project");
  assert.equal(fake.state.projects.size, 0);
});

// ---------- quay relay deploy ----------

test("deployRelay stores RELAY_KEY from the key file encrypted and never prints it", async () => {
  const credentialsDir = tempDir();
  const relayKey =
    "ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr";
  writeTree(credentialsDir, {
    [`relay.${SITE}.json`]: JSON.stringify({
      account_id: `relay.${SITE}`,
      public_key: "ed25519:x",
      private_key: relayKey,
    }),
  });
  const fake = fakeOutlayer();
  const io = streams();
  const ctx = baseCtx(io, {
    chain: fnChain(false),
    outlayer: fake.client,
    credentialsDir,
    secrets: [],
    buildFunction: async (dir) => {
      assert.match(dir, /functions[/\\]relay$/);
      return { path: "relay.wasm", bytes: WASM };
    },
  });
  ctx.chain = fnChain(true);
  const r = await deployRelay(ctx, { host: "outlayer", methods: ["db_add"] });
  assert.equal(r.registered, "not registered");
  assert.equal(ctx.chain.calls.filter((c) => c.method === "fn_set").length, 0);
  assert.equal(r.project, `${SITE}/relay`);
  assert.equal(r.relayer, `relay.${SITE}`);
  const store = fake.calls.find((c) => c.method === "store_secrets");
  const opened = JSON.parse(
    fake.ks.decrypt(store.args.encrypted_secrets_base64),
  );
  assert.deepEqual(Object.keys(opened).sort(), [
    "RELAY_ACCOUNT",
    "RELAY_KEY",
    "RELAY_POLICY",
  ]);
  assert.equal(opened.RELAY_KEY, relayKey);
  assert.deepEqual(JSON.parse(opened.RELAY_POLICY), { methods: ["db_add"] });
  assert.ok(!everythingSent(fake).includes(relayKey));
  assert.ok(!JSON.stringify(r).includes(relayKey));
  assert.ok(!io.text().includes(relayKey) && !io.err().includes(relayKey));
  assert.ok(ctx.secrets.includes(relayKey));

  const missing = await exec(["relay", "deploy"], {
    fake,
    credentialsDir: tempDir(),
  });
  assert.match(missing.error.message, /no key for relay\.board\.testnet/);
});
