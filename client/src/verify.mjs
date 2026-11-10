// Server and browser sign-in verification (NEP-413).
import { base64Decode, nep413Verify } from "./encoding.mjs";
import { createRpc, isFullAccess } from "./rpc.mjs";

const SKEW_MS = 60_000;

/**
 * Check a sign-in proof { accountId, publicKey, signature, message, nonce, recipient }.
 * Returns { ok: true, accountId, publicKey, issuedAt } or { ok: false, reason }.
 * Options: site (required, expected recipient), rpc (URL or client), maxAgeMs (default 5 min),
 * now (ms), fetch.
 */
export async function verifySignIn(proof, opts = {}) {
  const fail = (reason) => ({ ok: false, reason });
  const { site, maxAgeMs = 5 * 60_000, now = Date.now() } = opts;
  if (!site) throw new Error("verifySignIn needs { site }");
  if (!proof || typeof proof !== "object") return fail("missing proof");
  const { accountId, publicKey, signature, message, nonce, recipient } = proof;
  for (const [k, v] of Object.entries({ accountId, publicKey, signature, message, nonce, recipient }))
    if (typeof v !== "string" || v === "") return fail(`missing ${k}`);

  if (recipient !== site) return fail("wrong recipient");

  let sig;
  let nonceBytes;
  try {
    sig = base64Decode(signature);
    nonceBytes = base64Decode(nonce);
  } catch {
    return fail("malformed encoding");
  }
  if (sig.length !== 64) return fail("malformed signature");
  if (nonceBytes.length !== 32) return fail("malformed nonce");

  if (!(await nep413Verify(publicKey, sig, { message, nonce: nonceBytes, recipient })))
    return fail("bad signature");

  const m = /^Issued: (\S+)$/m.exec(message);
  const issuedAt = m ? Date.parse(m[1]) : Number.NaN;
  if (Number.isNaN(issuedAt)) return fail("message has no timestamp");
  if (issuedAt > now + SKEW_MS) return fail("timestamp is in the future");
  if (now - issuedAt > maxAgeMs) return fail("stale");

  const rpc = typeof opts.rpc === "object" && opts.rpc?.accessKey ? opts.rpc : createRpc({ url: opts.rpc, fetch: opts.fetch });
  let key;
  try {
    key = await rpc.accessKey(accountId, publicKey);
  } catch (e) {
    return fail(`rpc error: ${e.message}`);
  }
  if (!key) return fail("key is not on the account");
  if (!isFullAccess(key)) return fail("key is not full access");
  return { ok: true, accountId, publicKey, issuedAt };
}
