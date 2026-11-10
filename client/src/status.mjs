// Layer status (docs/fullstack-interface.md section 11). Read-only; works in a browser and in Node 20+.
// One call measures eight layers, each with its own timeout, so one failure never hides the others.
import { createRpc, DEFAULT_RPC } from "./rpc.mjs";

export { DEFAULT_RPC };
export const LAYERS = ["site", "gateway", "data", "functions", "routes", "relay", "cron", "keys"];
const OUTLAYER = "https://testnet-api.outlayer.ai";
const MIN_RELAY_YOCTO = 5n * 10n ** 22n; // 0.05 NEAR

const layer = (state, summary, metrics = {}, links = [], error = null) => ({ state, summary, metrics, links, error });
const off = (summary) => layer("off", summary);
const fail = (summary, error) => layer("down", summary, {}, [], String(error?.message ?? error));

const METHOD_MISSING = /MethodNotFound|MethodResolveError|CodeDoesNotExist|no contract code|is not deployed|method .* not found/i;
const ACCOUNT_MISSING = /does not exist|UNKNOWN_ACCOUNT/i;
export const isMethodMissing = (e) => METHOD_MISSING.test(String(e?.message ?? e));
export const isAccountMissing = (e) => ACCOUNT_MISSING.test(String(e?.message ?? e));

const host = (site) => `${site.replace(/\.testnet$/, "")}.testnet.page`;
const explorer = (account) => `https://explorer.testnet.near.org/accounts/${account}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const near = (yocto) => `${(Number(BigInt(yocto || 0) / 10n ** 20n) / 10000).toFixed(4)}`;

/** A list that a view may return as an array, a `{key: [...]}` page, or a `{name: spec}` map. */
export function rows(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (key && Array.isArray(value[key])) return value[key];
    return Object.entries(value).map(([name, spec]) => ({ name, ...spec }));
  }
  return [];
}

/** A sample path for a route pattern: ":id" becomes 1, "*rest" becomes nothing. */
export const samplePath = (pattern) => pattern.replace(/:[A-Za-z_]\w*/g, "1").replace(/\/?\*\w*$/, "/") || "/";

// ---- chain reads ----
// rpc is a URL or a query function (params) => result; the dashboard passes its own fallback client.
function querier({ rpc, fetch: f }) {
  if (typeof rpc === "function") return rpc;
  const client = createRpc({ url: rpc, fetch: f }); // a URL, a list, or nothing for the default failover list
  return (params) => client.call("query", { finality: "final", ...params });
}

function reader(query) {
  return {
    query,
    async view(account, method, args = {}) {
      const res = await query({ request_type: "call_function", account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) });
      if (res?.error) throw new Error(res.error);
      const text = new TextDecoder().decode(Uint8Array.from(res?.result ?? []));
      return text ? JSON.parse(text) : null;
    },
    /** Like view, but a missing method answers undefined (the layer is off). */
    async maybe(account, method, args) {
      try {
        return await this.view(account, method, args);
      } catch (e) {
        if (isMethodMissing(e)) return undefined;
        throw e;
      }
    },
  };
}

// ---- layers ----
async function siteLayer({ r, site, memo }) {
  const [status, version] = await Promise.all([memo.status(), r.maybe(site, "get_version")]);
  const metrics = { version: status.version, releases: status.release_count, production: status.production ?? "", stored_bytes: Number(status.stored_bytes), max_bytes: Number(status.max_bytes), standard: version?.standard ?? "quay" };
  const links = [{ label: "Account", href: explorer(site) }];
  if (!status.production) return layer("warn", "No release is in production", metrics, links, "nothing promoted yet");
  links.unshift({ label: "Open production", href: `https://${host(site)}/` });
  return layer("ok", `Production is release ${status.production} of ${status.release_count}`, metrics, links);
}

// One gateway host: a timed GET. A JSON body that says the RPC is deprecated is down even at HTTP 200.
async function checkHost(o, url, signal, now, self) {
  const started = now();
  try {
    const res = await o.fetch(url, { signal, cache: "no-store" });
    const ms = now() - started;
    const text = (await res.text().catch(() => "")).slice(0, 4000);
    const out = { ok: false, ms, status: res.status, error: null };
    if (/^\s*\{/.test(text) && /deprecated/i.test(text)) out.error = "the gateway still calls the deprecated rpc.testnet.near.org";
    else if (!res.ok) out.error = `HTTP ${res.status}`;
    else if (self) {
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      if (body?.ok === false) out.error = body.error ?? "health check failed";
      else if (body?.rpc) out.rpc = body.rpc;
    }
    out.ok = !out.error;
    return out;
  } catch (e) {
    return { ok: false, ms: now() - started, status: 0, error: e.name === "AbortError" ? "no answer in time" : e.message };
  }
}

async function gatewayLayer({ o, site, signal, now }) {
  const pub = `https://${host(site)}`;
  const targets = [];
  if (o.gateway) targets.push(["local", `${o.gateway.replace(/\/+$/, "")}/_quay/health`, true]);
  if (o.mirror) targets.push(["mirror", o.probe ? null : `${o.mirror.replace(/\/+$/, "")}/`, false]);
  if (o.probe) targets.push(["public", null, false]);
  else if (!o.gateway || o.mirror) targets.push(["public", `${pub}/`, false]);
  const got = await Promise.all(
    targets.map(async ([name, url, self]) => [name, url ? await checkHost(o, url, signal, now, self) : ((p) => ({ ok: p.ok, ms: p.ms ?? 0, status: p.ok ? 200 : 0, error: p.ok ? null : (p.reason ?? "no answer") }))(await o.probe(name))]),
  );
  const metrics = {};
  const links = [];
  const label = { local: "Local gateway", mirror: "Mirror", public: "Public testnet.page" };
  for (const [name, c] of got) {
    metrics[name] = c.ok ? "ok" : "down";
    metrics[`${name}_ms`] = c.ms;
    if (c.rpc) metrics.rpc = c.rpc;
    links.push({ label: label[name], href: name === "local" ? `${o.gateway.replace(/\/+$/, "")}/` : name === "mirror" ? `${o.mirror.replace(/\/+$/, "")}/` : `${pub}/` });
  }
  for (const n of ["mirror", "public"]) if (!(n in metrics)) metrics[n] = "off";
  const up = got.filter(([, c]) => c.ok);
  const down = got.filter(([, c]) => !c.ok);
  const why = down.map(([n, c]) => `${label[n]}: ${c.error}`).join("; ") || null;
  if (!up.length) return layer("down", `${down.map(([n]) => label[n]).join(" and ")} not answering`, metrics, links, why);
  const first = up[0];
  const summary = `${up.map(([n, c]) => `${label[n]} ${c.ms} ms`).join(", ")}${down.length ? `; ${down.map(([n]) => label[n]).join(", ")} down` : ""}`;
  return layer(down.length ? "warn" : "ok", summary || `${first[0]} up`, metrics, links, why);
}

async function dataLayer({ r, site }) {
  const list = await r.maybe(site, "list_collections");
  if (list === undefined) return off("Not available on this contract (before v3). Upgrade the contract to enable the document db.");
  const cols = rows(list);
  if (!cols.length) return off("No collections yet. Create one with quay db collection set <name>.");
  const pool = (await r.maybe(site, "get_pool")) ?? { balance: "0", reserved: "0" };
  const docs = cols.reduce((n, c) => n + Number(c.count), 0);
  const stored = cols.reduce((n, c) => n + Number(c.bytes), 0);
  const metrics = { collections: cols.length, docs, bytes: stored, pool_near: near(pool.balance), reserved_near: near(pool.reserved) };
  const siteCols = cols.filter((c) => c.payer === "site");
  const need = BigInt(Math.max(0, ...siteCols.map((c) => Number(c.max_doc_bytes)))) * 10n ** 19n;
  const summary = `${plural(cols.length, "collection")}, ${plural(docs, "doc")}, pool ${metrics.pool_near} NEAR`;
  if (siteCols.length && BigInt(pool.balance) < need) return layer("warn", summary, metrics, [], "the pool cannot cover another site-paid doc; fund it with db_fund");
  return layer("ok", summary, metrics);
}

async function functionsLayer({ r, site }) {
  const list = await r.maybe(site, "fn_list");
  if (list === undefined) return off("Not available on this contract (before v3). Upgrade the contract to enable functions.");
  const fns = rows(list);
  if (!fns.length) return off("No functions registered. Deploy one with quay functions deploy.");
  let results = [];
  try {
    const page = await r.maybe(site, "fn_results", { query: { limit: 10, order: "desc" } });
    results = rows(page, "docs");
  } catch {}
  const ok = results.filter((d) => (d.data ?? d).ok !== false).length;
  const metrics = { functions: fns.length, recent_ok: ok, recent_failed: results.length - ok };
  const summary = `${plural(fns.length, "function")}${results.length ? `, ${ok} of ${results.length} recent runs ok` : ", no runs yet"}`;
  if (results.length && (results[0].data ?? results[0]).ok === false) return layer("warn", summary, metrics, [], `the last run of ${(results[0].data ?? results[0]).name ?? "a function"} failed`);
  return layer("ok", summary, metrics);
}

async function routesLayer({ r, site, memo }) {
  const status = await memo.status();
  if (!status.production) return off("No production release, so no routes.");
  const rel = await r.maybe(site, "get_release", { id: status.production });
  if (rel === undefined) return off("Not available on this contract (before v3).");
  const routes = rel?.routes ?? [];
  if (!routes.length) return off(`Release ${status.production} declares no routes. Add routes to quay.json.`);
  const paths = new Set((rel.files ?? []).map((f) => f.path));
  const missing = routes.filter((x) => x.template && !paths.has(x.template)).map((x) => x.template);
  const kinds = { doc: 0, list: 0, json: 0 };
  for (const x of routes) kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
  const metrics = { routes: routes.length, ...kinds, release: status.production };
  const links = [{ label: "Open sample path", href: `https://${host(site)}${samplePath(routes[0].pattern)}` }];
  const summary = `${plural(routes.length, "route")} in release ${status.production}`;
  if (missing.length) return layer("warn", summary, metrics, links, `template ${missing[0]} is missing from the release`);
  return layer("ok", summary, metrics, links);
}

async function relayLayer({ r, o, site, signal }) {
  const relayer = `relay.${site}`;
  let health = null;
  if (typeof o.relay === "string") {
    const res = await o.fetch(`${o.relay.replace(/\/+$/, "")}/health`, { signal });
    if (!res.ok) return layer("down", `Relay answered HTTP ${res.status}`, {}, [], `HTTP ${res.status}`);
    health = await res.json();
  } else if (o.relay?.outlayer) {
    const { owner, project = "relay", paymentKey, api = OUTLAYER } = o.relay.outlayer;
    const res = await o.fetch(`${String(api).replace(/\/+$/, "")}/call/${owner}/${project}`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-payment-key": paymentKey },
      body: JSON.stringify({ input: { op: "health" } }),
    });
    const env = await res.json().catch(() => null);
    if (!res.ok) return layer("down", `OutLayer relay answered HTTP ${res.status}`, {}, [], env?.error ?? `HTTP ${res.status}`);
    health = typeof env?.output === "string" ? JSON.parse(env.output) : env?.output;
    if (!health || health.error) return layer("down", "OutLayer relay returned no health", {}, [], health?.error ?? env?.error ?? "no output");
  } else {
    let acct;
    try {
      acct = await r.query({ request_type: "view_account", account_id: relayer });
    } catch (e) {
      if (isAccountMissing(e)) return off(`No relayer for this site. Create one with quay relay deploy (account ${relayer}).`);
      throw e;
    }
    health = { relayer, balance: acct.amount, unchecked: true };
  }
  const balance = health.balance == null ? null : BigInt(health.balance);
  const metrics = { relayer: health.relayer ?? relayer, balance_near: balance == null ? "unknown" : near(balance), checked: !health.unchecked };
  if (health.policy) Object.assign(metrics, { per_account_per_hour: health.policy.per_account_per_hour, daily_tgas: health.policy.daily_tgas });
  const links = [{ label: "Relayer account", href: explorer(metrics.relayer) }];
  const summary = `Relayer ${metrics.relayer} holds ${metrics.balance_near} NEAR${health.unchecked ? " (no health URL given)" : ""}`;
  if (balance == null) return layer("warn", summary, metrics, links, "the relay did not report a balance");
  if (balance < MIN_RELAY_YOCTO) return layer("warn", summary, metrics, links, "balance is below 0.05 NEAR; top it up");
  if (health.ok === false) return layer("warn", summary, metrics, links, "the relay reports it is not ready");
  return layer("ok", summary, metrics, links);
}

async function cronLayer({ r, site, now }) {
  const st = await r.maybe(site, "cron_status");
  if (st === undefined) return off("Not available on this contract (before v3). Upgrade the contract to enable cron.");
  const jobs = rows(await r.maybe(site, "cron_list"), "jobs");
  if (!jobs.length) return off("No scheduled jobs. Add one with quay cron add.");
  const tick = st?.last_tick ? Number(BigInt(st.last_tick) / 1_000_000n) : 0;
  const idle = tick ? Math.max(0, Math.round((now() - tick) / 60000)) : null;
  const every = Math.min(...jobs.map((j) => Number(j.every_minutes) || 60));
  const metrics = { jobs: jobs.length, armed: Boolean(st?.armed), hops: Number(st?.hops ?? 0), every_minutes: every };
  if (idle != null) metrics.idle_minutes = idle;
  const summary = `${plural(jobs.length, "job")}, chain ${st?.armed ? "armed" : "stopped"}${idle != null ? `, last tick ${idle} min ago` : ""}`;
  if (!st?.armed) return layer("warn", summary, metrics, [], "jobs are set but the chain is not armed; run quay cron arm");
  if (idle != null && idle > 2 * every) return layer("warn", summary, metrics, [], `last tick was ${idle} min ago, more than twice the ${every} min interval`);
  return layer("ok", summary, metrics);
}

async function keysLayer({ r, site }) {
  const res = await r.query({ request_type: "view_access_key_list", account_id: site });
  const keys = res?.keys ?? [];
  const full = keys.filter((k) => k.access_key?.permission === "FullAccess").length;
  const metrics = { full_access: full, function_call: keys.length - full, total: keys.length };
  const summary = `${plural(full, "full-access key")}, ${plural(keys.length - full, "function-call key")}`;
  const links = [{ label: "Account", href: explorer(site) }];
  if (full !== 1) return layer("warn", summary, metrics, links, full === 0 ? "no full-access key: config changes are impossible" : "more than one full-access key can replace the contract");
  return layer("ok", summary, metrics, links);
}

const IMPLS = { site: siteLayer, gateway: gatewayLayer, data: dataLayer, functions: functionsLayer, routes: routesLayer, relay: relayLayer, cron: cronLayer, keys: keysLayer };

/**
 * Measure every layer. Options: site, rpc (URL, list of URLs, or a query function; default is the public failover list), gateway (self-hosted URL),
 * mirror (URL of a Workers or other gateway that serves the site), relay (URL or { outlayer: { owner, project, paymentKey, api } }), fetch, timeoutMs, now (ms, for tests),
 * probe (async ("mirror" | "public") => { ok, ms, reason } used where CORS blocks a fetch).
 */
export async function layerStatus(options) {
  const o = { timeoutMs: 6000, ...options };
  if (!o.site) throw new Error("layerStatus needs { site }");
  o.fetch ??= (...a) => globalThis.fetch(...a);
  const clock = o.now == null ? () => Date.now() : typeof o.now === "function" ? o.now : () => o.now;
  const r = reader(querier({ rpc: o.rpc, fetch: o.fetch }));
  let status = null;
  const memo = { status: () => (status ??= r.view(o.site, "get_status")) };
  const out = {};
  await Promise.all(
    LAYERS.map(async (name) => {
      const ctl = new AbortController();
      let timer;
      const late = new Promise((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort();
          reject(new Error(`no answer in ${o.timeoutMs / 1000} s`));
        }, o.timeoutMs);
      });
      try {
        out[name] = await Promise.race([IMPLS[name]({ r, o, site: o.site, memo, signal: ctl.signal, now: clock }), late]);
      } catch (e) {
        out[name] = fail(name === "site" && isAccountMissing(e) ? `${o.site} does not exist on testnet` : "Could not be read", e);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return { site: o.site, measured_at: new Date(clock()).toISOString().replace(/\.\d+Z$/, "Z"), layers: Object.fromEntries(LAYERS.map((n) => [n, out[n]])) };
}
