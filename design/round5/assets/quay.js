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
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("no-trans")));
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
  const tabs = [...demo.querySelectorAll('[role="tab"]')];
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
    frame.title = `Release ${tab.querySelector(".lg-id").textContent} of the sample site`;
    demo.querySelector('[role="tabpanel"]').setAttribute("aria-labelledby", tab.id);
    demo.querySelector("[data-demo-url]").textContent = url.replace("https://", "");
    demo.querySelector("[data-demo-open]").href = url;
  };
  // The gateway is a third party and sometimes fails. A network failure or 10 s of silence shows a plain
  // failure state over the frame. (A gateway error page that loads cannot be detected cross-origin.)
  const fail = demo.querySelector(".frame-fail");
  let timer;
  const failed = () => { clearTimeout(timer); delete frame.dataset.loading; fail.hidden = false; };
  const watch = (url) => {
    fail.hidden = true;
    clearTimeout(timer);
    if (new URLSearchParams(location.search).get("gateway") === "down") return failed(); // mock switch
    timer = setTimeout(failed, 10000);
    fetch(url, { mode: "no-cors", cache: "no-store" }).catch(failed);
  };
  frame.addEventListener("load", () => { clearTimeout(timer); delete frame.dataset.loading; });
  demo.querySelector("[data-demo-retry]").addEventListener("click", () => {
    frame.dataset.loading = "";
    frame.src = frame.src;
    watch(frame.src);
  });
  watch(frame.src);
  demo.addEventListener("click", (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && tab.getAttribute("aria-selected") !== "true") select(tab);
  });
  demo.addEventListener("keydown", (event) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    tab.focus();
    select(tab);
  });
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
