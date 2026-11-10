// Quay gateway core: HTTP in, `web4_get` view calls out. Web-standard APIs only
// (fetch, Request, Response, URL, crypto.subtle, TextEncoder), so the same file
// runs on Node 20+, Deno, Bun, and Cloudflare Workers.
import { createLru } from "./lru.mjs";
import {
  errorBody,
  errorHtml,
  GatewayError,
  KINDS,
  releaseOf,
  wantsJson,
} from "./page.mjs";

export { GatewayError, KINDS };

export const DEFAULT_RPC_URLS = [
  "https://test.rpc.fastnear.com",
  "https://testnet-rpc.intea.rs",
  "https://near-testnet.drpc.org",
];
export const DEFAULT_NEARFS_GATEWAYS = ["https://ipfs.web4.testnet.page"];
export const DEFAULT_IPFS_GATEWAYS = ["https://ipfs.io", "https://dweb.link"];
// rpc.testnet.near.org answers every call with HTTP 400 "deprecated".
export const DEPRECATED_RPC_HOSTS = ["rpc.testnet.near.org"];

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=0, must-revalidate";
const ACCOUNT_ID =
  /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;
// HANDLER_ERROR causes that mean "ask another node", not "this is the answer".
const TRANSIENT = new Set([
  "UNKNOWN_BLOCK",
  "GARBAGE_COLLECTED_BLOCK",
  "NOT_SYNCED_YET",
  "INTERNAL_ERROR",
  "TIMEOUT_ERROR",
  "UNAVAILABLE_SHARD",
  "NO_SYNCED_BLOCKS",
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isAccountId(id) {
  return typeof id === "string" && ACCOUNT_ID.test(id);
}

// Split "a,b c" or arrays of such strings into a clean URL list.
export function parseList(value) {
  const items = Array.isArray(value) ? value : [value];
  return items
    .flatMap((item) => String(item ?? "").split(/[\s,]+/))
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

// Drops the deprecated endpoint. Returns what was kept and what was dropped.
export function cleanRpcUrls(list) {
  const urls = [];
  const dropped = [];
  for (const url of parseList(list)) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      dropped.push(url);
      continue;
    }
    if (DEPRECATED_RPC_HOSTS.includes(host)) dropped.push(url);
    else if (!urls.includes(url)) urls.push(url);
  }
  return { urls, dropped };
}

export function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function etagOf(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const b64 = toBase64(digest)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `"${b64}"`;
}

export function etagMatches(header, etag) {
  if (!header || !etag) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .includes(etag);
}

function short(text, max = 160) {
  const line = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function networkReason(error) {
  if (error?.timeout) return error.message;
  const code = error?.cause?.code || error?.code;
  return `network error${code ? ` ${code}` : error?.message ? `: ${short(error.message, 80)}` : ""}`;
}

// Races `run(signal)` against a timer. The timer covers whatever `run` awaits.
async function timed(ms, run) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`timeout after ${ms} ms`);
      error.timeout = true;
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Why an RPC answer is not usable. Never includes the body itself.
function rpcReason(status, json, text) {
  const deprecated = /deprecated/i.test(text);
  if (status === 429)
    return `HTTP 429 rate limited${deprecated ? ", deprecated endpoint" : ""}`;
  if (status !== 200)
    return `HTTP ${status}${deprecated ? ", deprecated endpoint" : ""}`;
  if (!json) return "the answer was not JSON";
  if (json.error) {
    const name = json.error.cause?.name || json.error.name || json.error.code;
    return `RPC error ${short(name, 40)}${deprecated ? ", deprecated endpoint" : ""}`;
  }
  return "the answer had no result";
}

function panicMessage(text) {
  const match = /panic_msg: "((?:[^"\\]|\\.)*)"/.exec(text);
  if (match) return match[1].replace(/\\(.)/g, "$1");
  return text.replace(/^wasm execution failed with error:\s*/, "");
}

function execError(text, account, method, rpc) {
  const message = String(text ?? "");
  if (/CodeDoesNotExist/.test(message))
    return new GatewayError(
      "no_contract",
      `${account} exists, but no contract is deployed on it.`,
      { account, rpc },
    );
  if (/MethodNotFound|MethodResolveError/.test(message))
    return new GatewayError(
      method === "web4_get" ? "no_web4" : "bad_request",
      `${account} has a contract without a ${method} method.`,
      { account, rpc },
    );
  return new GatewayError(
    "panic",
    `${account} failed in ${method}: ${short(panicMessage(message), 400)}`,
    { account, rpc },
  );
}

function handlerError(error, account, method, rpc) {
  const cause = error?.cause?.name;
  const data = typeof error?.data === "string" ? error.data : "";
  if (cause === "UNKNOWN_ACCOUNT" || /does not exist while viewing/.test(data))
    return new GatewayError(
      "no_account",
      `${account} does not exist on testnet.`,
      { account, rpc },
    );
  if (cause === "INVALID_ACCOUNT")
    return new GatewayError(
      "no_account",
      `${account} is not a valid account id.`,
      { account, rpc },
    );
  if (cause === "NO_CONTRACT_CODE")
    return execError("CodeDoesNotExist", account, method, rpc);
  if (cause === "CONTRACT_EXECUTION_ERROR")
    return execError(
      data || error?.cause?.info?.vm_error || "",
      account,
      method,
      rpc,
    );
  return new GatewayError(
    "rpc",
    `The RPC refused the call (${short(cause || error?.name || "error", 40)}).`,
    { account, rpc },
  );
}

// One request to a public gateway, classified. Used by `quay status`.
export async function probeGateway(url, options = {}) {
  const fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const now = options.now ?? (() => Date.now());
  const started = now();
  try {
    const { status, text } = await timed(
      options.timeoutMs ?? 8000,
      async (signal) => {
        const response = await fetchImpl(url, {
          signal,
          redirect: "manual",
          headers: { accept: "text/html" },
        });
        const text = (await response.text()).slice(0, 4000);
        return { status: response.status, text };
      },
    );
    const ms = now() - started;
    const rpcJson = /"jsonrpc"/.test(text);
    let reason = null;
    if (rpcJson && /deprecated/i.test(text))
      reason = `${status} deprecated RPC`;
    else if (status === 429) reason = "429 rate limited";
    else if (status >= 500) reason = `${status} gateway error`;
    else if (rpcJson && status >= 400) reason = `${status} RPC error`;
    return { ok: !reason, status, ms, reason };
  } catch (error) {
    return {
      ok: false,
      status: null,
      ms: now() - started,
      reason: error?.timeout ? error.message : networkReason(error),
    };
  }
}

export function createGateway(options = {}) {
  const fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const now = options.now ?? (() => Date.now());
  const account = options.account
    ? String(options.account).trim().toLowerCase()
    : null;
  const domain = options.domain
    ? String(options.domain)
        .trim()
        .toLowerCase()
        .replace(/^\.+|\.+$/g, "")
    : null;
  if (account && !isAccountId(account))
    throw new Error(`${account} is not an account id`);
  if (!account && !domain)
    throw new Error("the gateway needs an account or a domain");
  const { urls: rpcUrls } = cleanRpcUrls(
    parseList(options.rpcUrls ?? []).length
      ? options.rpcUrls
      : DEFAULT_RPC_URLS,
  );
  if (!rpcUrls.length) throw new Error("no usable RPC URL");
  const nearfs = parseList(options.nearfsGateways ?? DEFAULT_NEARFS_GATEWAYS);
  const ipfs = parseList(options.ipfsGateways ?? DEFAULT_IPFS_GATEWAYS);
  const timeoutMs = options.timeoutMs ?? 8000;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? 15000;
  const maxHops = options.maxHops ?? 5;
  const cooldownMs = options.cooldownMs ?? 30000;
  const cache = createLru(options.cacheBytes ?? 32 * 1024 * 1024);
  const downUntil = new Map();

  function accountFor(url) {
    if (account) return account;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host.endsWith(`.${domain}`)) return null;
    const id = `${host.slice(0, -(domain.length + 1))}.testnet`;
    return isAccountId(id) ? id : null;
  }

  // POST to each RPC in order. An endpoint that failed in the last
  // `cooldownMs` moves to the back. Returns { result } or { error } (a
  // definitive handler error) plus the RPC that answered.
  async function rpc(method, params) {
    const attempts = [];
    const t = now();
    const order = [...rpcUrls].sort(
      (a, b) =>
        Number((downUntil.get(a) ?? 0) > t) -
        Number((downUntil.get(b) ?? 0) > t),
    );
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: "quay",
      method,
      params,
    });
    for (const url of order) {
      let status;
      let text;
      try {
        ({ status, text } = await timed(timeoutMs, async (signal) => {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
            signal,
          });
          return { status: response.status, text: await response.text() };
        }));
      } catch (error) {
        attempts.push({ rpc: url, reason: networkReason(error) });
        downUntil.set(url, now() + cooldownMs);
        continue;
      }
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      const error = json?.error;
      if (
        error?.name === "HANDLER_ERROR" &&
        !TRANSIENT.has(error.cause?.name)
      ) {
        downUntil.delete(url);
        return { error, rpc: url };
      }
      if (status !== 200 || !json || error || !("result" in json)) {
        attempts.push({ rpc: url, reason: rpcReason(status, json, text) });
        downUntil.set(url, now() + cooldownMs);
        continue;
      }
      downUntil.delete(url);
      return { result: json.result, rpc: url };
    }
    throw new GatewayError(
      "rpc",
      `No RPC endpoint answered (${attempts.length} tried).`,
      { attempts },
    );
  }

  async function view(id, method, args) {
    let out;
    try {
      out = await rpc("query", {
        request_type: "call_function",
        finality: "optimistic",
        account_id: id,
        method_name: method,
        args_base64: toBase64(encoder.encode(JSON.stringify(args))),
      });
    } catch (error) {
      error.account ??= id;
      throw error;
    }
    if (out.error) throw handlerError(out.error, id, method, out.rpc);
    const result = out.result;
    if (typeof result?.error === "string")
      throw execError(result.error, id, method, out.rpc);
    if (!Array.isArray(result?.result))
      throw new GatewayError(
        "bad_response",
        `The RPC answered ${method} on ${id} without a result.`,
        { account: id, rpc: out.rpc },
      );
    return { bytes: Uint8Array.from(result.result), rpc: out.rpc };
  }

  // GET /web4/contract/<account>/<method>?arg=v&obj.json={...}
  async function contractView(url) {
    const parts = url.pathname.split("/").slice(3);
    if (parts.length !== 2 || !parts[0] || !parts[1])
      throw new GatewayError(
        "bad_request",
        "Use /web4/contract/<account>/<method>?<args>.",
      );
    const [id, method] = parts.map((part) => decodeURIComponent(part));
    if (!isAccountId(id))
      throw new GatewayError("bad_request", `${id} is not an account id.`);
    const args = {};
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key);
      if (key.endsWith(".json")) {
        try {
          const parsed = values.map((value) => JSON.parse(value));
          args[key.slice(0, -5)] = parsed.length > 1 ? parsed : parsed[0];
        } catch {
          throw new GatewayError("bad_request", `${key} is not JSON.`, {
            account: id,
          });
        }
      } else args[key] = values.length > 1 ? values : values[0];
    }
    const { bytes, rpc: used } = await view(id, method, args);
    let type = "application/json; charset=utf-8";
    try {
      JSON.parse(decoder.decode(bytes));
    } catch {
      type = "text/plain; charset=utf-8";
    }
    return {
      status: 200,
      headers: { "content-type": type, "cache-control": REVALIDATE },
      bytes,
      etag: await etagOf(bytes),
      rpc: used,
    };
  }

  async function preload(urls, base, depth) {
    const entries = await Promise.all(
      urls.map(async (raw) => {
        const target = new URL(String(raw), `${base.origin}/`);
        let response;
        try {
          response =
            target.origin === base.origin
              ? await handle(
                  new Request(target, {
                    headers: { accept: "application/json" },
                  }),
                  depth + 1,
                )
              : await timed(bodyTimeoutMs, (signal) =>
                  fetchImpl(target.href, { signal }),
                );
          const bytes = new Uint8Array(await response.arrayBuffer());
          return [
            raw,
            {
              contentType: response.headers.get("content-type"),
              body: toBase64(bytes),
            },
          ];
        } catch (error) {
          throw new GatewayError(
            "preload",
            `Could not fetch the preload ${target.href}: ${networkReason(error)}.`,
            { url: target.href },
          );
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  async function fetchBodyUrl(bodyUrl, base, request, depth, out) {
    let target;
    try {
      target = new URL(bodyUrl, `${base.origin}/`);
    } catch {
      throw new GatewayError(
        "bad_response",
        `The contract sent a body URL that is not a URL: ${short(bodyUrl, 120)}.`,
        { rpc: out.rpc },
      );
    }
    let candidates;
    let etag = null;
    if (target.protocol === "ipfs:") {
      const cid = target.hostname || target.pathname.replace(/^\/+/, "");
      const rest = target.hostname ? `${target.pathname}${target.search}` : "";
      if (!/^[A-Za-z0-9]+$/.test(cid))
        throw new GatewayError(
          "bad_response",
          `The contract sent an IPFS URL without a CID: ${short(bodyUrl, 120)}.`,
          { rpc: out.rpc },
        );
      candidates = [...nearfs, ...ipfs].map(
        (gateway) => `${gateway}/ipfs/${cid}${rest === "/" ? "" : rest}`,
      );
      etag = `"${cid}${rest && rest !== "/" ? rest.replace(/"/g, "") : ""}"`;
      if (
        out.status === 200 &&
        etagMatches(request.headers.get("if-none-match"), etag)
      )
        return { ...out, etag, bytes: null };
    } else if (target.protocol === "http:" || target.protocol === "https:") {
      candidates = [target.href];
    } else {
      throw new GatewayError(
        "bad_response",
        `The contract sent a body URL with an unsupported scheme: ${target.protocol}`,
        { rpc: out.rpc },
      );
    }
    const attempts = [];
    for (const candidate of candidates) {
      let response;
      try {
        const same = new URL(candidate).origin === base.origin;
        response = same
          ? await handle(new Request(candidate), depth + 1)
          : await timed(bodyTimeoutMs, (signal) =>
              fetchImpl(candidate, { signal, headers: { accept: "*/*" } }),
            );
      } catch (error) {
        attempts.push({ url: candidate, reason: networkReason(error) });
        continue;
      }
      if (response.status !== 200) {
        attempts.push({ url: candidate, reason: `HTTP ${response.status}` });
        response.body?.cancel().catch(() => {});
        continue;
      }
      const headers = { ...out.headers };
      headers["content-type"] ??=
        response.headers.get("content-type") || "application/octet-stream";
      const length = response.headers.get("content-length");
      if (length && !response.headers.get("content-encoding"))
        headers["content-length"] = length;
      const upstream = response.headers.get("etag");
      if (!etag && upstream && !upstream.startsWith("W/")) etag = upstream;
      return { ...out, headers, etag, stream: response.body };
    }
    throw new GatewayError(
      "body_url",
      `None of the ${candidates.length} places for ${short(bodyUrl, 120)} answered.`,
      { url: bodyUrl, attempts, rpc: out.rpc },
    );
  }

  async function serveWeb4(id, url, request, depth) {
    const release = releaseOf(url.pathname);
    const query = {};
    for (const key of new Set(url.searchParams.keys()))
      query[key] = url.searchParams.getAll(key);
    const web4Request = { accountId: null, path: url.pathname, query };
    let used = null;
    for (let hop = 0; hop < maxHops; hop += 1) {
      const answer = await view(id, "web4_get", { request: web4Request });
      used = answer.rpc;
      let res;
      try {
        res = JSON.parse(decoder.decode(answer.bytes));
      } catch {}
      if (!res || typeof res !== "object" || Array.isArray(res))
        throw new GatewayError(
          "bad_response",
          `${id} answered web4_get with something that is not a web4 response.`,
          { account: id, rpc: used },
        );
      const status = res.status == null ? null : Number(res.status);
      if (
        status != null &&
        !(Number.isInteger(status) && status >= 200 && status <= 599)
      )
        throw new GatewayError(
          "bad_response",
          `${id} answered with status ${short(res.status, 20)}.`,
          { account: id, rpc: used },
        );
      const effective = status ?? 200;
      const headers = {};
      if (res.contentType) headers["content-type"] = String(res.contentType);
      headers["cache-control"] =
        release && (effective === 200 || effective === 404)
          ? IMMUTABLE
          : res.cacheControl
            ? String(res.cacheControl)
            : REVALIDATE;
      const out = { status: effective, headers, rpc: used };
      if (typeof res.body === "string") {
        let bytes;
        try {
          bytes = fromBase64(res.body);
        } catch {
          throw new GatewayError(
            "bad_response",
            `${id} sent a body that is not base64.`,
            { account: id, rpc: used },
          );
        }
        headers["content-type"] ??= "application/octet-stream";
        return { ...out, bytes, etag: await etagOf(bytes) };
      }
      if (typeof res.bodyUrl === "string" && res.bodyUrl)
        return fetchBodyUrl(res.bodyUrl, url, request, depth, out);
      if (Array.isArray(res.preloadUrls) && res.preloadUrls.length) {
        web4Request.preloads = await preload(res.preloadUrls, url, depth);
        continue;
      }
      if (status != null) {
        const bytes = encoder.encode(`${status}\n`);
        headers["content-type"] = "text/plain; charset=utf-8";
        return { ...out, bytes, etag: await etagOf(bytes) };
      }
      throw new GatewayError(
        "bad_response",
        `${id} answered web4_get with no body, body URL, preloads, or status.`,
        { account: id, rpc: used },
      );
    }
    throw new GatewayError(
      "hops",
      `${id} asked for preloads ${maxHops} times without answering.`,
      { account: id, rpc: used },
    );
  }

  async function health(url) {
    const id = accountFor(url);
    const started = now();
    const body = { ok: false, account: id, rpc: null, latency_ms: 0 };
    try {
      const out = await rpc("query", {
        request_type: "view_account",
        finality: "optimistic",
        account_id: id ?? "testnet",
      });
      body.rpc = out.rpc;
      body.ok = !out.error;
      if (out.error)
        body.error = handlerError(out.error, id, "view_account").message;
    } catch (error) {
      body.error = error.message;
      body.attempts = error.attempts;
    }
    body.latency_ms = now() - started;
    return new Response(JSON.stringify(body), {
      status: body.ok ? 200 : 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-quay-gateway": "quay",
        ...(body.rpc ? { "x-quay-rpc": body.rpc } : {}),
      },
    });
  }

  function finish(request, out, head) {
    const headers = new Headers(out.headers);
    headers.set("x-quay-gateway", "quay");
    if (out.rpc) headers.set("x-quay-rpc", out.rpc);
    if (out.cache) headers.set("x-quay-cache", out.cache);
    if (out.etag) headers.set("etag", out.etag);
    if (
      out.etag &&
      out.status === 200 &&
      etagMatches(request.headers.get("if-none-match"), out.etag)
    ) {
      out.stream?.cancel().catch(() => {});
      headers.delete("content-length");
      return new Response(null, { status: 304, headers });
    }
    if (out.bytes) headers.set("content-length", String(out.bytes.length));
    const empty = head || [204, 205, 304].includes(out.status);
    if (empty) out.stream?.cancel().catch(() => {});
    return new Response(empty ? null : (out.bytes ?? out.stream ?? null), {
      status: out.status,
      headers,
    });
  }

  function failure(error, { account: id, path, json, head }) {
    const err =
      error instanceof GatewayError
        ? error
        : new GatewayError(
            "bad_response",
            `The gateway failed: ${short(error?.message ?? error, 200)}`,
          );
    const context = { account: err.account ?? id, path };
    const headers = new Headers({
      "x-quay-gateway": "quay",
      "cache-control": "no-store",
    });
    if (err.rpc) headers.set("x-quay-rpc", err.rpc);
    if (err.kind === "method") headers.set("allow", "GET, HEAD");
    let body;
    if (json) {
      headers.set("content-type", "application/json; charset=utf-8");
      body = JSON.stringify(errorBody(err, context));
    } else {
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'",
      );
      body = errorHtml(err, context);
    }
    return new Response(head ? null : body, { status: err.status, headers });
  }

  async function handle(request, depth) {
    const url = new URL(request.url);
    const path = url.pathname;
    const head = request.method === "HEAD";
    const json = wantsJson(request, path);
    let id = null;
    try {
      if (request.method !== "GET" && !head)
        throw new GatewayError(
          "method",
          `${request.method} is not served. web4 pages are read-only.`,
        );
      if (depth > 3)
        throw new GatewayError("hops", "Body URLs and preloads nest too deep.");
      if (path === "/_quay/health") return await health(url);
      if (path.startsWith("/web4/contract/"))
        return finish(request, await contractView(url), head);
      id = accountFor(url);
      if (!id)
        throw new GatewayError(
          "no_site",
          domain
            ? `${url.hostname} is not <name>.${domain}, so no account matches it.`
            : `No account is configured for ${url.hostname}.`,
        );
      const key = releaseOf(path) ? `${id} ${path}${url.search}` : null;
      const hit = key && cache.get(key);
      if (hit) return finish(request, { ...hit, cache: "hit" }, head);
      const out = await serveWeb4(id, url, request, depth);
      if (key && out.bytes && (out.status === 200 || out.status === 404))
        cache.set(key, out, out.bytes.length + 512);
      return finish(request, out, head);
    } catch (error) {
      return failure(error, { account: id, path, json, head });
    }
  }

  const gateway = (request) => handle(request, 0);
  gateway.rpcUrls = rpcUrls;
  gateway.account = account;
  gateway.domain = domain;
  gateway.cache = cache;
  return gateway;
}
