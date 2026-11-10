// @quay/client: reads, writes, sign-in and member sessions for a Quay v3 site.
import {
  base58Decode,
  base64Decode,
  base64Encode,
  encodeSignedDelegate,
  formatPublicKey,
  generateKey,
  nep413Sign,
  parseSecretKey,
  randomBytes,
  signDelegate,
} from "./encoding.mjs";
import { createRpc } from "./rpc.mjs";

export { verifySignIn } from "./verify.mjs";

const CONNECT_URL = "https://esm.sh/@hot-labs/near-connect@0.12.0";
const DEFAULT_GAS = 50_000_000_000_000n;
const DELEGATE_TTL = 120n;

export class QuayError extends Error {
  constructor(message, code = "quay_error") {
    super(message);
    this.name = "QuayError";
    this.code = code;
  }
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}
function defaultStorage() {
  try {
    const s = globalThis.localStorage;
    if (s) return s;
  } catch {}
  return memoryStorage();
}

const toYocto = (v) => {
  try {
    return BigInt(v ?? 0);
  } catch {
    throw new QuayError("deposit must be a whole number of yoctoNEAR", "bad_deposit");
  }
};

/** Return value of the call on `receiver` from a final execution outcome, parsed as JSON. */
export function returnValue(outcome, receiver) {
  const decode = (b64) => {
    if (!b64) return undefined;
    const text = new TextDecoder().decode(base64Decode(b64));
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  for (const r of outcome?.receipts_outcome ?? []) {
    if (r.outcome?.executor_id === receiver && r.outcome.status?.SuccessValue) return decode(r.outcome.status.SuccessValue);
  }
  return decode(outcome?.status?.SuccessValue);
}

function failureOf(outcome) {
  const bad = [];
  if (outcome?.status?.Failure) bad.push(outcome.status.Failure);
  for (const r of outcome?.receipts_outcome ?? []) if (r.outcome?.status?.Failure) bad.push(r.outcome.status.Failure);
  return bad.length ? JSON.stringify(bad[0]).slice(0, 300) : null;
}

/**
 * connect({ site, rpc?, relay?, relayer?, fetch?, storage?, key?, wallet?, now?, gas? })
 *  - relay: base URL of the relayer (serves /relay and /join)
 *  - key: { accountId, secretKey } explicit key, Node scripts and tests (near-api-js must be installed)
 *  - wallet: a near-connect module `{ NearConnector }` to use instead of loading it from esm.sh
 */
export function connect(options) {
  if (!options?.site) throw new QuayError("connect needs { site }", "bad_config");
  const site = options.site;
  const doFetch = options.fetch ?? ((...a) => globalThis.fetch(...a));
  const rpc = createRpc({ url: options.rpc, fetch: doFetch });
  const storage = options.storage ?? defaultStorage();
  const sessionKey = `quay:${site}:session`;
  const relayBase = options.relay ? String(options.relay).replace(/\/+$/, "") : null;
  const relayerId = options.relayer ?? `relay.${site}`;
  const defaultGas = BigInt(options.gas ?? DEFAULT_GAS);
  const now = options.now ?? (() => Date.now());

  const state = { mode: null, account: null, proof: null, connector: null, wallet: null };

  // ----- member session storage -----
  const readSession = () => {
    try {
      const raw = storage.getItem(sessionKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const writeSession = (s) => {
    try {
      storage.setItem(sessionKey, JSON.stringify(s));
    } catch {}
  };
  const resumed = readSession();
  if (resumed?.active && resumed.accountId) {
    state.mode = "member";
    state.account = resumed.accountId;
  }

  // ----- reads -----
  const view = (method, args) => rpc.view(site, method, args);

  // ----- writes -----
  async function postRelay(path, body) {
    if (!relayBase) throw new QuayError("no relay configured: pass connect({ site, relay: <relayer URL> })", "no_relay");
    const res = await doFetch(`${relayBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    if (!res.ok) throw new QuayError(json?.error ?? `relay ${path} failed with HTTP ${res.status}`, "relay_refused");
    return json;
  }

  async function relayWrite(method, args, gas) {
    const s = readSession();
    if (!s?.active) throw new QuayError("sign in first", "not_signed_in");
    const { publicKey } = parseSecretKey(s.secretKey);
    const pk = formatPublicKey(publicKey);
    const [key, head] = await Promise.all([rpc.accessKey(s.accountId, pk, "optimistic"), rpc.block()]);
    if (!key) throw new QuayError("your member key is not on the account yet; sign in again", "member_key_missing");
    const delegate = {
      senderId: s.accountId,
      receiverId: site,
      actions: [{ methodName: method, args, gas, deposit: 0n }],
      nonce: BigInt(key.nonce) + 1n,
      maxBlockHeight: BigInt(head.height) + DELEGATE_TTL,
      publicKey: pk,
    };
    const signed = await signDelegate(delegate, s.secretKey);
    const out = await postRelay("/relay", { signed_delegate: base64Encode(encodeSignedDelegate(signed)) });
    return { hash: out.hash, outcome: null, relayed: true };
  }

  async function walletWrite(method, args, gas, deposit) {
    const wallet = state.wallet ?? (await state.connector?.wallet());
    if (!wallet) throw new QuayError("sign in with a wallet first", "not_signed_in");
    const outcome = await wallet.signAndSendTransaction({
      signerId: state.account,
      receiverId: site,
      actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: String(gas), deposit: String(deposit) } }],
    });
    return { hash: outcome?.transaction?.hash, outcome };
  }

  async function keyWrite(method, args, gas, deposit) {
    const { Account, JsonRpcProvider } = await import("near-api-js");
    const k = options.key;
    const account = new Account(k.accountId, new JsonRpcProvider({ url: rpc.url }), k.secretKey);
    const outcome = await account.callFunctionRaw({ contractId: site, methodName: method, args, gas, deposit });
    return { hash: outcome?.transaction?.hash, outcome };
  }

  /** Send a write. Returns { hash, outcome, relayed }. */
  async function write(method, args, { deposit = 0n, gas = defaultGas } = {}) {
    const dep = toYocto(deposit);
    let result;
    if (options.key) result = await keyWrite(method, args, gas, dep);
    else if (state.mode === "member") {
      if (dep !== 0n)
        throw new QuayError(
          "this write attaches a deposit, which a relayed member cannot pay. Sign in with a wallet, or use a site-paid collection.",
          "deposit_needs_wallet",
        );
      result = await relayWrite(method, args, gas);
    } else if (state.mode === "wallet") result = await walletWrite(method, args, gas, dep);
    else throw new QuayError("sign in first: quay.auth.signIn()", "not_signed_in");
    const bad = failureOf(result.outcome);
    if (bad) throw new QuayError(`${method} failed: ${bad}`, "call_failed");
    return result;
  }

  async function resultOf(method, written) {
    if (written.outcome) return returnValue(written.outcome, site);
    // relayed: read the inner receipt from the chain
    const outcome = await rpc.call("EXPERIMENTAL_tx_status", {
      tx_hash: written.hash,
      sender_account_id: relayerId,
      wait_until: "EXECUTED_OPTIMISTIC",
    });
    const bad = failureOf(outcome);
    if (bad) throw new QuayError(`${method} failed: ${bad}`, "call_failed");
    return returnValue(outcome, site);
  }

  // ----- db -----
  const db = {
    collection(name) {
      return {
        name,
        list: (query = {}) => view("db_list", { collection: name, query }),
        async get(id) {
          return (await view("db_get", { collection: name, id: String(id) })) ?? null;
        },
        async add(data, { id, deposit } = {}) {
          const args = { collection: name, data: JSON.stringify(data) };
          if (id != null) args.id = String(id);
          const written = await write("db_add", args, { deposit });
          if (id != null) return String(id);
          return resultOf("db_add", written);
        },
        async update(id, data, { deposit } = {}) {
          await write("db_update", { collection: name, id: String(id), data: JSON.stringify(data) }, { deposit });
        },
        async remove(id) {
          await write("db_remove", { collection: name, id: String(id) });
        },
      };
    },
    collections: () => view("list_collections", {}),
    pool: () => view("get_pool", {}),
  };

  const members = {
    list: ({ from = 0, limit = 50 } = {}) => view("list_members", { from_index: from, limit }),
    isMember: (account) => view("is_member", { account }),
  };

  // ----- auth -----
  const message = (issued) => `Sign in to ${site}\nSite: ${site}\nIssued: ${issued}`;

  function normalizeSignature(sig) {
    if (typeof sig !== "string") return base64Encode(new Uint8Array(sig));
    if (sig.startsWith("ed25519:")) return base64Encode(base58Decode(sig.slice(8)));
    return sig;
  }

  async function memberSignIn(name) {
    let s = readSession();
    if (!s) {
      const key = await generateKey();
      const handle = name ?? `u${[...randomBytes(4)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      const res = await postRelay("/join", { name: handle, public_key: formatPublicKey(key.publicKey) });
      s = { name: handle, accountId: res.account, publicKey: formatPublicKey(key.publicKey), secretKey: key.secretKey, active: true };
    } else if (name && !s.accountId.startsWith(`${name}.`)) {
      throw new QuayError(`this browser already holds the member ${s.accountId}; call auth.forget() to start over`, "session_exists");
    }
    s.active = true;
    writeSession(s);
    const nonce = randomBytes(32);
    const msg = message(new Date(now()).toISOString());
    const signature = await nep413Sign(s.secretKey, { message: msg, nonce, recipient: site });
    state.mode = "member";
    state.account = s.accountId;
    return {
      accountId: s.accountId,
      publicKey: s.publicKey,
      signature: base64Encode(signature),
      message: msg,
      nonce: base64Encode(nonce),
      recipient: site,
    };
  }

  async function walletSignIn() {
    if (!state.connector) {
      const mod = options.wallet ?? globalThis.QUAY_TEST_WALLET ?? (await import(/* @vite-ignore */ CONNECT_URL));
      state.connector = new mod.NearConnector({
        network: "testnet",
        features: { testnet: true, signMessage: true, signAndSendTransaction: true },
      });
      state.connector.on?.("wallet:signOut", () => {
        if (state.mode === "wallet") {
          state.mode = null;
          state.account = null;
          state.wallet = null;
        }
      });
    }
    await state.connector.connect();
    const wallet = await state.connector.wallet();
    const nonce = randomBytes(32);
    const msg = message(new Date(now()).toISOString());
    const signed = await wallet.signMessage({ message: msg, recipient: site, nonce });
    state.wallet = wallet;
    state.mode = "wallet";
    state.account = signed.accountId;
    return {
      accountId: signed.accountId,
      publicKey: signed.publicKey,
      signature: normalizeSignature(signed.signature),
      message: msg,
      nonce: base64Encode(nonce),
      recipient: site,
    };
  }

  const auth = {
    get account() {
      return state.account;
    },
    get mode() {
      return state.mode;
    },
    get proof() {
      return state.proof;
    },
    /** signIn({ mode: "wallet" | "member", name? }) -> sign-in proof */
    async signIn({ mode = "wallet", name } = {}) {
      if (mode !== "wallet" && mode !== "member") throw new QuayError(`unknown sign-in mode ${mode}`, "bad_mode");
      state.proof = mode === "member" ? await memberSignIn(name) : await walletSignIn();
      return state.proof;
    },
    /** Signs out in memory. A member key stays in storage so the same account can sign in again. */
    async signOut() {
      if (state.mode === "wallet") {
        try {
          await state.connector?.disconnect?.();
        } catch {}
      }
      if (state.mode === "member") {
        const s = readSession();
        if (s) writeSession({ ...s, active: false });
      }
      state.mode = state.account = state.proof = state.wallet = null;
    },
    /** Delete the stored member key. The account is unreachable afterwards. */
    forget() {
      try {
        storage.removeItem(sessionKey);
      } catch {}
      if (state.mode === "member") state.mode = state.account = state.proof = null;
    },
  };

  const functions = {
    async call(name) {
      throw new QuayError(`functions are not configured: quay.functions.call("${name}") has no function host for ${site}`, "not_configured");
    },
  };

  /** Buy a product. Needs a wallet or an explicit key because it attaches a deposit. */
  async function pay(product, { ref, deposit } = {}) {
    let amount = deposit;
    if (amount == null) {
      const p = await view("get_product", { id: product });
      if (!p) throw new QuayError(`unknown product ${product}`, "unknown_product");
      amount = p.price_yocto;
    }
    const args = { product };
    if (ref != null) args.ref = ref;
    await write("pay", args, { deposit: amount });
  }

  return { site, rpc, db, members, auth, functions, pay, view };
}
