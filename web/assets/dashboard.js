const RPC = "https://test.rpc.fastnear.com";
const GAS = "30000000000000";

const form = document.querySelector("#lookup");
const accountInput = document.querySelector("#account");
const empty = document.querySelector("#empty");
const loading = document.querySelector("#loading");
const errorBox = document.querySelector("#error");
const result = document.querySelector("#result");
const summary = document.querySelector("#summary");
const releaseBody = document.querySelector("#releases");
const historyBody = document.querySelector("#history");
const walletLine = document.querySelector("#wallet-line");
const signIn = document.querySelector("#sign-in");
const signOut = document.querySelector("#sign-out");
const dialog = document.querySelector("#confirm");
const confirmText = document.querySelector("#confirm-text");
const confirmYes = document.querySelector("#confirm-yes");

let connector = null;
let walletAccount = null;
let viewed = null;
let status = null;

function show(state) {
  empty.hidden = state !== "empty";
  loading.hidden = state !== "loading";
  errorBox.hidden = state !== "error";
  result.hidden = state !== "ready";
  loading.setAttribute("aria-busy", state === "loading" ? "true" : "false");
}

function fail(message) {
  errorBox.textContent = message;
  show("error");
}

function notice(message) {
  const box = document.querySelector("#notice");
  box.hidden = !message;
  box.textContent = message || "";
}

function bytes(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return String(value);
  if (n < 1000) return `${n} B`;
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} KB`;
}

function when(nanoseconds) {
  if (nanoseconds == null || BigInt(nanoseconds) === 0n) return "unknown";
  const date = new Date(Number(BigInt(nanoseconds) / 1_000_000n));
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function accountFrom(raw) {
  const text = raw
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (text.endsWith(".testnet.page"))
    return `${text.slice(0, -".testnet.page".length)}.testnet`;
  return text;
}

async function callView(account, method, args) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "quay",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: account,
        method_name: method,
        args_base64: btoa(JSON.stringify(args ?? {})),
      },
    }),
  });
  if (!response.ok) throw new Error(`RPC returned ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "RPC error");
  const raw = body.result?.result;
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

function preview(account, id) {
  const host = `https://${account.replace(/\.testnet$/, "")}.testnet.page`;
  return id ? `${host}/r/${id}/` : `${host}/`;
}

function render() {
  walletLine.textContent = walletAccount
    ? `Signed in as ${walletAccount}.`
    : "Not signed in. Anyone can read. Only the contract account can change production.";
  signIn.hidden = Boolean(walletAccount);
  signOut.hidden = !walletAccount;
  for (const button of result.querySelectorAll("[data-action]")) {
    const allowed = walletAccount && viewed && walletAccount === viewed;
    button.disabled = !allowed;
  }
}

function fill(account, current, releases, history) {
  status = current;
  viewed = account;
  summary.replaceChildren();
  const lines = [
    ["Account", account],
    ["Version", current.version],
    ["Production", current.production ?? "none"],
    ["Previous", current.previous ?? "none"],
    ["Stored", `${bytes(current.stored_bytes)} of ${bytes(current.max_bytes)}`],
    ["Price", "0.01 NEAR per 1000 bytes"],
  ];
  for (const [name, value] of lines) {
    const row = document.createElement("div");
    const dt = document.createElement("strong");
    dt.textContent = `${name} `;
    row.append(dt, document.createTextNode(String(value)));
    summary.append(row);
  }
  const open = document.createElement("a");
  open.href = preview(account);
  open.textContent = "Open production";
  summary.append(open);

  releaseBody.replaceChildren();
  if (releases.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "This account has no releases.";
    row.append(cell);
    releaseBody.append(row);
  }
  for (const release of releases) {
    const row = document.createElement("tr");
    const role =
      release.id === current.production
        ? "production"
        : release.id === current.previous
          ? "previous"
          : "";
    if (role) row.className = `is-${role}`;
    const cells = [
      release.id,
      when(release.timestamp),
      String(release.file_count),
      bytes(release.bytes),
      release.message || "",
    ];
    for (const value of cells) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const roleCell = document.createElement("td");
    if (role) {
      const badge = document.createElement("span");
      badge.className = `badge ${role}`;
      badge.textContent = role;
      roleCell.append(badge);
    }
    row.append(roleCell);
    const actions = document.createElement("td");
    actions.className = "cell-actions";
    const link = document.createElement("a");
    link.href = preview(account, release.id);
    link.textContent = "Preview";
    actions.append(link);
    if (release.id !== current.production) {
      actions.append(actionButton("Promote", "promote", release.id));
      actions.append(actionButton("Delete", "delete", release.id));
    }
    row.append(actions);
    releaseBody.append(row);
  }

  historyBody.replaceChildren();
  if (history.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = "No promotion history.";
    row.append(cell);
    historyBody.append(row);
  }
  for (const entry of history) {
    const row = document.createElement("tr");
    for (const value of [
      when(entry.timestamp),
      entry.kind,
      entry.release_id,
      entry.previous_id ?? "",
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    historyBody.append(row);
  }
  const rollback = document.querySelector("#rollback");
  rollback.disabled = !current.previous;
  render();
  show("ready");
}

function actionButton(label, action, id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quiet";
  button.dataset.action = action;
  button.dataset.id = id;
  button.textContent = label;
  return button;
}

async function load(account) {
  notice("");
  show("loading");
  try {
    const current = await callView(account, "get_status", {});
    if (!current?.version)
      throw new Error("This account did not answer as a Quay contract.");
    const [releases, history] = await Promise.all([
      listAll(account, "list_releases", "releases"),
      listAll(account, "list_history", "entries"),
    ]);
    fill(account, current, releases, history);
  } catch (error) {
    fail(error.message || "Could not load that account.");
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const account = accountFrom(accountInput.value);
  if (!/^[a-z0-9._-]+\.testnet$/.test(account)) {
    fail("Enter a testnet account, such as quay-harbor.testnet.");
    return;
  }
  const url = new URL(location.href);
  url.searchParams.set("account", account);
  history.replaceState(null, "", url);
  load(account);
});

async function ensureWallet() {
  if (connector) return connector;
  const { NearConnector } = await import(
    "https://esm.sh/@hot-labs/near-connect@0.12.0"
  );
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

signIn.addEventListener("click", async () => {
  signIn.disabled = true;
  try {
    const current = await ensureWallet();
    await current.connect();
    const wallet = await current.wallet();
    const accounts = await wallet.getAccounts();
    walletAccount = accounts[0]?.accountId ?? null;
    render();
  } catch (error) {
    notice(error.message || "The wallet did not sign in.");
  } finally {
    signIn.disabled = false;
  }
});

signOut.addEventListener("click", async () => {
  if (!connector) return;
  await connector.disconnect();
  walletAccount = null;
  render();
});

function ask(text) {
  confirmText.textContent = text;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      confirmYes.removeEventListener("click", onYes);
      resolve(dialog.returnValue === "confirm");
    };
    const onYes = () => dialog.close("confirm");
    confirmYes.addEventListener("click", onYes);
    dialog.addEventListener("close", onClose);
  });
}

result.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  if (walletAccount !== viewed) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  const question =
    action === "delete"
      ? `Delete release ${id}? Its storage unlocks on the contract account.`
      : action === "rollback"
        ? `Roll production back to ${status?.previous}?`
        : `Make release ${id} the production site?`;
  const ok = await ask(question);
  if (!ok) return;
  button.disabled = true;
  try {
    const wallet = await connector.wallet();
    const methodName = action === "rollback" ? "rollback" : action;
    const args = action === "rollback" ? {} : { id };
    await wallet.signAndSendTransaction({
      signerId: walletAccount,
      receiverId: viewed,
      actions: [
        {
          type: "FunctionCall",
          params: { methodName, args, gas: GAS, deposit: "1" },
        },
      ],
    });
    await load(viewed);
  } catch (error) {
    notice(error.message || "The wallet did not send the transaction.");
    button.disabled = false;
  }
});

const initial = new URL(location.href).searchParams.get("account");
if (initial) {
  accountInput.value = initial;
  load(accountFrom(initial));
} else {
  show("empty");
}
