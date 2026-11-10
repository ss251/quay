//! Sandbox stand-ins for Quay's tests. Not deployed anywhere real.
//!
//! - `request_execution` acts like OutLayer: it records the request and returns
//!   `{"hide": <input.data.hide>, "echo": <input>, "project": <project id>}`. An input with `"fail": true`
//!   returns `null` (a failed run); `"panic": true` panics (a refused request).
//! - `ft_transfer_call` / `ft_resolve_transfer` follow NEP-141: the receiver's
//!   `ft_on_transfer` returns the unused amount, which goes back to the sender.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Mock {
    requests: Vector<String>,
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl Mock {
    #[init]
    pub fn new() -> Self {
        Self {
            requests: Vector::new(b"r"),
            balances: LookupMap::new(b"b"),
        }
    }

    /// OutLayer stand-in. Records the whole argument object.
    #[payable]
    pub fn request_execution(&mut self) -> Value {
        let args: Value = serde_json::from_slice(&env::input().unwrap_or_default()).unwrap_or(Value::Null);
        self.requests.push(args.to_string());
        let input: Value = args["input_data"]
            .as_str()
            .and_then(|text| serde_json::from_str(text).ok())
            .unwrap_or(Value::Null);
        if input["panic"] == Value::Bool(true) {
            env::panic_str("mock outlayer refused the request");
        }
        if input["fail"] == Value::Bool(true) {
            return Value::Null;
        }
        serde_json::json!({
            "hide": input["data"]["hide"] == Value::Bool(true),
            "echo": input,
            "project": args["source"]["Project"]["project_id"],
            "deposit": env::attached_deposit().as_yoctonear().to_string(),
        })
    }

    pub fn get_requests(&self) -> Vec<String> {
        self.requests.iter().cloned().collect()
    }

    pub fn mint(&mut self, account: AccountId, amount: U128) {
        let now = self.balance(&account);
        self.balances.insert(account, now + amount.0);
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balance(&account_id))
    }

    #[payable]
    pub fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, msg: String) -> Promise {
        let sender = env::predecessor_account_id();
        let have = self.balance(&sender);
        if have < amount.0 {
            env::panic_str("not enough tokens");
        }
        self.balances.insert(sender.clone(), have - amount.0);
        let to = self.balance(&receiver_id);
        self.balances.insert(receiver_id.clone(), to + amount.0);
        Promise::new(receiver_id.clone())
            .function_call(
                "ft_on_transfer".to_string(),
                serde_json::json!({ "sender_id": sender, "amount": amount, "msg": msg }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(60),
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).ft_resolve_transfer(
                sender,
                receiver_id,
                amount,
            ))
    }

    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
        #[callback_result] unused: Result<U128, PromiseError>,
    ) -> U128 {
        let unused = match unused {
            Ok(value) => value.0.min(amount.0),
            Err(_) => amount.0,
        };
        if unused > 0 {
            let at_receiver = self.balance(&receiver_id);
            let back = unused.min(at_receiver);
            self.balances.insert(receiver_id, at_receiver - back);
            let at_sender = self.balance(&sender_id);
            self.balances.insert(sender_id, at_sender + back);
        }
        U128(amount.0 - unused)
    }
}

impl Mock {
    fn balance(&self, account: &AccountId) -> u128 {
        self.balances.get(account).copied().unwrap_or(0)
    }
}
