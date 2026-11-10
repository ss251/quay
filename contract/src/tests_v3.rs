//! Unit tests for the v3 features: db, members, routes and templates,
//! external files, payments, and the v2 to v3 migration.

use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::borsh;
use near_sdk::json_types::{U128, U64};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{env, testing_env, AccountId, Gas, NearToken, PromiseResult};
use sha2::{Digest, Sha256};

use crate::db::*;
use crate::legacy::StateV2;
use crate::pay::{Grant, Product};
use crate::routes::{RouteIn, RouteKind};
use crate::types::*;
use crate::*;

const SITE: &str = "board.testnet";
const ALICE: &str = "alice.testnet";
const BOB: &str = "bob.testnet";
const TOKEN: &str = "usdc.testnet";
const NOW: u64 = 1_731_283_200_000_000_000;
const BYTE: u128 = 10_000_000_000_000_000_000;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn ctx_with(predecessor: &str, deposit: u128, results: Vec<PromiseResult>) {
    let predecessor: AccountId = predecessor.parse().unwrap();
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(SITE.parse().unwrap())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300))
        .block_timestamp(NOW);
    testing_env!(
        builder.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results,
    );
}

fn as_who(predecessor: &str, deposit: u128) {
    ctx_with(predecessor, deposit, Vec::new());
}

fn site(deposit: u128) {
    as_who(SITE, deposit);
}

fn at_time(ns: u64) {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(SITE.parse().unwrap())
        .predecessor_account_id(SITE.parse().unwrap())
        .block_timestamp(ns);
    testing_env!(
        builder.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        Vec::new(),
    );
}

fn panics(f: impl FnOnce()) -> String {
    let err = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|receipt| {
            let to = receipt.receiver_id.to_string();
            receipt.actions.into_iter().filter_map(move |action| match action {
                MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

fn rules(write: WriteRule, payer: Payer) -> CollectionRules {
    CollectionRules {
        write,
        max_doc_bytes: 4096,
        moderated: true,
        payer,
        max_docs_per_account: None,
        on_add: None,
    }
}

fn fresh() -> Contract {
    site(0);
    Contract::new()
}

fn with_collection(name: &str, rules: CollectionRules) -> Contract {
    let mut c = fresh();
    site(1);
    c.set_collection(name.to_string(), rules);
    c
}

fn add(c: &mut Contract, who: &str, deposit: u128, coll: &str, id: Option<&str>, data: Value) -> String {
    as_who(who, deposit);
    c.db_add(coll.to_string(), id.map(str::to_string), data.to_string())
}

fn sha_hex(bytes: &[u8]) -> String {
    hex_encode(Sha256::digest(bytes).as_slice())
}

/// Store files on chain and seal them as release `id`.
fn seal_files(c: &mut Contract, id: &str, files: &[(&str, &str)], routes: Option<Vec<RouteIn>>) {
    site(0);
    let mut ins = Vec::new();
    for (path, body) in files {
        let hash = sha_hex(body.as_bytes());
        c.put_chunk(hash.clone(), body.as_bytes().to_vec().into());
        ins.push(FileIn {
            path: path.to_string(),
            chunks: vec![hash],
            content_type: if path.ends_with(".html") { "text/html; charset=utf-8" } else { "text/plain" }.to_string(),
            external: None,
        });
    }
    c.seal(id.to_string(), ins, String::new(), false, routes);
}

fn route(pattern: &str, kind: RouteKind, collection: &str, template: Option<&str>) -> RouteIn {
    RouteIn {
        pattern: pattern.to_string(),
        kind,
        collection: collection.to_string(),
        template: template.map(str::to_string),
        limit: None,
        order: None,
        pinned_first: None,
        content_type: None,
        prefix: None,
        also: None,
    }
}

fn get(c: &Contract, path: &str) -> Web4Response {
    c.web4_get(Web4Request {
        path: path.to_string(),
        ..Default::default()
    })
}

fn body(res: &Web4Response) -> String {
    String::from_utf8(res.body.as_ref().expect("body").0.clone()).unwrap()
}

/// Bytes a new doc adds: the doc record, the id record, and the writer count record.
fn doc_bytes(c: &Contract, coll: &str, seq: u64, new_writer: bool) -> u64 {
    let cid = c.db.collections.get(coll).unwrap().cid;
    let doc = c.db.docs.get(&(cid, seq)).unwrap();
    let record = |key: Vec<u8>, value: usize| (1 + key.len() + value + 40) as u64;
    let mut total = record(borsh::to_vec(&(cid, seq)).unwrap(), borsh::to_vec(doc).unwrap().len())
        + record(borsh::to_vec(&(cid, doc.id.clone())).unwrap(), 8);
    if new_writer {
        total += record(borsh::to_vec(&(cid, doc.owner.clone())).unwrap(), 4);
    }
    total
}

// ---------------------------------------------------------------- collections

#[test]
fn set_collection_is_owner_only_and_needs_one_yocto() {
    let mut c = fresh();
    as_who(ALICE, 1);
    let msg = panics(|| c.set_collection("posts".into(), rules(WriteRule::Anyone, Payer::Writer)));
    assert!(msg.contains("only this account"), "{msg}");
    site(0);
    let msg = panics(|| c.set_collection("posts".into(), rules(WriteRule::Anyone, Payer::Writer)));
    assert!(msg.contains("yoctoNEAR"), "{msg}");
    site(1);
    for (name, needle) in [("_receipts", "system collections"), ("Posts", "bad collection name"), ("", "bad collection name")] {
        let msg = panics(|| c.set_collection(name.into(), rules(WriteRule::Anyone, Payer::Writer)));
        assert!(msg.contains(needle), "{name}: {msg}");
    }
    let mut big = rules(WriteRule::Anyone, Payer::Writer);
    big.max_doc_bytes = 16_385;
    assert!(panics(|| c.set_collection("posts".into(), big.clone())).contains("max_doc_bytes"));
    big.max_doc_bytes = 0;
    assert!(panics(|| c.set_collection("posts".into(), big.clone())).contains("max_doc_bytes"));
    let mut zero = rules(WriteRule::Anyone, Payer::Writer);
    zero.max_docs_per_account = Some(0);
    assert!(panics(|| c.set_collection("posts".into(), zero)).contains("max_docs_per_account"));
    let mut hooked = rules(WriteRule::Anyone, Payer::Writer);
    hooked.on_add = Some("moderate".into());
    c.set_collection("posts".into(), hooked);
    let view = c.get_collection("posts".into()).unwrap();
    assert_eq!(view.rules.on_add.as_deref(), Some("moderate"));
    assert_eq!(view.next_seq.0, 1);
    assert!(get_logs().iter().any(|l| l.contains("collection_set") && l.contains("\"3.0.0\"")));
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["write"], "anyone");
    assert_eq!(json["payer"], "writer");
    assert_eq!(json["count"], "0");
}

#[test]
fn at_most_32_collections_and_drop_needs_an_empty_collection() {
    let mut c = fresh();
    site(1);
    for n in 0..32 {
        c.set_collection(format!("c{n}"), rules(WriteRule::Anyone, Payer::Writer));
    }
    assert!(panics(|| c.set_collection("c32".into(), rules(WriteRule::Anyone, Payer::Writer))).contains("full"));
    c.set_collection("c0".into(), rules(WriteRule::Owner, Payer::Writer));
    assert_eq!(c.list_collections().len(), 32);
    let id = add(&mut c, ALICE, NEAR, "c1", None, json!({ "a": 1 }));
    site(1);
    assert!(panics(|| c.drop_collection("c1".into())).contains("collection has docs"));
    as_who(ALICE, 0);
    c.db_remove("c1".into(), id);
    site(1);
    c.drop_collection("c1".into());
    assert!(c.get_collection("c1".into()).is_none());
    c.set_collection("c1".into(), rules(WriteRule::Anyone, Payer::Writer));
    assert_eq!(c.db_list("c1".into(), None).docs.len(), 0);
    assert_eq!(c.get_collection("c1".into()).unwrap().next_seq.0, 1);
}

// ---------------------------------------------------------------- writer pays

#[test]
fn writer_pays_exact_storage_and_gets_the_excess_back() {
    let mut c = with_collection("posts", rules(WriteRule::Anyone, Payer::Writer));
    let id = add(&mut c, ALICE, NEAR, "posts", None, json!({ "title": "hello" }));
    assert_eq!(id, "1");
    let bytes = doc_bytes(&c, "posts", 1, true);
    let cost = u128::from(bytes) * BYTE;
    let doc = c.db_get("posts".into(), "1".into()).unwrap();
    assert_eq!(doc.deposit.0, cost);
    assert_eq!(transfers(), vec![(ALICE.to_string(), NEAR - cost)]);
    assert_eq!(doc.owner.as_str(), ALICE);
    assert_eq!(doc.seq.0, 1);
    assert_eq!(doc.data, json!({ "title": "hello" }));
    assert_eq!(doc.fn_result, None);
    assert!(get_logs().iter().any(|l| l.contains("doc_added") && l.contains("\"bytes\":17")));

    // The second doc by the same writer has no new count record.
    let id = add(&mut c, ALICE, NEAR, "posts", Some("second-post"), json!({ "title": "two" }));
    assert_eq!(id, "second-post");
    let second = u128::from(doc_bytes(&c, "posts", 2, false)) * BYTE;
    assert_eq!(c.db_get("posts".into(), id).unwrap().deposit.0, second);
    assert_eq!(transfers(), vec![(ALICE.to_string(), NEAR - second)]);

    // Exactly the cost is enough, and nothing is refunded. Same name length, same data.
    let exact = add(&mut c, "carol.testnet", cost, "posts", None, json!({ "title": "hello" }));
    assert_eq!(c.db_get("posts".into(), exact).unwrap().deposit.0, cost);
    assert!(transfers().is_empty());

    let view = c.get_collection("posts".into()).unwrap();
    assert_eq!(view.count.0, 3);
    assert_eq!(view.next_seq.0, 4);
}

#[test]
fn writer_pays_refuses_a_short_deposit() {
    let mut c = with_collection("posts", rules(WriteRule::Anyone, Payer::Writer));
    let msg = panics(|| {
        add(&mut c, ALICE, 0, "posts", None, json!({ "title": "x" }));
    });
    assert!(msg.contains("attach at least") && msg.contains("yoctoNEAR for storage"), "{msg}");
}

#[test]
fn update_charges_growth_and_refunds_shrinkage_up_to_the_deposit() {
    let mut c = with_collection("posts", rules(WriteRule::Anyone, Payer::Writer));
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "t": "a" }));
    let start = c.db_get("posts".into(), "1".into()).unwrap().deposit.0;

    as_who(ALICE, NEAR);
    c.db_update("posts".into(), "1".into(), json!({ "t": "a".repeat(101) }).to_string());
    let grown = c.db_get("posts".into(), "1".into()).unwrap();
    assert_eq!(grown.deposit.0, start + 100 * BYTE);
    assert_eq!(transfers(), vec![(ALICE.to_string(), NEAR - 100 * BYTE)]);
    assert_eq!(grown.data["t"].as_str().unwrap().len(), 101);
    assert!(get_logs().iter().any(|l| l.contains("doc_updated")));

    as_who(ALICE, 99 * BYTE);
    let msg = panics(|| c.db_update("posts".into(), "1".into(), json!({ "t": "a".repeat(201) }).to_string()));
    assert!(msg.contains("attach at least"), "{msg}");
}

#[test]
fn update_shrink_refunds_and_a_no_growth_update_returns_the_deposit() {
    let mut c = with_collection("posts", rules(WriteRule::Anyone, Payer::Writer));
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "t": "a".repeat(51) }));
    let start = c.db_get("posts".into(), "1".into()).unwrap().deposit.0;
    as_who(ALICE, 0);
    c.db_update("posts".into(), "1".into(), json!({ "t": "a" }).to_string());
    assert_eq!(c.db_get("posts".into(), "1".into()).unwrap().deposit.0, start - 50 * BYTE);
    assert_eq!(transfers(), vec![(ALICE.to_string(), 50 * BYTE)]);
    // Grow back, then shrink again: the writer nets zero.
    as_who(ALICE, 50 * BYTE);
    c.db_update("posts".into(), "1".into(), json!({ "t": "a".repeat(51) }).to_string());
    assert!(transfers().is_empty());
    assert_eq!(c.db_get("posts".into(), "1".into()).unwrap().deposit.0, start);
    as_who(ALICE, 7);
    c.db_update("posts".into(), "1".into(), json!({ "t": "b".repeat(51) }).to_string());
    assert_eq!(transfers(), vec![(ALICE.to_string(), 7)]);
}

#[test]
fn only_the_doc_owner_updates() {
    let mut c = with_collection("posts", rules(WriteRule::Anyone, Payer::Writer));
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "t": "a" }));
    as_who(BOB, NEAR);
    assert!(panics(|| c.db_update("posts".into(), "1".into(), "{}".into())).contains("only the doc owner"));
    site(0);
    assert!(panics(|| c.db_update("posts".into(), "1".into(), "{}".into())).contains("only the doc owner"));
    as_who(ALICE, 0);
    assert!(panics(|| c.db_update("posts".into(), "9".into(), "{}".into())).contains("doc missing"));
}

#[test]
fn remove_refunds_the_writer_even_when_a_moderator_removes() {
    let mut c = with_collection("posts", rules(WriteRule::Anyone, Payer::Writer));
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "t": "a" }));
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "t": "b" }));
    let d1 = c.db_get("posts".into(), "1".into()).unwrap().deposit.0;
    let d2 = c.db_get("posts".into(), "2".into()).unwrap().deposit.0;

    as_who(BOB, 0);
    assert!(panics(|| c.db_remove("posts".into(), "1".into())).contains("only the doc owner or a moderator"));

    as_who(ALICE, 0);
    c.db_remove("posts".into(), "1".into());
    assert_eq!(transfers(), vec![(ALICE.to_string(), d1)]);
    assert!(c.db_get("posts".into(), "1".into()).is_none());
    assert!(get_logs().iter().any(|l| l.contains("doc_removed") && l.contains(&format!("\"refund\":\"{d1}\""))));

    site(0);
    c.db_remove("posts".into(), "2".into());
    assert_eq!(transfers(), vec![(ALICE.to_string(), d2)]);
    assert!(get_logs().iter().any(|l| l.contains("doc_removed") && l.contains(&format!("\"by\":\"{SITE}\""))));
    let view = c.get_collection("posts".into()).unwrap();
    assert_eq!(view.count.0, 0);
    assert_eq!(view.bytes.0, 0);
    assert!(c.db.counts.get(&(1, ALICE.parse().unwrap())).is_none());
    assert!(panics(|| c.db_remove("posts".into(), "2".into())).contains("doc missing"));
}

#[test]
fn an_unmoderated_collection_refuses_the_site_owner() {
    let mut r = rules(WriteRule::Anyone, Payer::Writer);
    r.moderated = false;
    let mut c = with_collection("posts", r);
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "t": "a" }));
    site(0);
    assert!(panics(|| c.db_remove("posts".into(), "1".into())).contains("moderator"));
    site(1);
    assert!(panics(|| c.db_hide("posts".into(), "1".into(), true)).contains("not moderated"));
}

#[test]
fn add_validation() {
    let mut c = with_collection("posts", rules(WriteRule::Anyone, Payer::Writer));
    let long_id = "x".repeat(65);
    let cases: Vec<(Option<&str>, String, &str)> = vec![
        (None, "[1,2]".into(), "data must be a JSON object"),
        (None, "{\"a\":".into(), "data must be a JSON object"),
        (None, "\"text\"".into(), "data must be a JSON object"),
        (None, format!("{{\"a\":\"{}\"}}", "x".repeat(4096)), "doc is too large"),
        (Some("bad id"), "{}".into(), "bad doc id"),
        (Some(""), "{}".into(), "bad doc id"),
        (Some(&long_id), "{}".into(), "bad doc id"),
        (Some("42"), "{}".into(), "all-digit doc ids are reserved"),
    ];
    for (id, data, needle) in cases {
        as_who(ALICE, NEAR);
        let msg = panics(|| {
            c.db_add("posts".into(), id.map(str::to_string), data.clone());
        });
        assert!(msg.contains(needle), "{id:?} {data}: {msg}");
    }
    add(&mut c, ALICE, NEAR, "posts", Some("dup"), json!({}));
    as_who(ALICE, NEAR);
    assert!(panics(|| {
        c.db_add("posts".into(), Some("dup".into()), "{}".into());
    })
    .contains("doc already exists"));
    as_who(ALICE, NEAR);
    assert!(panics(|| {
        c.db_add("missing".into(), None, "{}".into());
    })
    .contains("collection missing"));
    as_who(ALICE, NEAR);
    assert!(panics(|| {
        c.db_add("_receipts".into(), None, "{}".into());
    })
    .contains("read-only"));
    // Exactly max_doc_bytes is fine.
    let exact = format!("{{\"a\":\"{}\"}}", "x".repeat(4096 - 8));
    assert_eq!(exact.len(), 4096);
    as_who(ALICE, NEAR);
    c.db_add("posts".into(), None, exact);
}

#[test]
fn write_rules_owner_members_and_per_account_cap() {
    let mut c = fresh();
    site(1);
    c.set_collection("news".into(), rules(WriteRule::Owner, Payer::Writer));
    c.set_collection("club".into(), rules(WriteRule::Members, Payer::Writer));
    let mut capped = rules(WriteRule::Anyone, Payer::Writer);
    capped.max_docs_per_account = Some(2);
    c.set_collection("capped".into(), capped);

    as_who(ALICE, NEAR);
    assert!(panics(|| {
        c.db_add("news".into(), None, "{}".into());
    })
    .contains("not allowed to write here"));
    add(&mut c, SITE, NEAR, "news", None, json!({ "t": "by the site" }));
    // The site owner's own deposit is not sent back to itself.
    assert!(transfers().is_empty());

    as_who(ALICE, NEAR);
    assert!(panics(|| {
        c.db_add("club".into(), None, "{}".into());
    })
    .contains("not allowed to write here"));
    let member: AccountId = format!("alice.{SITE}").parse().unwrap();
    c.members.set.insert(member.clone());
    add(&mut c, member.as_str(), NEAR, "club", None, json!({ "t": "member post" }));

    add(&mut c, ALICE, NEAR, "capped", None, json!({}));
    add(&mut c, ALICE, NEAR, "capped", None, json!({}));
    as_who(ALICE, NEAR);
    assert!(panics(|| {
        c.db_add("capped".into(), None, "{}".into());
    })
    .contains("doc limit reached"));
    // Removing one frees a slot.
    as_who(ALICE, 0);
    c.db_remove("capped".into(), "1".into());
    add(&mut c, ALICE, NEAR, "capped", None, json!({}));
    add(&mut c, BOB, NEAR, "capped", None, json!({}));
}

// ---------------------------------------------------------------- site pays

#[test]
fn site_pays_from_the_pool_and_removal_returns_it() {
    let mut r = rules(WriteRule::Anyone, Payer::Site);
    r.max_docs_per_account = Some(2);
    let mut c = with_collection("guestbook", r);
    // An empty pool refuses: see `a_tiny_pool_cannot_be_overdrawn`. A unit test
    // does not roll back a panic, so that case runs in its own test.

    as_who(BOB, MIN_FUND_YOCTO - 1);
    assert!(panics(|| c.db_fund()).contains("at least 0.01 NEAR"));
    as_who(BOB, NEAR);
    c.db_fund();
    assert!(get_logs().iter().any(|l| l.contains("pool_funded")));
    assert_eq!(c.get_pool().balance.0, NEAR);

    as_who(ALICE, 1);
    assert!(panics(|| {
        c.db_add("guestbook".into(), None, "{}".into());
    })
    .contains("site-paid collection takes no deposit"));

    add(&mut c, ALICE, 0, "guestbook", None, json!({ "m": "hi" }));
    let cost = u128::from(doc_bytes(&c, "guestbook", 1, true)) * BYTE;
    assert!(transfers().is_empty());
    assert_eq!(c.get_pool().balance.0, NEAR - cost);
    assert_eq!(c.get_pool().reserved.0, cost);
    add(&mut c, ALICE, 0, "guestbook", None, json!({ "m": "again" }));
    as_who(ALICE, 0);
    assert!(panics(|| {
        c.db_add("guestbook".into(), None, "{}".into());
    })
    .contains("doc limit reached"));

    // Growth draws on the pool; a deposit is refused.
    as_who(ALICE, 5);
    assert!(panics(|| c.db_update("guestbook".into(), "1".into(), json!({ "m": "x" }).to_string())).contains("no deposit"));
    let before = c.get_pool();
    as_who(ALICE, 0);
    c.db_update("guestbook".into(), "1".into(), json!({ "m": "hi".repeat(11) }).to_string());
    assert_eq!(c.get_pool().balance.0, before.balance.0 - 20 * BYTE);
    as_who(ALICE, 0);
    c.db_update("guestbook".into(), "1".into(), json!({ "m": "hi" }).to_string());
    assert_eq!(c.get_pool().balance.0, before.balance.0);

    let pool = c.get_pool();
    let held = c.db_get("guestbook".into(), "1".into()).unwrap().deposit.0;
    site(0);
    c.db_remove("guestbook".into(), "1".into());
    assert!(transfers().is_empty(), "a pool refund is not a transfer");
    assert_eq!(c.get_pool().balance.0, pool.balance.0 + held);
    assert_eq!(c.get_pool().reserved.0, pool.reserved.0 - held);
}

#[test]
fn pool_withdraw_is_owner_only_and_bounded() {
    let mut c = fresh();
    as_who(BOB, NEAR);
    c.db_fund();
    as_who(BOB, 1);
    assert!(panics(|| c.db_withdraw(U128(1))).contains("only this account"));
    site(0);
    assert!(panics(|| c.db_withdraw(U128(1))).contains("yoctoNEAR"));
    site(1);
    assert!(panics(|| c.db_withdraw(U128(NEAR + 1))).contains("pool has less"));
    c.db_withdraw(U128(NEAR / 2));
    assert_eq!(c.get_pool().balance.0, NEAR / 2);
    assert!(transfers().is_empty());
}

#[test]
fn a_tiny_pool_cannot_be_overdrawn() {
    let mut c = with_collection("g", rules(WriteRule::Anyone, Payer::Site));
    c.db.pool_balance = 10 * BYTE;
    as_who(ALICE, 0);
    assert!(panics(|| {
        c.db_add("g".into(), None, "{}".into());
    })
    .contains("storage pool is empty"));
}

// ---------------------------------------------------------------- hide, list

#[test]
fn hide_is_owner_only_with_one_yocto_and_lists_skip_hidden() {
    let mut c = with_collection("posts", rules(WriteRule::Anyone, Payer::Writer));
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "t": "a" }));
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "t": "b" }));
    as_who(ALICE, 1);
    assert!(panics(|| c.db_hide("posts".into(), "1".into(), true)).contains("only this account"));
    site(0);
    assert!(panics(|| c.db_hide("posts".into(), "1".into(), true)).contains("yoctoNEAR"));
    site(1);
    c.db_hide("posts".into(), "1".into(), true);
    assert!(get_logs().iter().any(|l| l.contains("doc_hidden")));
    assert!(c.db_get("posts".into(), "1".into()).unwrap().hidden);
    let page = c.db_list("posts".into(), None);
    assert_eq!(page.docs.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), vec!["2"]);
    let all = c.db_list(
        "posts".into(),
        Some(ListQuery {
            include_hidden: Some(true),
            ..Default::default()
        }),
    );
    assert_eq!(all.docs.len(), 2);
    c.db_hide("posts".into(), "1".into(), false);
    assert_eq!(c.db_list("posts".into(), None).docs.len(), 2);
}

#[test]
fn listing_walks_seqs_with_holes_filters_and_cursors() {
    let mut c = with_collection("posts", rules(WriteRule::Anyone, Payer::Writer));
    for n in 1..=30 {
        let who = if n % 3 == 0 { BOB } else { ALICE };
        let id = if n % 5 == 0 { Some(format!("harbour-{n}")) } else { None };
        as_who(who, NEAR);
        c.db_add("posts".into(), id, json!({ "n": n }).to_string());
    }
    for seq in [29u64, 28, 10] {
        let id = c.db.docs.get(&(1, seq)).unwrap().id.clone();
        let owner = c.db.docs.get(&(1, seq)).unwrap().owner.clone();
        as_who(owner.as_str(), 0);
        c.db_remove("posts".into(), id);
    }
    let seqs = |page: &DocPage| page.docs.iter().map(|d| d.seq.0).collect::<Vec<_>>();

    let first = c.db_list("posts".into(), Some(ListQuery { limit: Some(5), ..Default::default() }));
    assert_eq!(seqs(&first), vec![30, 27, 26, 25, 24]);
    assert_eq!(first.next, Some(U64(23)));
    let second = c.db_list("posts".into(), Some(ListQuery { limit: Some(5), from: first.next, ..Default::default() }));
    assert_eq!(seqs(&second), vec![23, 22, 21, 20, 19]);

    let asc = c.db_list(
        "posts".into(),
        Some(ListQuery { order: Some(Order::Asc), limit: Some(10), ..Default::default() }),
    );
    assert_eq!(seqs(&asc), vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 11]);
    assert_eq!(asc.next, Some(U64(12)));

    let end = c.db_list("posts".into(), Some(ListQuery { order: Some(Order::Asc), from: Some(U64(27)), ..Default::default() }));
    assert_eq!(seqs(&end), vec![27, 30]);
    assert_eq!(end.next, None);
    let past = c.db_list("posts".into(), Some(ListQuery { order: Some(Order::Asc), from: Some(U64(99)), ..Default::default() }));
    assert!(past.docs.is_empty() && past.next.is_none());

    let bob = c.db_list(
        "posts".into(),
        Some(ListQuery { owner: Some(BOB.parse().unwrap()), limit: Some(50), ..Default::default() }),
    );
    assert_eq!(seqs(&bob), vec![30, 27, 24, 21, 18, 15, 12, 9, 6, 3]);
    let harbour = c.db_list("posts".into(), Some(ListQuery { prefix: Some("harbour-".into()), ..Default::default() }));
    assert_eq!(
        harbour.docs.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
        vec!["harbour-30", "harbour-25", "harbour-20", "harbour-15", "harbour-5"]
    );
    // limit is clamped to 1..=50.
    let one = c.db_list("posts".into(), Some(ListQuery { limit: Some(0), ..Default::default() }));
    assert_eq!(one.docs.len(), 1);
    let many = c.db_list("posts".into(), Some(ListQuery { limit: Some(500), ..Default::default() }));
    assert_eq!(many.docs.len(), 27);
    assert!(c.db_list("missing".into(), None).docs.is_empty());
}

#[test]
fn a_listing_probes_at_most_200_seqs_and_still_returns_a_cursor() {
    let mut c = with_collection("posts", rules(WriteRule::Anyone, Payer::Writer));
    for _ in 0..230 {
        add(&mut c, ALICE, NEAR, "posts", None, json!({}));
    }
    add(&mut c, BOB, NEAR, "posts", None, json!({}));
    as_who(ALICE, 0);
    let page = c.db_list(
        "posts".into(),
        Some(ListQuery { owner: Some(BOB.parse().unwrap()), order: Some(Order::Asc), ..Default::default() }),
    );
    assert!(page.docs.is_empty());
    assert_eq!(page.next, Some(U64(201)));
    let rest = c.db_list(
        "posts".into(),
        Some(ListQuery { owner: Some(BOB.parse().unwrap()), order: Some(Order::Asc), from: page.next, ..Default::default() }),
    );
    assert_eq!(rest.docs.len(), 1);
    assert_eq!(rest.docs[0].seq.0, 231);
    assert_eq!(rest.next, None);
}

// ---------------------------------------------------------------- members

fn pk() -> near_sdk::PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}

#[test]
fn join_creates_a_zero_balance_account_and_records_it_in_the_callback() {
    let mut c = fresh();
    as_who(ALICE, 0);
    let _ = c.join("alice".into(), pk());
    let receipts = get_created_receipts();
    let create = receipts
        .iter()
        .find(|r| r.receiver_id.as_str() == "alice.board.testnet")
        .expect("create receipt");
    assert!(create.actions.iter().any(|a| matches!(a, MockAction::CreateAccount { .. })));
    assert!(create.actions.iter().any(|a| matches!(a, MockAction::AddKeyWithFullAccess { .. })));
    assert!(!create.actions.iter().any(|a| matches!(a, MockAction::Transfer { .. })), "no NEAR is sent");
    let callback = receipts.iter().find(|r| r.receiver_id.as_str() == SITE).expect("callback");
    assert!(callback.actions.iter().any(|a| matches!(
        a,
        MockAction::FunctionCallWeight { method_name, .. } if method_name == b"on_join"
    )));
    // Not a member until the callback sees success.
    assert!(!c.is_member("alice.board.testnet".parse().unwrap()));

    ctx_with(SITE, 0, vec![PromiseResult::Failed]);
    assert!(!c.on_join("alice.board.testnet".parse().unwrap()));
    assert!(!c.is_member("alice.board.testnet".parse().unwrap()));

    ctx_with(SITE, 0, vec![PromiseResult::Successful(Vec::new())]);
    assert!(c.on_join("alice.board.testnet".parse().unwrap()));
    assert!(c.is_member("alice.board.testnet".parse().unwrap()));
    assert!(get_logs().iter().any(|l| l.contains("member_joined") && l.contains("alice.board.testnet")));
    // A repeated success does not list the member twice.
    ctx_with(SITE, 0, vec![PromiseResult::Successful(Vec::new())]);
    assert!(c.on_join("alice.board.testnet".parse().unwrap()));
    assert_eq!(c.list_members(0, 10).members.len(), 1);

    as_who(BOB, 0);
    assert!(panics(|| {
        let _ = c.join("alice".into(), pk());
    })
    .contains("already a member"));
}

#[test]
fn join_validates_names_and_respects_members_open() {
    let mut c = fresh();
    for (name, needle) in [
        ("a", "2 to 32 bytes"),
        ("Alice", "2 to 32 bytes"),
        ("al.ice", "2 to 32 bytes"),
        (&"a".repeat(33) as &str, "2 to 32 bytes"),
        ("relay", "reserved"),
        ("admin", "reserved"),
        ("www", "reserved"),
        ("api", "reserved"),
        ("quay", "reserved"),
        ("-alice", "not a valid account id"),
        ("al__ice", "not a valid account id"),
    ] {
        as_who(BOB, 0);
        let msg = panics(|| {
            let _ = c.join(name.to_string(), pk());
        });
        assert!(msg.contains(needle), "{name}: {msg}");
    }
    as_who(ALICE, 1);
    assert!(panics(|| c.set_members_open(false)).contains("only this account"));
    site(0);
    assert!(panics(|| c.set_members_open(false)).contains("yoctoNEAR"));
    site(1);
    c.set_members_open(false);
    assert!(!c.get_members_open());
    as_who(BOB, 0);
    assert!(panics(|| {
        let _ = c.join("bob".into(), pk());
    })
    .contains("members are closed"));
    site(0);
    let _ = c.join("bob".into(), pk());
}

#[test]
fn list_members_pages_oldest_first() {
    let mut c = fresh();
    for n in 0..5 {
        ctx_with(SITE, 0, vec![PromiseResult::Successful(Vec::new())]);
        c.on_join(format!("m{n}.{SITE}").parse().unwrap());
    }
    let page = c.list_members(0, 2);
    assert_eq!(page.members.iter().map(|m| m.to_string()).collect::<Vec<_>>(), vec![format!("m0.{SITE}"), format!("m1.{SITE}")]);
    assert_eq!(page.next, Some(2));
    let rest = c.list_members(2, 50);
    assert_eq!(rest.members.len(), 3);
    assert_eq!(rest.next, None);
    assert!(!c.is_member(ALICE.parse().unwrap()));
}

// ---------------------------------------------------------------- routes

const POST_HTML: &str = "<h1>{{doc.data.title}}</h1><p>{{doc.data.body | lines}}</p><i>{{doc.created | date}}</i><b>{{viewer}}</b><s>{{site.host}}</s>{{> parts/foot.html}}";
const LIST_HTML: &str = "<ul>{{#each docs}}<li id=\"{{id}}\">{{@index}} {{data.title}}{{#if pinned_until}} pinned{{/if}}</li>{{else}}<li>empty</li>{{/each}}</ul>{{#if next}}<a href=\"?from={{next}}\">more</a>{{/if}}";

fn routed_site() -> Contract {
    let mut c = with_collection("posts", rules(WriteRule::Anyone, Payer::Writer));
    site(1);
    c.set_collection("drafts".into(), rules(WriteRule::Anyone, Payer::Writer));
    seal_files(
        &mut c,
        "1",
        &[
            ("index.html", "<p>home</p>"),
            ("404.html", "<p>custom 404</p>"),
            ("templates/post.html", POST_HTML),
            ("templates/list.html", LIST_HTML),
            ("parts/foot.html", "<footer>{{site.account}} r{{site.release}}</footer>"),
        ],
        Some(vec![
            route("/posts/:id", RouteKind::Doc, "posts", Some("templates/post.html")),
            route("/posts", RouteKind::List, "posts", Some("templates/list.html")),
            route("/api/posts/:id", RouteKind::Json, "posts", None),
            route("/api/:collection", RouteKind::Json, "posts", None),
            route("/all/:collection", RouteKind::Json, "*", None),
        ]),
    );
    site(1);
    c.promote("1".into());
    c
}

#[test]
fn doc_routes_render_escaped_and_missing_or_hidden_is_404() {
    let mut c = routed_site();
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "title": "<b>Hi</b>", "body": "one\ntwo" }));
    as_who(ALICE, 0);
    let res = c.web4_get(Web4Request {
        account_id: Some(ALICE.into()),
        path: "/posts/1".into(),
        ..Default::default()
    });
    assert_eq!(res.status, Some(200));
    assert_eq!(res.cache_control.as_deref(), Some(CACHE_FRESH));
    assert_eq!(res.content_type.as_deref(), Some("text/html; charset=utf-8"));
    assert_eq!(
        body(&res),
        "<h1>&lt;b&gt;Hi&lt;/b&gt;</h1><p>one<br>two</p><i>2024-11-11 00:00 UTC</i><b>alice.testnet</b><s>https://board.testnet.page</s><footer>board.testnet r1</footer>"
    );
    let missing = get(&c, "/posts/9");
    assert_eq!(missing.status, Some(404));
    assert_eq!(body(&missing), "<p>custom 404</p>");
    assert_eq!(missing.cache_control.as_deref(), Some(CACHE_FRESH));
    assert_eq!(get(&c, "/posts/bad%20id").status, Some(404));
    site(1);
    c.db_hide("posts".into(), "1".into(), true);
    assert_eq!(get(&c, "/posts/1").status, Some(404));
    // Static files still serve when no route matches.
    assert_eq!(body(&get(&c, "/")), "<p>home</p>");
    assert_eq!(get(&c, "/templates/post.html").status, Some(200));
}

#[test]
fn list_routes_render_a_page_with_a_cursor_and_previews_use_the_release_routes() {
    let mut c = routed_site();
    let empty = get(&c, "/posts");
    assert_eq!(body(&empty), "<ul><li>empty</li></ul>");
    for n in 1..=22 {
        add(&mut c, ALICE, NEAR, "posts", None, json!({ "title": format!("post {n}") }));
    }
    site(0);
    let res = get(&c, "/posts/");
    let html = body(&res);
    assert!(html.starts_with("<ul><li id=\"22\">0 post 22</li><li id=\"21\">1 post 21</li>"), "{html}");
    assert_eq!(html.matches("<li").count(), 20);
    assert!(html.ends_with("<a href=\"?from=2\">more</a>"), "{html}");
    let next = c.web4_get(Web4Request {
        path: "/posts".into(),
        query: [("from".to_string(), json!(["2"]))].into_iter().collect(),
        ..Default::default()
    });
    let html = body(&next);
    assert_eq!(html, "<ul><li id=\"2\">0 post 2</li><li id=\"1\">1 post 1</li></ul>");
    // The preview path of the same release renders the same routes.
    let preview = get(&c, "/r/1/posts/3");
    assert_eq!(preview.status, Some(200));
    assert!(body(&preview).contains("post 3"));
    assert_eq!(preview.cache_control.as_deref(), Some(CACHE_FRESH));
}

#[test]
fn json_routes_serve_doc_pages_and_docs() {
    let mut c = routed_site();
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "title": "a" }));
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "title": "b" }));
    add(&mut c, BOB, NEAR, "drafts", None, json!({ "title": "d" }));
    let page = get(&c, "/api/posts");
    assert_eq!(page.content_type.as_deref(), Some("application/json; charset=utf-8"));
    let page: Value = serde_json::from_str(&body(&page)).unwrap();
    assert_eq!(page["docs"].as_array().unwrap().len(), 2);
    assert_eq!(page["docs"][0]["id"], "2");
    assert_eq!(page["docs"][0]["fn"], Value::Null);
    assert_eq!(page["next"], Value::Null);
    let doc: Value = serde_json::from_str(&body(&get(&c, "/api/posts/1"))).unwrap();
    assert_eq!(doc["data"]["title"], "a");
    assert_eq!(doc["seq"], "1");
    assert_eq!(get(&c, "/api/posts/9").status, Some(404));
    // `/api/:collection` names posts only, so drafts falls through to files (404).
    let drafts = get(&c, "/api/drafts");
    assert_eq!(drafts.status, Some(404));
    assert_eq!(body(&drafts), "<p>custom 404</p>");
    // The `*` route serves any collection, and 404s an unknown one.
    let any: Value = serde_json::from_str(&body(&get(&c, "/all/drafts"))).unwrap();
    assert_eq!(any["docs"][0]["owner"], BOB);
    assert_eq!(get(&c, "/all/nope").status, Some(404));
    let asc = c.web4_get(Web4Request {
        path: "/api/posts".into(),
        query: [("order".to_string(), json!(["asc"])), ("limit".to_string(), json!("1"))].into_iter().collect(),
        ..Default::default()
    });
    let asc: Value = serde_json::from_str(&body(&asc)).unwrap();
    assert_eq!(asc["docs"][0]["id"], "1");
    assert_eq!(asc["next"], "2");
}

#[test]
fn routes_are_sealed_with_the_release_so_rollback_restores_them() {
    let mut c = routed_site();
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "title": "a" }));
    seal_files(&mut c, "2", &[("index.html", "<p>v2</p>")], None);
    site(1);
    c.promote("2".into());
    assert_eq!(get(&c, "/posts/1").status, Some(404));
    assert_eq!(get(&c, "/r/1/posts/1").status, Some(200));
    c.rollback();
    assert_eq!(get(&c, "/posts/1").status, Some(200));
    let detail = c.get_release("1".into()).unwrap();
    assert_eq!(detail.routes.len(), 5);
    assert_eq!(detail.routes[1].limit, Some(20));
    assert_eq!(detail.routes[1].order, Some(Order::Desc));
    let json = serde_json::to_value(c.get_release("2".into()).unwrap()).unwrap();
    assert!(json.get("routes").is_none(), "a release without routes keeps the v2 JSON");
    assert!(json["files"][0].get("external").is_none());
    c.promote("2".into());
    c.delete("1".into());
    assert!(c.routes.get("1").is_none());
}

#[test]
fn seal_validates_routes_and_templates() {
    let files: &[(&str, &str)] = &[
        ("index.html", "<p>x</p>"),
        ("t.html", "{{doc.id}}"),
        ("bad.html", "{{#each docs}}"),
        ("raw.html", "{{{doc.id}}}"),
        ("deep.html", "{{> deep.html}}"),
    ];
    let cases: Vec<(Vec<RouteIn>, &str)> = vec![
        (vec![route("/p/:id", RouteKind::Doc, "posts", None)], "need a template"),
        (vec![route("/p/:id", RouteKind::Doc, "posts", Some("nope.html"))], "not a stored text file"),
        (vec![route("/p/:slug", RouteKind::Doc, "posts", Some("t.html"))], "need an :id segment"),
        (vec![route("/p", RouteKind::List, "posts", Some("bad.html"))], "unclosed"),
        (vec![route("/p", RouteKind::List, "posts", Some("raw.html"))], "raw output"),
        (vec![route("/p", RouteKind::List, "posts", Some("deep.html"))], "deeper than 4"),
        (vec![route("p", RouteKind::Json, "posts", None)], "must start with /"),
        (vec![route("/r/:id", RouteKind::Json, "posts", None)], "reserved for previews"),
        (vec![route("/api", RouteKind::Json, "*", None)], "need a :collection segment"),
        (vec![route("/p/:id", RouteKind::Doc, "*", Some("t.html"))], "only json routes"),
        (vec![route("/p", RouteKind::Json, "Bad", None)], "bad collection name"),
        (
            vec![RouteIn { limit: Some(51), ..route("/p", RouteKind::List, "posts", Some("t.html")) }],
            "limit must be 1 to 50",
        ),
        (
            (0..17).map(|n| route(&format!("/p{n}"), RouteKind::Json, "posts", None)).collect(),
            "at most 16 routes",
        ),
    ];
    for (routes, needle) in cases {
        let mut c = fresh();
        let msg = panics(|| seal_files(&mut c, "1", files, Some(routes)));
        assert!(msg.contains(needle), "{needle}: {msg}");
    }
    // An external file is not a template.
    let mut c = fresh();
    site(0);
    let html = b"<p>x</p>";
    c.put_chunk(sha_hex(html), html.to_vec().into());
    let msg = panics(|| {
        c.seal(
            "1".into(),
            vec![
                FileIn { path: "index.html".into(), chunks: vec![sha_hex(html)], content_type: "text/html".into(), external: None },
                FileIn {
                    path: "t.html".into(),
                    chunks: vec![],
                    content_type: "text/html".into(),
                    external: Some(ExternalIn { cid: "bafyabc".into(), size: U64(10), sha256: "ab".repeat(32) }),
                },
            ],
            String::new(),
            false,
            Some(vec![route("/p", RouteKind::List, "posts", Some("t.html"))]),
        )
    });
    assert!(msg.contains("not a stored text file"), "{msg}");
}

#[test]
fn web4_request_accepts_gateway_fields_and_ignores_unknown_ones() {
    let req: Web4Request = serde_json::from_value(json!({
        "accountId": "alice.testnet",
        "path": "/posts/12",
        "query": { "from": ["40"], "tag": ["a", "b"] },
        "preloads": { "/x": { "body": "" } },
        "somethingNew": 1
    }))
    .unwrap();
    assert_eq!(req.account_id.as_deref(), Some("alice.testnet"));
    assert_eq!(req.query["from"], json!(["40"]));
    let null: Web4Request = serde_json::from_value(json!({ "accountId": null, "path": "/" })).unwrap();
    assert!(null.account_id.is_none());
    let bare: Web4Request = serde_json::from_value(json!({})).unwrap();
    assert_eq!(bare.path, "");
}

#[test]
fn rendering_a_20_doc_list_page_stays_cheap() {
    let mut c = routed_site();
    for n in 1..=20 {
        add(&mut c, ALICE, NEAR, "posts", None, json!({ "title": format!("post {n} {}", "x".repeat(400)), "body": "b".repeat(1000) }));
    }
    site(0);
    let start = env::used_gas();
    let res = get(&c, "/posts");
    let used = env::used_gas().as_gas() - start.as_gas();
    assert_eq!(res.status, Some(200));
    assert_eq!(body(&res).matches("<li").count(), 20);
    // Host-side cost (storage reads, logs) of the whole request. The wasm side
    // is measured in the sandbox test, which calls web4_get as a transaction.
    assert!(used < Gas::from_tgas(20).as_gas(), "used {used}");
}

// ---------------------------------------------------------------- external files

#[test]
fn external_files_serve_a_body_url_and_do_not_count_as_stored_bytes() {
    let mut c = fresh();
    site(0);
    let html = b"<p>gallery</p>";
    c.put_chunk(sha_hex(html), html.to_vec().into());
    let before = c.get_budget().stored_bytes.0;
    let sha = "AB".repeat(32);
    c.seal(
        "1".into(),
        vec![
            FileIn { path: "index.html".into(), chunks: vec![sha_hex(html)], content_type: "text/html".into(), external: None },
            FileIn {
                path: "media/harbour.jpg".into(),
                chunks: vec![],
                content_type: "image/jpeg".into(),
                external: Some(ExternalIn { cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi".into(), size: U64(512_000), sha256: sha }),
            },
        ],
        String::new(),
        false,
        None,
    );
    assert_eq!(c.get_budget().stored_bytes.0, before);
    let detail = c.get_release("1".into()).unwrap();
    assert_eq!(detail.bytes.0, html.len() as u64);
    assert_eq!(detail.file_count, 2);
    let json = serde_json::to_value(&detail).unwrap();
    assert_eq!(json["files"][1]["external"]["cid"], "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
    assert_eq!(json["files"][1]["external"]["size"], "512000");
    assert_eq!(json["files"][1]["external"]["sha256"], "ab".repeat(32));
    assert_eq!(json["files"][1]["chunks"], json!([]));
    let res = get(&c, "/r/1/media/harbour.jpg");
    assert_eq!(res.status, Some(200));
    assert!(res.body.is_none());
    assert_eq!(res.body_url.as_deref(), Some("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"));
    assert_eq!(res.content_type.as_deref(), Some("image/jpeg"));
    assert_eq!(res.cache_control.as_deref(), Some(CACHE_IMMUTABLE));
    site(1);
    c.promote("1".into());
    assert_eq!(get(&c, "/media/harbour.jpg").cache_control.as_deref(), Some(CACHE_FRESH));
}

#[test]
fn external_file_validation() {
    let ext = |cid: &str, size: u64, sha: &str| ExternalIn { cid: cid.into(), size: U64(size), sha256: sha.into() };
    let good_sha = "ab".repeat(32);
    let cases: Vec<(&str, Vec<String>, ExternalIn, &str)> = vec![
        ("a.jpg", vec![], ext("", 1, &good_sha), "bad cid"),
        ("a.jpg", vec![], ext("bafy-x", 1, &good_sha), "bad cid"),
        ("a.jpg", vec![], ext(&"a".repeat(129), 1, &good_sha), "bad cid"),
        ("a.jpg", vec![], ext("bafy", 0, &good_sha), "size must be above 0"),
        ("a.jpg", vec![], ext("bafy", 1, "abc"), "bad sha256"),
        ("a.jpg", vec![good_sha.clone()], ext("bafy", 1, &good_sha), "no chunks"),
        ("index.html", vec![], ext("bafy", 1, &good_sha), "index.html must be stored on chain"),
    ];
    for (path, chunks, external, needle) in cases {
        let mut c = fresh();
        site(0);
        let html = b"<p>x</p>";
        c.put_chunk(sha_hex(html), html.to_vec().into());
        let mut files = vec![FileIn { path: path.into(), chunks, content_type: "image/jpeg".into(), external: Some(external) }];
        if path != "index.html" {
            files.push(FileIn { path: "index.html".into(), chunks: vec![sha_hex(html)], content_type: "text/html".into(), external: None });
        }
        let msg = panics(|| {
            c.seal(
                "1".into(),
                files,
                String::new(),
                false,
                None,
            )
        });
        assert!(msg.contains(needle), "{needle}: {msg}");
    }
}

// ---------------------------------------------------------------- migration

#[test]
fn migrates_v2_state_to_v3_and_is_idempotent() {
    site(0);
    let html = b"<p>v2 release</p>";
    let hash = sha_hex(html);
    {
        let mut chunks: LookupMap<String, Vec<u8>> = LookupMap::new(b"c");
        chunks.insert(hash.clone(), html.to_vec());
        let mut releases: LookupMap<String, Release> = LookupMap::new(b"r");
        releases.insert(
            "7".into(),
            Release {
                sha256: hash.clone(),
                files: vec![StoredFile { path: INDEX_PATH.into(), chunks: vec![hash.clone()], sha256: hash.clone(), content_type: "text/html".into() }],
                timestamp_ns: 5,
                message: "kept".into(),
                bytes: html.len() as u64,
                spa: false,
            },
        );
        let mut release_ids: Vector<String> = Vector::new(b"i");
        release_ids.push("7".into());
        let mut refs: LookupMap<String, u32> = LookupMap::new(b"n");
        refs.insert(hash.clone(), 1);
        let v2 = StateV2 {
            chunks,
            releases,
            production: Some("7".into()),
            stored_bytes: html.len() as u64,
            sales: Vector::new(b"s"),
            release_ids,
            history: Vector::new(b"h"),
            previous: None,
            chunk_refs: refs,
            version: 2,
        };
        env::state_write(&v2);
    }
    let mut migrated = Contract::migrate(vec![]);
    assert_eq!(migrated.version, 3);
    assert_eq!(migrated.get_version().version, "3.0.0");
    assert_eq!(migrated.get_production().as_deref(), Some("7"));
    assert_eq!(migrated.get_release("7".into()).unwrap().message, "kept");
    assert_eq!(body(&get(&migrated, "/")), "<p>v2 release</p>");
    assert!(migrated.list_collections().is_empty());
    assert!(migrated.get_members_open());
    // v3 features work on the migrated state.
    site(1);
    migrated.set_collection("posts".into(), rules(WriteRule::Anyone, Payer::Writer));
    add(&mut migrated, ALICE, NEAR, "posts", None, json!({ "t": 1 }));
    env::state_write(&migrated);
    drop(migrated);
    site(0);
    let again = Contract::migrate(vec![]);
    assert_eq!(again.get_status().release_count, 1);
    assert_eq!(again.db_get("posts".into(), "1".into()).unwrap().data["t"], 1);
    as_who(ALICE, 0);
    assert!(panics(|| {
        Contract::migrate(vec![]);
    })
    .contains("only this account"));
}

// ---------------------------------------------------------------- payments

fn pin_product() -> Product {
    Product {
        name: "Pin a post for 24 hours".into(),
        price_yocto: Some(U128(NEAR / 10)),
        price_token: Some(U128(100_000)),
        grant: Grant::Pin,
        pin_seconds: Some(86_400),
    }
}

fn shop() -> Contract {
    let mut c = with_collection("posts", rules(WriteRule::Anyone, Payer::Writer));
    site(1);
    c.set_product("pin".into(), pin_product());
    c.set_product(
        "supporter".into(),
        Product { name: "Supporter".into(), price_yocto: Some(U128(NEAR / 100)), price_token: None, grant: Grant::Receipt, pin_seconds: Some(5) },
    );
    c.set_token(Some(TOKEN.parse().unwrap()));
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "t": "a" }));
    add(&mut c, ALICE, NEAR, "posts", None, json!({ "t": "b" }));
    c
}

#[test]
fn products_are_owner_only_and_validated() {
    let mut c = shop();
    as_who(ALICE, 1);
    assert!(panics(|| c.set_product("x".into(), pin_product())).contains("only this account"));
    site(0);
    assert!(panics(|| c.set_product("x".into(), pin_product())).contains("yoctoNEAR"));
    assert!(panics(|| c.remove_product("pin".into())).contains("yoctoNEAR"));
    assert!(panics(|| c.set_token(None)).contains("yoctoNEAR"));
    site(1);
    let mut bad = pin_product();
    bad.pin_seconds = None;
    assert!(panics(|| c.set_product("x".into(), bad)).contains("pin_seconds"));
    let mut bad = pin_product();
    bad.price_yocto = None;
    bad.price_token = None;
    assert!(panics(|| c.set_product("x".into(), bad)).contains("price_yocto or price_token"));
    let mut bad = pin_product();
    bad.price_yocto = Some(U128(0));
    assert!(panics(|| c.set_product("x".into(), bad)).contains("above 0"));
    let mut bad = pin_product();
    bad.name = "".into();
    assert!(panics(|| c.set_product("x".into(), bad)).contains("bad product name"));
    assert!(panics(|| c.set_product("Bad".into(), pin_product())).contains("bad product id"));
    assert_eq!(c.get_product("supporter".into()).unwrap().pin_seconds, None);
    let listed = serde_json::to_value(c.list_products()).unwrap();
    assert_eq!(listed[0]["id"], "pin");
    assert_eq!(listed[0]["grant"], "pin");
    assert_eq!(listed[0]["price_yocto"], (NEAR / 10).to_string());
    assert_eq!(listed[0]["pin_seconds"], 86_400);
    for n in 2..32 {
        c.set_product(format!("p{n}"), pin_product());
    }
    assert!(panics(|| c.set_product("p32".into(), pin_product())).contains("product list is full"));
    c.set_product("pin".into(), pin_product());
    c.remove_product("p2".into());
    assert!(c.get_product("p2".into()).is_none());
    assert!(panics(|| c.remove_product("p2".into())).contains("product missing"));
}

#[test]
fn pay_refunds_the_excess_records_a_receipt_and_pins() {
    let mut c = shop();
    let price = NEAR / 10;
    as_who(BOB, price - 1);
    assert!(panics(|| c.pay("pin".into(), Some("posts/1".into()))).contains("attach at least"));
    as_who(BOB, price);
    assert!(panics(|| c.pay("pin".into(), None)).contains("pin needs ref"));
    as_who(BOB, price);
    assert!(panics(|| c.pay("pin".into(), Some("posts/9".into()))).contains("pinned doc missing"));
    as_who(BOB, price);
    assert!(panics(|| c.pay("nope".into(), None)).contains("product missing"));
    as_who(BOB, price);
    assert!(panics(|| c.pay("pin".into(), Some("posts 1".into()))).contains("bad ref"));

    as_who(BOB, price + 12_345);
    c.pay("pin".into(), Some("posts/1".into()));
    assert_eq!(transfers(), vec![(BOB.to_string(), 12_345)]);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"paid\"") && l.contains("posts/1")));
    let day = 86_400 * 1_000_000_000;
    assert_eq!(c.db_get("posts".into(), "1".into()).unwrap().pinned_until, Some(U64(NOW + day)));
    assert!(c.has_paid(BOB.parse().unwrap(), "pin".into(), Some("posts/1".into())));
    assert!(!c.has_paid(BOB.parse().unwrap(), "pin".into(), Some("posts/2".into())));
    assert!(!c.has_paid(ALICE.parse().unwrap(), "pin".into(), Some("posts/1".into())));

    // A second pin extends from the current pin, not from now.
    as_who(ALICE, price);
    c.pay("pin".into(), Some("posts/1".into()));
    assert_eq!(c.db_get("posts".into(), "1".into()).unwrap().pinned_until, Some(U64(NOW + 2 * day)));

    let receipts = c.list_receipts(None);
    assert_eq!(receipts.receipts.len(), 2);
    assert_eq!(receipts.receipts[1]["buyer"], BOB);
    assert_eq!(receipts.receipts[1]["product"], "pin");
    assert_eq!(receipts.receipts[1]["ref"], "posts/1");
    assert_eq!(receipts.receipts[1]["amount"], price.to_string());
    assert_eq!(receipts.receipts[1]["token"], "near");
    assert_eq!(receipts.receipts[1]["at"], NOW.to_string());
    let bobs = c.list_receipts(Some(ListQuery { owner: Some(BOB.parse().unwrap()), ..Default::default() }));
    assert_eq!(bobs.receipts.len(), 1);
    let receipt = c.db_get("_receipts".into(), "1".into()).unwrap();
    assert!(receipt.deposit.0 > 0 && receipt.deposit.0 < price);
    assert!(c.list_collections().iter().all(|coll| coll.name != "_receipts"));
    assert_eq!(c.get_collection("_receipts".into()).unwrap().count.0, 2);
    // Receipts are read-only through the db methods.
    as_who(BOB, 0);
    assert!(panics(|| c.db_remove("_receipts".into(), "1".into())).contains("read-only"));

    // Grant receipt only records.
    as_who(BOB, NEAR / 100);
    c.pay("supporter".into(), None);
    assert!(c.has_paid(BOB.parse().unwrap(), "supporter".into(), None));
}

#[test]
fn pinned_docs_list_first_and_pins_expire() {
    let mut c = shop();
    for _ in 0..3 {
        add(&mut c, ALICE, NEAR, "posts", None, json!({}));
    }
    as_who(BOB, NEAR / 10);
    c.pay("pin".into(), Some("posts/2".into()));
    let q = |from: Option<U64>| Some(ListQuery { pinned_first: Some(true), limit: Some(3), from, ..Default::default() });
    let seqs = |page: DocPage| page.docs.iter().map(|d| d.seq.0).collect::<Vec<_>>();
    let page = c.db_list("posts".into(), q(None));
    let next = page.next;
    assert_eq!(seqs(page), vec![2, 5, 4]);
    assert_eq!(seqs(c.db_list("posts".into(), q(next))), vec![3, 1]);
    assert_eq!(seqs(c.db_list("posts".into(), None)), vec![5, 4, 3, 2, 1]);
    at_time(NOW + 86_401 * 1_000_000_000);
    assert_eq!(seqs(c.db_list("posts".into(), q(None))), vec![5, 4, 3]);
    assert_eq!(c.db_get("posts".into(), "2".into()).unwrap().pinned_until, None, "an expired pin reads as null");
}

#[test]
fn the_pin_list_is_bounded() {
    let mut c = shop();
    for _ in 0..20 {
        add(&mut c, ALICE, NEAR, "posts", None, json!({}));
    }
    for seq in 1..=16 {
        as_who(BOB, NEAR / 10);
        c.pay("pin".into(), Some(format!("posts/{seq}")));
    }
    as_who(BOB, NEAR / 10);
    assert!(panics(|| c.pay("pin".into(), Some("posts/17".into()))).contains("pin list is full"));
    // Re-pinning a pinned doc is fine.
    as_who(BOB, NEAR / 10);
    c.pay("pin".into(), Some("posts/16".into()));
    // Removing a doc frees its slot.
    as_who(ALICE, 0);
    c.db_remove("posts".into(), "1".into());
    as_who(BOB, NEAR / 10);
    c.pay("pin".into(), Some("posts/17".into()));
}

#[test]
fn ft_on_transfer_accepts_the_configured_token_only() {
    let mut c = shop();
    let refused = |c: &mut Contract, from: &str, amount: u128, msg: Value| {
        as_who(from, 0);
        c.ft_on_transfer(BOB.parse().unwrap(), U128(amount), msg.to_string()).0
    };
    let pin = json!({ "product": "pin", "ref": "posts/1" });
    assert_eq!(refused(&mut c, "fake.testnet", 100_000, pin.clone()), 100_000);
    assert!(get_logs().iter().any(|l| l.contains("token not accepted")));
    // The pool pays a token receipt's storage, so an empty pool refuses.
    assert_eq!(refused(&mut c, TOKEN, 100_000, pin.clone()), 100_000);
    as_who(ALICE, NEAR);
    c.db_fund();
    assert_eq!(refused(&mut c, TOKEN, 99_999, pin.clone()), 99_999);
    assert_eq!(refused(&mut c, TOKEN, 100_000, json!({ "product": "supporter" })), 100_000);
    assert_eq!(refused(&mut c, TOKEN, 100_000, json!({ "product": "pin", "ref": "posts/9" })), 100_000);
    as_who(TOKEN, 0);
    assert_eq!(c.ft_on_transfer(BOB.parse().unwrap(), U128(5), "not json".into()).0, 5);
    assert!(c.list_receipts(None).receipts.is_empty());
    assert!(!c.has_paid(BOB.parse().unwrap(), "pin".into(), Some("posts/1".into())));

    let pool = c.get_pool().balance.0;
    as_who(TOKEN, 0);
    let unused = c.ft_on_transfer(BOB.parse().unwrap(), U128(150_000), pin.to_string());
    assert_eq!(unused.0, 50_000);
    assert!(c.has_paid(BOB.parse().unwrap(), "pin".into(), Some("posts/1".into())));
    let receipts = c.list_receipts(None).receipts;
    assert_eq!(receipts[0]["token"], TOKEN);
    assert_eq!(receipts[0]["amount"], "100000");
    let held = c.db_get("_receipts".into(), "1".into()).unwrap().deposit.0;
    assert_eq!(c.get_pool().balance.0, pool - held);
    assert!(c.db_get("posts".into(), "1".into()).unwrap().pinned_until.is_some());
}


#[test]
fn list_routes_filter_by_prefix_and_read_system_collections() {
    let mut c = shop();
    seal_files(
        &mut c,
        "9",
        &[
            ("index.html", "<p>x</p>"),
            ("ids.html", "{{#each docs}}[{{id}}]{{/each}}"),
            ("receipts.html", "{{#each docs}}<li>{{data.buyer}} {{data.product}} {{data.amount | near}}</li>{{/each}}"),
        ],
        Some(vec![
            RouteIn { prefix: Some("harbour-".into()), ..route("/harbour", RouteKind::List, "posts", Some("ids.html")) },
            route("/receipts", RouteKind::List, "_receipts", Some("receipts.html")),
            route("/api/:collection/:id", RouteKind::Json, "*", None),
        ]),
    );
    add(&mut c, ALICE, NEAR, "posts", Some("harbour-a"), json!({}));
    add(&mut c, ALICE, NEAR, "posts", Some("other"), json!({}));
    add(&mut c, ALICE, NEAR, "posts", Some("harbour-b"), json!({}));
    assert_eq!(body(&get(&c, "/r/9/harbour")), "[harbour-b][harbour-a]");
    as_who(BOB, NEAR / 10);
    c.pay("pin".into(), Some("posts/1".into()));
    assert_eq!(body(&get(&c, "/r/9/receipts")), "<li>bob.testnet pin 0.1000</li>");
    let receipt: Value = serde_json::from_str(&body(&get(&c, "/r/9/api/_receipts/1"))).unwrap();
    assert_eq!(receipt["data"]["product"], "pin");
    let bad = panics(|| {
        seal_files(
            &mut c,
            "10",
            &[("index.html", "<p>y</p>")],
            Some(vec![RouteIn { prefix: Some("a b".into()), ..route("/p", RouteKind::Json, "posts", None) }]),
        )
    });
    assert!(bad.contains("bad prefix"), "{bad}");
}

// ---------------------------------------------------------------- the board sample

/// Seals the real `examples/board` templates, partials and routes, then renders
/// `/`, a post and `/api/posts`. Read at test time, so a template change in the
/// sample is checked by the contract's renderer.
#[test]
fn renders_the_board_sample_templates() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/board");
    let config: Value = serde_json::from_str(&std::fs::read_to_string(root.join("quay.json")).unwrap()).unwrap();
    let routes: Vec<RouteIn> = serde_json::from_value(config["routes"].clone()).expect("quay.json routes parse as RouteIn");
    let mut files: Vec<(String, String)> = vec![("index.html".into(), "<p>static home</p>".into())];
    for dir in ["templates", "partials"] {
        let mut entries: Vec<_> = std::fs::read_dir(root.join("site").join(dir)).unwrap().map(|e| e.unwrap().path()).collect();
        entries.sort();
        for path in entries {
            let name = format!("{dir}/{}", path.file_name().unwrap().to_str().unwrap());
            files.push((name, std::fs::read_to_string(&path).unwrap()));
        }
    }
    let seed: Value = serde_json::from_str(&std::fs::read_to_string(root.join("seed/posts.json")).unwrap()).unwrap();

    let mut c = fresh();
    site(1);
    let posts_rules: CollectionRules = serde_json::from_value(config["collections"]["posts"].clone()).unwrap();
    c.set_collection("posts".into(), CollectionRules { on_add: None, ..posts_rules });
    as_who(BOB, NEAR);
    c.db_fund();
    let refs: Vec<(&str, &str)> = files.iter().map(|(p, b)| (p.as_str(), b.as_str())).collect();
    seal_files(&mut c, "1", &refs, Some(routes));
    site(1);
    c.promote("1".into());

    for post in seed["posts"].as_array().unwrap().iter().take(4) {
        let author = format!("{}.{SITE}", post["by"].as_str().unwrap());
        let mut data = post.clone();
        data.as_object_mut().unwrap().remove("by");
        add(&mut c, &author, 0, "posts", None, data);
    }
    let evil = add(
        &mut c,
        ALICE,
        0,
        "posts",
        None,
        json!({ "topic": "<b>x</b>", "title": "<script>alert(1)</script>", "body": "line one\n<img src=x onerror=alert(2)>" }),
    );
    // A link preview from the moderation function on the first post.
    c.db.docs.get_mut(&(1, 1)).unwrap().fn_result = Some(
        json!({ "preview": { "url": "https://www.metoffice.gov.uk/", "title": "Met Office", "description": "Forecasts \"and\" tides", "image": "https://example.com/p.png" } })
            .to_string(),
    );

    site(0);
    let home = get(&c, "/");
    let html = body(&home);
    assert_eq!(home.status, Some(200), "{html}");
    assert!(html.contains("Notices from the harbour"));
    assert!(html.contains("Tide notes for the week"));
    assert!(html.contains("Dredging in the inner basin"));
    assert!(html.contains("Release 1"));
    assert!(html.contains(&format!("<code>{SITE}</code>")));
    assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert!(!html.contains("<script>alert"));
    assert!(!html.contains("<img src=x"));

    let post = get(&c, "/posts/1");
    let html = body(&post);
    assert_eq!(post.status, Some(200), "{html}");
    assert!(html.contains("<title>Tide notes for the week - Harbour Board</title>"));
    assert!(html.contains("Springs run from Thursday to Sunday."));
    assert!(html.contains("<br>Neaps return"), "lines filter");
    assert!(html.contains("href=\"https://www.metoffice.gov.uk/\""));
    assert!(html.contains("Forecasts &quot;and&quot; tides"));
    assert!(html.contains("2024-11-11 00:00 UTC"));

    let bad = body(&get(&c, &format!("/posts/{evil}")));
    assert!(bad.contains("line one<br>&lt;img src&#61;x onerror&#61;alert(2)&gt;"), "{bad}");
    assert!(!bad.contains("<img src=x"));
    assert!(bad.contains("<span class=\"tag\">&lt;b&gt;x&lt;/b&gt;</span>"));

    let api = get(&c, "/api/posts");
    assert_eq!(api.status, Some(200));
    let page: Value = serde_json::from_str(&body(&api)).unwrap();
    assert_eq!(page["docs"].as_array().unwrap().len(), 5);
    let one: Value = serde_json::from_str(&body(&get(&c, "/api/posts/1"))).unwrap();
    assert_eq!(one["fn"]["preview"]["title"], "Met Office");
    assert_eq!(get(&c, "/posts/99").status, Some(404));
}

#[test]
fn also_lists_render_beside_a_page() {
    let mut c = shop();
    seal_files(
        &mut c,
        "5",
        &[
            ("index.html", "<p>x</p>"),
            ("home.html", "{{#each lists.latest}}[{{data.t}}]{{/each}}{{#each lists.receipts}}<{{data.product}}>{{/each}}|{{#each docs}}{{id}},{{/each}}"),
        ],
        Some(vec![RouteIn {
            also: Some(vec![
                crate::routes::AlsoList { name: "latest".into(), collection: "posts".into(), prefix: None, limit: Some(1), order: None },
                crate::routes::AlsoList { name: "receipts".into(), collection: "_receipts".into(), prefix: None, limit: None, order: Some(Order::Asc) },
            ]),
            ..route("/", RouteKind::List, "posts", Some("home.html"))
        }]),
    );
    as_who(BOB, NEAR / 10);
    c.pay("pin".into(), Some("posts/1".into()));
    assert_eq!(body(&get(&c, "/r/5/")), "[b]<pin>|2,1,");
    let detail = c.get_release("5".into()).unwrap();
    let also = detail.routes[0].also.as_ref().unwrap();
    assert_eq!(also[0].limit, Some(1));
    assert_eq!(also[1].limit, Some(5));
    for (lists, needle) in [
        (vec![("a", "posts", 11)], "also limit"),
        (vec![("a", "posts", 1), ("a", "posts", 1)], "distinct names"),
        (vec![("a", "posts", 1), ("b", "posts", 1), ("c", "posts", 1), ("d", "posts", 1)], "at most 3"),
        (vec![("a", "Bad", 1)], "bad also collection"),
    ] {
        let also = lists
            .into_iter()
            .map(|(name, coll, limit)| crate::routes::AlsoList { name: name.into(), collection: coll.into(), prefix: None, limit: Some(limit), order: None })
            .collect();
        let msg = panics(|| {
            seal_files(
                &mut c,
                "6",
                &[("index.html", "<p>y</p>"), ("t.html", "x")],
                Some(vec![RouteIn { also: Some(also), ..route("/", RouteKind::List, "posts", Some("t.html")) }]),
            )
        });
        assert!(msg.contains(needle), "{needle}: {msg}");
    }
}
