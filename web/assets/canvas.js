// Draws canvas edges between nodes. A stage holds data-edges="from>to|mode|label; ...",
// where mode is h (right side to left side), r (left side to right side) or v (bottom to top)
// and label names the call.
const NS = "http://www.w3.org/2000/svg";
// Fit the stage into the canvas width that is free (beside an open sheet), never above 1:1.
function fit(stage) {
  const canvas = stage.closest(".canvas");
  if (!canvas || matchMedia("(max-width: 1000px)").matches) {
    stage.style.transform = "";
    return;
  }
  const panel = document.querySelector(".side-panel[data-open]");
  const free =
    canvas.clientWidth -
    (panel && canvas.closest(".app-body") ? panel.offsetWidth + 36 : 0) -
    16;
  const k = Math.min(1, free / stage.offsetWidth);
  // fit never shrinks text below about 11px; past that the canvas scrolls instead
  stage.style.transformOrigin = "0 0";
  // beside an open sheet the stage starts at the canvas edge instead of centring under the sheet
  stage.style.margin = panel && canvas.closest(".app-body") ? "0 0 0 16px" : "";
  stage.style.transform = k < 1 ? `scale(${k})` : "";
  stage.style.marginBottom = k < 1 ? `${(k - 1) * stage.offsetHeight}px` : "";
}
export function drawEdges(stage) {
  const svg = stage.querySelector("svg.edges");
  if (!svg || !stage.dataset.edges) return;
  fit(stage);
  const box = stage.getBoundingClientRect();
  const k = box.width / stage.offsetWidth; // stage may be scaled; draw in its own units
  svg.setAttribute("viewBox", `0 0 ${stage.offsetWidth} ${stage.offsetHeight}`);
  svg.replaceChildren();
  for (const old of stage.querySelectorAll(".edge-label")) old.remove();
  if (getComputedStyle(svg).display === "none") return;
  for (const spec of stage.dataset.edges.split(";")) {
    const [pair, mode = "h", label = ""] = spec.trim().split("|");
    const [from, to] = pair.split(">");
    const a = stage
      .querySelector(`[data-node="${from}"]`)
      ?.getBoundingClientRect();
    const b = stage
      .querySelector(`[data-node="${to}"]`)
      ?.getBoundingClientRect();
    if (!a || !b) continue;
    const x = (v) => (v - box.left) / k;
    const y = (v) => (v - box.top) / k;
    let d;
    if (mode === "v") {
      const x1 = x(a.left + a.width / 2),
        y1 = y(a.bottom),
        x2 = x(b.left + b.width / 2),
        y2 = y(b.top);
      const m = (y2 - y1) / 2;
      d = `M${x1} ${y1} C ${x1} ${y1 + m}, ${x2} ${y2 - m}, ${x2} ${y2}`;
    } else if (mode === "r") {
      // right to left: from the source's left side to the target's right side
      const x1 = x(a.left),
        y1 = y(a.top + a.height / 2),
        x2 = x(b.right),
        y2 = y(b.top + Math.min(b.height / 2, 60));
      const m = Math.max((x1 - x2) / 2, 18);
      d = `M${x1} ${y1} C ${x1 - m} ${y1}, ${x2 + m} ${y2}, ${x2} ${y2}`;
    } else {
      const x1 = x(a.right),
        y1 = y(a.top + a.height / 2),
        x2 = x(b.left),
        y2 = y(b.top + Math.min(b.height / 2, 60));
      const m = Math.max((x2 - x1) / 2, 18);
      d = `M${x1} ${y1} C ${x1 + m} ${y1}, ${x2 - m} ${y2}, ${x2} ${y2}`;
    }
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
    if (label) {
      // vertical edges share their start, so their labels sit nearer the far end
      const mid = path.getPointAtLength(
        path.getTotalLength() * (mode === "v" ? 0.68 : 0.5),
      );
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
  for (const stage of document.querySelectorAll(".stage[data-edges]"))
    drawEdges(stage);
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
