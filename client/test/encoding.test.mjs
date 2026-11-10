import { test } from "node:test";
import assert from "node:assert/strict";
import { deserialize } from "borsh";
import { SCHEMA } from "near-api-js";
import * as n413 from "near-api-js/nep413";
import {
  base58Decode, base58Encode, base64Encode, decodeSignedDelegate, delegateHash, encodeDelegateAction,
  nep413Hash, nep413Sign, nep413Verify, randomBytes, NEP413_TAG, NEP461_TAG, parseSecretKey,
} from "../src/encoding.mjs";
import { Account, KeyPairSigner, JsonRpcProvider, buildDelegateAction, actions, encodeSignedDelegate, memberKey, mkDelegate, MEMBER, SITE } from "./helpers.mjs";

test("tags", () => {
  assert.equal(NEP413_TAG, 2147484061);
  assert.equal(NEP461_TAG, 1073742190);
});

test("base58 round trips and matches near-api-js key text", async () => {
  const k = await memberKey();
  assert.equal(k.pub, k.kp.getPublicKey().toString());
  assert.equal(k.secretKey, k.kp.toString());
  for (const len of [1, 5, 32, 64]) {
    const b = randomBytes(len);
    assert.deepEqual(base58Decode(base58Encode(b)), b);
  }
  assert.deepEqual(base58Decode(base58Encode(Uint8Array.of(0, 0, 7))), Uint8Array.of(0, 0, 7));
  assert.throws(() => base58Decode("0OIl"));
});

test("signed delegate bytes equal near-api-js byte for byte", async () => {
  const k = await memberKey();
  const signer = new KeyPairSigner(k.kp);
  const cases = [
    { method: "db_add", args: { collection: "posts", data: '{"t":"héllo"}' }, gas: 10n * 10n ** 12n, deposit: 0n },
    { method: "db_remove", args: { collection: "posts", id: "1" }, gas: 100n * 10n ** 12n, deposit: 0n },
    { method: "db_add", args: { a: 1 }, gas: 1n, deposit: 10n ** 24n },
  ];
  for (const c of cases) {
    const theirs = buildDelegateAction({
      senderId: MEMBER, receiverId: SITE, nonce: 77n, maxBlockHeight: 123456789n,
      publicKey: await signer.getPublicKey(), actions: [actions.functionCall(c.method, c.args, c.gas, c.deposit)],
    });
    const { signedDelegate } = await signer.signDelegateAction(theirs);
    const theirBytes = encodeSignedDelegate(signedDelegate);
    const mine = await mkDelegate(k, {
      nonce: 77n, maxBlockHeight: 123456789n,
      actions: [{ methodName: c.method, args: c.args, gas: c.gas, deposit: c.deposit }],
    });
    assert.deepEqual(Buffer.from(mine.bytes), Buffer.from(theirBytes), "serialized signed delegate");
    // ed25519 is deterministic, so the signatures must also be equal
    assert.deepEqual(Buffer.from(mine.signed.signature), Buffer.from(signedDelegate.signature.ed25519Signature.data));
  }
});

test("near-api-js decodes our delegate and verifies our signature", async () => {
  const k = await memberKey();
  const mine = await mkDelegate(k);
  const sd = deserialize(SCHEMA.SignedDelegate, mine.bytes);
  assert.equal(sd.delegateAction.senderId, MEMBER);
  assert.equal(sd.delegateAction.receiverId, SITE);
  assert.equal(sd.delegateAction.actions[0].functionCall.methodName, "db_add");
  assert.deepEqual(Buffer.from(sd.delegateAction.publicKey.ed25519Key.data), Buffer.from(k.publicKey));
  const hash = await delegateHash(mine.delegate);
  assert.equal(k.kp.getPublicKey().verify(hash, Uint8Array.from(sd.signature.ed25519Signature.data)), true);
});

test("our decoder reads what near-api-js produced, and rejects other actions without parsing them", async () => {
  const k = await memberKey();
  const signer = new KeyPairSigner(k.kp);
  const da = buildDelegateAction({
    senderId: MEMBER, receiverId: SITE, nonce: 9n, maxBlockHeight: 99n, publicKey: await signer.getPublicKey(),
    actions: [actions.functionCall("db_add", { x: 1 }, 5n, 0n)],
  });
  const { signedDelegate } = await signer.signDelegateAction(da);
  const dec = decodeSignedDelegate(encodeSignedDelegate(signedDelegate));
  assert.equal(dec.delegate.nonce, 9n);
  assert.equal(dec.delegate.actions[0].methodName, "db_add");
  assert.equal(new TextDecoder().decode(dec.delegate.actions[0].args), '{"x":1}');

  const tr = buildDelegateAction({
    senderId: MEMBER, receiverId: SITE, nonce: 9n, maxBlockHeight: 99n, publicKey: await signer.getPublicKey(),
    actions: [actions.transfer(10n ** 24n)],
  });
  const { signedDelegate: s2 } = await signer.signDelegateAction(tr);
  const dec2 = decodeSignedDelegate(encodeSignedDelegate(s2));
  assert.equal(dec2.opaque, true);
  assert.equal(dec2.delegate.actions[0].kind, 3);
});

test("decoder rejects truncated and trailing bytes", async () => {
  const k = await memberKey();
  const { bytes } = await mkDelegate(k);
  assert.throws(() => decodeSignedDelegate(bytes.slice(0, bytes.length - 3)));
  assert.throws(() => decodeSignedDelegate(Uint8Array.of(...bytes, 0)));
});

test("encodeDelegateAction is the borsh of near-api-js DelegateAction", async () => {
  const k = await memberKey();
  const { delegate, signed } = await mkDelegate(k);
  const sd = deserialize(SCHEMA.SignedDelegate, encodeSignedDelegate_(signed));
  assert.equal(encodeDelegateAction(delegate).length + 65, encodeSignedDelegate_(signed).length);
  assert.equal(sd.delegateAction.nonce, 5n);
});
import { encodeSignedDelegate as encode } from "../src/encoding.mjs";
const encodeSignedDelegate_ = (s) => encode(s);

test("NEP-413 signature equals near-api-js signMessage and verifies with near-api-js verifyMessage", async () => {
  const k = await memberKey();
  const payload = { message: "Sign in to board.testnet\nIssued: 2026-11-10T00:00:00.000Z", recipient: SITE, nonce: randomBytes(32) };
  const account = new Account(MEMBER, new JsonRpcProvider({ url: "http://127.0.0.1:1" }), new KeyPairSigner(k.kp));
  const theirs = await n413.signMessage({ signerAccount: account, payload });
  const mine = await nep413Sign(k.secretKey, payload);
  assert.deepEqual(Buffer.from(mine), Buffer.from(theirs.signature), "ed25519 over the same hash is identical");
  assert.equal(await nep413Verify(k.pub, theirs.signature, payload), true);
  const provider = { viewAccessKey: async () => ({ permission: "FullAccess", nonce: 0n }) };
  await n413.verifyMessage({ signerAccountId: MEMBER, signerPublicKey: k.pub, signature: mine, payload, provider }); // throws on failure
  await assert.rejects(n413.verifyMessage({ signerAccountId: MEMBER, signerPublicKey: k.pub, signature: mine, payload: { ...payload, message: "x" }, provider }));
});

test("NEP-413 hash layout: tag, strings, raw nonce, optional callback", async () => {
  const nonce = new Uint8Array(32).fill(7);
  const h1 = await nep413Hash({ message: "m", nonce, recipient: "r" });
  const h2 = await nep413Hash({ message: "m", nonce, recipient: "r", callbackUrl: null });
  const h3 = await nep413Hash({ message: "m", nonce, recipient: "r", callbackUrl: "https://x" });
  assert.deepEqual(h1, h2);
  assert.notDeepEqual(h1, h3);
  await assert.rejects(async () => nep413Hash({ message: "m", nonce: new Uint8Array(31), recipient: "r" }));
});

test("NEP-413 detects tampering", async () => {
  const k = await memberKey();
  const payload = { message: "hi", recipient: SITE, nonce: randomBytes(32) };
  const sig = await nep413Sign(k.secretKey, payload);
  assert.equal(await nep413Verify(k.pub, sig, payload), true);
  assert.equal(await nep413Verify(k.pub, sig, { ...payload, message: "ho" }), false);
  assert.equal(await nep413Verify(k.pub, sig, { ...payload, recipient: "evil.testnet" }), false);
  assert.equal(await nep413Verify(k.pub, sig, { ...payload, nonce: randomBytes(32) }), false);
  assert.equal(await nep413Verify("ed25519:11111111111111111111111111111111", sig, payload), false);
});

test("secret key parsing", async () => {
  const k = await memberKey();
  assert.deepEqual(parseSecretKey(k.secretKey).publicKey, k.publicKey);
  assert.throws(() => parseSecretKey("secp256k1:abc"));
  assert.ok(base64Encode(new Uint8Array([1, 2, 3])));
});
