import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS, helpText } from "../cli/src/text.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

const mark = `<svg class="mark-line" viewBox="0 0 32 32" aria-hidden="true"><path d="M4 25h24M7 25V11h5v14M15 25V7h5v18"/></svg>`;

function header(prefix, current) {
  const link = (href, label) => {
    const here = current === href ? ` aria-current="page"` : "";
    return `<a href="${prefix}${href}"${here}>${label}</a>`;
  };
  return `<a class="skip" href="#content">Skip to content</a>
<header class="site-header">
  <div class="wrap bar">
    <a class="brand" href="${prefix}index.html">${mark} Quay</a>
    <nav class="nav" aria-label="Site">
      ${link("index.html", "Overview")}
      ${link("docs/index.html", "Docs")}
      ${link("dashboard/index.html", "Dashboard")}
      <button type="button" class="quiet" data-theme-toggle>Dark</button>
    </nav>
  </div>
</header>`;
}

function footer() {
  return `<footer class="site-footer"><div class="wrap">Testnet only. A release stays at its URL. Production is a pointer.</div></footer>`;
}

function page({ title, description, href, body, script }) {
  const depth = href.includes("/") ? 1 : 0;
  const prefix = depth ? "../" : "";
  const extra = script
    ? `\n<script type="module" src="${prefix}${script}"></script>`
    : "";
  const embed =
    href === "dashboard/index.html"
      ? `\n<script>if (new URLSearchParams(location.search).has("embed")) document.documentElement.classList.add("embed");</script>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="https://quay-esc0v902.testnet.page/assets/preview.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${prefix}assets/mark.svg" type="image/svg+xml">
<link rel="stylesheet" href="${prefix}assets/quay.css">
<script type="module" src="${prefix}assets/quay.js"></script>${embed}${extra}
</head>
<body>
${header(prefix, href)}
<main id="content" class="wrap">
${body}
</main>
${footer()}
</body>
</html>
`;
}

function escapeHtml(text) {
  return text.replace(
    /[&<>]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char],
  );
}

const cli = escapeHtml(
  [helpText(), ...COMMANDS.map((command) => helpText(command.name))].join(
    "\n\n",
  ),
);

const pages = {
  "index.html": page({
    title: "Quay",
    description:
      "Publish a folder to a NEAR testnet account. Each release keeps its URL. Production is a pointer you move on purpose.",
    href: "index.html",
    body: readFileSync(join(root, "pages", "home.html"), "utf8"),
  }),
  "docs/index.html": page({
    title: "Quay docs",
    description:
      "Install Quay, deploy a folder, and read the command reference generated from quay --help.",
    href: "docs/index.html",
    body: readFileSync(join(root, "pages", "docs.html"), "utf8").replace(
      "{{CLI}}",
      cli,
    ),
  }),
  "dashboard/index.html": page({
    title: "Quay dashboard",
    description:
      "Look up a Quay account, then promote, roll back, or delete with a testnet wallet signature.",
    href: "dashboard/index.html",
    script: "assets/dashboard.js",
    body: readFileSync(join(root, "pages", "dashboard.html"), "utf8"),
  }),
  "404.html": page({
    title: "Not found — Quay",
    description: "That path is not in this Quay release.",
    href: "404.html",
    body: `<h1>Not found</h1>
<p class="lede">That path is not in this release. A missing file stays missing until you seal a new release that contains it.</p>
<p>If you just created the account, the gateway may still be issuing the TLS certificate. Wait a minute and try the host again.</p>
<p><a href="index.html">Overview</a> · <a href="docs/index.html">Docs</a> · <a href="dashboard/index.html">Dashboard</a></p>`,
  }),
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(root, "assets"), join(dist, "assets"), { recursive: true });
for (const [href, html] of Object.entries(pages)) {
  const target = join(dist, href);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
}
console.log(`built ${Object.keys(pages).length} pages into web/dist`);
