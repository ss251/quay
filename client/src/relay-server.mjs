// The Quay relayer as a Node process: the one off-chain piece of a Quay site.
// Protocol (docs/fullstack-interface.md section 6): POST /relay, POST /join, GET /health.
// Uses only node:http plus relay-core; near-api-js is loaded by createNearChain when a real chain is needed.
import { createServer } from "node:http";
import { checkDelegate, DEFAULT_POLICY, dayBucket, failures, memoryStore, relay as relayDelegate } from "./relay-core.mjs";
import { parsePublicKey } from "./encoding.mjs";

const NEAR = 10n ** 24n;
const MAX_BODY = 64 * 1024;
const RESERVED = new Set(["relay", "admin", "www", "api", "quay"]);

export const SERVER_DEFAULTS = Object.freeze({
  joinPerIpPerDay: 5,
  joinsPerDay: 500,
  minBalance: NEAR / 20n, // refuse to relay below 0.05 NEAR
  balanceTtlMs: 10_000,
});

/** Origins a browser page of this site may call from. `*` stands for any port. */
export function defaultOrigins(site) {
  return [`https://${site}.page`, "http://127.0.0.1:*", "http://localhost:*"];
}
export function originAllowed(origin, patterns) {
  return patterns.some((p) => {
    if (p === "*") return true;
    if (!p.includes("*")) return p === origin;
    const [head, tail] = p.split("*");
    return origin.startsWith(head) && /^\d*$/.test(origin.slice(head.length, origin.length - tail.length)) && origin.endsWith(tail);
  });
}

class HttpError extends Error {
  constructor(status, error, reason) {
    super(reason ?? error);
    this.status = status;
    this.error = error;
    this.reason = reason;
  }
}
const STATUS = { account_rate_limit: 429, daily_budget: 429, malformed: 400 };

/**
 * chain: { height(): bigint|number, balance(): yocto string|bigint, join(name, publicKey): {hash}, relay(bytes): {hash} }
 * options: { site, relayer, chain, policy?, origins?, trustProxy?, store?, log?, now?, joinPerIpPerDay?, joinsPerDay?, minBalance?, balanceTtlMs? }
 */
export function createRelayServer(options) {
  const { site, relayer, chain } = options;
  if (!site || !relayer || !chain) throw new Error("createRelayServer needs { site, relayer, chain }");
  const o = { ...SERVER_DEFAULTS, ...options };
  const store = o.store ?? memoryStore();
  const log = o.log ?? ((line) => process.stderr.write(`${line}\n`));
  const now = o.now ?? Date.now;
  const origins = o.origins ?? defaultOrigins(site);
  const policy = { ...DEFAULT_POLICY, ...(o.policy ?? {}), site, store };

  // One relayer account signs everything, so transactions go out one at a time (nonces).
  let tail = Promise.resolve();
  const serial = (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };

  let cached = { at: 0, value: 0n };
  async function balance(fresh = false) {
    if (!fresh && now() - cached.at < o.balanceTtlMs) return cached.value;
    cached = { at: now(), value: BigInt(await chain.balance()) };
    return cached.value;
  }

  async function readJson(req) {
    let size = 0;
    const parts = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, "too_large", "request body is over 64 KB");
      parts.push(chunk);
    }
    try {
      const v = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error();
      return v;
    } catch {
      throw new HttpError(400, "bad_json", "the body must be a JSON object");
    }
  }

  function clientIp(req) {
    if (o.trustProxy) {
      const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  async function handleRelay(req) {
    const body = await readJson(req);
    if (typeof body.signed_delegate !== "string") throw new HttpError(400, "malformed", "signed_delegate (base64) is required");
    if ((await balance()) < BigInt(o.minBalance)) throw new HttpError(503, "relayer_empty", "the relayer balance is too low to send");
    const height = await chain.height();
    const verdict = await checkDelegate(body.signed_delegate, policy, { ms: now(), height });
    if (!verdict.ok) {
      log(`reject ${verdict.code}`);
      throw new HttpError(STATUS[verdict.code] ?? 422, verdict.code, verdict.reason);
    }
    let sent;
    try {
      sent = await serial(() => chain.relay(verdict.bytes));
    } catch (e) {
      log(`failed ${verdict.sender} ${verdict.digest} ${e.code ?? "error"}`);
      throw new HttpError(502, e.code ?? "relay_failed", e.message);
    }
    await verdict.commit();
    cached.at = 0;
    log(`relay ${sent.hash} ${verdict.sender} ${verdict.receiver} ${verdict.gas}`);
    return { hash: sent.hash };
  }

  async function handleJoin(req) {
    const body = await readJson(req);
    const { name, public_key: publicKey } = body;
    if (typeof name !== "string" || !/^[a-z0-9_-]{2,32}$/.test(name)) throw new HttpError(400, "bad_name", "name is 2 to 32 characters of a-z, 0-9, _ and -");
    if (RESERVED.has(name)) throw new HttpError(400, "reserved_name", `${name} is reserved`);
    try {
      if (typeof publicKey !== "string") throw new Error();
      parsePublicKey(publicKey);
    } catch {
      throw new HttpError(400, "bad_public_key", "public_key must be an ed25519 key like ed25519:…");
    }
    const day = dayBucket(now());
    const ipKey = `join-ip:${clientIp(req)}:${day}`;
    const dayKey = `join-day:${day}`;
    if ((await store.get(ipKey)) >= o.joinPerIpPerDay) throw new HttpError(429, "join_rate_limit", "this address has joined enough accounts today");
    if ((await store.get(dayKey)) >= o.joinsPerDay) throw new HttpError(429, "join_daily_limit", "this site reached its daily join limit");
    if ((await balance()) < BigInt(o.minBalance)) throw new HttpError(503, "relayer_empty", "the relayer balance is too low to send");
    await store.add(ipKey, 1);
    await store.add(dayKey, 1);
    let sent;
    try {
      sent = await serial(() => chain.join(name, publicKey));
    } catch (e) {
      const taken = /already|taken|exists/i.test(e.message);
      log(`join-failed ${name}.${site} ${taken ? "taken" : "error"}`);
      throw new HttpError(taken ? 409 : 502, taken ? "name_taken" : "join_failed", e.message);
    }
    cached.at = 0;
    log(`join ${sent.hash} ${name}.${site}`);
    return { account: `${name}.${site}`, hash: sent.hash };
  }

  async function handleHealth() {
    let bal = null;
    try {
      bal = await balance(true);
    } catch {}
    return {
      site,
      relayer,
      balance: bal === null ? null : bal.toString(),
      balance_near: bal === null ? null : (Number(bal / 10n ** 20n) / 10000).toFixed(4),
      ok: bal !== null && bal >= BigInt(o.minBalance),
      policy: {
        methods: policy.methods,
        max_gas: String(policy.maxGas),
        max_block_height_ahead: String(policy.maxBlockHeightAhead),
        per_account_per_hour: policy.perAccountPerHour,
        daily_tgas: policy.dailyTgas,
        allow_uploads: policy.allowUploads,
        member_only: policy.memberOnly,
        join_per_ip_per_day: o.joinPerIpPerDay,
        joins_per_day: o.joinsPerDay,
        deposit: "0",
      },
    };
  }

  async function handler(req, res) {
    const origin = req.headers.origin;
    const send = (status, body) => {
      const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
      if (origin && originAllowed(origin, origins)) {
        headers["access-control-allow-origin"] = origin;
        headers.vary = "Origin";
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    try {
      const path = new URL(req.url, "http://x").pathname;
      if (origin && !originAllowed(origin, origins)) throw new HttpError(403, "origin_not_allowed", `${origin} may not call this relayer`);
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
        });
        return res.end();
      }
      if (req.method === "GET" && path === "/health") return send(200, await handleHealth());
      if (req.method === "POST" && path === "/relay") return send(200, await handleRelay(req));
      if (req.method === "POST" && path === "/join") return send(200, await handleJoin(req));
      throw new HttpError(path === "/relay" || path === "/join" || path === "/health" ? 405 : 404, "not_found", `${req.method} ${path}`);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.error, ...(e.reason ? { reason: e.reason } : {}) });
      log(`error ${e?.message ?? e}`);
      return send(500, { error: "internal", reason: "the relayer hit an unexpected error" });
    }
  }

  const server = createServer((req, res) => void handler(req, res));
  return {
    server,
    handler,
    policy,
    store,
    listen: (port = 8788, host = "127.0.0.1") =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(`http://${host}:${server.address().port}`));
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function joinResult(outcome) {
  const b64 = outcome?.status?.SuccessValue;
  if (typeof b64 !== "string" || b64 === "") return undefined;
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

const GAS_JOIN = 50n * 10n ** 12n;

/** The real chain behind the server: a near-api-js Account for the relayer. Node only. */
export async function createNearChain({ rpc, site, relayer, secret }) {
  const { Account, JsonRpcProvider } = await import("near-api-js");
  const provider = new JsonRpcProvider({ url: rpc });
  const account = new Account(relayer, provider, secret);
  return {
    async height() {
      return BigInt((await provider.viewBlock({ finality: "final" })).header.height);
    },
    async balance() {
      return (await provider.viewAccount({ accountId: relayer })).amount.toString();
    },
    async join(name, publicKey) {
      const outcome = await account.callFunctionRaw({ contractId: site, methodName: "join", args: { name, public_key: publicKey }, gas: GAS_JOIN, deposit: 0n });
      const bad = failures(outcome);
      if (bad.length) throw new Error(`join failed: ${bad.join("; ")}`);
      // join returns true once the member is recorded, false when the account could not be created
      if (joinResult(outcome) === false) throw new Error("join failed: the account could not be created (it may already exist)");
      return { hash: outcome?.transaction?.hash };
    },
    relay: (bytes) => relayDelegate(bytes, { account }),
  };
}
