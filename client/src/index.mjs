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
const MAX_GAS = 300_000_000_000_000n;
const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
 *  - relay: base URL of the relayer (serves /relay and /join), or { outlayer: { owner, project: "relay", paymentKey, api } }
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
  const outlayer = options.relay && typeof options.relay === "object" ? options.relay.outlayer : null;
  if (options.relay && typeof options.relay === "object" && !outlayer)
    throw new QuayError("relay must be a URL or { outlayer: { owner, project, paymentKey, api } }", "bad_config");
  const relayBase = typeof options.relay === "string" ? options.relay.replace(/\/+$/, "") : null;
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
  const failMessage = (json, fallback) => (json?.error ? (json.reason ? `${json.error}: ${json.reason}` : json.error) : fallback);

  // One OutLayer call: POST {api}/call/{owner}/{project}, answer envelope {call_id, status, output}.
  async function outlayerCall({ owner, project, paymentKey, api = "https://testnet-api.outlayer.ai", secretsAccount = owner }, input, label) {
    if (!owner || !paymentKey) throw new QuayError("OutLayer needs { owner, paymentKey }", "bad_config");
    const res = await doFetch(`${String(api).replace(/\/+$/, "")}/call/${owner}/${project}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment-key": paymentKey },
      body: JSON.stringify({ input, secrets_ref: { profile: "default", account_id: secretsAccount } }),
    });
    let env = null;
    try {
      env = await res.json();
    } catch {}
    if (!res.ok) throw new QuayError(failMessage(env, `outlayer ${label} failed with HTTP ${res.status}`), "relay_refused");
    let out = env?.output;
    if (typeof out === "string") {
      try {
        out = JSON.parse(out);
      } catch {}
    }
    if (out && typeof out === "object" && out.error) throw new QuayError(failMessage(out), "relay_refused");
    if (out == null)
      throw new QuayError(`outlayer ${label} ${env?.status === "failed" ? "failed" : "returned no output"}${env?.error ? `: ${env.error}` : ""}`, "relay_refused");
    return out;
  }

  // OutLayer hosts the relayer as a function: /join, /relay and /health become op calls.
  async function postOutlayer(path, body) {
    const op = path.replace(/^\//, "");
    const out = await outlayerCall({ project: "relay", ...outlayer }, { op, ...body }, op);
    if (typeof out !== "object") throw new QuayError(`outlayer ${op} returned no output`, "relay_refused");
    return out;
  }

  async function postRelay(path, body) {
    if (outlayer) return postOutlayer(path, body);
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
    if (!res.ok) throw new QuayError(failMessage(json, `relay ${path} failed with HTTP ${res.status}`), "relay_refused");
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

  async function walletWrite(method, args, gas, deposit, receiver = site) {
    const wallet = state.wallet ?? (await state.connector?.wallet());
    if (!wallet) throw new QuayError("sign in with a wallet first", "not_signed_in");
    const outcome = await wallet.signAndSendTransaction({
      signerId: state.account,
      receiverId: receiver,
      actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: String(gas), deposit: String(deposit) } }],
    });
    return { hash: outcome?.transaction?.hash, outcome };
  }

  async function keyWrite(method, args, gas, deposit, receiver = site) {
    const { Account, JsonRpcProvider } = await import("near-api-js");
    const k = options.key;
    const account = new Account(k.accountId, new JsonRpcProvider({ url: rpc.url }), k.secretKey);
    const outcome = await account.callFunctionRaw({ contractId: receiver, methodName: method, args, gas, deposit });
    return { hash: outcome?.transaction?.hash, outcome };
  }

  /** Send a write. Returns { hash, outcome, relayed }. */
  async function write(method, args, { deposit = 0n, gas = defaultGas, receiver = site } = {}) {
    const dep = toYocto(deposit);
    let result;
    if (options.key) result = await keyWrite(method, args, gas, dep, receiver);
    else if (state.mode === "member") {
      if (dep !== 0n)
        throw new QuayError(
          "this write attaches a deposit, which a relayed member cannot pay. Sign in with a wallet, or use a site-paid collection.",
          "deposit_needs_wallet",
        );
      result = await relayWrite(method, args, gas);
    } else if (state.mode === "wallet") result = await walletWrite(method, args, gas, dep, receiver);
    else throw new QuayError("sign in first: quay.auth.signIn()", "not_signed_in");
    const bad = failureOf(result.outcome);
    if (bad) throw new QuayError(`${method} failed: ${bad}`, "call_failed");
    return result;
  }

  /** The call's return value. { final: true } waits for the whole promise chain and reads the transaction result. */
  async function resultOf(method, written, { final = false } = {}) {
    let outcome = written.outcome;
    if (!outcome) {
      // relayed: read the transaction from the chain
      outcome = await rpc.call("EXPERIMENTAL_tx_status", {
        tx_hash: written.hash,
        sender_account_id: relayerId,
        wait_until: final ? "FINAL" : "EXECUTED_OPTIMISTIC",
      });
      const bad = failureOf(outcome);
      if (bad) throw new QuayError(`${method} failed: ${bad}`, "call_failed");
    }
    return final ? returnValue({ status: outcome.status }, site) : returnValue(outcome, site);
  }

  // A collection with on_add runs a function after each add and needs the full 300 Tgas.
  const collectionInfo = new Map();
  async function addGas(name) {
    if (!collectionInfo.has(name)) {
      try {
        collectionInfo.set(name, (await view("get_collection", { name })) ?? null);
      } catch {
        return defaultGas;
      }
    }
    return collectionInfo.get(name)?.on_add ? MAX_GAS : defaultGas;
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
          if (id != null) {
            if (!DOC_ID.test(String(id)) || /^\d+$/.test(String(id)))
              throw new QuayError("a doc id is 1 to 64 characters of A-Z a-z 0-9 _ - and may not be all digits (digits are automatic ids)", "bad_id");
            args.id = String(id);
          }
          const written = await write("db_add", args, { deposit, gas: await addGas(name) });
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

  const fnConfig = options.functions ?? {};
  const httpsKey = fnConfig.httpsKey ?? fnConfig.https_key ?? null;

  const functions = {
    /**
     * Run a site function. With functions.https_key it calls OutLayer over HTTPS (no wallet needed);
     * otherwise it sends fn_call (300 Tgas) through the member relayer, the wallet or the explicit key
     * and returns the function output from the transaction result.
     */
    async call(name, input = {}) {
      if (httpsKey)
        return outlayerCall({ owner: site, project: name, paymentKey: httpsKey, api: fnConfig.api }, input, name);
      const spec = await view("fn_get", { name });
      if (!spec) throw new QuayError(`unknown function ${name}`, "unknown_function");
      const deposit = spec.payer === "site" ? 0n : toYocto(spec.deposit ?? "5000000000000000000000");
      const written = await write("fn_call", { name, input: JSON.stringify(input ?? {}) }, { deposit, gas: MAX_GAS });
      const out = await resultOf("fn_call", written, { final: true });
      if (typeof out === "string") {
        try {
          return JSON.parse(out);
        } catch {}
      }
      return out;
    },
  };

  /**
   * Buy a product. Needs a wallet or an explicit key because it attaches a deposit.
   * { token: true } pays `price_token` in the site's NEP-141 token with ft_transfer_call.
   */
  async function pay(product, { ref, deposit, token = false } = {}) {
    if (token) {
      if (state.mode === "member")
        throw new QuayError("token payments need a wallet: members have no NEAR for the 1 yocto deposit. Sign in with a wallet.", "deposit_needs_wallet");
      const [tokenId, p] = await Promise.all([view("get_token", {}), view("get_product", { id: product })]);
      if (!tokenId) throw new QuayError("this site has no payment token configured", "no_token");
      if (!p) throw new QuayError(`unknown product ${product}`, "unknown_product");
      if (!p.price_token || BigInt(p.price_token) === 0n) throw new QuayError(`${product} has no token price`, "no_token_price");
      const msg = { product };
      if (ref != null) msg.ref = ref;
      await write("ft_transfer_call", { receiver_id: site, amount: String(p.price_token), msg: JSON.stringify(msg) }, { deposit: 1n, gas: 100_000_000_000_000n, receiver: tokenId });
      return;
    }
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
