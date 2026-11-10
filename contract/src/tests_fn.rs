//! Unit tests for functions (section 3) and cron (section 8).

use near_sdk::json_types::{U128, U64};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseResult};

use crate::cron::JobIn;
use crate::db::*;
use crate::functions::{FnPayer, FunctionSpec};
use crate::tests_v3::{as_who, panics, site, transfers, ALICE, BOB, NEAR, NOW, SITE};
use crate::*;

fn ctx(predecessor: &str, deposit: u128, tgas: u64, results: Vec<PromiseResult>, now: u64) {
    let predecessor: AccountId = predecessor.parse().unwrap();
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(SITE.parse().unwrap())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(tgas))
        .block_timestamp(now);
    testing_env!(
        builder.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results,
    );
}

fn result_ok(value: Value) -> Vec<PromiseResult> {
    vec![PromiseResult::Successful(value.to_string().into_bytes())]
}

fn spec(payer: FnPayer, call: WriteRule) -> FunctionSpec {
    FunctionSpec {
        project: format!("{SITE}/preview"),
        call,
        payer,
        deposit: U128(NEAR / 200),
        max_instructions: U64(2_000_000_000),
        max_seconds: 30,
        secrets: false,
    }
}

fn with_fn(name: &str, spec: FunctionSpec) -> Contract {
    site(0);
    let mut c = Contract::new();
    site(1);
    c.fn_set(name.into(), spec);
    c
}

/// The OutLayer request and the callback a call created.
fn outlayer_calls() -> (Value, Value, u128, Gas) {
    let receipts = get_created_receipts();
    let mut request = None;
    let mut callback = None;
    for receipt in &receipts {
        for action in &receipt.actions {
            if let MockAction::FunctionCallWeight { method_name, args, attached_deposit, prepaid_gas, .. } = action {
                let parsed: Value = serde_json::from_slice(args).unwrap();
                if method_name == b"request_execution" {
                    assert_eq!(receipt.receiver_id.as_str(), "outlayer.testnet");
                    request = Some((parsed, attached_deposit.as_yoctonear(), *prepaid_gas));
                } else if method_name == b"fn_on_result" {
                    assert_eq!(receipt.receiver_id.as_str(), SITE);
                    callback = Some(parsed);
                }
            }
        }
    }
    let (request, deposit, gas) = request.expect("request_execution");
    (request, callback.expect("fn_on_result"), deposit, gas)
}

fn fund(c: &mut Contract, amount: u128) {
    as_who(BOB, amount);
    c.db_fund();
}

#[test]
fn fn_set_is_owner_only_and_validated() {
    let mut c = with_fn("preview", spec(FnPayer::Caller, WriteRule::Anyone));
    as_who(ALICE, 1);
    assert!(panics(|| c.fn_set("x".into(), spec(FnPayer::Caller, WriteRule::Anyone))).contains("only this account"));
    site(0);
    assert!(panics(|| c.fn_set("x".into(), spec(FnPayer::Caller, WriteRule::Anyone))).contains("yoctoNEAR"));
    assert!(panics(|| c.fn_remove("preview".into())).contains("yoctoNEAR"));
    assert!(panics(|| c.set_outlayer("x.testnet".parse().unwrap())).contains("yoctoNEAR"));
    site(1);
    assert!(panics(|| c.fn_set("Bad".into(), spec(FnPayer::Caller, WriteRule::Anyone))).contains("bad function name"));
    let mut bad = spec(FnPayer::Caller, WriteRule::Anyone);
    bad.project = "noslash".into();
    assert!(panics(|| c.fn_set("x".into(), bad)).contains("project"));
    let mut bad = spec(FnPayer::Caller, WriteRule::Anyone);
    bad.max_seconds = 0;
    assert!(panics(|| c.fn_set("x".into(), bad)).contains("max_seconds"));
    let mut bad = spec(FnPayer::Caller, WriteRule::Anyone);
    bad.deposit = U128(0);
    assert!(panics(|| c.fn_set("x".into(), bad)).contains("deposit"));
    for n in 1..16 {
        c.fn_set(format!("f{n}"), spec(FnPayer::Caller, WriteRule::Anyone));
    }
    assert!(panics(|| c.fn_set("f16".into(), spec(FnPayer::Caller, WriteRule::Anyone))).contains("function list is full"));
    c.fn_remove("f15".into());
    assert!(c.fn_get("f15".into()).is_none());
    let listed = serde_json::to_value(c.fn_list()).unwrap();
    assert_eq!(listed[0]["name"], "preview");
    assert_eq!(listed[0]["payer"], "caller");
    assert_eq!(listed[0]["call"], "anyone");
    assert_eq!(listed[0]["deposit"], (NEAR / 200).to_string());
    assert_eq!(listed[0]["max_instructions"], "2000000000");
    // Defaults fill in.
    let parsed: FunctionSpec = serde_json::from_value(json!({ "project": "a.testnet/b", "call": "owner", "payer": "site" })).unwrap();
    assert_eq!(parsed.deposit.0, 5_000_000_000_000_000_000_000);
    assert_eq!(parsed.max_seconds, 30);
    assert!(!parsed.secrets);
    assert_eq!(c.get_outlayer().as_str(), "outlayer.testnet");
    c.set_outlayer("mock.testnet".parse().unwrap());
    assert_eq!(c.get_outlayer().as_str(), "mock.testnet");
}

#[test]
fn fn_call_sends_the_outlayer_request_and_chains_the_callback() {
    let mut s = spec(FnPayer::Caller, WriteRule::Anyone);
    s.secrets = true;
    let mut c = with_fn("preview", s);
    ctx(ALICE, NEAR / 100, 300, vec![], NOW);
    let _ = c.fn_call("preview".into(), json!({ "url": "https://example.com" }).to_string());
    let (request, callback, deposit, gas) = outlayer_calls();
    assert_eq!(deposit, NEAR / 100, "the whole attached deposit goes to OutLayer");
    assert_eq!(gas, Gas::from_tgas(0), "OutLayer gets the unused gas by weight");
    assert_eq!(request["source"]["Project"]["project_id"], format!("{SITE}/preview"));
    assert_eq!(request["source"]["Project"]["version_key"], Value::Null);
    assert_eq!(request["resource_limits"]["max_instructions"], 2_000_000_000u64);
    assert_eq!(request["resource_limits"]["max_memory_mb"], 128);
    assert_eq!(request["resource_limits"]["max_execution_seconds"], 30);
    assert_eq!(request["input_data"], "{\"url\":\"https://example.com\"}");
    assert_eq!(request["response_format"], "Json");
    assert_eq!(request["payer_account_id"], ALICE);
    assert_eq!(request["secrets_ref"], json!({ "profile": "default", "account_id": SITE }));
    assert_eq!(callback["name"], "preview");
    assert_eq!(callback["request"], "preview-1");
    assert_eq!(callback["caller"], ALICE);
    assert_eq!(callback["refund_to"], ALICE);
    assert_eq!(callback["trigger"], Value::Null);

    // The callback stores the output in `_fn` with the pool paying storage.
    fund(&mut c, NEAR);
    ctx(SITE, 0, 30, result_ok(json!({ "title": "Example" })), NOW);
    let out = c.fn_on_result("preview".into(), "preview-1".into(), ALICE.parse().unwrap(), U128(NEAR / 100), Some(ALICE.parse().unwrap()), None);
    assert_eq!(out, json!({ "title": "Example" }));
    let doc = c.db_get("_fn".into(), "preview-1".into()).unwrap();
    assert_eq!(doc.data["ok"], true);
    assert_eq!(doc.data["output"]["title"], "Example");
    assert_eq!(doc.data["caller"], ALICE);
    assert!(doc.deposit.0 > 0);
    assert_eq!(c.get_pool().reserved.0, doc.deposit.0);
    assert!(get_logs().iter().any(|l| l.contains("fn_result") && l.contains("\"ok\":true")));
    let page = c.fn_results(Some(ListQuery { prefix: Some("preview-".into()), ..Default::default() }));
    assert_eq!(page.docs.len(), 1);
    // The site owner may prune results; the deposit goes back to the pool.
    let pool = c.get_pool().balance.0;
    site(0);
    c.db_remove("_fn".into(), "preview-1".into());
    assert_eq!(c.get_pool().balance.0, pool + doc.deposit.0);
    as_who(ALICE, 0);
    assert!(panics(|| c.db_remove("_fn".into(), "preview-1".into())).contains("read-only"));
}

#[test]
fn fn_call_access_deposit_input_and_gas() {
    let mut c = with_fn("owner_only", spec(FnPayer::Caller, WriteRule::Owner));
    site(1);
    c.fn_set("members".into(), spec(FnPayer::Caller, WriteRule::Members));
    c.fn_set("free".into(), spec(FnPayer::Site, WriteRule::Anyone));
    ctx(ALICE, NEAR, 300, vec![], NOW);
    assert!(panics(|| { let _ = c.fn_call("owner_only".into(), "{}".into()); }).contains("not allowed"));
    ctx(ALICE, NEAR, 300, vec![], NOW);
    assert!(panics(|| { let _ = c.fn_call("members".into(), "{}".into()); }).contains("not allowed"));
    ctx(ALICE, NEAR, 300, vec![], NOW);
    assert!(panics(|| { let _ = c.fn_call("nope".into(), "{}".into()); }).contains("function missing"));
    ctx(ALICE, NEAR / 1000, 300, vec![], NOW);
    assert!(panics(|| { let _ = c.fn_call("members".into(), "{}".into()); }).contains("not allowed"));
    let member = format!("m.{SITE}");
    c.members.set.insert(member.parse().unwrap());
    ctx(&member, NEAR / 1000, 300, vec![], NOW);
    assert!(panics(|| { let _ = c.fn_call("members".into(), "{}".into()); }).contains("attach at least"));
    ctx(&member, NEAR, 300, vec![], NOW);
    assert!(panics(|| { let _ = c.fn_call("members".into(), "not json".into()); }).contains("input must be JSON"));
    ctx(&member, NEAR, 300, vec![], NOW);
    let big = json!({ "x": "y".repeat(4100) }).to_string();
    assert!(panics(|| { let _ = c.fn_call("members".into(), big.clone()); }).contains("over 4096"));
    ctx(&member, NEAR, 100, vec![], NOW);
    assert!(panics(|| { let _ = c.fn_call("members".into(), "{}".into()); }).contains("150 Tgas"));
    ctx(&member, NEAR, 300, vec![], NOW);
    let _ = c.fn_call("members".into(), "{}".into());
    // Site-paid: no deposit, and the pool pays the run.
    ctx(ALICE, 1, 300, vec![], NOW);
    assert!(panics(|| { let _ = c.fn_call("free".into(), "{}".into()); }).contains("attach no deposit"));
    ctx(ALICE, 0, 300, vec![], NOW);
    assert!(panics(|| { let _ = c.fn_call("free".into(), "{}".into()); }).contains("pool cannot pay"));
    fund(&mut c, NEAR);
    ctx(ALICE, 0, 300, vec![], NOW);
    let _ = c.fn_call("free".into(), "{}".into());
    let (request, callback, deposit, _) = outlayer_calls();
    assert_eq!(deposit, NEAR / 200);
    assert_eq!(request["payer_account_id"], SITE);
    assert!(request.get("secrets_ref").is_none());
    assert_eq!(callback["refund_to"], Value::Null);
    assert_eq!(c.get_pool().balance.0, NEAR - NEAR / 200);
}

#[test]
fn failures_are_recorded_and_a_refused_request_refunds_the_payer() {
    let mut c = with_fn("preview", spec(FnPayer::Caller, WriteRule::Anyone));
    fund(&mut c, NEAR);
    // OutLayer ran it and the function failed: null. No refund (OutLayer settles).
    ctx(SITE, 0, 30, result_ok(Value::Null), NOW);
    let out = c.fn_on_result("preview".into(), "preview-1".into(), ALICE.parse().unwrap(), U128(NEAR / 100), Some(ALICE.parse().unwrap()), None);
    assert_eq!(out, Value::Null);
    assert!(transfers().is_empty());
    let doc = c.db_get("_fn".into(), "preview-1".into()).unwrap();
    assert_eq!(doc.data["ok"], false);
    assert_eq!(doc.data["error"], "function failed");
    // The request receipt failed: the deposit came back here, so it goes to the payer.
    ctx(SITE, 0, 30, vec![PromiseResult::Failed], NOW);
    c.fn_on_result("preview".into(), "preview-2".into(), ALICE.parse().unwrap(), U128(NEAR / 100), Some(ALICE.parse().unwrap()), None);
    assert_eq!(transfers(), vec![(ALICE.to_string(), NEAR / 100)]);
    assert_eq!(c.db_get("_fn".into(), "preview-2".into()).unwrap().data["error"], "request failed");
    // Site-paid: back to the pool.
    let pool = c.get_pool().balance.0;
    ctx(SITE, 0, 30, vec![PromiseResult::Failed], NOW);
    c.fn_on_result("preview".into(), "preview-3".into(), SITE.parse().unwrap(), U128(NEAR / 200), None, None);
    assert!(transfers().is_empty());
    let stored = c.db_get("_fn".into(), "preview-3".into()).unwrap().deposit.0;
    assert_eq!(c.get_pool().balance.0, pool + NEAR / 200 - stored);
    // Output that is not JSON.
    ctx(SITE, 0, 30, vec![PromiseResult::Successful(b"not json".to_vec())], NOW);
    c.fn_on_result("preview".into(), "preview-4".into(), ALICE.parse().unwrap(), U128(0), None, None);
    assert_eq!(c.db_get("_fn".into(), "preview-4".into()).unwrap().data["error"], "output is not JSON");
    // Over 16 KB.
    let big = json!({ "x": "y".repeat(17_000) }).to_string().into_bytes();
    ctx(SITE, 0, 30, vec![PromiseResult::Successful(big)], NOW);
    c.fn_on_result("preview".into(), "preview-5".into(), ALICE.parse().unwrap(), U128(0), None, None);
    assert_eq!(c.db_get("_fn".into(), "preview-5".into()).unwrap().data["error"], "output over 16 KB");
    // A repeated callback for the same request does not panic.
    ctx(SITE, 0, 30, result_ok(json!({})), NOW);
    c.fn_on_result("preview".into(), "preview-5".into(), ALICE.parse().unwrap(), U128(0), None, None);
}

#[test]
fn a_low_pool_stores_the_result_without_output_and_an_empty_pool_stores_nothing() {
    let mut c = with_fn("preview", spec(FnPayer::Caller, WriteRule::Anyone));
    ctx(SITE, 0, 30, result_ok(json!({ "a": 1 })), NOW);
    let out = c.fn_on_result("preview".into(), "preview-1".into(), ALICE.parse().unwrap(), U128(0), None, None);
    assert_eq!(out, json!({ "a": 1 }), "the caller still gets the output");
    assert!(c.db_get("_fn".into(), "preview-1".into()).is_none());
    c.db.pool_balance = 900 * 10_000_000_000_000_000_000;
    let big = json!({ "x": "y".repeat(2000) });
    ctx(SITE, 0, 30, result_ok(big), NOW);
    c.fn_on_result("preview".into(), "preview-2".into(), ALICE.parse().unwrap(), U128(0), None, None);
    let doc = c.db_get("_fn".into(), "preview-2".into()).unwrap();
    assert_eq!(doc.data["output"], Value::Null);
    assert_eq!(doc.data["error"], "output not stored: the pool is low");
}

#[test]
fn on_add_triggers_run_from_the_pool_and_can_hide_the_doc() {
    let mut c = with_fn("moderate", spec(FnPayer::Site, WriteRule::Owner));
    let mut rules = CollectionRules {
        write: WriteRule::Anyone,
        max_doc_bytes: 4096,
        moderated: true,
        payer: Payer::Writer,
        max_docs_per_account: None,
        on_add: Some("moderate".into()),
    };
    site(1);
    c.set_collection("posts".into(), rules.clone());
    // Too little gas for a trigger is refused up front.
    ctx(ALICE, NEAR, 100, vec![], NOW);
    assert!(panics(|| { c.db_add("posts".into(), None, "{}".into()); }).contains("150 Tgas"));
    // An empty pool skips the trigger but keeps the doc.
    ctx(ALICE, NEAR, 300, vec![], NOW);
    let id = c.db_add("posts".into(), None, json!({ "t": "first" }).to_string());
    assert!(get_logs().iter().any(|l| l.contains("on_add moderate skipped")));
    assert!(c.db_get("posts".into(), id).is_some());

    fund(&mut c, NEAR);
    ctx(ALICE, NEAR, 300, vec![], NOW);
    let id = c.db_add("posts".into(), None, json!({ "t": "spam" }).to_string());
    let (request, callback, deposit, _) = outlayer_calls();
    assert_eq!(deposit, NEAR / 200);
    assert_eq!(request["payer_account_id"], SITE);
    let input: Value = serde_json::from_str(request["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(input, json!({ "collection": "posts", "id": id, "owner": ALICE, "data": { "t": "spam" } }));
    assert_eq!(callback["trigger"], json!({ "collection": "posts", "id": id }));

    ctx(SITE, 0, 30, result_ok(json!({ "hide": true, "score": 0.9 })), NOW);
    c.fn_on_result(
        "moderate".into(),
        callback["request"].as_str().unwrap().into(),
        ALICE.parse().unwrap(),
        U128(NEAR / 200),
        None,
        Some(serde_json::from_value(callback["trigger"].clone()).unwrap()),
    );
    let doc = c.db_get("posts".into(), id.clone()).unwrap();
    assert!(doc.hidden);
    assert_eq!(doc.fn_result, Some(json!({ "hide": true, "score": 0.9 })));
    let held = c.db.docs.get(&(1, 2)).unwrap().fn_deposit;
    assert!(held > 0);
    // Removing the doc returns the result storage to the pool.
    let pool = c.get_pool().balance.0;
    as_who(ALICE, 0);
    c.db_remove("posts".into(), id);
    assert_eq!(c.get_pool().balance.0, pool + held);

    // Not moderated: the output is kept but the doc stays visible.
    rules.moderated = false;
    site(1);
    c.set_collection("posts".into(), rules);
    ctx(ALICE, NEAR, 300, vec![], NOW);
    let id = c.db_add("posts".into(), None, json!({ "t": "x" }).to_string());
    let (_, callback, _, _) = outlayer_calls();
    ctx(SITE, 0, 30, result_ok(json!({ "hide": true })), NOW);
    c.fn_on_result("moderate".into(), callback["request"].as_str().unwrap().into(), ALICE.parse().unwrap(), U128(0), None, Some(serde_json::from_value(callback["trigger"].clone()).unwrap()));
    assert!(!c.db_get("posts".into(), id).unwrap().hidden);
}

// ---------------------------------------------------------------- cron

fn job(func: &str, every: u32) -> JobIn {
    JobIn { every_minutes: every, func: func.into(), input: "{\"kind\":\"digest\"}".into() }
}


#[test]
fn cron_set_is_owner_only_and_validated() {
    let mut c = with_fn("digest", spec(FnPayer::Site, WriteRule::Owner));
    as_who(ALICE, 1);
    assert!(panics(|| c.cron_set("daily".into(), job("digest", 30))).contains("only this account"));
    site(0);
    assert!(panics(|| c.cron_set("daily".into(), job("digest", 30))).contains("yoctoNEAR"));
    site(1);
    assert!(panics(|| c.cron_set("daily".into(), job("digest", 4))).contains("every_minutes"));
    assert!(panics(|| c.cron_set("daily".into(), job("nope", 30))).contains("function missing"));
    assert!(panics(|| c.cron_set("Daily".into(), job("digest", 30))).contains("bad job name"));
    let mut bad = job("digest", 30);
    bad.input = "nope".into();
    assert!(panics(|| c.cron_set("daily".into(), bad)).contains("input must be JSON"));
    for n in 0..8 {
        c.cron_set(format!("j{n}"), job("digest", 30));
    }
    assert!(panics(|| c.cron_set("j8".into(), job("digest", 30))).contains("job list is full"));
    c.cron_remove("j7".into());
    let list = serde_json::to_value(c.cron_list()).unwrap();
    assert_eq!(list.as_array().unwrap().len(), 7);
    assert_eq!(list[0]["fn"], "digest");
    assert_eq!(list[0]["last_run"], Value::Null);
    assert_eq!(list[0]["next_due"], "0");
    let parsed: JobIn = serde_json::from_value(json!({ "every_minutes": 30, "fn": "digest" })).unwrap();
    assert_eq!(parsed.input, "{}");
}

#[test]
fn cron_arm_ticks_run_due_jobs_and_yield_again() {
    let mut c = with_fn("digest", spec(FnPayer::Site, WriteRule::Owner));
    site(1);
    c.cron_set("daily".into(), job("digest", 30));
    fund(&mut c, NEAR);
    ctx(ALICE, 0, 40, vec![], NOW);
    assert!(panics(|| c.cron_arm()).contains("needs gas"));
    ctx(ALICE, 0, 300, vec![], NOW);
    c.cron_arm();
    assert!(c.cron.pending.is_some(), "a pending yield");
    let status = c.cron_status();
    assert!(status.armed && status.pending);
    assert_eq!(status.started, Some(U64(NOW)));
    assert!(get_logs().iter().any(|l| l.contains("cron_armed")));
    ctx(BOB, 0, 300, vec![], NOW + 1);
    assert!(panics(|| c.cron_arm()).contains("already armed"));
    ctx(BOB, 0, 300, vec![], NOW + 1);
    assert!(panics(|| c.cron_kick()).contains("kicked too soon"));

    // The tick runs the due job with fixed gas and yields again.
    let chain = c.cron.chain;
    let t1 = NOW + 120 * 1_000_000_000;
    ctx(SITE, 0, 290, vec![PromiseResult::Failed], t1);
    c.cron_tick(chain);
    let (request, callback, deposit, gas) = outlayer_calls();
    assert_eq!(gas, crate::cron::JOB_REQUEST_GAS);
    assert_eq!(deposit, NEAR / 200);
    assert_eq!(request["input_data"], "{\"kind\":\"digest\"}");
    assert_eq!(callback["caller"], SITE);
    assert!(callback["request"].as_str().unwrap().starts_with("digest-"));
    // The tick clears `pending` first, so a pending yield now means it yielded again.
    assert!(c.cron.pending.is_some(), "yielded again");
    let status = c.cron_status();
    assert_eq!(status.hops.0, 1);
    assert_eq!(status.last_tick, Some(U64(t1)));
    let jobs = c.cron_list();
    assert_eq!(jobs[0].last_run, Some(U64(t1)));
    assert_eq!(jobs[0].next_due.0, t1 + 30 * 60 * 1_000_000_000);
    assert_eq!(c.get_pool().balance.0, NEAR - NEAR / 200);

    // Not due again yet: the next tick only yields.
    ctx(SITE, 0, 200, vec![PromiseResult::Failed], t1 + 120 * 1_000_000_000);
    c.cron_tick(chain);
    assert!(get_created_receipts().iter().all(|r| r.receiver_id.as_str() != "outlayer.testnet"));
    assert!(c.cron.pending.is_some());

    // Low gas: no job, and the chain stops.
    ctx(SITE, 0, 22, vec![PromiseResult::Failed], t1 + 3600 * 1_000_000_000);
    c.cron_tick(chain);
    assert!(c.cron.pending.is_none());
    assert!(!c.cron_status().armed);
    assert!(get_logs().iter().any(|l| l.contains("cron_stopped")));
    // A stale tick of an older chain does nothing.
    ctx(ALICE, 0, 300, vec![], t1 + 3700 * 1_000_000_000);
    c.cron_arm();
    let live = c.cron.pending;
    ctx(SITE, 0, 290, vec![PromiseResult::Failed], t1 + 3800 * 1_000_000_000);
    c.cron_tick(chain);
    assert_eq!(c.cron.pending, live, "an old chain's tick leaves the live chain alone");
    assert_eq!(c.cron_status().hops.0, 0);
}

#[test]
fn a_dead_chain_can_be_armed_again_after_ten_minutes() {
    let mut c = with_fn("digest", spec(FnPayer::Site, WriteRule::Owner));
    ctx(ALICE, 0, 300, vec![], NOW);
    c.cron_arm();
    let first = c.cron.chain;
    ctx(ALICE, 0, 300, vec![], NOW + 9 * 60 * 1_000_000_000);
    assert!(panics(|| c.cron_arm()).contains("already armed"));
    ctx(ALICE, 0, 300, vec![], NOW + 11 * 60 * 1_000_000_000);
    c.cron_arm();
    assert_eq!(c.cron.chain, first + 1);
    site(0);
    let mut fresh = Contract::new();
    as_who(ALICE, 0);
    assert!(panics(|| fresh.cron_kick()).contains("nothing to kick"));
}

// ---------------------------------------------------------------- the export layer

/// Call an export with JSON input as `who`, against the state in storage.
fn via_export(f: fn(), who: &str, deposit: u128, input: Value) {
    let predecessor: AccountId = who.parse().unwrap();
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(SITE.parse().unwrap())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300))
        .block_timestamp(NOW);
    builder.context.input = input.to_string().into_bytes().into();
    testing_env!(
        builder.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        Vec::new(),
    );
    f();
}

fn state() -> Contract {
    near_sdk::env::state_read().expect("state")
}

#[test]
fn every_export_reads_its_json_arguments() {
    use crate::exports as x;
    let hash = crate::tests_v3::sha_hex(b"<p>x</p>");
    let pk = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
    let steps: Vec<(fn(), &str, u128, Value)> = vec![
        (x::new, SITE, 0, json!({})),
        (x::put_chunk, SITE, 0, json!({ "sha256": hash, "data": "PHA+eDwvcD4=" })),
        (x::seal, SITE, 0, json!({ "id": "1", "message": "m", "spa": false, "files": [{ "path": "index.html", "chunks": [hash], "content_type": "text/html" }] })),
        (x::seal, SITE, 0, json!({ "id": "2", "message": "m", "spa": false, "routes": [], "files": [{ "path": "index.html", "chunks": [hash], "content_type": "text/html" }] })),
        (x::promote, SITE, 1, json!({ "id": "1" })),
        (x::promote, SITE, 1, json!({ "id": "2" })),
        (x::rollback, SITE, 1, json!({})),
        (x::delete, SITE, 1, json!({ "id": "2" })),
        (x::buy, BOB, NEAR / 100, json!({ "memo": "hi" })),
        (x::set_collection, SITE, 1, json!({ "name": "posts", "rules": { "write": "anyone", "max_doc_bytes": 100, "moderated": true, "payer": "writer" } })),
        (x::set_collection, SITE, 1, json!({ "name": "tmp", "rules": { "write": "owner", "max_doc_bytes": 100, "moderated": false, "payer": "site" } })),
        (x::drop_collection, SITE, 1, json!({ "name": "tmp" })),
        (x::db_add, ALICE, NEAR, json!({ "collection": "posts", "data": "{\"a\":1}" })),
        (x::db_add, ALICE, NEAR, json!({ "collection": "posts", "id": "slug", "data": "{\"a\":2}" })),
        (x::db_update, ALICE, NEAR, json!({ "collection": "posts", "id": "slug", "data": "{\"a\":3}" })),
        (x::db_hide, SITE, 1, json!({ "collection": "posts", "id": "1", "hidden": true })),
        (x::db_remove, ALICE, 0, json!({ "collection": "posts", "id": "slug" })),
        (x::db_fund, BOB, NEAR, json!({})),
        (x::db_withdraw, SITE, 1, json!({ "amount": "10" })),
        (x::join, BOB, 0, json!({ "name": "carol", "public_key": pk })),
        (x::set_members_open, SITE, 1, json!({ "open": false })),
        (x::set_product, SITE, 1, json!({ "id": "pin", "product": { "name": "Pin", "price_yocto": "100000000000000000000000", "grant": "pin", "pin_seconds": 60 } })),
        (x::set_product, SITE, 1, json!({ "id": "gone", "product": { "name": "Gone", "price_token": "5", "grant": "receipt" } })),
        (x::remove_product, SITE, 1, json!({ "id": "gone" })),
        (x::set_token, SITE, 1, json!({ "account": "usdc.testnet" })),
        (x::pay, BOB, NEAR, json!({ "product": "pin", "ref": "posts/1" })),
        (x::fn_set, SITE, 1, json!({ "name": "digest", "spec": { "project": "a.testnet/digest", "call": "anyone", "payer": "caller" } })),
        (x::fn_set, SITE, 1, json!({ "name": "gone", "spec": { "project": "a.testnet/gone", "call": "owner", "payer": "site" } })),
        (x::fn_remove, SITE, 1, json!({ "name": "gone" })),
        (x::set_outlayer, SITE, 1, json!({ "account": "mock.testnet" })),
        (x::fn_call, ALICE, NEAR, json!({ "name": "digest", "input": "{}" })),
        (x::cron_set, SITE, 1, json!({ "name": "hourly", "job": { "every_minutes": 60, "fn": "digest", "input": "{}" } })),
        (x::cron_set, SITE, 1, json!({ "name": "gone", "job": { "every_minutes": 60, "fn": "digest" } })),
        (x::cron_remove, SITE, 1, json!({ "name": "gone" })),
        (x::cron_arm, BOB, 0, json!({})),
    ];
    for (f, who, deposit, input) in steps {
        via_export(f, who, deposit, input);
    }
    let c = state();
    assert_eq!(c.get_production().as_deref(), Some("1"));
    assert_eq!(c.get_sales().len(), 1);
    assert!(c.get_collection("tmp".into()).is_none());
    assert!(c.db_get("posts".into(), "1".into()).unwrap().hidden);
    assert!(c.db_get("posts".into(), "slug".into()).is_none());
    assert!(!c.get_members_open());
    assert!(c.get_product("gone".into()).is_none());
    assert_eq!(c.get_token().unwrap().as_str(), "usdc.testnet");
    assert!(c.has_paid(BOB.parse().unwrap(), "pin".into(), Some("posts/1".into())));
    assert!(c.fn_get("gone".into()).is_none());
    assert_eq!(c.get_outlayer().as_str(), "mock.testnet");
    assert_eq!(c.cron_list().len(), 1);
    assert!(c.cron_status().armed);
    assert_eq!(c.get_pool().balance.0, NEAR - 10);

    // Callbacks and the receiver hook, with their argument names.
    via_export(x::on_join, SITE, 0, json!({ "account": format!("carol.{SITE}") }));
    via_export(x::ft_on_transfer, "usdc.testnet", 0, json!({ "sender_id": BOB, "amount": "5", "msg": "{}" }));
    via_export(x::fn_on_result, SITE, 0, json!({ "name": "digest", "request": "digest-1", "caller": ALICE, "deposit": "0", "refund_to": null, "trigger": null }));
    let chain = state().cron.chain;
    via_export(x::cron_tick, SITE, 0, json!({ "chain": chain }));
    let kick = panics(|| via_export(x::cron_kick, BOB, 0, json!({})));
    assert!(kick.contains("kicked too soon"), "{kick}");
    assert!(state().db_get("_fn".into(), "digest-1".into()).is_some());

    // Views run through their exports too.
    let views: Vec<(fn(), Value)> = vec![
        (x::publish_methods, json!({})),
        (x::web4_get, json!({ "request": { "path": "/", "accountId": null, "query": {} } })),
        (x::get_version, json!({})),
        (x::get_status, json!({})),
        (x::get_production, json!({})),
        (x::get_previous, json!({})),
        (x::get_release, json!({ "id": "1" })),
        (x::list_releases, json!({ "from_index": 0, "limit": 5 })),
        (x::list_history, json!({ "from_index": 0, "limit": 5 })),
        (x::get_budget, json!({})),
        (x::has_chunk, json!({ "sha256": hash })),
        (x::get_sales, json!({})),
        (x::get_collection, json!({ "name": "posts" })),
        (x::list_collections, json!({})),
        (x::db_get, json!({ "collection": "posts", "id": "1" })),
        (x::db_list, json!({ "collection": "posts", "query": { "limit": 5, "include_hidden": true } })),
        (x::db_list, json!({ "collection": "posts" })),
        (x::get_pool, json!({})),
        (x::get_members_open, json!({})),
        (x::list_members, json!({ "from_index": 0, "limit": 5 })),
        (x::is_member, json!({ "account": ALICE })),
        (x::get_product, json!({ "id": "pin" })),
        (x::list_products, json!({})),
        (x::get_token, json!({})),
        (x::has_paid, json!({ "account": BOB, "product": "pin", "ref": "posts/1" })),
        (x::list_receipts, json!({ "query": { "owner": BOB } })),
        (x::fn_get, json!({ "name": "digest" })),
        (x::fn_list, json!({})),
        (x::get_outlayer, json!({})),
        (x::fn_results, json!({})),
        (x::cron_list, json!({})),
        (x::cron_status, json!({})),
    ];
    for (f, input) in views {
        via_export(f, ALICE, 0, input);
    }
}

#[test]
fn exports_keep_the_near_sdk_refusals() {
    use crate::exports as x;
    via_export(x::new, SITE, 0, json!({}));
    let msg = panics(|| via_export(x::new, SITE, 0, json!({})));
    assert!(msg.contains("already been initialized"), "{msg}");
    let msg = panics(|| via_export(x::put_chunk, SITE, 1, json!({ "sha256": "ab", "data": "" })));
    assert!(msg.contains("Method put_chunk doesn't accept deposit"), "{msg}");
    let msg = panics(|| via_export(x::on_join, ALICE, 0, json!({ "account": ALICE })));
    assert!(msg.contains("Method on_join is private"), "{msg}");
    let msg = panics(|| via_export(x::db_get, ALICE, 0, json!({ "collection": 5 })));
    assert!(msg.contains("Failed to deserialize input from JSON."), "{msg}");
    let msg = panics(|| via_export(x::promote, SITE, 1, json!("not an object")));
    assert!(msg.contains("Failed to deserialize input from JSON."), "{msg}");
}
