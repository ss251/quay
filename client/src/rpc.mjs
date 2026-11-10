// Plain JSON-RPC. No near-api-js.
export const DEFAULT_RPC = "https://test.rpc.fastnear.com";

export class RpcError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "RpcError";
    this.detail = detail;
  }
}

export function createRpc({ url = DEFAULT_RPC, fetch: f } = {}) {
  const doFetch = f ?? ((...a) => globalThis.fetch(...a));
  let id = 0;
  async function call(method, params) {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!res.ok) throw new RpcError(`rpc ${method} failed with HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) {
      const cause = body.error.cause?.name;
      throw new RpcError(`rpc ${method}: ${cause ?? body.error.message ?? "error"}`, body.error);
    }
    return body.result;
  }
  return {
    url,
    call,
    /** call_function on a view method; args is an object, the result is parsed JSON. */
    async view(accountId, methodName, args = {}) {
      const result = await call("query", {
        request_type: "call_function",
        finality: "optimistic",
        account_id: accountId,
        method_name: methodName,
        args_base64: btoa(JSON.stringify(args)),
      });
      if (result.error) throw new RpcError(`${methodName}: ${result.error}`, result);
      const text = new TextDecoder().decode(Uint8Array.from(result.result));
      return text === "" ? null : JSON.parse(text);
    },
    /** Returns the access key view, or null when the key is not on the account. */
    async accessKey(accountId, publicKey, finality = "optimistic") {
      try {
        const res = await call("query", {
          request_type: "view_access_key",
          finality,
          account_id: accountId,
          public_key: publicKey,
        });
        // some nodes answer an unknown key with a result.error string instead of an RPC error
        if (res?.error) return /does not exist/.test(res.error) ? null : Promise.reject(new RpcError(`view_access_key: ${res.error}`));
        return res;
      } catch (e) {
        if (e instanceof RpcError && /UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/.test(e.message)) return null;
        throw e;
      }
    },
    async block(finality = "final") {
      return (await call("block", { finality })).header;
    },
  };
}

/** NEAR permission views are the string "FullAccess" or { FunctionCall: {...} }. */
export const isFullAccess = (key) => key?.permission === "FullAccess";
