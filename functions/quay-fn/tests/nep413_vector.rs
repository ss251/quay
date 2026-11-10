//! The NEP-413 proof in vectors/nep413.json was signed by `client/src/encoding.mjs`
//! (see `cli/test/function-vectors.test.mjs`). The Rust checks must agree with `verify.mjs`.
#![cfg(feature = "ed25519")]

use quay_fn::encoding::{b64_decode, hex};
use quay_fn::rpc::Rpc;
use quay_fn::signin::{check_proof, nep413_payload, verify_sign_in, Options};
use quay_fn::{json, Value};

fn vector() -> Value {
    serde_json::from_str(include_str!("vectors/nep413.json")).unwrap()
}

#[test]
fn payload_bytes_match_the_js_encoder() {
    let v = vector();
    let p = &v["proof"];
    let nonce: [u8; 32] = b64_decode(p["nonce"].as_str().unwrap()).unwrap().try_into().unwrap();
    let msg = p["message"].as_str().unwrap();
    let site = p["recipient"].as_str().unwrap();
    assert_eq!(hex(&nep413_payload(msg, &nonce, site, None)), v["payload_hex"].as_str().unwrap());
    assert_eq!(
        hex(&nep413_payload(msg, &nonce, site, Some("https://board.testnet.page/"))),
        v["with_callback_hex"].as_str().unwrap()
    );
}

#[test]
fn accepts_the_js_signed_proof() {
    let v = vector();
    let opts = Options { site: "board.testnet", max_age_ms: 300_000, now_ms: v["now_ms"].as_u64().unwrap() };
    let rpc = Rpc::with_transport(|req| {
        assert_eq!(req["params"]["request_type"], "view_access_key");
        assert_eq!(req["params"]["account_id"], "alice.board.testnet");
        Ok(json!({ "result": { "nonce": 3, "permission": "FullAccess" } }))
    });
    let ok = verify_sign_in(&v["proof"], &opts, &rpc).unwrap();
    assert_eq!(ok.account_id, "alice.board.testnet");

    let mut bad = v["proof"].clone();
    bad["message"] = json!(format!("{} ", bad["message"].as_str().unwrap()));
    assert_eq!(check_proof(&bad, &opts).unwrap_err(), "bad signature");
    let wrong_site = Options { site: "other.testnet", ..opts };
    assert_eq!(check_proof(&v["proof"], &wrong_site).unwrap_err(), "wrong recipient");
}
