import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  credentialsHome,
  FAUCET_URL,
  gatewayFor,
  requireAccount,
} from "./config.mjs";
import { generateKey } from "./chain.mjs";
import { refused, QuayError } from "./errors.mjs";
import { readProject } from "./projectfile.mjs";
import { gateway, localCommand, publicGatewayHealth } from "./gateway.mjs";
import { cronCmd } from "./cron.mjs";
import { db } from "./db.mjs";
import { functionsCmd } from "./functions.mjs";
import { secretsCmd } from "./secrets.mjs";
import { parseCount } from "./units.mjs";
import { membersCmd } from "./members.mjs";
import { productsCmd, receiptsCmd } from "./products.mjs";
import { allReleases, deployRelease, reportDeploy } from "./release.mjs";
import {
  confirm,
  explorerUrl,
  owner,
  previewUrl,
  stopped,
  VERSIONED_NOTE,
  waitForGateway,
} from "./shared.mjs";
import { relayCmd } from "./relay.mjs";
import { up } from "./up.mjs";
import { checkId, yoctoUnlocked } from "./site.mjs";
import {
  emit,
  formatBytes,
  formatNear,
  formatTime,
  helpText,
  paint,
  table,
  writeErr,
  writeOut,
} from "./text.mjs";

const FALLBACK_METHODS = ["put_chunk", "seal"];

export { explorerUrl, previewUrl, waitForGateway };

export function initLines({
  adopted,
  account,
  funded,
  version,
  hash,
  gateway,
}) {
  const lines = [
    `${adopted ? "adopted" : "created"} ${account}`,
    `funded ${funded}`,
    `contract ${version}`,
  ];
  if (hash) lines.push(`transaction ${explorerUrl(hash)}`);
  lines.push(`gateway ${gateway}`);
  lines.push("next  quay deploy");
  return lines.join("\n");
}

export async function run(ctx, parsed) {
  if (parsed.flags.version) {
    writeOut(ctx, "2.0.0");
    return 0;
  }
  if (
    parsed.command === "help" ||
    parsed.flags.help ||
    parsed.command === "help"
  ) {
    const topic =
      parsed.command === "help"
        ? parsed.rest[0]
        : parsed.flags.help
          ? parsed.command
          : undefined;
    writeOut(ctx, helpText(topic === "help" ? undefined : topic));
    return 0;
  }
  const handlers = {
    init: init,
    deploy: deploy,
    promote: promote,
    rollback: rollback,
    releases: releases,
    status: status,
    open: open,
    delete: deleteRelease,
    keys: keys,
    gateway: gateway,
    db: db,
    members: membersCmd,
    products: productsCmd,
    receipts: receiptsCmd,
    relay: relayCmd,
    up: up,
    cron: cronCmd,
    functions: functionsCmd,
    secrets: secretsCmd,
  };
  const handler = handlers[parsed.command];
  if (!handler) {
    writeErr(ctx, helpText());
    throw new QuayError(`unknown command ${parsed.command}`, 1);
  }
  await handler(ctx, parsed);
  return 0;
}

async function publishMethods(chain) {
  try {
    const methods = await chain.view("publish_methods", {});
    if (Array.isArray(methods) && methods.length > 0)
      return methods.map(String);
  } catch {
    return FALLBACK_METHODS;
  }
  return FALLBACK_METHODS;
}

export async function deploy(ctx, parsed) {
  requireAccount(ctx.config);
  if (!ctx.signer?.secret)
    throw new QuayError("no signing key for this account", 1);
  const flags = parsed.flags;
  const project = ctx.config.path ? readProject(ctx.config.path) : null;
  const result = await deployRelease(ctx, {
    dir: parsed.rest[0] ?? ".",
    message: flags.message ? String(flags.message) : "",
    spa: Boolean(ctx.spa),
    id: flags.id,
    routes: project?.routes ?? [],
    externalOver:
      flags["external-over"] !== undefined
        ? parseCount(flags["external-over"], "--external-over", { min: 1 })
        : (project?.files.external_over ?? null),
    store: flags.store
      ? String(flags.store)
      : (project?.files.store ?? "nearfs"),
    verify: !flags["no-verify"],
    verifyTimeoutMs:
      flags["verify-wait"] !== undefined
        ? parseCount(flags["verify-wait"], "--verify-wait", { min: 0 }) * 1000
        : undefined,
  });
  if (result.stopped) return;
  if (result.dryRun) {
    emit(
      ctx,
      { ...result.summary, dry_run: true, next: result.next },
      `${result.summary.url}\ndry run\nnext  ${result.next}`,
    );
    return;
  }
  reportDeploy(ctx, result);
  if (result.listed.length === 0) await waitForGateway(ctx, result.summary.url);
}

export async function promote(ctx, parsed) {
  owner(ctx);
  const id = checkId(parsed.rest[0] ?? "");
  const current = await ctx.chain.view("get_status", {});
  if (current?.production === id)
    throw new QuayError(`${id} is already production`, 1);
  const release = await ctx.chain.view("get_release", { id });
  if (!release) throw new QuayError(`release ${id} is missing`, 1);
  const ok = await confirm(ctx, `Make ${id} the production release?`);
  if (!ok) return stopped(ctx);
  const sent = await ctx.chain.promote(id);
  const url = previewUrl(ctx.config.gateway);
  const transactionUrl = explorerUrl(sent.hash);
  emit(
    ctx,
    { id, url, transaction: sent.hash, transaction_url: transactionUrl },
    `${id} is production\n${url}\ntransaction ${transactionUrl}`,
  );
}

export async function rollback(ctx) {
  owner(ctx);
  const current = await ctx.chain.view("get_status", {});
  if (!current?.previous) throw refused("nothing to roll back");
  const ok = await confirm(ctx, `Roll production back to ${current.previous}?`);
  if (!ok) return stopped(ctx);
  const sent = await ctx.chain.rollback();
  const id = typeof sent.value === "string" ? sent.value : current.previous;
  const url = previewUrl(ctx.config.gateway);
  const transactionUrl = explorerUrl(sent.hash);
  emit(
    ctx,
    {
      id,
      previous: current.production,
      url,
      transaction: sent.hash,
      transaction_url: transactionUrl,
      versioned: VERSIONED_NOTE.split("\n"),
    },
    `${id} is production\n${url}\ntransaction ${transactionUrl}\n${VERSIONED_NOTE}`,
  );
}

export async function releases(ctx) {
  requireAccount(ctx.config);
  const [rows, current] = await Promise.all([
    allReleases(ctx.chain),
    ctx.chain.view("get_status", {}),
  ]);
  const view = rows.map((release) => ({
    id: release.id,
    date: formatTime(release.timestamp),
    files: release.file_count,
    size: formatBytes(release.bytes),
    message: release.message || "",
    role:
      release.id === current?.production
        ? "production"
        : release.id === current?.previous
          ? "previous"
          : "",
  }));
  if (ctx.json) {
    writeOut(
      ctx,
      JSON.stringify({
        production: current?.production ?? null,
        releases: view,
      }),
    );
    return;
  }
  if (view.length === 0) {
    writeOut(ctx, "no releases");
    return;
  }
  const lines = table(view, [
    { key: "id", label: "id" },
    { key: "date", label: "date" },
    { key: "files", label: "files" },
    { key: "size", label: "size" },
    { key: "message", label: "message" },
    { key: "role", label: "role" },
  ]);
  writeOut(ctx, colorRoles(ctx, lines));
}

function colorRoles(ctx, lines) {
  if (!ctx.color) return lines;
  return lines
    .split("\n")
    .map((line) =>
      line.trimEnd().endsWith("production") ? paint(true, "36", line) : line,
    )
    .join("\n");
}

export async function status(ctx) {
  const account = requireAccount(ctx.config);
  const [current, health] = await Promise.all([
    ctx.chain.view("get_status", {}),
    publicGatewayHealth(ctx),
  ]);
  const local = localCommand(account);
  const payload = {
    account,
    network: "testnet",
    version: current.version,
    production: current.production,
    previous: current.previous,
    releases: current.release_count,
    stored_bytes: current.stored_bytes,
    max_bytes: current.max_bytes,
    gateway: ctx.config.gateway,
    production_url: previewUrl(ctx.config.gateway),
    gateway_health: health,
    local_gateway: local,
  };
  const reach = health.ok
    ? `ok ${health.status}, ${health.ms} ms`
    : `down: ${health.reason}, ${health.ms} ms`;
  emit(
    ctx,
    payload,
    [
      `account      ${account}`,
      `version      ${current.version}`,
      `production   ${current.production ?? "none"}`,
      `previous     ${current.previous ?? "none"}`,
      `releases     ${current.release_count}`,
      `stored       ${formatBytes(current.stored_bytes)} of ${formatBytes(current.max_bytes)}`,
      `gateway      ${ctx.config.gateway}  ${reach}`,
      `local        ${local}`,
    ].join("\n"),
  );
}

export async function open(ctx, parsed) {
  requireAccount(ctx.config);
  const id = parsed.rest[0] ? checkId(parsed.rest[0]) : null;
  if (id) {
    const release = await ctx.chain.view("get_release", { id });
    if (!release) throw new QuayError(`release ${id} is missing`, 1);
  }
  const url = previewUrl(ctx.config.gateway, id);
  emit(ctx, { url }, url);
  if (!ctx.json && process.platform === "darwin") {
    const child = spawn("open", [url], { stdio: "ignore", detached: true });
    child.unref();
  }
}

export async function deleteRelease(ctx, parsed) {
  owner(ctx);
  const id = checkId(parsed.rest[0] ?? "");
  const current = await ctx.chain.view("get_status", {});
  if (current?.production === id) throw refused("cannot delete production");
  const release = await ctx.chain.view("get_release", { id });
  if (!release) throw new QuayError(`release ${id} is missing`, 1);
  const ok = await confirm(ctx, `Delete release ${id} and unlock its storage?`);
  if (!ok) return stopped(ctx);
  const sent = await ctx.chain.deleteRelease(id);
  const bytes = BigInt(sent.value ?? release.bytes ?? 0);
  emit(
    ctx,
    {
      id,
      bytes_freed: bytes.toString(),
      unlocked_near: formatNear(yoctoUnlocked(bytes)),
      transaction: sent.hash,
    },
    `deleted ${id}\nunlocked about ${formatNear(yoctoUnlocked(bytes))} NEAR on the contract account`,
  );
}

export async function keys(ctx, parsed) {
  const sub = parsed.rest[0];
  if (!sub || parsed.flags.help) {
    writeOut(ctx, helpText("keys"));
    if (!sub)
      throw new QuayError("quay keys needs create, list, revoke, or prove", 1);
    return;
  }
  if (sub === "create") return keysCreate(ctx);
  if (sub === "list") return keysList(ctx);
  if (sub === "revoke") return keysRevoke(ctx, parsed.rest[1]);
  if (sub === "prove") return keysProve(ctx);
  throw new QuayError(`unknown keys command ${sub}`, 1);
}

async function keysCreate(ctx) {
  owner(ctx);
  if (!ctx.ci)
    throw new QuayError(
      "pass --ci. This command creates a publish-only key.",
      1,
    );
  const account = requireAccount(ctx.config);
  const methods = await publishMethods(ctx.chain);
  const key = ctx.generateKey();
  const sent = await ctx.chain.addPublishKey(key.publicKey, methods);
  const file = join(ctx.credentialsDir, `${account}.ci.json`);
  writeKeyFile(file, {
    account_id: account,
    public_key: key.publicKey,
    private_key: key.secret,
  });
  const payload = {
    account,
    public_key: key.publicKey,
    private_key: key.secret,
    methods,
    credential_file: file,
    github_secret: "QUAY_CI_KEY",
    transaction: sent.hash,
    warning: "The private key is shown once. Do not record this output.",
  };
  if (ctx.json) {
    writeOut(ctx, JSON.stringify(payload));
    return;
  }
  writeOut(
    ctx,
    [
      `public  ${key.publicKey}`,
      `secret  ${key.secret}`,
      "",
      "Store the secret as a GitHub Actions secret named QUAY_CI_KEY.",
      `Set QUAY_ACCOUNT to ${account}.`,
      "The workflow can deploy a preview. It cannot promote.",
      `A copy is in ${file} with mode 0600. It is outside this repository.`,
      "Do not run this command in a recorded log.",
    ].join("\n"),
  );
}

async function keysList(ctx) {
  requireAccount(ctx.config);
  const listed = await ctx.chain.accessKeys();
  const keys = listed?.keys ?? [];
  const ciPath = join(ctx.credentialsDir, `${ctx.config.account}.ci.json`);
  let ciPublic = null;
  if (existsSync(ciPath)) {
    ciPublic = JSON.parse(readFileSync(ciPath, "utf8"))?.public_key ?? null;
  }
  const rows = keys.map((entry) => {
    const permission = entry.access_key?.permission;
    const limited =
      permission && permission !== "FullAccess" && permission.FunctionCall;
    return {
      public_key: String(entry.public_key),
      access: limited ? "publish" : "full",
      methods: limited ? permission.FunctionCall.method_names.join(",") : "",
      note: String(entry.public_key) === ciPublic ? "ci file" : "",
    };
  });
  if (ctx.json) {
    writeOut(ctx, JSON.stringify({ keys: rows }));
    return;
  }
  if (rows.length === 0) {
    writeOut(ctx, "no access keys");
    return;
  }
  writeOut(
    ctx,
    table(rows, [
      { key: "public_key", label: "public key" },
      { key: "access", label: "access" },
      { key: "methods", label: "methods" },
      { key: "note", label: "note" },
    ]),
  );
}

async function keysRevoke(ctx, publicKey) {
  owner(ctx);
  if (!publicKey) throw new QuayError("quay keys revoke needs a public key", 1);
  if (publicKey === ctx.signer.publicKey)
    throw refused("refusing to revoke the key that is signing");
  const sent = await ctx.chain.deleteKey(publicKey);
  const ciPath = join(ctx.credentialsDir, `${ctx.config.account}.ci.json`);
  if (existsSync(ciPath)) {
    const saved = JSON.parse(readFileSync(ciPath, "utf8"));
    if (saved.public_key === publicKey) rmSync(ciPath);
  }
  emit(
    ctx,
    { public_key: publicKey, transaction: sent.hash },
    `revoked ${publicKey}`,
  );
}

async function keysProve(ctx) {
  owner(ctx);
  requireAccount(ctx.config);
  const ciSecret = ctx.ciSecret;
  if (!ciSecret)
    throw new QuayError(
      "no publish-only key. Run quay keys create --ci first.",
      1,
    );
  const result = await ctx.chain.relayRefusal(ciSecret);
  if (!result.refused) {
    throw new QuayError("the publish-only key was able to promote", 2);
  }
  const url = result.hash ? explorerUrl(result.hash) : null;
  emit(
    ctx,
    { refused: true, message: result.message, transaction: result.hash, url },
    [
      `refused  ${result.message}`,
      url ?? "the refusal had no transaction hash",
    ].join("\n"),
  );
}

export async function init(ctx, parsed) {
  if (ctx.signer?.limited) throw refused("a publish-only key cannot init");
  const requested = parsed.rest[0] || ctx.config.account;
  const replacing = Boolean(parsed.flags.replace);
  if (replacing) owner(ctx);
  let account = requested;
  let key = ctx.signer?.secret ? ctx.signer : null;
  if (!account) {
    account = freshAccount();
    key = ctx.generateKey();
    rememberKey(ctx, account, key);
    await fundAccount(account, key.publicKey);
    ctx = reconnect(ctx, account, key);
    await waitForAccount(ctx);
    const wasm = ctx.readWasm();
    const sent = await ctx.chain.deployAndInit(wasm);
    await finishInit(ctx, account, key, sent.hash, false);
    return;
  }
  if (!/^[a-z0-9._-]+\.testnet$/.test(account)) {
    throw new QuayError("the account must end in .testnet", 1);
  }
  if (!key?.secret) {
    key = ctx.generateKey();
    rememberKey(ctx, account, key);
    await fundAccount(account, key.publicKey);
    ctx = reconnect(ctx, account, key);
    await waitForAccount(ctx);
  } else {
    ctx = reconnect(ctx, account, key);
    const view = await ctx.chain.accountView();
    if (!view) {
      await fundAccount(account, key.publicKey);
      await waitForAccount(ctx);
    }
  }
  const view = await ctx.chain.accountView();
  const hasCode = view && !ctx.emptyCode(view.code_hash);
  if (!hasCode) {
    const wasm = ctx.readWasm();
    const sent = await ctx.chain.deployAndInit(wasm);
    await finishInit(ctx, account, key, sent.hash, false);
    return;
  }
  let version = null;
  try {
    version = await ctx.chain.view("get_version", {});
  } catch {
    version = null;
  }
  if (!replacing) {
    await finishInit(ctx, account, key, null, true, version?.version ?? null);
    return;
  }
  const ok = await confirm(
    ctx,
    `Replace the wasm on ${account}? A full-access key can do this.`,
  );
  if (!ok) return stopped(ctx);
  const wasm = ctx.readWasm();
  const sent = await ctx.chain.replaceWasm(wasm);
  await finishInit(
    ctx,
    account,
    key,
    sent.hash,
    true,
    version?.version ?? null,
  );
}

function reconnect(ctx, account, key) {
  const next = ctx.connect({
    account,
    secret: key.secret,
    publicKey: key.publicKey,
  });
  return next;
}

async function finishInit(ctx, account, key, hash, adopted, version = "2.0.0") {
  const file = join(ctx.credentialsDir, `${account}.json`);
  if (key?.secret && key?.publicKey) {
    writeKeyFile(file, {
      account_id: account,
      public_key: key.publicKey,
      private_key: key.secret,
    });
  }
  const config = {
    account,
    network: "testnet",
    rpc: ctx.config.rpc,
    gateway: gatewayFor(account),
  };
  writeFileSync(
    join(ctx.cwd, "quay.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  let funded = "unknown";
  try {
    const view = await ctx.chain.accountView();
    if (view?.amount != null) {
      funded = `${formatNear(BigInt(view.amount))} NEAR`;
    }
  } catch {
    funded = "unknown";
  }
  let reported = version || "unknown";
  try {
    const got = await ctx.chain.view("get_version", {});
    if (got?.version) reported = got.version;
  } catch {
    reported = version || "unknown";
  }
  await waitForGateway(ctx, config.gateway);
  const plain = initLines({
    adopted,
    account,
    funded,
    version: reported,
    hash,
    gateway: config.gateway,
  });
  emit(
    ctx,
    {
      ...config,
      adopted,
      version: reported,
      funded,
      transaction: hash,
      transaction_url: hash ? explorerUrl(hash) : null,
      credential_file: file,
    },
    `${plain}\n`,
  );
}

function freshAccount() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let index = 0; index < 8; index += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `quay-${suffix}.testnet`;
}

async function fundAccount(accountId, publicKey) {
  const response = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      newAccountId: accountId,
      newAccountPublicKey: publicKey,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new QuayError(
      `faucet returned ${response.status}: ${text.slice(0, 180)}`,
      2,
    );
  }
}

async function waitForAccount(ctx) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const view = await ctx.chain.accountView();
    if (view) return view;
    await new Promise((done) => setTimeout(done, 1500));
  }
  throw new QuayError("the account was not visible on the RPC yet", 2);
}

function rememberKey(ctx, account, key) {
  if (!key?.secret || !key?.publicKey) return;
  writeKeyFile(join(ctx.credentialsDir, `${account}.json`), {
    account_id: account,
    public_key: key.publicKey,
    private_key: key.secret,
  });
}

function writeKeyFile(path, record) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export { generateKey, credentialsHome };
