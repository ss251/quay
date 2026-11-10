//! The Quay relayer (fullstack-interface section 6) as an OutLayer function.
//!
//! Input: `{"op":"relay","signed_delegate":"<base64>"}`, `{"op":"join","name","public_key"}`
//! or `{"op":"health"}`. Configuration comes from the function's secrets, which
//! only the site owner can set:
//!
//! - `RELAY_KEY` (required): the relayer account's `ed25519:` secret key.
//! - `RELAY_ACCOUNT`: the relayer account, default `relay.<site>`.
//! - `RELAY_SITE`: the site contract, default the OutLayer project owner.
//! - `RELAY_POLICY`: optional JSON overriding the policy fields below.
//! - `RELAY_RPC`: JSON-RPC URL, default `https://test.rpc.fastnear.com`.
//!
//! The relayer account's NEAR balance is the hard spend limit. Per-sender and
//! per-day counters live in OutLayer persistent storage.

use quay_fn::borsh::{Reader, Writer};
use quay_fn::encoding::{b58, b58_decode, b64, b64_decode, format_public_key, parse_public_key, parse_secret_key, sha256};
use quay_fn::rpc::Rpc;
use quay_fn::signin;
use quay_fn::{json, Value};

/// 2^30 + 366, the NEP-461 prefix for signed delegate actions.
pub const NEP461_TAG: u32 = 1_073_742_190;
const TGAS: u64 = 1_000_000_000_000;
const ACTION_FUNCTION_CALL: u8 = 2;
const ACTION_DELEGATE: u8 = 8;
const JOIN_GAS: u64 = 100 * TGAS;

#[derive(Debug, Clone, PartialEq)]
pub struct Policy {
    pub site: String,
    pub methods: Vec<String>,
    pub max_gas: u64,
    pub max_block_height_ahead: u64,
    pub per_account_per_hour: i64,
    pub daily_tgas: i64,
    pub joins_per_day: i64,
    pub allow_uploads: bool,
    pub member_only: bool,
}

impl Policy {
    pub fn new(site: &str) -> Self {
        Self {
            site: site.to_string(),
            methods: ["db_add", "db_update", "db_remove", "fn_call"].map(String::from).to_vec(),
            max_gas: 300 * TGAS,
            max_block_height_ahead: 200,
            per_account_per_hour: 30,
            daily_tgas: 30_000,
            joins_per_day: 50,
            allow_uploads: false,
            member_only: true,
        }
    }

    /// Apply `RELAY_POLICY` overrides. Unknown keys are an error so a typo is not ignored.
    pub fn with_overrides(mut self, v: &Value) -> Result<Self, String> {
        let obj = v.as_object().ok_or("RELAY_POLICY must be a JSON object")?;
        for (k, val) in obj {
            let bad = || format!("RELAY_POLICY.{k} has the wrong type");
            match k.as_str() {
                "site" => self.site = val.as_str().ok_or_else(bad)?.to_string(),
                "methods" => {
                    self.methods = val
                        .as_array()
                        .ok_or_else(bad)?
                        .iter()
                        .map(|m| m.as_str().map(String::from).ok_or_else(bad))
                        .collect::<Result<_, _>>()?
                }
                "max_gas" => self.max_gas = num(val).ok_or_else(bad)?,
                "max_block_height_ahead" => self.max_block_height_ahead = num(val).ok_or_else(bad)?,
                "per_account_per_hour" => self.per_account_per_hour = num(val).ok_or_else(bad)? as i64,
                "daily_tgas" => self.daily_tgas = num(val).ok_or_else(bad)? as i64,
                "joins_per_day" => self.joins_per_day = num(val).ok_or_else(bad)? as i64,
                "allow_uploads" => self.allow_uploads = val.as_bool().ok_or_else(bad)?,
                "member_only" => self.member_only = val.as_bool().ok_or_else(bad)?,
                _ => return Err(format!("RELAY_POLICY has an unknown key {k}")),
            }
        }
        Ok(self)
    }

    pub fn to_json(&self) -> Value {
        json!({
            "site": self.site,
            "methods": self.methods,
            "max_gas": self.max_gas.to_string(),
            "max_block_height_ahead": self.max_block_height_ahead,
            "per_account_per_hour": self.per_account_per_hour,
            "daily_tgas": self.daily_tgas,
            "joins_per_day": self.joins_per_day,
            "allow_uploads": self.allow_uploads,
            "member_only": self.member_only,
            "deposit": "0",
        })
    }
}

fn num(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

#[derive(Debug, Clone, PartialEq)]
pub struct FunctionCall {
    pub method: String,
    pub args: Vec<u8>,
    pub gas: u64,
    pub deposit: u128,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Delegate {
    pub sender: String,
    pub receiver: String,
    /// `Ok` for FunctionCall actions; `Err(tag)` for any other action kind.
    pub actions: Vec<Result<FunctionCall, u8>>,
    pub nonce: u64,
    pub max_block_height: u64,
    pub public_key: [u8; 32],
    /// The DelegateAction bytes (what the signature covers, after the NEP-461 tag).
    pub signed_part: Vec<u8>,
    pub signature: [u8; 64],
}

/// Decode a borsh `SignedDelegateAction`. Any non-FunctionCall action stops
/// decoding and is recorded as `Err(tag)`; such a delegate is always refused.
pub fn decode_signed_delegate(bytes: &[u8]) -> Result<Delegate, String> {
    let mut r = Reader::new(bytes);
    let sender = r.str()?;
    let receiver = r.str()?;
    let count = r.u32()?;
    if count > 64 {
        return Err("too many actions".into());
    }
    let mut actions = Vec::new();
    for _ in 0..count {
        let tag = r.u8()?;
        if tag != ACTION_FUNCTION_CALL {
            actions.push(Err(tag));
            return Ok(Delegate {
                sender,
                receiver,
                actions,
                nonce: 0,
                max_block_height: 0,
                public_key: [0; 32],
                signed_part: Vec::new(),
                signature: [0; 64],
            });
        }
        actions.push(Ok(FunctionCall { method: r.str()?, args: r.bytes()?.to_vec(), gas: r.u64()?, deposit: r.u128()? }));
    }
    let nonce = r.u64()?;
    let max_block_height = r.u64()?;
    if r.u8()? != 0 {
        return Err("only ed25519 keys are supported".into());
    }
    let public_key: [u8; 32] = r.raw(32)?.try_into().unwrap();
    let signed_part = bytes[..r.pos()].to_vec();
    if r.u8()? != 0 {
        return Err("only ed25519 signatures are supported".into());
    }
    let signature: [u8; 64] = r.raw(64)?.try_into().unwrap();
    if !r.done() {
        return Err("trailing bytes".into());
    }
    Ok(Delegate { sender, receiver, actions, nonce, max_block_height, public_key, signed_part, signature })
}

/// sha256(borsh_u32(NEP461_TAG) || DelegateAction).
pub fn delegate_hash(d: &Delegate) -> [u8; 32] {
    sha256(&Writer::new().u32(NEP461_TAG).raw(&d.signed_part).finish())
}

/// A refusal: a stable code plus a reason naming the rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub reason: String,
}

fn refuse<T>(code: &'static str, reason: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal { code, reason: reason.into() })
}

/// Budget counters. OutLayer storage in the guest, a map in tests.
pub trait Store {
    fn get(&self, key: &str) -> Result<i64, String>;
    fn add(&self, key: &str, delta: i64) -> Result<i64, String>;
}

#[derive(Default)]
pub struct MemoryStore(std::cell::RefCell<std::collections::HashMap<String, i64>>);

impl Store for MemoryStore {
    fn get(&self, key: &str) -> Result<i64, String> {
        Ok(*self.0.borrow().get(key).unwrap_or(&0))
    }
    fn add(&self, key: &str, delta: i64) -> Result<i64, String> {
        let mut m = self.0.borrow_mut();
        let v = m.entry(key.to_string()).or_insert(0);
        *v += delta;
        Ok(*v)
    }
}

pub fn hour_bucket(ms: u64) -> u64 {
    ms / 3_600_000
}

pub fn day_bucket(ms: u64) -> u64 {
    ms / 86_400_000
}

/// `<name>.<site>` with one label, the only accounts `join` creates. A deeper
/// `x.<name>.<site>` belongs to a member, who could mint any number of them to
/// get around the per-sender limit.
pub fn is_member_of(sender: &str, site: &str) -> bool {
    sender
        .strip_suffix(site)
        .and_then(|rest| rest.strip_suffix('.'))
        .is_some_and(|name| !name.is_empty() && !name.contains('.'))
}

/// What a passing delegate charges once it is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Charge {
    pub hour_key: String,
    pub day_key: String,
    pub tgas: i64,
}

/// Check a delegate against the policy (section 6), in the same order as `client/src/relay-core.mjs`.
pub fn check(d: &Delegate, p: &Policy, now_ms: u64, height: u64, store: &dyn Store) -> Result<Charge, Refusal> {
    if d.actions.is_empty() {
        return refuse("no_actions", "delegate has no actions");
    }
    if d.actions.iter().any(|a| a.is_err()) {
        return refuse("action_not_allowed", "only FunctionCall actions are allowed");
    }
    if !signin::verify(&d.public_key, &delegate_hash(d), &d.signature) {
        return refuse("bad_signature", "delegate signature is invalid");
    }
    let calls: Vec<&FunctionCall> = d.actions.iter().filter_map(|a| a.as_ref().ok()).collect();
    let mut gas: u64 = 0;
    for a in &calls {
        if a.deposit != 0 {
            return refuse("deposit_not_allowed", "relayed calls must attach no deposit");
        }
        gas = gas.saturating_add(a.gas);
    }
    if gas > p.max_gas {
        return refuse("gas_too_high", format!("gas {gas} exceeds the limit of {}", p.max_gas));
    }
    if p.member_only && !is_member_of(&d.sender, &p.site) {
        return refuse("sender_not_member", format!("sender must be a member of {}", p.site));
    }
    if d.receiver == p.site {
        if let Some(a) = calls.iter().find(|a| !p.methods.contains(&a.method)) {
            return refuse("method_not_allowed", format!("method {} is not relayed", a.method));
        }
    } else if d.receiver == d.sender && p.allow_uploads {
        if let Some(a) = calls.iter().find(|a| a.method != "fs_store") {
            return refuse("method_not_allowed", format!("method {} is not relayed", a.method));
        }
    } else {
        return refuse("receiver_not_allowed", format!("receiver {} is not allowed", d.receiver));
    }
    if d.max_block_height <= height {
        return refuse("expired", "delegate has expired");
    }
    if d.max_block_height > height + p.max_block_height_ahead {
        return refuse(
            "expiry_too_far",
            format!("max_block_height is more than {} blocks ahead", p.max_block_height_ahead),
        );
    }
    let charge = Charge {
        hour_key: format!("acct:{}:{}", d.sender, hour_bucket(now_ms)),
        day_key: format!("tgas:{}", day_bucket(now_ms)),
        tgas: (gas.div_ceil(TGAS)) as i64,
    };
    let store_err = |e: String| Refusal { code: "store_unavailable", reason: format!("rate-limit store: {e}") };
    if store.get(&charge.hour_key).map_err(store_err)? >= p.per_account_per_hour {
        return refuse(
            "account_rate_limit",
            format!("{} reached {} relays this hour", d.sender, p.per_account_per_hour),
        );
    }
    if store.get(&charge.day_key).map_err(store_err)? + charge.tgas > p.daily_tgas {
        return refuse("daily_budget", "daily gas budget is used up");
    }
    Ok(charge)
}

/// Take the charge from the budgets, or refuse. `check` reads the counters and
/// `reserve` adds to them, so two runs that passed `check` together could both
/// send; here each add returns the new total and one over the limit is rolled back.
pub fn reserve(charge: &Charge, p: &Policy, store: &dyn Store) -> Result<(), Refusal> {
    let store_err = |e: String| Refusal { code: "store_unavailable", reason: format!("rate-limit store: {e}") };
    let relays = store.add(&charge.hour_key, 1).map_err(store_err)?;
    if relays > p.per_account_per_hour {
        let _ = store.add(&charge.hour_key, -1);
        return refuse("account_rate_limit", format!("the sender reached {} relays this hour", p.per_account_per_hour));
    }
    let tgas = match store.add(&charge.day_key, charge.tgas) {
        Ok(t) => t,
        Err(e) => {
            let _ = store.add(&charge.hour_key, -1);
            return Err(store_err(e));
        }
    };
    if tgas > p.daily_tgas {
        let _ = store.add(&charge.day_key, -charge.tgas);
        let _ = store.add(&charge.hour_key, -1);
        return refuse("daily_budget", "daily gas budget is used up");
    }
    Ok(())
}

/// Give a reservation back when nothing was sent.
pub fn release(charge: &Charge, store: &dyn Store) {
    let _ = store.add(&charge.hour_key, -1);
    let _ = store.add(&charge.day_key, -charge.tgas);
}

/// The delegate's key must be on the sender account with a lower nonce. The
/// signature alone proves nothing: anyone can sign a delegate for any
/// `<name>.<site>` with a key of their own, or resend one they saw on chain. The
/// chain would refuse both, but only after the relayer paid for the try.
pub fn check_sender_key(rpc: &Rpc, d: &Delegate) -> Result<(), Refusal> {
    let key = match rpc.access_key(&d.sender, &format_public_key(&d.public_key)) {
        Ok(k) => k,
        Err(e) => return refuse("rpc", quay_fn::clip(&e, 300)),
    };
    let Some(key) = key else {
        return refuse("unknown_key", format!("the delegate's key is not a key of {}", d.sender));
    };
    let Some(nonce) = key.get("nonce").and_then(Value::as_u64) else {
        return refuse("rpc", "the access key view has no nonce");
    };
    if d.nonce <= nonce {
        return refuse("nonce_used", "the delegate's nonce is already used; sign a new one");
    }
    Ok(())
}

pub enum Action<'a> {
    /// A whole borsh SignedDelegateAction.
    Delegate(&'a [u8]),
    FunctionCall(&'a FunctionCall),
}

/// Borsh `Transaction` (V0).
pub fn encode_transaction(
    signer: &str,
    public_key: &[u8; 32],
    nonce: u64,
    receiver: &str,
    block_hash: &[u8; 32],
    actions: &[Action],
) -> Vec<u8> {
    let mut w = Writer::new();
    w.str(signer).u8(0).raw(public_key).u64(nonce).str(receiver).raw(block_hash).u32(actions.len() as u32);
    for a in actions {
        match a {
            Action::Delegate(bytes) => {
                w.u8(ACTION_DELEGATE).raw(bytes);
            }
            Action::FunctionCall(c) => {
                w.u8(ACTION_FUNCTION_CALL).str(&c.method).bytes(&c.args).u64(c.gas).u128(c.deposit);
            }
        }
    }
    w.finish()
}

/// Sign a transaction: returns (borsh SignedTransaction, base58 tx hash).
pub fn sign_transaction(seed: &[u8; 32], tx: &[u8]) -> (Vec<u8>, String) {
    let hash = sha256(tx);
    let sig = signin::sign(seed, &hash);
    let signed = Writer::new().raw(tx).u8(0).raw(&sig).finish();
    (signed, b58(&hash))
}

/// Every failure in a final execution outcome: outer status, transaction outcome, each receipt.
pub fn failures(outcome: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut add = |f: &Value| out.push(quay_fn::clip(&f.to_string(), 400));
    if let Some(f) = outcome.pointer("/status/Failure") {
        add(f);
    }
    if let Some(f) = outcome.pointer("/transaction_outcome/outcome/status/Failure") {
        add(f);
    }
    for r in outcome.get("receipts_outcome").and_then(Value::as_array).into_iter().flatten() {
        if let Some(f) = r.pointer("/outcome/status/Failure") {
            add(f);
        }
    }
    out
}

/// Member names: 2 to 32 bytes of `[a-z0-9_-]`, not reserved.
pub fn check_member_name(name: &str) -> Result<(), String> {
    let ok = (2..=32).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    if !ok {
        return Err("name must be 2 to 32 characters of a-z, 0-9, _ and -".into());
    }
    if ["relay", "admin", "www", "api", "quay"].contains(&name) {
        return Err(format!("{name} is reserved"));
    }
    Ok(())
}

/// The relayer's identity and policy, read from the function's secrets.
pub struct Config {
    pub account: String,
    pub seed: [u8; 32],
    pub public_key: [u8; 32],
    pub policy: Policy,
}

impl Config {
    /// `get(name)` reads an environment variable (a secret).
    pub fn from_env(get: &dyn Fn(&str) -> Option<String>) -> Result<Config, String> {
        let site = get("RELAY_SITE").or_else(|| get("OUTLAYER_PROJECT_OWNER")).ok_or("RELAY_SITE is not set")?;
        let mut policy = Policy::new(&site);
        if let Some(text) = get("RELAY_POLICY") {
            let v: Value = serde_json::from_str(&text).map_err(|_| "RELAY_POLICY is not JSON".to_string())?;
            policy = policy.with_overrides(&v)?;
        }
        let account = get("RELAY_ACCOUNT").unwrap_or_else(|| format!("relay.{site}"));
        // Never echo the key or a parse error that might contain it.
        let key = get("RELAY_KEY").ok_or("RELAY_KEY is not set: run quay relay deploy")?;
        let seed = parse_secret_key(&key).map_err(|_| "RELAY_KEY is not an ed25519 secret key".to_string())?;
        let public_key = signin::public_key_of(&seed);
        Ok(Config { account, seed, public_key, policy })
    }
}

/// Chain state needed to send: the relayer key's next nonce, a recent block hash, and the height.
pub struct Head {
    pub nonce: u64,
    pub block_hash: [u8; 32],
    pub height: u64,
}

pub fn head(rpc: &Rpc, cfg: &Config) -> Result<Head, String> {
    let header = rpc.final_block()?;
    let height = header.get("height").and_then(Value::as_u64).ok_or("block has no height")?;
    let hash = header.get("hash").and_then(Value::as_str).ok_or("block has no hash")?;
    let block_hash: [u8; 32] = b58_decode(hash)?.try_into().map_err(|_| "bad block hash")?;
    let key = rpc
        .access_key(&cfg.account, &format_public_key(&cfg.public_key))?
        .ok_or_else(|| format!("RELAY_KEY is not a key of {}", cfg.account))?;
    let nonce = key.get("nonce").and_then(Value::as_u64).ok_or("access key has no nonce")?;
    Ok(Head { nonce: nonce + 1, block_hash, height })
}

/// How long `send` waits on the RPC node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wait {
    /// Return once the transaction is in a block (about one block). Inner receipts,
    /// such as an `on_add` trigger that waits for another OutLayer run, are not
    /// waited for: the caller reads the outcome from the chain itself.
    Included,
    /// Wait until every receipt ran (no yield involved, for example `join`).
    Executed,
}

/// Classify an RPC answer to `send_tx`. The hash is computed locally, so a timeout
/// or a dropped connection is not a failure: the transaction may be in, and the
/// caller must look it up instead of sending again.
pub fn send_result(res: Result<Value, String>, hash: &str) -> Value {
    match res {
        Ok(outcome) => {
            let bad = failures(&outcome);
            if !bad.is_empty() {
                return json!({ "error": format!("relayed call failed: {}", bad.join("; ")), "code": "inner_failure", "hash": hash });
            }
            let executed = outcome.get("receipts_outcome").is_some();
            json!({ "hash": hash, "status": if executed { "executed" } else { "included" } })
        }
        // The relayer holds the delegate's prepaid gas (about 0.001 NEAR per Tgas) until every
        // receipt, an on_add trigger included, has run. Nothing was sent: the same delegate can
        // be sent again once earlier relays have been refunded.
        Err(e) if e.contains("NotEnoughBalance") => json!({
            "error": "the relayer's free balance is held by relays still running; send the same delegate again in a few seconds",
            "code": "relayer_busy",
        }),
        Err(e) if e.starts_with("rpc send_tx:") && !e.contains("TIMEOUT") => {
            json!({ "error": quay_fn::clip(&e, 400), "code": "rejected", "hash": hash })
        }
        Err(_) => json!({ "hash": hash, "status": "pending" }),
    }
}

/// Submit a signed transaction. Returns `{hash, status}` or `{error, code, hash}`.
pub fn send(rpc: &Rpc, signed: &[u8], hash: &str, wait: Wait) -> Value {
    let wait_until = match wait {
        Wait::Included => "INCLUDED",
        Wait::Executed => "EXECUTED_OPTIMISTIC",
    };
    send_result(rpc.call("send_tx", json!({ "signed_tx_base64": b64(signed), "wait_until": wait_until })), hash)
}

/// Sign `actions` for `receiver` with a fresh nonce and send. One retry with a new
/// nonce when another relay took ours (`InvalidNonce`).
pub fn sign_and_send(rpc: &Rpc, cfg: &Config, first: &Head, receiver: &str, actions: &[Action], wait: Wait) -> Value {
    let mut nonce = first.nonce;
    let mut block_hash = first.block_hash;
    for attempt in 0..2 {
        let tx = encode_transaction(&cfg.account, &cfg.public_key, nonce, receiver, &block_hash, actions);
        let (signed, hash) = sign_transaction(&cfg.seed, &tx);
        let out = send(rpc, &signed, &hash, wait);
        let raced = out["code"] == "rejected" && out["error"].as_str().is_some_and(|e| e.contains("InvalidNonce"));
        if !raced || attempt == 1 {
            return out;
        }
        match head(rpc, cfg) {
            Ok(h) => {
                nonce = h.nonce.max(nonce + 1);
                block_hash = h.block_hash;
            }
            Err(_) => return out,
        }
    }
    unreachable!()
}

fn refusal_json(r: Refusal) -> Value {
    json!({ "error": r.reason, "code": r.code })
}

/// Handle one request. `now_ms` is wall-clock time.
pub fn handle(input: &Value, cfg: &Config, rpc: &Rpc, store: &dyn Store, now_ms: u64) -> Value {
    match input.get("op").and_then(Value::as_str).unwrap_or("") {
        "health" => {
            let balance = rpc
                .view_account(&cfg.account)
                .ok()
                .and_then(|a| a.get("amount").cloned())
                .unwrap_or(Value::Null);
            // Each relay holds its prepaid gas (~0.001 NEAR per Tgas) until it finishes.
            let held_per_relay = u128::from(cfg.policy.max_gas / TGAS) * 1_000_000_000_000_000_000_000;
            let capacity = balance
                .as_str()
                .and_then(|b| b.parse::<u128>().ok())
                .map(|b| (b / held_per_relay.max(1)) as u64);
            json!({
                "site": cfg.policy.site,
                "relayer": cfg.account,
                "balance": balance,
                "relays_in_flight": capacity,
                "policy": cfg.policy.to_json(),
                "host": "outlayer",
            })
        }
        "relay" => {
            let Some(text) = input.get("signed_delegate").and_then(Value::as_str) else {
                return json!({ "error": "pass signed_delegate as base64", "code": "malformed" });
            };
            let Ok(bytes) = b64_decode(text) else {
                return json!({ "error": "signed_delegate is not valid base64", "code": "malformed" });
            };
            let d = match decode_signed_delegate(&bytes) {
                Ok(d) => d,
                Err(e) => return json!({ "error": format!("cannot decode signed delegate: {e}"), "code": "malformed" }),
            };
            let head = match head(rpc, cfg) {
                Ok(h) => h,
                Err(e) => return json!({ "error": e, "code": "rpc" }),
            };
            let charge = match check(&d, &cfg.policy, now_ms, head.height, store) {
                Ok(c) => c,
                Err(r) => return refusal_json(r),
            };
            if let Err(r) = check_sender_key(rpc, &d) {
                return refusal_json(r);
            }
            // Charge before sending: a relay that times out or fails on chain still spent gas.
            if let Err(r) = reserve(&charge, &cfg.policy, store) {
                return refusal_json(r);
            }
            // Return once included: waiting for execution would also wait for any
            // on_add trigger, which is another OutLayer run, and outlast the HTTPS window.
            let mut out = sign_and_send(rpc, cfg, &head, &d.sender, &[Action::Delegate(&bytes)], Wait::Included);
            if out["code"] == "relayer_busy" {
                // nothing was sent; the client sends the same delegate again
                release(&charge, store);
            }
            out["sender"] = json!(d.sender);
            out
        }
        "join" => {
            let name = input.get("name").and_then(Value::as_str).unwrap_or("");
            let public_key = input.get("public_key").and_then(Value::as_str).unwrap_or("");
            if let Err(e) = check_member_name(name) {
                return json!({ "error": e, "code": "bad_name" });
            }
            if parse_public_key(public_key).is_err() {
                return json!({ "error": "public_key must be ed25519:<base58>", "code": "bad_key" });
            }
            let day_key = format!("join:{}", day_bucket(now_ms));
            match store.get(&day_key) {
                Ok(n) if n >= cfg.policy.joins_per_day => {
                    return json!({ "error": format!("at most {} joins a day", cfg.policy.joins_per_day), "code": "join_rate_limit" })
                }
                Err(e) => return json!({ "error": format!("rate-limit store: {e}"), "code": "store_unavailable" }),
                _ => {}
            }
            let head = match head(rpc, cfg) {
                Ok(h) => h,
                Err(e) => return json!({ "error": e, "code": "rpc" }),
            };
            let call = FunctionCall {
                method: "join".into(),
                args: json!({ "name": name, "public_key": public_key }).to_string().into_bytes(),
                gas: JOIN_GAS,
                deposit: 0,
            };
            // add, then check the total: two runs that both read n - 1 cannot both join
            match store.add(&day_key, 1) {
                Ok(n) if n > cfg.policy.joins_per_day => {
                    let _ = store.add(&day_key, -1);
                    return json!({ "error": format!("at most {} joins a day", cfg.policy.joins_per_day), "code": "join_rate_limit" });
                }
                Err(e) => return json!({ "error": format!("rate-limit store: {e}"), "code": "store_unavailable" }),
                _ => {}
            }
            let site = cfg.policy.site.clone();
            let mut out = sign_and_send(rpc, cfg, &head, &site, &[Action::FunctionCall(&call)], Wait::Executed);
            if out.get("error").is_none() {
                out["account"] = json!(format!("{name}.{}", cfg.policy.site));
            }
            out
        }
        "" => json!({ "error": "pass op: relay, join or health", "code": "malformed" }),
        other => json!({ "error": format!("unknown op {other}"), "code": "malformed" }),
    }
}

#[cfg(test)]
mod tests;
