// A near-api-js provider with ordered failover (Node). Reads move to the next endpoint on network
// errors, HTTP 429/5xx and rate-limit answers. A broadcast re-sends the SAME signed bytes (the caller
// signed once; nothing here signs) and asks the next endpoint for the transaction hash first, so a
// transaction the first endpoint did accept is never sent twice as a new one.
import { base58Encode, sha256 } from "./encoding.mjs";
import { isRetryable, rpcUrls } from "./rpc.mjs";

const UNKNOWN_TX = /UNKNOWN_TRANSACTION|doesn't exist|does not exist|not found/i;

export async function createFailoverProvider(urlOrList, { retries = 1, now = Date.now, cooldownMs = 30_000, makeProvider } = {}) {
  const { FailoverRpcProvider, JsonRpcProvider, encodeTransaction } = await import("near-api-js");
  const urls = rpcUrls(urlOrList);
  const make = makeProvider ?? ((url) => new JsonRpcProvider({ url }, { retries, backoff: 1, wait: 100 }));

  class QuayFailoverProvider extends FailoverRpcProvider {
    constructor() {
      super(urls.map(make));
      this.urls = urls;
      this.downUntil = new Map();
    }
    // Endpoints that failed recently go last, the rest keep their order.
    order() {
      const t = now();
      const idx = this.providers.map((_, i) => i);
      return [...idx.filter((i) => (this.downUntil.get(i) ?? 0) <= t), ...idx.filter((i) => (this.downUntil.get(i) ?? 0) > t)];
    }
    fail(i, errors, e) {
      this.downUntil.set(i, now() + cooldownMs);
      errors.push(`${this.urls[i]}: ${e?.message ?? e}`);
    }
    exhausted(errors) {
      return Object.assign(new Error(`every RPC endpoint failed (${errors.join("; ")})`), { errors, retryable: false });
    }
    async withBackoff(getResult) {
      const errors = [];
      for (const i of this.order()) {
        try {
          return await getResult(this.providers[i]);
        } catch (e) {
          if (!isRetryable(e)) throw e;
          this.fail(i, errors, e);
        }
      }
      throw this.exhausted(errors);
    }
    async sendTransactionUntil(signedTx, waitUntil) {
      const hash = base58Encode(await sha256(encodeTransaction(signedTx.transaction)));
      const accountId = signedTx.transaction.signerId;
      const errors = [];
      let tried = false;
      for (const i of this.order()) {
        const p = this.providers[i];
        if (tried) {
          // an earlier endpoint may have accepted it before failing: look by hash before sending again
          try {
            const known = await p.viewTransactionStatus({ txHash: hash, accountId, waitUntil });
            if (known) return known;
          } catch (e) {
            if (!UNKNOWN_TX.test(`${e?.type} ${e?.message}`) && !isRetryable(e)) throw e;
          }
        }
        tried = true;
        try {
          return await p.sendTransactionUntil(signedTx, waitUntil);
        } catch (e) {
          if (!isRetryable(e)) throw e;
          this.fail(i, errors, e);
        }
      }
      throw this.exhausted(errors);
    }
    async sendTransaction(signedTx) {
      return this.sendTransactionUntil(signedTx, "EXECUTED_OPTIMISTIC");
    }
    async sendTransactionAsync(signedTx) {
      return this.sendTransactionUntil(signedTx, "NONE");
    }
  }
  return new QuayFailoverProvider();
}
