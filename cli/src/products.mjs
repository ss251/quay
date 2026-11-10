import { requireAccount } from "./config.mjs";
import { QuayError } from "./errors.mjs";
import { sendCall } from "./db.mjs";
import { confirm, explorerUrl, owner, stopped } from "./shared.mjs";
import {
  emit,
  formatNear,
  formatTime,
  helpText,
  table,
  writeOut,
} from "./text.mjs";
import { parseCount, parseNear, parseUnits } from "./units.mjs";

export const PRODUCT_ID = /^[a-z0-9_-]{1,32}$/;
const GRANTS = ["pin", "receipt"];

export function checkProductId(id) {
  if (typeof id !== "string" || !PRODUCT_ID.test(id)) {
    throw new QuayError("a product id is 1 to 32 of a-z, 0-9, _ -", 1);
  }
  return id;
}

/**
 * The Product the contract takes, from loose input. Prices are yocto or token
 * units as decimal strings. Throws a usage error for anything the contract
 * would reject.
 */
export function buildProduct({
  name,
  priceYocto,
  priceToken,
  grant,
  pinSeconds,
}) {
  const label = String(name ?? "").trim();
  if (!label || [...label].length > 80)
    throw new QuayError("a product name is 1 to 80 characters", 1);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: names must not contain control characters
  if (/[\u0000-\u001f\u007f]/.test(label))
    throw new QuayError("a product name has a control character", 1);
  if (!GRANTS.includes(grant))
    throw new QuayError("grant must be pin or receipt", 1);
  const yocto = priceYocto == null ? null : BigInt(priceYocto);
  const token = priceToken == null ? null : BigInt(priceToken);
  if (yocto == null && token == null)
    throw new QuayError("a product needs a NEAR price or a token price", 1);
  if ((yocto != null && yocto <= 0n) || (token != null && token <= 0n))
    throw new QuayError("a price must be above 0", 1);
  const product = {
    name: label,
    price_yocto: yocto == null ? null : yocto.toString(),
    price_token: token == null ? null : token.toString(),
    grant,
    pin_seconds: null,
  };
  if (grant === "pin") {
    if (pinSeconds == null)
      throw new QuayError("a pin product needs --pin-seconds", 1);
    const secs = Number(pinSeconds);
    if (!Number.isInteger(secs) || secs < 1 || secs > 31_536_000)
      throw new QuayError("pin seconds must be 1 to 31536000", 1);
    product.pin_seconds = secs;
  }
  return product;
}

export async function productsCmd(ctx, parsed) {
  const sub = parsed.rest[0];
  if (!sub || parsed.flags.help) {
    writeOut(ctx, helpText("products"));
    if (!sub)
      throw new QuayError("quay products needs set, list, rm, or token", 1);
    return;
  }
  requireAccount(ctx.config);
  const flags = parsed.flags;
  if (sub === "list") {
    const [list, token] = await Promise.all([
      ctx.chain.view("list_products", {}),
      ctx.chain.view("get_token", {}).catch(() => null),
    ]);
    const products = list ?? [];
    if (ctx.json)
      return writeOut(ctx, JSON.stringify({ token: token ?? null, products }));
    if (products.length === 0) return writeOut(ctx, "no products");
    const rows = products.map((item) => ({
      id: item.id,
      name: item.name,
      near: item.price_yocto ? formatNear(BigInt(item.price_yocto)) : "",
      token: item.price_token ?? "",
      grant: item.grant,
      pin: item.pin_seconds ?? "",
    }));
    writeOut(
      ctx,
      [
        table(rows, [
          { key: "id", label: "id" },
          { key: "name", label: "name" },
          { key: "near", label: "NEAR" },
          { key: "token", label: "token amount" },
          { key: "grant", label: "grant" },
          { key: "pin", label: "pin seconds" },
        ]),
        token ? `token ${token}` : "no token accepted",
      ].join("\n"),
    );
    return;
  }
  if (sub === "set") {
    owner(ctx);
    const id = checkProductId(parsed.rest[1]);
    const product = buildProduct({
      name: flags.name === true ? undefined : flags.name,
      priceYocto:
        flags.price === undefined
          ? null
          : parseNear(flags.price, "--price").toString(),
      priceToken:
        flags["price-token"] === undefined
          ? null
          : parseUnits(flags["price-token"], "--price-token").toString(),
      grant: flags.grant === true ? undefined : flags.grant,
      pinSeconds:
        flags["pin-seconds"] === undefined
          ? null
          : parseCount(flags["pin-seconds"], "--pin-seconds", {
              min: 1,
              max: 31_536_000,
            }),
    });
    const sent = await sendCall(
      ctx,
      "set_product",
      { id, product },
      { deposit: 1n },
    );
    if (!sent) return;
    emit(
      ctx,
      {
        id,
        product,
        transaction: sent.hash,
        transaction_url: explorerUrl(sent.hash),
      },
      `saved product ${id}\ntransaction ${explorerUrl(sent.hash)}`,
    );
    return;
  }
  if (sub === "rm") {
    owner(ctx);
    const id = checkProductId(parsed.rest[1]);
    if (!ctx.dryRun) {
      const ok = await confirm(ctx, `Remove product ${id}?`);
      if (!ok) return stopped(ctx);
    }
    const sent = await sendCall(ctx, "remove_product", { id }, { deposit: 1n });
    if (!sent) return;
    emit(
      ctx,
      {
        id,
        removed: true,
        transaction: sent.hash,
        transaction_url: explorerUrl(sent.hash),
      },
      `removed product ${id}\ntransaction ${explorerUrl(sent.hash)}`,
    );
    return;
  }
  if (sub === "token") {
    owner(ctx);
    const raw = parsed.rest[1];
    if (!raw)
      throw new QuayError("quay products token needs an account or none", 1);
    const account = raw === "none" ? null : String(raw);
    const sent = await sendCall(ctx, "set_token", { account }, { deposit: 1n });
    if (!sent) return;
    emit(
      ctx,
      {
        token: account,
        transaction: sent.hash,
        transaction_url: explorerUrl(sent.hash),
      },
      `${account ? `accepting ${account}` : "no token accepted"}\ntransaction ${explorerUrl(sent.hash)}`,
    );
    return;
  }
  throw new QuayError(`unknown products command ${sub}`, 1);
}

export async function receiptsCmd(ctx, parsed) {
  requireAccount(ctx.config);
  const query = {};
  const flags = parsed.flags;
  if (flags.owner !== undefined) {
    const who = flags.owner === true ? ctx.config.account : String(flags.owner);
    query.owner = who;
  }
  if (flags.from !== undefined)
    query.from = String(parseCount(flags.from, "--from"));
  if (flags.limit !== undefined)
    query.limit = parseCount(flags.limit, "--limit", { min: 1, max: 50 });
  const page = await ctx.chain.view("list_receipts", { query });
  if (ctx.json) return writeOut(ctx, JSON.stringify(page));
  const receipts = page?.receipts ?? [];
  if (receipts.length === 0) return writeOut(ctx, "no receipts");
  const lines = [
    table(
      receipts.map((item) => ({
        buyer: item.buyer,
        product: item.product,
        ref: item.ref ?? "",
        amount:
          item.token === "near"
            ? `${formatNear(BigInt(item.amount))} NEAR`
            : `${item.amount} ${item.token}`,
        at: formatTime(item.at),
      })),
      [
        { key: "buyer", label: "buyer" },
        { key: "product", label: "product" },
        { key: "ref", label: "ref" },
        { key: "amount", label: "amount" },
        { key: "at", label: "at" },
      ],
    ),
  ];
  if (page?.next != null) lines.push(`more  quay receipts --from ${page.next}`);
  writeOut(ctx, lines.join("\n"));
}
