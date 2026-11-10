import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function streams() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (chunk) => out.push(String(chunk)) },
    stderr: { write: (chunk) => err.push(String(chunk)) },
    text: () => out.join(""),
    err: () => err.join(""),
  };
}

export function tempDir(prefix = "quay-t-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/**
 * A chain stub that remembers state like the v3 contract: collections, docs,
 * products, members, releases. Records every send in `calls`.
 */
export function fakeChain(seed = {}) {
  const state = {
    collections: new Map(Object.entries(seed.collections ?? {})),
    docs: new Map(),
    products: new Map(Object.entries(seed.products ?? {})),
    members: [],
    membersOpen: seed.membersOpen ?? true,
    releases: [...(seed.releases ?? [])],
    production: null,
    chunks: new Set(),
    pool: { balance: "0", reserved: "0" },
    next: 1,
  };
  const calls = [];
  const chain = {
    state,
    calls,
    async view(method, args = {}) {
      if (method === "list_collections")
        return [...state.collections].map(([name, rules]) => ({
          name,
          ...rules,
          count: String(
            [...state.docs.keys()].filter((key) => key.startsWith(`${name}/`))
              .length,
          ),
          bytes: "0",
          next_seq: String(state.next),
        }));
      if (method === "get_collection") {
        const rules = state.collections.get(args.name);
        if (!rules) return null;
        return {
          name: args.name,
          ...rules,
          count: String(
            [...state.docs.keys()].filter((key) =>
              key.startsWith(`${args.name}/`),
            ).length,
          ),
          bytes: "0",
          next_seq: String(state.next),
        };
      }
      if (method === "db_get")
        return state.docs.get(`${args.collection}/${args.id}`) ?? null;
      if (method === "db_list") {
        const docs = [...state.docs.entries()]
          .filter(([key]) => key.startsWith(`${args.collection}/`))
          .map(([, doc]) => doc);
        return { docs, next: null };
      }
      if (method === "get_pool") return state.pool;
      if (method === "list_products")
        return [...state.products].map(([id, product]) => ({ id, ...product }));
      if (method === "get_token") return null;
      if (method === "get_members_open") return state.membersOpen;
      if (method === "list_members")
        return { members: state.members, next: null };
      if (method === "list_receipts") return { receipts: [], next: null };
      if (method === "list_releases")
        return { releases: state.releases, next: null };
      if (method === "get_status")
        return {
          stored_bytes: "0",
          max_bytes: "2000000",
          production: state.production,
          previous: null,
          release_count: state.releases.length,
          version: "3.0.0",
        };
      if (method === "get_release")
        return state.releases.find((release) => release.id === args.id) ?? null;
      return null;
    },
    async send(method, args, options = {}) {
      calls.push({
        method,
        args,
        deposit: options.deposit ?? 0n,
        ...(options.gas ? { gas: options.gas } : {}),
      });
      const hash = `tx-${calls.length}`;
      if (method === "set_collection")
        state.collections.set(args.name, args.rules);
      if (method === "drop_collection") state.collections.delete(args.name);
      if (method === "set_product") state.products.set(args.id, args.product);
      if (method === "remove_product") state.products.delete(args.id);
      if (method === "set_members_open") state.membersOpen = args.open;
      let value = null;
      if (method === "db_add") {
        const id = args.id ?? String(state.next);
        state.next += 1;
        state.docs.set(`${args.collection}/${id}`, {
          collection: args.collection,
          id,
          owner: "alice.testnet",
          created: "1731283200000000000",
          hidden: false,
          data: JSON.parse(args.data),
        });
        value = id;
      }
      if (method === "db_remove")
        state.docs.delete(`${args.collection}/${args.id}`);
      return { hash, value };
    },
    async hasChunk(hash) {
      return state.chunks.has(hash);
    },
    async putChunk(hash) {
      calls.push({ method: "put_chunk", hash });
      state.chunks.add(hash);
      return { hash: `chunk-${calls.length}` };
    },
    async sendBatch(batch) {
      calls.push({
        method: "batch",
        count: batch.length,
        bytes: batch.reduce((sum, item) => sum + item.args.length, 0),
      });
      return { hash: `batch-${calls.length}` };
    },
    async seal(id, files, message, spa, routes) {
      calls.push({ method: "seal", id, files, message, spa, routes });
      state.releases.push({ id, file_count: files.length, bytes: 0, message });
      return { hash: `seal-${id}` };
    },
    async promote(id) {
      calls.push({ method: "promote", id });
      state.production = id;
      return { hash: `promote-${id}` };
    },
    async rollback() {
      return { hash: "rb", value: "1" };
    },
    async dropChunk() {
      return { hash: "drop" };
    },
  };
  return chain;
}

export function baseCtx(io, overrides = {}) {
  return {
    ...io,
    json: false,
    yes: true,
    dryRun: false,
    spa: false,
    color: false,
    isTTY: false,
    cwd: process.cwd(),
    config: {
      account: "board.testnet",
      gateway: "https://board.testnet.page",
      rpc: "https://test.rpc.fastnear.com",
      path: null,
    },
    signer: { secret: "local", limited: false, publicKey: "ed25519:abc" },
    probe: async () => 200,
    ...overrides,
  };
}
