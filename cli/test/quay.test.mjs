import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deploy, promote, releases, run } from "../src/app.mjs";
import { gatewayFor } from "../src/config.mjs";
import { classifyChainError, formatNear, formatTime, helpText, parseArgs, redact } from "../src/text.mjs";
import { COMMANDS } from "../src/text.mjs";
import { checkPath, collectSite, contentType, planRelease, YOCTO_PER_BYTE } from "../src/site.mjs";

function streams() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (chunk) => out.push(String(chunk)) },
    stderr: { write: (chunk) => err.push(String(chunk)) },
    text: () => out.join(""),
    err: () => err.join(""),
  };
}

test("help lists every command and json output", () => {
  const root = helpText();
  for (const command of COMMANDS) {
    assert.match(root, new RegExp(command.name));
    const page = helpText(command.name);
    assert.match(page, /--json/);
    assert.match(page, new RegExp(command.usage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("parseArgs reads the message and rejects an unknown flag", () => {
  const parsed = parseArgs(["deploy", "site", "-m", "harbour", "--spa", "--json"]);
  assert.equal(parsed.command, "deploy");
  assert.deepEqual(parsed.rest, ["site"]);
  assert.equal(parsed.flags.message, "harbour");
  assert.equal(parsed.flags.spa, true);
  assert.throws(() => parseArgs(["deploy", "--nope"]), /unknown flag/);
});

test("the gateway host is the account name plus testnet.page", () => {
  assert.equal(gatewayFor("quay-bb.testnet"), "https://quay-bb.testnet.page");
  assert.equal(gatewayFor("quay-esc0v902.testnet"), "https://quay-esc0v902.testnet.page");
});

test("storage price is 0.01 NEAR per 1000 bytes", () => {
  assert.equal(formatNear(1000n * YOCTO_PER_BYTE), "0.0100");
  assert.equal(formatNear(100_000n * YOCTO_PER_BYTE), "1.0000");
  assert.equal(formatTime("0"), "unknown");
});

test("collect keeps nested files, types, and skips dotfiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "quay-site-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<p>quay</p>");
  writeFileSync(join(dir, "assets", "mark.svg"), "<svg></svg>");
  writeFileSync(join(dir, ".secret"), "no");
  const files = collectSite(dir);
  assert.deepEqual(files.map((file) => file.path), ["assets/mark.svg", "index.html"]);
  assert.equal(contentType("assets/mark.svg"), "image/svg+xml");
  assert.equal(files.find((file) => file.path.endsWith(".svg")).contentType, "image/svg+xml");
  assert.throws(() => checkPath("../etc/passwd"), /dotted/);
});

test("unchanged bytes are reused once inside a release", () => {
  const bytes = Buffer.from("<p>same</p>");
  const files = [
    { path: "index.html", bytes, contentType: "text/html; charset=utf-8" },
    { path: "docs/index.html", bytes, contentType: "text/html; charset=utf-8" },
  ];
  const plan = planRelease(files, new Set());
  assert.equal(plan.uploads.length, 1);
  assert.equal(plan.reusedBytes, BigInt(bytes.length));
  assert.equal(plan.newBytes, BigInt(bytes.length));
});

test("deploy skips chunks the contract already has", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quay-deploy-"));
  writeFileSync(join(dir, "index.html"), "<p>one</p>");
  writeFileSync(join(dir, "app.css"), "body{}");
  const uploaded = [];
  const io = streams();
  const files = collectSite(dir);
  const first = planRelease(files, new Set());
  const known = first.uploads[0].sha256;
  await deploy(
    {
      ...io,
      json: false,
      yes: true,
      dryRun: false,
      spa: false,
      color: false,
      isTTY: false,
      config: { account: "quay-demo.testnet", gateway: "https://quay-demo.testnet.page", rpc: "https://test.rpc.fastnear.com" },
      signer: { secret: "local", limited: false, publicKey: "ed25519:abc" },
      chain: {
        async view(method) {
          if (method === "list_releases") return { releases: [], next: null };
          if (method === "get_status") {
            return { stored_bytes: "10", max_bytes: "2000000", production: null, release_count: 0, version: "2.0.0" };
          }
          return null;
        },
        async hasChunk(hash) {
          return hash === known;
        },
        async putChunk(hash, bytes) {
          uploaded.push([hash, bytes.length]);
          return { hash: "chunk-tx" };
        },
        async seal(id, sealFiles, message, spa) {
          assert.equal(id, "1");
          assert.equal(message, "note");
          assert.equal(spa, false);
          assert.equal(sealFiles.length, 2);
          return { hash: "seal-tx" };
        },
      },
    },
    { rest: [dir], flags: { message: "note" } },
  );
  assert.equal(uploaded.length, 1);
  assert.match(io.err(), /reused/);
  assert.match(io.text(), /https:\/\/quay-demo\.testnet\.page\/r\/1\//);
});

test("a failed seal drops the chunks just uploaded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quay-drop-"));
  writeFileSync(join(dir, "index.html"), "<p>one</p>");
  const dropped = [];
  const io = streams();
  await assert.rejects(
    () =>
      deploy(
        {
          ...io,
          json: false,
          yes: true,
          dryRun: false,
          spa: false,
          color: false,
          isTTY: false,
          config: { account: "quay-demo.testnet", gateway: "https://quay-demo.testnet.page", rpc: "https://test.rpc.fastnear.com" },
          signer: { secret: "local", limited: false, publicKey: "ed25519:abc" },
          chain: {
            async view(method) {
              if (method === "list_releases") return { releases: [], next: null };
              if (method === "get_status") return { stored_bytes: "0", max_bytes: "2000000" };
              return null;
            },
            async hasChunk() {
              return false;
            },
            async putChunk(hash) {
              return { hash };
            },
            async seal() {
              throw new Error("seal failed");
            },
            async dropChunk(hash) {
              dropped.push(hash);
              return { hash: "drop-tx" };
            },
          },
        },
        { rest: [dir], flags: { message: "note" } },
      ),
    /seal failed/,
  );
  assert.equal(dropped.length, 1);
});

test("a publish-only key cannot promote", async () => {
  let called = false;
  await assert.rejects(
    () =>
      promote(
        {
          signer: { limited: true, secret: "ci" },
          chain: {
            async promote() {
              called = true;
            },
          },
        },
        { rest: ["1"], flags: {} },
      ),
    (error) => error.code === 3,
  );
  assert.equal(called, false);
});

test("a method mismatch is a refusal", () => {
  const error = classifyChainError(new Error("AccessKey MethodNameMismatch promote"));
  assert.equal(error.code, 3);
});

test("secrets do not survive an error string", () => {
  const secret = "ed25519:THISISNOTAREALKEYVALUE";
  assert.equal(redact(`failed with ${secret}`, [secret]), "failed with [redacted]");
});

test("releases marks production", async () => {
  const io = streams();
  await releases({
    ...io,
    json: false,
    color: false,
    config: { account: "quay-demo.testnet" },
    chain: {
      async view(method) {
        if (method === "list_releases") {
          return {
            releases: [
              { id: "1", timestamp: "0", file_count: 2, bytes: "1200", message: "first" },
              { id: "2", timestamp: "1700000000000000000", file_count: 3, bytes: "2400", message: "second" },
            ],
            next: null,
          };
        }
        return { production: "2", previous: "1" };
      },
    },
  });
  assert.match(io.text(), /2\s+.*production/);
  assert.match(io.text(), /unknown/);
});

test("missing publish_methods falls back to put_chunk and seal", async () => {
  const io = streams();
  const methods = [];
  await run(
    {
      ...io,
      json: true,
      yes: true,
      dryRun: false,
      spa: false,
      ci: true,
      color: false,
      isTTY: false,
      cwd: tmpdir(),
      credentialsDir: mkdtempSync(join(tmpdir(), "quay-keys-")),
      config: { account: "quay-demo.testnet", rpc: "https://test.rpc.fastnear.com", gateway: "https://quay-demo.testnet.page" },
      signer: { secret: "owner", limited: false, publicKey: "ed25519:owner" },
      secrets: [],
      generateKey: () => ({ secret: "ed25519:NEWSECRETVALUE12", publicKey: "ed25519:new" }),
      chain: {
        async view() {
          throw new Error("method missing");
        },
        async addPublishKey(_publicKey, names) {
          methods.push(names);
          return { hash: "key-tx" };
        },
      },
    },
    { command: "keys", rest: ["create"], flags: { ci: true } },
  );
  assert.deepEqual(methods, [["put_chunk", "seal"]]);
  assert.match(io.text(), /ed25519:NEWSECRETVALUE12/);
  assert.doesNotMatch(io.err(), /NEWSECRETVALUE12/);
});
