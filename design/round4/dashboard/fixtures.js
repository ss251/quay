// Mock-only data and renderer for the dashboard (never shipped). ?data=demo|worst|empty|one picks a fixture.
// Worst-case values come from the contract's limits in contract/src/types.rs:
// MAX_RELEASES 32 kept at once (ids keep counting), MAX_MESSAGE_CHARS 200, MAX_FILES 64,
// MAX_STORED_BYTES 2,000,000, and NEAR account ids up to 64 characters.
const nf = new Intl.NumberFormat("en-US");
const B = (n) => `${nf.format(n)} B`;
const plural = (n, one, many) => `${nf.format(n)} ${n === 1 ? one : many}`;

const demoReleases = [
  [5, "harbour office, new look", 8, 8910, "Nov 10, 16:51"],
  [4, "harbour office", 8, 6280, "Nov 10, 14:38"],
  [3, "latest preview", 6, 2754, "Nov 10, 14:06"],
  [2, "tide log linked", 6, 2754, "Nov 10, 14:06"],
  [1, "harbour opens", 6, 2754, "Nov 10, 14:05"],
];
const long =
  "Rebuild the berth board for the winter timetable, move the tide log under /log/2026/, add the Polish and Vietnamese pages (Plan nabrzeża, Kế hoạch bến tàu) and cut the hero image to a 40 KB webp";
const worstReleases = Array.from({ length: 32 }, (_, i) => {
  const id = 147 - i;
  const msg = id === 147 ? long : id === 146 ? "wip" : id === 145 ? "" : `nightly ${id}`;
  return [id, msg, id === 147 ? 64 : 12, id === 147 ? 1912448 : 41200 + id, `Nov ${10 - Math.floor(i / 6)}, ${String(23 - (i % 6) * 3).padStart(2, "0")}:0${i % 10}`];
});

export const fixtures = {
  demo: {
    account: "quay-65nqd3rn.testnet", stored: 17717, prod: 5, prev: 4, releases: demoReleases,
    promoted: "Nov 10, 16:51 UTC", hash: "f3fde7b5…cce8",
    keys: { full: ["ed25519:27sRhfJZebb3…"], ci: ["ed25519:DaAfMdDQ8hdV…"] },
    history: [["Promoted 5, previous 4", "Nov 10, 16:51"], ["Promoted 4, previous 2", "Nov 10, 14:38"], ["Rolled back to 2 from 3", "Nov 10, 14:06"]],
  },
  worst: {
    account: "northwind-harbour-office-preview-environment-2026.testnet", stored: 1998112, prod: 140, prev: 147, releases: worstReleases,
    promoted: "Nov 10, 23:09 UTC", hash: "0c9e41aa…7b20",
    keys: { full: ["ed25519:27sRhfJZebb3…", "ed25519:9QwErTyUiOp1…"], ci: ["ed25519:DaAfMdDQ8hdV…", "ed25519:4xZcVbNmLkJh…", "ed25519:HgFdSaPoIuYt…", "ed25519:7MnBvCxZaSdF…"] },
    history: [["Rolled back to 140 from 147", "Nov 10, 23:09"], ["Promoted 147, previous 140", "Nov 10, 22:40"], ["Deleted 115", "Nov 10, 22:39"]],
  },
  empty: { account: "quay-new-account.testnet", stored: 0, prod: null, prev: null, releases: [], keys: { full: ["ed25519:27sRhfJZebb3…"], ci: [] }, history: [] },
  one: {
    account: "quay-65nqd3rn.testnet", stored: 2754, prod: 1, prev: null, releases: [[1, "harbour opens", 6, 2754, "Nov 10, 14:05"]],
    promoted: "Nov 10, 14:05 UTC", hash: "a1b2c3d4…e5f6",
    keys: { full: ["ed25519:27sRhfJZebb3…"], ci: [] }, history: [["Promoted 1", "Nov 10, 14:05"]],
  },
};

// The track shows at most 8 marks: the newest releases, always including production and previous.
function trackIds(d) {
  const ids = d.releases.map((r) => r[0]).sort((a, b) => a - b);
  if (ids.length <= 8) return { ids, earlier: 0 };
  const keep = new Set([d.prod, d.prev].filter(Boolean));
  for (const id of ids.slice().reverse()) { if (keep.size >= 8) break; keep.add(id); }
  const shown = ids.filter((id) => keep.has(id));
  return { ids: shown, earlier: ids.length - shown.length };
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function render(d) {
  const $ = (s) => document.querySelector(s);
  for (const el of document.querySelectorAll("[data-account]")) { el.textContent = d.account; el.title = d.account; }
  const host = d.account.replace(/\.testnet$/, ".testnet.page");
  $("[data-host]").firstChild.textContent = host;
  document.title = `${d.account} on Quay`;
  const n = d.releases.length;
  $("[data-site-sub]").textContent = n ? `${plural(n, "release", "releases")}, ${B(d.stored)} stored` : "No releases yet";
  $("[data-meta-count]").textContent = plural(n, "release", "releases");
  $("[data-meta-stored]").textContent = `${B(d.stored)} stored`;
  // track
  const wrap = $("#track");
  if (!n) {
    wrap.outerHTML = `<span id="track" class="node-empty">Nothing is live yet. <code>quay deploy ./dist</code> seals release 1.</span>`;
  } else {
    const { ids, earlier } = trackIds(d);
    const i = ids.indexOf(d.prod);
    wrap.innerHTML = `<ol class="track" aria-label="${earlier ? `Latest ${ids.length} of ${n} releases. ` : ""}Production is ${d.prod}${d.prev ? `, previous is ${d.prev}` : ""}.">${ids
      .map((id) => `<li class="${id === d.prod ? "is-prod" : id === d.prev ? "is-prev" : ""}"><i aria-hidden="true"></i><span>${id}</span></li>`)
      .join("")}</ol><span class="track-ptr" aria-hidden="true" style="--n:${ids.length};--i:${i}"${i === 0 && ids.length > 1 ? ' data-edge="start"' : i === ids.length - 1 && ids.length > 1 ? ' data-edge="end"' : ""}><span class="ptr ptr-down">production</span></span>${earlier ? `<span class="track-more">${plural(earlier, "earlier release", "earlier releases")}</span>` : ""}`;
  }
  $("[data-site-foot]").textContent = d.promoted ? `Promoted ${d.promoted}` : "Nothing promoted yet";
  // keys
  const keyNode = (sel, list, none, one, many) => {
    const node = $(sel);
    node.querySelector(".node-name").textContent = list.length > 1 ? `${many} (${list.length})` : one;
    const sub = node.querySelector(".node-sub");
    sub.textContent = list.length ? `${list[0]}${list.length > 1 ? ` and ${list.length - 1} more` : ""}` : none;
    sub.classList.toggle("mono", list.length > 0); // key ids are mono; the sentence is not
  };
  keyNode('[data-node="owner"]', d.keys.full, "None", "Full-access key", "Full-access keys");
  keyNode('[data-node="ci"]', d.keys.ci, "None yet. quay keys create --ci adds one", "Publish-only key", "Publish-only keys");
  // sheet: production card
  const card = $(".live-card");
  if (!n) {
    card.outerHTML = `<section class="live-card is-empty" aria-label="Production"><div class="lc-main"><strong>Nothing is live yet</strong><p class="lc-msg">Deploy a folder to seal release 1, then promote it to put it on ${esc(host)}.</p><pre class="lc-cmd">quay deploy ./dist -m "first release"\nquay promote 1</pre></div></section>`;
  } else {
    const p = d.releases.find((r) => r[0] === d.prod);
    card.querySelector(".top strong").textContent = `Release ${p[0]}`;
    card.querySelector(".lc-msg").textContent = p[1] || "No message";
    card.querySelector(".lc-msg").classList.toggle("faint", !p[1]);
    const dd = card.querySelectorAll(".facts-line dd");
    dd[0].textContent = d.promoted; dd[1].textContent = `${plural(p[2], "file", "files")}, ${B(p[3])}`; dd[2].textContent = d.hash;
    const rb = card.querySelector("#rollback");
    rb.disabled = !d.prev;
    rb.querySelector("span").textContent = d.prev ? `Roll back to ${d.prev}` : "No release to roll back to";
  }
  // sheet: rows (newest first; the sheet shows 8, the Releases tab shows all)
  const rows = d.releases.slice(0, 8)
    .map(([id, msg, files, bytes, when]) => {
      const badge = id === d.prod ? `<span class="ptr">production</span>` : id === d.prev ? `<span class="chip chip-prev">previous</span>` : "";
      const act = id === d.prod ? "" : `<button class="btn btn-sm" type="button" aria-label="Promote release ${id} to production">Promote</button>`;
      return `<li class="rel-row"><span class="id">${id}</span><div class="msg"><span class="l1"><span class="m${msg ? "" : " faint"}" title="${esc(msg)}">${esc(msg || "No message")}</span>${badge}</span><span class="l2 num">${plural(files, "file", "files")}, ${B(bytes)}</span></div><span class="when">${when}</span><div class="acts">${act}</div></li>`;
    })
    .join("");
  const list = $(".sp-body .rows");
  if (n) list.innerHTML = rows; else list.closest(".sp-section").remove();
  const all = $(".sp-section h3 a");
  if (all) all.textContent = n > 8 ? `All ${n} releases` : "All releases";
  $(".sp-body .timeline").innerHTML = d.history.length
    ? d.history.map(([w, t]) => `<li><span class="what">${w}</span><span class="when">${t}</span></li>`).join("")
    : `<li><span class="what faint">No changes yet</span></li>`;
}
