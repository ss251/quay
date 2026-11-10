const key = "quay-theme";
const root = document.documentElement;
const stored = localStorage.getItem(key);
if (stored === "light" || stored === "dark") root.dataset.theme = stored;

const button = document.querySelector("[data-theme-toggle]");
if (button) {
  const label = () => {
    const dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    button.textContent = dark ? "Light" : "Dark";
    button.setAttribute("aria-pressed", dark ? "true" : "false");
  };
  label();
  button.addEventListener("click", () => {
    const dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    localStorage.setItem(key, root.dataset.theme);
    label();
  });
}
