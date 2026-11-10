// Draws canvas edges from node positions. Stage holds data-edges="a>b:kind:mode ...",
// kind is flow | soon | plain, mode is h (right side to left side) or v (bottom to top).
const NS = "http://www.w3.org/2000/svg";
export function drawEdges(stage) {
  const svg = stage.querySelector("svg.edges");
  if (!svg || !stage.dataset.edges) return;
  const box = stage.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  svg.replaceChildren();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let n = 0;
  for (const spec of stage.dataset.edges.trim().split(/\s+/)) {
    const [pair, kind = "plain", mode = "h"] = spec.split(":");
    const [from, to] = pair.split(">");
    const a = stage.querySelector(`[data-node="${from}"]`)?.getBoundingClientRect();
    const b = stage.querySelector(`[data-node="${to}"]`)?.getBoundingClientRect();
    if (!a || !b) continue;
    const x = (v) => v - box.left;
    const y = (v) => v - box.top;
    let d;
    if (mode === "v") {
      const x1 = x(a.left + a.width / 2), y1 = y(a.bottom), x2 = x(b.left + b.width / 2), y2 = y(b.top);
      const m = (y2 - y1) / 2;
      d = `M${x1} ${y1} C ${x1} ${y1 + m}, ${x2} ${y2 - m}, ${x2} ${y2}`;
    } else {
      const x1 = x(a.right), y1 = y(a.top + Math.min(a.height / 2, 42)), x2 = x(b.left), y2 = y(b.top + Math.min(b.height / 2, 42));
      const m = Math.max((x2 - x1) / 2, 18);
      d = `M${x1} ${y1} C ${x1 + m} ${y1}, ${x2 - m} ${y2}, ${x2} ${y2}`;
    }
    const path = document.createElementNS(NS, "path");
    const id = `edge-${stage.id || "s"}-${n++}`;
    path.setAttribute("d", d);
    path.setAttribute("id", id);
    if (kind !== "plain") path.setAttribute("class", kind);
    svg.append(path);
    if ((kind === "flow" || kind === "deploy") && !reduce) {
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("r", kind === "deploy" ? "4" : "3.5");
      dot.setAttribute("class", kind === "deploy" ? "packet" : "packet req");
      const move = document.createElementNS(NS, "animateMotion");
      move.setAttribute("dur", kind === "deploy" ? "2.6s" : "1.6s");
      move.setAttribute("repeatCount", "indefinite");
      move.setAttribute("begin", `${(n % 3) * 0.5}s`);
      const mpath = document.createElementNS(NS, "mpath");
      mpath.setAttribute("href", `#${id}`);
      move.append(mpath);
      dot.append(move);
      svg.append(dot);
    }
  }
}
export function drawAll() {
  for (const stage of document.querySelectorAll(".stage[data-edges]")) drawEdges(stage);
}
drawAll();
addEventListener("resize", drawAll);
document.fonts?.ready.then(drawAll);
