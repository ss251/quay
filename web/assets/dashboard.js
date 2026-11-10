// Quay dashboard. Reads a Quay contract over public RPC; changes go through a
// testnet wallet via near-connect. The page never holds a key.
const RPC = "https://test.rpc.fastnear.com";
const GAS = "30000000000000";
const EXPLORER = "https://explorer.testnet.near.org/transactions/";
const SPRITE = new URL("icons.svg", import.meta.url).href;
const TABS = ["overview", "releases", "history", "storage"];

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
function host(account) {
  return `${account.replace(/\.testnet$/, "")}.testnet.page`;
}
function preview(account, id) {
  return id ? `https://${host(account)}/r/${id}/` : `https://${host(account)}/`;
}
function accountFrom(raw) {
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (text.endsWith(".testnet.page"))
    return `${text.slice(0, -".testnet.page".length)}.testnet`;
  return text;
}

// ---------- RPC ----------
async function rpc(params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "quay",
      method: "query",
      params: { finality: "final", ...params },
    }),
  });
  if (!response.ok)
    throw new Error(
      `The RPC answered ${response.status}. Try again in a moment.`,
    );
  const body = await response.json();
  if (body.error)
    throw new Error(body.error.data || body.error.message || "RPC error");
  return body.result;
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
  $("visit-prod").href = preview(account);
  $("copy-host").dataset.copy = `https://${host(account)}/`;

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
}

function currentTab() {
  const tab = new URL(location.href).searchParams.get("tab");
  return TABS.includes(tab) ? tab : "overview";
}
function applyTab() {
  const tab = currentTab();
  const ready = $("view-ready");
  ready.dataset.tab = tab;
  for (const el of ready.querySelectorAll("[data-in]"))
    el.hidden = !el.dataset.in.split(" ").includes(tab);
  for (const a of $("tabs").querySelectorAll("a")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
    const url = new URL(location.href);
    url.searchParams.set("tab", a.dataset.tab);
    a.href = url.search;
  }
}

// ---------- loading ----------
async function load(account, quiet) {
  viewed = account;
  $("crumb-name").textContent = account;
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
