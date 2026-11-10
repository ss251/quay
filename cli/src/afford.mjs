import { QuayError } from "./errors.mjs";
import { formatNear, writeErr } from "./text.mjs";

const BYTE_COST = 10n ** 19n;
/** Room for the contract's own state right after `new`. */
const STATE_MARGIN = 10n ** 23n;

export function codeCostYocto(wasm) {
  return BigInt(wasm.length) * BYTE_COST + STATE_MARGIN;
}

/**
 * Say what the contract code costs to store, and stop before deploying when the
 * account cannot pay for it. Deploying locks 0.01 NEAR per 1000 bytes of wasm.
 */
export async function assertCanAffordWasm(ctx, wasm) {
  const need = codeCostYocto(wasm);
  writeErr(
    ctx,
    `the contract is ${Math.round(wasm.length / 1000)} KB. Storing it locks about ${formatNear(need)} NEAR on the account (0.01 NEAR per 1000 bytes, plus state). The testnet faucet gives 10 NEAR.`,
  );
  const view = await ctx.chain.accountView();
  const liquid =
    BigInt(view?.amount ?? 0) - BigInt(view?.storage_usage ?? 0) * BYTE_COST;
  if (liquid < need) {
    throw new QuayError(
      `this account has ${formatNear(liquid < 0n ? 0n : liquid)} NEAR free and deploying the contract needs about ${formatNear(need)} NEAR. Fund the account with more testnet NEAR and run quay init again. Nothing was deployed.`,
      1,
    );
  }
}
