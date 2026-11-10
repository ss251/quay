// `quay gateway`: serve an account's site on this machine over JSON-RPC, for
// when the public testnet.page gateway is down. The core is vendored from
// gateway/src by `node gateway/build.mjs`, so the packed CLI carries it.
import {
  cleanRpcUrls,
  createGateway,
  DEFAULT_RPC_URLS,
  probeGateway,
} from "../vendor/gateway/core.mjs";
import { localUrl, serve } from "../vendor/gateway/node.mjs";
import { DEFAULT_RPC, requireAccount } from "./config.mjs";
import { QuayError, usage } from "./errors.mjs";
import { emit, writeErr } from "./text.mjs";

export const DEFAULT_PORT = 8787;

export function localCommand(account) {
  return `quay gateway --account ${account}`;
}

// --rpc flags in order, else a custom quay.json/QUAY_RPC endpoint first, then
// the defaults. The deprecated rpc.testnet.near.org is always dropped.
export function rpcList(flags, config) {
  const given = flags.rpcList?.length ? flags.rpcList : [];
  const base = given.length
    ? given
    : config.rpc && config.rpc !== DEFAULT_RPC
      ? [config.rpc, ...DEFAULT_RPC_URLS]
      : DEFAULT_RPC_URLS;
  return cleanRpcUrls(base);
}

function portOf(value) {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (value === true || !Number.isInteger(port) || port < 0 || port > 65535)
    throw usage("quay: --port needs a number from 0 to 65535");
  return port;
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

export async function gateway(ctx, parsed) {
  const account = requireAccount(ctx.config);
  const port = portOf(parsed.flags.port);
  if (parsed.flags.host === true) throw usage("quay: --host needs an address");
  const host = parsed.flags.host ?? "127.0.0.1";
  const { urls, dropped } = rpcList(parsed.flags, ctx.config);
  for (const url of dropped)
    writeErr(ctx, `skipping ${url}: deprecated or not a URL`);
  if (!urls.length) throw new QuayError("no usable RPC URL", 1);
  const handler = createGateway({
    account,
    rpcUrls: urls,
    fetch: ctx.fetch,
  });
  let server;
  try {
    server = await serve(handler, {
      port,
      host,
      log: ctx.json ? undefined : (line) => writeErr(ctx, line),
    });
  } catch (error) {
    throw new QuayError(
      error?.code === "EADDRINUSE"
        ? `port ${port} is in use. Pass --port with another number.`
        : `could not listen on ${host}:${port}: ${error?.message ?? error}`,
      1,
    );
  }
  const url = localUrl(server.host, server.port);
  emit(
    ctx,
    { url, account, rpc: urls },
    [
      `serving ${account} at ${url}`,
      `rpc      ${urls.join(", ")}`,
      "Ctrl-C stops it.",
    ].join("\n"),
  );
  ctx.onGatewayReady?.({ url, port: server.port });
  await (ctx.gatewayStop ?? waitForSignal());
  await server.close();
  if (!ctx.json) writeErr(ctx, "gateway stopped");
}

// The public gateway line for `quay status`: one request, timed and classified.
export async function publicGatewayHealth(ctx) {
  const url = `${String(ctx.config.gateway).replace(/\/$/, "")}/`;
  return probeGateway(url, {
    fetch: ctx.fetch,
    timeoutMs: ctx.gatewayProbeMs ?? 8000,
  });
}
