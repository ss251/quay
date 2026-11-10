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
    root.dataset.theme = isDark() ? "light" : "dark";
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
    setTimeout(() => {
      button.setAttribute("aria-label", before);
      delete button.dataset.copied;
    }, 1500);
  } catch {}
});
