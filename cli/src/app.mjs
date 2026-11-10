import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";

import { credentialsHome, FAUCET_URL, gatewayFor, requireAccount } from "./config.mjs";
import { generateKey } from "./chain.mjs";
import { refused, QuayError } from "./errors.mjs";
import {
  checkId,
  checkMessage,
  chunkFile,
  collectSite,
  MAX_STORED_BYTES,
  nextReleaseId,
  planRelease,
  yoctoUnlocked,
} from "./site.mjs";
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

export function previewUrl(gateway, id) {
  const base = String(gateway).replace(/\/$/, "");
  return id ? `${base}/r/${id}/` : `${base}/`;
}

export function explorerUrl(hash) {
  return `https://explorer.testnet.near.org/transactions/${hash}`;
}

export async function run(ctx, parsed) {
  if (parsed.flags.version) {
    writeOut(ctx, "2.0.0");
    return 0;
  }
  if (parsed.command === "help" || parsed.flags.help || parsed.command === "help") {
    const topic = parsed.command === "help" ? parsed.rest[0] : parsed.flags.help ? parsed.command : undefined;
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
  };
  const handler = handlers[parsed.command];
  if (!handler) {
    writeErr(ctx, helpText());
    throw new QuayError(`unknown command ${parsed.command}`, 1);
  }
  await handler(ctx, parsed);
  return 0;
}

function owner(ctx) {
  if (ctx.signer?.limited) throw refused("a publish-only key cannot do that");
  if (!ctx.signer?.secret) throw new QuayError("no signing key for this account", 1);
}

async function confirm(ctx, question) {
  if (ctx.dryRun) return false;
  if (ctx.yes || !ctx.isTTY) return true;
  writeErr(ctx, `${question} [y/N]`);
  const lines = createInterface({ input: ctx.stdin, output: ctx.stderr });
  const answer = await new Promise((done) => {
    lines.once("line", (line) => {
      lines.close();
      done(line);
    });
  });
  return /^y(es)?$/i.test(String(answer).trim());
}

function stopped(ctx) {
  emit(ctx, { stopped: true }, "stopped before spending");
}

async function allReleases(chain) {
  const releases = [];
  let from = 0;
  for (;;) {
    const page = await chain.view("list_releases", { from_index: from, limit: 20 });
    releases.push(...(page?.releases ?? []));
    if (page?.next == null) return releases;
    from = page.next;
  }
}

async function publishMethods(chain) {
  try {
    const methods = await chain.view("publish_methods", {});
    if (Array.isArray(methods) && methods.length > 0) return methods.map(String);
  } catch {
    return FALLBACK_METHODS;
  }
  return FALLBACK_METHODS;
}

export async function deploy(ctx, parsed) {
  const account = requireAccount(ctx.config);
  if (!ctx.signer?.secret) throw new QuayError("no signing key for this account", 1);
  const dir = resolve(parsed.rest[0] ?? ".");
  const message = checkMessage(parsed.flags.message ? String(parsed.flags.message) : "");
  const spa = Boolean(ctx.spa);
  const files = collectSite(dir);
  const listed = await allReleases(ctx.chain);
  if (listed.length >= 32) throw new QuayError("the contract already has 32 releases", 1);
  const id = parsed.flags.id ? checkId(String(parsed.flags.id)) : nextReleaseId(listed);
  if (listed.some((release) => release.id === id)) throw new QuayError(`release ${id} already exists`, 1);
  const status = await ctx.chain.view("get_status", {});
  const hashes = new Set();
  for (const file of files) {
    for (const chunk of chunkFile(file.bytes)) hashes.add(chunk.sha256);
  }
  const known = new Set();
  for (const hash of hashes) {
    if (await ctx.chain.hasChunk(hash)) known.add(hash);
  }
  const plan = planRelease(files, known);
  const stored = BigInt(status?.stored_bytes ?? 0);
  const max = BigInt(status?.max_bytes ?? MAX_STORED_BYTES);
  if (stored + plan.newBytes > max) {
    throw new QuayError(
      `this release needs ${plan.newBytes} new bytes and the contract has ${max - stored} left`,
      1,
    );
  }
  const summary = {
    id,
    files: files.length,
    new_bytes: Number(plan.newBytes),
    reused_bytes: Number(plan.reusedBytes),
    estimated_near: formatNear(plan.yocto),
    url: previewUrl(ctx.config.gateway, id),
  };
  writeErr(
    ctx,
    [
      `${summary.files} files, ${formatBytes(summary.new_bytes)} new, ${formatBytes(summary.reused_bytes)} reused`,
      `storage estimate ${summary.estimated_near} NEAR (0.01 NEAR / 1000 bytes, plus trie overhead)`,
    ].join("\n"),
  );
  if (ctx.dryRun) {
    emit(ctx, { ...summary, dry_run: true }, `${summary.url}\ndry run`);
    return;
  }
  const ok = await confirm(ctx, `Store release ${id} on ${account}?`);
  if (!ok) {
    stopped(ctx);
    return;
  }
  const chunkHashes = [];
  const uploaded = [];
  let sealed;
  try {
    for (let index = 0; index < plan.uploads.length; index += 1) {
      const upload = plan.uploads[index];
      writeErr(ctx, `${index + 1}/${plan.uploads.length}  ${upload.path}  ${upload.data.length} bytes`);
      const sent = await ctx.chain.putChunk(upload.sha256, upload.data);
      chunkHashes.push(sent.hash);
      uploaded.push(upload.sha256);
    }
    sealed = await ctx.chain.seal(
      id,
      plan.planned.map((file) => ({
        path: file.path,
        chunks: file.chunks,
        content_type: file.contentType,
      })),
      message,
      spa,
    );
  } catch (error) {
    await dropAbandoned(ctx, uploaded);
    throw error;
  }
  emit(
    ctx,
    { ...summary, message, spa, transaction: sealed.hash, chunk_transactions: chunkHashes },
    `${paint(ctx.color, "36", id)}  ${summary.url}\nreused ${formatBytes(summary.reused_bytes)}`,
  );
}

async function dropAbandoned(ctx, hashes) {
  if (hashes.length === 0) return;
  if (ctx.signer?.limited) {
    writeErr(ctx, "Those new chunks stay stored. A publish-only key cannot drop them.");
    return;
  }
  for (const sha256 of hashes) {
    try {
      await ctx.chain.dropChunk(sha256);
      writeErr(ctx, `dropped unused chunk ${sha256.slice(0, 12)}`);
    } catch (error) {
      writeErr(ctx, `could not drop ${sha256.slice(0, 12)}: ${error.message ?? error}`);
    }
  }
}

export async function promote(ctx, parsed) {
  owner(ctx);
  const id = checkId(parsed.rest[0] ?? "");
  const current = await ctx.chain.view("get_status", {});
  if (current?.production === id) throw new QuayError(`${id} is already production`, 1);
  const release = await ctx.chain.view("get_release", { id });
  if (!release) throw new QuayError(`release ${id} is missing`, 1);
  const ok = await confirm(ctx, `Make ${id} the production release?`);
  if (!ok) return stopped(ctx);
  const sent = await ctx.chain.promote(id);
  const url = previewUrl(ctx.config.gateway);
  emit(ctx, { id, url, transaction: sent.hash }, `${id} is production\n${url}`);
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
  emit(ctx, { id, previous: current.production, url, transaction: sent.hash }, `${id} is production\n${url}`);
}

export async function releases(ctx) {
  requireAccount(ctx.config);
  const [rows, current] = await Promise.all([allReleases(ctx.chain), ctx.chain.view("get_status", {})]);
  const view = rows.map((release) => ({
    id: release.id,
    date: formatTime(release.timestamp),
    files: release.file_count,
    size: formatBytes(release.bytes),
    message: release.message || "",
    role: release.id === current?.production ? "production" : release.id === current?.previous ? "previous" : "",
  }));
  if (ctx.json) {
    writeOut(ctx, JSON.stringify({ production: current?.production ?? null, releases: view }));
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
    .map((line) => (line.trimEnd().endsWith("production") ? paint(true, "36", line) : line))
    .join("\n");
}

export async function status(ctx) {
  const account = requireAccount(ctx.config);
  const current = await ctx.chain.view("get_status", {});
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
  };
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
      `gateway      ${ctx.config.gateway}`,
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
    if (!sub) throw new QuayError("quay keys needs create, list, revoke, or prove", 1);
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
  if (!ctx.ci) throw new QuayError("pass --ci. This command creates a publish-only key.", 1);
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
    const limited = permission && permission !== "FullAccess" && permission.FunctionCall;
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
  if (publicKey === ctx.signer.publicKey) throw refused("refusing to revoke the key that is signing");
  const sent = await ctx.chain.deleteKey(publicKey);
  const ciPath = join(ctx.credentialsDir, `${ctx.config.account}.ci.json`);
  if (existsSync(ciPath)) {
    const saved = JSON.parse(readFileSync(ciPath, "utf8"));
    if (saved.public_key === publicKey) rmSync(ciPath);
  }
  emit(ctx, { public_key: publicKey, transaction: sent.hash }, `revoked ${publicKey}`);
}

async function keysProve(ctx) {
  owner(ctx);
  requireAccount(ctx.config);
  const ciSecret = ctx.ciSecret;
  if (!ciSecret) throw new QuayError("no publish-only key. Run quay keys create --ci first.", 1);
  const result = await ctx.chain.relayRefusal(ciSecret);
  if (!result.refused) {
    throw new QuayError("the publish-only key was able to promote", 2);
  }
  const url = result.hash ? explorerUrl(result.hash) : null;
  emit(
    ctx,
    { refused: true, message: result.message, transaction: result.hash, url },
    [`refused  ${result.message}`, url ?? "the refusal had no transaction hash"].join("\n"),
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
    finishInit(ctx, account, key, sent.hash, false);
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
    finishInit(ctx, account, key, sent.hash, false);
    return;
  }
  let version = null;
  try {
    version = await ctx.chain.view("get_version", {});
  } catch {
    version = null;
  }
  if (!replacing) {
    finishInit(ctx, account, key, null, true, version?.version ?? null);
    return;
  }
  const ok = await confirm(ctx, `Replace the wasm on ${account}? A full-access key can do this.`);
  if (!ok) return stopped(ctx);
  const wasm = ctx.readWasm();
  const sent = await ctx.chain.replaceWasm(wasm);
  finishInit(ctx, account, key, sent.hash, true, version?.version ?? null);
}

function reconnect(ctx, account, key) {
  const next = ctx.connect({ account, secret: key.secret, publicKey: key.publicKey });
  return next;
}

function finishInit(ctx, account, key, hash, adopted, version = "2.0.0") {
  const file = join(ctx.credentialsDir, `${account}.json`);
  if (key?.secret && key?.publicKey) {
    writeKeyFile(file, { account_id: account, public_key: key.publicKey, private_key: key.secret });
  }
  const config = {
    account,
    network: "testnet",
    rpc: ctx.config.rpc,
    gateway: gatewayFor(account),
  };
  writeFileSync(join(ctx.cwd, "quay.json"), `${JSON.stringify(config, null, 2)}\n`);
  emit(
    ctx,
    { ...config, adopted, version, transaction: hash, credential_file: file },
    `${adopted ? "adopted" : "created"} ${account}\n${config.gateway}\n`,
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
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new QuayError(`faucet returned ${response.status}: ${text.slice(0, 180)}`, 2);
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
