import { createHash } from "node:crypto";

import { QuayError } from "../errors.mjs";
import { filebaseStore } from "./filebase.mjs";
import { nearfsStore } from "./nearfs.mjs";
import { pinataStore } from "./pinata.mjs";

export const STORES = ["nearfs", "pinata", "filebase"];

const FACTORIES = {
  nearfs: nearfsStore,
  pinata: pinataStore,
  filebase: filebaseStore,
};

/** `ctx` supplies chain, env and fetch. Throws if the store is unknown or lacks credentials. */
export function makeStore(name, ctx) {
  const factory = FACTORIES[name];
  if (!factory) {
    throw new QuayError(`unknown store ${name}. Use ${STORES.join(", ")}.`, 1);
  }
  return factory(ctx);
}

/**
 * Read the file back from the store's gateway and compare sha256. Polls until
 * `timeoutMs`; a 404 is retried, a hash mismatch is final.
 */
export async function verifyExternal(store, cid, expectedSha256, ctx = {}) {
  const fetcher = ctx.fetch ?? globalThis.fetch;
  const sleep =
    ctx.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const timeoutMs = ctx.verifyTimeoutMs ?? 90_000;
  const intervalMs = ctx.verifyIntervalMs ?? 3_000;
  const url = store.gatewayUrl(cid);
  const started = Date.now();
  let last = "no response";
  for (;;) {
    try {
      const response = await fetcher(url);
      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual === expectedSha256) return { url, bytes: bytes.length };
        throw new QuayError(
          `${url} served different bytes (sha256 ${actual}, expected ${expectedSha256})`,
          2,
        );
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      if (error instanceof QuayError) throw error;
      last = error?.cause?.code || error?.message || String(error);
    }
    if (Date.now() - started >= timeoutMs) {
      throw new QuayError(
        `${store.name} did not serve ${cid} within ${Math.round(timeoutMs / 1000)} seconds (${last}) at ${url}. Nothing was sealed. Retry later, pick another --store, or pass --no-verify to seal without this check.`,
        2,
      );
    }
    await sleep(intervalMs);
  }
}

/** True when the gateway already serves these exact bytes. One quick try. */
export async function alreadyStored(store, cid, expectedSha256, ctx = {}) {
  try {
    await verifyExternal(store, cid, expectedSha256, {
      ...ctx,
      verifyTimeoutMs: 0,
    });
    return true;
  } catch {
    return false;
  }
}
