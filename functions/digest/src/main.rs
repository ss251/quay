//! `digest`: a scheduled job. Reads the newest docs of a collection with the
//! `db_list` view over JSON-RPC and returns a short digest (at most 2 KB):
//! `{"title","text","collection","counts":{"docs","last_24h","posters"},"top_posters","newest","scheduled"}`.
//! `scheduled` is true when the input says `{"run": "schedule"}` (the cron job does).
//!
//! Input (all optional): `{"collection": "posts", "site": "<account>", "limit": 50}`.
//! The site defaults to the OutLayer project owner, then the calling contract.
use quay_fn::rpc::{Rpc, DEFAULT_RPC};
use quay_fn::{clip, json, Value};

const MAX_BYTES: usize = 2048;
const DAY_NS: u64 = 86_400 * 1_000_000_000;

fn title_of(doc: &Value) -> Option<String> {
    let data = doc.get("data")?;
    ["title", "name", "text", "body"]
        .iter()
        .find_map(|k| data.get(*k).and_then(Value::as_str))
        .map(|t| clip(&t.split_whitespace().collect::<Vec<_>>().join(" "), 80))
        .filter(|t| !t.is_empty())
}

fn num(v: Option<&Value>) -> u64 {
    v.and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0)
}

/// Build the digest from a `db_list` page (newest first). `now_ns` decides "last 24 hours".
pub fn digest(collection: &str, docs: &[Value], now_ns: u64) -> Value {
    let mut posters: Vec<(String, u64)> = Vec::new();
    let mut last_day = 0;
    for doc in docs {
        let owner = doc.get("owner").and_then(Value::as_str).unwrap_or("?").to_string();
        match posters.iter_mut().find(|(o, _)| *o == owner) {
            Some((_, n)) => *n += 1,
            None => posters.push((owner, 1)),
        }
        if now_ns.saturating_sub(num(doc.get("created"))) <= DAY_NS {
            last_day += 1;
        }
    }
    let poster_count = posters.len();
    posters.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    posters.truncate(3);
    let mut newest: Vec<String> = docs.iter().filter_map(title_of).take(5).collect();

    let top = posters.first().map(|(o, n)| format!(" Most active: {o} ({n})."));
    let text = if docs.is_empty() {
        format!("No {collection} yet.")
    } else {
        format!(
            "{last_day} new in the last 24 hours, {} recent from {poster_count} {}.{}",
            docs.len(),
            if poster_count == 1 { "person" } else { "people" },
            top.unwrap_or_default()
        )
    };
    let build = |newest: &[String]| {
        json!({
            "title": clip(&format!("Digest of {collection}"), 60),
            "text": clip(&text, 240),
            "collection": collection,
            "counts": { "docs": docs.len(), "last_24h": last_day, "posters": poster_count },
            "top_posters": posters.iter().map(|(o, n)| json!({ "account": clip(o, 64), "docs": n })).collect::<Vec<_>>(),
            "newest": newest,
        })
    };
    let mut out = build(&newest);
    while out.to_string().len() > MAX_BYTES && !newest.is_empty() {
        newest.pop();
        out = build(&newest);
    }
    out
}

fn answer(input: &Value, rpc: &Rpc, env: &dyn Fn(&str) -> Option<String>, now_ns: u64) -> Result<Value, String> {
    let collection = input.get("collection").and_then(Value::as_str).unwrap_or("posts");
    let site = input
        .get("site")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| env("OUTLAYER_PROJECT_OWNER"))
        .or_else(|| env("NEAR_PREDECESSOR_ID"))
        .ok_or("pass {\"site\": \"<account>\"}")?;
    let limit = num(input.get("limit")).clamp(1, 50);
    let limit = if input.get("limit").is_none() { 50 } else { limit };
    let page = rpc.view(
        &site,
        "db_list",
        &json!({ "collection": collection, "query": { "limit": limit, "order": "desc" } }),
    )?;
    let docs = page.get("docs").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut out = digest(collection, &docs, now_ns);
    // A cron job passes {"run": "schedule"}; anything else is a run by hand.
    out["scheduled"] = json!(input.get("run").and_then(Value::as_str) == Some("schedule"));
    Ok(out)
}

fn main() {
    quay_fn::run(|input| {
        let rpc = Rpc::new(&quay_fn::env("DIGEST_RPC").unwrap_or_else(|| DEFAULT_RPC.to_string()));
        answer(&input, &rpc, &quay_fn::env, quay_fn::now_ms() * 1_000_000)
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(owner: &str, title: &str, created_ns: u64) -> Value {
        json!({ "owner": owner, "created": created_ns.to_string(), "data": { "title": title } })
    }

    #[test]
    fn summarises_a_page() {
        let now = 10 * DAY_NS;
        let docs = vec![
            doc("alice.b.testnet", "Harbour at dawn", now - 1000),
            doc("bob.b.testnet", "Gulls", now - 2000),
            doc("alice.b.testnet", "  Fog   again ", now - 2 * DAY_NS),
        ];
        let d = digest("posts", &docs, now);
        assert_eq!(d["counts"], json!({ "docs": 3, "last_24h": 2, "posters": 2 }));
        assert_eq!(d["top_posters"][0], json!({ "account": "alice.b.testnet", "docs": 2 }));
        assert_eq!(d["newest"], json!(["Harbour at dawn", "Gulls", "Fog again"]));
        assert_eq!(d["title"], "Digest of posts");
        assert_eq!(d["text"], "2 new in the last 24 hours, 3 recent from 2 people. Most active: alice.b.testnet (2).");
        assert_eq!(digest("posts", &[], now)["text"], "No posts yet.");
    }

    #[test]
    fn stays_under_two_kilobytes() {
        let docs: Vec<Value> = (0..50).map(|i| doc(&format!("{}{i}.b.testnet", "u".repeat(50)), &"t".repeat(300), 0)).collect();
        assert!(digest("posts", &docs, 0).to_string().len() <= MAX_BYTES);
    }

    #[test]
    fn reads_db_list_over_rpc() {
        let rpc = Rpc::with_transport(|req| {
            let args = quay_fn::encoding::b64_decode(req["params"]["args_base64"].as_str().unwrap()).unwrap();
            let args: Value = serde_json::from_slice(&args).unwrap();
            assert_eq!(args, json!({ "collection": "notes", "query": { "limit": 5, "order": "desc" } }));
            assert_eq!(req["params"]["account_id"], "board.testnet");
            let page = json!({ "docs": [doc("a.board.testnet", "One", 0)], "next": null }).to_string();
            let bytes: Vec<Value> = page.bytes().map(|b| json!(b)).collect();
            Ok(json!({ "result": { "result": bytes } }))
        });
        let env = |k: &str| (k == "OUTLAYER_PROJECT_OWNER").then(|| "board.testnet".to_string());
        let out = answer(&json!({ "collection": "notes", "limit": 5 }), &rpc, &env, 0).unwrap();
        assert_eq!(out["counts"]["docs"], 1);
        assert_eq!(out["scheduled"], false);
        let cron = answer(&json!({ "collection": "notes", "limit": 5, "run": "schedule" }), &rpc, &env, 0).unwrap();
        assert_eq!(cron["scheduled"], true);
        let none = |_: &str| None;
        assert!(answer(&json!({}), &rpc, &none, 0).is_err());
    }
}
