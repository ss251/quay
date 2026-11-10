import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { QuayError } from "./errors.mjs";
import { assertTestnet } from "./text.mjs";

import { DEFAULT_RPC_URLS } from "./failover.mjs";

export const DEFAULT_RPC = DEFAULT_RPC_URLS[0];
export const FAUCET_URL = "https://helper.nearprotocol.com/account";

export function findConfig(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    const path = join(dir, "quay.json");
    if (existsSync(path)) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        throw new QuayError(`quay.json is not valid JSON: ${path}`, 1);
      }
      return { path, ...parsed };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function gatewayFor(account) {
  const name = String(account).replace(/\.testnet$/, "");
  return `https://${name}.testnet.page`;
}

export function resolveConfig(flags, start = process.cwd()) {
  const file = findConfig(start);
  const account = flags.account || process.env.QUAY_ACCOUNT || file?.account;
  const network = process.env.QUAY_NETWORK || file?.network || "testnet";
  const given = flags.rpcList?.length
    ? flags.rpcList
    : [flags.rpc || process.env.QUAY_RPC || file?.rpc].filter(
        (value) => typeof value === "string" && value,
      );
  // An RPC the user named is the only one used. Without one, fail over.
  const rpcExplicit = given.length > 0;
  const rpcUrls = rpcExplicit ? given : DEFAULT_RPC_URLS;
  const rpc = rpcUrls[0];
  assertTestnet(network);
  return {
    account,
    network,
    rpc,
    rpcUrls,
    rpcExplicit,
    gateway: account ? gatewayFor(account) : file?.gateway,
    path: file?.path ?? null,
  };
}

export function requireAccount(config) {
  if (!config.account) {
    throw new QuayError("no account. Run quay init, or pass --account.", 1);
  }
  if (!/^[a-z0-9._-]+\.testnet$/.test(config.account)) {
    throw new QuayError("the account must be a testnet account id", 1);
  }
  return config.account;
}

export function credentialsHome(network = "testnet") {
  return join(homedir(), ".near-credentials", network);
}

export function readKeyFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new QuayError(`could not read the key file ${path}`, 1);
  }
  if (!parsed.private_key || !parsed.public_key) {
    throw new QuayError(`the key file ${path} has no key`, 1);
  }
  return parsed;
}
