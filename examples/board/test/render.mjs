// A reference renderer for the template syntax in docs/fullstack-interface.md section 4.
// It mirrors contract/src/template.rs (escape set, scope lookup, truthiness, filters,
// includes up to depth 4) so the board's templates can be rendered offline. It also
// reports every path that did not resolve, which the contract silently renders empty.

const ESC = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
  "=": "&#61;",
};
export const escapeHtml = (s) => String(s).replace(/[&<>"'`=]/g, (c) => ESC[c]);
const pct = (s) =>
  [...Buffer.from(String(s))]
    .map((b) =>
      /[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b))
        ? String.fromCharCode(b)
        : `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .join("");

function parse(src) {
  const root = [];
  const stack = [];
  const push = (node) => {
    const top = stack.at(-1);
    (top ? (top.alt ?? top.body) : root).push(node);
  };
  let rest = src;
  for (;;) {
    const open = rest.indexOf("{{");
    if (open === -1) {
      if (rest) push({ text: rest });
      break;
    }
    if (open > 0) push({ text: rest.slice(0, open) });
    const after = rest.slice(open + 2);
    if (after.startsWith("{"))
      throw new Error("raw output {{{ }}} is not supported");
    const close = after.indexOf("}}");
    if (close === -1) throw new Error("unclosed tag");
    const tag = after.slice(0, close).trim();
    rest = after.slice(close + 2);
    if (tag.startsWith("!")) continue;
    if (tag.startsWith("#")) {
      const [word, ...arg] = tag.slice(1).split(/\s+/);
      if (!["each", "if", "unless"].includes(word))
        throw new Error(`unknown block ${word}`);
      stack.push({ kind: word, path: arg.join(" "), body: [], alt: null });
    } else if (tag.startsWith("/")) {
      const frame = stack.pop();
      if (!frame || frame.kind !== tag.slice(1).trim())
        throw new Error(`unexpected ${tag}`);
      push({
        block: frame.kind,
        path: frame.path,
        body: frame.body,
        alt: frame.alt ?? [],
      });
    } else if (tag === "else") {
      const top = stack.at(-1);
      if (!top || top.alt) throw new Error("bad {{else}}");
      top.alt = [];
    } else if (tag.startsWith(">")) {
      push({ include: tag.slice(1).trim() });
    } else {
      const [path, filter] = tag.split("|").map((x) => x.trim());
      if (
        filter &&
        !["date", "json", "url", "lines", "near", "count"].includes(filter)
      )
        throw new Error(`unknown filter ${filter}`);
      push({ path, filter });
    }
  }
  if (stack.length) throw new Error(`unclosed ${stack.at(-1).kind} block`);
  return root;
}

const MISSING = Symbol("missing");
function walk(value, path) {
  for (const seg of path.split(".")) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      seg in value
    )
      value = value[seg];
    else if (
      Array.isArray(value) &&
      /^\d+$/.test(seg) &&
      Number(seg) < value.length
    )
      value = value[Number(seg)];
    else return MISSING;
  }
  return value;
}
function resolve(scopes, path) {
  if (path === "@index") {
    for (let i = scopes.length - 1; i >= 0; i -= 1)
      if (scopes[i].index != null) return scopes[i].index;
    return MISSING;
  }
  const top = scopes.at(-1).value;
  if (path === "." || path === "this") return top;
  if (path.startsWith("this.")) return walk(top, path.slice(5));
  const first = path.split(".")[0];
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const v = scopes[i].value;
    if (v && typeof v === "object" && !Array.isArray(v) && first in v)
      return walk(v, path);
  }
  return MISSING;
}
const truthy = (v) =>
  v !== MISSING &&
  v !== null &&
  v !== false &&
  v !== 0 &&
  v !== "" &&
  !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

function plain(v) {
  if (v === MISSING || v === null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
function near(yocto) {
  const y = BigInt(yocto);
  const frac = ((y % 10n ** 24n) * 10_000n) / 10n ** 24n;
  return `${y / 10n ** 24n}.${String(frac).padStart(4, "0")}`;
}
function applyFilter(v, filter) {
  if (!filter) return escapeHtml(plain(v));
  if (filter === "date") {
    if (v === MISSING || v == null) return "";
    const ms = Number(BigInt(v) / 1_000_000n);
    return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
  if (filter === "near") return v === MISSING ? "" : near(v);
  if (filter === "count")
    return String(
      Array.isArray(v)
        ? v.length
        : v && typeof v === "object"
          ? Object.keys(v).length
          : typeof v === "string"
            ? [...v].length
            : 0,
    );
  if (filter === "json")
    return v === MISSING ? "" : escapeHtml(JSON.stringify(v));
  if (filter === "url") return pct(plain(v));
  return plain(v)
    .split("\n")
    .map((l) => escapeHtml(l.replace(/\r$/, "")))
    .join("<br>");
}

/**
 * render(template path, ctx, { read, onMissing }) -> html. `read(path)` returns a file's text or null.
 * onMissing(path, from) is called for every unresolved variable or block path.
 */
export function render(path, ctx, { read, onMissing = () => {} }) {
  const out = [];
  const run = (nodes, scopes, depth, from) => {
    for (const node of nodes) {
      if (node.text != null) out.push(node.text);
      else if (node.include) {
        if (depth >= 4) throw new Error("includes nest deeper than 4");
        const src = read(node.include);
        if (src == null) throw new Error(`include ${node.include} missing`);
        run(parse(src), scopes, depth + 1, node.include);
      } else if (node.block) {
        const v = resolve(scopes, node.path);
        if (v === MISSING && node.block !== "each")
          onMissing(node.path, from, "block");
        if (node.block === "each") {
          if (Array.isArray(v) && v.length)
            for (const [index, item] of v.entries())
              run(node.body, [...scopes, { value: item, index }], depth, from);
          else run(node.alt, scopes, depth, from);
        } else {
          run(
            truthy(v) !== (node.block === "unless") ? node.body : node.alt,
            scopes,
            depth,
            from,
          );
        }
      } else {
        const v = resolve(scopes, node.path);
        if (v === MISSING) onMissing(node.path, from, "var");
        out.push(applyFilter(v, node.filter));
      }
    }
  };
  const src = read(path);
  if (src == null) throw new Error(`template ${path} missing`);
  run(parse(src), [{ value: ctx, index: null }], 0, path);
  return out.join("");
}

/** Every path a template (and its includes) reads, for shape checks. */
export function includesOf(src) {
  return [...src.matchAll(/\{\{>\s*([^\s}]+)\s*\}\}/g)].map((m) => m[1]);
}
