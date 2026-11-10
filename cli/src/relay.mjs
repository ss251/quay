// `quay relay serve|status|create`: the relayer that pays gas for member writes.
// `serve` is the one off-chain piece of a Quay site: a small Node process.
// The host is vendored from client/src by `node client/build.mjs`, so the packed CLI carries it.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";

import { requireAccount, readKeyFile } from "./config.mjs";
import { QuayError, usage } from "./errors.mjs";
import { confirm, explorerUrl, owner } from "./shared.mjs";
import { emit, formatNear, helpText, writeErr, writeOut } from "./text.mjs";
import { parseNear } from "./units.mjs";

export const DEFAULT_RELAY_PORT = 8788;
export const DEFAULT_RELAY_FUNDING = "0.5";

export const relayerFor = (account, flags) =>
  typeof flags.relayer === "string" ? flags.relayer : `relay.${account}`;

function portOf(value) {
  if (value === undefined) return DEFAULT_RELAY_PORT;
  const port = Number(value);
  if (value === true || !Number.isInteger(port) || port < 0 || port > 65535)
    throw usage("quay: --port needs a number from 0 to 65535");
  return port;
}

function countOf(flags, name) {
  if (flags[name] === undefined) return undefined;
  const n = Number(flags[name]);
  if (flags[name] === true || !Number.isInteger(n) || n < 1)
    throw usage(`quay: --${name} needs a whole number of at least 1`);
  return n;
}

function relayerKey(ctx, relayer) {
  if (process.env.QUAY_RELAYER_KEY) {
    ctx.secrets?.push(process.env.QUAY_RELAYER_KEY);
    return process.env.QUAY_RELAYER_KEY;
  }
  const path = join(ctx.credentialsDir, `${relayer}.json`);
  if (!existsSync(path))
    throw new QuayError(
      `no key for ${relayer} at ${path}. Run quay relay create, or set QUAY_RELAYER_KEY.`,
      1,
    );
  const file = readKeyFile(path);
  ctx.secrets?.push(file.private_key);
  return file.private_key;
}

function waitForSignal() {
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

async function balanceOf(ctx, relayer) {
  if (ctx.relayBalance) return ctx.relayBalance(relayer);
  try {
    const view = await new JsonRpcProvider({ url: ctx.config.rpc }).viewAccount(
      { accountId: relayer },
    );
    return BigInt(view.amount);
  } catch {
    return null;
  }
}

async function serve(ctx, parsed) {
  const site = requireAccount(ctx.config);
  const flags = parsed.flags;
  const relayer = relayerFor(site, flags);
  const port = portOf(flags.port);
  if (flags.host === true) throw usage("quay: --host needs an address");
  const host = flags.host ?? "127.0.0.1";
  const { createRelayServer, createNearChain, defaultOrigins } = await import(
    "../vendor/relay/server.mjs"
  );
  const chain =
    ctx.relayChain ??
    (await createNearChain({
      rpc: ctx.config.rpc,
      site,
      relayer,
      secret: relayerKey(ctx, relayer),
    }));
  const policy = {};
  const perAccount = countOf(flags, "per-account");
  const dailyTgas = countOf(flags, "daily-tgas");
  if (perAccount) policy.perAccountPerHour = perAccount;
  if (dailyTgas) policy.dailyTgas = dailyTgas;
  const extra =
    typeof flags.origin === "string" ? flags.origin.split(",").filter(Boolean) : [];
  const relay = createRelayServer({
    site,
    relayer,
    chain,
    policy,
    origins: [...defaultOrigins(site), ...extra],
    trustProxy: Boolean(flags["trust-proxy"]),
    log: ctx.json ? () => {} : (line) => writeErr(ctx, line),
  });
  let url;
  try {
    url = await relay.listen(port, host);
  } catch (error) {
    throw new QuayError(
      error?.code === "EADDRINUSE"
        ? `port ${port} is in use. Pass --port with another number.`
        : `could not listen on ${host}:${port}: ${error?.message ?? error}`,
      1,
    );
  }
  let balance = null;
  try {
    balance = BigInt(await chain.balance());
  } catch {}
  emit(
    ctx,
    {
      url,
      site,
      relayer,
      balance: balance?.toString() ?? null,
      policy: relay.policy.methods,
    },
    [
      `relaying for ${site} at ${url}`,
      `relayer  ${relayer}${balance === null ? "" : `, ${formatNear(balance)} NEAR`}`,
      "This is the one off-chain piece of the site: if it stops, members cannot write, but the site and its data stay up.",
      "The relayer balance is the spend limit. Ctrl-C stops it.",
    ].join("\n"),
  );
  ctx.onRelayReady?.({ url, port: relay.server.address().port });
  await (ctx.relayStop ?? waitForSignal());
  await relay.close();
  if (!ctx.json) writeErr(ctx, "relay stopped");
}

async function status(ctx, parsed) {
  const site = requireAccount(ctx.config);
  const relayer = relayerFor(site, parsed.flags);
  const keyPath = join(ctx.credentialsDir, `${relayer}.json`);
  const hasKey = Boolean(process.env.QUAY_RELAYER_KEY) || existsSync(keyPath);
  const balance = await balanceOf(ctx, relayer);
  const exists = balance !== null;
  const port = portOf(parsed.flags.port);
  const host = parsed.flags.host ?? "127.0.0.1";
  let server = null;
  try {
    const res = await (ctx.fetch ?? fetch)(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    server = await res.json();
  } catch {}
  const payload = {
    site,
    relayer,
    account_exists: exists,
    balance: balance?.toString() ?? null,
    key_file: hasKey,
    server,
  };
  emit(
    ctx,
    payload,
    [
      `site     ${site}`,
      `relayer  ${relayer}${exists ? "" : " (does not exist, run quay relay create)"}`,
      `balance  ${exists ? `${formatNear(balance)} NEAR` : "n/a"}`,
      `key      ${hasKey ? "found" : "missing"}`,
      server
        ? `server   running on ${host}:${port}, ${server.ok ? "healthy" : "balance too low"}`
        : `server   not running on ${host}:${port} (quay relay serve)`,
    ].join("\n"),
  );
}

async function create(ctx, parsed) {
  const site = requireAccount(ctx.config);
  owner(ctx);
  const relayer = relayerFor(site, parsed.flags);
  if (!relayer.endsWith(`.${site}`))
    throw usage(`quay: the relayer must be a sub-account of ${site}`);
  const amount = parseNear(
    parsed.flags.near === undefined || parsed.flags.near === true
      ? DEFAULT_RELAY_FUNDING
      : parsed.flags.near,
    "--near",
  );
  const keyPath = join(ctx.credentialsDir, `${relayer}.json`);
  if (existsSync(keyPath))
    throw new QuayError(
      `${keyPath} already exists. Fund the relayer instead, or remove the file.`,
      1,
    );
  if ((await balanceOf(ctx, relayer)) !== null)
    throw new QuayError(`${relayer} already exists`, 1);
  if (ctx.dryRun) {
    emit(
      ctx,
      { dry_run: true, relayer, near: amount.toString() },
      `dry run: create ${relayer} with ${formatNear(amount)} NEAR from ${site}`,
    );
    return;
  }
  if (
    !(await confirm(
      ctx,
      `Create ${relayer} and move ${formatNear(amount)} NEAR from ${site} to it?`,
    ))
  )
    return;
  const key = KeyPair.fromRandom("ed25519");
  const publicKey = key.getPublicKey().toString();
  const make =
    ctx.relayCreate ??
    (async ({ relayer: id, publicKey: pk, amount: yocto }) => {
      const account = new Account(
        site,
        new JsonRpcProvider({ url: ctx.config.rpc }),
        ctx.signer.secret,
      );
      const outcome = await account.createSubAccount({
        accountOrPrefix: id,
        publicKey: pk,
        nearToTransfer: yocto,
      });
      return { hash: outcome?.transaction?.hash };
    });
  // Save the key first: if it cannot be written, nothing was created on chain.
  mkdirSync(ctx.credentialsDir, { recursive: true });
  writeFileSync(
    keyPath,
    `${JSON.stringify({ account_id: relayer, public_key: publicKey, private_key: key.toString() }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  let sent;
  try {
    sent = await make({ relayer, publicKey, amount });
  } catch (error) {
    rmSync(keyPath, { force: true });
    throw error;
  }
  emit(
    ctx,
    {
      relayer,
      public_key: publicKey,
      near: amount.toString(),
      key_file: keyPath,
      transaction: sent?.hash ?? null,
    },
    [
      `created ${relayer} with ${formatNear(amount)} NEAR`,
      `key ${keyPath}`,
      sent?.hash ? `transaction ${explorerUrl(sent.hash)}` : null,
      "next  quay relay serve",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export async function relayCmd(ctx, parsed) {
  const sub = parsed.rest[0];
  if (!sub || parsed.flags.help) {
    writeOut(ctx, helpText("relay"));
    if (!sub) throw new QuayError("quay relay needs serve, status, or create", 1);
    return;
  }
  if (sub === "serve") return serve(ctx, parsed);
  if (sub === "status") return status(ctx, parsed);
  if (sub === "create") return create(ctx, parsed);
  throw new QuayError(`unknown relay command ${sub}`, 1);
}
