// Plain JSON-RPC with ordered failover. No near-api-js.
// Without an explicit endpoint the three public testnet RPCs are tried in order, the same list the gateway uses.
export const DEFAULT_RPC_URLS = ["https://test.rpc.fastnear.com", "https://testnet-rpc.intea.rs", "https://near-testnet.drpc.org"];
export const DEFAULT_RPC = DEFAULT_RPC_URLS[0];
const COOLDOWN_MS = 30_000;

export class RpcError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "RpcError";
    this.detail = detail;
  }
}

/** A list of endpoints from nothing, one URL, a comma list or an array. The deprecated rpc.testnet.near.org is dropped. */
export function rpcUrls(value) {
  const list = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((u) => String(u).trim())
    .filter((u) => u && !/\/\/rpc\.testnet\.near\.org/.test(u));
  return list.length ? [...new Set(list)] : [...DEFAULT_RPC_URLS];
}

const RATE_LIMIT = /rate.?limit|too many requests|\b429\b|deprecated/i;
/** Network errors, timeouts, HTTP 429/408/5xx and JSON-RPC rate-limit answers are worth another endpoint. */
export function isRetryable(e) {
  if (e?.retryable !== undefined) return e.retryable;
  return /rate.?limit|too many requests|\b429\b|time(?:d)?[ -]?out|TIMEOUT_ERROR|ECONN\w*|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network|socket hang up|Bad Gateway|Service Unavailable|Gateway Timeout|HTTP 5\d\d|RetriesExceeded|Exceeded \d+ attempts/i.test(
    `${e?.name} ${e?.type} ${e?.code} ${e?.message} ${e?.cause?.message ?? ""}`,
  );
}

/** createRpc({ url | urls, fetch, now, cooldownMs }): url may be one endpoint, a list, or omitted for the default list. */
export function createRpc({ url, urls, fetch: f, now = Date.now, cooldownMs = COOLDOWN_MS } = {}) {
  const list = rpcUrls(urls ?? url);
  const doFetch = f ?? ((...a) => globalThis.fetch(...a));
  const down = new Map();
  let id = 0;

  async function attempt(endpoint, method, params) {
    let res;
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
    } catch (e) {
      throw Object.assign(new RpcError(`rpc ${method}: ${e?.message ?? "network error"}`), { retryable: true });
    }
    let body = null;
    try {
      body = await res.json();
    } catch {}
    if (!res.ok) {
      const retry = res.status === 429 || res.status === 408 || res.status >= 500 || (body && RATE_LIMIT.test(JSON.stringify(body)));
      throw Object.assign(new RpcError(`rpc ${method} failed with HTTP ${res.status}`, body), { retryable: retry });
    }
    if (!body) throw Object.assign(new RpcError(`rpc ${method}: the answer is not JSON`), { retryable: true });
    if (body.error) {
      const cause = body.error.cause?.name;
      const retry = body.error.code === -429 || RATE_LIMIT.test(JSON.stringify(body.error)) || cause === "TIMEOUT_ERROR";
      throw Object.assign(new RpcError(`rpc ${method}: ${cause ?? body.error.data ?? body.error.message ?? "error"}`, body.error), { retryable: retry });
    }
    return body.result;
  }

  async function call(method, params) {
    const t = now();
    const up = list.filter((u) => (down.get(u) ?? 0) <= t);
    const order = up.length ? up : list;
    const reasons = [];
    for (const endpoint of order) {
      try {
        return await attempt(endpoint, method, params);
      } catch (e) {
        if (!e.retryable) throw e;
        down.set(endpoint, now() + cooldownMs);
        reasons.push(`${new URL(endpoint).host}: ${e.message}`);
      }
    }
    throw new RpcError(`every RPC endpoint failed (${reasons.join("; ")})`, { reasons });
  }
  return {
    url: list[0],
    urls: list,
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
