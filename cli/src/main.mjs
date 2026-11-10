import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./app.mjs";
import { createChain, emptyCodeHash, generateKey, publicKeyOf, readWasm } from "./chain.mjs";
import { credentialsHome, gatewayFor, readKeyFile, resolveConfig } from "./config.mjs";
import { QuayError } from "./errors.mjs";
import { parseArgs, redact } from "./text.mjs";

export async function main(argv, io = {}) {
  const parsed = parseArgs(argv);
  const secrets = [];
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const config = resolveConfig(parsed.flags, io.cwd ?? process.cwd());
    const credentialsDir = io.credentialsDir ?? credentialsHome(config.network || "testnet");
    const showingHelp = parsed.command === "help" || parsed.flags.help || parsed.flags.version;
    const signWithCi =
      !showingHelp &&
      (Boolean(process.env.QUAY_CI_KEY) || (Boolean(parsed.flags.ci) && parsed.command !== "keys"));
    const accountForKey = parsed.command === "init" && parsed.rest[0] ? String(parsed.rest[0]) : config.account;
    const signer = showingHelp ? null : loadSigner({ account: accountForKey, credentialsDir, signWithCi, secrets });
    const ciSecret = showingHelp ? null : loadCiSecret(accountForKey, credentialsDir, secrets);
    const base = {
      json: Boolean(parsed.flags.json),
      yes: Boolean(parsed.flags.yes),
      dryRun: Boolean(parsed.flags["dry-run"]),
      spa: Boolean(parsed.flags.spa),
      ci: Boolean(parsed.flags.ci),
      color: Boolean(stdout.isTTY) && !parsed.flags.json && !process.env.NO_COLOR,
      isTTY: Boolean(io.isTTY ?? process.stdin.isTTY) && !parsed.flags.yes,
      stdin: io.stdin ?? process.stdin,
      stdout,
      stderr,
      config,
      cwd: io.cwd ?? process.cwd(),
      credentialsDir,
      signer,
      ciSecret,
      secrets,
      generateKey: io.generateKey ?? generateKey,
      readWasm: () => readWasm(io.wasmPath ?? defaultWasm()),
      emptyCode: emptyCodeHash,
    };
    base.connect = ({ account, secret, publicKey }) => {
      const nextConfig = {
        ...base.config,
        account,
        network: "testnet",
        rpc: base.config.rpc,
        gateway: gatewayFor(account),
      };
      return {
        ...base,
        config: nextConfig,
        signer: { secret, publicKey, limited: false },
        chain: createChain({ accountId: account, rpc: nextConfig.rpc, secret }),
      };
    };
    const chain =
      config.account && !showingHelp
        ? createChain({ accountId: config.account, rpc: config.rpc, secret: signer?.secret })
        : null;
    return (await run({ ...base, chain }, parsed)) ?? 0;
  } catch (error) {
    stderr.write(`quay: ${redact(error?.message ?? error, secrets)}\n`);
    return error instanceof QuayError ? error.code : 2;
  }
}

function defaultWasm() {
  return fileURLToPath(new URL("../vendor/quay.wasm", import.meta.url));
}

function loadSigner({ account, credentialsDir, signWithCi, secrets }) {
  if (!account) return null;
  if (signWithCi) {
    if (process.env.QUAY_CI_KEY) {
      secrets.push(process.env.QUAY_CI_KEY);
      return { secret: process.env.QUAY_CI_KEY, publicKey: publicKeyOf(process.env.QUAY_CI_KEY), limited: true };
    }
    const path = join(credentialsDir, `${account}.ci.json`);
    if (!existsSync(path)) throw new QuayError(`no publish-only key at ${path}`, 1);
    const file = readKeyFile(path);
    secrets.push(file.private_key);
    return { secret: file.private_key, publicKey: file.public_key, limited: true };
  }
  const path = join(credentialsDir, `${account}.json`);
  if (!existsSync(path)) return null;
  const file = readKeyFile(path);
  secrets.push(file.private_key);
  return { secret: file.private_key, publicKey: file.public_key, limited: false };
}

function loadCiSecret(account, credentialsDir, secrets) {
  if (process.env.QUAY_CI_KEY) {
    if (!secrets.includes(process.env.QUAY_CI_KEY)) secrets.push(process.env.QUAY_CI_KEY);
    return process.env.QUAY_CI_KEY;
  }
  if (!account) return null;
  const path = join(credentialsDir, `${account}.ci.json`);
  if (!existsSync(path)) return null;
  const file = readKeyFile(path);
  if (!secrets.includes(file.private_key)) secrets.push(file.private_key);
  return file.private_key;
}
