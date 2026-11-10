// Error responses. HTML for browsers, JSON for API callers. Neither ever
// carries an RPC response body: only the short reasons the core collected.

export const KINDS = {
  rpc: { status: 502, title: "Every RPC endpoint failed" },
  no_account: { status: 404, title: "This account does not exist" },
  no_contract: { status: 404, title: "This account has no contract" },
  no_web4: { status: 404, title: "This contract does not serve pages" },
  panic: { status: 500, title: "The contract panicked" },
  body_url: { status: 502, title: "Could not fetch the file body" },
  bad_response: { status: 502, title: "The contract sent an unusable answer" },
  hops: { status: 502, title: "Too many preload hops" },
  preload: { status: 502, title: "A preload URL failed" },
  no_site: { status: 404, title: "No site on this host" },
  bad_request: { status: 400, title: "Bad request" },
  method: { status: 405, title: "Only GET and HEAD are served" },
};

export class GatewayError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    this.status = KINDS[kind]?.status ?? 502;
    this.attempts = extra.attempts ?? [];
    this.rpc = extra.rpc ?? null;
    this.url = extra.url ?? null;
    this.account = extra.account ?? null;
  }
}

function escapeHtml(text) {
  return String(text ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// Tokens follow web/assets/quay.css. System fonts only: the page makes no requests.
const STYLE = `:root{color-scheme:light dark;--bg:oklch(.985 .0015 250);--surface:#fff;--text:oklch(.2 .006 260);--text-2:oklch(.45 .01 260);--line:oklch(.22 .01 260/.09);--accent:oklch(.55 .19 27);--tint:oklch(.97 .02 25);--ink:oklch(.2 .006 260);--on-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:oklch(.145 .004 260);--surface:oklch(.18 .005 260);--text:oklch(.965 .002 260);--text-2:oklch(.74 .008 260);--line:oklch(.27 .006 260);--accent:oklch(.72 .16 25);--tint:oklch(.27 .06 25);--ink:oklch(.965 .002 260);--on-ink:oklch(.16 .004 260)}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:400 15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:560px;background:var(--surface);border-radius:16px;box-shadow:0 0 0 1px var(--line),0 24px 48px -16px oklch(.2 .02 260/.16);padding:28px}
.code{display:inline-flex;align-items:center;gap:8px;height:24px;padding:0 10px;border-radius:999px;background:var(--tint);color:var(--accent);font:500 12px/1 ui-monospace,"SF Mono",Menlo,monospace}
h1{font-size:20px;line-height:1.3;margin:14px 0 6px;font-weight:600;letter-spacing:-.01em}p{margin:0;color:var(--text-2)}
dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 16px;margin:20px 0 0;padding:16px 0 0;border-top:1px solid var(--line);font-size:13.5px}
dt{color:var(--text-2)}dd{margin:0;font-family:ui-monospace,"SF Mono",Menlo,monospace;overflow-wrap:anywhere}
ul{margin:0;padding:0;list-style:none;display:grid;gap:4px}
.links{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px}a{color:inherit}
.btn{display:inline-flex;align-items:center;height:34px;padding:0 14px;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px;box-shadow:inset 0 0 0 1px var(--line)}
.btn-primary{background:var(--ink);color:var(--on-ink);box-shadow:none}
footer{margin-top:22px;font-size:12.5px;color:var(--text-2)}`;

export function releaseOf(path) {
  const match = /^\/r\/([^/]+)(\/|$)/.exec(path || "");
  return match ? match[1] : null;
}

export function wantsJson(request, path) {
  if (path.startsWith("/api/") || path.startsWith("/web4/contract/"))
    return true;
  const accept = request.headers.get("accept") || "";
  if (!accept.includes("application/json")) return false;
  const html = accept.indexOf("text/html");
  return html === -1 || accept.indexOf("application/json") < html;
}

export function errorBody(error, { account, path }) {
  const kind = KINDS[error.kind] ? error.kind : "rpc";
  return {
    error: {
      kind,
      status: KINDS[kind].status,
      title: KINDS[kind].title,
      message: error.message,
      account: account ?? null,
      path,
      attempts: error.attempts?.length ? error.attempts : undefined,
      url: error.url ?? undefined,
    },
  };
}

export function errorHtml(error, { account, path }) {
  const kind = KINDS[error.kind] ? error.kind : "rpc";
  const { status, title } = KINDS[kind];
  const rows = [];
  if (account) rows.push(["Account", escapeHtml(account)]);
  rows.push(["Path", escapeHtml(path)]);
  if (error.url) rows.push(["Body URL", escapeHtml(error.url)]);
  if (error.attempts?.length)
    rows.push([
      "Tried",
      `<ul>${error.attempts.map((a) => `<li>${escapeHtml(a.rpc ?? a.url)}: ${escapeHtml(a.reason)}</li>`).join("")}</ul>`,
    ]);
  const release = releaseOf(path);
  const links = [
    `<a class="btn btn-primary" href="${escapeHtml(path)}">Try again</a>`,
  ];
  if (release && path !== `/r/${release}/`)
    links.push(
      `<a class="btn" href="/r/${escapeHtml(release)}/">Open release ${escapeHtml(release)}</a>`,
    );
  if (path !== "/") links.push(`<a class="btn" href="/">Production</a>`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${status} · ${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<span class="code">${status} · ${escapeHtml(kind)}</span>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(error.message)}</p>
<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
<div class="links">${links.join("")}</div>
<footer>Served by the Quay gateway. Health: <a href="/_quay/health">/_quay/health</a></footer>
</main>
</body>
</html>
`;
}
