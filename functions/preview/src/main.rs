//! `preview`: a link preview. Input `{"url": "https://…"}`, output
//! `{"url","title","description","image"}` (https only, at most 2 KB).
//! The page is fetched with an 8 s timeout and read up to 256 KB.
use quay_fn::{preview, Value};

fn answer(input: &Value) -> Result<Value, String> {
    let url = input
        .get("url")
        .and_then(Value::as_str)
        .ok_or("pass {\"url\": \"https://…\"}")?;
    Ok(preview::link_preview(url)?.to_json())
}

fn main() {
    quay_fn::run(|input| answer(&input));
}

#[cfg(test)]
mod tests {
    use super::*;
    use quay_fn::json;

    #[test]
    fn needs_an_https_url() {
        assert!(answer(&json!({})).unwrap_err().contains("pass"));
        assert!(answer(&json!({ "url": "http://example.com" })).unwrap_err().contains("https"));
        assert!(answer(&json!({ "url": "https://10.0.0.1/" })).unwrap_err().contains("not allowed"));
    }
}
