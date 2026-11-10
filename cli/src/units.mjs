import { teraToGas } from "near-api-js";

import { QuayError } from "./errors.mjs";

export const YOCTO_PER_NEAR = 10n ** 24n;
/** The price the contract charges per stored byte. */
export const BYTE_COST = 10n ** 19n;
/**
 * Bytes a new doc adds beyond its data text: the doc record, the id index
 * record, the per-account counter and trie record overhead. The contract
 * refunds whatever the real cost leaves over, so this errs high.
 */
export const DOC_OVERHEAD_BYTES = 450;
export const UPDATE_MARGIN_BYTES = 100;

/** "0.5" -> yocto as a bigint. At most 24 decimals. */
export function parseNear(text, label = "amount") {
  const raw = String(text ?? "").trim();
  if (!/^\d+(\.\d{1,24})?$/.test(raw)) {
    throw new QuayError(
      `${label} must be a NEAR amount such as 0.5 or 2 (at most 24 decimals)`,
      1,
    );
  }
  const [whole, frac = ""] = raw.split(".");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, "0"));
}

/** A plain non-negative integer, as a bigint. Used for token amounts. */
export function parseUnits(text, label = "amount") {
  const raw = String(text ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new QuayError(`${label} must be a whole number`, 1);
  }
  return BigInt(raw);
}

export function parseCount(
  text,
  label,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
) {
  const raw = String(text ?? "").trim();
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new QuayError(
      `${label} must be a whole number from ${min} to ${max}`,
      1,
    );
  }
  return Number(raw);
}

export function addDocCost(idBytes, dataBytes) {
  return BigInt(dataBytes + 2 * idBytes + DOC_OVERHEAD_BYTES) * BYTE_COST;
}

export function growthCost(oldBytes, newBytes) {
  const growth = newBytes - oldBytes;
  if (growth <= 0) return 0n;
  return BigInt(growth + UPDATE_MARGIN_BYTES) * BYTE_COST;
}

/** fn_call and a db_add that runs an on_add trigger need at least 120 Tgas. */
export const TRIGGER_GAS = teraToGas("300");
/** A token payment needs this much in the pool for its receipt (1000 bytes). */
export const MIN_TOKEN_POOL_YOCTO = 10n ** 22n;
