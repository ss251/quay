// Opt-in integration test against a local near-sandbox node:
//   QUAY_SANDBOX=1 node --test test/sandbox.test.mjs
// Needs the `near-sandbox` devDependency (it downloads a neard binary on first start; set
// NEAR_SANDBOX_BIN_PATH to reuse one) or QUAY_SANDBOX_MODULE=<path to near-sandbox/dist/esm/index.mjs>.
// Deploys cli/vendor/quay.wasm (v3), or QUAY_WASM=<path>. Run it through the shared lock, one sandbox at a time. With a v3 wasm it runs the whole product path:
// member joins through the relay server, posts through /relay into a site-paid collection.
// With a v2 wasm it checks everything that does not need v3 (reads, sign-in, delegates, inner-failure reporting).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { connect } from "../src/index.mjs";
import { createNearChain, createRelayServer } from "../src/relay-server.mjs";
import { verifySignIn } from "../src/verify.mjs";
import { base64Encode, encodeSignedDelegate, signDelegate } from "../src/encoding.mjs";

const on = process.env.QUAY_SANDBOX === "1";
const SITE = "quay-it.testnet";
const TGAS = 10n ** 12n;

const memStore = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
};

test("sandbox: relay server, member join, relayed writes and sign-in against a real node", { skip: !on && "set QUAY_SANDBOX=1", timeout: 300_000 }, async (t) => {
  const wasm = readFileSync(process.env.QUAY_WASM ?? new URL("../../cli/vendor/quay.wasm", import.meta.url));
  const { Sandbox, GenesisAccount } = await import(process.env.QUAY_SANDBOX_MODULE ? pathToFileURL(process.env.QUAY_SANDBOX_MODULE).href : "near-sandbox");
  const { Account, JsonRpcProvider, KeyPair, actions } = await import("near-api-js");

  const siteKey = KeyPair.fromRandom("ed25519");
  const sb = await Sandbox.start({
    config: { rpcPort: 3081, additionalAccounts: [new GenesisAccount(SITE, siteKey.getPublicKey().toString(), siteKey.toString(), 10n ** 27n)] },
  });
  t.after(() => sb.tearDown());
  const provider = new JsonRpcProvider({ url: sb.rpcUrl });
  const owner = new Account(SITE, provider, siteKey.toString());
  await owner.signAndSendTransaction({ receiverId: SITE, actions: [actions.deployContract(wasm), actions.functionCall("new", {}, 30n * TGAS, 0n)] });
  const version = await provider.callFunction({ contractId: SITE, method: "get_version", args: {} });
  const v3 = String(version?.version).startsWith("3.");

  // the relayer: its own sub-account, its balance is the spend limit
  const relayerKey = KeyPair.fromRandom("ed25519");
  const relayerId = `relay.${SITE}`;
  await owner.createSubAccount({ accountOrPrefix: relayerId, publicKey: relayerKey.getPublicKey(), nearToTransfer: 10n ** 25n });
  const chain = await createNearChain({ rpc: sb.rpcUrl, site: SITE, relayer: relayerId, secret: relayerKey.toString() });
  const logs = [];
  const server = createRelayServer({ site: SITE, relayer: relayerId, chain, log: (l) => logs.push(l) });
  const url = await server.listen(0);
  t.after(() => server.close());

  const health = await (await fetch(`${url}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(BigInt(health.balance) > 9n * 10n ** 24n, true);

  if (v3) {
    await owner.callFunction({ contractId: SITE, methodName: "set_collection", args: { name: "notes", rules: { write: "members", max_doc_bytes: 2048, moderated: true, payer: "site", max_docs_per_account: 5, on_add: null } }, gas: 30n * TGAS, deposit: 1n });
    await owner.callFunction({ contractId: SITE, methodName: "db_fund", args: {}, gas: 30n * TGAS, deposit: 10n ** 24n });
  } else {
    // v2 has no join: create the member the way /join would
  }

  const sessionStore = memStore();
  const member = connect({ site: SITE, rpc: sb.rpcUrl, relay: url, storage: sessionStore });
  let proof;
  if (v3) {
    proof = await member.auth.signIn({ mode: "member", name: "alice" });
    assert.equal(member.auth.account, `alice.${SITE}`);
    assert.ok(logs.some((l) => l.startsWith("join ") && l.endsWith(`alice.${SITE}`)));
    assert.equal(await member.members.isMember(`alice.${SITE}`), true);
    // joining the same name again: the contract's join callback returns false, the server answers 409
    const dup = await fetch(`${url}/join`, { method: "POST", body: JSON.stringify({ name: "alice", public_key: KeyPair.fromRandom("ed25519").getPublicKey().toString() }) });
    assert.equal(dup.status, 409);
    assert.equal((await dup.json()).error, "name_taken");
  } else {
    const kp = KeyPair.fromRandom("ed25519");
    await owner.createSubAccount({ accountOrPrefix: `alice.${SITE}`, publicKey: kp.getPublicKey(), nearToTransfer: 0n });
    sessionStore.setItem(`quay:${SITE}:session`, JSON.stringify({ name: "alice", accountId: `alice.${SITE}`, publicKey: kp.getPublicKey().toString(), secretKey: kp.toString(), active: true }));
    const resumed = connect({ site: SITE, rpc: sb.rpcUrl, relay: url, storage: sessionStore });
    proof = await resumed.auth.signIn({ mode: "member" });
    member.db = resumed.db;
    // /join on v2 reaches the chain and reports the contract's failure by name
    const res = await fetch(`${url}/join`, { method: "POST", body: JSON.stringify({ name: "bob", public_key: kp.getPublicKey().toString() }) });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "join_failed");
  }
  const verdict = await verifySignIn(proof, { site: SITE, rpc: sb.rpcUrl });
  assert.equal(verdict.ok, true, verdict.reason);

  if (v3) {
    const notes = member.db.collection("notes");
    const id = await notes.add({ text: "hello from a member with zero NEAR" });
    assert.match(id, /^\d+$/);
    const doc = await notes.get(id);
    assert.equal(doc.owner, `alice.${SITE}`);
    assert.equal(doc.data.text, "hello from a member with zero NEAR");
    await notes.update(id, { text: "edited" });
    assert.equal((await notes.get(id)).data.text, "edited");
    assert.equal((await notes.list({ limit: 10 })).docs.length, 1);
    await notes.remove(id);
    assert.equal(await notes.get(id), null);
    // a deposit is refused by the client before it reaches the relay
    await assert.rejects(notes.add({ a: 1 }, { deposit: 1n }), (e) => e.code === "deposit_needs_wallet");
  } else {
    await assert.rejects(member.db.collection("notes").add({ a: 1 }, { id: "x" }), /MethodNotFound/);
  }

  // the server refuses an owner-only method even when a real member key signs it
  const session = JSON.parse(sessionStore.getItem(`quay:${SITE}:session`));
  const head = (await provider.viewBlock({ finality: "final" })).header;
  const key = await provider.viewAccessKey({ accountId: session.accountId, publicKey: session.publicKey });
  const forged = await signDelegate(
    {
      senderId: session.accountId,
      receiverId: SITE,
      actions: [{ methodName: "set_collection", args: { name: "x", rules: {} }, gas: 10n * TGAS, deposit: 0n }],
      nonce: BigInt(key.nonce) + 1n,
      maxBlockHeight: BigInt(head.height) + 50n,
      publicKey: session.publicKey,
    },
    session.secretKey,
  );
  const refused = await fetch(`${url}/relay`, { method: "POST", body: JSON.stringify({ signed_delegate: base64Encode(encodeSignedDelegate(forged)) }) });
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).error, "method_not_allowed");
  assert.ok(logs.every((l) => !/ed25519:|secret/i.test(l)), "logs carry hashes and senders only");
});
