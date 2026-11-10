//! `moderate`: an `on_add` trigger for a community board.
//!
//! Input `{collection, id, owner, data}`. Output (at most ~2 KB):
//! `{"hide": bool, "reason": "…", "preview": {url,title,description,image} | null,
//!   "auth": "ok" | "none" | "error", "key_sha256_prefix": "…" | null}`
//!
//! - Local rules decide first: length, link spam, repeated characters, a small blocklist
//!   (plus the optional `MOD_BLOCKLIST` secret, comma-separated).
//! - Secret proof: with `MOD_API_KEY` set and `MOD_API_URL` unset, it calls the
//!   authenticated echo API `https://httpbin.org/bearer` with the key as a bearer
//!   token and reports `auth: "ok"` plus a sha256 prefix of the key, never the key.
//!   The demo proves the secret round-trip with an echo API; a real moderation API
//!   is one secret away: set `MOD_API_URL` to an OpenAI-compatible `/moderations`
//!   endpoint and the text is posted there with the same key.
//! - When `data.link` (or `data.url`) is an https URL, a link preview is attached so
//!   post pages can render it server-side.
use quay_fn::encoding::sha256_hex;
use quay_fn::http::{self, Options};
use quay_fn::preview::{self, Preview};
use quay_fn::{clip, json, Value};

const MAX_TEXT_CHARS: usize = 2000;
const MAX_LINKS: usize = 3;
const MAX_REPEAT: usize = 20;
const BLOCKLIST: &[&str] = &["viagra", "casino bonus", "free money", "crypto giveaway", "double your", "seed phrase"];
const ECHO_API: &str = "https://httpbin.org/bearer";
const PREVIEW_BUDGET: usize = 1500;

#[derive(Debug, PartialEq, Eq)]
pub struct Verdict {
    pub hide: bool,
    pub reason: String,
}

fn verdict(hide: bool, reason: impl Into<String>) -> Verdict {
    Verdict { hide, reason: reason.into() }
}

/// `data` as an object (the contract may pass the JSON text or the parsed object).
pub fn data_of(input: &Value) -> Value {
    match input.get("data") {
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        None => Value::Null,
    }
}

/// Every top-level string of the doc except the link fields, joined by newlines.
pub fn text_of(data: &Value) -> String {
    data.as_object()
        .map(|o| {
            o.iter()
                .filter(|(k, _)| k.as_str() != "link" && k.as_str() != "url")
                .filter_map(|(_, v)| v.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

pub fn count_links(text: &str) -> usize {
    let lower = text.to_ascii_lowercase();
    lower.matches("http://").count() + lower.matches("https://").count() + lower.matches("www.").count()
}

fn longest_run(text: &str) -> usize {
    let mut best = 0;
    let mut run = 0;
    let mut prev = None;
    for c in text.chars() {
        if Some(c) == prev && !c.is_whitespace() {
            run += 1;
        } else {
            run = 1;
            prev = Some(c);
        }
        best = best.max(run);
    }
    best
}

/// The local rules. `extra` are owner-supplied blocked words.
pub fn local_rules(text: &str, extra: &[String]) -> Verdict {
    let chars = text.chars().count();
    if chars > MAX_TEXT_CHARS {
        return verdict(true, format!("too long: {chars} characters, the limit is {MAX_TEXT_CHARS}"));
    }
    let links = count_links(text);
    if links > MAX_LINKS {
        return verdict(true, format!("link spam: {links} links, the limit is {MAX_LINKS}"));
    }
    if longest_run(text) >= MAX_REPEAT {
        return verdict(true, "repeated characters");
    }
    let lower = text.to_lowercase();
    let blocked = BLOCKLIST
        .iter()
        .map(|w| w.to_string())
        .chain(extra.iter().map(|w| w.trim().to_lowercase()))
        .find(|w| !w.is_empty() && lower.contains(w.as_str()));
    if let Some(word) = blocked {
        return verdict(true, format!("blocked word: {word}"));
    }
    verdict(false, "ok")
}

/// The https link to preview, if the doc has one.
pub fn link_of(data: &Value) -> Option<String> {
    ["link", "url"]
        .iter()
        .filter_map(|k| data.get(*k).and_then(Value::as_str))
        .find(|u| preview::check_url(u).is_ok())
        .map(String::from)
}

/// Read an OpenAI-compatible moderation answer: `{results: [{flagged, categories}]}`.
pub fn read_moderation(body: &Value) -> Option<Verdict> {
    let r = body.get("results")?.get(0)?;
    let flagged = r.get("flagged")?.as_bool()?;
    if !flagged {
        return Some(verdict(false, "ok"));
    }
    let cats: Vec<&str> = r
        .get("categories")
        .and_then(Value::as_object)
        .map(|o| o.iter().filter(|(_, v)| v.as_bool() == Some(true)).map(|(k, _)| k.as_str()).collect())
        .unwrap_or_default();
    let why = if cats.is_empty() { "flagged".to_string() } else { cats.join(", ") };
    Some(verdict(true, clip(&format!("moderation API: {why}"), 200)))
}

/// Did httpbin's bearer echo authenticate with this exact key?
pub fn echo_authenticated(status: u16, body: &Value, key: &str) -> bool {
    status == 200
        && body.get("authenticated").and_then(Value::as_bool) == Some(true)
        && body.get("token").and_then(Value::as_str) == Some(key)
}

fn bearer(key: &str) -> String {
    format!("Bearer {key}")
}

/// Use the key; return (auth, an optional verdict from a real moderation API).
fn call_with_key(key: &str, url: Option<&str>, text: &str, skip_moderation: bool) -> (&'static str, Option<Verdict>) {
    let opts = Options { timeout_ms: 8_000, max_bytes: 64 * 1024 };
    let auth = bearer(key);
    match url {
        None => match http::send("GET", ECHO_API, &[("authorization", &auth)], None, &opts) {
            Ok(res) => {
                let body = res.json().unwrap_or(Value::Null);
                (if echo_authenticated(res.status, &body, key) { "ok" } else { "error" }, None)
            }
            Err(_) => ("error", None),
        },
        Some(_) if skip_moderation => ("ok", None),
        Some(url) => {
            let mut req = json!({ "input": text });
            if let Some(model) = quay_fn::env("MOD_MODEL") {
                req["model"] = json!(model);
            }
            let body = req.to_string();
            match http::send(
                "POST",
                url,
                &[("authorization", &auth), ("content-type", "application/json")],
                Some(body.as_bytes()),
                &opts,
            ) {
                Ok(res) if res.ok() => ("ok", res.json().ok().as_ref().and_then(read_moderation)),
                _ => ("error", None),
            }
        }
    }
}

pub fn shape(v: &Verdict, preview: Option<Preview>, auth: &str, key: Option<&str>) -> Value {
    json!({
        "hide": v.hide,
        "reason": clip(&v.reason, 200),
        "preview": preview.map(|p| preview::fit_within(p, PREVIEW_BUDGET).to_json()),
        "auth": auth,
        "key_sha256_prefix": key.map(|k| sha256_hex(k.as_bytes())[..12].to_string()),
    })
}

fn answer(input: &Value) -> Result<Value, String> {
    let data = data_of(input);
    if !data.is_object() {
        return Err("pass {collection, id, owner, data} with data as a JSON object".into());
    }
    let text = text_of(&data);
    let extra: Vec<String> = quay_fn::secret("MOD_BLOCKLIST")
        .map(|s| s.split(',').map(String::from).collect())
        .unwrap_or_default();
    let mut v = local_rules(&text, &extra);
    let key = quay_fn::secret("MOD_API_KEY");
    let auth = match &key {
        None => "none",
        Some(k) => {
            let url = quay_fn::secret("MOD_API_URL");
            let (auth, remote) = call_with_key(k, url.as_deref(), &text, v.hide);
            if let Some(r) = remote {
                if r.hide {
                    v = r;
                }
            }
            auth
        }
    };
    let preview = if v.hide { None } else { link_of(&data).and_then(|u| preview::link_preview(&u).ok()) };
    Ok(shape(&v, preview, auth, key.as_deref()))
}

fn main() {
    quay_fn::run(|input| answer(&input));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_rules_decide() {
        assert_eq!(local_rules("A harbour at dawn", &[]), verdict(false, "ok"));
        assert!(local_rules(&"x ".repeat(1500), &[]).reason.starts_with("too long"));
        let spam = "see https://a.com https://b.com http://c.com www.d.com";
        assert_eq!(local_rules(spam, &[]).reason, "link spam: 4 links, the limit is 3");
        assert_eq!(local_rules("Win FREE MONEY now", &[]).reason, "blocked word: free money");
        assert_eq!(local_rules("buy turnips", &["Turnips".into()]).reason, "blocked word: turnips");
        assert_eq!(local_rules("aaaaaaaaaaaaaaaaaaaaaaaa", &[]).reason, "repeated characters");
    }

    #[test]
    fn reads_doc_data_in_both_forms() {
        let as_text = json!({ "collection": "posts", "id": "1", "owner": "a", "data": "{\"title\":\"hi\",\"link\":\"https://x.com\"}" });
        let as_obj = json!({ "data": { "title": "hi", "link": "https://x.com" } });
        assert_eq!(data_of(&as_text), data_of(&as_obj));
        assert_eq!(text_of(&data_of(&as_obj)), "hi");
        assert_eq!(link_of(&data_of(&as_obj)).as_deref(), Some("https://x.com"));
        assert_eq!(link_of(&json!({ "link": "http://x.com" })), None);
        assert_eq!(link_of(&json!({ "link": "javascript:alert(1)" })), None);
        assert!(answer(&json!({ "data": 5 })).is_err());
    }

    #[test]
    fn checks_the_echo_without_returning_the_key() {
        let key = "tok-123456789";
        assert!(echo_authenticated(200, &json!({ "authenticated": true, "token": key }), key));
        assert!(!echo_authenticated(200, &json!({ "authenticated": true, "token": "other" }), key));
        assert!(!echo_authenticated(401, &json!({}), key));
        let out = shape(&verdict(false, "ok"), None, "ok", Some(key));
        assert!(!out.to_string().contains(key));
        assert_eq!(out["key_sha256_prefix"].as_str().unwrap().len(), 12);
        assert_eq!(out["preview"], Value::Null);
        assert_eq!(shape(&verdict(false, "ok"), None, "none", None)["key_sha256_prefix"], Value::Null);
    }

    #[test]
    fn reads_openai_moderation_answers() {
        let flagged = json!({ "results": [{ "flagged": true, "categories": { "harassment": true, "violence": false } }] });
        assert_eq!(read_moderation(&flagged), Some(verdict(true, "moderation API: harassment")));
        assert_eq!(read_moderation(&json!({ "results": [{ "flagged": false }] })), Some(verdict(false, "ok")));
        assert_eq!(read_moderation(&json!({})), None);
    }

    #[test]
    fn output_stays_small() {
        let big = Preview {
            url: format!("https://a.example/{}", "p".repeat(500)),
            title: Some("t".repeat(160)),
            description: Some("d ".repeat(200)),
            image: Some(format!("https://a.example/{}.png", "i".repeat(500))),
        };
        let out = shape(&verdict(false, "x".repeat(500)), Some(big), "ok", Some("k"));
        assert!(out.to_string().len() <= 2048, "{}", out.to_string().len());
        assert!(out["preview"]["url"].as_str().unwrap().starts_with("https://"));
    }
}
