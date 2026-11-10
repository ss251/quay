// RPC failover. near-api-js's FailoverRpcProvider retries every error on every
// node (a contract error would hit all three) and wraps what it throws, which
// would hide the messages quay reads. This wrapper moves to the next URL only
// for network errors, HTTP 429/5xx and rate-limit answers, and rethrows
// everything else as it came.
import { createHash } from "node:crypto";

import { baseEncode, encodeTransaction, JsonRpcProvider } from "near-api-js";

import { QuayError } from "./errors.mjs";

export const DEFAULT_RPC_URLS = [
  "https://test.rpc.fastnear.com",
  "https://testnet-rpc.intea.rs",
  "https://near-testnet.drpc.org",
];

const NETWORK_CODES =
  /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|UND_ERR_.*)$/;

/** True for errors that say "this node, not your request": try another. */
export function isRetriable(error) {
  if (!error) return false;
  if (error.name === "RetriesExceeded") return true;
  const status = Number(error.cause);
  if (status === 408 || status === 429 || (status >= 500 && status <= 599))
    return true;
  const code = error.cause?.code ?? error.code;
  if (typeof code === "string" && NETWORK_CODES.test(code)) return true;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  const message = String(error.message ?? "");
  if (error instanceof TypeError && /fetch failed|network/i.test(message))
    return true;
  return /rate limit|too many requests|\b429\b|socket hang up|timed? ?out|bad gateway|service unavailable|Exceeded \d+ attempts/i.test(
    message,
  );
}

function hashOf(signed) {
  try {
    const bytes = encodeTransaction(signed.transaction);
    return baseEncode(createHash("sha256").update(bytes).digest());
  } catch {
    return null;
  }
}

function brief(error) {
  const text = String(error?.message ?? error).split("\n")[0];
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * A provider over several RPC URLs. `makeProvider(url)` builds one node's
 * provider. The node that last answered is tried first.
 */
export function createFailoverProvider(urls, { makeProvider, onSwitch } = {}) {
  const build =
    makeProvider ??
    ((url) =>
      new JsonRpcProvider({ url }, { retries: 2, wait: 300, backoff: 1.5 }));
  const nodes = urls.map((url) => ({ url, provider: build(url) }));
  let current = 0;

  async function attempt(run, { beforeRetry } = {}) {
    const failures = [];
    for (let step = 0; step < nodes.length; step += 1) {
      const index = (current + step) % nodes.length;
      const node = nodes[index];
      try {
        if (step > 0 && beforeRetry) {
          const known = await beforeRetry(node.provider);
          if (known !== undefined) {
            current = index;
            return known;
          }
        }
        const result = await run(node.provider);
        current = index;
        return result;
      } catch (error) {
        if (!isRetriable(error)) throw error;
        failures.push(`${node.url}: ${brief(error)}`);
        onSwitch?.(node.url, error);
      }
    }
    throw new QuayError(
      `every RPC endpoint failed (${failures.join("; ")}). Wait a minute, or pass --rpc <url>.`,
      2,
    );
  }

  const handler = {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === "urls") return nodes.map((node) => node.url);
      const first = nodes[0].provider;
      const value = first[prop];
      if (typeof value !== "function") return nodes[current].provider[prop];
      if (prop === "sendTransactionUntil") {
        return (signed, waitUntil) => {
          // Re-sending the same signed bytes is safe (the hash is the id), and
          // before the next node gets them, ask it whether it already has the tx.
          const txHash = hashOf(signed);
          return attempt(
            (provider) => provider.sendTransactionUntil(signed, waitUntil),
            {
              beforeRetry: txHash
                ? async (provider) => {
                    try {
                      const status = await provider.viewTransactionStatus({
                        txHash,
                        accountId: signed.transaction.signerId,
                        waitUntil,
                      });
                      return status?.transaction ? status : undefined;
                    } catch {
                      return undefined;
                    }
                  }
                : undefined,
            },
          );
        };
      }
      return (...args) => attempt((provider) => provider[prop](...args));
    },
  };
  return new Proxy({}, handler);
}
