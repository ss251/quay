import { KeyPair, KeyPairSigner, Account, JsonRpcProvider, actions, buildDelegateAction, encodeSignedDelegate, teraToGas } from "near-api-js";
import { base64Encode, encodeSignedDelegate as myEncode, formatPublicKey, generateKey, signDelegate } from "../src/encoding.mjs";

export { KeyPair, KeyPairSigner, Account, JsonRpcProvider, actions, buildDelegateAction, encodeSignedDelegate, teraToGas };

export const SITE = "board.testnet";
export const MEMBER = `alice.${SITE}`;

/** A member key in NEAR text form, plus the same key as a near-api-js KeyPair. */
export async function memberKey() {
  const k = await generateKey();
  return { ...k, kp: KeyPair.fromString(k.secretKey), pub: formatPublicKey(k.publicKey) };
}

/** Build and sign a delegate with our code. */
export async function mkDelegate(key, over = {}) {
  const d = {
    senderId: MEMBER,
    receiverId: SITE,
    actions: [{ methodName: "db_add", args: { collection: "posts", data: "{}" }, gas: 10n * 10n ** 12n, deposit: 0n }],
    nonce: 5n,
    maxBlockHeight: 1100n,
    publicKey: key.pub,
    ...over,
  };
  const signed = await signDelegate(d, key.secretKey);
  return { delegate: d, signed, bytes: myEncode(signed), b64: base64Encode(myEncode(signed)) };
}

/** Fake fetch for JSON-RPC and the relay. handlers: { rpc: {method: fn(params)}, routes: {"POST /relay": fn(body)} } */
export function fakeFetch({ rpc = {}, routes = {} } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const u = new URL(url);
    if (body?.jsonrpc) {
      const h = rpc[body.method];
      if (!h) return json({ jsonrpc: "2.0", id: body.id, error: { message: `no stub for ${body.method}` } });
      try {
        return json({ jsonrpc: "2.0", id: body.id, result: await h(body.params) });
      } catch (e) {
        if (e.rpcError) return json({ jsonrpc: "2.0", id: body.id, error: e.rpcError });
        throw e;
      }
    }
    const r = routes[`${init.method ?? "GET"} ${u.pathname}`];
    if (!r) return json({ error: "not found" }, 404);
    const out = await r(body);
    return out.status ? json(out.body, out.status) : json(out);
  };
  f.calls = calls;
  return f;
}
const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
export const rpcErr = (name) => Object.assign(new Error(name), { rpcError: { message: name, cause: { name } } });
export const viewResult = (value) => ({ result: [...new TextEncoder().encode(JSON.stringify(value))] });
