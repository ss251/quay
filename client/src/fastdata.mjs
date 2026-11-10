// Gas-only public data on FastNEAR's KV indexer (FastData), behind the same collection API.
// A write is a call to `__fastdata_kv` on the site account with { key: value } args. The call fails
// on chain by design (the site has no such method); the FastNEAR indexer records it anyway, under the
// caller's account. There are no rules, no moderation and no storage deposit: every account writes
// under its own name, and anyone may write any key there. Treat `owner` as the only identity.
// Reads depend on FastNEAR's indexer being up.

export const FASTDATA_METHOD = "__fastdata_kv";
export const FASTDATA_KV = "https://kv.test.fastnear.com";
export const FASTDATA_GAS = 5_000_000_000_000n; // 5 Tgas: MethodNotFound, and a few hundred thousandths of a NEAR at most

const NAME = /^[a-z0-9_-]{1,32}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TS = 36 ** 9 - 1;

const bad = (message, code = "bad_request") => Object.assign(new Error(message), { name: "QuayError", code });

/** Newest first when read in key order: the id counts down from a fixed ceiling. */
export function autoId(ms = Date.now(), random = crypto.getRandomValues(new Uint8Array(3))) {
  const ts = (MAX_TS - Math.floor(ms)).toString(36).padStart(9, "0");
  return ts + [...random].map((b) => b.toString(36).padStart(2, "0")).join("");
}

export const keyOf = (collection, id) => `quay/${collection}/${id}`;

function check(collection, id) {
  if (!NAME.test(collection)) throw bad("a collection name is 1 to 32 characters of a-z 0-9 _ -", "bad_collection");
  if (id != null && !ID.test(String(id))) throw bad("a doc id is 1 to 64 characters of A-Z a-z 0-9 _ -", "bad_id");
}

const nanos = (t) => String(t < 1e15 ? BigInt(Math.trunc(t)) * 1_000_000n : BigInt(Math.trunc(t)));

/** A KV entry as the DocPage item shape. `owner` is the account that wrote it. */
export function toDoc(collection, entry) {
  const id = entry.key.slice(`quay/${collection}/`.length);
  const v = entry.value;
  return {
    collection,
    id,
    seq: String(entry.block_height ?? ""),
    owner: entry.predecessor_id,
    created: nanos(entry.block_timestamp ?? 0),
    updated: nanos(entry.block_timestamp ?? 0),
    data: v && typeof v === "object" && "data" in v ? v.data : v,
    at: v && typeof v === "object" ? (v.at ?? null) : null,
    hidden: false,
    pinned_until: null,
    fn: null,
    deposit: "0",
    backend: "fastdata",
    tx_hash: entry.tx_hash ?? null,
  };
}

/**
 * ctx: { site, kv?, fetch, write(args) -> Promise, now? }. Returns a collection object.
 * `write` sends the __fastdata_kv call through the caller's signed-in path (member relayer, wallet or key).
 */
export function fastdataCollection(name, ctx) {
  check(name);
  const kv = String(ctx.kv ?? FASTDATA_KV).replace(/\/+$/, "");
  const now = ctx.now ?? Date.now;
  const post = async (path, body) => {
    const res = await ctx.fetch(`${kv}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    if (!res.ok) throw bad(`FastData read failed${json?.error ? `: ${json.error}` : ` with HTTP ${res.status}`}`, "fastdata_read_failed");
    return json ?? { entries: [] };
  };
  const live = (e) => e && e.value !== null && e.value !== undefined && String(e.key).startsWith(`quay/${name}/`);

  async function put(id, data) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw bad("a doc must be a JSON object", "bad_doc");
    const value = { data, at: now() };
    await ctx.write({ [keyOf(name, id)]: value });
    return id;
  }

  return {
    name,
    backend: "fastdata",
    /** Docs under quay/<name>/, in key order (newest first for automatic ids). { limit, from, owner, prefix, order } */
    async list({ limit = 20, from, owner, prefix = "", order = "desc" } = {}) {
      const path = `/v0/latest/${ctx.site}${owner ? `/${owner}` : ""}`;
      const body = { key_prefix: `quay/${name}/${prefix}`, include_metadata: true, limit: Math.min(Math.max(Number(limit) || 20, 1), 200) };
      if (order === "asc") {
        // the indexer pages in key order only: read everything (at most 1000) and flip it
        const all = [];
        let token;
        for (let i = 0; i < 5; i++) {
          const page = await post(path, { ...body, limit: 200, ...(token ? { page_token: token } : {}) });
          all.push(...page.entries);
          token = page.page_token;
          if (!token) break;
        }
        return { docs: all.filter(live).map((e) => toDoc(name, e)).reverse().slice(0, body.limit), next: null };
      }
      if (from) body.page_token = from;
      const page = await post(path, body);
      return { docs: page.entries.filter(live).map((e) => toDoc(name, e)), next: page.page_token ?? null };
    },
    /** One doc. Pass { owner } to read that account's entry; without it the earliest write wins. */
    async get(id, { owner } = {}) {
      check(name, id);
      const key = keyOf(name, id);
      if (owner) {
        const res = await ctx.fetch(`${kv}/v0/latest/${ctx.site}/${owner}/${key}`);
        if (res.status === 404) return null;
        const json = await res.json().catch(() => null);
        if (!res.ok) throw bad(`FastData read failed${json?.error ? `: ${json.error}` : ` with HTTP ${res.status}`}`, "fastdata_read_failed");
        const e = json?.entries?.[0];
        return live(e) ? toDoc(name, e) : null;
      }
      const page = await post(`/v0/latest/${ctx.site}`, { key_prefix: key, include_metadata: true, limit: 200 });
      const hits = page.entries.filter((e) => e.key === key && live(e)).sort((a, b) => a.block_height - b.block_height);
      return hits[0] ? toDoc(name, hits[0]) : null;
    },
    /** Write a doc under the signed-in account. Returns the id. */
    add(data, { id } = {}) {
      check(name, id);
      return put(id == null ? autoId(now()) : String(id), data);
    },
    /** Overwrite your own doc. */
    async update(id, data) {
      check(name, id);
      await put(String(id), data);
    },
    /** A tombstone (value null) under the signed-in account. Only your own entry can be removed. */
    async remove(id) {
      check(name, id);
      await ctx.write({ [keyOf(name, String(id))]: null });
    },
  };
}
