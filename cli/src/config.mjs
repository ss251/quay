import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { QuayError } from "./errors.mjs";
import { assertTestnet } from "./text.mjs";

export const DEFAULT_RPC = "https://test.rpc.fastnear.com";
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
  return `https://${account}.testnet.page`;
}

export function resolveConfig(flags, start = process.cwd()) {
  const file = findConfig(start);
  const account = flags.account || process.env.QUAY_ACCOUNT || file?.account;
  const network = process.env.QUAY_NETWORK || file?.network || "testnet";
  const rpc = flags.rpc || process.env.QUAY_RPC || file?.rpc || DEFAULT_RPC;
  assertTestnet(network);
  return {
    account,
    network,
    rpc,
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
