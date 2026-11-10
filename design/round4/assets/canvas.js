// Draws canvas edges between nodes. A stage holds data-edges="from>to|mode|label; ...",
// where mode is h (right side to left side) or v (bottom to top) and label names the call.
const NS = "http://www.w3.org/2000/svg";
export function drawEdges(stage) {
  const svg = stage.querySelector("svg.edges");
  if (!svg || !stage.dataset.edges) return;
  const box = stage.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  svg.replaceChildren();
  for (const old of stage.querySelectorAll(".edge-label")) old.remove();
  if (getComputedStyle(svg).display === "none") return;
  for (const spec of stage.dataset.edges.split(";")) {
    const [pair, mode = "h", label = ""] = spec.trim().split("|");
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
      const x1 = x(a.right), y1 = y(a.top + a.height / 2), x2 = x(b.left), y2 = y(b.top + Math.min(b.height / 2, 60));
      const m = Math.max((x2 - x1) / 2, 18);
      d = `M${x1} ${y1} C ${x1 + m} ${y1}, ${x2 - m} ${y2}, ${x2} ${y2}`;
    }
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
    if (label) {
      // vertical edges share their start, so their labels sit nearer the far end
      const mid = path.getPointAtLength(path.getTotalLength() * (mode === "v" ? 0.68 : 0.5));
      const tag = document.createElement("span");
      tag.className = "edge-label";
      tag.textContent = label;
      tag.style.left = `${mid.x}px`;
      tag.style.top = `${mid.y}px`;
      stage.append(tag);
    }
  }
}
export function drawAll() {
  for (const stage of document.querySelectorAll(".stage[data-edges]")) drawEdges(stage);
}
drawAll();
// one redraw per frame while the window is being resized, not one per resize event
let queued = false;
addEventListener("resize", () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    drawAll();
  });
});
document.fonts?.ready.then(drawAll);
