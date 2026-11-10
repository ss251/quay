//! The contract's wasm exports, written by hand.
//!
//! `#[near]` derives one JSON argument struct per method, and each one
//! instantiates serde_json's whole struct deserializer. With 67 methods that
//! was the largest part of the wasm. Here the input is parsed once into a
//! `Value`, and each argument is read by name, so the deserializer code exists
//! once per argument type instead of once per method.
//!
//! The wrappers keep `#[near]`'s behaviour and messages: a deposit refused
//! unless the method is payable (views are not checked), `#[private]` checks,
//! `Expected input since method has arguments.`, `Failed to deserialize input
//! from JSON.`, and the init checks. The JSON interface is unchanged.
//!
//! Each wrapper is an ordinary Rust function, so unit tests can call it with
//! a mocked input and catch its panics. On wasm a `#[no_mangle]` shim of the
//! same name exports it.

use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, Map, Value};
use near_sdk::{env, AccountId};

use crate::json_in::FromJson;
use crate::Contract;

/// The parsed argument object of one call.
pub(crate) struct Args(Map<String, Value>);

impl Args {
    fn read() -> Self {
        let input = env::input().unwrap_or_else(|| env::panic_str("Expected input since method has arguments."));
        match serde_json::from_slice::<Value>(&input) {
            Ok(Value::Object(map)) => Args(map),
            _ => bad_input(),
        }
    }

    /// A required or optional argument (`Option<T>` reads a missing key as `None`).
    fn get<T: FromJson>(&mut self, key: &str) -> T {
        let value = self.0.remove(key).unwrap_or(Value::Null);
        T::from_json(value).unwrap_or_else(|| bad_input())
    }
}

fn bad_input() -> ! {
    env::panic_str("Failed to deserialize input from JSON.")
}

/// Panic messages reach the caller as on `#[near]`. Native tests keep the
/// default hook so `catch_unwind` works.
fn hook() {
    #[cfg(target_arch = "wasm32")]
    env::setup_panic_hook();
}

fn guard(method: &str, payable: bool, private: bool) {
    hook();
    if private && env::current_account_id() != env::predecessor_account_id() {
        env::panic_str(&["Method ", method, " is private"].concat());
    }
    if !payable && env::attached_deposit().as_yoctonear() != 0 {
        env::panic_str(&["Method ", method, " doesn't accept deposit"].concat());
    }
}

fn load() -> Contract {
    env::state_read().unwrap_or_else(|| env::panic_str("The contract is not initialized"))
}

fn save(contract: &Contract) {
    env::state_write(contract);
}

fn ret<T: Serialize + ?Sized>(value: &T) {
    match serde_json::to_vec(value) {
        Ok(bytes) => env::value_return(bytes),
        Err(_) => env::panic_str("Failed to serialize the return value using JSON."),
    }
}

/// The exported symbol for `$name`, on wasm only.
macro_rules! wasm_export {
    ($name:ident) => {
        #[cfg(target_arch = "wasm32")]
        const _: () = {
            #[no_mangle]
            extern "C" fn $name() {
                crate::exports::$name()
            }
        };
    };
}

/// `&self` with a JSON result. Views take no deposit check.
macro_rules! view {
    ($name:ident, |$c:ident, $a:ident| $body:expr) => {
        wasm_export!($name);
        pub fn $name() {
            hook();
            #[allow(unused_mut, unused_variables)]
            let mut $a = Args::read();
            let $c = load();
            let out = $body;
            ret(&out);
        }
    };
    ($name:ident, |$c:ident| $body:expr) => {
        wasm_export!($name);
        pub fn $name() {
            hook();
            let $c = load();
            let out = $body;
            ret(&out);
        }
    };
}

/// `&mut self`. `ret` returns the JSON result; `unit` returns nothing (or
/// leaves a `promise_return` in place).
macro_rules! call {
    ($name:ident, $payable:expr, $private:expr, ret, |$c:ident, $a:ident| $body:expr) => {
        wasm_export!($name);
        pub fn $name() {
            guard(stringify!($name), $payable, $private);
            #[allow(unused_mut, unused_variables)]
            let mut $a = Args::read();
            let mut $c = load();
            let out = $body;
            ret(&out);
            save(&$c);
        }
    };
    ($name:ident, $payable:expr, $private:expr, unit, |$c:ident, $a:ident| $body:expr) => {
        wasm_export!($name);
        pub fn $name() {
            guard(stringify!($name), $payable, $private);
            #[allow(unused_mut, unused_variables)]
            let mut $a = Args::read();
            let mut $c = load();
            $body;
            save(&$c);
        }
    };
    ($name:ident, $payable:expr, $private:expr, ret, |$c:ident| $body:expr) => {
        wasm_export!($name);
        pub fn $name() {
            guard(stringify!($name), $payable, $private);
            let mut $c = load();
            let out = $body;
            ret(&out);
            save(&$c);
        }
    };
    ($name:ident, $payable:expr, $private:expr, unit, |$c:ident| $body:expr) => {
        wasm_export!($name);
        pub fn $name() {
            guard(stringify!($name), $payable, $private);
            let mut $c = load();
            $body;
            save(&$c);
        }
    };
}

const PAY: bool = true;
const FREE: bool = false;
const PRIVATE: bool = true;
const OPEN: bool = false;

// ---------------------------------------------------------------- init

wasm_export!(new);
pub fn new() {
    guard("new", FREE, OPEN);
    if env::state_exists() {
        env::panic_str("The contract has already been initialized");
    }
    save(&Contract::new());
}

wasm_export!(migrate);
pub fn migrate() {
    guard("migrate", FREE, OPEN);
    let mut a = Args::read();
    let contract = Contract::migrate(a.get("ids"));
    save(&contract);
}

// ---------------------------------------------------------------- releases (v2)

view!(publish_methods, |c| c.publish_methods());
call!(put_chunk, FREE, OPEN, unit, |c, a| c.put_chunk(a.get("sha256"), a.get("data")));
call!(seal, FREE, OPEN, unit, |c, a| c.seal(
    a.get("id"),
    a.get("files"),
    a.get("message"),
    a.get("spa"),
    a.get("routes")
));
call!(promote, PAY, OPEN, ret, |c, a| c.promote(a.get("id")));
call!(rollback, PAY, OPEN, ret, |c| c.rollback());
call!(delete, PAY, OPEN, ret, |c, a| c.delete(a.get("id")));
call!(drop_chunk, PAY, OPEN, unit, |c, a| c.drop_chunk(a.get("sha256")));
call!(buy, PAY, OPEN, unit, |c, a| c.buy(a.get("memo")));
view!(web4_get, |c, a| c.web4_get(a.get("request")));
view!(get_version, |c| c.get_version());
view!(get_status, |c| c.get_status());
view!(get_production, |c| c.get_production());
view!(get_previous, |c| c.get_previous());
view!(get_release, |c, a| c.get_release(a.get("id")));
view!(list_releases, |c, a| c.list_releases(a.get("from_index"), a.get("limit")));
view!(list_history, |c, a| c.list_history(a.get("from_index"), a.get("limit")));
view!(get_budget, |c| c.get_budget());
view!(has_chunk, |c, a| c.has_chunk(a.get("sha256")));
view!(get_sales, |c| c.get_sales());

// ---------------------------------------------------------------- data

call!(set_collection, PAY, OPEN, unit, |c, a| c.set_collection(a.get("name"), a.get("rules")));
call!(drop_collection, PAY, OPEN, unit, |c, a| c.drop_collection(a.get("name")));
view!(get_collection, |c, a| c.get_collection(a.get("name")));
view!(list_collections, |c| c.list_collections());
call!(db_add, PAY, OPEN, ret, |c, a| c.db_add(a.get("collection"), a.get("id"), a.get("data")));
call!(db_update, PAY, OPEN, unit, |c, a| c.db_update(a.get("collection"), a.get("id"), a.get("data")));
call!(db_remove, FREE, OPEN, unit, |c, a| c.db_remove(a.get("collection"), a.get("id")));
call!(db_hide, PAY, OPEN, unit, |c, a| c.db_hide(a.get("collection"), a.get("id"), a.get("hidden")));
view!(db_get, |c, a| c.db_get(a.get("collection"), a.get("id")));
view!(db_list, |c, a| c.db_list(a.get("collection"), a.get("query")));
call!(db_fund, PAY, OPEN, unit, |c| c.db_fund());
call!(db_withdraw, PAY, OPEN, unit, |c, a| c.db_withdraw(a.get("amount")));
view!(get_pool, |c| c.get_pool());

// ---------------------------------------------------------------- members

call!(join, FREE, OPEN, unit, |c, a| c.join(a.get("name"), a.get("public_key")));
call!(on_join, FREE, PRIVATE, ret, |c, a| c.on_join(a.get::<AccountId>("account")));
call!(set_members_open, PAY, OPEN, unit, |c, a| c.set_members_open(a.get("open")));
view!(get_members_open, |c| c.get_members_open());
view!(list_members, |c, a| c.list_members(a.get("from_index"), a.get("limit")));
view!(is_member, |c, a| c.is_member(a.get("account")));

// ---------------------------------------------------------------- payments

call!(set_product, PAY, OPEN, unit, |c, a| c.set_product(a.get("id"), a.get("product")));
call!(remove_product, PAY, OPEN, unit, |c, a| c.remove_product(a.get("id")));
view!(get_product, |c, a| c.get_product(a.get("id")));
view!(list_products, |c| c.list_products());
call!(set_token, PAY, OPEN, unit, |c, a| c.set_token(a.get("account")));
view!(get_token, |c| c.get_token());
call!(pay, PAY, OPEN, unit, |c, a| c.pay(a.get("product"), a.get("ref")));
call!(ft_on_transfer, FREE, OPEN, ret, |c, a| c.ft_on_transfer(
    a.get("sender_id"),
    a.get("amount"),
    a.get("msg")
));
view!(has_paid, |c, a| c.has_paid(a.get("account"), a.get("product"), a.get("ref")));
view!(list_receipts, |c, a| c.list_receipts(a.get("query")));

// ---------------------------------------------------------------- functions

call!(fn_set, PAY, OPEN, unit, |c, a| c.fn_set(a.get("name"), a.get("spec")));
call!(fn_remove, PAY, OPEN, unit, |c, a| c.fn_remove(a.get("name")));
view!(fn_get, |c, a| c.fn_get(a.get("name")));
view!(fn_list, |c| c.fn_list());
call!(set_outlayer, PAY, OPEN, unit, |c, a| c.set_outlayer(a.get("account")));
view!(get_outlayer, |c| c.get_outlayer());
call!(fn_call, PAY, OPEN, unit, |c, a| c.fn_call(a.get("name"), a.get("input")));
call!(fn_on_result, FREE, PRIVATE, ret, |c, a| c.fn_on_result(
    a.get("name"),
    a.get("request"),
    a.get("caller"),
    a.get("deposit"),
    a.get("refund_to"),
    a.get("trigger")
));
view!(fn_results, |c, a| c.fn_results(a.get("query")));

// ---------------------------------------------------------------- cron

call!(cron_set, PAY, OPEN, unit, |c, a| c.cron_set(a.get("name"), a.get("job")));
call!(cron_remove, PAY, OPEN, unit, |c, a| c.cron_remove(a.get("name")));
view!(cron_list, |c| c.cron_list());
view!(cron_status, |c| c.cron_status());
call!(cron_arm, FREE, OPEN, unit, |c| c.cron_arm());
call!(cron_kick, FREE, OPEN, unit, |c| c.cron_kick());
call!(cron_tick, FREE, PRIVATE, unit, |c, a| c.cron_tick(a.get("chain")));
