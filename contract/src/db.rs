//! Live data: collections, docs, and the site storage pool (section 1).
//!
//! Docs are keyed by `(collection number, seq)`, so a listing walks sequence
//! numbers without an index. Storage is priced from `env::storage_usage()`
//! before and after each write. Every charge is recorded on the doc as its
//! `deposit`, and every refund comes out of that record, so a doc can never
//! return more than was paid for it.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, Value};
use crate::coll::{IterMap, Map};
use near_sdk::{env, near, require, AccountId, NearToken};

use crate::{assert_self, emit, Contract};

pub const MAX_COLLECTIONS: usize = 32;
pub const MAX_DOC_BYTES: u32 = 16_384;
pub const MAX_DOC_ID_BYTES: usize = 64;
pub const MAX_NAME_BYTES: usize = 32;
pub const DEFAULT_LIMIT: u32 = 20;
pub const MAX_LIMIT: u32 = 50;
/// One `db_list` call reads at most this many sequence numbers.
pub const MAX_PROBES: u32 = 200;
/// Docs pinned at once per collection.
pub const MAX_PINS: usize = 16;
/// 0.01 NEAR.
pub const MIN_FUND_YOCTO: u128 = 10_000_000_000_000_000_000_000;
pub const RECEIPTS: &str = "_receipts";
pub const FN_RESULTS: &str = "_fn";

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum WriteRule {
    Owner,
    Anyone,
    Members,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Payer {
    Writer,
    Site,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Order {
    Asc,
    #[default]
    Desc,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CollectionRules {
    pub write: WriteRule,
    pub max_doc_bytes: u32,
    pub moderated: bool,
    pub payer: Payer,
    #[serde(default)]
    pub max_docs_per_account: Option<u32>,
    #[serde(default)]
    pub on_add: Option<String>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Collection {
    pub cid: u32,
    pub rules: CollectionRules,
    pub count: u64,
    pub bytes: u64,
    pub next_seq: u64,
}

/// Who holds a doc's storage deposit, and so who gets it back.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PaidBy {
    /// The doc owner. Refunds are transfers to the owner.
    Writer,
    /// The site pool. Refunds go back to the pool.
    Pool,
    /// Taken from a payment. Never refunded (receipts are not removable).
    Payment,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Doc {
    pub id: String,
    pub owner: AccountId,
    pub created: u64,
    pub updated: u64,
    /// The JSON object text as the writer sent it.
    pub data: String,
    pub hidden: bool,
    /// 0 when never pinned. A fixed-size field, so pinning does not grow the doc.
    pub pinned_until: u64,
    /// The last `on_add` function result (section 3). JSON text.
    pub fn_result: Option<String>,
    pub deposit: u128,
    pub paid_by: PaidBy,
    /// Pool NEAR that holds `fn_result`. Returned to the pool on removal.
    pub fn_deposit: u128,
}

#[near(serializers = [borsh])]
pub struct DbState {
    pub collections: IterMap<String, Collection>,
    pub docs: Map<(u32, u64), Doc>,
    pub ids: Map<(u32, String), u64>,
    pub counts: Map<(u32, AccountId), u32>,
    pub pins: Map<u32, Vec<u64>>,
    pub next_cid: u32,
    pub pool_balance: u128,
    pub pool_reserved: u128,
}

impl DbState {
    pub fn new() -> Self {
        Self {
            collections: IterMap::new(b"k"),
            docs: Map::new(b"d"),
            ids: Map::new(b"e"),
            counts: Map::new(b"w"),
            pins: Map::new(b"p"),
            next_cid: 1,
            pool_balance: 0,
            pool_reserved: 0,
        }
    }
}

#[near(serializers = [json])]
pub struct CollectionView {
    pub name: String,
    #[serde(flatten)]
    pub rules: CollectionRules,
    pub count: U64,
    pub bytes: U64,
    pub next_seq: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DocView {
    pub collection: String,
    pub id: String,
    pub seq: U64,
    pub owner: AccountId,
    pub created: U64,
    pub updated: U64,
    pub data: Value,
    pub hidden: bool,
    pub pinned_until: Option<U64>,
    #[serde(rename = "fn")]
    pub fn_result: Option<Value>,
    pub deposit: U128,
}

#[near(serializers = [json])]
#[derive(Default, Clone, Debug)]
pub struct ListQuery {
    #[serde(default)]
    pub from: Option<U64>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub order: Option<Order>,
    #[serde(default)]
    pub owner: Option<AccountId>,
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub include_hidden: Option<bool>,
    #[serde(default)]
    pub pinned_first: Option<bool>,
}

#[near(serializers = [json])]
#[derive(Debug)]
pub struct DocPage {
    pub docs: Vec<DocView>,
    pub next: Option<U64>,
}

#[near(serializers = [json])]
pub struct PoolView {
    /// Pool NEAR not held by any doc. `db_withdraw` can take it.
    pub balance: U128,
    /// NEAR that site-paid docs and pool-paid receipts hold.
    pub reserved: U128,
}

impl Contract {
    pub fn set_collection(&mut self, name: String, rules: CollectionRules) {
        assert_self();
        near_sdk::assert_one_yocto();
        let name = check_collection_name(&name);
        let rules = check_rules(rules);
        if self.db.collections.contains_key(&name) {
            self.db.collections.update(&name, |existing| existing.rules = rules);
        } else {
            let user = self
                .db
                .collections
                .keys()
                .filter(|key| !key.starts_with('_'))
                .count();
            if user >= MAX_COLLECTIONS {
                env::panic_str("collection list is full");
            }
            let cid = self.take_cid();
            self.db.collections.insert(
                name.clone(),
                Collection {
                    cid,
                    rules,
                    count: 0,
                    bytes: 0,
                    next_seq: 1,
                },
            );
        }
        emit("collection_set", &serde_json::json!({ "name": name }));
    }
    pub fn drop_collection(&mut self, name: String) {
        assert_self();
        near_sdk::assert_one_yocto();
        let name = check_collection_name(&name);
        let coll = self
            .db
            .collections
            .get(&name)
            .unwrap_or_else(|| env::panic_str("collection missing"));
        if coll.count > 0 {
            env::panic_str("collection has docs");
        }
        self.db.collections.remove(&name);
        self.db.pins.remove(&coll.cid);
        emit("collection_dropped", &serde_json::json!({ "name": name }));
    }

    pub fn get_collection(&self, name: String) -> Option<CollectionView> {
        self.db
            .collections
            .get(&name)
            .map(|coll| collection_view(&name, &coll))
    }

    pub fn list_collections(&self) -> Vec<CollectionView> {
        self.db
            .collections
            .iter()
            .filter(|(name, _)| !name.starts_with('_'))
            .map(|(name, coll)| collection_view(&name, &coll))
            .collect()
    }

    /// Add a doc. Returns its id.
    pub fn db_add(&mut self, collection: String, id: Option<String>, data: String) -> String {
        let name = check_collection_name(&collection);
        let writer = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let coll = self
            .db
            .collections
            .get(&name)
            .unwrap_or_else(|| env::panic_str("collection missing"));
        if !self.can_write(&coll.rules, &writer) {
            env::panic_str("not allowed to write here");
        }
        check_data(&data, coll.rules.max_doc_bytes);
        let paid_by = match coll.rules.payer {
            Payer::Writer => PaidBy::Writer,
            Payer::Site => {
                require!(deposit == 0, "site-paid collection takes no deposit");
                PaidBy::Pool
            }
        };
        let is_site = writer == env::current_account_id();
        let held = self.writer_count(coll.cid, &writer);
        if let Some(max) = coll.rules.max_docs_per_account {
            if held >= max && !is_site {
                env::panic_str("doc limit reached for this account");
            }
        }
        let id = match id {
            Some(id) => check_new_doc_id(&id),
            None => coll.next_seq.to_string(),
        };
        let trigger = coll.rules.on_add.clone();
        if trigger.is_some() {
            crate::functions::require_trigger_gas();
        }
        let bytes = data.len() as u64;
        let (seq, cost) = self.insert_doc(&name, id.clone(), writer.clone(), data.clone(), paid_by);
        match paid_by {
            PaidBy::Writer => {
                if deposit < cost {
                    env::panic_str(&format!("attach at least {cost} yoctoNEAR for storage"));
                }
                refund(&writer, deposit - cost);
            }
            _ => self.draw_pool(cost),
        }
        self.set_deposit(coll.cid, seq, cost);
        emit(
            "doc_added",
            &serde_json::json!({ "collection": name, "id": id, "owner": writer, "bytes": bytes }),
        );
        if let Some(func) = trigger {
            self.run_trigger(&func, &name, &id, &writer, &data);
        }
        id
    }

    /// Replace a doc's data. Only its owner can.
    pub fn db_update(&mut self, collection: String, id: String, data: String) {
        let name = check_collection_name(&collection);
        let caller = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let coll = self.collection(&name);
        let seq = self.doc_seq(coll.cid, &id);
        let mut doc = self.db.docs.get(&(coll.cid, seq)).unwrap_or_else(|| env::panic_str("doc missing"));
        if doc.owner != caller {
            env::panic_str("only the doc owner can update it");
        }
        check_data(&data, coll.rules.max_doc_bytes);
        if doc.paid_by == PaidBy::Pool {
            require!(deposit == 0, "site-paid collection takes no deposit");
        }
        let old_len = doc.data.len() as u64;
        let new_len = data.len() as u64;
        let before = self.storage_mark();
        doc.data = data;
        doc.updated = env::block_timestamp();
        self.db.docs.insert((coll.cid, seq), doc.clone());
        self.db.collections.update(&name, |c| {
            c.bytes = c.bytes.saturating_sub(old_len).saturating_add(new_len);
        });
        let after = self.storage_mark();
        let byte_cost = env::storage_byte_cost().as_yoctonear();
        if after > before {
            let cost = u128::from(after - before) * byte_cost;
            match doc.paid_by {
                PaidBy::Writer => {
                    if deposit < cost {
                        env::panic_str(&format!("attach at least {cost} yoctoNEAR for storage"));
                    }
                    refund(&caller, deposit - cost);
                }
                _ => self.draw_pool(cost),
            }
            doc.deposit = doc.deposit.saturating_add(cost);
        } else {
            let back = (u128::from(before - after) * byte_cost).min(doc.deposit);
            doc.deposit -= back;
            match doc.paid_by {
                PaidBy::Writer => refund(&caller, deposit.saturating_add(back)),
                _ => self.return_pool(back),
            }
        }
        self.set_deposit(coll.cid, seq, doc.deposit);
        emit(
            "doc_updated",
            &serde_json::json!({ "collection": name, "id": id, "bytes": new_len }),
        );
    }

    /// Delete a doc and refund its deposit to whoever paid it.
    pub fn db_remove(&mut self, collection: String, id: String) {
        let caller = env::predecessor_account_id();
        // The site owner may prune function results; other system docs stay.
        let name = if collection == FN_RESULTS && caller == env::current_account_id() {
            collection
        } else {
            check_collection_name(&collection)
        };
        let coll = self.collection(&name);
        let seq = self.doc_seq(coll.cid, &id);
        let doc = self
            .db
            .docs
            .get(&(coll.cid, seq))
            .unwrap_or_else(|| env::panic_str("doc missing"));
        let moderator = caller == env::current_account_id() && coll.rules.moderated;
        if doc.owner != caller && !moderator {
            env::panic_str("only the doc owner or a moderator can remove it");
        }
        self.db.docs.remove(&(coll.cid, seq));
        self.db.ids.remove(&(coll.cid, doc.id.clone()));
        let held = self.writer_count(coll.cid, &doc.owner);
        if held <= 1 {
            self.db.counts.remove(&(coll.cid, doc.owner.clone()));
        } else {
            self.db.counts.insert((coll.cid, doc.owner.clone()), held - 1);
        }
        let freed = doc.data.len() as u64;
        self.db.collections.update(&name, |c| {
            c.count = c.count.saturating_sub(1);
            c.bytes = c.bytes.saturating_sub(freed);
        });
        self.unpin(coll.cid, seq);
        match doc.paid_by {
            PaidBy::Writer => refund(&doc.owner, doc.deposit),
            PaidBy::Pool => self.return_pool(doc.deposit),
            PaidBy::Payment => {}
        }
        self.return_pool(doc.fn_deposit);
        emit(
            "doc_removed",
            &serde_json::json!({
                "collection": name,
                "id": doc.id,
                "by": caller,
                "refund": U128(doc.deposit),
            }),
        );
    }
    pub fn db_hide(&mut self, collection: String, id: String, hidden: bool) {
        assert_self();
        near_sdk::assert_one_yocto();
        let name = check_collection_name(&collection);
        let coll = self.collection(&name);
        if !coll.rules.moderated {
            env::panic_str("collection is not moderated");
        }
        let seq = self.doc_seq(coll.cid, &id);
        if !self.db.docs.update(&(coll.cid, seq), |doc| doc.hidden = hidden) {
            env::panic_str("doc missing");
        }
        emit(
            "doc_hidden",
            &serde_json::json!({ "collection": name, "id": id, "hidden": hidden }),
        );
    }

    pub fn db_get(&self, collection: String, id: String) -> Option<DocView> {
        let coll = self.db.collections.get(&collection)?;
        let seq = self.db.ids.get(&(coll.cid, id))?;
        self.db
            .docs
            .get(&(coll.cid, seq))
            .map(|doc| doc_view(&collection, seq, &doc))
    }

    pub fn db_list(&self, collection: String, query: Option<ListQuery>) -> DocPage {
        self.list_page(&collection, &query.unwrap_or_default())
    }

    /// Add to the site storage pool.
    pub fn db_fund(&mut self) {
        let deposit = env::attached_deposit().as_yoctonear();
        if deposit < MIN_FUND_YOCTO {
            env::panic_str("db_fund needs at least 0.01 NEAR");
        }
        self.db.pool_balance = self.db.pool_balance.saturating_add(deposit);
        emit(
            "pool_funded",
            &serde_json::json!({ "by": env::predecessor_account_id(), "yocto": U128(deposit) }),
        );
    }

    /// Release unused pool NEAR. The site owner is this account, so the NEAR
    /// is already on it: the call only stops reserving it for the pool.
    pub fn db_withdraw(&mut self, amount: U128) {
        assert_self();
        near_sdk::assert_one_yocto();
        if amount.0 > self.db.pool_balance {
            env::panic_str("pool has less than that");
        }
        self.db.pool_balance -= amount.0;
        emit("pool_withdrawn", &serde_json::json!({ "yocto": amount }));
    }

    pub fn get_pool(&self) -> PoolView {
        PoolView {
            balance: U128(self.db.pool_balance),
            reserved: U128(self.db.pool_reserved),
        }
    }
}

impl Contract {
    fn take_cid(&mut self) -> u32 {
        let cid = self.db.next_cid;
        self.db.next_cid = cid
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("collection ids exhausted"));
        cid
    }

    fn collection(&self, name: &str) -> Collection {
        self.db
            .collections
            .get(name)
            .unwrap_or_else(|| env::panic_str("collection missing"))
    }

    fn doc_seq(&self, cid: u32, id: &str) -> u64 {
        self
            .db
            .ids
            .get(&(cid, id.to_string()))
            .unwrap_or_else(|| env::panic_str("doc missing"))
    }

    fn writer_count(&self, cid: u32, writer: &AccountId) -> u32 {
        self.db
            .counts
            .get(&(cid, writer.clone()))
            .unwrap_or(0)
    }

    fn can_write(&self, rules: &CollectionRules, writer: &AccountId) -> bool {
        if writer == &env::current_account_id() {
            return true;
        }
        match rules.write {
            WriteRule::Owner => false,
            WriteRule::Anyone => true,
            WriteRule::Members => self.members.set.contains(writer),
        }
    }

    /// The account's storage usage now.
    pub(crate) fn storage_mark(&mut self) -> u64 {
        // Every collection writes through, so usage is exact without a flush.
        env::storage_usage()
    }

    /// Store a new doc in `name` (which must exist) and return its seq and the
    /// storage it added, priced in yoctoNEAR. The doc's deposit is left at 0.
    pub(crate) fn insert_doc(
        &mut self,
        name: &str,
        id: String,
        owner: AccountId,
        data: String,
        paid_by: PaidBy,
    ) -> (u64, u128) {
        let coll = self.collection(name);
        if self.db.ids.contains_key(&(coll.cid, id.clone())) {
            env::panic_str("doc already exists");
        }
        let seq = coll.next_seq;
        let held = self.writer_count(coll.cid, &owner);
        let now = env::block_timestamp();
        let bytes = data.len() as u64;
        let before = self.storage_mark();
        self.db.docs.insert(
            (coll.cid, seq),
            Doc {
                id: id.clone(),
                owner: owner.clone(),
                created: now,
                updated: now,
                data,
                hidden: false,
                pinned_until: 0,
                fn_result: None,
                deposit: 0,
                paid_by,
                fn_deposit: 0,
            },
        );
        self.db.ids.insert((coll.cid, id), seq);
        self.db.counts.insert((coll.cid, owner), held.saturating_add(1));
        self.db.collections.update(name, |c| {
            c.count += 1;
            c.bytes = c.bytes.saturating_add(bytes);
            c.next_seq = seq + 1;
        });
        let after = self.storage_mark();
        let cost = u128::from(after.saturating_sub(before)) * env::storage_byte_cost().as_yoctonear();
        (seq, cost)
    }

    pub(crate) fn set_deposit(&mut self, cid: u32, seq: u64, deposit: u128) {
        self.db.docs.update(&(cid, seq), |doc| doc.deposit = deposit);
    }

    pub(crate) fn draw_pool(&mut self, cost: u128) {
        if cost > self.db.pool_balance {
            env::panic_str("storage pool is empty");
        }
        self.db.pool_balance -= cost;
        self.db.pool_reserved = self.db.pool_reserved.saturating_add(cost);
    }

    pub(crate) fn return_pool(&mut self, amount: u128) {
        self.db.pool_reserved = self.db.pool_reserved.saturating_sub(amount);
        self.db.pool_balance = self.db.pool_balance.saturating_add(amount);
    }

    /// A system collection (`_receipts`, `_fn`), created on first use.
    pub(crate) fn ensure_system(&mut self, name: &str) {
        if self.db.collections.contains_key(name) {
            return;
        }
        let cid = self.take_cid();
        self.db.collections.insert(
            name.to_string(),
            Collection {
                cid,
                rules: CollectionRules {
                    write: WriteRule::Owner,
                    max_doc_bytes: MAX_DOC_BYTES,
                    // The site owner may prune `_fn`; receipts are permanent.
                    moderated: name == FN_RESULTS,
                    payer: Payer::Site,
                    max_docs_per_account: None,
                    on_add: None,
                },
                count: 0,
                bytes: 0,
                next_seq: 1,
            },
        );
    }

    /// Pin `seq` until `until`. Expired pins are pruned first.
    pub(crate) fn pin(&mut self, cid: u32, seq: u64, seconds: u64) -> Result<u64, &'static str> {
        let now = env::block_timestamp();
        let mut pins = self.db.pins.get(&cid).unwrap_or_default();
        pins.retain(|pinned| {
            *pinned == seq
                || self
                    .db
                    .docs
                    .get(&(cid, *pinned))
                    .is_some_and(|doc| doc.pinned_until > now)
        });
        if !pins.contains(&seq) {
            if pins.len() >= MAX_PINS {
                return Err("pin list is full");
            }
            pins.push(seq);
        }
        let mut doc = self.db.docs.get(&(cid, seq)).ok_or("doc missing")?;
        let until = doc
            .pinned_until
            .max(now)
            .saturating_add(seconds.saturating_mul(1_000_000_000));
        doc.pinned_until = until;
        self.db.docs.insert((cid, seq), doc);
        self.db.pins.insert(cid, pins);
        Ok(until)
    }

    /// Whether `pin` would find room for `seq`.
    pub(crate) fn pin_has_room(&self, cid: u32, seq: u64) -> bool {
        let now = env::block_timestamp();
        let Some(pins) = self.db.pins.get(&cid) else {
            return true;
        };
        let live = pins
            .iter()
            .filter(|pinned| {
                **pinned == seq
                    || self
                        .db
                        .docs
                        .get(&(cid, **pinned))
                        .is_some_and(|doc| doc.pinned_until > now)
            })
            .count();
        pins.contains(&seq) || live < MAX_PINS
    }

    fn unpin(&mut self, cid: u32, seq: u64) {
        self.db.pins.update(&cid, |pins| pins.retain(|pinned| *pinned != seq));
    }

    /// Walk sequence numbers (section 1, `db_list`). Works for system collections.
    pub(crate) fn list_page(&self, name: &str, query: &ListQuery) -> DocPage {
        self.list_page_probes(name, query, MAX_PROBES)
    }

    /// `list_page` with a smaller probe budget (extra lists on a page).
    pub(crate) fn list_page_probes(&self, name: &str, query: &ListQuery, max_probes: u32) -> DocPage {
        let mut docs = Vec::new();
        let Some(coll) = self.db.collections.get(name) else {
            return DocPage { docs, next: None };
        };
        let last = coll.next_seq.saturating_sub(1);
        let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize;
        let order = query.order.unwrap_or_default();
        let include_hidden = query.include_hidden.unwrap_or(false);
        let pinned_first = query.pinned_first.unwrap_or(false);
        let prefix = query.prefix.as_deref().unwrap_or("");
        let now = env::block_timestamp();
        let matches = |doc: &Doc| {
            (include_hidden || !doc.hidden)
                && query.owner.as_ref().is_none_or(|owner| &doc.owner == owner)
                && doc.id.starts_with(prefix)
        };
        if pinned_first && query.from.is_none() {
            if let Some(pins) = self.db.pins.get(&coll.cid) {
                let mut seqs = pins.clone();
                seqs.sort_unstable();
                if order == Order::Desc {
                    seqs.reverse();
                }
                for seq in seqs {
                    if docs.len() >= limit {
                        break;
                    }
                    if let Some(doc) = self.db.docs.get(&(coll.cid, seq)) {
                        if doc.pinned_until > now && matches(&doc) {
                            docs.push(doc_view(name, seq, &doc));
                        }
                    }
                }
            }
        }
        let start = match (query.from, order) {
            (Some(from), Order::Desc) => from.0.min(last),
            (Some(from), Order::Asc) => from.0.max(1),
            (None, Order::Desc) => last,
            (None, Order::Asc) => 1,
        };
        let mut cursor = (start >= 1 && start <= last).then_some(start);
        let mut probes = 0;
        while let Some(seq) = cursor {
            if docs.len() >= limit || probes >= max_probes {
                break;
            }
            probes += 1;
            if let Some(doc) = self.db.docs.get(&(coll.cid, seq)) {
                let shown_above = pinned_first && doc.pinned_until > now;
                if matches(&doc) && !shown_above {
                    docs.push(doc_view(name, seq, &doc));
                }
            }
            cursor = match order {
                Order::Desc => (seq > 1).then(|| seq - 1),
                Order::Asc => (seq < last).then(|| seq + 1),
            };
        }
        DocPage {
            docs,
            next: cursor.map(U64),
        }
    }
}

pub(crate) fn refund(to: &AccountId, amount: u128) {
    if amount > 0 && to != &env::current_account_id() {
        // Low-level promise API: the high-level `Promise` links code this
        // contract never uses (global contracts, hashing).
        let index = env::promise_batch_create(to);
        env::promise_batch_action_transfer(index, NearToken::from_yoctonear(amount));
    }
}

fn collection_view(name: &str, coll: &Collection) -> CollectionView {
    CollectionView {
        name: name.to_string(),
        rules: coll.rules.clone(),
        count: U64(coll.count),
        bytes: U64(coll.bytes),
        next_seq: U64(coll.next_seq),
    }
}

pub(crate) fn doc_view(collection: &str, seq: u64, doc: &Doc) -> DocView {
    DocView {
        collection: collection.to_string(),
        id: doc.id.clone(),
        seq: U64(seq),
        owner: doc.owner.clone(),
        created: U64(doc.created),
        updated: U64(doc.updated),
        data: serde_json::from_str(&doc.data).unwrap_or(Value::Null),
        hidden: doc.hidden,
        // An expired pin reads as no pin.
        pinned_until: (doc.pinned_until > env::block_timestamp()).then_some(U64(doc.pinned_until)),
        fn_result: doc
            .fn_result
            .as_deref()
            .map(|text| serde_json::from_str(text).unwrap_or(Value::Null)),
        deposit: U128(doc.deposit),
    }
}

/// `[a-z0-9_-]`, `min..=max` bytes.
pub(crate) fn name_ok(name: &str, min: usize, max: usize) -> bool {
    name.len() >= min
        && name.len() <= max
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// A collection a writer or the site owner can change: no leading `_`.
pub(crate) fn check_collection_name(name: &str) -> String {
    if name.starts_with('_') {
        env::panic_str("system collections are read-only");
    }
    if !name_ok(name, 1, MAX_NAME_BYTES) {
        env::panic_str("bad collection name");
    }
    name.to_string()
}

pub(crate) fn doc_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_DOC_ID_BYTES
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// An id chosen by the writer. All-digit ids are reserved for automatic ids,
/// so an explicit id can never block the next sequence number.
fn check_new_doc_id(id: &str) -> String {
    if !doc_id_ok(id) {
        env::panic_str("bad doc id");
    }
    if id.bytes().all(|b| b.is_ascii_digit()) {
        env::panic_str("all-digit doc ids are reserved for automatic ids");
    }
    id.to_string()
}

fn check_rules(rules: CollectionRules) -> CollectionRules {
    if rules.max_doc_bytes == 0 || rules.max_doc_bytes > MAX_DOC_BYTES {
        env::panic_str("max_doc_bytes must be 1 to 16384");
    }
    if rules.max_docs_per_account == Some(0) {
        env::panic_str("max_docs_per_account must be at least 1");
    }
    if let Some(func) = &rules.on_add {
        if !name_ok(func, 1, MAX_NAME_BYTES) {
            env::panic_str("bad on_add function name");
        }
    }
    rules
}

/// The data must be a JSON object whose text fits `max`.
fn check_data(data: &str, max: u32) {
    if data.len() > max as usize {
        env::panic_str("doc is too large");
    }
    match serde_json::from_str::<Value>(data) {
        Ok(Value::Object(_)) => {}
        _ => env::panic_str("data must be a JSON object"),
    }
}
