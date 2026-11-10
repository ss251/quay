use super::*;
use quay_fn::encoding::{hex, hex_decode};
use std::cell::RefCell;
use std::rc::Rc;

const VECTOR: &str = include_str!("../tests/vectors/relay.json");

fn vector() -> Value {
    serde_json::from_str(VECTOR).unwrap()
}

fn seed(byte: u8) -> [u8; 32] {
    [byte; 32]
}

/// A delegate built and signed here (seed 4 = the member key of the vector).
fn delegate_bytes(sender: &str, receiver: &str, calls: &[FunctionCall], max_block_height: u64, signer: u8) -> Vec<u8> {
    let pk = signin::public_key_of(&seed(signer));
    let mut w = Writer::new();
    w.str(sender).str(receiver).u32(calls.len() as u32);
    for c in calls {
        w.u8(2).str(&c.method).bytes(&c.args).u64(c.gas).u128(c.deposit);
    }
    w.u64(5).u64(max_block_height).u8(0).raw(&pk);
    let part = w.finish();
    let hash = sha256(&Writer::new().u32(NEP461_TAG).raw(&part).finish());
    let sig = signin::sign(&seed(signer), &hash);
    Writer::new().raw(&part).u8(0).raw(&sig).finish()
}

fn call(method: &str, gas_tgas: u64, deposit: u128) -> FunctionCall {
    FunctionCall { method: method.into(), args: b"{}".to_vec(), gas: gas_tgas * TGAS, deposit }
}

fn policy() -> Policy {
    Policy::new("board.testnet")
}

#[test]
fn decodes_the_js_signed_delegate() {
    let v = vector();
    let bytes = b64_decode(v["signed_delegate_base64"].as_str().unwrap()).unwrap();
    let d = decode_signed_delegate(&bytes).unwrap();
    assert_eq!(d.sender, "alice.board.testnet");
    assert_eq!(d.receiver, "board.testnet");
    assert_eq!(d.nonce, 12);
    assert_eq!(d.max_block_height, 1000);
    assert_eq!(format_public_key(&d.public_key), v["member_public_key"].as_str().unwrap());
    let a = d.actions[0].as_ref().unwrap();
    assert_eq!(a.method, "db_add");
    assert_eq!(a.gas, 100 * TGAS);
    assert_eq!(a.deposit, 0);
    assert!(signin::verify(&d.public_key, &delegate_hash(&d), &d.signature));
}

#[test]
fn builds_the_same_transaction_as_near_api_js() {
    let v = vector();
    let bytes = b64_decode(v["signed_delegate_base64"].as_str().unwrap()).unwrap();
    let relayer_seed: [u8; 32] = hex_decode(v["relayer_seed_hex"].as_str().unwrap()).unwrap().try_into().unwrap();
    let pk = signin::public_key_of(&relayer_seed);
    assert_eq!(format_public_key(&pk), v["relayer_public_key"].as_str().unwrap());
    let block: [u8; 32] = b58_decode(v["block_hash"].as_str().unwrap()).unwrap().try_into().unwrap();
    let tx = encode_transaction(
        v["relayer_account"].as_str().unwrap(),
        &pk,
        v["nonce"].as_u64().unwrap(),
        "alice.board.testnet",
        &block,
        &[Action::Delegate(&bytes)],
    );
    assert_eq!(hex(&tx), v["tx_hex"].as_str().unwrap());
    let (signed, hash) = sign_transaction(&relayer_seed, &tx);
    assert_eq!(hash, v["tx_hash"].as_str().unwrap());
    assert_eq!(hex(&signed), v["signed_tx_hex"].as_str().unwrap());

    let member = v["member_public_key"].as_str().unwrap();
    let join = FunctionCall {
        method: "join".into(),
        args: json!({ "name": "alice", "public_key": member }).to_string().into_bytes(),
        gas: JOIN_GAS,
        deposit: 0,
    };
    let tx = encode_transaction(
        "relay.board.testnet",
        &pk,
        v["join_nonce"].as_u64().unwrap(),
        "board.testnet",
        &block,
        &[Action::FunctionCall(&join)],
    );
    assert_eq!(hex(&tx), v["join_tx_hex"].as_str().unwrap());
}

fn refused(bytes: &[u8], p: &Policy, height: u64) -> &'static str {
    let d = decode_signed_delegate(bytes).unwrap();
    check(&d, p, 0, height, &MemoryStore::default()).unwrap_err().code
}

#[test]
fn enforces_the_policy() {
    let p = policy();
    let m = "alice.board.testnet";
    let ok = delegate_bytes(m, "board.testnet", &[call("db_add", 100, 0)], 1100, 4);
    let d = decode_signed_delegate(&ok).unwrap();
    let charge = check(&d, &p, 7_200_000, 1000, &MemoryStore::default()).unwrap();
    assert_eq!(charge, Charge { hour_key: format!("acct:{m}:2"), day_key: "tgas:0".into(), tgas: 100 });

    // deposit is a hard rule: the relayer would pay it
    assert_eq!(refused(&delegate_bytes(m, "board.testnet", &[call("db_add", 10, 1)], 1100, 4), &p, 1000), "deposit_not_allowed");
    assert_eq!(refused(&delegate_bytes(m, "board.testnet", &[call("db_add", 301, 0)], 1100, 4), &p, 1000), "gas_too_high");
    assert_eq!(refused(&delegate_bytes(m, "board.testnet", &[call("promote", 10, 0)], 1100, 4), &p, 1000), "method_not_allowed");
    assert_eq!(refused(&delegate_bytes(m, "evil.testnet", &[call("db_add", 10, 0)], 1100, 4), &p, 1000), "receiver_not_allowed");
    assert_eq!(refused(&delegate_bytes("bob.testnet", "board.testnet", &[call("db_add", 10, 0)], 1100, 4), &p, 1000), "sender_not_member");
    assert_eq!(refused(&delegate_bytes(m, "board.testnet", &[call("db_add", 10, 0)], 1000, 4), &p, 1000), "expired");
    assert_eq!(refused(&delegate_bytes(m, "board.testnet", &[call("db_add", 10, 0)], 1201, 4), &p, 1000), "expiry_too_far");
    assert_eq!(refused(&delegate_bytes(m, "board.testnet", &[], 1100, 4), &p, 1000), "no_actions");

    // a signature by another key
    let mut forged = delegate_bytes(m, "board.testnet", &[call("db_add", 10, 0)], 1100, 4);
    let n = forged.len();
    forged[n - 1] ^= 1;
    assert_eq!(refused(&forged, &p, 1000), "bad_signature");

    // non-FunctionCall actions (Transfer = 3)
    let mut w = Writer::new();
    w.str(m).str("board.testnet").u32(1).u8(3).u128(1);
    let transfer = w.finish();
    assert_eq!(refused(&transfer, &p, 1000), "action_not_allowed");

    // uploads go to the sender itself, only when allowed
    let up = delegate_bytes(m, m, &[call("fs_store", 10, 0)], 1100, 4);
    assert_eq!(refused(&up, &p, 1000), "receiver_not_allowed");
    let p2 = Policy { allow_uploads: true, ..policy() };
    assert!(check(&decode_signed_delegate(&up).unwrap(), &p2, 0, 1000, &MemoryStore::default()).is_ok());
}

#[test]
fn rate_limits_per_sender_and_per_day() {
    let p = Policy { per_account_per_hour: 2, daily_tgas: 250, ..policy() };
    let store = MemoryStore::default();
    let bytes = delegate_bytes("alice.board.testnet", "board.testnet", &[call("db_add", 100, 0)], 1100, 4);
    let d = decode_signed_delegate(&bytes).unwrap();
    for _ in 0..2 {
        let c = check(&d, &p, 0, 1000, &store).unwrap();
        store.add(&c.hour_key, 1).unwrap();
        store.add(&c.day_key, c.tgas).unwrap();
    }
    assert_eq!(check(&d, &p, 0, 1000, &store).unwrap_err().code, "account_rate_limit");
    let bob = delegate_bytes("bob.board.testnet", "board.testnet", &[call("db_add", 100, 0)], 1100, 4);
    let e = check(&decode_signed_delegate(&bob).unwrap(), &p, 0, 1000, &store).unwrap_err();
    assert_eq!(e.code, "daily_budget");
}

#[test]
fn policy_overrides_are_strict() {
    let p = policy()
        .with_overrides(&json!({ "site": "counter.testnet", "methods": ["increment"], "member_only": false, "max_gas": "50000000000000" }))
        .unwrap();
    assert_eq!(p.site, "counter.testnet");
    assert_eq!(p.methods, vec!["increment"]);
    assert_eq!(p.max_gas, 50 * TGAS);
    assert!(policy().with_overrides(&json!({ "metods": [] })).is_err());
    assert!(policy().with_overrides(&json!({ "member_only": "yes" })).is_err());
}

#[test]
fn config_never_echoes_the_key() {
    let env = |k: &str| match k {
        "OUTLAYER_PROJECT_OWNER" => Some("board.testnet".to_string()),
        "RELAY_KEY" => Some("ed25519:not-a-valid-key-0OIl".to_string()),
        _ => None,
    };
    let err = Config::from_env(&env).err().unwrap();
    assert!(!err.contains("not-a-valid"), "{err}");
    let missing = Config::from_env(&|k: &str| (k == "OUTLAYER_PROJECT_OWNER").then(|| "b.testnet".to_string()));
    assert!(missing.err().unwrap().contains("RELAY_KEY is not set"));
}

#[test]
fn member_names() {
    assert!(check_member_name("alice_1").is_ok());
    assert!(check_member_name("a").is_err());
    assert!(check_member_name("Alice").is_err());
    assert!(check_member_name("relay").is_err());
}

#[test]
fn reports_inner_failures() {
    let outcome = json!({
        "status": { "SuccessValue": "" },
        "transaction_outcome": { "outcome": { "status": { "SuccessReceiptId": "x" } } },
        "receipts_outcome": [
            { "outcome": { "status": { "SuccessValue": "" } } },
            { "outcome": { "status": { "Failure": { "ActionError": { "kind": "DelegateActionExpired" } } } } }
        ]
    });
    let f = failures(&outcome);
    assert_eq!(f.len(), 1);
    assert!(f[0].contains("DelegateActionExpired"));
}

#[derive(Clone, Copy, PartialEq)]
enum Node {
    Ok,
    /// The first send_tx is refused with InvalidNonce (another relay took the nonce).
    NonceRace,
    /// send_tx times out at the node.
    Timeout,
}

/// A fake RPC node: block, access key, account, and send_tx (recording the params).
fn fake_rpc(sent: Rc<RefCell<Vec<Value>>>, node: Node) -> Rpc {
    Rpc::with_transport(move |req| {
        let method = req["method"].as_str().unwrap();
        let p = &req["params"];
        let result = match (method, p["request_type"].as_str()) {
            ("block", _) => json!({ "header": { "height": 1000, "hash": b58(&[5u8; 32]) } }),
            // the relayer's key is at 76, a member's key at 1
            ("query", Some("view_access_key")) if p["account_id"] == "relay.board.testnet" => json!({ "nonce": 76, "permission": "FullAccess" }),
            ("query", Some("view_access_key")) => json!({ "nonce": 1, "permission": "FullAccess" }),
            ("query", Some("view_account")) => json!({ "amount": "500000000000000000000000" }),
            ("send_tx", _) => {
                sent.borrow_mut().push(p.clone());
                if node == Node::Timeout {
                    return Ok(json!({ "error": { "name": "HANDLER_ERROR", "cause": { "name": "TIMEOUT_ERROR" } } }));
                }
                if node == Node::NonceRace && sent.borrow().len() == 1 {
                    return Ok(json!({ "error": { "name": "HANDLER_ERROR", "cause": { "name": "INVALID_TRANSACTION" },
                        "data": { "TxExecutionError": { "InvalidTxError": { "InvalidNonce": { "tx_nonce": 77, "ak_nonce": 77 } } } } } }));
                }
                if p["wait_until"] == "INCLUDED" {
                    json!({ "final_execution_status": "INCLUDED" })
                } else {
                    json!({ "final_execution_status": "EXECUTED_OPTIMISTIC", "status": { "SuccessValue": "" },
                            "transaction_outcome": { "outcome": { "status": {} } },
                            "receipts_outcome": [ { "outcome": { "status": { "SuccessValue": "" } } } ] })
                }
            }
            other => panic!("unexpected rpc {other:?}"),
        };
        Ok(json!({ "result": result }))
    })
}

fn config() -> Config {
    Config {
        account: "relay.board.testnet".into(),
        seed: seed(3),
        public_key: signin::public_key_of(&seed(3)),
        policy: policy(),
    }
}

#[test]
fn relays_end_to_end_against_a_fake_node() {
    let v = vector();
    let sent = Rc::new(RefCell::new(Vec::new()));
    let rpc = fake_rpc(sent.clone(), Node::Ok);
    let store = MemoryStore::default();
    let bytes = delegate_bytes("alice.board.testnet", "board.testnet", &[call("db_add", 100, 0)], 1100, 4);
    let out = handle(&json!({ "op": "relay", "signed_delegate": b64(&bytes) }), &config(), &rpc, &store, 0);
    assert!(out.get("error").is_none(), "{out}");
    // it returns once the transaction is in a block, without waiting for triggers
    assert_eq!(sent.borrow()[0]["wait_until"], "INCLUDED");
    assert_eq!(out["status"], "included");
    let tx = b64_decode(sent.borrow()[0]["signed_tx_base64"].as_str().unwrap()).unwrap();
    // nonce = access key nonce + 1, block hash from the final block
    let expect = encode_transaction("relay.board.testnet", &config().public_key, 77, "alice.board.testnet", &[5; 32], &[Action::Delegate(&bytes)]);
    assert_eq!(&tx[..expect.len()], &expect[..]);
    assert_eq!(out["hash"].as_str().unwrap(), b58(&sha256(&expect)));
    assert_eq!(store.get("acct:alice.board.testnet:0").unwrap(), 1);

    // the JS-built delegate expires at 1000 = the fake head: refused before sending
    let old = handle(&json!({ "op": "relay", "signed_delegate": v["signed_delegate_base64"] }), &config(), &rpc, &store, 0);
    assert_eq!(old["code"], "expired");
    assert_eq!(sent.borrow().len(), 1);
}

#[test]
fn a_node_timeout_returns_the_hash_as_pending_not_an_error() {
    let sent = Rc::new(RefCell::new(Vec::new()));
    let rpc = fake_rpc(sent.clone(), Node::Timeout);
    let bytes = delegate_bytes("alice.board.testnet", "board.testnet", &[call("db_add", 100, 0)], 1100, 4);
    let out = handle(&json!({ "op": "relay", "signed_delegate": b64(&bytes) }), &config(), &rpc, &MemoryStore::default(), 0);
    assert!(out.get("error").is_none(), "{out}");
    assert_eq!(out["status"], "pending");
    let expect = encode_transaction("relay.board.testnet", &config().public_key, 77, "alice.board.testnet", &[5; 32], &[Action::Delegate(&bytes)]);
    assert_eq!(out["hash"].as_str().unwrap(), b58(&sha256(&expect)));
    assert_eq!(sent.borrow().len(), 1, "never sends twice on a timeout");
}

#[test]
fn a_nonce_race_is_retried_once_with_the_next_nonce() {
    let sent = Rc::new(RefCell::new(Vec::new()));
    let rpc = fake_rpc(sent.clone(), Node::NonceRace);
    let bytes = delegate_bytes("alice.board.testnet", "board.testnet", &[call("db_add", 100, 0)], 1100, 4);
    let out = handle(&json!({ "op": "relay", "signed_delegate": b64(&bytes) }), &config(), &rpc, &MemoryStore::default(), 0);
    assert_eq!(out["status"], "included", "{out}");
    assert_eq!(sent.borrow().len(), 2);
    let second = b64_decode(sent.borrow()[1]["signed_tx_base64"].as_str().unwrap()).unwrap();
    let expect = encode_transaction("relay.board.testnet", &config().public_key, 78, "alice.board.testnet", &[5; 32], &[Action::Delegate(&bytes)]);
    assert_eq!(&second[..expect.len()], &expect[..]);
}

#[test]
fn send_results_are_classified() {
    let h = "HASH";
    assert_eq!(send_result(Ok(json!({ "final_execution_status": "INCLUDED" })), h), json!({ "hash": h, "status": "included" }));
    assert_eq!(send_result(Err("request failed: connection reset".into()), h)["status"], "pending");
    assert_eq!(send_result(Err("rpc send_tx: TIMEOUT_ERROR".into()), h)["status"], "pending");
    let bad = send_result(Err("rpc send_tx: INVALID_TRANSACTION {\"Expired\":null}".into()), h);
    assert_eq!(bad["code"], "rejected");
    let inner = send_result(Ok(json!({ "receipts_outcome": [ { "outcome": { "status": { "Failure": { "x": 1 } } } } ] })), h);
    assert_eq!(inner["code"], "inner_failure");
    let busy = send_result(Err("rpc send_tx: INVALID_TRANSACTION {\"InvalidTxError\":{\"NotEnoughBalance\":{}}}".into()), h);
    assert_eq!(busy["code"], "relayer_busy");
    assert!(busy.get("hash").is_none(), "nothing was sent");
    let done = send_result(Ok(json!({ "status": { "SuccessValue": "" }, "receipts_outcome": [] })), h);
    assert_eq!(done["status"], "executed");
}

#[test]
fn joins_and_reports_health() {
    let sent = Rc::new(RefCell::new(Vec::new()));
    let rpc = fake_rpc(sent.clone(), Node::Ok);
    let store = MemoryStore::default();
    let pk = format_public_key(&signin::public_key_of(&seed(4)));
    let out = handle(&json!({ "op": "join", "name": "alice", "public_key": pk }), &config(), &rpc, &store, 0);
    assert_eq!(out["account"], "alice.board.testnet");
    assert_eq!(handle(&json!({ "op": "join", "name": "x", "public_key": pk }), &config(), &rpc, &store, 0)["code"], "bad_name");
    let h = handle(&json!({ "op": "health" }), &config(), &rpc, &store, 0);
    assert_eq!(h["relayer"], "relay.board.testnet");
    assert_eq!(h["balance"], "500000000000000000000000");
    assert_eq!(h["relays_in_flight"], 1, "0.5 NEAR holds one 300 Tgas relay");
    assert_eq!(h["policy"]["deposit"], "0");
    assert!(!h.to_string().contains("ed25519:"), "health must not show keys");
    assert_eq!(handle(&json!({}), &config(), &rpc, &store, 0)["code"], "malformed");
}

/// A node where the relayer's key has nonce 76 and the member key of seed 4 has `member_nonce`
/// (`None`: the key is not on the sender account).
fn member_rpc(sent: Rc<RefCell<Vec<Value>>>, member_nonce: Option<u64>) -> Rpc {
    Rpc::with_transport(move |req| {
        let p = &req["params"];
        if p["request_type"] == "view_access_key" && p["account_id"] != "relay.board.testnet" {
            return Ok(match member_nonce {
                Some(n) => json!({ "result": { "nonce": n, "permission": "FullAccess" } }),
                None => json!({ "error": { "name": "HANDLER_ERROR", "cause": { "name": "UNKNOWN_ACCESS_KEY" } } }),
            });
        }
        let inner = fake_rpc(sent.clone(), Node::Ok);
        inner.call(req["method"].as_str().unwrap(), p.clone()).map(|r| json!({ "result": r }))
    })
}

#[test]
fn a_key_that_is_not_on_the_sender_is_refused_before_anything_is_sent_or_charged() {
    // Anyone can sign a delegate for <name>.<site> with a key of their own: the
    // signature checks out, the chain rejects it, and the relayer pays for the try.
    let sent = Rc::new(RefCell::new(Vec::new()));
    let store = MemoryStore::default();
    let bytes = delegate_bytes("mallory.board.testnet", "board.testnet", &[call("db_add", 300, 0)], 1100, 9);
    let out = handle(&json!({ "op": "relay", "signed_delegate": b64(&bytes) }), &config(), &member_rpc(sent.clone(), None), &store, 0);
    assert_eq!(out["code"], "unknown_key", "{out}");
    assert!(sent.borrow().is_empty());
    assert_eq!(store.get("tgas:0").unwrap(), 0, "a refused delegate spends no budget");
}

#[test]
fn a_used_nonce_is_refused_so_a_seen_delegate_cannot_be_replayed() {
    let sent = Rc::new(RefCell::new(Vec::new()));
    let store = MemoryStore::default();
    // delegate_bytes signs nonce 5; the key on chain is already at 5
    let bytes = delegate_bytes("alice.board.testnet", "board.testnet", &[call("db_add", 100, 0)], 1100, 4);
    let out = handle(&json!({ "op": "relay", "signed_delegate": b64(&bytes) }), &config(), &member_rpc(sent.clone(), Some(5)), &store, 0);
    assert_eq!(out["code"], "nonce_used", "{out}");
    assert!(sent.borrow().is_empty());
    assert_eq!(store.get("acct:alice.board.testnet:0").unwrap(), 0);
    let ok = handle(&json!({ "op": "relay", "signed_delegate": b64(&bytes) }), &config(), &member_rpc(sent.clone(), Some(4)), &store, 0);
    assert!(ok.get("error").is_none(), "{ok}");
}

#[test]
fn only_direct_sub_accounts_of_the_site_are_members() {
    // A member can create x.alice.<site> accounts of its own and dodge the per-sender limit.
    let p = policy();
    let nested = delegate_bytes("x.alice.board.testnet", "board.testnet", &[call("db_add", 10, 0)], 1100, 4);
    assert_eq!(refused(&nested, &p, 1000), "sender_not_member");
    let bare = delegate_bytes(".board.testnet", "board.testnet", &[call("db_add", 10, 0)], 1100, 4);
    assert_eq!(refused(&bare, &p, 1000), "sender_not_member");
    assert!(is_member_of("alice.board.testnet", "board.testnet"));
    assert!(!is_member_of("alice.xboard.testnet", "board.testnet"));
    assert!(!is_member_of("board.testnet", "board.testnet"));
}

#[test]
fn reserving_is_atomic_so_parallel_runs_cannot_pass_the_limits_together() {
    // Two runs that both passed check() before either charged: only one may reserve.
    let p = Policy { per_account_per_hour: 1, daily_tgas: 1000, ..policy() };
    let store = MemoryStore::default();
    let bytes = delegate_bytes("alice.board.testnet", "board.testnet", &[call("db_add", 100, 0)], 1100, 4);
    let d = decode_signed_delegate(&bytes).unwrap();
    let a = check(&d, &p, 0, 1000, &store).unwrap();
    let b = check(&d, &p, 0, 1000, &store).unwrap();
    assert!(reserve(&a, &p, &store).is_ok());
    assert_eq!(reserve(&b, &p, &store).unwrap_err().code, "account_rate_limit");
    assert_eq!(store.get(&a.hour_key).unwrap(), 1, "the refused reservation was rolled back");
    assert_eq!(store.get(&a.day_key).unwrap(), 100);

    let p = Policy { per_account_per_hour: 10, daily_tgas: 150, ..policy() };
    let store = MemoryStore::default();
    let a = check(&d, &p, 0, 1000, &store).unwrap();
    let b = check(&d, &p, 0, 1000, &store).unwrap();
    assert!(reserve(&a, &p, &store).is_ok());
    assert_eq!(reserve(&b, &p, &store).unwrap_err().code, "daily_budget");
    assert_eq!(store.get(&a.hour_key).unwrap(), 1);
    assert_eq!(store.get(&a.day_key).unwrap(), 100);
}

#[test]
fn relayer_busy_gives_the_reservation_back() {
    // Nothing was sent, and the client resends the same delegate: it must not pay twice.
    let store = MemoryStore::default();
    let rpc = Rpc::with_transport(|req| {
        let p = &req["params"];
        Ok(match (req["method"].as_str().unwrap(), p["request_type"].as_str()) {
            ("block", _) => json!({ "result": { "header": { "height": 1000, "hash": b58(&[5u8; 32]) } } }),
            ("query", Some("view_access_key")) => {
                json!({ "result": { "nonce": if p["account_id"] == "relay.board.testnet" { 76 } else { 1 }, "permission": "FullAccess" } })
            }
            ("send_tx", _) => json!({ "error": { "name": "HANDLER_ERROR", "cause": { "name": "INVALID_TRANSACTION" },
                "data": { "TxExecutionError": { "InvalidTxError": { "NotEnoughBalance": {} } } } } }),
            other => panic!("unexpected rpc {other:?}"),
        })
    });
    let bytes = delegate_bytes("alice.board.testnet", "board.testnet", &[call("db_add", 100, 0)], 1100, 4);
    let out = handle(&json!({ "op": "relay", "signed_delegate": b64(&bytes) }), &config(), &rpc, &store, 0);
    assert_eq!(out["code"], "relayer_busy", "{out}");
    assert_eq!(store.get("acct:alice.board.testnet:0").unwrap(), 0);
    assert_eq!(store.get("tgas:0").unwrap(), 0);
}
