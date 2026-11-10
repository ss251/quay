// Relayed writes after the relayer stopped waiting for execution: the relayer
// answers once the transaction is included, and the client follows it on chain.
// Also OutLayer's synchronous window (408 + poll) and client-made doc ids.
import assert from "node:assert/strict";
import test from "node:test";

import { decodeSignedDelegate } from "../src/encoding.mjs";
import { connect, newDocId } from "../src/index.mjs";
import { SITE, rpcErr, viewResult } from "./helpers.mjs";

const mem = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};
const OL = { outlayer: { owner: SITE, project: "relay", paymentKey: "pk_test" } };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const fast = { pollMs: 1, sleep: async () => {} };

/**
 * A chain plus OutLayer. `relay(input, n)` answers the n-th relay call; `txStatus(params, n)`
 * answers EXPERIMENTAL_tx_status; docs relayed with an id appear after `landAfter` db_get reads.
 */
function world({ relay = () => ({ hash: "H1", status: "included" }), txStatus, landAfter = 1, calls: callAnswers = [] } = {}) {
  const s = { posts: [], polls: [], relayed: [], docs: new Map(), reads: 0, tx: 0 };
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (body?.jsonrpc) {
      const p = body.params;
      if (body.method === "block") return json({ result: { header: { height: 5000 } } });
      if (body.method === "EXPERIMENTAL_tx_status") {
        s.tx += 1;
        try {
          return json({ result: await (txStatus ?? (() => ({ status: { SuccessValue: "" }, receipts_outcome: [] })))(p, s.tx) });
        } catch (e) {
          return json({ error: e.rpcError });
        }
      }
      if (p.request_type === "view_access_key") return json({ result: { permission: "FullAccess", nonce: 41 } });
      if (p.method_name === "db_get") {
        const args = JSON.parse(atob(p.args_base64));
        s.reads += 1;
        const doc = s.docs.get(args.id);
        return json({ result: viewResult(doc && s.reads >= landAfter ? doc : null) });
      }
      if (p.method_name === "get_collection") return json({ result: viewResult({ name: "posts", on_add: "moderate" }) });
      return json({ result: viewResult(null) });
    }
    if (url.includes("/calls/")) {
      s.polls.push(url);
      return json(callAnswers.shift() ?? { status: "pending" });
    }
    s.posts.push(body.input);
    if (body.input.op === "join") return json({ status: "completed", output: { account: `alice.${SITE}`, hash: "J" } });
    const n = s.relayed.push(body.input.signed_delegate);
    const d = decodeSignedDelegate(Buffer.from(body.input.signed_delegate, "base64")).delegate;
    const args = JSON.parse(new TextDecoder().decode(d.actions[0].args));
    const answer = await relay(body.input, n);
    if (answer.land !== false && args.id) s.docs.set(args.id, { id: args.id, owner: d.senderId });
    if (answer.http) return json(answer.body, answer.http);
    if (answer.throw) throw answer.throw;
    return json({ call_id: `c${n}`, status: "completed", output: answer });
  };
  return { s, fetch };
}

async function member(w, extra = {}) {
  const quay = connect({ site: SITE, fetch: w.fetch, storage: mem(), relay: OL, ...fast, ...extra });
  await quay.auth.signIn({ mode: "member", name: "alice" });
  return quay;
}

test("newDocId: a letter then 9 base36 characters, never all digits, unique", () => {
  const ids = new Set(Array.from({ length: 2000 }, newDocId));
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9]{9}$/);
});

test("a relayed add returns its id once the doc can be read, while the trigger still runs", async () => {
  // tx_status keeps timing out (the on_add trigger is another OutLayer run): the doc decides
  const w = world({ txStatus: () => { throw rpcErr("TIMEOUT_ERROR"); }, landAfter: 2 });
  const quay = await member(w);
  const id = await quay.db.collection("posts").add({ title: "Fog at the pier" });
  assert.match(id, /^[a-z][a-z0-9]{9}$/);
  assert.equal(w.s.relayed.length, 1, "sent once");
  const d = decodeSignedDelegate(Buffer.from(w.s.relayed[0], "base64")).delegate;
  assert.equal(JSON.parse(new TextDecoder().decode(d.actions[0].args)).id, id);
});

test("a relayed add that fails on chain reports the failure", async () => {
  const w = world({ relay: () => ({ hash: "H1", status: "included", land: false }), txStatus: () => ({ status: { Failure: { ActionError: { kind: "doc id exists" } } }, receipts_outcome: [] }) });
  const quay = await member(w);
  await assert.rejects(quay.db.collection("posts").add({ t: 1 }, { id: "dup-1" }), (e) => e.code === "call_failed" && /doc id exists/.test(e.message));
});

test("a relayed add that never shows up times out as relay_timeout with the id, not a resend", async () => {
  const w = world({ relay: () => ({ hash: "H1", status: "pending", land: false }), txStatus: () => { throw rpcErr("UNKNOWN_TRANSACTION"); } });
  const quay = await member(w, { confirmMs: 30 });
  await assert.rejects(quay.db.collection("posts").add({ t: 1 }, { id: "keep-me" }), (e) => e.code === "relay_timeout" && /look it up/.test(e.message));
  assert.equal(w.s.relayed.length, 1);
});

test("OutLayer's synchronous window (408) is polled on /calls/{id}, never resent", async () => {
  const w = world({
    relay: (_input, n) => (n === 1 ? { http: 408, body: { error: "timed out", reason: "timeout", call_id: "c1", poll_url: "/calls/c1" } } : { hash: "H2" }),
    calls: [{ status: "pending" }, { call_id: "c1", status: "completed", output: { hash: "H1", status: "included" } }],
  });
  const quay = await member(w);
  const id = await quay.db.collection("posts").add({ t: 1 });
  assert.ok(id);
  assert.equal(w.s.relayed.length, 1, "the timed-out call was not sent again");
  assert.deepEqual(w.s.polls, ["https://testnet-api.outlayer.ai/calls/c1", "https://testnet-api.outlayer.ai/calls/c1"]);
});

test("a pending envelope (API restarted mid-call) is polled too", async () => {
  const w = world({
    relay: () => ({ http: 200, body: { call_id: "c9", status: "pending", poll_url: "/calls/c9" } }),
    calls: [{ call_id: "c9", status: "completed", output: { hash: "H9" } }],
  });
  const quay = await member(w);
  assert.ok(await quay.db.collection("posts").add({ t: 1 }));
  assert.equal(w.s.polls.length, 1);
});

test("an aborted relay request is relay_timeout; the add still answers if the doc landed", async () => {
  const abort = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  const landed = world({ relay: () => ({ throw: abort }) });
  const quay = await member(landed);
  assert.equal(await quay.db.collection("posts").add({ t: 1 }, { id: "post-a" }), "post-a");
  const lost = world({ relay: () => ({ throw: abort, land: false }) });
  const q2 = await member(lost);
  await assert.rejects(q2.db.collection("posts").add({ t: 1 }, { id: "post-b" }), (e) => e.code === "relay_timeout" && /posts\/post-b/.test(e.message));
});

test("relayed update and remove wait for the transaction and surface inner failures", async () => {
  const ok = world();
  const quay = await member(ok);
  await quay.db.collection("posts").update("p1", { t: 2 });
  assert.equal(ok.s.tx, 1);
  const bad = world({ txStatus: () => ({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: "not the owner" } } } } }] }) });
  const q2 = await member(bad);
  await assert.rejects(q2.db.collection("posts").remove("p1"), (e) => e.code === "call_failed" && /not the owner/.test(e.message));
});

test("relayer_busy resends the same signed delegate until the relayer has room", async () => {
  const w = world({ relay: (_input, n) => (n < 3 ? { error: "the relayer's free balance is held", code: "relayer_busy", land: false } : { hash: "H3", status: "included" }) });
  const quay = await member(w);
  const id = await quay.db.collection("posts").add({ t: 1 });
  assert.ok(id);
  assert.equal(w.s.relayed.length, 3);
  assert.equal(new Set(w.s.relayed).size, 1, "the very same delegate each time");
  const other = world({ relay: () => ({ error: "nope", code: "method_not_allowed", land: false }) });
  const q2 = await member(other);
  await assert.rejects(q2.db.collection("posts").add({ t: 1 }), (e) => e.code === "relay_refused" && e.reason === "method_not_allowed");
  assert.equal(other.s.relayed.length, 1);
});
