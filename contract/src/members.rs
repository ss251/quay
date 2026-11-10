//! Members (section 2): `join` creates `<name>.<site>` with one full-access key
//! and no NEAR. A zero-balance account under 770 bytes needs no storage
//! deposit, so the site pays nothing but the member record. The member is
//! recorded only in the `on_join` callback, after the account exists.

use crate::coll::Seq;
use near_sdk::store::LookupSet;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Gas, GasWeight, NearToken, PublicKey};

use crate::db::name_ok;
use crate::{assert_self, emit, page_bounds_max, Contract};

pub const RESERVED_NAMES: [&str; 5] = ["relay", "admin", "www", "api", "quay"];
/// A member record (a list entry and a set entry for an account id of at most
/// 64 bytes, about 222 bytes with key overheads) stays under this many bytes.
/// A visitor's `join` holds this much pool NEAR.
pub const MEMBER_BYTES_BOUND: u128 = 300;
const ON_JOIN_GAS: Gas = Gas::from_tgas(10);
const MEMBER_PAGE_MAX: u32 = 50;

#[near(serializers = [borsh])]
pub struct MemberState {
    pub list: Seq<AccountId>,
    pub set: LookupSet<AccountId>,
    pub open: bool,
}

impl MemberState {
    pub fn new() -> Self {
        Self {
            list: Seq::new(b"m"),
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

impl Contract {
    /// Create `<name>.<this account>` with `public_key` as its only full-access
    /// key. No NEAR is transferred.
    /// The transaction result is `on_join`'s: `true` once recorded.
    pub fn join(&mut self, name: String, public_key: PublicKey) {
        let site = env::current_account_id();
        let by_site = env::predecessor_account_id() == site;
        require!(self.members.open || by_site, "members are closed");
        let account = member_account(&name, &site);
        if self.members.set.contains(&account) {
            env::panic_str("already a member");
        }
        // The member record is permanent storage. A visitor's join pays it
        // from the pool, like other site-paid writes, so joins cannot spend
        // the site's own balance. Held now, settled in `on_join`.
        let held = if by_site {
            0
        } else {
            let bound = MEMBER_BYTES_BOUND * env::storage_byte_cost().as_yoctonear();
            if self.spend_pool(bound).is_err() {
                env::panic_str("storage pool is empty: fund it with db_fund so visitors can join");
            }
            bound
        };
        let create = env::promise_batch_create(&account);
        env::promise_batch_action_create_account(create);
        env::promise_batch_action_add_key_with_full_access(create, &public_key, 0);
        let callback = env::promise_batch_then(create, &site);
        let args = crate::json_text(&crate::jv::obj!({ "account": account, "held": U128(held) }));
        env::promise_batch_action_function_call_weight(
            callback,
            "on_join",
            args.as_bytes(),
            NearToken::from_yoctonear(0),
            ON_JOIN_GAS,
            GasWeight(0),
        );
        env::promise_return(callback);
    }

    /// Records the member when the account was created and settles the pool
    /// NEAR `join` held. Never panics.
    pub fn on_join(&mut self, account: AccountId, held: Option<U128>) -> bool {
        let held = held.map_or(0, |held| held.0);
        if env::promise_results_count() != 1 {
            // Not the callback of a `join`: nothing was held, nothing to settle.
            return false;
        }
        if matches!(env::promise_result_checked(0, 64), Err(near_sdk::PromiseError::Failed)) {
            self.db.pool_balance = self.db.pool_balance.saturating_add(held);
            env::log_str(&format!("join failed: {account} was not created"));
            return false;
        }
        let before = self.storage_mark();
        if self.members.set.insert(account.clone()) {
            self.members.list.push(account.clone());
        }
        let after = self.storage_mark();
        let used = (u128::from(after.saturating_sub(before)) * env::storage_byte_cost().as_yoctonear()).min(held);
        self.db.pool_reserved = self.db.pool_reserved.saturating_add(used);
        self.db.pool_balance = self.db.pool_balance.saturating_add(held - used);
        emit("member_joined", &crate::jv::obj!({ "account": account }));
        true
    }
    pub fn set_members_open(&mut self, open: bool) {
        assert_self();
        near_sdk::assert_one_yocto();
        self.members.open = open;
        emit("members_open_set", &crate::jv::obj!({ "open": open }));
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
