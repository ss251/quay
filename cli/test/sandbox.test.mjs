// Opt-in integration test against a local near-sandbox node:
//   QUAY_SANDBOX=1 node --test test/sandbox.test.mjs
// Needs the `near-sandbox` npm package (npm i --no-save near-sandbox) or
// QUAY_SANDBOX_MODULE=<path to its dist/esm/index.mjs>. Set
// NEAR_SANDBOX_BIN_PATH to reuse a neard binary instead of downloading one.
// Deploys cli/vendor/quay.wasm, or QUAY_WASM=<path>. It skips unless that wasm
// reports contract version 3.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { Account, actions, JsonRpcProvider, KeyPair } from "near-api-js";

import { main } from "../src/main.mjs";
import { streams, tempDir, writeTree } from "./helpers.mjs";

const enabled = process.env.QUAY_SANDBOX === "1";
const SITE = "quay-it.testnet";

test(
  "sandbox: db, routes and quay up through the CLI against the v3 wasm",
  { skip: !enabled && "set QUAY_SANDBOX=1", timeout: 300_000 },
  async (t) => {
    const wasmPath =
      process.env.QUAY_WASM ??
      new URL("../vendor/quay.wasm", import.meta.url).pathname;
    const wasm = readFileSync(wasmPath);
    const moduleUrl = process.env.QUAY_SANDBOX_MODULE
      ? pathToFileURL(process.env.QUAY_SANDBOX_MODULE).href
      : "near-sandbox";
    const { Sandbox, GenesisAccount } = await import(moduleUrl);
    // The CLI only talks to *.testnet accounts. The sandbox only lets its
    // registrar create `testnet`, so the site account starts in genesis.
    const siteKey = KeyPair.fromRandom("ed25519");
    const sandbox = await Sandbox.start({
      config: {
        rpcPort: 3071,
        additionalAccounts: [
          new GenesisAccount(
            SITE,
            siteKey.getPublicKey().toString(),
            siteKey.toString(),
            10n ** 27n,
          ),
        ],
      },
    });
    t.after(() => sandbox.tearDown());
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const site = new Account(SITE, provider, siteKey.toString());
    await site.signAndSendTransaction({
      receiverId: SITE,
      actions: [
        actions.deployContract(wasm),
        actions.functionCall("new", {}, 30n * 10n ** 12n, 0n),
      ],
    });
    const version = await provider.callFunction({
      contractId: SITE,
      method: "get_version",
      args: {},
    });
    if (!String(version?.version).startsWith("3.")) {
      t.skip(`wasm reports ${version?.version}, this test needs v3`);
      return;
    }

    const project = tempDir("quay-sbx-");
    const credentialsDir = join(project, "creds");
    mkdirSync(credentialsDir, { recursive: true });
    writeFileSync(
      join(credentialsDir, `${SITE}.json`),
      JSON.stringify({
        account_id: SITE,
        public_key: siteKey.getPublicKey().toString(),
        private_key: siteKey.toString(),
      }),
    );
    writeTree(project, {
      "site/index.html": "<h1>board</h1>",
      "site/templates/post.html": "<article>{{doc.data.title}}</article>",
    });
    writeFileSync(
      join(project, "quay.json"),
      JSON.stringify({
        account: SITE,
        network: "testnet",
        rpc: sandbox.rpcUrl,
        site: { dir: "site" },
        collections: {
          notes: { write: "anyone", payer: "writer", max_doc_bytes: 1000 },
        },
        routes: [
          {
            pattern: "/posts/:id",
            kind: "doc",
            collection: "posts",
            template: "templates/post.html",
          },
          { pattern: "/api/:collection", kind: "json", collection: "*" },
        ],
      }),
    );
    const cli = async (...argv) => {
      const io = streams();
      const code = await main([...argv, "--rpc", sandbox.rpcUrl], {
        ...io,
        cwd: project,
        credentialsDir,
        probe: async () => 200,
        isTTY: false,
      });
      assert.equal(code, 0, `${argv.join(" ")} failed: ${io.err()}`);
      return { out: io.text(), err: io.err() };
    };

    await cli(
      "db",
      "collection",
      "set",
      "posts",
      "--write",
      "anyone",
      "--payer",
      "writer",
      "--max-bytes",
      "500",
      "--moderated",
    );
    const listed = JSON.parse((await cli("db", "collections", "--json")).out);
    assert.deepEqual(
      listed.collections.map((view) => view.name),
      ["posts"],
    );
    assert.equal(listed.collections[0].moderated, true);

    await cli(
      "db",
      "add",
      "posts",
      '{"title":"hello harbour"}',
      "--id",
      "first",
    );
    const docs = JSON.parse((await cli("db", "list", "posts", "--json")).out);
    assert.equal(docs.docs.length, 1);
    assert.equal(docs.docs[0].data.title, "hello harbour");
    assert.equal(docs.docs[0].owner, SITE);
    const one = JSON.parse((await cli("db", "get", "posts", "first")).out);
    assert.equal(one.id, "first");
    await cli(
      "db",
      "update",
      "posts",
      "first",
      '{"title":"hello again, harbour"}',
    );
    assert.equal(
      JSON.parse((await cli("db", "get", "posts", "first")).out).data.title,
      "hello again, harbour",
    );
    await cli("db", "hide", "posts", "first");
    const hidden = JSON.parse((await cli("db", "list", "posts", "--json")).out);
    assert.equal(hidden.docs.length, 0);
    await cli("db", "unhide", "posts", "first");

    await cli("members", "close");
    assert.match((await cli("members", "list")).out, /joining is closed/);
    await cli(
      "products",
      "set",
      "pin",
      "--name",
      "Pin",
      "--price",
      "0.1",
      "--grant",
      "pin",
      "--pin-seconds",
      "60",
    );
    assert.match((await cli("products", "list")).out, /pin\s+Pin/);
    await cli("db", "fund", "0.5");
    assert.match((await cli("db", "pool")).out, /pool\s+0\.5000/);

    const dry = JSON.parse((await cli("up", "--dry-run", "--json")).out);
    assert.equal(dry.dry_run, true);
    assert.ok(
      dry.steps.some(
        (step) =>
          step.step === "collection" &&
          step.name === "notes" &&
          step.action === "create",
      ),
    );

    const upRun = JSON.parse(
      (await cli("up", "--yes", "--json", "-m", "first release")).out,
    );
    assert.equal(upRun.release, "1");
    assert.deepEqual(
      upRun.steps.map((step) => step.step),
      ["collection", "deploy", "promote"],
    );

    const release = await provider.callFunction({
      contractId: SITE,
      method: "get_release",
      args: { id: "1" },
    });
    assert.equal(release.routes.length, 2);
    assert.equal(release.routes[0].template, "templates/post.html");

    const page = await provider.callFunction({
      contractId: SITE,
      method: "web4_get",
      args: { request: { path: "/posts/first", query: {} } },
    });
    const body = Buffer.from(page.body ?? "", "base64").toString("utf8");
    assert.match(body, /hello again, harbour/);

    // A large file: nearfs sends each block as an fs_store call to the site
    // account. The call fails by design, so the deploy must still go on. There
    // is no NEARFS indexer here, so the read-back check is skipped.
    const big = writeTree(tempDir("quay-sbx-big-"), {
      "index.html": "<p>big</p>",
      "templates/post.html": "<article>{{doc.data.title}}</article>",
    });
    writeFileSync(join(big, "movie.bin"), Buffer.alloc(300_000, 7));
    const large = JSON.parse(
      (
        await cli(
          "deploy",
          big,
          "--external-over",
          "65536",
          "--no-verify",
          "--json",
        )
      ).out,
    );
    assert.equal(large.external.length, 1);
    assert.equal(large.external_transactions.length, 2);
    const withExternal = await provider.callFunction({
      contractId: SITE,
      method: "get_release",
      args: { id: large.id },
    });
    const moved = withExternal.files.find((file) => file.path === "movie.bin");
    assert.equal(moved.external.cid, large.external[0].cid);
    assert.equal(moved.external.size, "300000");
    assert.match(moved.external.cid, /^bafybei/);

    await cli("db", "rm", "posts", "first");
    await cli("db", "collection", "drop", "posts");
    const again = JSON.parse((await cli("up", "--dry-run", "--json")).out);
    assert.equal(
      again.steps.find((step) => step.name === "notes").action,
      "unchanged",
    );
  },
);
