//! NEAR JSON-RPC over HTTPS.
use crate::encoding::{b64, b64_decode};
use crate::http;
use crate::{json, Value};

pub const DEFAULT_RPC: &str = "https://test.rpc.fastnear.com";

type Transport = Box<dyn Fn(&Value) -> Result<Value, String>>;

/// A JSON-RPC endpoint. `Rpc::new(url)` posts over `wasi:http`; tests use
/// `Rpc::with_transport` to answer requests themselves.
pub struct Rpc {
    pub url: String,
    transport: Option<Transport>,
}

impl Rpc {
    pub fn new(url: &str) -> Self {
        Self { url: url.to_string(), transport: None }
    }

    pub fn testnet() -> Self {
        Self::new(DEFAULT_RPC)
    }

    /// `f` gets the whole JSON-RPC request and returns the whole response body.
    pub fn with_transport<F: Fn(&Value) -> Result<Value, String> + 'static>(f: F) -> Self {
        Self { url: "test:".into(), transport: Some(Box::new(f)) }
    }

    /// Call a JSON-RPC method and return its `result`.
    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let req = json!({ "jsonrpc": "2.0", "id": "quay", "method": method, "params": params });
        let body = match &self.transport {
            Some(f) => f(&req)?,
            None => http::post_json(&self.url, &[], &req)?,
        };
        if let Some(err) = body.get("error") {
            let name = err
                .pointer("/cause/name")
                .and_then(Value::as_str)
                .or_else(|| err.get("name").and_then(Value::as_str))
                .unwrap_or("error");
            let info = err
                .pointer("/data")
                .map(|d| d.to_string())
                .unwrap_or_default();
            return Err(format!("rpc {method}: {name} {}", crate::clip(&info, 300)).trim().to_string());
        }
        body.get("result").cloned().ok_or_else(|| format!("rpc {method}: no result"))
    }

    /// Call a view method; `args` is JSON, the answer is parsed JSON (`null` for empty).
    pub fn view(&self, account: &str, method: &str, args: &Value) -> Result<Value, String> {
        let result = self.call(
            "query",
            json!({
                "request_type": "call_function",
                "finality": "optimistic",
                "account_id": account,
                "method_name": method,
                "args_base64": b64(args.to_string().as_bytes()),
            }),
        )?;
        decode_view(&result).map_err(|e| format!("{method}: {e}"))
    }

    /// The access key view, or `None` when the key is not on the account.
    pub fn access_key(&self, account: &str, public_key: &str) -> Result<Option<Value>, String> {
        let res = self.call(
            "query",
            json!({
                "request_type": "view_access_key",
                "finality": "final",
                "account_id": account,
                "public_key": public_key,
            }),
        );
        match res {
            Ok(v) => match v.get("error").and_then(Value::as_str) {
                Some(e) if e.contains("does not exist") => Ok(None),
                Some(e) => Err(format!("view_access_key: {e}")),
                None => Ok(Some(v)),
            },
            Err(e) if e.contains("UNKNOWN_ACCESS_KEY") || e.contains("UNKNOWN_ACCOUNT") => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn view_account(&self, account: &str) -> Result<Value, String> {
        self.call(
            "query",
            json!({ "request_type": "view_account", "finality": "final", "account_id": account }),
        )
    }

    /// The final block header (`height`, `hash`, `timestamp`).
    pub fn final_block(&self) -> Result<Value, String> {
        let block = self.call("block", json!({ "finality": "final" }))?;
        block.get("header").cloned().ok_or_else(|| "block has no header".into())
    }
}

/// Parse a `call_function` result: `{ result: [bytes] }` or `{ error }`.
pub fn decode_view(result: &Value) -> Result<Value, String> {
    if let Some(e) = result.get("error").and_then(Value::as_str) {
        return Err(crate::clip(e, 300));
    }
    let bytes: Vec<u8> = match result.get("result") {
        Some(Value::Array(items)) => items.iter().map(|v| v.as_u64().unwrap_or(0) as u8).collect(),
        Some(Value::String(s)) => b64_decode(s)?,
        _ => return Err("view result has no bytes".into()),
    };
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes).map_err(|_| "view result is not JSON".into())
}

/// NEAR permission views are the string `"FullAccess"` or `{ "FunctionCall": … }`.
pub fn is_full_access(key: &Value) -> bool {
    key.get("permission").and_then(Value::as_str) == Some("FullAccess")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_view_results() {
        let bytes: Vec<Value> = br#"{"a":1}"#.iter().map(|b| json!(b)).collect();
        assert_eq!(decode_view(&json!({ "result": bytes })).unwrap(), json!({"a":1}));
        assert_eq!(decode_view(&json!({ "result": [] })).unwrap(), Value::Null);
        assert!(decode_view(&json!({ "error": "wasm execution failed" })).is_err());
    }

    #[test]
    fn view_goes_through_transport() {
        let rpc = Rpc::with_transport(|req| {
            assert_eq!(req["method"], "query");
            assert_eq!(req["params"]["method_name"], "db_list");
            let bytes: Vec<Value> = b"[1,2]".iter().map(|b| json!(b)).collect();
            Ok(json!({ "result": { "result": bytes } }))
        });
        assert_eq!(rpc.view("s.testnet", "db_list", &json!({})).unwrap(), json!([1, 2]));
    }

    #[test]
    fn missing_keys_are_none() {
        let rpc = Rpc::with_transport(|_| {
            Ok(json!({ "error": { "name": "HANDLER_ERROR", "cause": { "name": "UNKNOWN_ACCESS_KEY" } } }))
        });
        assert_eq!(rpc.access_key("a.testnet", "ed25519:x").unwrap(), None);
        let rpc = Rpc::with_transport(|_| Ok(json!({ "result": { "nonce": 5, "permission": "FullAccess" } })));
        assert!(is_full_access(&rpc.access_key("a.testnet", "ed25519:x").unwrap().unwrap()));
    }
}
