//! Functions (section 3): a registry of OutLayer projects the site may call.
//!
//! `fn_call` sends `request_execution` to the OutLayer contract and chains
//! `fn_on_result`, which stores the output in the system collection `_fn` as
//! doc `<fn>-<n>`. A collection's `on_add` runs a function after each
//! `db_add`; the result lands in that doc's `fn` field. Cron jobs (`cron.rs`)
//! use the same launch path.
//!
//! Result storage is paid from the site pool. When the pool cannot hold the
//! output, the result is stored without it (or not at all), never panicking.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, Value};
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, Gas, GasWeight, NearToken, Promise, PromiseError};

use crate::db::{name_ok, refund, ListQuery, DocPage, PaidBy, WriteRule, FN_RESULTS, MAX_NAME_BYTES};
use crate::{assert_self, emit, Contract, ContractExt};

pub const MAX_FUNCTIONS: usize = 16;
pub const MAX_INPUT_BYTES: usize = 4096;
/// Quay stores at most this much output per result.
pub const MAX_OUTPUT_BYTES: usize = 16_384;
const MAX_PROJECT_BYTES: usize = 128;
const MAX_SECONDS: u32 = 600;
const MAX_INSTRUCTIONS: u64 = 1_000_000_000_000;
/// 0.005 NEAR.
pub const DEFAULT_DEPOSIT: u128 = 5_000_000_000_000_000_000_000;
const DEFAULT_INSTRUCTIONS: u64 = 2_000_000_000;
const DEFAULT_SECONDS: u32 = 30;
/// A call with less prepaid gas than this cannot cover OutLayer's settlement.
pub const MIN_RUN_GAS: Gas = Gas::from_tgas(120);
pub const RESULT_GAS: Gas = Gas::from_tgas(15);
/// Bytes a result doc takes besides the output text.
const RESULT_OVERHEAD_BYTES: u128 = 700;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum FnPayer {
    Caller,
    Site,
}

fn default_deposit() -> U128 {
    U128(DEFAULT_DEPOSIT)
}
fn default_instructions() -> U64 {
    U64(DEFAULT_INSTRUCTIONS)
}
fn default_seconds() -> u32 {
    DEFAULT_SECONDS
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct FunctionSpec {
    pub project: String,
    pub call: WriteRule,
    pub payer: FnPayer,
    #[serde(default = "default_deposit")]
    pub deposit: U128,
    #[serde(default = "default_instructions")]
    pub max_instructions: U64,
    #[serde(default = "default_seconds")]
    pub max_seconds: u32,
    #[serde(default)]
    pub secrets: bool,
}

#[near(serializers = [json])]
pub struct FunctionView {
    pub name: String,
    #[serde(flatten)]
    pub spec: FunctionSpec,
}

/// The doc an `on_add` trigger reports back to.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TriggerRef {
    pub collection: String,
    pub id: String,
}

#[near(serializers = [borsh])]
pub struct FnState {
    pub specs: IterableMap<String, FunctionSpec>,
    pub outlayer: AccountId,
    pub next_request: u64,
}

impl FnState {
    pub fn new() -> Self {
        Self {
            specs: IterableMap::new(b"f"),
            outlayer: "outlayer.testnet".parse().unwrap(),
            next_request: 1,
        }
    }
}

/// One run to launch.
pub(crate) struct Run {
    pub name: String,
    pub input: String,
    pub caller: AccountId,
    pub payer: AccountId,
    pub deposit: u128,
    /// Who gets the deposit back if OutLayer refuses the request.
    pub paid_by: PaidBy,
    pub trigger: Option<TriggerRef>,
    /// `None`: OutLayer gets all unused gas. `Some`: a fixed amount (cron).
    pub gas: Option<Gas>,
}

#[near]
impl Contract {
    #[payable]
    pub fn fn_set(&mut self, name: String, spec: FunctionSpec) {
        assert_self();
        near_sdk::assert_one_yocto();
        let name = check_fn_name(&name);
        let spec = check_spec(spec);
        if !self.fns.specs.contains_key(&name) && self.fns.specs.len() as usize >= MAX_FUNCTIONS {
            env::panic_str("function list is full");
        }
        self.fns.specs.insert(name.clone(), spec);
        emit("fn_set", &serde_json::json!({ "name": name }));
    }

    #[payable]
    pub fn fn_remove(&mut self, name: String) {
        assert_self();
        near_sdk::assert_one_yocto();
        if self.fns.specs.remove(&name).is_none() {
            env::panic_str("function missing");
        }
        emit("fn_removed", &serde_json::json!({ "name": name }));
    }

    pub fn fn_get(&self, name: String) -> Option<FunctionSpec> {
        self.fns.specs.get(&name).cloned()
    }

    pub fn fn_list(&self) -> Vec<FunctionView> {
        self.fns
            .specs
            .iter()
            .map(|(name, spec)| FunctionView {
                name: name.clone(),
                spec: spec.clone(),
            })
            .collect()
    }

    #[payable]
    pub fn set_outlayer(&mut self, account: AccountId) {
        assert_self();
        near_sdk::assert_one_yocto();
        self.fns.outlayer = account.clone();
        emit("outlayer_set", &serde_json::json!({ "account": account }));
    }

    pub fn get_outlayer(&self) -> AccountId {
        self.fns.outlayer.clone()
    }

    /// Run a function on OutLayer. The transaction result is the function's
    /// output JSON (null when it failed).
    #[payable]
    pub fn fn_call(&mut self, name: String, input: String) -> Promise {
        let spec = self
            .fns
            .specs
            .get(&name)
            .cloned()
            .unwrap_or_else(|| env::panic_str("function missing"));
        let caller = env::predecessor_account_id();
        let site = env::current_account_id();
        let allowed = caller == site
            || match spec.call {
                WriteRule::Owner => false,
                WriteRule::Anyone => true,
                WriteRule::Members => self.members.set.contains(&caller),
            };
        if !allowed {
            env::panic_str("not allowed to call this function");
        }
        check_input(&input);
        require_run_gas();
        let attached = env::attached_deposit().as_yoctonear();
        let (payer, deposit, paid_by) = match spec.payer {
            FnPayer::Caller => {
                if attached < spec.deposit.0 {
                    env::panic_str(&format!("attach at least {} yoctoNEAR", spec.deposit.0));
                }
                (caller.clone(), attached, PaidBy::Writer)
            }
            FnPayer::Site => {
                require!(attached == 0, "this function is paid by the site; attach no deposit");
                self.spend_pool(spec.deposit.0)
                    .unwrap_or_else(|reason| env::panic_str(reason));
                (site, spec.deposit.0, PaidBy::Pool)
            }
        };
        self.launch(Run {
            name,
            input,
            caller,
            payer,
            deposit,
            paid_by,
            trigger: None,
            gas: None,
        })
    }

    /// Stores the result. Never panics: a failure is recorded, not raised.
    #[private]
    pub fn fn_on_result(
        &mut self,
        name: String,
        request: String,
        caller: AccountId,
        deposit: U128,
        refund_to: Option<AccountId>,
        trigger: Option<TriggerRef>,
    ) -> Value {
        let (ok, output, error) = read_result();
        if error.as_deref() == Some("request failed") {
            // OutLayer refused the receipt, so the runtime sent the deposit back here.
            match &refund_to {
                Some(account) => refund(account, deposit.0),
                None => self.return_spent(deposit.0),
            }
        }
        let output_text = output.as_ref().map(|value| value.to_string());
        self.store_result(&name, &request, &caller, ok, output_text.as_deref(), error.as_deref());
        if let (Some(target), true) = (&trigger, ok) {
            self.apply_trigger(target, output.as_ref(), output_text.as_deref());
        }
        emit(
            "fn_result",
            &serde_json::json!({ "name": name, "request": request, "ok": ok }),
        );
        output.unwrap_or(Value::Null)
    }

    pub fn fn_results(&self, query: Option<ListQuery>) -> DocPage {
        self.list_page(FN_RESULTS, &query.unwrap_or_default())
    }
}

impl Contract {
    /// Send `request_execution` and chain `fn_on_result`.
    pub(crate) fn launch(&mut self, run: Run) -> Promise {
        let spec = self
            .fns
            .specs
            .get(&run.name)
            .cloned()
            .unwrap_or_else(|| env::panic_str("function missing"));
        let site = env::current_account_id();
        let request = format!("{}-{}", run.name, self.fns.next_request);
        self.fns.next_request += 1;
        let mut args = serde_json::json!({
            "source": { "Project": { "project_id": spec.project, "version_key": null } },
            "resource_limits": {
                "max_instructions": spec.max_instructions.0,
                "max_memory_mb": 128,
                "max_execution_seconds": spec.max_seconds,
            },
            "input_data": run.input,
            "response_format": "Json",
            "payer_account_id": run.payer,
        });
        if spec.secrets {
            args["secrets_ref"] = serde_json::json!({ "profile": "default", "account_id": site });
        }
        let refund_to = (run.paid_by == PaidBy::Writer).then(|| run.payer.clone());
        let callback = serde_json::json!({
            "name": run.name,
            "request": request,
            "caller": run.caller,
            "deposit": U128(run.deposit),
            "refund_to": refund_to,
            "trigger": run.trigger,
        });
        let (gas, weight) = match run.gas {
            Some(gas) => (gas, GasWeight(0)),
            None => (Gas::from_tgas(0), GasWeight(1)),
        };
        emit(
            "fn_called",
            &serde_json::json!({ "name": run.name, "request": request, "caller": run.caller }),
        );
        Promise::new(self.fns.outlayer.clone())
            .function_call_weight(
                "request_execution".to_string(),
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(run.deposit),
                gas,
                weight,
            )
            .then(Promise::new(site).function_call(
                "fn_on_result".to_string(),
                callback.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                RESULT_GAS,
            ))
    }

    /// Run `func` for a doc just added. Paid from the pool; skipped (logged)
    /// when the function is missing or the pool cannot pay.
    pub(crate) fn run_trigger(&mut self, func: &str, collection: &str, id: &str, owner: &AccountId, data: &str) {
        let Some(spec) = self.fns.specs.get(func).cloned() else {
            env::log_str(&format!("on_add {func} skipped: function missing"));
            return;
        };
        if let Err(reason) = self.spend_pool(spec.deposit.0) {
            env::log_str(&format!("on_add {func} skipped: {reason}"));
            return;
        }
        let input = serde_json::json!({
            "collection": collection,
            "id": id,
            "owner": owner,
            "data": serde_json::from_str::<Value>(data).unwrap_or(Value::Null),
        })
        .to_string();
        self.launch(Run {
            name: func.to_string(),
            input,
            caller: owner.clone(),
            payer: env::current_account_id(),
            deposit: spec.deposit.0,
            paid_by: PaidBy::Pool,
            trigger: Some(TriggerRef {
                collection: collection.to_string(),
                id: id.to_string(),
            }),
            gas: None,
        })
        .detach();
    }

    /// Spend `amount` of pool NEAR on a run (it leaves the pool for good).
    pub(crate) fn spend_pool(&mut self, amount: u128) -> Result<(), &'static str> {
        if amount > self.db.pool_balance {
            return Err("the pool cannot pay for this run");
        }
        self.db.pool_balance -= amount;
        Ok(())
    }

    fn return_spent(&mut self, amount: u128) {
        self.db.pool_balance = self.db.pool_balance.saturating_add(amount);
    }

    /// Take up to `cost` from the pool for storage the contract already wrote.
    fn draw_pool_upto(&mut self, cost: u128) -> u128 {
        let taken = cost.min(self.db.pool_balance);
        if taken < cost {
            env::log_str(&format!("pool short by {} yoctoNEAR for a result", cost - taken));
        }
        self.db.pool_balance -= taken;
        self.db.pool_reserved = self.db.pool_reserved.saturating_add(taken);
        taken
    }

    fn store_result(
        &mut self,
        name: &str,
        request: &str,
        caller: &AccountId,
        ok: bool,
        output: Option<&str>,
        error: Option<&str>,
    ) {
        let byte_cost = env::storage_byte_cost().as_yoctonear();
        let full = (RESULT_OVERHEAD_BYTES + output.map_or(0, str::len) as u128) * byte_cost;
        let bare = RESULT_OVERHEAD_BYTES * byte_cost;
        let pool = self.db.pool_balance;
        if pool < bare {
            env::log_str(&format!("result {request} not stored: the pool is empty"));
            return;
        }
        let (output, error) = if pool < full {
            (None, Some("output not stored: the pool is low"))
        } else {
            (output, error)
        };
        let output_value = output
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .unwrap_or(Value::Null);
        let mut data = serde_json::json!({
            "name": name,
            "request": request,
            "caller": caller,
            "ok": ok,
            "output": output_value,
            "at": U64(env::block_timestamp()),
        });
        if let Some(error) = error {
            data["error"] = Value::String(error.to_string());
        }
        self.ensure_system(FN_RESULTS);
        if self
            .db
            .collections
            .get(FN_RESULTS)
            .is_some_and(|coll| self.db.ids.contains_key(&(coll.cid, request.to_string())))
        {
            return;
        }
        let (seq, cost) = self.insert_doc(FN_RESULTS, request.to_string(), caller.clone(), data.to_string(), PaidBy::Pool);
        let taken = self.draw_pool_upto(cost);
        let cid = self.db.collections.get(FN_RESULTS).map(|coll| coll.cid).unwrap_or_default();
        self.set_deposit(cid, seq, taken);
    }

    /// Put the output on the doc that triggered the run, and hide it when the
    /// output says `"hide": true` in a moderated collection.
    fn apply_trigger(&mut self, target: &TriggerRef, output: Option<&Value>, text: Option<&str>) {
        let Some(coll) = self.db.collections.get(&target.collection).cloned() else {
            return;
        };
        let Some(seq) = self.db.ids.get(&(coll.cid, target.id.clone())).copied() else {
            return;
        };
        let hide = coll.rules.moderated
            && output.and_then(|value| value.get("hide")).and_then(Value::as_bool) == Some(true);
        let byte_cost = env::storage_byte_cost().as_yoctonear();
        let new_len = text.map_or(0, str::len) as u128;
        let keep_text = self.db.pool_balance >= new_len * byte_cost;
        let before = self.storage_mark();
        let Some(doc) = self.db.docs.get_mut(&(coll.cid, seq)) else {
            return;
        };
        if keep_text {
            doc.fn_result = text.map(str::to_string);
        }
        if hide {
            doc.hidden = true;
        }
        let after = self.storage_mark();
        let byte_cost_delta = |a: u64, b: u64| u128::from(a.saturating_sub(b)) * byte_cost;
        if after > before {
            let taken = self.draw_pool_upto(byte_cost_delta(after, before));
            if let Some(doc) = self.db.docs.get_mut(&(coll.cid, seq)) {
                doc.fn_deposit = doc.fn_deposit.saturating_add(taken);
            }
        } else if before > after {
            let mut back = byte_cost_delta(before, after);
            if let Some(doc) = self.db.docs.get_mut(&(coll.cid, seq)) {
                back = back.min(doc.fn_deposit);
                doc.fn_deposit -= back;
            }
            self.return_pool(back);
        }
        if hide {
            emit(
                "doc_hidden",
                &serde_json::json!({ "collection": target.collection, "id": target.id, "hidden": true }),
            );
        }
    }
}

/// Read OutLayer's answer: `(ok, output, error)`. OutLayer answers `null` when
/// the run failed.
fn read_result() -> (bool, Option<Value>, Option<String>) {
    if env::promise_results_count() != 1 {
        return (false, None, Some("no result".to_string()));
    }
    match env::promise_result_checked(0, MAX_OUTPUT_BYTES) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Null) => (false, None, Some("function failed".to_string())),
            Ok(value) => (true, Some(value), None),
            Err(_) => (false, None, Some("output is not JSON".to_string())),
        },
        Err(PromiseError::TooLong(_)) => (false, None, Some("output over 16 KB".to_string())),
        Err(_) => (false, None, Some("request failed".to_string())),
    }
}

/// The caller of a trigger or `fn_call` needs this much prepaid gas.
pub(crate) fn require_run_gas() {
    if env::prepaid_gas() < MIN_RUN_GAS {
        env::panic_str("this call runs a function: attach about 150 Tgas");
    }
}

pub(crate) fn require_trigger_gas() {
    require_run_gas();
}

pub(crate) fn check_fn_name(name: &str) -> String {
    if !name_ok(name, 1, MAX_NAME_BYTES) {
        env::panic_str("bad function name");
    }
    name.to_string()
}

fn check_spec(spec: FunctionSpec) -> FunctionSpec {
    let project = &spec.project;
    if project.is_empty()
        || project.len() > MAX_PROJECT_BYTES
        || !project.contains('/')
        || !project
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
    {
        env::panic_str("project must be <account>/<name>");
    }
    if spec.deposit.0 == 0 {
        env::panic_str("deposit must be above 0");
    }
    if spec.max_instructions.0 == 0 || spec.max_instructions.0 > MAX_INSTRUCTIONS {
        env::panic_str("max_instructions must be 1 to 10^12");
    }
    if spec.max_seconds == 0 || spec.max_seconds > MAX_SECONDS {
        env::panic_str("max_seconds must be 1 to 600");
    }
    spec
}

/// Input is JSON text of at most 4096 bytes.
pub(crate) fn check_input(input: &str) {
    if input.len() > MAX_INPUT_BYTES {
        env::panic_str("input is over 4096 bytes");
    }
    if serde_json::from_str::<Value>(input).is_err() {
        env::panic_str("input must be JSON");
    }
}
