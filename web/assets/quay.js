const key = "quay-theme";
const root = document.documentElement;
try {
  const stored = localStorage.getItem(key);
  if (stored === "light" || stored === "dark") root.dataset.theme = stored;
} catch {}

const isDark = () =>
  root.dataset.theme
    ? root.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;

for (const button of document.querySelectorAll("[data-theme-toggle]")) {
  const label = () =>
    button.setAttribute(
      "aria-label",
      isDark() ? "Use the light theme" : "Use the dark theme",
    );
  label();
  button.addEventListener("click", () => {
    // switch without each component running its own transition
    root.classList.add("no-trans");
    root.dataset.theme = isDark() ? "light" : "dark";
    requestAnimationFrame(() =>
      requestAnimationFrame(() => root.classList.remove("no-trans")),
    );
    try {
      localStorage.setItem(key, root.dataset.theme);
    } catch {}
    label();
  });
}

// Copy buttons: data-copy holds the text, or data-copy-from names an element.
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy], [data-copy-from]");
  if (!button) return;
  const source = button.dataset.copyFrom
    ? document.getElementById(button.dataset.copyFrom)?.innerText
    : button.dataset.copy;
  if (!source) return;
  try {
    await navigator.clipboard.writeText(source.trim());
    const before = button.getAttribute("aria-label") || "";
    button.setAttribute("aria-label", "Copied");
    button.dataset.copied = "";
    const use = button.querySelector("use");
    const icon = use?.getAttribute("href");
    use?.setAttribute("href", icon.replace(/#i-[a-z]+$/, "#i-check"));
    setTimeout(() => {
      if (use) use.setAttribute("href", icon);
      button.setAttribute("aria-label", before);
      delete button.dataset.copied;
    }, 1500);
  } catch {}
});

// Home demo: each sealed release still answers at its own URL, so the frame can load any of them.
// The release list is a vertical tablist: click, or arrow keys, Home and End.
const demo = document.querySelector("[data-demo]");
if (demo) {
  let tabs = [...demo.querySelectorAll('[role="tab"]')];
  const frame = demo.querySelector("[data-demo-frame]");
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    }
    const url = tab.dataset.src;
    frame.dataset.loading = "";
    frame.src = url;
    watch(url);
    frame.title = `Release ${tab.querySelector(".lg-id").textContent} of Harbour Board`;
    demo
      .querySelector('[role="tabpanel"]')
      .setAttribute("aria-labelledby", tab.id);
    demo.querySelector("[data-demo-url]").textContent = url.replace(
      "https://",
      "",
    );
    demo.querySelector("[data-demo-open]").href = url;
  };
  // The gateway is a third party and sometimes fails. A network failure or 10 s of silence shows a plain
  // failure state over the frame. (A gateway error page that loads cannot be detected cross-origin.)
  const fail = demo.querySelector(".frame-fail");
  let timer;
  const failed = () => {
    clearTimeout(timer);
    delete frame.dataset.loading;
    fail.hidden = false;
  };
  const watch = (url) => {
    fail.hidden = true;
    clearTimeout(timer);
    timer = setTimeout(failed, 10000);
    fetch(url, { mode: "no-cors", cache: "no-store" }).catch(failed);
  };
  frame.addEventListener("load", () => {
    clearTimeout(timer);
    delete frame.dataset.loading;
  });
  demo.querySelector("[data-demo-retry]").addEventListener("click", () => {
    const url = frame.src;
    frame.dataset.loading = "";
    frame.src = url;
    watch(url);
  });
  watch(frame.src);
  demo.addEventListener("click", (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && tab.getAttribute("aria-selected") !== "true") select(tab);
  });
  demo.addEventListener("keydown", (event) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = {
      ArrowDown: i + 1,
      ArrowUp: i - 1,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    tab.focus();
    select(tab);
  });
  refreshReleases(demo, () => {
    tabs = [...demo.querySelectorAll('[role="tab"]')];
  });
}

// The release list is baked into the page; read the live list from the chain so a
// release sealed after this page was built shows up. On any failure the baked list stays.
async function refreshReleases(box, done) {
  const account = box.dataset.account;
  const origin = box.dataset.host;
  if (!account || !origin) return;
  const view = async (method, args) => {
    const response = await fetch("https://test.rpc.fastnear.com", {
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
          args_base64: btoa(JSON.stringify(args)),
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.json();
    return JSON.parse(
      new TextDecoder().decode(Uint8Array.from(body.result.result)),
    );
  };
  try {
    const [status, page] = await Promise.all([
      view("get_status", {}),
      view("list_releases", { from_index: 0, limit: 50 }),
    ]);
    const list = box.querySelector('[role="tablist"]');
    const shown = [...list.children].map((b) => b.id).join();
    const ids = page.releases
      .map((r) => `rel-${r.id}`)
      .reverse()
      .join();
    if (shown === ids && box.querySelector(`#rel-${status.production} .ptr`))
      return;
    if (
      box.querySelector('[aria-selected="true"]')?.id !==
      `rel-${status.production}`
    )
      return; // the visitor already picked a release; leave the list alone
    const nf = new Intl.NumberFormat("en-US");
    const rows = [...page.releases].reverse().map((r) => {
      const on = r.id === status.production;
      const row = document.createElement("button");
      row.className = "lg-row";
      row.type = "button";
      row.setAttribute("role", "tab");
      row.id = `rel-${r.id}`;
      row.setAttribute("aria-controls", "demo-panel");
      row.setAttribute("aria-selected", String(on));
      row.tabIndex = on ? 0 : -1;
      row.dataset.src = on ? `${origin}/` : `${origin}/r/${r.id}/`;
      const id = Object.assign(document.createElement("span"), {
        className: "lg-id",
        textContent: r.id,
      });
      const msg = Object.assign(document.createElement("span"), {
        className: "lg-msg",
        textContent: r.message || `Release ${r.id}`,
      });
      msg.append(
        Object.assign(document.createElement("small"), {
          textContent: `${r.file_count} files, ${nf.format(Number(r.bytes))}\u00a0B`,
        }),
      );
      row.append(id, msg);
      if (on)
        row.append(
          Object.assign(document.createElement("span"), {
            className: "ptr",
            textContent: "production",
          }),
        );
      else if (r.id === status.previous)
        row.append(
          Object.assign(document.createElement("span"), {
            className: "chip chip-prev",
            textContent: "previous",
          }),
        );
      return row;
    });
    list.replaceChildren(...rows);
    box.querySelector("[data-demo-count]").textContent =
      `${rows.length} release${rows.length === 1 ? "" : "s"}`;
    box.querySelector("[data-demo-prod]").textContent = status.production;
    box
      .querySelector('[role="tabpanel"]')
      .setAttribute("aria-labelledby", `rel-${status.production}`);
    done();
  } catch {}
}

// Returning visitors: the dashboard remembers the last account it opened, so the hero offers that account.
try {
  const last = localStorage.getItem("quay-account");
  if (last && /^[a-z0-9._-]+\.testnet$/.test(last)) {
    for (const link of document.querySelectorAll("[data-cta-account]")) {
      const url = new URL(link.getAttribute("href"), location.href);
      url.searchParams.set("account", last);
      link.href = url.href;
      if (link.dataset.ctaAccount !== "href") link.textContent = `Open ${last}`;
    }
  }
} catch {}
