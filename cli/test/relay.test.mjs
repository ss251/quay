import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { run } from "../src/app.mjs";
import { parseArgs } from "../src/text.mjs";
import { streams, tempDir } from "./helpers.mjs";

const SITE = "demo.testnet";
const config = {
  account: SITE,
  network: "testnet",
  rpc: "http://127.0.0.1:9",
  gateway: "https://demo.testnet.page",
};

const chain = (over = {}) => ({
  height: async () => 1000n,
  balance: async () => (5n * 10n ** 23n).toString(),
  join: async (name) => ({ hash: `J-${name}` }),
  relay: async () => ({ hash: "R1" }),
  ...over,
});

test("quay relay serve runs the relayer on the requested port until stopped", async () => {
  const io = streams();
  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const done = run(
    {
      ...io,
      config,
      relayChain: chain(),
      relayStop: stopped,
      onRelayReady: ready,
    },
    parseArgs(["relay", "serve", "--port", "0", "--per-account", "7"]),
  );
  const { url } = await started;
  const health = await (await fetch(`${url}/health`)).json();
  assert.equal(health.site, SITE);
  assert.equal(health.relayer, `relay.${SITE}`);
  assert.equal(health.policy.per_account_per_hour, 7);
  const join = await fetch(`${url}/join`, {
    method: "POST",
    body: JSON.stringify({
      name: "alice",
      public_key: "ed25519:6E8bvvuWTQ6NfJ7hyyTcUMKjJ4NQJyqEBLhhNp1ymLEb",
    }),
  });
  assert.deepEqual(await join.json(), {
    account: `alice.${SITE}`,
    hash: "J-alice",
  });
  stop();
  assert.equal(await done, 0);
  assert.match(
    io.text(),
    /relaying for demo\.testnet at http:\/\/127\.0\.0\.1:\d+/,
  );
  assert.match(io.text(), /one off-chain piece/);
  assert.match(io.text(), /relay\.demo\.testnet, 0\.5000 NEAR/);
  assert.match(io.err(), /join J-alice alice\.demo\.testnet/);
});

test("quay relay serve says how to get a key when none exists", async () => {
  const io = streams();
  delete process.env.QUAY_RELAYER_KEY;
  await assert.rejects(
    run(
      { ...io, config, credentialsDir: tempDir() },
      parseArgs(["relay", "serve", "--port", "0"]),
    ),
    /no key for relay\.demo\.testnet.*quay relay create/,
  );
});

test("quay relay serve rejects a bad port and an account-less run", async () => {
  const io = streams();
  await assert.rejects(
    run(
      { ...io, config, relayChain: chain() },
      parseArgs(["relay", "serve", "--port", "nope"]),
    ),
    /--port/,
  );
  await assert.rejects(
    run(
      { ...io, config: { ...config, account: undefined } },
      parseArgs(["relay", "serve"]),
    ),
    /no account/,
  );
});

test("quay relay status reports balance, key and a stopped server", async () => {
  const io = streams();
  const dir = tempDir();
  await run(
    {
      ...io,
      config,
      credentialsDir: dir,
      relayBalance: async () => 5n * 10n ** 23n,
      fetch: async () => {
        throw new Error("down");
      },
    },
    parseArgs(["relay", "status", "--port", "9"]),
  );
  assert.match(io.text(), /relayer {2}relay\.demo\.testnet\n/);
  assert.match(io.text(), /balance {2}0\.5000 NEAR/);
  assert.match(io.text(), /key {6}missing/);
  assert.match(io.text(), /not running on 127\.0\.0\.1:9/);
});

test("quay relay status --json carries the health of a running server", async () => {
  const io = streams();
  await run(
    {
      ...io,
      json: true,
      config,
      credentialsDir: tempDir(),
      relayBalance: async () => null,
      fetch: async () => ({ json: async () => ({ ok: true, balance: "1" }) }),
    },
    parseArgs(["relay", "status", "--json"]),
  );
  const out = JSON.parse(io.text());
  assert.equal(out.account_exists, false);
  assert.equal(out.server.ok, true);
});

function owned(extra = {}) {
  const dir = tempDir();
  const created = [];
  return {
    dir,
    created,
    ctx: {
      ...streams(),
      config,
      credentialsDir: dir,
      yes: true,
      signer: { secret: "ed25519:x", limited: false },
      relayBalance: async () => null,
      relayCreate: async (args) => {
        created.push(args);
        return { hash: "TXC" };
      },
      ...extra,
    },
  };
}

test("quay relay create makes relay.<site> with 0.5 NEAR and stores the key at mode 600", async () => {
  const { ctx, created, dir } = owned();
  await run(ctx, parseArgs(["relay", "create"]));
  assert.equal(created.length, 1);
  assert.equal(created[0].relayer, `relay.${SITE}`);
  assert.equal(created[0].amount, 5n * 10n ** 23n);
  const path = join(dir, `relay.${SITE}.json`);
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(file.account_id, `relay.${SITE}`);
  assert.equal(file.public_key, created[0].publicKey);
  assert.match(file.private_key, /^ed25519:/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(ctx.text(), /created relay\.demo\.testnet with 0\.5000 NEAR/);
  assert.ok(!ctx.text().includes(file.private_key));
  assert.match(ctx.text(), /next {2}quay relay serve/);
});

test("quay relay create honors --near and --dry-run", async () => {
  const a = owned();
  await run(a.ctx, parseArgs(["relay", "create", "--near", "2"]));
  assert.equal(a.created[0].amount, 2n * 10n ** 24n);
  const b = owned({ dryRun: true });
  await run(b.ctx, parseArgs(["relay", "create", "--dry-run"]));
  assert.equal(b.created.length, 0);
  assert.equal(existsSync(join(b.dir, `relay.${SITE}.json`)), false);
  assert.match(b.ctx.text(), /dry run: create relay\.demo\.testnet/);
  await assert.rejects(
    run(owned().ctx, parseArgs(["relay", "create", "--near", "lots"])),
    /NEAR amount/,
  );
});

test("quay relay create refuses an existing account or key and a publish-only signer", async () => {
  const a = owned({ relayBalance: async () => 1n });
  await assert.rejects(
    run(a.ctx, parseArgs(["relay", "create"])),
    /already exists/,
  );
  const b = owned();
  await run(b.ctx, parseArgs(["relay", "create"]));
  await assert.rejects(
    run(b.ctx, parseArgs(["relay", "create"])),
    /already exists/,
  );
  const c = owned({ signer: { secret: "ed25519:x", limited: true } });
  await assert.rejects(
    run(c.ctx, parseArgs(["relay", "create"])),
    /publish-only/,
  );
  const d = owned();
  await assert.rejects(
    run(
      d.ctx,
      parseArgs(["relay", "create", "--relayer", "relay.other.testnet"]),
    ),
    /sub-account of demo\.testnet/,
  );
});

test("a failed creation leaves no key file behind", async () => {
  const { ctx, dir } = owned({
    relayCreate: async () => {
      throw new Error("not enough balance");
    },
  });
  await assert.rejects(
    run(ctx, parseArgs(["relay", "create"])),
    /not enough balance/,
  );
  assert.equal(existsSync(join(dir, `relay.${SITE}.json`)), false);
});

test("quay relay with no subcommand prints help and fails", async () => {
  const io = streams();
  await assert.rejects(
    run({ ...io, config }, parseArgs(["relay"])),
    /serve, status, or create/,
  );
  assert.match(io.text(), /quay relay serve/);
  await assert.rejects(
    run({ ...io, config }, parseArgs(["relay", "zap"])),
    /unknown relay command/,
  );
});
