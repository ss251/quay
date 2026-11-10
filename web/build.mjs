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

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const SITE = "https://quay-esc0v902.testnet.page/";

// {{i:name}} or {{i:name sm}} expands to an inline reference into the icon sprite.
function expand(html, prefix) {
  return html
    .replaceAll("{{P}}", prefix)
    .replace(/\{\{i:([a-z-]+)( sm)?\}\}/g, (_, name, sm) => {
      return `<svg class="icon${sm ? " sm" : ""}" aria-hidden="true"><use href="${prefix}assets/icons.svg#i-${name}"/></svg>`;
    });
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

const mark = () =>
  `<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="var(--ink)"/><path d="M5.5 17.5h13M9 17.5v-6M14.5 17.5V8.5" stroke="var(--on-ink)" stroke-width="2" fill="none"/><circle cx="14.5" cy="5.6" r="1.6" fill="var(--live)"/></svg>`;

function siteNav(prefix, current) {
  const link = (href, label, cls = "") => {
    const here = current === href ? ` aria-current="page"` : "";
    return `<a${cls ? ` class="${cls}"` : ""} href="${prefix}${href}"${here}>${label}</a>`;
  };
  return `<a class="skip" href="#content">Skip to content</a>
<header class="site-nav"><div class="container">
<a class="brand" href="${prefix}index.html">${mark()}Quay</a>
<nav aria-label="Site">${link("docs/index.html", "Docs")}${link("dashboard/index.html", "Dashboard")}<a class="hide-s" href="https://quay-65nqd3rn.testnet.page/">Sample</a></nav>
<div class="nav-end"><span class="net hide-s"><span class="dot dot-live"></span>Testnet</span>
<button class="btn btn-sm btn-icon btn-quiet theme-btn" type="button" data-theme-toggle aria-label="Switch theme">{{i:moon}}<svg class="icon i-sun" aria-hidden="true"><use href="${prefix}assets/icons.svg#i-sun"/></svg></button>
<a class="btn btn-sm btn-primary" href="${prefix}dashboard/index.html">Open dashboard</a></div>
</div></header>`.replace(
    "{{i:moon}}",
    `<svg class="icon i-moon" aria-hidden="true"><use href="${prefix}assets/icons.svg#i-moon"/></svg>`,
  );
}

function siteFoot(prefix) {
  return `<footer class="site-foot"><div class="container">
<div class="cols">
<div><a class="brand" href="${prefix}index.html">${mark()}Quay</a><p class="muted" style="margin-top:14px;max-width:34ch">Sealed releases and a production pointer for static sites on NEAR testnet.</p></div>
<div><h2>Product</h2><ul><li><a href="${prefix}docs/index.html">Docs</a></li><li><a href="${prefix}dashboard/index.html">Dashboard</a></li><li><a href="${prefix}docs/index.html#cli">Commands</a></li></ul></div>
<div><h2>Sample</h2><ul><li><a href="https://quay-65nqd3rn.testnet.page/">Production</a></li><li><a href="https://quay-65nqd3rn.testnet.page/r/1/">Release 1</a></li><li><a href="${prefix}dashboard/index.html?account=quay-65nqd3rn.testnet">In the dashboard</a></li></ul></div>
<div><h2>On chain</h2><ul><li><a href="https://explorer.testnet.near.org/accounts/quay-esc0v902.testnet">This site's account</a></li><li><a href="https://explorer.testnet.near.org/accounts/quay-65nqd3rn.testnet">Sample account</a></li><li><a href="${prefix}docs/index.html#how">How it works</a></li></ul></div>
</div>
<div class="small"><span>Testnet only. No mainnet path and no real funds.</span><span class="mono">quay-esc0v902.testnet</span></div>
</div></footer>`;
}

function page({ title, description, href, body, script, app, root: absolute }) {
  const depth = href.split("/").length - 1;
  // 404.html is served at any missing path, so it links from the host root.
  const prefix = absolute ? "/" : depth ? "../".repeat(depth) : "";
  const scripts = [
    `<script type="module" src="${prefix}assets/quay.js"></script>`,
  ];
  if (script)
    scripts.push(`<script type="module" src="${prefix}${script}"></script>`);
  const embed = app
    ? `<script>if(new URLSearchParams(location.search).has("embed"))document.documentElement.classList.add("embed")</script>`
    : "";
  const theme = `<script>try{const t=localStorage.getItem("quay-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}</script>`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
<link rel="stylesheet" href="${prefix}assets/quay.css">
${theme}${embed}
${scripts.join("\n")}
</head>
<body>
${app ? body : `${siteNav(prefix, href)}\n<main id="content">\n${body}\n</main>\n${siteFoot(prefix)}`}
</body>
</html>
`;
  return tidy(expand(html, prefix));
}

function escapeHtml(text) {
  return text.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );
}

const cli = escapeHtml(
  [helpText(), ...COMMANDS.map((command) => helpText(command.name))].join(
    "\n\n",
  ),
);
const read = (name) => readFileSync(join(root, "pages", name), "utf8");

const pages = {
  "index.html": page({
    title: "Quay: deploy static sites to NEAR testnet",
    description:
      "Quay seals every deploy as a release with its own URL. Production is a pointer you promote or roll back.",
    href: "index.html",
    body: read("home.html"),
  }),
  "docs/index.html": page({
    title: "Docs · Quay",
    description:
      "Install Quay, deploy a folder, and read the command reference generated from quay --help.",
    href: "docs/index.html",
    body: read("docs.html").replace("{{CLI}}", cli),
  }),
  "dashboard/index.html": page({
    title: "Dashboard · Quay",
    description:
      "Read a Quay account's releases, then promote, roll back, or delete with a testnet wallet.",
    href: "dashboard/index.html",
    script: "assets/dashboard.js",
    app: true,
    body: read("dashboard.html"),
  }),
  "404.html": page({
    title: "Not found · Quay",
    description: "That path is not in this Quay release.",
    href: "404.html",
    root: true,
    body: read("404.html"),
  }),
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(root, "assets"), join(dist, "assets"), { recursive: true });
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
for (const name of ["quay.js", "dashboard.js"]) {
  const js = readFileSync(join(root, "assets", name), "utf8");
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
for (const [href, html] of Object.entries(pages)) {
  const target = join(dist, href);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
}
console.log(`built ${Object.keys(pages).length} pages into web/dist`);
