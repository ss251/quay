import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { deploy, rollback, run } from "../src/app.mjs";
import { rulesFromFlags } from "../src/db.mjs";
import { parseProject } from "../src/projectfile.mjs";
import { validateRoutes } from "../src/routes.mjs";
import { parseArgs, COMMANDS, helpText } from "../src/text.mjs";
import { addDocCost, growthCost, parseNear } from "../src/units.mjs";
import { baseCtx, fakeChain, streams, tempDir, writeTree } from "./helpers.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function exec(argv, { chain = fakeChain(), ctx = {} } = {}) {
  const io = streams();
  const full = baseCtx(io, { chain, ...ctx });
  const parsed = parseArgs(argv);
  full.json = Boolean(parsed.flags.json);
  full.dryRun = Boolean(parsed.flags["dry-run"]);
  await run(full, parsed);
  return { chain, io };
}

test("parseNear reads decimals and rejects junk", () => {
  assert.equal(parseNear("1"), 10n ** 24n);
  assert.equal(parseNear("0.01"), 10n ** 22n);
  assert.throws(() => parseNear("-1"), /NEAR amount/);
  assert.throws(() => parseNear("1e3"), /NEAR amount/);
  assert.equal(growthCost(100, 50), 0n);
  assert.ok(addDocCost(2, 100) > 0n);
});

test("every new command has help with --json and its usage", () => {
  for (const name of ["db", "members", "products", "receipts", "up"]) {
    assert.ok(COMMANDS.some((command) => command.name === name));
    assert.match(helpText(name), /--json/);
  }
  assert.match(helpText("deploy"), /--store/);
  assert.match(helpText("deploy"), /not tested against the live services/);
});

test("db collection set creates, then keeps unspecified rules", async () => {
  const chain = fakeChain();
  await exec(
    [
      "db",
      "collection",
      "set",
      "posts",
      "--write",
      "members",
      "--payer",
      "site",
      "--max-bytes",
      "2000",
      "--moderated",
      "--max-per-account",
      "50",
    ],
    { chain },
  );
  assert.deepEqual(chain.calls[0], {
    method: "set_collection",
    args: {
      name: "posts",
      rules: {
        write: "members",
        max_doc_bytes: 2000,
        moderated: true,
        payer: "site",
        max_docs_per_account: 50,
        on_add: null,
      },
    },
    deposit: 1n,
  });
  await exec(["db", "collection", "set", "posts", "--write", "anyone"], {
    chain,
  });
  const second = chain.calls[1].args.rules;
  assert.equal(second.write, "anyone");
  assert.equal(second.payer, "site");
  assert.equal(second.max_doc_bytes, 2000);
  assert.equal(second.max_docs_per_account, 50);
});

test("collection rules reject bad values", () => {
  assert.throws(() => rulesFromFlags({ write: "everyone" }), /--write must be/);
  assert.throws(() => rulesFromFlags({ "max-bytes": "99999" }), /--max-bytes/);
  assert.equal(
    rulesFromFlags({ moderated: "false" }, { moderated: true }).moderated,
    false,
  );
  assert.equal(
    rulesFromFlags({ "max-per-account": "none" }, { max_docs_per_account: 4 })
      .max_docs_per_account,
    null,
  );
});

test("a publish-only key cannot set a collection", async () => {
  await assert.rejects(
    exec(["db", "collection", "set", "posts"], {
      ctx: { signer: { secret: "x", limited: true } },
    }),
    /publish-only/,
  );
});

test("db add attaches an estimated deposit for a writer-paid collection and none for a site-paid one", async () => {
  const chain = fakeChain({
    collections: {
      mine: {
        write: "anyone",
        payer: "writer",
        max_doc_bytes: 500,
        moderated: false,
        max_docs_per_account: null,
        on_add: null,
      },
      free: {
        write: "anyone",
        payer: "site",
        max_doc_bytes: 500,
        moderated: false,
        max_docs_per_account: null,
        on_add: null,
      },
    },
  });
  const paid = await exec(
    ["db", "add", "mine", '{"title":"hi"}', "--id", "first"],
    { chain },
  );
  const call = chain.calls[0];
  assert.equal(call.method, "db_add");
  assert.equal(call.args.data, '{"title":"hi"}');
  assert.equal(call.args.id, "first");
  assert.equal(call.deposit, addDocCost(5, 14));
  assert.match(paid.io.out ?? paid.io.text(), /added mine\/first/);
  await exec(["db", "add", "free", '{"a":1}'], { chain });
  assert.equal(chain.calls[1].deposit, 0n);
  assert.equal(chain.calls[1].args.id, null);
  await assert.rejects(
    exec(["db", "add", "free", '{"a":1}', "--deposit", "0.1"], { chain }),
    /takes no deposit/,
  );
  await exec(["db", "add", "mine", '{"a":1}', "--deposit", "0.05"], { chain });
  assert.equal(chain.calls[2].deposit, 5n * 10n ** 22n);
});

test("db add checks the doc locally", async () => {
  const chain = fakeChain({
    collections: {
      c: {
        write: "anyone",
        payer: "writer",
        max_doc_bytes: 10,
        moderated: false,
        max_docs_per_account: null,
        on_add: null,
      },
    },
  });
  await assert.rejects(
    exec(["db", "add", "c", "[1]"], { chain }),
    /JSON object/,
  );
  await assert.rejects(
    exec(["db", "add", "c", "not json"], { chain }),
    /not valid JSON/,
  );
  await assert.rejects(
    exec(["db", "add", "c", '{"long":"0123456789"}'], { chain }),
    /allows 10/,
  );
  await assert.rejects(
    exec(["db", "add", "c", "{}", "--id", "12"], { chain }),
    /all-digit/,
  );
  await assert.rejects(
    exec(["db", "add", "missing", "{}"], { chain }),
    /missing/,
  );
  assert.equal(chain.calls.length, 0);
});

test("db add reads @file.json", async () => {
  const dir = writeTree(tempDir(), { "doc.json": '{ "title": "from file" }' });
  const chain = fakeChain({
    collections: {
      c: {
        write: "anyone",
        payer: "site",
        max_doc_bytes: 100,
        moderated: false,
        max_docs_per_account: null,
        on_add: null,
      },
    },
  });
  await exec(["db", "add", "c", "@doc.json"], { chain, ctx: { cwd: dir } });
  assert.equal(chain.calls[0].args.data, '{"title":"from file"}');
});

test("db list, get, update, rm, hide, fund, pool", async () => {
  const chain = fakeChain({
    collections: {
      c: {
        write: "anyone",
        payer: "writer",
        max_doc_bytes: 500,
        moderated: true,
        max_docs_per_account: null,
        on_add: null,
      },
    },
  });
  await exec(["db", "add", "c", '{"title":"one"}', "--id", "alpha"], { chain });
  const listed = await exec(["db", "list", "c"], { chain });
  assert.match(listed.io.text(), /alpha\s+alice\.testnet/);
  assert.match(listed.io.text(), /"title":"one"/);
  const json = await exec(["db", "list", "c", "--json"], { chain });
  assert.equal(JSON.parse(json.io.text()).docs[0].id, "alpha");
  const got = await exec(["db", "get", "c", "alpha"], { chain });
  assert.equal(JSON.parse(got.io.text()).data.title, "one");
  await assert.rejects(
    exec(["db", "get", "c", "nope"], { chain }),
    /no doc nope/,
  );
  await exec(
    [
      "db",
      "update",
      "c",
      "alpha",
      '{"title":"a much longer title than before"}',
    ],
    { chain },
  );
  const update = chain.calls.find((call) => call.method === "db_update");
  assert.ok(update.deposit > 0n);
  await exec(["db", "update", "c", "alpha", '{"t":1}'], { chain });
  assert.equal(
    chain.calls.filter((call) => call.method === "db_update")[1].deposit,
    0n,
  );
  await exec(["db", "hide", "c", "alpha"], { chain });
  assert.deepEqual(chain.calls.at(-1), {
    method: "db_hide",
    args: { collection: "c", id: "alpha", hidden: true },
    deposit: 1n,
  });
  await exec(["db", "unhide", "c", "alpha"], { chain });
  assert.equal(chain.calls.at(-1).args.hidden, false);
  await exec(["db", "fund", "0.5"], { chain });
  assert.deepEqual(chain.calls.at(-1), {
    method: "db_fund",
    args: {},
    deposit: 5n * 10n ** 23n,
  });
  await assert.rejects(
    exec(["db", "fund", "0.001"], { chain }),
    /at least 0\.01/,
  );
  const pool = await exec(["db", "pool"], { chain });
  assert.match(pool.io.text(), /pool\s+0\.0000 NEAR/);
  await exec(["db", "rm", "c", "alpha"], { chain });
  assert.equal(chain.calls.at(-1).method, "db_remove");
});

test("db collection drop refuses a collection with docs and drops an empty one", async () => {
  const chain = fakeChain({
    collections: {
      c: {
        write: "anyone",
        payer: "site",
        max_doc_bytes: 100,
        moderated: false,
        max_docs_per_account: null,
        on_add: null,
      },
    },
  });
  await exec(["db", "add", "c", "{}"], { chain });
  await assert.rejects(
    exec(["db", "collection", "drop", "c"], { chain }),
    /still has 1 docs/,
  );
  await exec(["db", "rm", "c", "1"], { chain });
  await exec(["db", "collection", "drop", "c"], { chain });
  assert.deepEqual(chain.calls.at(-1), {
    method: "drop_collection",
    args: { name: "c" },
    deposit: 1n,
  });
});

test("--dry-run prints the call and sends nothing", async () => {
  const chain = fakeChain();
  const out = await exec(
    ["db", "collection", "set", "posts", "--dry-run", "--json"],
    { chain },
  );
  assert.equal(chain.calls.length, 0);
  const body = JSON.parse(out.io.text());
  assert.equal(body.dry_run, true);
  assert.equal(body.method, "set_collection");
});

test("db collections lists rules and counts", async () => {
  const chain = fakeChain({
    collections: {
      posts: {
        write: "members",
        payer: "site",
        max_doc_bytes: 2000,
        moderated: true,
        max_docs_per_account: 50,
        on_add: null,
      },
    },
  });
  const out = await exec(["db", "collections"], { chain });
  assert.match(out.io.text(), /posts\s+members\s+site\s+2000\s+yes\s+50/);
  const none = await exec(["db", "collections"], { chain: fakeChain() });
  assert.match(none.io.text(), /no collections/);
});

test("members list, open and close", async () => {
  const chain = fakeChain();
  chain.state.members = ["alice.board.testnet"];
  const out = await exec(["members", "list"], { chain });
  assert.match(out.io.text(), /joining is open/);
  assert.match(out.io.text(), /alice\.board\.testnet/);
  await exec(["members", "close"], { chain });
  assert.deepEqual(chain.calls.at(-1), {
    method: "set_members_open",
    args: { open: false },
    deposit: 1n,
  });
  await exec(["members", "open"], { chain });
  assert.equal(chain.calls.at(-1).args.open, true);
});

test("products set builds the contract shape and list prints it", async () => {
  const chain = fakeChain();
  await exec(
    [
      "products",
      "set",
      "pin",
      "--name",
      "Pin a post for 24 hours",
      "--price",
      "0.1",
      "--grant",
      "pin",
      "--pin-seconds",
      "86400",
    ],
    { chain },
  );
  assert.deepEqual(chain.calls[0], {
    method: "set_product",
    args: {
      id: "pin",
      product: {
        name: "Pin a post for 24 hours",
        price_yocto: "100000000000000000000000",
        price_token: null,
        grant: "pin",
        pin_seconds: 86400,
      },
    },
    deposit: 1n,
  });
  const out = await exec(["products", "list"], { chain });
  assert.match(
    out.io.text(),
    /pin\s+Pin a post for 24 hours\s+0\.1000\s+pin\s+86400/,
  );
  await assert.rejects(
    exec(
      ["products", "set", "x", "--name", "N", "--price", "1", "--grant", "pin"],
      { chain },
    ),
    /pin-seconds/,
  );
  await assert.rejects(
    exec(["products", "set", "x", "--name", "N", "--grant", "receipt"], {
      chain,
    }),
    /needs a NEAR price/,
  );
  await assert.rejects(
    exec(
      [
        "products",
        "set",
        "x",
        "--name",
        "N",
        "--price",
        "1",
        "--grant",
        "gift",
      ],
      { chain },
    ),
    /grant must be/,
  );
  await exec(
    [
      "products",
      "set",
      "ticket",
      "--name",
      "Ticket",
      "--price-token",
      "500",
      "--grant",
      "receipt",
    ],
    { chain },
  );
  assert.equal(chain.calls.at(-1).args.product.price_token, "500");
  assert.equal(chain.calls.at(-1).args.product.pin_seconds, null);
  await exec(["products", "rm", "pin"], { chain });
  assert.equal(chain.calls.at(-1).method, "remove_product");
  await exec(["products", "token", "usdt.testnet"], { chain });
  assert.deepEqual(chain.calls.at(-1).args, { account: "usdt.testnet" });
});

test("receipts passes the buyer filter", async () => {
  const seen = [];
  const chain = fakeChain();
  const view = chain.view;
  chain.view = async (method, args) => {
    if (method === "list_receipts") {
      seen.push(args);
      return {
        receipts: [
          {
            buyer: "alice.testnet",
            product: "pin",
            ref: "posts/12",
            amount: "100000000000000000000000",
            token: "near",
            at: "1731283200000000000",
          },
        ],
        next: null,
      };
    }
    return view(method, args);
  };
  const out = await exec(["receipts", "--owner", "alice.testnet"], { chain });
  assert.deepEqual(seen[0], { query: { owner: "alice.testnet" } });
  assert.match(
    out.io.text(),
    /alice\.testnet\s+pin\s+posts\/12\s+0\.1000 NEAR/,
  );
  await exec(["receipts", "--owner"], { chain });
  assert.equal(seen[1].query.owner, "board.testnet");
});

test("routes are validated against the folder", () => {
  const files = [
    { path: "index.html", bytes: Buffer.from("x") },
    {
      path: "templates/post.html",
      bytes: Buffer.from("{{> templates/head.html}}{{doc.data.title}}"),
    },
    { path: "templates/head.html", bytes: Buffer.from("<head>") },
  ];
  const routes = validateRoutes(
    [
      {
        pattern: "/posts/:id",
        kind: "doc",
        collection: "posts",
        template: "templates/post.html",
      },
      { pattern: "/api/:collection", kind: "json", collection: "*" },
      {
        pattern: "/",
        kind: "list",
        collection: "posts",
        template: "templates/head.html",
        limit: 10,
        order: "asc",
        pinned_first: true,
        prefix: "digest-",
      },
    ],
    files,
  );
  assert.equal(routes.length, 3);
  assert.deepEqual(routes[1], {
    pattern: "/api/:collection",
    kind: "json",
    collection: "*",
  });
  const bad = (route, message) =>
    assert.throws(() => validateRoutes([route], files), message);
  bad(
    {
      pattern: "/r/:id",
      kind: "doc",
      collection: "p",
      template: "templates/post.html",
    },
    /reserved for previews/,
  );
  bad(
    {
      pattern: "/p/:Id",
      kind: "doc",
      collection: "p",
      template: "templates/post.html",
    },
    /bad parameter name/,
  );
  bad(
    {
      pattern: "/p/:id",
      kind: "doc",
      collection: "p",
      template: "templates/post.html",
      prefix: "x",
    },
    /prefix is for list routes/,
  );

  bad(
    {
      pattern: "posts/:id",
      kind: "doc",
      collection: "p",
      template: "templates/post.html",
    },
    /start with \//,
  );
  bad(
    {
      pattern: "/a/*rest/b",
      kind: "list",
      collection: "p",
      template: "templates/post.html",
    },
    /must be last/,
  );
  bad(
    {
      pattern: "/p/:id",
      kind: "doc",
      collection: "p",
      template: "templates/nope.html",
    },
    /not in the site folder/,
  );
  bad({ pattern: "/p/:id", kind: "doc", collection: "p" }, /needs a template/);
  bad(
    {
      pattern: "/p",
      kind: "doc",
      collection: "p",
      template: "templates/post.html",
    },
    /:id/,
  );
  bad({ pattern: "/p/:id", kind: "weird", collection: "p" }, /kind must be/);
  bad(
    {
      pattern: "/p",
      kind: "list",
      collection: "p",
      template: "templates/post.html",
      limit: 99,
    },
    /limit/,
  );
  bad(
    {
      pattern: "/p/:id",
      kind: "doc",
      collection: "p",
      template: "templates/post.html",
      extra: 1,
    },
    /unknown key extra/,
  );
  bad(
    {
      pattern: "/p",
      kind: "list",
      collection: "*",
      template: "templates/post.html",
    },
    /collection must be/,
  );
  assert.throws(
    () =>
      validateRoutes(
        [
          {
            pattern: "/p/:id",
            kind: "doc",
            collection: "p",
            template: "a.html",
          },
        ],
        [{ path: "a.html", bytes: Buffer.from("{{> gone.html}}") }],
      ),
    /includes gone\.html/,
  );
  assert.throws(
    () =>
      validateRoutes(
        Array.from({ length: 17 }, () => ({
          pattern: "/x",
          kind: "json",
          collection: "*",
        })),
        files,
      ),
    /at most 16/,
  );
});

test("quay.json is strict and normalised", () => {
  const project = parseProject({
    account: "board.testnet",
    network: "testnet",
    site: { dir: "site" },
    files: { external_over: 65536, store: "nearfs" },
    collections: {
      posts: {
        write: "members",
        payer: "site",
        max_doc_bytes: 2000,
        moderated: true,
      },
    },
    products: {
      pin: { name: "Pin", price_yocto: "100", grant: "pin", pin_seconds: 60 },
    },
    members: { open: false },
    functions: {},
    relay: {},
    cron: [],
  });
  assert.equal(project.collections.posts.max_docs_per_account, null);
  assert.equal(project.products.pin.price_token, null);
  assert.deepEqual(project.members, { open: false });
  assert.deepEqual(project.pending, []);
  assert.throws(
    () => parseProject({ colections: {} }),
    /unknown key colections/,
  );
  assert.throws(
    () => parseProject({ collections: { Posts: {} } }),
    /collection name/,
  );
  assert.throws(
    () => parseProject({ collections: { posts: { writes: "x" } } }),
    /unknown key collections\.posts\.writes/,
  );
  assert.throws(
    () => parseProject({ files: { store: "ftp" } }),
    /files\.store/,
  );
  assert.throws(
    () => parseProject({ products: { p: { name: "P", grant: "pin" } } }),
    /products\.p/,
  );
  assert.deepEqual(parseProject({ functions: { a: {} } }).pending, [
    "functions",
  ]);
});

function siteDir() {
  return writeTree(tempDir("quay-site-"), {
    "site/index.html": "<h1>board</h1>",
    "site/templates/post.html": "<h1>{{doc.data.title}}</h1>",
  });
}

test("deploy seals routes from quay.json and checks that templates exist", async () => {
  const root = siteDir();
  const config = join(root, "quay.json");
  writeFileSync(
    config,
    JSON.stringify({
      account: "board.testnet",
      routes: [
        {
          pattern: "/posts/:id",
          kind: "doc",
          collection: "posts",
          template: "templates/post.html",
        },
      ],
    }),
  );
  const chain = fakeChain();
  const io = streams();
  await deploy(
    baseCtx(io, {
      chain,
      config: {
        account: "board.testnet",
        gateway: "https://board.testnet.page",
        path: config,
      },
    }),
    { rest: [join(root, "site")], flags: {} },
  );
  const seal = chain.calls.find((call) => call.method === "seal");
  assert.equal(seal.routes.length, 1);
  assert.equal(seal.routes[0].template, "templates/post.html");
  assert.match(io.err(), /no collection named posts/);
  writeFileSync(
    config,
    JSON.stringify({
      routes: [
        {
          pattern: "/p/:id",
          kind: "doc",
          collection: "posts",
          template: "templates/gone.html",
        },
      ],
    }),
  );
  await assert.rejects(
    deploy(
      baseCtx(streams(), {
        chain: fakeChain(),
        config: {
          account: "board.testnet",
          gateway: "https://board.testnet.page",
          path: config,
        },
      }),
      { rest: [join(root, "site")], flags: {} },
    ),
    /templates\/gone\.html is not in the site folder/,
  );
});

function largeSite() {
  const dir = tempDir("quay-large-");
  const big = Buffer.alloc(300_000, 9);
  writeTree(dir, { "index.html": "<img src=media/big.bin>" });
  writeFileSync(join(dir, "big.bin"), big);
  return { dir, big };
}

function nearfsCtx(io, chain, big, { serve = true, mismatch = false } = {}) {
  return baseCtx(io, {
    chain,
    fetch: async () =>
      serve && chain.calls.some((call) => call.method === "batch")
        ? {
            ok: true,
            arrayBuffer: async () => (mismatch ? Buffer.from("nope") : big),
          }
        : { ok: false, status: 404 },
    sleep: async () => {},
    verifyTimeoutMs: 0,
  });
}

test("a file over files.external_over is stored in nearfs and sealed as external", async () => {
  const { dir, big } = largeSite();
  const chain = fakeChain();
  const io = streams();
  await deploy(nearfsCtx(io, chain, big), {
    rest: [dir],
    flags: { "external-over": "65536" },
  });
  const batches = chain.calls.filter((call) => call.method === "batch");
  assert.equal(batches.length, 2);
  const seal = chain.calls.find((call) => call.method === "seal");
  const external = seal.files.find((file) => file.path === "big.bin");
  assert.deepEqual(external.chunks, []);
  assert.equal(external.external.size, "300000");
  assert.equal(external.external.sha256, sha(big));
  assert.match(external.external.cid, /^bafybei/);
  assert.equal(
    seal.files.find((file) => file.path === "index.html").chunks.length,
    1,
  );
  assert.match(io.text(), /stored off chain big\.bin bafybei/);
});

test("deploy does not seal when the store does not serve the file", async () => {
  const { dir, big } = largeSite();
  const chain = fakeChain();
  await assert.rejects(
    deploy(nearfsCtx(streams(), chain, big, { serve: false }), {
      rest: [dir],
      flags: { "external-over": "65536" },
    }),
    /did not serve bafybei.*Nothing was sealed/,
  );
  assert.equal(
    chain.calls.some((call) => call.method === "seal"),
    false,
  );
  assert.equal(
    chain.calls.some((call) => call.method === "put_chunk"),
    false,
  );
  await assert.rejects(
    deploy(nearfsCtx(streams(), fakeChain(), big, { mismatch: true }), {
      rest: [dir],
      flags: { "external-over": "65536" },
    }),
    /different bytes/,
  );
});

test("--no-verify seals without reading back and warns", async () => {
  const { dir, big } = largeSite();
  const chain = fakeChain();
  const io = streams();
  await deploy(nearfsCtx(io, chain, big, { serve: false }), {
    rest: [dir],
    flags: { "external-over": "65536", "no-verify": true },
  });
  assert.ok(chain.calls.some((call) => call.method === "seal"));
  assert.match(io.err(), /warning: big\.bin was not read back/);
});

test("a file over the on-chain limit without an external store is refused", async () => {
  const dir = writeTree(tempDir("quay-huge-"), { "index.html": "<p>x</p>" });
  writeFileSync(join(dir, "huge.bin"), Buffer.alloc(900_000, 1));
  await assert.rejects(
    deploy(baseCtx(streams(), { chain: fakeChain() }), {
      rest: [dir],
      flags: {},
    }),
    /external_over/,
  );
});

test("a deploy dry run reports large files and sends nothing", async () => {
  const { dir, big } = largeSite();
  const chain = fakeChain();
  const io = streams();
  await deploy(nearfsCtx(io, chain, big, {}), {
    rest: [dir],
    flags: { "external-over": "65536" },
  }).catch(() => {});
  const dry = streams();
  const ctx = nearfsCtx(dry, chain, big);
  ctx.dryRun = true;
  ctx.json = true;
  await deploy(ctx, {
    rest: [dir],
    flags: { "external-over": "65536", message: "x" },
  });
  const body = JSON.parse(dry.text());
  assert.equal(body.dry_run, true);
  assert.equal(body.external[0].path, "big.bin");
  assert.match(body.external[0].cid, /^bafybei/);
  assert.equal(chain.calls.filter((call) => call.method === "seal").length, 1);
});

function projectRoot(extra = {}) {
  const root = siteDir();
  const config = join(root, "quay.json");
  writeFileSync(
    config,
    JSON.stringify({
      account: "board.testnet",
      site: { dir: "site" },
      collections: {
        posts: {
          write: "members",
          payer: "site",
          max_doc_bytes: 2000,
          moderated: true,
        },
      },
      routes: [
        {
          pattern: "/posts/:id",
          kind: "doc",
          collection: "posts",
          template: "templates/post.html",
        },
      ],
      products: {
        pin: {
          name: "Pin",
          price_yocto: "100000000000000000000000",
          grant: "pin",
          pin_seconds: 86400,
        },
      },
      members: { open: true },
      ...extra,
    }),
  );
  return { root, config };
}

test("quay up --dry-run prints the plan and changes nothing", async () => {
  const { root, config } = projectRoot();
  const chain = fakeChain();
  const io = streams();
  const ctx = baseCtx(io, {
    chain,
    cwd: root,
    config: {
      account: "board.testnet",
      gateway: "https://board.testnet.page",
      path: config,
    },
    dryRun: true,
  });
  await run(ctx, parseArgs(["up", "--dry-run"]));
  assert.equal(chain.calls.length, 0);
  const text = io.text();
  assert.match(text, /collection posts {2}create/);
  assert.match(text, /product pin {2}create/);
  assert.match(text, /members open {2}unchanged/);
  assert.match(text, /deploy site {2}2 files, 1 routes/);
  assert.match(text, /versioned per release/);
  assert.match(text, /live state, not versioned/);
});

test("quay up applies steps in order, prints a link for each and promotes", async () => {
  const { root, config } = projectRoot({ members: { open: false } });
  const chain = fakeChain();
  const io = streams();
  const ctx = baseCtx(io, {
    chain,
    cwd: root,
    config: {
      account: "board.testnet",
      gateway: "https://board.testnet.page",
      path: config,
    },
  });
  await run(ctx, parseArgs(["up", "-m", "first"]));
  assert.deepEqual(
    chain.calls.map((call) => call.method),
    [
      "set_collection",
      "set_product",
      "set_members_open",
      "put_chunk",
      "put_chunk",
      "seal",
      "promote",
    ],
  );
  const seal = chain.calls.find((call) => call.method === "seal");
  assert.equal(seal.message, "first");
  assert.equal(seal.routes.length, 1);
  const text = io.text();
  assert.match(
    text,
    /collection posts {2}created {2}https:\/\/explorer\.testnet\.near\.org\/transactions\/tx-1/,
  );
  assert.match(
    text,
    /release 1 {2}https:\/\/board\.testnet\.page\/r\/1\/ {2}.*seal-1/,
  );
  assert.match(
    text,
    /production 1 {2}https:\/\/board\.testnet\.page\/ {2}.*promote-1/,
  );
  assert.match(text, /live state, not versioned/);
  // a second run changes nothing but the release
  const again = fakeChain({
    collections: Object.fromEntries(chain.state.collections),
    products: Object.fromEntries(chain.state.products),
    membersOpen: false,
    releases: chain.state.releases,
  });
  const second = streams();
  await run(
    baseCtx(second, { chain: again, cwd: root, config: ctx.config }),
    parseArgs(["up"]),
  );
  assert.deepEqual(
    again.calls
      .map((call) => call.method)
      .filter((method) => method.startsWith("set_")),
    [],
  );
});

test("quay up refuses a typo in quay.json before sending anything", async () => {
  const { root, config } = projectRoot();
  writeFileSync(
    config,
    JSON.stringify({
      account: "board.testnet",
      site: { dir: "site" },
      colections: {},
    }),
  );
  const chain = fakeChain();
  await assert.rejects(
    run(
      baseCtx(streams(), {
        chain,
        cwd: root,
        config: { account: "board.testnet", gateway: "x", path: config },
      }),
      parseArgs(["up"]),
    ),
    /unknown key colections/,
  );
  assert.equal(chain.calls.length, 0);
});

test("quay rollback prints what is versioned and what is not", async () => {
  const io = streams();
  const chain = fakeChain();
  chain.view = async (method) =>
    method === "get_status" ? { production: "2", previous: "1" } : null;
  await rollback(baseCtx(io, { chain }));
  assert.match(io.text(), /versioned per release: files, routes and templates/);
  assert.match(io.text(), /docs, collection rules, products, members/);
  const json = streams();
  await rollback(baseCtx(json, { chain, json: true }));
  assert.equal(JSON.parse(json.text()).versioned.length, 2);
});
