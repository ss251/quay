// Site functions and checkout, loaded on demand by index.mjs (dist/extras.mjs beside dist/quay.js).
// ctx is built by connect(): { site, view, write, resultOf, outlayerCall, state, toYocto, QuayError, MAX_GAS, fn }.

/**
 * Run a site function. With functions.https_key it calls OutLayer over HTTPS (no wallet needed);
 * otherwise it sends fn_call (300 Tgas) through the member relayer, the wallet or the explicit key
 * and returns the function output from the transaction result.
 */
export async function call(ctx, name, input = {}) {
  const { site, view, write, resultOf, QuayError, fn } = ctx;
  const httpsKey = fn.httpsKey ?? fn.https_key ?? null;
  if (httpsKey) return ctx.outlayerCall({ owner: site, project: name, paymentKey: httpsKey, api: fn.api }, input, name);
  const spec = await view("fn_get", { name });
  if (!spec) throw new QuayError(`unknown function ${name}`, "unknown_function");
  const deposit = spec.payer === "site" ? 0n : ctx.toYocto(spec.deposit ?? "5000000000000000000000");
  const written = await write("fn_call", { name, input: JSON.stringify(input ?? {}) }, { deposit, gas: ctx.MAX_GAS, confirm: false });
  const out = await resultOf("fn_call", written, { final: true });
  if (typeof out === "string") {
    try {
      return JSON.parse(out);
    } catch {}
  }
  return out;
}

/** Buy a product. Needs a wallet or an explicit key because it attaches a deposit. { token: true } pays price_token. */
export async function pay(ctx, product, { ref, deposit, token = false } = {}) {
  const { site, view, write, state, QuayError } = ctx;
  if (token) {
    if (state.mode === "member")
      throw new QuayError("token payments need a wallet: members have no NEAR for the 1 yocto deposit. Sign in with a wallet.", "deposit_needs_wallet");
    const [tokenId, p] = await Promise.all([view("get_token", {}), view("get_product", { id: product })]);
    if (!tokenId) throw new QuayError("this site has no payment token configured", "no_token");
    if (!p) throw new QuayError(`unknown product ${product}`, "unknown_product");
    if (!p.price_token || BigInt(p.price_token) === 0n) throw new QuayError(`${product} has no token price`, "no_token_price");
    const msg = { product };
    if (ref != null) msg.ref = ref;
    await write("ft_transfer_call", { receiver_id: site, amount: String(p.price_token), msg: JSON.stringify(msg) }, { deposit: 1n, gas: 100_000_000_000_000n, receiver: tokenId });
    return;
  }
  let amount = deposit;
  if (amount == null) {
    const p = await view("get_product", { id: product });
    if (!p) throw new QuayError(`unknown product ${product}`, "unknown_product");
    amount = p.price_yocto;
  }
  const args = { product };
  if (ref != null) args.ref = ref;
  await write("pay", args, { deposit: amount });
}
