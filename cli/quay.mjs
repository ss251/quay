#!/usr/bin/env node
// Publish a file or directory as a sealed Quay release, or move production.
// Keys stay in the local NEAR credentials folder. This script never prints them.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHUNK_BYTES = 200_000;
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(readFileSync(join(ROOT, "quay.json"), "utf8"));
const ACCOUNT = process.env.QUAY_ACCOUNT || config.account;
const NETWORK = process.env.QUAY_NETWORK || config.network;
const RPC = process.env.QUAY_RPC || config.rpc;
const NEAR = process.env.NEAR_BIN || "near";
const PUBLISH_KEY =
  process.env.QUAY_PUBLISH_KEY_FILE ||
  join(homedir(), ".near-credentials", NETWORK, `${ACCOUNT}.publish.json`);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function die(message) {
  console.error(message);
  process.exit(1);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function contentType(path) {
  return TYPES[extname(path).toLowerCase()] || "application/octet-stream";
}

function collect(target) {
  const stat = statSync(target);
  if (stat.isFile()) {
    const bytes = readFileSync(target);
    return [{ path: "index.html", bytes, contentType: contentType(target) }];
  }
  if (!stat.isDirectory()) die(`not a file or directory: ${target}`);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const child = statSync(full);
      if (child.isDirectory()) {
        if (name === "node_modules" || name === "target") continue;
        walk(full);
        continue;
      }
      const rel = full.slice(target.length).replaceAll("\\", "/").replace(/^\//, "");
      files.push({ path: rel, bytes: readFileSync(full), contentType: contentType(full) });
    }
  };
  walk(target);
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (!files.some((file) => file.path === "index.html")) {
    die("a directory release needs index.html");
  }
  return files;
}

function chunksOf(bytes) {
  if (bytes.length === 0) die("empty file");
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const part = bytes.subarray(offset, offset + CHUNK_BYTES);
    chunks.push({ sha256: sha256(part), data: Buffer.from(part).toString("base64") });
  }
  return chunks;
}

function nearEnv() {
  const home = homedir();
  return {
    ...process.env,
    PATH: `${join(home, ".cargo", "bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}`,
  };
}

function runNear(args) {
  const result = spawnSync(NEAR, args, {
    env: nearEnv(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
  });
  if (result.error) die(`could not run ${NEAR}: ${result.error.message}`);
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) {
    die(output.trim() || `${NEAR} exited ${result.status}`);
  }
  return output;
}

function signTail(keyFile) {
  if (keyFile) {
    if (!existsSync(keyFile)) die(`publish key file is missing: ${keyFile}`);
    return ["sign-with-access-key-file", keyFile, "send"];
  }
  return ["sign-with-legacy-keychain", "send"];
}

function call(method, args, { gas, deposit, keyFile }) {
  const payload = JSON.stringify(args);
  return runNear([
    "contract",
    "call-function",
    "as-transaction",
    ACCOUNT,
    method,
    "json-args",
    payload,
    "prepaid-gas",
    gas,
    "attached-deposit",
    deposit,
    "sign-as",
    ACCOUNT,
    "network-config",
    NETWORK,
    ...signTail(keyFile),
  ]);
}

async function rpc(method, args) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "quay",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: ACCOUNT,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  if (body.result.error) throw new Error(String(body.result.error));
  const text = Buffer.from(body.result.result).toString("utf8");
  return JSON.parse(text);
}

async function nextId() {
  for (let id = 1; id <= 64; id += 1) {
    let release;
    try {
      release = await rpc("get_release", { id: String(id) });
    } catch (err) {
      die(err.message);
    }
    if (release === null) return String(id);
  }
  die("no free release id from 1 to 64; pass --id");
}

function options() {
  const positional = [];
  let id;
  let fullAccess = false;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === "--id") {
      id = process.argv[i + 1];
      if (!id || id.startsWith("--")) die("--id needs a value");
      i += 1;
      continue;
    }
    if (arg === "--full-access") {
      fullAccess = true;
      continue;
    }
    if (arg.startsWith("--")) die(`unknown option ${arg}`);
    positional.push(arg);
  }
  return { positional, id, fullAccess };
}

async function publish(target, { id, fullAccess }) {
  const releaseId = id || (await nextId());
  const keyFile = fullAccess ? null : PUBLISH_KEY;
  if (!fullAccess && !existsSync(PUBLISH_KEY)) {
    die(
      `publish key not found at ${PUBLISH_KEY}\n` +
        "The owner key can publish with --full-access. A publish-only key is rejected on promote.",
    );
  }
  const files = collect(resolve(target));
  const sealed = [];
  const seen = new Set();
  for (const file of files) {
    const parts = chunksOf(file.bytes);
    for (const part of parts) {
      if (seen.has(part.sha256)) continue;
      seen.add(part.sha256);
      const exists = await rpc("has_chunk", { sha256: part.sha256 }).catch(() => false);
      if (exists === true) {
        console.log(`reuse ${part.sha256.slice(0, 12)} ${file.path}`);
        continue;
      }
      console.log(`put   ${part.sha256.slice(0, 12)} ${file.path} (${Buffer.from(part.data, "base64").length} bytes)`);
      call("put_chunk", { sha256: part.sha256, data: part.data }, {
        gas: "300 Tgas",
        deposit: "0 NEAR",
        keyFile,
      });
    }
    sealed.push({
      path: file.path,
      chunks: parts.map((part) => part.sha256),
      content_type: file.contentType,
    });
  }
  const index = files.find((file) => file.path === "index.html");
  const releaseSha = sha256(index.bytes);
  console.log(`seal  ${releaseId} ${releaseSha}`);
  call("seal", { id: releaseId, files: sealed }, { gas: "100 Tgas", deposit: "0 NEAR", keyFile });
  console.log(`sealed ${releaseId}`);
  console.log(`sha256 ${releaseSha}`);
  console.log(`url    ${config.gateway}/r/${releaseId}`);
}

function promote(id) {
  if (!id) die("usage: quay promote <id>");
  console.log(`promote ${id}`);
  const output = call("promote", { id }, {
    gas: "30 Tgas",
    deposit: "1 yoctoNEAR",
    keyFile: null,
  });
  const hash = output.match(/Transaction ID:\s*(\S+)/);
  if (hash) console.log(`tx     ${hash[1]}`);
  console.log(`url    ${config.gateway}/`);
}

function usage() {
  console.log(`quay publish <file-or-dir> [--id <id>] [--full-access]
quay promote <id>

account ${ACCOUNT} on ${NETWORK}
publish key ${PUBLISH_KEY}`);
}

const { positional, id, fullAccess } = options();
const [command, target] = positional;

if (command === "publish") {
  if (!target) die("usage: quay publish <file-or-dir> [--id <id>]");
  await publish(target, { id, fullAccess });
} else if (command === "promote") {
  await promote(target);
} else {
  usage();
  process.exit(command ? 1 : 0);
}
