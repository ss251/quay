//! Members (section 2): `join` creates `<name>.<site>` with one full-access key
//! and no NEAR. A zero-balance account under 770 bytes needs no storage
//! deposit, so the site pays nothing but the member record. The member is
//! recorded only in the `on_join` callback, after the account exists.

use near_sdk::store::{LookupSet, Vector};
use near_sdk::{env, near, require, AccountId, Gas, Promise, PublicKey};

use crate::db::name_ok;
use crate::{assert_self, emit, page_bounds_max, Contract, ContractExt};

pub const RESERVED_NAMES: [&str; 5] = ["relay", "admin", "www", "api", "quay"];
const ON_JOIN_GAS: Gas = Gas::from_tgas(10);
const MEMBER_PAGE_MAX: u32 = 50;

#[near(serializers = [borsh])]
pub struct MemberState {
    pub list: Vector<AccountId>,
    pub set: LookupSet<AccountId>,
    pub open: bool,
}

impl MemberState {
    pub fn new() -> Self {
        Self {
            list: Vector::new(b"m"),
            set: LookupSet::new(b"u"),
            open: true,
        }
    }
}

#[near(serializers = [json])]
pub struct MemberPage {
    pub members: Vec<AccountId>,
    pub next: Option<u32>,
}

#[near]
impl Contract {
    /// Create `<name>.<this account>` with `public_key` as its only full-access
    /// key. No NEAR is transferred.
    pub fn join(&mut self, name: String, public_key: PublicKey) -> Promise {
        let site = env::current_account_id();
        require!(
            self.members.open || env::predecessor_account_id() == site,
            "members are closed"
        );
        let account = member_account(&name, &site);
        if self.members.set.contains(&account) {
            env::panic_str("already a member");
        }
        Promise::new(account.clone())
            .create_account()
            .add_full_access_key(public_key)
            .then(
                Self::ext(site)
                    .with_static_gas(ON_JOIN_GAS)
                    .with_unused_gas_weight(0)
                    .on_join(account),
            )
    }

    /// Records the member when the account was created. Never panics.
    #[private]
    pub fn on_join(&mut self, account: AccountId) -> bool {
        let created = env::promise_results_count() == 1
            && !matches!(
                env::promise_result_checked(0, 64),
                Err(near_sdk::PromiseError::Failed)
            );
        if !created {
            env::log_str(&format!("join failed: {account} was not created"));
            return false;
        }
        if self.members.set.insert(account.clone()) {
            self.members.list.push(account.clone());
        }
        emit("member_joined", &near_sdk::serde_json::json!({ "account": account }));
        true
    }

    #[payable]
    pub fn set_members_open(&mut self, open: bool) {
        assert_self();
        near_sdk::assert_one_yocto();
        self.members.open = open;
        emit("members_open_set", &near_sdk::serde_json::json!({ "open": open }));
    }

    pub fn get_members_open(&self) -> bool {
        self.members.open
    }

    pub fn list_members(&self, from_index: u32, limit: u32) -> MemberPage {
        let (start, end, next) = page_bounds_max(self.members.list.len(), from_index, limit, MEMBER_PAGE_MAX);
        let mut members = Vec::with_capacity((end - start) as usize);
        for index in start..end {
            if let Some(account) = self.members.list.get(index) {
                members.push(account.clone());
            }
        }
        MemberPage { members, next }
    }

    pub fn is_member(&self, account: AccountId) -> bool {
        self.members.set.contains(&account)
    }
}

/// `name` is 2 to 32 bytes of `[a-z0-9_-]`, not reserved, and must make a valid
/// account id under the site.
pub(crate) fn member_account(name: &str, site: &AccountId) -> AccountId {
    if !name_ok(name, 2, 32) {
        env::panic_str("member name must be 2 to 32 bytes of a-z 0-9 _ -");
    }
    if RESERVED_NAMES.contains(&name) {
        env::panic_str("member name is reserved");
    }
    format!("{name}.{site}")
        .parse()
        .unwrap_or_else(|_| env::panic_str("member name is not a valid account id"))
}
