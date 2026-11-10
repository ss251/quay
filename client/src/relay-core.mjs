// Relayer core (Node). Hosts (a Node server or OutLayer) call checkDelegate, then relay.
import { decodeSignedDelegate, base64Decode, verifySignedDelegate, hex, sha256 } from "./encoding.mjs";

export const DEFAULT_POLICY = Object.freeze({
  methods: ["db_add", "db_update", "db_remove"],
  maxGas: 100_000_000_000_000n, // 100 Tgas
  maxBlockHeightAhead: 200n,
  perAccountPerHour: 30,
  dailyTgas: 30_000,
  allowUploads: false,
  memberOnly: true, // sender must be <name>.<site>
});

/** In-memory budget store. Hosts with several processes inject a shared one with the same shape. */
export function memoryStore() {
  const m = new Map();
  return {
    async get(key) {
      return m.get(key) ?? 0;
    },
    async add(key, amount) {
      const v = (m.get(key) ?? 0) + amount;
      m.set(key, v);
      return v;
    },
  };
}

export const hourBucket = (ms) => Math.floor(ms / 3_600_000);
export const dayBucket = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Decide whether to relay. `input` is the base64 string or the raw bytes of a
 * SignedDelegateAction. `policy` = { site, store, ...DEFAULT_POLICY overrides }.
 * `now` = { ms, height } (current time and current final block height).
 * Returns { ok: true, sender, receiver, gas, digest, commit() } or { ok: false, code, reason }.
 * Call commit() once the relay is actually sent to charge the budgets.
 */
export async function checkDelegate(input, policy, now) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const reject = (code, reason) => ({ ok: false, code, reason });
  if (!p.site) throw new Error("policy.site is required");
  if (!p.store) throw new Error("policy.store is required");
  if (!now || typeof now.ms !== "number" || now.height == null) throw new Error("now must be { ms, height }");

  let bytes;
  try {
    bytes = typeof input === "string" ? base64Decode(input) : input;
  } catch {
    return reject("malformed", "signed_delegate is not valid base64");
  }
  let decoded;
  try {
    decoded = decodeSignedDelegate(bytes);
  } catch (e) {
    return reject("malformed", `cannot decode signed delegate: ${e.message}`);
  }
  const d = decoded.delegate;
  if (d.actions.length === 0) return reject("no_actions", "delegate has no actions");
  if (d.actions.some((a) => a.kind !== 2)) return reject("action_not_allowed", "only FunctionCall actions are allowed");

  if (!(await verifySignedDelegate(d, decoded.signature))) return reject("bad_signature", "delegate signature is invalid");

  let gas = 0n;
  for (const a of d.actions) {
    if (a.deposit !== 0n) return reject("deposit_not_allowed", "relayed calls must attach no deposit");
    gas += a.gas;
  }
  if (gas > BigInt(p.maxGas)) return reject("gas_too_high", `gas ${gas} exceeds the limit of ${p.maxGas}`);

  const isMember = d.senderId.endsWith(`.${p.site}`);
  if (p.memberOnly && !isMember) return reject("sender_not_member", `sender must be a member of ${p.site}`);

  if (d.receiverId === p.site) {
    for (const a of d.actions)
      if (!p.methods.includes(a.methodName)) return reject("method_not_allowed", `method ${a.methodName} is not relayed`);
  } else if (d.receiverId === d.senderId && p.allowUploads) {
    for (const a of d.actions)
      if (a.methodName !== "fs_store") return reject("method_not_allowed", `method ${a.methodName} is not relayed`);
  } else {
    return reject("receiver_not_allowed", `receiver ${d.receiverId} is not allowed`);
  }

  const height = BigInt(now.height);
  if (d.maxBlockHeight <= height) return reject("expired", "delegate has expired");
  if (d.maxBlockHeight > height + BigInt(p.maxBlockHeightAhead))
    return reject("expiry_too_far", `max_block_height is more than ${p.maxBlockHeightAhead} blocks ahead`);

  const hourKey = `acct:${d.senderId}:${hourBucket(now.ms)}`;
  const dayKey = `tgas:${dayBucket(now.ms)}`;
  const tgas = Number(gas / 1_000_000_000_000n) + (gas % 1_000_000_000_000n ? 1 : 0);
  if ((await p.store.get(hourKey)) >= p.perAccountPerHour)
    return reject("account_rate_limit", `${d.senderId} reached ${p.perAccountPerHour} relays this hour`);
  if ((await p.store.get(dayKey)) + tgas > p.dailyTgas) return reject("daily_budget", "daily gas budget is used up");

  return {
    ok: true,
    sender: d.senderId,
    receiver: d.receiverId,
    gas,
    digest: hex(await sha256(bytes)),
    bytes,
    async commit() {
      await p.store.add(hourKey, 1);
      await p.store.add(dayKey, tgas);
    },
  };
}

export class RelayError extends Error {
  constructor(message, { code = "relay_failed", outcome } = {}) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.outcome = outcome;
  }
}

/** Every failure reason in a final execution outcome (outer status plus each receipt). */
export function failures(outcome) {
  const out = [];
  const add = (f) => out.push(typeof f === "string" ? f : JSON.stringify(f).slice(0, 400));
  if (outcome?.status?.Failure) add(outcome.status.Failure);
  if (outcome?.transaction_outcome?.outcome?.status?.Failure) add(outcome.transaction_outcome.outcome.status.Failure);
  for (const r of outcome?.receipts_outcome ?? []) if (r.outcome?.status?.Failure) add(r.outcome.status.Failure);
  return out;
}

/**
 * Wrap a signed delegate in a transaction from the relayer `account` (a near-api-js Account).
 * Returns { hash, outcome }. Throws RelayError when the outer transaction or any inner receipt failed,
 * because a delegate can succeed outwardly while its inner receipt fails.
 */
export async function relay(input, { account }) {
  const [{ SCHEMA }, { deserialize }] = await Promise.all([import("near-api-js"), import("borsh")]);
  const bytes = typeof input === "string" ? base64Decode(input) : input;
  const signedDelegate = deserialize(SCHEMA.SignedDelegate, bytes);
  const outcome = await account.relayMetaTransaction(signedDelegate);
  const bad = failures(outcome);
  if (bad.length) throw new RelayError(`relayed call failed: ${bad.join("; ")}`, { code: "inner_failure", outcome });
  return { hash: outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id, outcome };
}
