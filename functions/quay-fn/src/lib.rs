//! Guest helpers for Quay functions on OutLayer.
//!
//! A function is a `wasm32-wasip2` command: it reads its input JSON on stdin,
//! writes its output JSON on stdout, and gets secrets as environment variables.
//!
//! ```ignore
//! fn main() {
//!     quay_fn::run(|input| {
//!         let url = input["url"].as_str().ok_or("pass a url")?;
//!         Ok(quay_fn::preview::link_preview(url)?.to_json())
//!     });
//! }
//! ```

pub mod borsh;
pub mod encoding;
pub mod html;
pub mod http;
pub mod preview;
pub mod rpc;
#[cfg(feature = "ed25519")]
pub mod signin;

pub use serde_json::{json, Value};

use std::io::{Read, Write};

/// The input JSON from stdin. Empty or invalid input is `null`.
pub fn input() -> Value {
    let mut text = String::new();
    let _ = std::io::stdin().read_to_string(&mut text);
    parse_input(&text)
}

/// Parse input text the way [`input`] does. Some hosts wrap the input as a
/// JSON string holding JSON text; that is unwrapped once.
pub fn parse_input(text: &str) -> Value {
    let value: Value = serde_json::from_str(text.trim()).unwrap_or(Value::Null);
    if let Value::String(inner) = &value {
        if let Ok(parsed) = serde_json::from_str::<Value>(inner) {
            if parsed.is_object() {
                return parsed;
            }
        }
    }
    value
}

/// Write one JSON value to stdout.
pub fn output(value: &Value) {
    let mut out = std::io::stdout();
    let _ = out.write_all(value.to_string().as_bytes());
    let _ = out.flush();
}

/// Read the input, run `f`, and write its output. An `Err(reason)` becomes
/// `{"error": reason}` so the caller always gets JSON back.
pub fn run<F>(f: F)
where
    F: FnOnce(Value) -> Result<Value, String>,
{
    let value = match f(input()) {
        Ok(v) => v,
        Err(reason) => json!({ "error": reason }),
    };
    output(&value);
}

/// A secret set with `quay secrets set NAME`. `None` when unset or empty.
/// Never put the value in the output: hash it with [`encoding::sha256_hex`]
/// when you need to show that it arrived.
pub fn secret(name: &str) -> Option<String> {
    env(name)
}

/// A non-empty environment variable (OutLayer sets `NEAR_SENDER_ID`,
/// `OUTLAYER_PROJECT_OWNER`, `OUTLAYER_EXECUTION_TYPE`, and others).
pub fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// The site account: the project owner when run through a project.
pub fn site() -> Option<String> {
    env("OUTLAYER_PROJECT_OWNER")
}

/// Current time in milliseconds since the epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Cut a string to at most `max` characters, on a char boundary.
pub fn clip(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((i, _)) => text[..i].to_string(),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_input_handles_objects_strings_and_garbage() {
        assert_eq!(parse_input(r#"{"a":1}"#), json!({"a":1}));
        assert_eq!(parse_input(r#""{\"a\":1}""#), json!({"a":1}));
        assert_eq!(parse_input("not json"), Value::Null);
        assert_eq!(parse_input(""), Value::Null);
        assert_eq!(parse_input(r#""plain""#), json!("plain"));
    }

    #[test]
    fn clip_respects_char_boundaries() {
        assert_eq!(clip("héllo", 2), "hé");
        assert_eq!(clip("hi", 10), "hi");
    }
}
