// Quay dashboard. Reads a Quay contract over public RPC; changes go through a
// testnet wallet via near-connect. The page never holds a key.
// Tried in order; a network error, timeout, 429, 5xx, or a non-handler RPC
// error moves on. rpc.testnet.near.org is deprecated and not listed.
const RPCS = [
  "https://test.rpc.fastnear.com",
  "https://testnet-rpc.intea.rs",
  "https://near-testnet.drpc.org",
];
const GAS = "30000000000000";
const EXPLORER = "https://explorer.testnet.near.org/transactions/";
// The built page carries the icon sprite inline.
const SPRITE = "";
const TABS = [
  "canvas",
  "releases",
  "data",
  "functions",
  "routes",
  "keys",
  "history",
  "storage",
];
// web/hosts.json, inlined by web/build.mjs: { mirrors: {account: origin}, public: "https://{name}.testnet.page", local }.
const HOSTS = {};
// The account this product site is published on; a page loaded over http(s) is served by a gateway for it.
const PRODUCT = "quay-esc0v902.testnet";

const $ = (id) => document.getElementById(id);
const views = ["empty", "loading", "error", "ready"];

let connector = null;
let walletAccount = null;
let viewed = null;
let status = null;
let busy = null; // { action, id }
let lastRollback = null;

// ---------- small DOM helpers ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("data-")) el.setAttribute(k, v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(
      typeof child === "string" ? document.createTextNode(child) : child,
    );
  }
  return el;
}

function icon(name, small) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", small ? "icon sm" : "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `${SPRITE}#i-${name}`);
  svg.append(use);
  return svg;
}

function show(view) {
  for (const name of views) $(`view-${name}`).hidden = name !== view;
  $("tabs").hidden = view !== "ready";
  $("crumb").hidden = !viewed || view === "empty";
}

// ---------- formatting ----------
const nf = new Intl.NumberFormat("en-US");
function bytes(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? `${nf.format(n)} B` : String(value);
}
function nearFromBytes(n) {
  return `≈ ${(Number(n) / 100000).toFixed(n < 100000 ? 3 : 2)} NEAR`;
}
function nearFromYocto(yocto) {
  const whole = BigInt(yocto) / 10n ** 20n; // in 1e-4 NEAR
  return `${(Number(whole) / 10000).toFixed(4)} NEAR`;
}
const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
function when(ns, utc) {
  if (ns == null || BigInt(ns) === 0n) return "unknown";
  const date = new Date(Number(BigInt(ns) / 1_000_000n));
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${dateFmt.format(date)}${utc ? " UTC" : ""}`;
}
function iso(ns) {
  try {
    return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
  } catch {
    return "";
  }
}
// Where an account is served: this page's own origin when it is the product
// site (or the account's mirror), else the account's mirror, else testnet.page.
function publicOrigin(account) {
  return (HOSTS.public || "https://{name}.testnet.page").replace(
    "{name}",
    account.replace(/\.testnet$/, ""),
  );
}
function hostFor(account) {
  const mirror = HOSTS.mirrors?.[account];
  if (
    /^https?:$/.test(location.protocol) &&
    (account === PRODUCT || (mirror && location.origin === mirror))
  )
    return location.origin;
  return mirror || publicOrigin(account);
}
function host(account) {
  return new URL(hostFor(account)).host;
}
function preview(account, id) {
  return `${hostFor(account)}/${id ? `r/${id}/` : ""}`;
}
function accountFrom(raw) {
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (text.endsWith(".testnet.page"))
    return `${text.slice(0, -".testnet.page".length)}.testnet`;
  for (const [account, origin] of Object.entries(HOSTS.mirrors || {}))
    if (new URL(origin).host === text) return account;
  return text;
}

// ---------- RPC ----------
let rpcFirst = 0;
async function rpc(params) {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: "quay",
    method: "query",
    params: { finality: "final", ...params },
  });
  let last = "";
  for (let i = 0; i < RPCS.length; i += 1) {
    const index = (rpcFirst + i) % RPCS.length;
    let body;
    try {
      const response = await fetch(RPCS[index], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(8000),
      });
      body = await response.json().catch(() => null);
      if (body?.error?.name === "HANDLER_ERROR")
        throw Object.assign(
          new Error(body.error.data || body.error.message || "RPC error"),
          { final: true },
        );
      if (!response.ok || !body || body.error || !("result" in body)) {
        last = `${new URL(RPCS[index]).host} answered ${response.status}`;
        continue;
      }
    } catch (error) {
      if (error.final) throw error;
      last = `${new URL(RPCS[index]).host}: ${error.name === "TimeoutError" ? "no answer in 8 s" : "network error"}`;
      continue;
    }
    rpcFirst = index;
    return body.result;
  }
  throw new Error(`No RPC answered (${last}). Try again in a moment.`);
}
async function callView(account, method, args) {
  const result = await rpc({
    request_type: "call_function",
    account_id: account,
    method_name: method,
    args_base64: btoa(JSON.stringify(args ?? {})),
  });
  const raw = result?.result;
  if (!raw) return null;
  const text = new TextDecoder().decode(Uint8Array.from(raw));
  return text ? JSON.parse(text) : null;
}
async function listAll(account, method, field) {
  const rows = [];
  let from = 0;
  for (;;) {
    const page = await callView(account, method, {
      from_index: from,
      limit: 20,
    });
    rows.push(...(page?.[field] ?? []));
    if (page?.next == null) return rows;
    from = page.next;
  }
}

// ---------- public gateway health ----------
// One timed request to the viewed account's public host. A CORS read shows the
// status (and the deprecated-RPC body); without CORS, a no-cors request only
// tells reachable from unreachable.
let gateway = null;
let probing = null;
function probeGateway(account) {
  const origin = publicOrigin(account);
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const get = (mode) =>
    fetch(`${origin}/`, {
      mode,
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
  return get("cors")
    .then(async (res) => {
      if (res.ok) return { ok: true, ms: ms() };
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        ms: ms(),
        reason: /deprecated/i.test(text)
          ? `HTTP ${res.status}: it still calls the deprecated rpc.testnet.near.org`
          : `HTTP ${res.status}`,
      };
    })
    .catch(() =>
      get("no-cors")
        .then(() => ({ ok: true, ms: ms(), opaque: true }))
        .catch(() => ({ ok: false, ms: ms(), reason: "no answer in 5 s" })),
    );
}
function checkGateway(force) {
  const account = viewed;
  if (!account) return null;
  if (probing?.account === account) return probing.promise;
  if (
    !force &&
    gateway?.account === account &&
    Date.now() - gateway.at < 60_000
  )
    return gateway;
  const promise = probeGateway(account).then((result) => {
    gateway = { ...result, at: Date.now(), account };
    probing = null;
    if (viewed === account) renderGateway();
    return gateway;
  });
  probing = { account, promise };
  return promise;
}
function renderGateway() {
  const chip = $("gw-chip");
  const banner = $("gw-banner");
  const fresh = gateway?.account === viewed ? gateway : null;
  chip.hidden = !fresh;
  banner.hidden = !fresh || fresh.ok;
  if (!fresh) return;
  chip.className = gateway.ok ? "chip chip-live" : "chip chip-warn";
  chip.title = gateway.ok
    ? "testnet.page answered"
    : `testnet.page: ${gateway.reason}`;
  chip.replaceChildren(
    h("span", { class: gateway.ok ? "dot dot-live" : "dot" }),
    gateway.ok
      ? `testnet.page ${gateway.opaque ? "reachable" : "up"} · ${gateway.ms} ms`
      : "testnet.page down",
  );
  const command = `quay gateway --account ${viewed || "<name>.testnet"}`;
  $("gw-copy").dataset.copy = command;
  $("gw-text").replaceChildren(
    `The public testnet.page gateway is down (${gateway.reason}). ${HOSTS.mirrors?.[viewed] ? "Links use the mirror, which is a separate host. " : "The preview and production links may not load. "}This page still reads the chain directly. To see the site locally, run `,
    h("code", { text: command }),
    " and open ",
    h("a", { href: "http://127.0.0.1:8787/", text: "127.0.0.1:8787" }),
    ".",
  );
}
// A failed image, script, stylesheet, or frame re-checks the gateway.
addEventListener(
  "error",
  (event) => {
    const tag = event.target?.tagName;
    if (["IMG", "SCRIPT", "LINK", "IFRAME"].includes(tag)) checkGateway(true);
  },
  true,
);

// ---------- rendering ----------
function isOwner() {
  return Boolean(walletAccount && viewed && walletAccount === viewed);
}

function setNotice() {
  const box = $("notice");
  const text = $("notice-text");
  const action = $("notice-action");
  action.replaceChildren();
  box.className = "notice";
  box.querySelector(".icon use").setAttribute("href", `${SPRITE}#i-lock`);
  if (lastRollback && lastRollback.account === viewed) {
    box.className = "notice notice-warn";
    box.querySelector(".icon use").setAttribute("href", `${SPRITE}#i-alert`);
    text.textContent = `Rolled back to ${lastRollback.to}. Release ${lastRollback.from} is now previous.`;
    if (isOwner())
      action.append(
        h("button", {
          class: "btn btn-sm",
          type: "button",
          "data-action": "rollback",
          "data-undo": "1",
          text: "Undo",
        }),
      );
    box.hidden = false;
    return;
  }
  if (isOwner()) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (walletAccount) {
    text.textContent = `Signed in as ${walletAccount}. Only ${viewed} can change its production.`;
  } else {
    text.textContent = `Read only. Sign in as ${viewed} to promote, roll back or delete.`;
    action.append(
      h(
        "button",
        { class: "btn btn-sm btn-primary", type: "button", "data-signin": "1" },
        icon("wallet", true),
        "Sign in",
      ),
    );
  }
}

function actionButton(label, action, id, iconName) {
  const owner = isOwner();
  const pending = busy && busy.action === action && busy.id === id;
  return h(
    "button",
    {
      class: "btn btn-sm",
      type: "button",
      "data-action": action,
      "data-id": id,
      disabled: !owner || Boolean(busy),
      title: owner ? null : `Sign in as ${viewed} to ${action}`,
    },
    pending ? null : icon(iconName, true),
    pending ? "Waiting…" : label,
  );
}

function releaseRow(release) {
  const id = release.id;
  const isProd = id === status.production;
  const isPrev = id === status.previous;
  const pending = busy && busy.id === id;
  const chips = [];
  if (isProd)
    chips.push(h("span", { class: "chip chip-live", text: "Production" }));
  if (isPrev)
    chips.push(h("span", { class: "chip chip-prev", text: "Previous" }));
  if (pending)
    chips.push(
      h("span", {
        class: "chip chip-info",
        text: busy.action === "delete" ? "Deleting" : "Promoting",
      }),
    );
  const menuItems = [
    h("a", { href: preview(viewed, id) }, icon("ext", true), "Open preview"),
  ];
  if (!isProd)
    menuItems.push(
      h(
        "button",
        {
          type: "button",
          class: "danger",
          "data-action": "delete",
          "data-id": id,
          disabled: !isOwner() || Boolean(busy),
        },
        icon("trash", true),
        "Delete release",
      ),
    );
  const menu = h(
    "details",
    { class: "menu" },
    h(
      "summary",
      {
        class: "btn btn-sm btn-quiet btn-icon",
        "aria-label": `More for release ${id}`,
      },
      icon("more"),
    ),
    h("div", { class: "menu-list" }, menuItems),
  );
  return h(
    "li",
    { class: `rel-row${isProd ? " is-live" : ""}${pending ? " is-busy" : ""}` },
    h(
      "div",
      null,
      h("div", { class: "l1" }, h("span", { class: "id", text: id }), chips),
      h(
        "div",
        { class: "l2" },
        h("span", {
          text: pending
            ? "Approve the transaction in your wallet."
            : release.message || "No message",
        }),
      ),
    ),
    h(
      "div",
      { class: "c-status" },
      h(
        "div",
        { class: "l1 n" },
        h("span", { class: isProd ? "dot dot-live" : "dot" }),
        isProd ? "Live" : "Sealed",
      ),
      h("div", {
        class: "l2 num",
        text: `${release.file_count} files, ${bytes(release.bytes)}`,
      }),
    ),
    h(
      "div",
      { class: "c-msg" },
      h(
        "div",
        { class: "l1 n" },
        icon("globe", true),
        h("a", { class: "mono", href: preview(viewed, id), text: `/r/${id}/` }),
      ),
      h(
        "div",
        { class: "l2" },
        icon("box", true),
        h("span", { class: "mono", text: (release.sha256 || "").slice(0, 8) }),
        release.spa ? h("span", { text: "SPA" }) : null,
      ),
    ),
    h("div", {
      class: "when c-when",
      title: iso(release.timestamp),
      text: when(release.timestamp),
    }),
    h(
      "div",
      { class: "acts" },
      isProd
        ? h("a", { class: "btn btn-sm", href: preview(viewed), text: "Visit" })
        : actionButton("Promote", "promote", id, "up"),
      menu,
    ),
  );
}

function historyItem(entry, byId) {
  const up = entry.kind !== "rollback";
  const msg = byId.get(entry.release_id)?.message;
  const detail = up
    ? `${msg ? `${msg}, ` : ""}${entry.previous_id ? `previous ${entry.previous_id}` : "first production"}`
    : `from ${entry.previous_id}`;
  return h(
    "li",
    null,
    h(
      "span",
      { class: up ? "ti up" : "ti back" },
      icon(up ? "up" : "undo", true),
    ),
    h(
      "span",
      { class: "what" },
      h("b", {
        text: up
          ? `Promoted release ${entry.release_id}`
          : `Rolled back to release ${entry.release_id}`,
      }),
      " ",
      h("span", { class: "muted", text: detail }),
    ),
    h("span", {
      class: "when",
      title: iso(entry.timestamp),
      text: when(entry.timestamp),
    }),
  );
}

function keyItem(key, account) {
  const perm = key.access_key.permission;
  const short = `${key.public_key.slice(0, 16)}…`;
  if (perm === "FullAccess")
    return h(
      "li",
      null,
      icon("key"),
      h(
        "div",
        null,
        h("div", { class: "kn", text: "Full access" }),
        h("div", { class: "kd", text: short }),
      ),
      h("span", { class: "chip chip-outline", text: "Owner" }),
    );
  const fc = perm.FunctionCall || {};
  const methods = fc.method_names?.length
    ? fc.method_names.join(", ")
    : "any method";
  const publishOnly =
    fc.receiver_id === account &&
    fc.method_names?.length === 2 &&
    fc.method_names.includes("put_chunk") &&
    fc.method_names.includes("seal");
  return h(
    "li",
    null,
    icon("key"),
    h(
      "div",
      null,
      h("div", {
        class: "kn",
        text: publishOnly ? "Publish-only" : "Function call",
      }),
      h("div", { class: "kd", text: methods }),
    ),
    h("span", { class: "chip", text: publishOnly ? "CI" : short.slice(8, 14) }),
  );
}

let data = null;
function render() {
  // wallet
  $("sign-in").hidden = Boolean(walletAccount);
  $("wallet-menu").hidden = !walletAccount;
  $("wallet-name").textContent = walletAccount || "";
  if (!data) return;
  const { account, releases, history, keys, acct } = data;
  status = data.status;
  const byId = new Map(releases.map((r) => [r.id, r]));
  const prod = byId.get(status.production);
  const prev = byId.get(status.previous);

  $("crumb-name").textContent = account;
  $("acct-title").textContent = account;
  $("contract-chip").textContent = `Contract ${status.version}`;
  $("host-text").textContent = host(account);
  $("host-link").href = preview(account);
  const pub = publicOrigin(account);
  $("host-public").hidden = pub === hostFor(account);
  $("host-public").href = `${pub}/`;
  $("host-public").querySelector("span").textContent = new URL(pub).host;
  $("visit-prod").href = preview(account);
  $("copy-host").dataset.copy = `${hostFor(account)}/`;
  renderGateway();

  // production card
  const frame = $("prod-preview");
  frame.href = preview(account);
  const src = preview(account);
  if (prod && frame.dataset.src !== src) {
    frame.dataset.src = src;
    frame.replaceChildren(
      h("iframe", {
        src,
        title: `Production of ${account}`,
        sandbox: "allow-scripts allow-same-origin",
        tabindex: "-1",
        "aria-hidden": "true",
      }),
    );
  }
  if (!prod)
    frame.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("span", { class: "ic" }, icon("box")),
        h("p", { text: "Nothing is in production yet." }),
      ),
    );
  $("prod-chip").hidden = !prod;
  $("prod-name").textContent = prod
    ? `Release ${prod.id}`
    : "No production release";
  $("prod-msg").textContent = prod?.message || "";
  const url = $("prod-url");
  url.href = preview(account);
  url.querySelector("span").textContent = host(account);
  const lastPromote = [...history]
    .reverse()
    .find((e) => e.release_id === status.production);
  $("f-promoted").textContent = lastPromote
    ? when(lastPromote.timestamp, true)
    : "never";
  $("f-size").textContent = prod
    ? `${prod.file_count} files, ${bytes(prod.bytes)}`
    : "none";
  const fp = $("f-preview");
  fp.textContent = prod ? `/r/${prod.id}/` : "none";
  fp.href = prod ? preview(account, prod.id) : "#";
  $("f-hash").textContent = prod?.sha256
    ? `${prod.sha256.slice(0, 8)}…${prod.sha256.slice(-4)}`
    : "none";
  $("f-hash").title = prod?.sha256 || "";
  $("f-spa").textContent = prod
    ? prod.spa
      ? "index.html (SPA)"
      : "404.html"
    : "none";
  $("f-count").textContent = String(releases.length);
  $("prev-row").hidden = !prev;
  if (prev) {
    $("prev-text").replaceChildren(
      "Previous: ",
      h("b", { text: `release ${prev.id}` }),
      `${prev.message ? `, ${prev.message}` : ""}. A rollback lands here.`,
    );
    $("prev-link").textContent = `/r/${prev.id}/`;
    $("prev-link").href = preview(account, prev.id);
  }
  const rb = $("rollback");
  const rbPending = busy?.action === "rollback";
  rb.disabled = !isOwner() || !status.previous || Boolean(busy);
  rb.title = isOwner()
    ? status.previous
      ? ""
      : "There is no previous release"
    : `Sign in as ${account} to roll back`;
  rb.querySelector("span").textContent = rbPending
    ? "Waiting for the wallet…"
    : status.previous
      ? `Roll back to ${status.previous}`
      : "Roll back";

  // storage
  const stored = Number(status.stored_bytes);
  const max = Number(status.max_bytes);
  const pct = max ? (stored / max) * 100 : 0;
  $("st-bytes").textContent = nf.format(stored);
  $("st-max").textContent = `of ${nf.format(max)} bytes`;
  $("st-chip").querySelector("span").textContent =
    `${pct < 1 ? pct.toFixed(1) : Math.round(pct)}% used`;
  $("st-meter").firstElementChild.style.width = `${Math.max(pct, 0.4)}%`;
  $("st-meter").setAttribute(
    "aria-label",
    `${nf.format(stored)} of ${nf.format(max)} bytes stored`,
  );
  $("st-lock").textContent = nearFromBytes(stored);
  $("st-account").textContent = acct
    ? `${nf.format(acct.storage_usage)} B, ${nearFromBytes(acct.storage_usage)}`
    : "unknown";
  $("st-balance").textContent = acct ? nearFromYocto(acct.amount) : "unknown";

  $("keys").replaceChildren(
    ...(keys.length
      ? keys.map((k) => keyItem(k, account))
      : [
          h(
            "li",
            null,
            h("span", { class: "muted", text: "No keys returned." }),
          ),
        ]),
  );

  // releases and history
  const sorted = [...releases].sort((a, b) => Number(b.id) - Number(a.id));
  $("rel-count").textContent = String(releases.length);
  $("releases").replaceChildren(
    ...(sorted.length
      ? sorted.map(releaseRow)
      : [
          h(
            "li",
            { class: "empty" },
            h("span", { class: "ic" }, icon("box")),
            h("b", { text: "Nothing sealed on this account yet" }),
            h("p", {
              text: "Run a deploy from your project folder. The first release gets its own URL, and you can promote it from here.",
            }),
            h("span", { class: "cmd", text: "$ quay deploy ./dist" }),
          ),
        ]),
  );
  const newest = [...history].reverse();
  $("history").replaceChildren(
    ...(newest.length
      ? newest.map((e) => historyItem(e, byId))
      : [
          h(
            "li",
            { class: "empty", style: "display:grid" },
            h("p", {
              text: "No promotions yet. Run quay promote <id> or use Promote above.",
            }),
          ),
        ]),
  );
  setNotice();
  applyTab();
  if (canvasData?.account === account) drawCanvas();
}

function currentTab() {
  const tab = new URL(location.href).searchParams.get("tab");
  return TABS.includes(tab) ? tab : "canvas";
}
function applyTab() {
  const tab = currentTab();
  const ready = $("view-ready");
  ready.dataset.tab = tab;
  $("content").dataset.tab = tab;
  for (const el of ready.querySelectorAll("[data-in]"))
    el.hidden = !el.dataset.in.split(" ").includes(tab);
  for (const a of $("tabs").querySelectorAll("a")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    const url = new URL(location.href);
    url.searchParams.set("tab", a.dataset.tab);
    a.href = url.search;
  }
  // The status module loads only for the views that show it.
  if (tab === "keys" && layersFor !== viewed) loadLayers();
  if (tab === "canvas") ensureCanvas();
  else closePanel(true);
  ensureTab(tab);
}

// ---------- full-stack views ----------
// Every read goes straight to RPC. A method the contract does not have means
// the layer is off (a contract before v3), not an error.
const OFF_TEXT =
  "This contract is before v3, so this layer is off. A new account from quay init has it.";
let tabState = {};
let layersFor = null;
let layersP = null;
let statusP = null;

async function viewOpt(account, method, args) {
  const res = await rpc({
    request_type: "call_function",
    account_id: account,
    method_name: method,
    args_base64: btoa(JSON.stringify(args ?? {})),
  });
  if (res?.error) {
    if (
      /MethodNotFound|MethodResolveError|CodeDoesNotExist|not deployed/i.test(
        res.error,
      )
    )
      return undefined;
    throw new Error(res.error);
  }
  const text = new TextDecoder().decode(Uint8Array.from(res?.result ?? []));
  return text ? JSON.parse(text) : null;
}
function rows(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (key && Array.isArray(value[key])) return value[key];
    return Object.entries(value).map(([name, spec]) => ({ name, ...spec }));
  }
  return [];
}
function short(value, max) {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
function samplePath(route, ids) {
  const first = ids[route.collection];
  const path = route.pattern
    .replace(/:([A-Za-z_]\w*)/g, (_, name) =>
      name === "collection"
        ? route.collection === "*"
          ? "posts"
          : route.collection
        : first || "1",
    )
    .replace(/\/?\*\w*$/, "/");
  return path || "/";
}

function card(title, note, ...body) {
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("h2", { text: title }),
      note
        ? h("span", { class: "muted", style: "font-size:12.5px", text: note })
        : null,
    ),
    body,
  );
}
function skeleton(lines = 3) {
  return h(
    "div",
    { class: "card", "aria-busy": "true" },
    h(
      "div",
      { style: "display:grid;gap:14px;padding:18px 16px" },
      Array.from({ length: lines }, (_, i) =>
        h("div", { class: "skel", style: `width:${92 - i * 14}%` }),
      ),
    ),
  );
}
function stateBox(kind, title, text, cmd) {
  return h(
    "div",
    { class: "empty" },
    h("span", { class: "ic" }, icon(kind === "off" ? "lock" : "db")),
    h("b", { text: title }),
    h("p", { text }),
    cmd ? h("span", { class: "cmd", text: `$ ${cmd}` }) : null,
  );
}
function offCard(title, how) {
  return card(
    title,
    "off",
    stateBox("off", `${title} is off`, `${OFF_TEXT} ${how || ""}`.trim()),
  );
}
function errorBox(error, retry) {
  return h(
    "div",
    { class: "card err-card", role: "alert" },
    icon("alert"),
    h(
      "div",
      null,
      h("h2", { style: "font-size:15px", text: "Could not read this view" }),
      h("p", {
        class: "muted",
        style: "font-size:13.5px;margin-top:4px",
        text: String(error?.message || error),
      }),
      h("button", {
        class: "btn btn-sm",
        type: "button",
        style: "margin-top:12px",
        onclick: retry,
        text: "Try again",
      }),
    ),
  );
}
function table(head, body) {
  return h(
    "div",
    { class: "tbl-wrap" },
    h(
      "table",
      { class: "tbl" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          head.map((t) => h("th", { text: t })),
        ),
      ),
      h(
        "tbody",
        null,
        body.map((cells) =>
          h(
            "tr",
            null,
            cells.map((c) => h("td", null, c)),
          ),
        ),
      ),
    ),
  );
}
const chip = (text, kind) =>
  h("span", { class: `chip${kind ? ` chip-${kind}` : ""}`, text });
const mono = (text) => h("span", { class: "mono", text });
const link = (href, text) =>
  h("a", { class: "link", href, text, target: "_blank", rel: "noopener" });
const price = (p) =>
  [
    p.price_yocto ? nearFromYocto(p.price_yocto) : null,
    p.price_token ? `${p.price_token} token units` : null,
  ]
    .filter(Boolean)
    .join(" or ") || "free";

// ----- status API and the Layers strip -----
function statusModule() {
  statusP ??= import("./status.js");
  return statusP;
}
function relayOption() {
  return new URL(location.href).searchParams.get("relay") || undefined;
}
// window.quay.status(account, options) is the layer status API of
// docs/fullstack-interface.md section 11, for pages and canvases that embed this.
async function layerStatus(account, options = {}) {
  const { layerStatus: measure } = await statusModule();
  const mirror = HOSTS.mirrors?.[account];
  return measure({
    site: account,
    rpc: (params) => rpc(params),
    mirror,
    relay: relayOption(),
    ...options,
  });
}
window.quay = { status: layerStatus, hostFor };

const LAYER_NAMES = {
  site: "Site",
  gateway: "Gateway",
  data: "Data",
  functions: "Functions",
  routes: "Routes",
  relay: "Relay",
  cron: "Cron",
  keys: "Keys",
};
function layerRow(name, layer) {
  const dot = {
    ok: "dot dot-live",
    warn: "dot dot-warn",
    down: "dot dot-down",
  }[layer?.state];
  const first = layer?.links?.[0];
  return h(
    "li",
    { "data-state": layer?.state || "loading" },
    h("span", { class: dot || "dot", title: layer?.state || "reading" }),
    h("span", { class: "nm", text: LAYER_NAMES[name] }),
    h(
      "span",
      { class: "sm" },
      layer
        ? layer.summary
        : h("span", { class: "skel", style: "display:block;width:60%" }),
      layer?.error && layer.state !== "ok" && layer.state !== "off"
        ? h("span", { class: "faint", text: ` ${layer.error}` })
        : null,
    ),
    first
      ? h("a", {
          class: "link",
          href: first.href,
          target: "_blank",
          rel: "noopener",
          text: first.label,
        })
      : h("span", { class: "chip", text: layer ? layer.state : "reading" }),
  );
}
function loadLayers() {
  const account = viewed;
  layersFor = account;
  $("layers").replaceChildren(
    ...Object.keys(LAYER_NAMES).map((name) => layerRow(name)),
  );
  $("layers-note").textContent = "reading";
  layersP = layerStatus(account)
    .then((result) => {
      if (viewed !== account) return null;
      $("layers").replaceChildren(
        ...Object.keys(LAYER_NAMES).map((name) =>
          layerRow(name, result.layers[name]),
        ),
      );
      $("layers-note").textContent =
        `measured ${result.measured_at.slice(11, 16)} UTC`;
      return result;
    })
    .catch((error) => {
      if (viewed !== account) return null;
      $("layers").replaceChildren(
        h(
          "li",
          null,
          h("span", { class: "dot dot-down" }),
          h("span", { class: "nm", text: "Status" }),
          h("span", { class: "sm", text: String(error?.message || error) }),
          h("button", {
            class: "btn btn-sm",
            type: "button",
            onclick: loadLayers,
            text: "Try again",
          }),
        ),
      );
      $("layers-note").textContent = "failed";
      return null;
    });
}

// ----- tabs -----
async function loadDataTab(account, box) {
  const list = await viewOpt(account, "list_collections");
  if (list === undefined) return box.replaceChildren(offCard("Data"));
  const cols = rows(list);
  const pool = (await viewOpt(account, "get_pool")) ?? {
    balance: "0",
    reserved: "0",
  };
  const poolCard = card(
    "Storage pool",
    "pays for site-paid docs",
    h(
      "div",
      { class: "card-body" },
      h(
        "dl",
        { class: "kv" },
        h("dt", { text: "Available" }),
        h("dd", { class: "num", text: nearFromYocto(pool.balance) }),
        h("dt", { text: "Held by docs" }),
        h("dd", { class: "num", text: nearFromYocto(pool.reserved) }),
        h("dt", { text: "Add NEAR" }),
        h("dd", { class: "mono", text: "quay db fund 1" }),
      ),
    ),
  );
  if (!cols.length)
    return box.replaceChildren(
      card(
        "Collections",
        null,
        stateBox(
          "empty",
          "No collections yet",
          "A collection holds JSON docs that members or visitors can add.",
          "quay db collection set posts --write members",
        ),
      ),
      poolCard,
    );
  const browse = { name: cols[0].name, from: null, stack: [] };
  const docsBox = h("div", null);
  const colsBox = h("div", null);
  const select = (name) => {
    browse.name = name;
    browse.from = null;
    browse.stack = [];
    drawCollections();
    drawDocs();
  };
  function drawCollections() {
    colsBox.replaceChildren(
      card(
        "Collections",
        `${cols.length} of 32`,
        table(
          ["Name", "Write", "Payer", "Docs", "Bytes", "Rules"],
          cols.map((c) => [
            h("button", {
              class: `btn btn-sm${c.name === browse.name ? "" : " btn-quiet"}`,
              type: "button",
              "aria-pressed": String(c.name === browse.name),
              onclick: () => select(c.name),
              text: c.name,
            }),
            c.write,
            c.payer,
            h("span", { class: "num", text: nf.format(Number(c.count)) }),
            h("span", { class: "num", text: nf.format(Number(c.bytes)) }),
            h(
              "span",
              { class: "chips" },
              c.moderated ? chip("moderated") : null,
              c.on_add ? chip(`on_add ${c.on_add}`, "info") : null,
              c.max_docs_per_account
                ? chip(`${c.max_docs_per_account}/account`)
                : null,
            ),
          ]),
        ),
      ),
    );
  }
  async function drawDocs() {
    const col = cols.find((c) => c.name === browse.name);
    docsBox.replaceChildren(skeleton(4));
    try {
      const page = await viewOpt(account, "db_list", {
        collection: browse.name,
        query: {
          limit: 10,
          order: "desc",
          include_hidden: true,
          ...(browse.from ? { from: browse.from } : {}),
        },
      });
      if (viewed !== account || browse.name !== col.name) return;
      const docs = page?.docs ?? [];
      const body = docs.length
        ? table(
            col.moderated
              ? ["Id", "Owner", "Data", "Added", "", ""]
              : ["Id", "Owner", "Data", "Added", ""],
            docs.map((d) => [
              mono(d.id),
              mono(d.owner),
              h("span", {
                class: "mono",
                title: JSON.stringify(d.data),
                text: short(d.data, 90),
              }),
              h("span", {
                class: "when",
                title: iso(d.created),
                text: when(d.created),
              }),
              h(
                "span",
                { class: "chips" },
                d.hidden ? chip("hidden", "warn") : null,
                d.pinned_until ? chip("pinned", "info") : null,
                d.fn ? chip("fn", "outline") : null,
              ),
              ...(col.moderated
                ? [
                    h(
                      "button",
                      {
                        class: "btn btn-sm",
                        type: "button",
                        disabled: !isOwner() || Boolean(busy),
                        title: isOwner()
                          ? null
                          : `Sign in as ${viewed} to moderate`,
                        onclick: () => hideDoc(col.name, d, drawDocs),
                      },
                      d.hidden ? "Unhide" : "Hide",
                    ),
                  ]
                : []),
            ]),
          )
        : stateBox(
            "empty",
            `${browse.name} has no docs`,
            "Docs added by members or visitors show up here.",
            `quay db add ${browse.name} '{"title":"First"}'`,
          );
      docsBox.replaceChildren(
        card(
          `Documents in ${browse.name}`,
          "newest first, hidden included",
          body,
          h(
            "div",
            { class: "tbl-pager" },
            h("button", {
              class: "btn btn-sm",
              type: "button",
              disabled: !browse.stack.length,
              text: "Newer",
              onclick: () => {
                browse.from = browse.stack.pop() ?? null;
                drawDocs();
              },
            }),
            h("button", {
              class: "btn btn-sm",
              type: "button",
              disabled: page?.next == null,
              text: "Older",
              onclick: () => {
                browse.stack.push(browse.from);
                browse.from = page.next;
                drawDocs();
              },
            }),
          ),
        ),
      );
    } catch (error) {
      docsBox.replaceChildren(errorBox(error, drawDocs));
    }
  }
  drawCollections();
  box.replaceChildren(colsBox, docsBox, poolCard);
  drawDocs();
}

async function hideDoc(collection, doc, refresh) {
  if (!isOwner() || busy) return;
  const hidden = !doc.hidden;
  const verb = hidden ? "Hide" : "Unhide";
  if (
    !(await ask(
      `${verb} doc ${doc.id}?`,
      hidden
        ? `It leaves lists and routes of ${collection} until you unhide it. Its data stays on chain.`
        : `It shows in lists and routes of ${collection} again.`,
      verb,
    ))
  )
    return;
  busy = { action: "hide", id: doc.id };
  try {
    const wallet = await connector.wallet();
    const result = await wallet.signAndSendTransaction({
      signerId: walletAccount,
      receiverId: viewed,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "db_hide",
            args: { collection, id: doc.id, hidden },
            gas: GAS,
            deposit: "1",
          },
        },
      ],
    });
    busy = null;
    await refresh();
    const hash = txHash(result);
    toast(
      "ok",
      `${verb === "Hide" ? "Hid" : "Unhid"} doc ${doc.id}`,
      null,
      hash ? EXPLORER + hash : null,
    );
  } catch (error) {
    busy = null;
    await refresh();
    toast(
      "bad",
      "The wallet did not send it",
      error?.message || "The request was closed.",
    );
  }
}

async function loadFunctionsTab(account, box) {
  const [fl, cs] = await Promise.all([
    viewOpt(account, "fn_list"),
    viewOpt(account, "cron_status"),
  ]);
  if (fl === undefined && cs === undefined)
    return box.replaceChildren(offCard("Functions"), offCard("Cron"));
  const cards = [];
  if (fl === undefined) cards.push(offCard("Functions"));
  else {
    const fns = rows(fl);
    cards.push(
      card(
        "Registered functions",
        `${fns.length} of 16`,
        fns.length
          ? table(
              ["Name", "Project", "Who calls", "Payer", "Per run", "Secrets"],
              fns.map((f) => [
                mono(f.name),
                mono(f.project || ""),
                f.call,
                f.payer,
                f.deposit ? nearFromYocto(f.deposit) : "0",
                f.secrets ? "yes" : "no",
              ]),
            )
          : stateBox(
              "empty",
              "No functions yet",
              "A function is a Rust wasm that runs on OutLayer when a visitor or a trigger calls it.",
              "quay functions deploy preview",
            ),
      ),
    );
    let page = null;
    try {
      page = await viewOpt(account, "fn_results", {
        query: { limit: 10, order: "desc" },
      });
      if (page === undefined)
        page = await viewOpt(account, "db_list", {
          collection: "_fn",
          query: { limit: 10, order: "desc" },
        });
    } catch {
      page = null;
    }
    const runs = rows(page, "docs");
    cards.push(
      card(
        "Recent runs",
        "newest first",
        runs.length
          ? table(
              ["Run", "Result", "Output", "When"],
              runs.map((d) => {
                const r = d.data ?? d;
                const out = r.output;
                const att =
                  out && typeof out === "object"
                    ? out.attestation_url || out.attestation
                    : null;
                return [
                  h(
                    "div",
                    null,
                    mono(d.id || r.name || ""),
                    h("div", {
                      class: "faint",
                      style: "font-size:12px",
                      text: r.caller || "",
                    }),
                  ),
                  r.ok === false ? chip("failed", "warn") : chip("ok", "live"),
                  h(
                    "details",
                    null,
                    h("summary", {
                      class: "mono",
                      text: short(out ?? "", 60) || "empty",
                    }),
                    h("pre", {
                      class: "mono out",
                      text: short(
                        typeof out === "string"
                          ? out
                          : JSON.stringify(out, null, 1),
                        2000,
                      ),
                    }),
                    typeof att === "string" && /^https:/.test(att)
                      ? link(att, "Attestation")
                      : null,
                  ),
                  h("span", {
                    class: "when",
                    title: iso(r.at ?? d.created),
                    text: when(r.at ?? d.created),
                  }),
                ];
              }),
            )
          : stateBox(
              "empty",
              "No runs yet",
              "Results appear after the first call or trigger.",
              "quay functions invoke preview '{}'",
            ),
      ),
    );
  }
  if (cs === undefined) cards.push(offCard("Cron"));
  else {
    const jobs = rows(await viewOpt(account, "cron_list"), "jobs");
    cards.push(
      card(
        "Scheduled jobs",
        cs?.armed ? "chain armed" : "chain stopped",
        h(
          "div",
          { class: "card-body chips" },
          chip(cs?.armed ? "Armed" : "Stopped", cs?.armed ? "live" : "warn"),
          chip(`${cs?.hops ?? 0} hops`),
          chip(
            cs?.last_tick && cs.last_tick !== "0"
              ? `last tick ${when(cs.last_tick, true)}`
              : "no tick yet",
          ),
        ),
        jobs.length
          ? table(
              ["Job", "Every", "Function", "Last run", "Next due"],
              jobs.map((j) => [
                mono(j.name),
                `${j.every_minutes} min`,
                mono(j.fn),
                j.last_run ? when(j.last_run) : "never",
                j.next_due ? when(j.next_due) : "unknown",
              ]),
            )
          : stateBox(
              "empty",
              "No scheduled jobs",
              "A job runs a function every few minutes while the chain is armed. One arm of 1 PGas lasts about 15 hours with no jobs and about 6 with one hourly job.",
              'quay cron add "every 30m" digest',
            ),
      ),
    );
  }
  box.replaceChildren(...cards);
}

async function loadRoutesTab(account, box) {
  const prodId = data.status.production;
  if (!prodId)
    return box.replaceChildren(
      card(
        "Routes",
        null,
        stateBox(
          "empty",
          "Nothing is in production",
          "Routes come with a release.",
          "quay up",
        ),
      ),
    );
  const rel = await viewOpt(account, "get_release", { id: prodId });
  if (rel === undefined) return box.replaceChildren(offCard("Routes"));
  const routes = rel?.routes ?? [];
  if (!routes.length)
    return box.replaceChildren(
      card(
        "Routes",
        `release ${prodId}`,
        stateBox(
          "empty",
          "This release has no routes",
          "Routes turn db docs into pages and JSON. They are sealed with the release and roll back with it.",
          'add "routes" to quay.json, then quay up',
        ),
      ),
    );
  const files = new Set((rel.files ?? []).map((f) => f.path));
  // One real doc id per collection, so a sample link opens a page that exists.
  const ids = {};
  await Promise.all(
    [
      ...new Set(routes.map((r) => r.collection).filter((c) => c && c !== "*")),
    ].map(async (c) => {
      try {
        const page = await viewOpt(account, "db_list", {
          collection: c,
          query: { limit: 1, order: "desc" },
        });
        ids[c] = page?.docs?.[0]?.id;
      } catch {}
    }),
  );
  box.replaceChildren(
    card(
      "Routes",
      `release ${prodId}, ${routes.length} of 16`,
      table(
        ["Pattern", "Kind", "Collection", "Template", "Sample"],
        routes.map((r) => {
          const path = samplePath(r, ids);
          return [
            mono(r.pattern),
            chip(r.kind, r.kind === "json" ? "info" : null),
            mono(r.collection),
            r.template
              ? h(
                  "span",
                  null,
                  mono(r.template),
                  files.has(r.template) ? null : chip("missing", "warn"),
                )
              : "none",
            h("a", {
              class: "link mono",
              href: `${hostFor(account)}${path}`,
              target: "_blank",
              rel: "noopener",
              text: path,
            }),
          ];
        }),
      ),
    ),
    h("p", {
      class: "muted note",
      style: "font-size:13px",
      text: "Routes are checked before files, in this order. Docs and rules are live state; routes and templates roll back with the release.",
    }),
  );
}

async function loadKeysTab(account, box) {
  const [open, members, products, receipts] = await Promise.all([
    viewOpt(account, "get_members_open"),
    viewOpt(account, "list_members", { from_index: 0, limit: 50 }),
    viewOpt(account, "list_products"),
    viewOpt(account, "list_receipts", { query: { limit: 10, order: "desc" } }),
  ]);
  const cards = [
    card(
      "Access keys",
      "read from chain",
      h(
        "ul",
        { class: "keys" },
        data.keys.map((k) => keyItem(k, account)),
      ),
    ),
  ];
  if (members === undefined) cards.push(offCard("Members"));
  else {
    const list = members?.members ?? [];
    cards.push(
      card(
        "Members",
        `${members?.next != null ? "50+" : list.length} · ${open === false ? "closed" : "open to anyone"}`,
        list.length
          ? h(
              "ul",
              { class: "keys" },
              list
                .slice(0, 10)
                .map((m) =>
                  h(
                    "li",
                    null,
                    icon("key"),
                    h("div", { class: "kd", text: m }),
                    h("span"),
                  ),
                ),
              list.length > 10 || members.next != null
                ? h(
                    "li",
                    null,
                    h("span"),
                    h("div", {
                      class: "muted",
                      text: `${members.next != null ? "At least " : ""}${list.length} members; the first 10 are shown.`,
                    }),
                    h("span"),
                  )
                : null,
            )
          : stateBox(
              "empty",
              "No members yet",
              "A member is an account <name>.<site> made by join, with no NEAR needed.",
              "quay members list",
            ),
      ),
    );
  }
  // relay health comes from the shared status read
  const relayBox = h("div", null, skeleton(2));
  cards.push(relayBox);
  if (products === undefined) cards.push(offCard("Payments"));
  else {
    const list = rows(products);
    cards.push(
      card(
        "Products",
        `${list.length} of 32`,
        list.length
          ? table(
              ["Id", "Name", "Price", "Grant"],
              list.map((p) => [
                mono(p.id || p.name),
                p.name,
                price(p),
                p.grant === "pin"
                  ? `pin ${Math.round((p.pin_seconds || 0) / 3600)} h`
                  : p.grant,
              ]),
            )
          : stateBox(
              "empty",
              "No products yet",
              "A product sells a pin or a receipt for NEAR or a token.",
              "quay products set pin",
            ),
      ),
    );
    const recs = rows(receipts, "receipts");
    cards.push(
      card(
        "Recent receipts",
        "newest first",
        recs.length
          ? table(
              ["Buyer", "Product", "Ref", "Amount", "When"],
              recs.map((x) => {
                const r = x.data ?? x;
                return [
                  mono(r.buyer || ""),
                  r.product,
                  mono(r.ref || ""),
                  r.token && r.token !== "near"
                    ? `${r.amount} of ${r.token}`
                    : r.amount
                      ? nearFromYocto(r.amount)
                      : "",
                  when(r.at ?? x.created),
                ];
              }),
            )
          : stateBox(
              "empty",
              "No receipts yet",
              "A receipt is recorded each time someone pays.",
              "quay receipts",
            ),
      ),
    );
  }
  box.replaceChildren(...cards);
  const result = await layersP;
  if (viewed !== account) return;
  const l = result?.layers?.relay;
  relayBox.replaceChildren(
    card(
      "Relay",
      l ? l.state : "not measured",
      l && l.state !== "off"
        ? h(
            "div",
            { class: "card-body" },
            h("p", { style: "font-size:14px", text: l.summary }),
            l.error
              ? h("p", {
                  class: "muted",
                  style: "font-size:13px;margin-top:4px",
                  text: l.error,
                })
              : null,
            h(
              "dl",
              { class: "kv", style: "margin-top:12px" },
              Object.entries(l.metrics).flatMap(([k, v]) => [
                h("dt", { text: k.replaceAll("_", " ") }),
                h("dd", { class: "num", text: String(v) }),
              ]),
            ),
            h("p", {
              class: "muted",
              style: "font-size:12.5px;margin-top:12px",
              text: "To check a relay URL, add ?relay=<url> to this page's address.",
            }),
          )
        : stateBox(
            "off",
            "No relay for this site",
            l?.summary || "Members need a relayer to write with zero NEAR.",
            "quay relay create",
          ),
    ),
  );
}

const TAB_LOADERS = {
  data: loadDataTab,
  functions: loadFunctionsTab,
  routes: loadRoutesTab,
  keys: loadKeysTab,
};
function ensureTab(tab) {
  const loader = TAB_LOADERS[tab];
  if (!loader || tabState[tab] || !data) return;
  const account = viewed;
  const box = $(`tab-${tab}`);
  tabState[tab] = true;
  box.replaceChildren(skeleton(4));
  loader(account, box).catch((error) => {
    if (viewed !== account) return;
    tabState[tab] = false;
    box.replaceChildren(errorBox(error, () => ensureTab(tab)));
  });
}
function resetTabs() {
  tabState = {};
  ensureTab(currentTab());
}

// ---------- canvas ----------
// The account drawn as nodes: the gateways that serve it, the layers inside
// the contract, and the third-party services it calls. A layer the contract
// does not have is absent, never a placeholder. Edges come from canvas.js.
let canvasFor = null;
let canvasData = null;
let canvasP = null;
let panelKind = null;
let panelFrom = null;
let drawEdges = null;

// A price for a node: NEAR without trailing zeros, the token amount in its smallest units.
const shortPrice = (p) =>
  [
    p.price_yocto
      ? nearFromYocto(p.price_yocto).replace(/\.?0+ NEAR$/, " NEAR")
      : null,
    p.price_token ? `${nf.format(Number(p.price_token))} token units` : null,
  ]
    .filter(Boolean)
    .join(" or ") || "free";
// The first few names, then "and N more", so a node never grows past its slot.
const firstFew = (items, n = 2) =>
  items.length > n
    ? `${items.slice(0, n).join(", ")} and ${items.length - n} more`
    : items.join(", ");
const trimNear = (yocto) =>
  nearFromYocto(yocto).replace(/\.?0+ NEAR$/, " NEAR");
const plural = (n, word) => `${nf.format(n)} ${word}${n === 1 ? "" : "s"}`;
const shortKey = (key) => `${key.slice(0, 20)}…`;
const storeName = (url) => {
  try {
    const host = new URL(url).host;
    if (host.includes("fastfs")) return "FastFS";
    if (/ipfs|dweb|pinata|filebase/.test(host)) return "IPFS";
    return host;
  } catch {
    return "an external store";
  }
};
const toolMark = (key, text) =>
  h(
    "span",
    { class: "provider" },
    h("span", { class: "tool tool-text", "data-tool": key, text }),
  );

function ensureCanvas() {
  if (!data) return;
  if (canvasFor === viewed) {
    if (canvasData) drawCanvas();
    return;
  }
  loadCanvas();
}

async function loadCanvas() {
  const account = viewed;
  canvasFor = account;
  canvasData = null;
  const stage = $("stage");
  stage.className = "stage";
  stage.removeAttribute("data-edges");
  stage.removeAttribute("style");
  stage.replaceChildren(
    stage.querySelector("svg.edges"),
    h(
      "div",
      { class: "canvas-wait", role: "status" },
      h("span", { class: "skel", style: "width:180px" }),
      h("span", { text: `Reading ${account}` }),
    ),
  );
  // A view the contract does not have answers undefined; a failed read answers null.
  const opt = (method, args) =>
    viewOpt(account, method, args).catch(() => null);
  const relayer = `relay.${account}`;
  canvasP = Promise.all([
    opt("list_collections"),
    opt("list_members", { from_index: 0, limit: 50 }),
    opt("fn_list"),
    opt("list_products"),
    opt("list_receipts", { limit: 50 }),
    opt("cron_list"),
    opt("cron_status"),
    opt("db_list", { collection: "_fn", query: { limit: 50, order: "desc" } }),
    data.status.production
      ? callView(account, "get_release", { id: data.status.production }).catch(
          () => null,
        )
      : null,
    rpc({ request_type: "view_account", account_id: relayer }).catch(
      () => null,
    ),
    drawEdges
      ? null
      : import("./canvas.js").then((m) => {
          drawEdges = m.drawEdges;
        }),
  ]);
  const [
    cols,
    members,
    fns,
    products,
    receipts,
    jobs,
    cron,
    runs,
    release,
    relay,
  ] = await canvasP;
  if (viewed !== account) return;
  canvasData = {
    account,
    cols: cols === undefined ? undefined : rows(cols),
    members:
      members === undefined ? undefined : rows(members?.members ?? members),
    fns: fns === undefined ? undefined : rows(fns),
    products: products === undefined ? undefined : rows(products),
    receipts: rows(receipts, "receipts"),
    jobs: jobs === undefined ? undefined : rows(jobs, "jobs"),
    cron,
    runs: rows(runs, "docs"),
    release,
    relay: relay?.amount ? { account: relayer, amount: relay.amount } : null,
  };
  drawCanvas();
  const want = new URL(location.href).searchParams.get("panel");
  if (want !== "none" && matchMedia("(min-width: 1001px)").matches)
    openPanel(
      want === "site" || !canvasData.fns?.length ? "site" : "functions",
    );
}

// A canvas node at pos = [left, top, width, target]. target is PANEL (a button
// that opens the side panel), a URL (a link to a tab), or absent (plain).
const PANEL = Symbol("panel");
function node(key, pos, name, ...body) {
  const style = `left:${pos[0]}px;top:${pos[1]}px;width:${pos[2]}px`;
  const kids = [h("span", { class: "node-name", text: name }), ...body];
  if (pos[3] === PANEL)
    return h(
      "button",
      {
        class: "node",
        type: "button",
        "data-node": key,
        "data-panel": key,
        "aria-expanded": String(panelKind === key),
        "aria-controls": "panel",
        style,
      },
      kids,
    );
  if (pos[3])
    return h(
      "a",
      { class: "node", "data-node": key, href: pos[3], style },
      kids,
    );
  return h("div", { class: "node", "data-node": key, style }, kids);
}
const sub = (text, cls = "") =>
  h("span", { class: `node-sub${cls ? ` ${cls}` : ""}`, text });
const note = (text) => h("span", { class: "node-note", text });
const tabHref = (tab) => {
  const url = new URL(location.href);
  url.searchParams.set("tab", tab);
  url.searchParams.delete("panel");
  return url.search;
};

// The release track: one berth per release, production marked from above.
function track() {
  // The newest releases, always including production and previous; fewer
  // berths when ids reach three digits, so their labels never touch.
  const all = data.releases
    .map((r) => r.id)
    .sort((a, b) => Number(a) - Number(b));
  const room = all.some((id) => id.length > 2) ? 6 : 8;
  const keep = new Set(
    [data.status.production, data.status.previous].filter((id) =>
      all.includes(id),
    ),
  );
  for (const id of [...all].reverse()) {
    if (keep.size >= room) break;
    keep.add(id);
  }
  const ids = all.filter((id) => keep.has(id));
  const prodAt = ids.indexOf(data.status.production);
  return h(
    "span",
    { class: "track-wrap" },
    h(
      "ol",
      {
        class: "track",
        "aria-label": `Releases ${ids[0]} to ${ids.at(-1)}. Production is ${data.status.production || "none"}${data.status.previous ? `, previous is ${data.status.previous}` : ""}.`,
      },
      ids.map((id) =>
        h(
          "li",
          {
            class:
              id === data.status.production
                ? "is-prod"
                : id === data.status.previous
                  ? "is-prev"
                  : "",
          },
          h("i", { "aria-hidden": "true" }),
          h("span", { text: id }),
        ),
      ),
    ),
    prodAt >= 0
      ? h(
          "span",
          {
            class: "track-ptr",
            "aria-hidden": "true",
            style: `--n:${ids.length};--i:${prodAt}`,
            "data-edge":
              prodAt === ids.length - 1 ? "end" : prodAt === 0 ? "start" : null,
          },
          h("span", { class: "ptr ptr-down", text: "production" }),
        )
      : null,
  );
}

function gatewayNodes(at) {
  const account = canvasData.account;
  const mirror = HOSTS.mirrors?.[account];
  const out = [];
  if (mirror)
    out.push(
      node(
        "workers",
        at[0],
        "Workers host",
        sub(new URL(mirror).host),
        note("Primary, answers from RPC"),
        toolMark("cloudflare", "Cloudflare Workers"),
      ),
    );
  out.push(
    node(
      "page",
      mirror ? at[1] : at[0],
      "testnet.page",
      sub(new URL(publicOrigin(account)).host),
      note("Public web4 gateway"),
      toolMark("web4", "web4"),
    ),
  );
  return { nodes: out, keys: mirror ? ["workers", "page"] : ["page"] };
}

function drawCanvas() {
  const c = canvasData;
  if (!c || !data || c.account !== data.account) return;
  const stage = $("stage");
  const full = c.fns !== undefined || c.cols !== undefined;
  const keys = data.keys;
  const fullKeys = keys.filter((k) => k.access_key.permission === "FullAccess");
  const callKeys = keys.length - fullKeys.length;
  const stored = `${plural(data.releases.length, "release")}, ${bytes(data.status.stored_bytes)} stored`;
  const nodes = [];
  const edges = [];
  if (!full) {
    // Contract 2.x: the site, its gateways and its keys.
    const gw = gatewayNodes([
      [16, 120, 220],
      [16, 290, 220],
    ]);
    nodes.push(...gw.nodes);
    for (const key of gw.keys) edges.push(`${key}>site|h|web4_get`);
    const prod = data.releases.find((r) => r.id === data.status.production);
    nodes.push(
      h(
        "div",
        {
          class: "group",
          style: "left:280px;top:72px;width:516px;height:500px",
        },
        h("span", { class: "group-label", title: c.account, text: c.account }),
      ),
      node(
        "site",
        [384, 112, 316, PANEL],
        "Site",
        sub(stored),
        track(),
        h("span", {
          class: "node-foot",
          text: prod
            ? `Production: ${prod.message || `release ${prod.id}`}`
            : "Nothing in production yet",
        }),
      ),
      node(
        "owner",
        [296, 436, 240, tabHref("storage")],
        fullKeys.length === 1
          ? "Full-access key"
          : plural(fullKeys.length, "full-access key"),
        fullKeys[0] ? sub(shortKey(fullKeys[0].public_key), "mono") : null,
        note("Can promote, roll back and delete"),
      ),
    );
    edges.push("site>owner|v|promote, rollback, delete");
    if (callKeys) {
      nodes.push(
        node(
          "ci",
          [548, 436, 240, tabHref("storage")],
          plural(callKeys, "function-call key"),
          note("Can upload and seal. Cannot move production"),
        ),
      );
      edges.push("site>ci|v|put_chunk, seal");
    }
    stage.style.cssText = "width:820px;height:600px";
  } else {
    const gw = gatewayNodes([
      [16, 110, 210],
      [16, 280, 210],
    ]);
    nodes.push(...gw.nodes);
    const routes = c.release?.routes ?? [];
    const into = routes.length ? "routes" : "site";
    for (const key of gw.keys) edges.push(`${key}>${into}|h|web4_get`);
    nodes.push(
      h(
        "div",
        {
          class: "group",
          style: "left:250px;top:40px;width:500px;height:640px",
        },
        h("span", { class: "group-label", title: c.account, text: c.account }),
      ),
    );
    if (routes.length) {
      const patterns = routes.map((r) => r.pattern);
      nodes.push(
        node(
          "routes",
          [270, 80, 225, tabHref("routes")],
          "Routes",
          sub(
            patterns.join(", ").length > 60
              ? `${plural(patterns.length, "route")}, from ${patterns[0]}`
              : patterns.join(", "),
          ),
          note(`Sealed in release ${data.status.production}`),
        ),
      );
    }
    nodes.push(
      node("site", [510, 80, 225, PANEL], "Site", sub(stored), track()),
    );
    if (c.members !== undefined)
      nodes.push(
        node(
          "members",
          [270, 270, 225, tabHref("keys")],
          "Members",
          sub(plural(c.members.length, "account")),
          c.members.length
            ? note(
                `${c.members
                  .slice(0, 3)
                  .map((m) => m.split(".")[0])
                  .join(
                    ", ",
                  )}${c.members.length > 3 ? ` and ${c.members.length - 3} more` : ""}, made with no NEAR`,
              )
            : null,
        ),
      );
    if (c.cols !== undefined) {
      const first = c.cols[0];
      nodes.push(
        node(
          "data",
          [510, 270, 225, tabHref("data")],
          "Data",
          sub(
            first
              ? c.cols.length > 1
                ? `${plural(c.cols.length, "collection")}, ${plural(
                    c.cols.reduce((n, col) => n + Number(col.count ?? 0), 0),
                    "doc",
                  )}`
                : `${first.name}: ${plural(Number(first.count ?? 0), "doc")}, ${bytes(first.bytes)}`
              : "No collections yet",
          ),
          first
            ? note(
                `${first.write === "anyone" ? "Anyone writes" : `${first.write} write`}, ${first.payer === "site" ? "the site pays" : "the writer pays"}${first.moderated ? ", moderated" : ""}`,
              )
            : null,
        ),
      );
      if (routes.some((r) => r.collection === first?.name))
        edges.push(`routes>data|v|reads ${first.name}`);
    }
    if (c.products !== undefined)
      nodes.push(
        node(
          "pay",
          [270, 440, 225, tabHref("data")],
          "Payments",
          sub(
            c.products.length
              ? `${c.products[0].id}: ${shortPrice(c.products[0])}${c.products.length > 1 ? `, and ${c.products.length - 1} more` : ""}`
              : "No products yet",
          ),
          note(plural(c.receipts.length, "receipt")),
        ),
      );
    nodes.push(
      node(
        "keys",
        [510, 440, 225, tabHref("keys")],
        "Keys",
        sub(
          `${plural(fullKeys.length, "full-access key")}${callKeys ? `, ${callKeys} function-call` : ""}`,
        ),
        fullKeys[0] ? note(shortKey(fullKeys[0].public_key)) : null,
      ),
    );
    if (c.jobs !== undefined) {
      const job = c.jobs[0];
      const armed = c.cron?.armed;
      nodes.push(
        node(
          "cron",
          [270, 580, 465, tabHref("functions")],
          "Cron",
          sub(
            job
              ? `${`${job.fn}, every ${job.every_minutes} min${c.jobs.length > 1 ? `, and ${c.jobs.length - 1} more` : ""}`}`
              : "No jobs",
          ),
          note(
            armed
              ? `Armed, ${c.cron.hops} hops, last tick ${when(c.cron.last_tick, true)}`
              : job
                ? "Set, not armed now. quay cron arm starts it for about 6 hours."
                : "Add a job with quay cron add",
          ),
        ),
      );
    }
    const ext = (c.release?.files ?? []).filter((f) => f.external);
    if (ext.length) {
      const size = ext.reduce((n, f) => n + Number(f.external.size ?? 0), 0);
      nodes.push(
        node(
          "fs",
          [830, 60, 210],
          "Large files",
          sub(
            `${plural(ext.length, "file")} on ${storeName(ext[0].external.url)}, ${bytes(size)}`,
          ),
          note(
            `sha256 ${ext[0].sha256.slice(0, 8)}…${ext[0].sha256.slice(-4)}`,
          ),
          toolMark("fastnear", storeName(ext[0].external.url)),
        ),
      );
      edges.push("fs>site|r|by URL");
    }
    if (c.fns !== undefined) {
      const last = c.runs[0]?.data ?? c.runs[0];
      nodes.push(
        node(
          "functions",
          [830, 250, 210, PANEL],
          "Functions",
          sub(c.fns.length ? firstFew(c.fns.map((f) => f.name)) : "None yet"),
          last
            ? note(
                `${last.name} last ran ${when(last.at ?? c.runs[0].created)}`,
              )
            : null,
          toolMark("outlayer", "OutLayer"),
        ),
      );
      const trigger = c.cols?.find((col) => col.on_add);
      if (trigger) edges.push("data>functions|h|on_add");
    }
    if (c.relay) {
      nodes.push(
        node(
          "relay",
          [830, 440, 210, tabHref("keys")],
          "Relay",
          sub(c.relay.account),
          note(`${nearFromYocto(c.relay.amount)}, gas only`),
          h(
            "span",
            { class: "provider" },
            h("span", { class: "std", text: "NEP-366" }),
          ),
        ),
      );
      if (c.cols !== undefined) edges.push("relay>data|r|db_add, gas paid");
    }
    stage.style.cssText = "width:1050px;height:700px";
  }
  stage.dataset.edges = edges.join("; ");
  // A redraw (after a sign-in or a promote) keeps keyboard focus on the same node.
  const focused = stage.contains(document.activeElement)
    ? document.activeElement.closest("[data-node]")?.dataset.node
    : null;
  stage.replaceChildren(stage.querySelector("svg.edges"), ...nodes);
  if (focused) stage.querySelector(`[data-node="${focused}"]`)?.focus();
  redraw();
  if (panelKind) fillPanel(panelKind);
}
function redraw() {
  if (drawEdges && currentTab() === "canvas")
    requestAnimationFrame(() => drawEdges($("stage")));
}

// ----- the side panel -----
// A closed panel is out of the tab order; on a phone the open sheet is modal,
// so the canvas behind it is.
function setPanelInert(open) {
  $("panel").inert = !open;
  $("canvas-view").querySelector(".canvas").inert =
    open && matchMedia("(max-width: 1000px)").matches;
}
function openPanel(kind, from) {
  panelKind = kind;
  panelFrom = from || null;
  fillPanel(kind);
  $("panel").setAttribute("data-open", "");
  setPanelInert(true);
  for (const el of $("stage").querySelectorAll("[data-panel]"))
    el.setAttribute("aria-expanded", String(el.dataset.panel === kind));
  redraw();
  if (from) $("panel-title").focus();
}
function closePanel(quiet) {
  if (!panelKind) return;
  const back = $("stage").querySelector(`[data-panel="${panelKind}"]`);
  panelKind = null;
  $("panel").removeAttribute("data-open");
  setPanelInert(false);
  for (const el of $("stage").querySelectorAll("[data-panel]"))
    el.setAttribute("aria-expanded", "false");
  redraw();
  if (!quiet) (panelFrom || back)?.focus();
}
function fillPanel(kind) {
  if (!canvasData) return;
  if (kind === "functions") return functionsPanel();
  return sitePanel();
}
// replaceChildren would print a null child as the text "null".
function setPanelBody(...children) {
  $("panel-body").replaceChildren(...children.filter(Boolean));
}
function sitePanel() {
  const account = viewed;
  const prod = data.releases.find((r) => r.id === data.status.production);
  $("panel-title").textContent = "Site";
  $("panel-provider").replaceChildren();
  $("panel-meta").replaceChildren(
    h("a", { href: preview(account) }, host(account), icon("ext", true)),
    h("span", { text: plural(data.releases.length, "release") }),
    h("span", {
      class: "num",
      text: `${bytes(data.status.stored_bytes)} stored`,
    }),
    h("span", { text: `Contract ${data.status.version}` }),
  );
  const sorted = [...data.releases].sort((a, b) => Number(b.id) - Number(a.id));
  const lastPromote = [...data.history]
    .reverse()
    .find((e) => e.release_id === data.status.production);
  setPanelBody(
    prod
      ? h(
          "section",
          { class: "live-card", "aria-label": "Production" },
          h(
            "div",
            { class: "lc-frame" },
            h("span", {
              class: "lc-wait",
              text: `Loading from ${host(account)}`,
            }),
            h("iframe", {
              src: preview(account),
              loading: "lazy",
              title: `Production, release ${prod.id}`,
              sandbox: "allow-scripts allow-same-origin",
              tabindex: "-1",
              "aria-hidden": "true",
              onload: (e) => {
                e.target.dataset.ok = "";
              },
            }),
          ),
          h(
            "div",
            { class: "lc-main" },
            h(
              "div",
              { class: "top" },
              h("span", { class: "ptr", text: "production" }),
              h("strong", { text: `Release ${prod.id}` }),
            ),
            h("p", { class: "lc-msg", text: prod.message || "No message" }),
            h(
              "dl",
              { class: "facts-line" },
              h("dt", { text: "Promoted" }),
              h("dd", {
                text: lastPromote ? when(lastPromote.timestamp, true) : "never",
              }),
              h("dt", { text: "Size" }),
              h("dd", {
                class: "num",
                text: `${prod.file_count} files, ${bytes(prod.bytes)}`,
              }),
              h("dt", { text: "Hash" }),
              h("dd", {
                class: "mono",
                text: prod.sha256
                  ? `${prod.sha256.slice(0, 8)}…${prod.sha256.slice(-4)}`
                  : "none",
              }),
            ),
            h(
              "div",
              { class: "acts" },
              data.status.previous
                ? actionButton(
                    `Roll back to ${data.status.previous}`,
                    "rollback",
                    undefined,
                    "undo",
                  )
                : null,
              h(
                "a",
                { class: "btn btn-sm", href: preview(account) },
                "Visit",
                icon("ext", true),
              ),
            ),
          ),
        )
      : h("p", {
          class: "muted",
          text: "Nothing is in production yet. Run quay promote <id>.",
        }),
    h(
      "section",
      { class: "sp-section" },
      h(
        "h3",
        null,
        "Releases ",
        h("a", { href: tabHref("releases"), text: "All releases" }),
      ),
      sorted.length
        ? h("ol", { class: "rows" }, sorted.slice(0, 5).map(panelRelease))
        : h("p", {
            class: "muted",
            text: "Nothing sealed yet. Run quay deploy ./dist from your project folder.",
          }),
    ),
    data.history.length
      ? h(
          "section",
          { class: "sp-section" },
          h("h3", { text: "Recent changes" }),
          h(
            "ol",
            { class: "timeline" },
            [...data.history]
              .reverse()
              .slice(0, 3)
              .map((e) =>
                h(
                  "li",
                  null,
                  h("span", {
                    class: "what",
                    text:
                      e.kind === "rollback"
                        ? `Rolled back to ${e.release_id} from ${e.previous_id}`
                        : `Promoted ${e.release_id}${e.previous_id ? `, previous ${e.previous_id}` : ""}`,
                  }),
                  h("span", {
                    class: "when",
                    title: iso(e.timestamp),
                    text: when(e.timestamp),
                  }),
                ),
              ),
          ),
        )
      : null,
  );
}
// A release in the Site panel: id, message and size, and Promote for any but production.
function panelRelease(release) {
  const isProd = release.id === data.status.production;
  const isPrev = release.id === data.status.previous;
  return h(
    "li",
    { class: `rel-row${isProd ? " is-live" : ""}` },
    h("span", { class: "id", text: release.id }),
    h(
      "div",
      { class: "msg" },
      h(
        "span",
        { class: "l1" },
        h("span", {
          class: "m",
          title: release.message || "",
          text: release.message || "No message",
        }),
        isProd
          ? h("span", { class: "ptr", text: "production" })
          : isPrev
            ? h("span", { class: "chip chip-prev", text: "previous" })
            : null,
      ),
      h("span", {
        class: "l2 num",
        text: `${release.file_count} files, ${bytes(release.bytes)}`,
      }),
    ),
    h("span", {
      class: "when",
      title: iso(release.timestamp),
      text: when(release.timestamp),
    }),
    h(
      "div",
      { class: "acts" },
      isProd ? null : actionButton("Promote", "promote", release.id, "up"),
    ),
  );
}
function functionsPanel() {
  const c = canvasData;
  $("panel-title").textContent = "Functions";
  $("panel-provider").replaceChildren(
    h("span", {
      class: "tool tool-text",
      "data-tool": "outlayer",
      text: "OutLayer",
    }),
  );
  const runsOf = (name) =>
    c.runs
      .map((d) => ({ id: d.id, ...(d.data ?? d) }))
      .filter((r) => r.name === name);
  const secrets = c.fns.filter((f) => f.secrets).length;
  $("panel-meta").replaceChildren(
    h("span", { text: plural(c.fns.length, "function") }),
    h("span", { text: "Rust compiled to WASI" }),
    h("span", { text: `${secrets} with a secret` }),
    h("a", { href: tabHref("functions") }, "Every run", icon("right", true)),
  );
  const cards = c.fns.map((f) => {
    const trigger = c.cols?.find((col) => col.on_add === f.name);
    const job = c.jobs?.find((j) => j.fn === f.name);
    const last = runsOf(f.name)[0];
    const out =
      last?.output && typeof last.output === "object" ? last.output : null;
    const id = `fn-${f.name}`;
    const facts = [
      [
        "Trigger",
        trigger
          ? `on_add on ${trigger.name}`
          : job
            ? `cron, every ${job.every_minutes} min`
            : `fn_call by the ${f.call === "owner" ? "owner" : f.call}`,
      ],
      ["Secret", f.secrets ? "stored on OutLayer, never shown" : "none"],
      [
        "Per call",
        `${f.deposit ? trimNear(f.deposit) : "nothing"} attached, paid by the ${f.payer === "site" ? "site" : "caller"}; ${f.max_seconds ?? 30} s limit`,
      ],
      [
        "Last run",
        last
          ? `${when(last.at, true)}, ${last.ok === false ? `failed${last.error ? `: ${last.error}` : ""}` : out?.auth ? `auth: ${out.auth}` : out?.scheduled ? "from the schedule" : "ok"}`
          : "no run yet",
      ],
    ];
    const chipEl = trigger
      ? h(
          "span",
          { class: "chip chip-live" },
          h("span", { class: "dot dot-live" }),
          `Runs on every new ${trigger.name.replace(/s$/, "")}`,
        )
      : job
        ? h(
            "span",
            { class: c.cron?.armed ? "chip chip-live" : "chip" },
            c.cron?.armed ? h("span", { class: "dot dot-live" }) : null,
            c.cron?.armed
              ? `Every ${job.every_minutes} min`
              : "Schedule not armed",
          )
        : h("span", { class: "chip", text: "Run by call" });
    return h(
      "section",
      { class: "fn-card", "aria-labelledby": id },
      h(
        "div",
        { class: "fn-top" },
        h("h3", { id, class: "mono", text: f.name }),
        chipEl,
      ),
      h(
        "dl",
        { class: "facts-line" },
        facts.flatMap(([dt, dd]) => [
          h("dt", { text: dt }),
          h("dd", { text: dd }),
        ]),
      ),
    );
  });
  const recent = c.runs.slice(0, 8).map((d) => {
    const r = d.data ?? d;
    const out = r.output && typeof r.output === "object" ? r.output : null;
    const what =
      r.ok === false
        ? `failed${r.error ? `: ${r.error}` : ""}`
        : out?.hide
          ? `hidden, ${out.reason || "blocked"}`
          : out?.scheduled
            ? "digest, from the schedule"
            : out?.auth
              ? `auth ${out.auth}${out.preview?.title ? `, preview: ${out.preview.title}` : ""}`
              : "ok";
    return h(
      "li",
      { class: "rel-row run-row" },
      h("span", { class: "id", text: (d.id || "").replace(/^.*-/, "") }),
      h(
        "div",
        { class: "msg" },
        h(
          "span",
          { class: "l1" },
          h("span", {
            class: "m",
            title: r.caller || "",
            text:
              r.caller && r.caller !== c.account
                ? `${r.name} · ${r.caller.replace(`.${c.account}`, "")}`
                : r.name,
          }),
          out?.hide
            ? h("span", { class: "chip chip-warn-plain", text: "hidden" })
            : null,
          r.ok === false
            ? h("span", { class: "chip chip-warn-plain", text: "failed" })
            : null,
        ),
        h("span", { class: "l2", text: what }),
      ),
      h("span", { class: "when", title: iso(r.at), text: when(r.at) }),
    );
  });
  setPanelBody(
    ...(cards.length
      ? cards
      : [
          stateBox(
            "empty",
            "No functions yet",
            "A function is Rust compiled to WASI that OutLayer runs when a trigger or a call asks.",
            "quay functions deploy <name>",
          ),
        ]),
    recent.length
      ? h(
          "section",
          { class: "sp-section" },
          h(
            "h3",
            null,
            "Recent runs ",
            h("a", { href: tabHref("functions"), text: "All runs" }),
          ),
          h("ol", { class: "rows" }, recent),
        )
      : null,
    h("p", {
      class: "sp-note",
      text: "OutLayer is one operator. A run took 5 to 17 seconds in our checks, and a post is saved before its check comes back.",
    }),
  );
}

// ---------- loading ----------
async function load(account, quiet) {
  viewed = account;
  tabState = {};
  layersFor = null;
  canvasFor = null;
  canvasData = null;
  try {
    localStorage.setItem("quay-account", account);
  } catch {}
  $("crumb-name").textContent = account;
  checkGateway();
  if (!quiet) show("loading");
  try {
    const current = await callView(account, "get_status", {});
    if (!current?.version)
      throw Object.assign(
        new Error(`${account} did not answer as a Quay contract.`),
        { notQuay: true },
      );
    const [releases, history, keyList, acct] = await Promise.all([
      listAll(account, "list_releases", "releases"),
      listAll(account, "list_history", "entries"),
      rpc({ request_type: "view_access_key_list", account_id: account })
        .then((r) => r.keys ?? [])
        .catch(() => []),
      rpc({ request_type: "view_account", account_id: account }).catch(
        () => null,
      ),
    ]);
    data = { account, status: current, releases, history, keys: keyList, acct };
    show("ready");
    render();
  } catch (error) {
    const msg = String(error?.message || error);
    const missing = /does not exist|UNKNOWN_ACCOUNT|doesn't exist/i.test(msg);
    const noCode =
      /CodeDoesNotExist|wasm|MethodNotFound|MethodResolveError|CompilationError/i.test(
        msg,
      ) || error?.notQuay;
    $("error-title").textContent = missing
      ? `${account} does not exist on testnet`
      : noCode
        ? `${account} did not answer as a Quay 2 contract`
        : `Could not read ${account}`;
    $("error-text").textContent = missing
      ? "Check the spelling, or create an account with quay init."
      : noCode
        ? "It may be on the old v1 contract, or have no contract. Check the name, or run quay init to create a new account."
        : msg;
    data = null;
    show("error");
  }
}

// ---------- wallet ----------
async function ensureWallet() {
  if (connector) return connector;
  // Tests may provide a stub connector; production loads near-connect.
  const { NearConnector } =
    globalThis.QUAY_TEST_WALLET ||
    (await import("https://esm.sh/@hot-labs/near-connect@0.12.0"));
  connector = new NearConnector({
    network: "testnet",
    features: {
      testnet: true,
      signAndSendTransaction: true,
      signInWithoutAddKey: true,
    },
  });
  connector.on("wallet:signOut", () => {
    walletAccount = null;
    render();
    resetTabs();
  });
  return connector;
}

async function signIn(button) {
  if (button) button.disabled = true;
  try {
    const current = await ensureWallet();
    await current.connect();
    const wallet = await current.wallet();
    const accounts = await wallet.getAccounts();
    walletAccount = accounts[0]?.accountId ?? null;
    render();
    resetTabs();
    if (walletAccount)
      toast(
        "ok",
        `Signed in as ${walletAccount}`,
        isOwner() || !viewed
          ? "The wallet signs each change."
          : `Only ${viewed} can change its production.`,
      );
  } catch (error) {
    toast(
      "bad",
      "The wallet did not sign in",
      error?.message || "Try again, or pick another wallet.",
    );
  } finally {
    if (button) button.disabled = false;
  }
}

// ---------- toasts and confirm ----------
function toast(kind, title, text, link) {
  const box = h(
    "div",
    { class: "toast", role: kind === "bad" ? "alert" : "status" },
    icon(kind === "ok" ? "check" : "alert"),
    h(
      "div",
      null,
      h("b", { text: title }),
      text ? h("span", { class: "muted", text }) : null,
      link
        ? h(
            "div",
            { style: "margin-top:8px" },
            h("a", {
              class: "link mono",
              href: link,
              style: "font-size:12.5px",
              text: "View transaction",
            }),
          )
        : null,
    ),
    h(
      "button",
      {
        class: "btn btn-sm btn-icon btn-quiet",
        type: "button",
        "aria-label": "Dismiss",
      },
      icon("x", true),
    ),
  );
  box.firstChild.classList.add(kind === "ok" ? "ok" : "bad");
  box.lastChild.addEventListener("click", () => box.remove());
  $("toasts").append(box);
  const words = `${title} ${text || ""}`.split(/\s+/).length;
  setTimeout(
    () => box.remove(),
    kind === "bad" ? 15000 : Math.max(5000, words * 300) + (link ? 4000 : 0),
  );
}

function ask(title, text, verb, danger) {
  const dialog = $("confirm");
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  const yes = $("confirm-yes");
  yes.textContent = verb;
  yes.className = danger ? "btn btn-sm btn-danger" : "btn btn-sm btn-primary";
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "confirm"),
      { once: true },
    );
  });
}

function txHash(result) {
  return (
    result?.transaction?.hash ||
    result?.transaction_outcome?.id ||
    result?.[0]?.transaction?.hash ||
    null
  );
}

async function run(action, id) {
  if (!isOwner() || busy) return;
  const prod = status.production;
  const prev = status.previous;
  const copy = {
    promote: [
      `Promote release ${id}?`,
      `The host root will serve release ${id}. Release ${prod ?? "none"} becomes previous. Nothing is re-uploaded.`,
      "Promote",
    ],
    rollback: [
      `Roll back to release ${prev}?`,
      `The host root will serve release ${prev} again. Release ${prod} becomes previous, so you can undo this.`,
      "Roll back",
    ],
    delete: [
      `Delete release ${id}?`,
      `Its URL /r/${id}/ stops working, and its bytes unlock on ${viewed}. This cannot be undone.`,
      "Delete release",
    ],
  }[action];
  if (!(await ask(...copy, action === "delete"))) return;
  busy = { action, id: action === "rollback" ? null : id };
  render();
  try {
    const wallet = await connector.wallet();
    const result = await wallet.signAndSendTransaction({
      signerId: walletAccount,
      receiverId: viewed,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: action,
            args: action === "rollback" ? {} : { id },
            gas: GAS,
            deposit: "1",
          },
        },
      ],
    });
    const hash = txHash(result);
    busy = null;
    lastRollback =
      action === "rollback" ? { account: viewed, to: prev, from: prod } : null;
    await load(viewed, true);
    const done = {
      promote: [
        `Release ${id} is production`,
        `Previous is ${prod ?? "none"}.`,
      ],
      rollback: [
        `Rolled back to release ${prev}`,
        `Release ${prod} is now previous.`,
      ],
      delete: [
        `Deleted release ${id}`,
        "Its bytes are unlocked on the contract account.",
      ],
    }[action];
    toast("ok", done[0], done[1], hash ? EXPLORER + hash : null);
  } catch (error) {
    busy = null;
    render();
    toast(
      "bad",
      "The wallet did not send it",
      `${error?.message || "The request was closed."} Production is still release ${prod}.`,
    );
  }
}

// ---------- events ----------
$("lookup").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("account");
  const err = $("account-err");
  const account = accountFrom(input.value);
  if (!/^[a-z0-9._-]+\.testnet$/.test(account)) {
    input.setAttribute("aria-invalid", "true");
    err.replaceChildren(
      icon("alert", true),
      "Enter a testnet account, such as quay-65nqd3rn.testnet, or its .testnet.page host.",
    );
    err.hidden = false;
    input.focus();
    return;
  }
  input.removeAttribute("aria-invalid");
  err.hidden = true;
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("account", account);
  history.pushState(null, "", url);
  load(account);
});
$("account").addEventListener("input", (event) => {
  if (event.target.getAttribute("aria-invalid")) {
    event.target.removeAttribute("aria-invalid");
    $("account-err").hidden = true;
  }
});
$("retry").addEventListener("click", () => viewed && load(viewed));
$("sign-in").addEventListener("click", (event) => signIn(event.currentTarget));
$("sign-out").addEventListener("click", async () => {
  $("wallet-menu").open = false;
  try {
    if (connector) await connector.disconnect();
  } catch {}
  walletAccount = null;
  render();
  resetTabs();
  toast("ok", "Signed out", "The page can still read every account.");
});
$("tabs").addEventListener("click", (event) => {
  const a = event.target.closest("a[data-tab]");
  if (!a) return;
  event.preventDefault();
  const url = new URL(location.href);
  url.searchParams.set("tab", a.dataset.tab);
  history.replaceState(null, "", url);
  applyTab();
});
document.addEventListener("click", (event) => {
  for (const menu of document.querySelectorAll("details.menu[open]"))
    if (!menu.contains(event.target)) menu.open = false;
  const signin = event.target.closest("[data-signin]");
  if (signin) return signIn(signin);
  const button = event.target.closest("#view-ready [data-action]");
  if (!button || button.disabled) return;
  const menu = button.closest("details.menu");
  if (menu) menu.open = false;
  run(button.dataset.action, button.dataset.id);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of document.querySelectorAll("details.menu[open]")) {
    menu.open = false;
    menu.querySelector("summary").focus();
  }
});
addEventListener("popstate", start);
$("stage").addEventListener("click", (event) => {
  const button = event.target.closest("[data-panel]");
  if (!button) return;
  if (panelKind === button.dataset.panel) closePanel();
  else openPanel(button.dataset.panel, button);
});
$("panel-close").addEventListener("click", () => closePanel());
$("scrim").addEventListener("click", () => closePanel());
// Phone sheet: drag the handle down to dismiss. While the finger is down the
// sheet follows it 1:1 and the scrim fades with it; on release it closes past
// 40% of its height or on a flick faster than 0.5 px/ms, else snaps back.
// Upward drags rubber-band. One pointer at a time.
const grab = $("panel").querySelector(".sp-grab");
let sheetDrag = null;
grab.addEventListener("pointerdown", (event) => {
  if (sheetDrag || !matchMedia("(max-width: 1000px)").matches) return;
  const panel = $("panel");
  const start = new DOMMatrix(getComputedStyle(panel).transform).m42;
  sheetDrag = {
    id: event.pointerId,
    y0: event.clientY - start,
    t: event.timeStamp,
    y: start,
    v: 0,
  };
  grab.setPointerCapture(event.pointerId);
  panel.setAttribute("data-dragging", "");
});
grab.addEventListener("pointermove", (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.id) return;
  const panel = $("panel");
  let y = event.clientY - sheetDrag.y0;
  if (y < 0) y *= 0.2;
  sheetDrag.v = (y - sheetDrag.y) / Math.max(1, event.timeStamp - sheetDrag.t);
  sheetDrag.y = y;
  sheetDrag.t = event.timeStamp;
  panel.style.transform = `translateY(${y}px)`;
  $("scrim").style.opacity = String(1 - Math.max(0, y) / panel.offsetHeight);
});
function releaseSheet(event) {
  if (!sheetDrag || event.pointerId !== sheetDrag.id) return;
  const panel = $("panel");
  const { y } = sheetDrag;
  // A finger that stopped before lifting is not a flick.
  const v = event.timeStamp - sheetDrag.t > 100 ? 0 : sheetDrag.v;
  sheetDrag = null;
  panel.removeAttribute("data-dragging");
  panel.style.transform = "";
  $("scrim").style.opacity = "";
  if (y > panel.offsetHeight * 0.4 || v > 0.5) closePanel();
  else {
    panel.setAttribute("data-snap", "");
    setTimeout(() => panel.removeAttribute("data-snap"), 220);
  }
}
grab.addEventListener("pointerup", releaseSheet);
grab.addEventListener("pointercancel", releaseSheet);
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    panelKind &&
    !document.querySelector("details.menu[open], dialog[open]")
  )
    closePanel();
});

function start() {
  const initial = new URL(location.href).searchParams.get("account");
  if (initial) {
    $("account").value = initial;
    load(accountFrom(initial));
  } else {
    viewed = null;
    data = null;
    show("empty");
    render();
  }
}
start();
