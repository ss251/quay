import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS, helpText } from "../cli/src/text.mjs";
import { BOARD, BOARD_RELEASES, LAYERS, UP } from "./layers.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
// Hosts that serve each account come from hosts.json. Static pages use relative
// links for themselves, so they work on any host; SITE is only for og: tags,
// which must be absolute.
const hosts = JSON.parse(readFileSync(join(root, "hosts.json"), "utf8"));
const SITE = `${hosts.mirrors["quay-esc0v902.testnet"]}/`;
const SAMPLE = hosts.mirrors["quay-65nqd3rn.testnet"];
const SAMPLE_PUBLIC = hosts.public.replace("{name}", "quay-65nqd3rn");
const BOARD_HOST = hosts.mirrors[BOARD];
if (!BOARD_HOST) throw new Error(`hosts.json has no mirror for ${BOARD}`);

// {{i:name}} or {{i:name sm}} expands to a reference into the sprite that
// `inlineSprite` puts in the page, so icons never need a second request.
function expand(html, prefix) {
  return html
    .replaceAll("{{P}}", prefix)
    .replaceAll("{{SAMPLE_HOST}}", SAMPLE.replace("https://", ""))
    .replaceAll("{{SAMPLE_PUBLIC}}", SAMPLE_PUBLIC)
    .replaceAll("{{SAMPLE}}", SAMPLE)
    .replaceAll("{{BOARD_HOST}}", BOARD_HOST.replace("https://", ""))
    .replaceAll("{{BOARD}}", BOARD_HOST)
    .replace(/\{\{i:([a-z-]+)( sm)?( end)?\}\}/g, (_, name, sm, end) => {
      const cls = `icon${sm ? " sm" : ""}${end ? " icon-end" : ""}`;
      return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
    })
    .replace(/href="[^"]*assets\/icons\.svg#/g, 'href="#');
}

const SYMBOLS = new Map(
  [
    ...readFileSync(join(root, "assets", "icons.svg"), "utf8").matchAll(
      /<symbol id="(i-[a-z-]+)"[\s\S]*?<\/symbol>/g,
    ),
  ].map((match) => [match[1], match[0]]),
);

// A hidden sprite after <body> with the symbols the page uses. The dashboard
// draws icons from script, so it gets every symbol.
function inlineSprite(html, all) {
  const used = all
    ? [...SYMBOLS.keys()]
    : [...new Set([...html.matchAll(/href="#(i-[a-z-]+)"/g)].map((m) => m[1]))];
  const missing = used.filter((id) => !SYMBOLS.has(id));
  if (missing.length) throw new Error(`no icon ${missing.join(", ")}`);
  if (!used.length) return html;
  const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">${used.map((id) => SYMBOLS.get(id)).join("")}</svg>`;
  return html.replace("<body>\n", `<body>\n${sprite}\n`);
}

// Drop indentation and blank lines outside <pre>; the bytes are stored on chain.
function tidy(html) {
  return html
    .split(/(<pre[\s\S]*?<\/pre>)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/<!--(?!\s*biome)[\s\S]*?-->/g, "")
            .replace(/\n[ \t]+/g, "\n")
            .replace(/\n{2,}/g, "\n"),
    )
    .join("");
}

// A small CSS minifier: comments, indentation, and spaces around punctuation.
function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};,>])\s*/g, "$1")
    .replace(/:\s+/g, ":")
    .replace(/;}/g, "}")
    .replace(/([\s(,:/])0\.(\d)/g, "$1.$2")
    .trim();
}

// Plain JS: drop whole-line comments and indentation. No renaming, no bundler.
function tidyJs(js) {
  return js
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .join("\n");
}

function escapeHtml(text) {
  return text.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );
}

const mark = () =>
  `<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="var(--ink)"/><path d="M5.5 17.5h13M9 17.5v-6M14.5 17.5V8.5" stroke="var(--on-ink)" stroke-width="2" fill="none"/><circle cx="14.5" cy="5.6" r="1.6" fill="var(--accent)"/></svg>`;

// Third-party marks, by design/round5-assets rules: NEAR's own logo and
// "Built on NEAR" badge, unmodified, one colour per theme; every other tool is
// its name set in type (Cloudflare allows word form only; OutLayer and
// FastNEAR publish no usage rules, so no logo of theirs is used).
const NAMES = {
  near: "NEAR",
  web4: "web4",
  cloudflare: "Cloudflare Workers",
  outlayer: "OutLayer",
  fastnear: "FastNEAR",
  connect: "near-connect",
};
function nearLogo(prefix) {
  return `<span class="tool" data-tool="near"><img class="on-light" src="${prefix}assets/brand/near-logo.svg" alt="NEAR" width="1440" height="351"><img class="on-dark" src="${prefix}assets/brand/near-logo-rev.svg" alt="" width="1440" height="351"></span>`;
}
function builtOn(prefix, cls = "") {
  return `<a class="built-on${cls}" href="https://near.org/"><span class="tool" data-tool="near-built"><img class="on-light" src="${prefix}assets/brand/built-on-near.svg" alt="Built on NEAR" width="3420" height="567"><img class="on-dark" src="${prefix}assets/brand/built-on-near-rev.svg" alt="" width="3420" height="567"></span></a>`;
}
// "near", "outlayer", "fastnear:FastFS" (a tool with a product name) or "std:NEP-413".
function tool(spec, { prefix = "", logo = false } = {}) {
  const [key, label] = spec.split(":");
  if (key === "std") return `<span class="std">${label}</span>`;
  if (key === "near" && logo) return nearLogo(prefix);
  return `<span class="tool tool-text" data-tool="${key}">${label ?? NAMES[key]}</span>`;
}

function siteNav(prefix, current) {
  const link = (href, label, cls = "") => {
    const here = current.startsWith(href.replace("index.html", ""))
      ? ` aria-current="page"`
      : "";
    return `<a${cls ? ` class="${cls}"` : ""} href="${prefix}${href}"${here}>${label}</a>`;
  };
  return `<a class="skip" href="#content">Skip to content</a>
<header class="site-nav"><div class="container">
<a class="brand" href="${prefix}index.html">${mark()}Quay</a>
${builtOn(prefix, " hide-s")}
<nav aria-label="Site">${link("docs/index.html", "Docs")}${link("architecture/index.html", "Architecture", "hide-s")}<a class="hide-s" href="{{BOARD}}/">Harbour Board</a></nav>
<div class="nav-end"><span class="net hide-s"><span class="dot dot-live"></span>NEAR testnet</span>
<button class="btn btn-sm btn-icon btn-quiet theme-btn" type="button" data-theme-toggle aria-label="Switch theme"><svg class="icon i-moon" aria-hidden="true"><use href="#i-moon"/></svg><svg class="icon i-sun" aria-hidden="true"><use href="#i-sun"/></svg></button>
<a class="btn btn-sm" data-cta-account="href" href="${prefix}dashboard/index.html">Open dashboard</a></div>
</div></header>`;
}

const INDEPENDENT =
  "Quay is an independent hackathon project. It runs on NEAR testnet and is not made, run or endorsed by the NEAR Foundation or by any tool named on this page. Testnet only, with no mainnet path and no real funds. Cloudflare, the Cloudflare logo, and Cloudflare Workers are trademarks and/or registered trademarks of Cloudflare, Inc. in the United States and other jurisdictions.";

function siteFoot(prefix) {
  const ex = (id) => `https://explorer.testnet.near.org/accounts/${id}`;
  return `<footer class="site-foot"><div class="container">
<div class="cols">
<div><a class="brand" href="${prefix}index.html">${mark()}Quay</a><p class="muted blurb">Pages, data, functions and sign-in on one NEAR testnet account.</p>${builtOn(prefix)}</div>
<div><h2>Product</h2><ul><li><a href="${prefix}docs/index.html">Docs</a></li><li><a href="${prefix}docs/layers/index.html">Layers</a></li><li><a href="${prefix}architecture/index.html">Architecture</a></li><li><a href="${prefix}dashboard/index.html">Dashboard</a></li></ul></div>
<div><h2>Harbour Board</h2><ul><li><a href="{{BOARD}}/">Live site</a></li><li><a href="${prefix}dashboard/index.html?account=${BOARD}">In the dashboard</a></li><li><a href="${ex(BOARD)}">On the explorer</a></li></ul></div>
<div><h2>On chain</h2><ul><li><a href="${ex("quay-esc0v902.testnet")}">This site's account</a></li><li><a href="https://explorer.testnet.near.org/">Testnet explorer</a></li></ul></div>
</div>
<div class="small"><p>${INDEPENDENT}</p><span class="mono">quay-esc0v902.testnet</span></div>
</div></footer>`;
}

function page({
  title,
  description,
  href,
  body,
  script,
  app,
  root: absolute,
  head = "",
  mainClass,
}) {
  const depth = href.split("/").length - 1;
  // 404.html is served at any missing path, so it links from the host root.
  const prefix = absolute ? "/" : depth ? "../".repeat(depth) : "";
  const scripts = [
    `<script type="module" src="${prefix}assets/quay.js"></script>`,
  ];
  if (script)
    for (const src of [script].flat())
      scripts.push(`<script type="module" src="${prefix}${src}"></script>`);
  const embed = app
    ? `<script>if(new URLSearchParams(location.search).has("embed"))document.documentElement.classList.add("embed")</script>`
    : "";
  const theme = `<script>try{const t=localStorage.getItem("quay-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}</script>`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="theme-color" content="#f9fafb" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0c0e" media="(prefers-color-scheme: dark)">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${SITE}assets/og.png">
<meta property="og:url" content="${SITE}${href.replace("index.html", "")}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${prefix}assets/mark.svg" type="image/svg+xml">
<link rel="preload" href="${prefix}assets/fonts/geist.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${prefix}assets/fonts/geist-mono.woff2" as="font" type="font/woff2" crossorigin>
${head}<link rel="stylesheet" href="${prefix}assets/quay.css">
${theme}${embed}
${scripts.join("\n")}
</head>
<body>
${app ? body : `${siteNav(prefix, href)}\n<main id="content"${mainClass ? ` class="${mainClass}"` : ""}>\n${body}\n</main>\n${siteFoot(prefix)}`}
</body>
</html>
`;
  return tidy(inlineSprite(expand(html, prefix), app));
}

// ---------- commands shown on the site must exist ----------
// Every `quay ...` line on a page is checked against the CLI's own help: the
// command must exist and every --flag must be one its help lists.
const GLOBAL_FLAGS = ["--json", "--account", "--rpc", "--help"];
function checkCommand(line, where) {
  const words = line.trim().split(/\s+/);
  if (words[0] !== "quay") return;
  const name = words[1];
  if (!COMMANDS.some((command) => command.name === name))
    throw new Error(`${where}: "${line}" uses a command quay does not have`);
  const help = helpText(name);
  for (const flag of line.match(/(?<=\s)--[a-z][a-z-]*/g) ?? []) {
    if (!GLOBAL_FLAGS.includes(flag) && !help.includes(flag))
      throw new Error(
        `${where}: "${line}" uses ${flag}, not in quay ${name} --help`,
      );
  }
}
function checkCommands(html, where) {
  const text = html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  for (const match of text.matchAll(/(?:^|[\n`]|\s)(quay [a-z]+[^\n`<]*)/g)) {
    const line = match[1].split(/(?:,|\.)\s|\s(?:then|and|or|to|on|with)\s/)[0];
    if (
      /^quay [a-z]+(\s|$)/.test(line) &&
      COMMANDS.some((c) => line.startsWith(`quay ${c.name}`))
    )
      checkCommand(line.replace(/[.)]$/, ""), where);
  }
}

const cli = escapeHtml(
  [helpText(), ...COMMANDS.map((command) => helpText(command.name))].join(
    "\n\n",
  ),
);
// Each layer page names the commands whose help covers it; they must exist.
for (const name of [...LAYERS, UP].flatMap((layer) => layer.help))
  if (!COMMANDS.some((command) => command.name === name))
    throw new Error(`quay ${name} is not in this build of the CLI`);
const read = (name) => readFileSync(join(root, "pages", name), "utf8");

// ---------- the layer table (home and the layers overview) ----------
function layerRows(prefix) {
  return LAYERS.map((layer) => {
    const runs = layer.runs.map((spec) => tool(spec, { prefix })).join(" ");
    const proof = layer.proof
      .map(([href, label]) => `<a href="${href}">${label}</a>`)
      .join("<br>");
    const long = layer.cmd.length > 46 ? ` class="cmd-wrap"` : "";
    return `<tr><th scope="row"><a href="${prefix}docs/layers/${layer.id}/index.html">${layer.name}</a></th><td>${layer.what}</td><td${long}><code>${escapeHtml(layer.cmd)}</code></td><td class="runs">${runs}</td><td class="proof">${proof}</td></tr>`;
  }).join("\n");
}
function layerTable(prefix) {
  return `<div class="table-wrap" role="region" tabindex="0" aria-label="Layers, with commands and proof"><table class="layers">
<thead><tr><th scope="col">Layer</th><th scope="col">What it does</th><th scope="col">Command</th><th scope="col">Runs on</th><th scope="col">Proof</th></tr></thead>
<tbody>
${layerRows(prefix)}
</tbody></table></div>`;
}

// ---------- docs: sidebar, layer pages ----------
const DOC_PAGES = [
  ["docs/index.html", "Get started"],
  ["docs/index.html#cli", "Commands"],
  ["docs/index.html#ci", "CI"],
  ["docs/index.html#limits", "Limits"],
  ["architecture/index.html", "Architecture"],
];
function docsSide(prefix, current) {
  const item = (href, label) =>
    `<li><a href="${prefix}${href}"${href === current ? ' aria-current="page"' : ""}>${label}</a></li>`;
  return `<nav class="docs-side" aria-label="Docs"><p class="docs-side-h">Start</p><ol>${DOC_PAGES.map(([href, label]) => item(href, label)).join("")}</ol>
<p class="docs-side-h">Layers</p><ol>${item("docs/layers/index.html", "All layers")}${LAYERS.map((l) => item(`docs/layers/${l.id}/index.html`, l.title ?? l.name)).join("")}${item("docs/layers/up/index.html", "<code>quay up</code>")}</ol></nav>`;
}
function docsShell(prefix, current, article) {
  return `<div class="container docs-grid">
${docsSide(prefix, current)}
<article class="prose">
${article}
</article>
</div>`;
}
function term(id, text, label = "Terminal") {
  return `<div class="term"><div class="term-bar"><span>${label}</span><button class="btn btn-sm btn-icon btn-quiet" type="button" data-copy-from="${id}" aria-label="Copy the ${label === "Terminal" ? "commands" : label}">{{i:copy sm}}</button></div>
<pre id="${id}">${escapeHtml(text)}</pre></div>`;
}
const ORDER = [...LAYERS, UP];
function pager(prefix, index) {
  const prev = ORDER[index - 1];
  const next = ORDER[index + 1];
  const href = (l) => `${prefix}docs/layers/${l.id}/index.html`;
  return `<nav class="pager" aria-label="Next and previous">${prev ? `<a href="${href(prev)}">{{i:left sm}}${prev.title ?? prev.name}</a>` : `<a href="${prefix}docs/layers/index.html">{{i:left sm}}All layers</a>`}${next ? `<a href="${href(next)}">${next.title ?? next.name}{{i:right sm end}}</a>` : `<a href="${prefix}architecture/index.html">Architecture{{i:right sm end}}</a>`}</nav>`;
}
function layerPage(layer, index) {
  const href = `docs/layers/${layer.id}/index.html`;
  const prefix = "../../../";
  const chipKind = layer.stateKind === "warn" ? "chip-warn-plain" : "chip-live";
  const dot =
    layer.stateKind === "warn" ? "" : '<span class="dot dot-live"></span>';
  const runsOn = layer.runs
    .filter((spec) => !spec.startsWith("std:"))
    .map((spec) => tool(spec, { prefix, logo: true }))
    .join(" ");
  const article = `<p class="crumbs"><a href="${prefix}docs/index.html">Docs</a> <span aria-hidden="true">/</span> <a href="${prefix}docs/layers/index.html">Layers</a></p>
<h1>${layer.title ?? layer.name}</h1>
<p class="status-line"><span class="chip ${chipKind}">${dot}${layer.state}</span><span class="provider">Runs on ${runsOn}</span></p>
<p class="lede">${layer.lede}</p>
<h2 id="commands">${layer.cmdsLabel ? "Setting" : "Commands"}</h2>
${term(`cmd-${layer.id}`, layer.cmds, layer.cmdsLabel)}
<h2 id="how">How Harbour Board uses it</h2>
<ol class="steps-list">${layer.how.map((line) => `<li>${line}</li>`).join("")}</ol>
${layer.sample ? `<p>${layer.sample.intro}</p>\n<pre class="out" tabindex="0">${escapeHtml(layer.sample.json)}</pre>` : ""}
<h2 id="proof">Proof on testnet</h2>
<table class="proof-table"><tbody>${layer.proofRows.map(([th, td]) => `<tr><th scope="row">${th}</th><td>${td}</td></tr>`).join("")}</tbody></table>
<p>Check it without a key: ${layer.check} The <code>view</code> helper is in the repository README, and <code>scripts/judge.sh</code> runs these checks.</p>
<h2 id="trust">What you trust</h2>
<p>${layer.trust}</p>
<h2 id="limits">Limits</h2>
<table class="limits4"><tbody>${layer.limits.map(([th, td]) => `<tr><th scope="row">${th}</th><td>${td}</td></tr>`).join("")}</tbody></table>
<p>Every flag is in the <a href="${prefix}docs/index.html#cli">command reference</a>, generated from ${layer.help.map((name) => `<code>quay ${name} --help</code>`).join(", ")}.</p>
${pager(prefix, index)}`;
  return [
    href,
    page({
      title: `${layer.title ?? layer.name} · Quay docs`,
      description: `${layer.title ?? layer.name} on a NEAR testnet account with Quay: commands, how Harbour Board uses it, proof on testnet, what you trust and the limits.`,
      href,
      mainClass: "docs4",
      body: docsShell(prefix, href, article),
    }),
  ];
}
function upPage() {
  const href = "docs/layers/up/index.html";
  const prefix = "../../../";
  const article = `<p class="crumbs"><a href="${prefix}docs/index.html">Docs</a> <span aria-hidden="true">/</span> <a href="${prefix}docs/layers/index.html">Layers</a></p>
<h1><code>quay up</code></h1>
<p class="status-line"><span class="chip chip-live"><span class="dot dot-live"></span>Live on testnet</span></p>
<p class="lede">${UP.lede}</p>
<h2 id="commands">Commands</h2>
${term("cmd-up", UP.cmds)}
<h2 id="versioned">Versioned with a release, and not</h2>
<p>${UP.versioned}</p>
<p>Every flag is in the <a href="${prefix}docs/index.html#cli">command reference</a>, generated from <code>quay up --help</code>.</p>
${pager(prefix, ORDER.length - 1)}`;
  return [
    href,
    page({
      title: "quay up · Quay docs",
      description:
        "quay up applies quay.json: functions, collections, products, members and cron, then deploys the site and promotes it.",
      href,
      mainClass: "docs4",
      body: docsShell(prefix, href, article),
    }),
  ];
}

// ---------- the Harbour Board release picker on the home page ----------
// The list is baked in for a page without JavaScript; quay.js refreshes it
// from the chain on load.
const nf = new Intl.NumberFormat("en-US");
function releasePicker() {
  const sorted = [...BOARD_RELEASES.releases].sort((a, b) => b.id - a.id);
  const rows = sorted.map((r) => {
    const on = r.id === BOARD_RELEASES.production;
    const src = on ? `${BOARD_HOST}/` : `${BOARD_HOST}/r/${r.id}/`;
    const badge = on
      ? '<span class="ptr">production</span>'
      : r.id === BOARD_RELEASES.previous
        ? '<span class="chip chip-prev">previous</span>'
        : "";
    return `<button class="lg-row" type="button" role="tab" id="rel-${r.id}" aria-controls="demo-panel" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-src="${src}"><span class="lg-id">${r.id}</span><span class="lg-msg">${escapeHtml(r.message)}<small>${r.files} files, ${nf.format(r.bytes)}&nbsp;B</small></span>${badge}</button>`;
  });
  return rows.join("\n");
}

const home = read("home.html")
  .replace("{{RELEASES}}", releasePicker())
  .replaceAll("{{RELEASE_COUNT}}", String(BOARD_RELEASES.releases.length))
  .replaceAll("{{PRODUCTION}}", String(BOARD_RELEASES.production))
  .replace("{{LAYERS}}", layerTable(""))
  .replace("{{NEAR_LOGO}}", nearLogo(""))
  .replaceAll("{{NEAR_MARK}}", nearLogo(""));

const pages = {
  "index.html": page({
    title: "Quay: full-stack apps on one NEAR account",
    description:
      "Quay deploys pages, data, functions and sign-in to a NEAR testnet account it creates in one command. No signup, no server to rent. Every deploy is a sealed release.",
    href: "index.html",
    head: `<link rel="preconnect" href="${BOARD_HOST}">\n`,
    script: "assets/canvas.js",
    body: home,
  }),
  "docs/index.html": page({
    title: "Docs · Quay",
    description:
      "Install Quay, deploy a folder, and read the command reference generated from quay --help.",
    href: "docs/index.html",
    mainClass: "docs4",
    body: docsShell("../", "docs/index.html", read("docs.html")).replace(
      "{{CLI}}",
      cli,
    ),
  }),
  "docs/layers/index.html": page({
    title: "Layers · Quay docs",
    description:
      "Site, gateway, routes, data, functions, sign-in, relay, large files, payments and cron on one NEAR testnet account: commands and proof.",
    href: "docs/layers/index.html",
    mainClass: "docs4",
    body: docsShell(
      "../../",
      "docs/layers/index.html",
      read("layers.html").replace("{{LAYERS}}", layerTable("../../")),
    ),
  }),
  ...Object.fromEntries([...LAYERS.map(layerPage), upPage()]),
  "architecture/index.html": page({
    title: "Architecture · Quay",
    description:
      "What is on chain, what depends on one operator, and how to replace or self-host each piece.",
    href: "architecture/index.html",
    script: "assets/canvas.js",
    body: read("architecture.html").replaceAll(
      "{{NEAR_MARK}}",
      nearLogo("../"),
    ),
  }),
  "dashboard/index.html": page({
    title: "Dashboard · Quay",
    description:
      "Read a Quay account's releases, data, functions and relay on a canvas, then promote, roll back, or delete with a testnet wallet.",
    href: "dashboard/index.html",
    script: "assets/dashboard.js",
    app: true,
    body: read("dashboard.html").replace("{{FOOT}}", INDEPENDENT),
  }),
  "404.html": page({
    title: "Not found · Quay",
    description: "That path is not in this Quay release.",
    href: "404.html",
    root: true,
    body: read("404.html"),
  }),
};
for (const [href, html] of Object.entries(pages)) checkCommands(html, href);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
// Pages carry their icons inline, so the sprite file is not published.
cpSync(join(root, "assets"), join(dist, "assets"), {
  recursive: true,
  filter: (path) => !path.endsWith("icons.svg"),
});
// esbuild is a dev dependency used only to shrink files; without it the build falls back to plain tidying.
let esbuild = null;
try {
  esbuild = await import("esbuild");
} catch {}
const cssSource = readFileSync(join(root, "assets", "quay.css"), "utf8");
writeFileSync(
  join(dist, "assets", "quay.css"),
  esbuild
    ? (
        await esbuild.transform(cssSource, {
          loader: "css",
          minify: true,
          target: ["chrome123", "safari17.5", "firefox120"],
        })
      ).code
    : minifyCss(cssSource),
);
// hosts.json is inlined into the dashboard so it needs no extra request.
const HOSTS_LINE = "const HOSTS = {};";
for (const name of ["quay.js", "canvas.js", "dashboard.js"]) {
  let js = readFileSync(join(root, "assets", name), "utf8");
  if (name === "dashboard.js") {
    if (!js.includes(HOSTS_LINE))
      throw new Error("dashboard.js lost its HOSTS line");
    const { mirrors, public: pub, local } = hosts;
    js = js.replace(
      HOSTS_LINE,
      `const HOSTS = ${JSON.stringify({ mirrors, public: pub, local })};`,
    );
  }
  writeFileSync(
    join(dist, "assets", name),
    esbuild
      ? (
          await esbuild.transform(js, {
            loader: "js",
            format: "esm",
            minify: true,
            target: "es2022",
          })
        ).code
      : tidyJs(js),
  );
}
// The layer status module the dashboard loads on demand (also @quay/client/status).
if (esbuild)
  await esbuild.build({
    entryPoints: [join(root, "..", "client", "src", "status.mjs")],
    outfile: join(dist, "assets", "status.js"),
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    legalComments: "none",
  });
else
  cpSync(
    join(root, "..", "client", "src", "status.mjs"),
    join(dist, "assets", "status.js"),
  );
for (const [href, html] of Object.entries(pages)) {
  const target = join(dist, href);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
}
console.log(`built ${Object.keys(pages).length} pages into web/dist`);
