// OutLayer client: FastFS upload, projects, encrypted secrets, payment keys, HTTPS calls.
// Facts from the spike (docs/fullstack-interface.md section 3). Secret values are
// encrypted here and only ciphertext leaves this process; the keystore's
// /secrets/pubkey request carries placeholder values with the real key names.
import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { Account, actions, teraToGas } from "near-api-js";

import { createProvider } from "./chain.mjs";

import { QuayError } from "./errors.mjs";
import { classifyChainError } from "./text.mjs";

export const OUTLAYER_CONTRACT = "outlayer.testnet";
export const OUTLAYER_API = "https://testnet-api.outlayer.ai";
export const FASTFS_HOST = "https://test.fastfs.io";
export const PAYMENT_TOKEN = "usdc.fakes.testnet";
export const BUILD_TARGET = "wasm32-wasip2";
export const PLACEHOLDER = "placeholder";

const GAS_STORE = teraToGas("100");
const GAS_PROJECT = teraToGas("50");
const GAS_FT = teraToGas("100");
const GAS_SMALL = teraToGas("30");
const EXTRA_DEPOSIT = 1_000_000_000_000_000_000_000n; // 0.001 NEAR over the estimate
const FT_STORAGE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR, NEP-145 minimum on the fake USDC

export const sha256Hex = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

/** FastFS `__fastdata_fastfs` args: borsh SimpleFastfs variant 0 {relative_path, Some(mime), content}. */
export function fastfsPayload(bytes, relativePath, mime = "application/wasm") {
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0]),
      str(relativePath),
      Buffer.from([1]),
      str(mime),
      u32(bytes.length),
      Buffer.from(bytes),
    ]),
  );
}

export function fastfsUrl(account, sha256, receiver = OUTLAYER_CONTRACT) {
  return `${FASTFS_HOST}/${account}/${receiver}/${sha256}.wasm`;
}

/** ECIES v1: 0x01 || ephemeral X25519 public key || 12-byte nonce || ChaCha20-Poly1305(ciphertext || tag), base64. */
export function encryptSecrets(pubkeyHex, plaintext) {
  if (!/^[0-9a-f]{64}$/i.test(String(pubkeyHex ?? "")))
    throw new QuayError("the OutLayer keystore returned no usable key", 2);
  const recipient = createPublicKey({
    key: {
      kty: "OKP",
      crv: "X25519",
      x: Buffer.from(pubkeyHex, "hex").toString("base64url"),
    },
    format: "jwk",
  });
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: recipient,
  });
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.alloc(0),
      Buffer.from("outlayer-keystore-v1"),
      32,
    ),
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: 16,
  });
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const ephRaw = Buffer.from(
    eph.publicKey.export({ format: "jwk" }).x,
    "base64url",
  );
  return Buffer.concat([Buffer.from([1]), ephRaw, nonce, body]).toString(
    "base64",
  );
}

/** Same key names, every value replaced: what /secrets/pubkey may see. */
export function placeholders(values) {
  return Object.fromEntries(Object.keys(values).map((k) => [k, PLACEHOLDER]));
}

/**
 * Who may open a function's secrets: the site contract as predecessor of a
 * contract call, or the site as payer of an HTTPS call (over HTTPS
 * `Predecessor{X}` is judged as X on the paying account).
 */
export const siteAccess = (site) => ({
  Predecessor: { condition: { Whitelist: { accounts: [site] } } },
});

export function parsePaymentKey(text) {
  const m = /^([a-z0-9._-]+):(\d+):([0-9a-f]{16,})$/.exec(
    String(text ?? "").trim(),
  );
  if (!m) throw new QuayError("a payment key looks like owner:nonce:secret", 1);
  return { owner: m[1], nonce: Number(m[2]), secret: m[3], text: m[0] };
}

/** OutLayer resource limits from a function spec (always pass them, else a run only compiles). */
export function resourceLimits(spec = {}) {
  return {
    max_instructions: Number(spec.max_instructions ?? 2_000_000_000),
    max_memory_mb: Number(spec.max_memory_mb ?? 128),
    max_execution_seconds: Number(spec.max_seconds ?? 30),
  };
}

function outcomeSummary(outcome) {
  const hash =
    outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? null;
  const receipts = outcome?.receipts_outcome ?? [];
  const failures = receipts
    .filter((r) => r.outcome?.status?.Failure)
    .map((r) => JSON.stringify(r.outcome.status.Failure).slice(0, 300));
  if (outcome?.status?.Failure)
    failures.unshift(JSON.stringify(outcome.status.Failure).slice(0, 300));
  const logs = receipts.flatMap((r) => r.outcome?.logs ?? []);
  let value = null;
  const raw = outcome?.status?.SuccessValue;
  if (typeof raw === "string" && raw) {
    const text = Buffer.from(raw, "base64").toString("utf8");
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  return { hash, failures, logs, value };
}

/** Chain access through near-api-js. Tests pass their own `{ view, call }`. */
export function nearSender({ account, rpc, secret }) {
  const provider = createProvider(rpc);
  const signer = secret ? new Account(account, provider, secret) : null;
  return {
    async view(contractId, method, args = {}) {
      return provider.callFunction({ contractId, method, args });
    },
    /** One function call. `allowFailure` returns failed outcomes instead of throwing (FastFS fails on purpose). */
    async call(
      receiverId,
      method,
      args,
      { gas = GAS_SMALL, deposit = 0n, allowFailure = false } = {},
    ) {
      if (!signer) throw new QuayError("no signing key for this account", 1);
      try {
        const outcome = await signer.signAndSendTransaction({
          receiverId,
          actions: [actions.functionCall(method, args, gas, deposit)],
          waitUntil: allowFailure ? "INCLUDED_FINAL" : "EXECUTED_OPTIMISTIC",
          throwOnFailure: !allowFailure,
        });
        return outcomeSummary(outcome);
      } catch (error) {
        throw classifyChainError(error);
      }
    },
  };
}

async function readJson(res, what) {
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const reason =
      body?.error?.message ??
      body?.error ??
      body?.message ??
      text.slice(0, 200) ??
      "";
    throw new QuayError(
      `${what} failed with HTTP ${res.status}${reason ? `: ${String(reason).slice(0, 300)}` : ""}`,
      2,
    );
  }
  return body;
}

export function createOutlayer({
  account,
  rpc,
  secret,
  fetch: doFetch = (...a) => globalThis.fetch(...a),
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  near,
  contract = OUTLAYER_CONTRACT,
  api = OUTLAYER_API,
  token = PAYMENT_TOKEN,
} = {}) {
  const chain = near ?? nearSender({ account, rpc, secret });
  const view = (method, args) => chain.view(contract, method, args);

  async function pubkey(accessor, profile, secretsJson) {
    const res = await doFetch(`${api}/secrets/pubkey`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accessor,
        owner: account,
        profile,
        secrets_json: secretsJson,
      }),
    });
    const body = await readJson(res, "the OutLayer keystore key request");
    return body?.pubkey;
  }

  async function storeRow({ accessor, coordinator, profile, values, access }) {
    const key = await pubkey(
      coordinator,
      profile,
      JSON.stringify(placeholders(values)),
    );
    const args = {
      accessor,
      profile,
      encrypted_secrets_base64: encryptSecrets(key, JSON.stringify(values)),
      access,
      vault_id: null,
    };
    const estimate = BigInt(
      await view("estimate_storage_cost", { ...args, owner: account }),
    );
    const sent = await chain.call(contract, "store_secrets", args, {
      gas: GAS_STORE,
      deposit: estimate + EXTRA_DEPOSIT,
    });
    return { hash: sent.hash, deposit: estimate + EXTRA_DEPOSIT };
  }

  const projectId = (name) => `${account}/${name}`;

  return {
    account,
    contract,
    api,
    projectId,

    /** Upload wasm to FastFS (gas only) and wait until it is served with the right hash. */
    async upload(bytes, { timeoutMs = 180_000, intervalMs = 3_000 } = {}) {
      const sha256 = sha256Hex(bytes);
      const url = fastfsUrl(account, sha256, contract);
      const existing = await this.fetchHash(url).catch(() => null);
      if (existing === sha256)
        return { sha256, url, size: bytes.length, hash: null, reused: true };
      // The call is meant to fail (gas 1): the indexer keeps the args, the chain keeps nothing.
      const sent = await chain.call(
        contract,
        "__fastdata_fastfs",
        fastfsPayload(bytes, `${sha256}.wasm`),
        { gas: 1n, deposit: 0n, allowFailure: true },
      );
      const started = Date.now();
      for (;;) {
        const got = await this.fetchHash(url).catch(() => null);
        if (got === sha256)
          return { sha256, url, size: bytes.length, hash: sent.hash };
        if (Date.now() - started > timeoutMs)
          throw new QuayError(
            `FastFS did not serve ${url} within ${Math.round(timeoutMs / 1000)} s (transaction ${sent.hash})`,
            2,
          );
        await sleep(intervalMs);
      }
    },

    async fetchHash(url) {
      const res = await doFetch(url);
      if (!res.ok) return null;
      return sha256Hex(Buffer.from(await res.arrayBuffer()));
    },

    async getProject(name) {
      return view("get_project", { project_id: projectId(name) });
    },

    async listProjects(owner = account) {
      return (await view("list_user_projects", { account_id: owner })) ?? [];
    },

    /** Create the project, or add a version and make it active. */
    async deployProject(name, { url, sha256 }) {
      const source = {
        WasmUrl: { url, hash: sha256, build_target: BUILD_TARGET },
      };
      const existing = await this.getProject(name);
      if (existing?.active_version === sha256)
        return { project: projectId(name), created: false, unchanged: true };
      // Storage is about 0.01 NEAR per KB of project record; the excess is refunded.
      const deposit = 50_000_000_000_000_000_000_000n; // 0.05 NEAR, refunded above the cost
      if (!existing) {
        const sent = await chain.call(
          contract,
          "create_project",
          { name, source },
          { gas: GAS_PROJECT, deposit },
        );
        return { project: projectId(name), created: true, hash: sent.hash };
      }
      const sent = await chain.call(
        contract,
        "add_version",
        { project_name: name, source, set_active: true },
        { gas: GAS_PROJECT, deposit },
      );
      return { project: projectId(name), created: false, hash: sent.hash };
    },

    async deleteProject(name) {
      const sent = await chain.call(
        contract,
        "delete_project",
        { project_name: name },
        { gas: GAS_PROJECT },
      );
      return { hash: sent.hash };
    },

    /** Replace the function's `default` secret profile with `values` ({NAME: value}). */
    async storeSecrets(name, values, { site = account } = {}) {
      if (!values || Object.keys(values).length === 0)
        throw new QuayError("no secrets to store", 1);
      const id = projectId(name);
      return storeRow({
        accessor: { Project: { project_id: id } },
        coordinator: { type: "Project", project_id: id },
        profile: "default",
        values,
        access: siteAccess(site),
      });
    },

    async secretsRow(name) {
      return view("get_secrets", {
        accessor: { Project: { project_id: projectId(name) } },
        profile: "default",
        owner: account,
      });
    },

    async deleteSecrets(name) {
      const sent = await chain.call(
        contract,
        "delete_secrets",
        {
          accessor: { Project: { project_id: projectId(name) } },
          profile: "default",
        },
        { gas: GAS_SMALL },
      );
      return { hash: sent.hash };
    },

    /**
     * Create a payment key scoped to `projects` ("owner/name"). `save(keyText)`
     * runs before the transaction so a crash cannot leave an unspendable key.
     */
    async createPaymentKey({ projects = [], maxPerCall = "0", save }) {
      const nonce = Number(
        await view("get_next_payment_key_nonce", { account_id: account }),
      );
      const secretHex = randomBytes(32).toString("hex");
      const blob = (key) =>
        JSON.stringify({
          key,
          project_ids: projects,
          max_per_call: String(maxPerCall),
          initial_balance: "0",
        });
      const keyText = `${account}:${nonce}:${secretHex}`;
      const pk = await pubkey(
        { type: "System", PaymentKey: {} },
        String(nonce),
        blob("0".repeat(64)),
      );
      const args = {
        accessor: { System: "PaymentKey" },
        profile: String(nonce),
        encrypted_secrets_base64: encryptSecrets(pk, blob(secretHex)),
        access: "AllowAll",
        vault_id: null,
      };
      const estimate = BigInt(
        await view("estimate_storage_cost", { ...args, owner: account }),
      );
      if (save) await save(keyText, nonce);
      const sent = await chain.call(contract, "store_secrets", args, {
        gas: GAS_STORE,
        deposit: estimate + EXTRA_DEPOSIT,
      });
      return { nonce, key: keyText, hash: sent.hash, projects };
    },

    /** Mint test USDC (testnet only), register, and credit the key. `amount` in 6-decimal units. */
    async topUp(nonce, amount) {
      const hashes = [];
      const registered = await chain.view(token, "storage_balance_of", {
        account_id: account,
      });
      if (!registered) {
        const s = await chain.call(
          token,
          "storage_deposit",
          { account_id: account, registration_only: true },
          { gas: GAS_SMALL, deposit: FT_STORAGE },
        );
        hashes.push(s.hash);
      }
      const minted = await chain.call(
        token,
        "mint",
        { account_id: account, amount: String(amount) },
        { gas: GAS_SMALL },
      );
      hashes.push(minted.hash);
      const sent = await chain.call(
        token,
        "ft_transfer_call",
        {
          receiver_id: contract,
          amount: String(amount),
          msg: JSON.stringify({ action: "top_up_payment_key", nonce }),
        },
        { gas: GAS_FT, deposit: 1n },
      );
      hashes.push(sent.hash);
      return { hash: sent.hash, hashes, logs: sent.logs };
    },

    async balance(owner, nonce) {
      const res = await doFetch(
        `${api}/public/payment-keys/${owner}/${nonce}/balance`,
      );
      return readJson(res, "the payment key balance");
    },

    async usage(owner, nonce) {
      const res = await doFetch(
        `${api}/public/payment-keys/${owner}/${nonce}/usage`,
      );
      return readJson(res, "the payment key usage");
    },

    /** POST /call/{owner}/{project}. `secrets` passes secrets_ref {default, owner}. */
    async callHttps(
      project,
      input,
      { paymentKey, secrets = true, owner = account },
    ) {
      const key = parsePaymentKey(paymentKey);
      const body = { input };
      if (secrets) body.secrets_ref = { profile: "default", account_id: owner };
      const res = await doFetch(`${api}/call/${owner}/${project}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-payment-key": key.text,
        },
        body: JSON.stringify(body),
      });
      return readJson(res, `the call to ${owner}/${project}`);
    },

    async estimate(spec = {}, inputLen = 64) {
      return view("estimate_execution_cost", {
        resource_limits: resourceLimits(spec),
        input_len: inputLen,
      });
    },
  };
}
