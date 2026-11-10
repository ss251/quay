// Opt-in integration test against a local near-sandbox node:
//   QUAY_SANDBOX=1 node --test test/sandbox.test.mjs
// Needs the `near-sandbox` package (npm i --no-save near-sandbox) or QUAY_SANDBOX_MODULE=<path to its index.mjs>.
// Deploys cli/vendor/quay.wasm (v2 today). Reads work now; v3 db calls fail with MethodNotFound until the v3 wasm is vendored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { connect } from "../src/index.mjs";
import { checkDelegate, memoryStore, relay } from "../src/relay-core.mjs";

const on = process.env.QUAY_SANDBOX === "1";
const ROOT_KEY = "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB"; // public sandbox default

test("sandbox: reads, explicit-key writes, member join and relayed writes against a real node", { skip: !on && "set QUAY_SANDBOX=1", timeout: 180_000 }, async (t) => {
  const mod = process.env.QUAY_SANDBOX_MODULE ? pathToFileURL(process.env.QUAY_SANDBOX_MODULE).href : "near-sandbox";
  const { Sandbox } = await import(mod);
  const { Account, JsonRpcProvider, KeyPair, actions } = await import("near-api-js");
  const sb = await Sandbox.start({ config: { rpcPort: 3041 } });
  t.after(() => sb.tearDown());

  const provider = new JsonRpcProvider({ url: sb.rpcUrl });
  const site = "sandbox";
  const root = new Account(site, provider, ROOT_KEY);
  await root.signAndSendTransaction({
    receiverId: site,
    actions: [actions.deployContract(readFileSync(new URL("../../cli/vendor/quay.wasm", import.meta.url))), actions.functionCall("new", {}, 30n * 10n ** 12n, 0n)],
  });
  const relayerKey = KeyPair.fromRandom("ed25519");
  await root.createSubAccount({ accountOrPrefix: `relay.${site}`, publicKey: relayerKey.getPublicKey(), nearToTransfer: 10n ** 25n });
  const relayer = new Account(`relay.${site}`, provider, relayerKey.toString());

  // reads over plain JSON-RPC
  const quay = connect({ site, rpc: sb.rpcUrl, relay: "http://relay.test", storage: memStore(), relayer: `relay.${site}` });
  const status = await quay.view("get_status", {});
  assert.ok(status);

  // explicit-key write path reaches the chain (v2 has no db_add, so the failure is MethodNotFound)
  const admin = connect({ site, rpc: sb.rpcUrl, key: { accountId: site, secretKey: ROOT_KEY } });
  await assert.rejects(admin.db.collection("posts").add({ a: 1 }), /db_add|MethodNotFound|method/i);

  // member flow: /join creates alice.sandbox, /relay applies the policy and sends it from the relayer
  const real = globalThis.fetch;
  const front = async (url, init) => {
    const u = new URL(url);
    if (u.host !== "relay.test") return real(url, init);
    const body = JSON.parse(init.body);
    const reply = (status, b) => ({ ok: status < 400, status, json: async () => b });
    if (u.pathname === "/join") {
      await root.createSubAccount({ accountOrPrefix: `${body.name}.${site}`, publicKey: body.public_key, nearToTransfer: 0n });
      return reply(200, { account: `${body.name}.${site}`, hash: "-" });
    }
    const head = (await provider.viewBlock({ finality: "final" })).header;
    const verdict = await checkDelegate(body.signed_delegate, { site, store: memoryStore() }, { ms: Date.now(), height: head.height });
    if (!verdict.ok) return reply(422, { error: verdict.code });
    try {
      const out = await relay(verdict.bytes, { account: relayer });
      return reply(200, { hash: out.hash });
    } catch (e) {
      return reply(502, { error: e.message });
    }
  };
  const member = connect({ site, rpc: sb.rpcUrl, relay: "http://relay.test", fetch: front, storage: memStore() });
  const proof = await member.auth.signIn({ mode: "member", name: "alice" });
  assert.equal(member.auth.account, `alice.${site}`);
  const { verifySignIn } = await import("../src/verify.mjs");
  const verdict = await verifySignIn(proof, { site, rpc: sb.rpcUrl });
  assert.equal(verdict.ok, true, verdict.reason);

  // the delegate is valid and relayed; v2 lacks db_add, so the inner receipt fails and relay() must say so
  await assert.rejects(member.db.collection("posts").add({ a: 1 }, { id: "x" }), /MethodNotFound/);
});

function memStore() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}
