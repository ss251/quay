import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseProject } from "../../../cli/src/projectfile.mjs";
import { validateRoutes } from "../../../cli/src/routes.mjs";
import { collectSite } from "../../../cli/src/site.mjs";
import { docOf, loadSeed } from "../seed.mjs";
import { escapeHtml, includesOf, render } from "./render.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const board = join(here, "..");
const siteDir = join(board, "site");
const raw = JSON.parse(readFileSync(join(board, "quay.json"), "utf8"));

// the client bundle and config.json are build outputs
const built = spawnSync("node", [join(board, "build.mjs")], {
  encoding: "utf8",
});
assert.equal(built.status, 0, built.stderr);

const project = parseProject(raw);
const files = collectSite(siteDir);
const read = (path) =>
  existsSync(join(siteDir, path))
    ? readFileSync(join(siteDir, path), "utf8")
    : null;
const seed = loadSeed();
const NS = 1_731_283_200_000_000_000n;

/** A DocView as the contract returns it. `full` fills every optional field. */
function docView(post, index, full) {
  const owner = `${post.by}.${raw.account}`;
  return {
    collection: "posts",
    id: String(index + 1),
    seq: String(index + 1),
    owner,
    created: String(NS + BigInt(index) * 3_600_000_000_000n),
    updated: String(NS),
    data: docOf(post),
    hidden: false,
    pinned_until: full && index === 0 ? String(NS + 86_400_000_000_000n) : null,
    fn: full
      ? {
          hide: false,
          preview: {
            url: post.link ?? "https://example.org/",
            title: "Preview title",
            description: "Preview text",
            image: "https://example.org/i.png",
          },
        }
      : null,
    deposit: "1230000000000000000000",
  };
}
const ctxFor = (kind, full) => {
  const docs = seed.posts.map((post, i) => docView(post, i, full)).reverse();
  const base = {
    site: {
      account: raw.account,
      release: "7",
      host: `https://${raw.account}.page`,
    },
    params: {},
    query: full ? { owner: `maren.${raw.account}`, from: "5" } : {},
    viewer: null,
    now: String(NS),
  };
  return kind === "list"
    ? { ...base, docs: docs.slice(0, 10), next: full ? "3" : null }
    : { ...base, params: { id: "1" }, doc: docs.at(-1) };
};

test("quay.json passes the CLI's strict reader and has the shape the board needs", () => {
  assert.deepEqual(project.site, { dir: "site", spa: false });
  assert.deepEqual(project.members, { open: true });
  const posts = project.collections.posts;
  assert.equal(posts.write, "members");
  assert.equal(posts.payer, "site");
  assert.equal(posts.moderated, true);
  assert.equal(posts.max_doc_bytes, 2000);
  assert.equal(posts.max_docs_per_account, 50);
  assert.equal(posts.on_add, "moderate");
  const pin = project.products.pin;
  assert.equal(pin.grant, "pin");
  assert.equal(pin.pin_seconds, 86400);
  assert.equal(pin.price_yocto, "100000000000000000000000");
  assert.ok(pin.price_token);
  assert.deepEqual(Object.keys(raw.functions).sort(), ["digest", "moderate"]);
  assert.equal(raw.relay.host, "outlayer");
  assert.equal(raw.relay.fallback, "node");
  assert.deepEqual(raw.cron, [
    { name: "digest", every_minutes: 60, fn: "digest", input: {} },
  ]);
  assert.ok(raw.cron.every((job) => raw.functions[job.fn]));
  assert.ok(raw.collections.posts.on_add in raw.functions);
});

test("every route is valid for the CLI and its template is stored on chain", () => {
  const threshold = project.files.external_over;
  const listed = files.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    external: file.bytes.length > threshold,
  }));
  const routes = validateRoutes(project.routes, listed);
  assert.equal(routes.length, 4);
  for (const route of routes)
    if (route.template) assert.ok(read(route.template), route.template);
  assert.ok(
    files.some((f) => f.path === "index.html"),
    "index.html must be stored on chain",
  );
  assert.ok(files.some((f) => f.path === "404.html"));
  assert.ok(files.length <= 64);
});

test("on-chain size stays under 60 KB and a large image goes off chain", () => {
  const threshold = project.files.external_over;
  const onChain = files.filter((f) => f.bytes.length <= threshold);
  const external = files.filter((f) => f.bytes.length > threshold);
  const bytes = onChain.reduce((sum, f) => sum + f.bytes.length, 0);
  console.log(
    `on chain: ${onChain.length} files, ${bytes} bytes; external: ${external.map((f) => `${f.path} ${f.bytes.length}`).join(", ")}`,
  );
  assert.ok(bytes < 60 * 1024, `${bytes} bytes on chain`);
  assert.ok(external.some((f) => f.path === "assets/img/harbour.png"));
  for (const f of external)
    assert.match(
      f.path,
      /\.(png|jpe?g|webp)$/,
      "only images should be external",
    );
  for (const f of onChain)
    assert.ok(!f.bytes.includes("{{{"), `${f.path} has raw output`);
});

test("templates render with every variable present in the doc shape", () => {
  for (const [kind, path] of [
    ["list", "templates/home.html"],
    ["doc", "templates/post.html"],
  ]) {
    const missing = new Set();
    const html = render(path, ctxFor(kind, true), {
      read,
      onMissing: (p, from, type) => missing.add(`${from}: ${type} ${p}`),
    });
    // head.html is shared: list pages have no doc, by design
    if (kind === "list")
      missing.delete("partials/head.html: block doc.data.title");
    // optional fields exist in the full shape, so nothing may be unresolved except what the context omits by design
    assert.deepEqual([...missing], [], `unresolved in ${path}`);
    assert.ok(!html.includes("{{"), "no unrendered tag");
    assert.ok(html.includes("<title>"), "has a title");
  }
});

test("templates render the sparse shape (no fn, no pin, no link) without error", () => {
  const home = render("templates/home.html", ctxFor("list", false), { read });
  for (const post of seed.posts.slice(-10))
    assert.ok(home.includes(escapeHtml(post.title)), post.title);
  assert.ok(!home.includes('class="post pinned"'));
  assert.ok(home.includes("<ol"));
  const one = render("templates/post.html", ctxFor("doc", false), { read });
  assert.ok(one.includes("Pin this post"));
  assert.ok(!one.includes("Pinned until"));
  assert.ok(!one.includes("Link preview"));
});

test("pinned posts, previews and pagination appear in the full shape", () => {
  const home = render("templates/home.html", ctxFor("list", true), { read });
  assert.ok(home.includes("by maren.harbour-board.testnet"));
  assert.ok(
    home.includes(
      'rel="next" href="/?from=3&amp;owner=maren.harbour-board.testnet"',
    ),
  );
  const post = render("templates/post.html", ctxFor("doc", true), { read });
  assert.ok(post.includes("Pinned until"));
  assert.ok(post.includes("Preview title"));
  assert.ok(
    post.includes("2024-11-11") || post.includes("2024-11-10"),
    "date filter",
  );
  assert.ok(post.includes("<br>"), "lines filter keeps line breaks");
});

test("post text is escaped and cannot inject markup", () => {
  const ctx = ctxFor("doc", true);
  ctx.doc.data.title = '<script>alert("x")</script>';
  ctx.doc.data.body = "a < b\n<img src=x onerror=1>";
  ctx.doc.owner = 'evil"><b>.test';
  const html = render("templates/post.html", ctx, { read });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes('"><b>'));
});

test("every include and asset a page names exists in the release", () => {
  for (const file of files.filter((f) => f.path.endsWith(".html"))) {
    const text = file.bytes.toString("utf8");
    for (const inc of includesOf(text))
      assert.ok(read(inc), `${file.path} includes ${inc}`);
    for (const m of text.matchAll(/(?:src|href)="(\/[^"#?{]+)"/g)) {
      const target = m[1].replace(/^\//, "");
      if (/^(posts|api)\b/.test(target) || target === "") continue;
      const ok =
        existsSync(join(siteDir, target)) ||
        existsSync(join(siteDir, target, "index.html"));
      assert.ok(ok, `${file.path} points at ${m[1]}`);
    }
  }
});

test("pages are accessible HTML: lang, viewport, main, skip link, labelled fields", () => {
  const pages = [
    "index.html",
    "404.html",
    "new/index.html",
    "members/index.html",
    "receipts/index.html",
    "templates/home.html",
    "templates/post.html",
  ];
  for (const path of pages) {
    const text = read(path);
    assert.match(text, /<html lang="en">/, path);
    assert.ok(
      text.includes("</main>") || text.includes("</article>"),
      `${path} has main`,
    );
    assert.ok(
      text.includes('class="skip"') || text.includes("partials/header.html"),
      `${path} skip link`,
    );
    assert.ok(
      text.includes("viewport") || text.includes("partials/head.html"),
      `${path} viewport`,
    );
    assert.ok(!text.includes("lorem"), path);
  }
  const form = read("new/index.html");
  for (const m of form.matchAll(/<(input|textarea|select)\b[^>]*>/g)) {
    const before = form.slice(0, m.index);
    const inLabel =
      before.lastIndexOf("<label") > before.lastIndexOf("</label>");
    assert.ok(
      inLabel || /aria-label=/.test(m[0]) || /type="hidden"/.test(m[0]),
      `unlabelled ${m[0]}`,
    );
  }
  const css = read("assets/board.css");
  assert.ok(
    css.includes(":focus-visible") &&
      css.includes("prefers-color-scheme: dark") &&
      css.includes("prefers-reduced-motion"),
  );
});

test("seed data: 4 to 6 members, 10 to 14 posts, each fits the collection rules", () => {
  const members = Object.keys(seed.members);
  assert.ok(members.length >= 4 && members.length <= 6);
  assert.ok(seed.posts.length >= 10 && seed.posts.length <= 14);
  const perMember = {};
  for (const post of seed.posts) {
    const doc = docOf(post);
    assert.ok(
      Buffer.byteLength(JSON.stringify(doc)) <=
        project.collections.posts.max_doc_bytes,
      post.title,
    );
    assert.ok(doc.title.length <= 80 && doc.title && doc.body);
    if (doc.link) assert.match(doc.link, /^https:\/\//);
    perMember[post.by] = (perMember[post.by] ?? 0) + 1;
  }
  for (const [name, n] of Object.entries(perMember)) {
    assert.match(name, /^[a-z0-9_-]{2,32}$/);
    assert.ok(!["relay", "admin", "www", "api", "quay"].includes(name));
    assert.ok(n <= project.collections.posts.max_docs_per_account);
  }
  assert.equal(
    new Set(seed.posts.map((p) => p.title)).size,
    seed.posts.length,
    "unique titles (seed.mjs skips by title)",
  );
  assert.ok(!/lorem|ipsum/i.test(JSON.stringify(seed)));
  // the form's topic options cover every seeded topic
  const options = [
    ...read("new/index.html").matchAll(/<option value="([a-z]+)"/g),
  ].map((m) => m[1]);
  for (const post of seed.posts)
    assert.ok(options.includes(post.topic), `topic ${post.topic}`);
});

test("site folder holds only files quay can seal", () => {
  const walk = (dir) =>
    readdirSync(dir).flatMap((n) =>
      statSync(join(dir, n)).isDirectory()
        ? walk(join(dir, n))
        : [relative(siteDir, join(dir, n))],
    );
  for (const path of walk(siteDir)) assert.ok(!/(^|\/)\./.test(path), path);
});
