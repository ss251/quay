//! Quay: immutable releases, one production pointer, served by `web4_get`.
//!
//! A function-call key may call `put_chunk` and `seal`. `promote` and `buy`
//! require an attached deposit, which that key cannot send. A full-access key
//! can still replace this Wasm. Releases are not owner-proof.

use near_sdk::json_types::Base64VecU8;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, AccountId, PanicOnDefault};

const MAX_CHUNK_BYTES: u64 = 200_000;
const MAX_STORED_BYTES: u64 = 800_000;
const MAX_FILE_BYTES: usize = 400_000;
const MAX_FILES: usize = 16;
const MAX_SALES: u32 = 128;
const INDEX_PATH: &str = "index.html";
/// 0.01 NEAR. Covers the sale record and leaves the storage lock funded.
const MIN_BUY_YOCTO: u128 = 10_000_000_000_000_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct StoredFile {
    pub path: String,
    pub chunks: Vec<String>,
    pub sha256: String,
    pub content_type: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Release {
    pub sha256: String,
    pub files: Vec<StoredFile>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Sale {
    pub buyer: AccountId,
    pub yocto: String,
    pub memo: Option<String>,
}

#[near(serializers = [json])]
pub struct FileIn {
    pub path: String,
    pub chunks: Vec<String>,
    pub content_type: String,
}

#[near(serializers = [json])]
pub struct Budget {
    pub stored_bytes: u64,
    pub max_bytes: u64,
    pub chunk_bytes: u64,
}

#[derive(Clone, near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde", rename_all = "camelCase", default)]
pub struct Web4Request {
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub query: near_sdk::serde_json::Map<String, near_sdk::serde_json::Value>,
}

impl Default for Web4Request {
    fn default() -> Self {
        Self {
            account_id: None,
            path: String::new(),
            query: near_sdk::serde_json::Map::new(),
        }
    }
}

#[derive(near_sdk::serde::Serialize, near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde", rename_all = "camelCase")]
pub struct Web4Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<Base64VecU8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preload_urls: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    chunks: LookupMap<String, Vec<u8>>,
    releases: LookupMap<String, Release>,
    production: Option<String>,
    stored_bytes: u64,
    sales: Vector<Sale>,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
            chunks: LookupMap::new(b"c"),
            releases: LookupMap::new(b"r"),
            production: None,
            stored_bytes: 0,
            sales: Vector::new(b"s"),
        }
    }

    /// Store one content-addressed chunk. An existing hash is not written again.
    pub fn put_chunk(&mut self, sha256: String, data: Base64VecU8) {
        let sha256 = normalize_sha256(&sha256);
        let bytes = data.0;
        let len = bytes.len() as u64;
        if len == 0 || len > MAX_CHUNK_BYTES {
            env::panic_str("chunk must be 1 to 200000 bytes");
        }
        let actual = hex_encode(&env::sha256(&bytes));
        if actual != sha256 {
            env::panic_str("chunk hash mismatch");
        }
        if self.chunks.contains_key(&sha256) {
            return;
        }
        let next = self
            .stored_bytes
            .checked_add(len)
            .unwrap_or_else(|| env::panic_str("storage budget exceeded"));
        if next > MAX_STORED_BYTES {
            env::panic_str("storage budget exceeded");
        }
        self.chunks.insert(sha256, bytes);
        self.stored_bytes = next;
    }

    /// Seal a release. The same id cannot be sealed again.
    pub fn seal(&mut self, id: String, files: Vec<FileIn>) {
        let id = check_id(&id);
        if self.releases.contains_key(&id) {
            env::panic_str("release already sealed");
        }
        if files.is_empty() || files.len() > MAX_FILES {
            env::panic_str("release needs 1 to 16 files");
        }
        let mut stored = Vec::with_capacity(files.len());
        let mut seen_paths = Vec::with_capacity(files.len());
        let mut index_sha = None;
        for file in files {
            let path = check_path(&file.path);
            if seen_paths.iter().any(|p| p == &path) {
                env::panic_str("duplicate path");
            }
            seen_paths.push(path.clone());
            let content_type = check_content_type(&file.content_type);
            if file.chunks.is_empty() {
                env::panic_str("file needs a chunk");
            }
            let mut assembled = Vec::new();
            let mut hashes = Vec::with_capacity(file.chunks.len());
            for hash in file.chunks {
                let hash = normalize_sha256(&hash);
                let chunk = self
                    .chunks
                    .get(&hash)
                    .unwrap_or_else(|| env::panic_str("chunk missing"));
                if assembled.len() + chunk.len() > MAX_FILE_BYTES {
                    env::panic_str("file too large");
                }
                assembled.extend_from_slice(chunk);
                hashes.push(hash);
            }
            let sha256 = hex_encode(&env::sha256(&assembled));
            if path == INDEX_PATH {
                index_sha = Some(sha256.clone());
            }
            stored.push(StoredFile {
                path,
                chunks: hashes,
                sha256,
                content_type,
            });
        }
        let sha256 = index_sha.unwrap_or_else(|| env::panic_str("index.html required"));
        let release = Release {
            sha256: sha256.clone(),
            files: stored,
        };
        self.releases.insert(id.clone(), release);
        emit(
            "release_sealed",
            &near_sdk::serde_json::json!({ "id": id, "sha256": sha256 }),
        );
    }

    /// Point production at a sealed release.
    ///
    /// Requires exactly 1 yoctoNEAR. A function-call key cannot attach NEAR,
    /// so a publish-only key cannot promote.
    #[payable]
    pub fn promote(&mut self, id: String) {
        near_sdk::assert_one_yocto();
        let id = check_id(&id);
        if !self.releases.contains_key(&id) {
            env::panic_str("release missing");
        }
        self.production = Some(id.clone());
        emit(
            "promoted",
            &near_sdk::serde_json::json!({ "id": id }),
        );
    }

    /// Accept testnet NEAR into this account and record the buyer.
    #[payable]
    pub fn buy(&mut self, memo: Option<String>) {
        let deposit = env::attached_deposit();
        if deposit.as_yoctonear() < MIN_BUY_YOCTO {
            env::panic_str("buy needs at least 0.01 NEAR");
        }
        if self.sales.len() >= MAX_SALES {
            env::panic_str("sale log is full");
        }
        let memo = match memo {
            Some(memo) if memo.len() > 140 => env::panic_str("memo too long"),
            Some(memo) if memo.is_empty() => None,
            other => other,
        };
        self.sales.push(Sale {
            buyer: env::predecessor_account_id(),
            yocto: deposit.as_yoctonear().to_string(),
            memo,
        });
        emit(
            "purchased",
            &near_sdk::serde_json::json!({
                "buyer": env::predecessor_account_id(),
                "yocto": deposit.as_yoctonear().to_string(),
            }),
        );
    }

    pub fn web4_get(&self, request: Web4Request) -> Web4Response {
        match route(&request.path) {
            Routed::Production => match &self.production {
                Some(id) => self.serve(id, INDEX_PATH, false),
                None => text_response(404, "no production release"),
            },
            Routed::Release { id, path } => self.serve(&id, &path, true),
            Routed::Missing => text_response(404, "not found"),
        }
    }

    pub fn get_production(&self) -> Option<String> {
        self.production.clone()
    }

    pub fn get_release(&self, id: String) -> Option<Release> {
        self.releases.get(&id).cloned()
    }

    pub fn get_sales(&self) -> Vec<Sale> {
        let mut out = Vec::with_capacity(self.sales.len() as usize);
        for i in 0..self.sales.len() {
            if let Some(sale) = self.sales.get(i) {
                out.push(sale.clone());
            }
        }
        out
    }

    pub fn get_budget(&self) -> Budget {
        Budget {
            stored_bytes: self.stored_bytes,
            max_bytes: MAX_STORED_BYTES,
            chunk_bytes: MAX_CHUNK_BYTES,
        }
    }

    pub fn has_chunk(&self, sha256: String) -> bool {
        let sha256 = normalize_sha256(&sha256);
        self.chunks.contains_key(&sha256)
    }
}

impl Contract {
    fn serve(&self, id: &str, path: &str, immutable: bool) -> Web4Response {
        let Some(release) = self.releases.get(id) else {
            return text_response(404, "release missing");
        };
        let Some(file) = release.files.iter().find(|file| file.path == path) else {
            return text_response(404, "file missing");
        };
        let mut body = Vec::new();
        for hash in &file.chunks {
            let Some(chunk) = self.chunks.get(hash) else {
                return text_response(500, "chunk missing");
            };
            body.extend_from_slice(chunk);
        }
        // Production must not sit in the gateway's default one-minute HTML cache.
        let cache = if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "public, max-age=0, must-revalidate"
        };
        Web4Response {
            content_type: Some(file.content_type.clone()),
            status: Some(200),
            body: Some(body.into()),
            body_url: None,
            preload_urls: None,
            cache_control: Some(cache.to_string()),
        }
    }
}

enum Routed {
    Production,
    Release { id: String, path: String },
    Missing,
}

fn route(raw: &str) -> Routed {
    let path = raw.split('?').next().unwrap_or("");
    if path.contains("..") || path.contains('\\') {
        return Routed::Missing;
    }
    let path = if path.is_empty() { "/" } else { path };
    if path == "/" || path == "/index.html" {
        return Routed::Production;
    }
    let mut parts = path.trim_start_matches('/').split('/');
    if parts.next() != Some("r") {
        return Routed::Missing;
    }
    let Some(id) = parts.next() else {
        return Routed::Missing;
    };
    if check_id_ok(id).is_none() {
        return Routed::Missing;
    }
    let rest: Vec<&str> = parts.collect();
    let file = if rest.is_empty() || rest == [""] || rest == ["index.html"] {
        INDEX_PATH.to_string()
    } else if rest.iter().any(|part| part.is_empty()) {
        return Routed::Missing;
    } else {
        rest.join("/")
    };
    Routed::Release {
        id: id.to_string(),
        path: file,
    }
}

fn emit(event: &str, data: &near_sdk::serde_json::Value) {
    let line = near_sdk::serde_json::json!({
        "standard": "quay",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{line}"));
}

fn text_response(status: u32, message: &str) -> Web4Response {
    let html = format!("<!doctype html><title>quay</title><p>{message}</p>");
    Web4Response {
        content_type: Some("text/html; charset=utf-8".to_string()),
        status: Some(status),
        body: Some(html.into_bytes().into()),
        body_url: None,
        preload_urls: None,
        cache_control: Some("public, max-age=0, must-revalidate".to_string()),
    }
}

fn check_id(id: &str) -> String {
    check_id_ok(id).unwrap_or_else(|| env::panic_str("bad release id"))
}

fn check_id_ok(id: &str) -> Option<String> {
    if id.is_empty() || id.len() > 64 {
        return None;
    }
    if id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
    {
        Some(id.to_string())
    } else {
        None
    }
}

fn check_path(path: &str) -> String {
    if path.is_empty()
        || path.len() > 128
        || path.starts_with('/')
        || path.contains("..")
        || path.contains('\\')
        || path.contains("//")
    {
        env::panic_str("bad path");
    }
    if path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
    {
        path.to_string()
    } else {
        env::panic_str("bad path")
    }
}

fn check_content_type(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 || value.bytes().any(|b| b < 0x20 || b > 0x7e) {
        env::panic_str("bad content type");
    }
    value.to_string()
}

fn normalize_sha256(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        env::panic_str("bad sha256");
    }
    value
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, AccountId, Gas, NearToken};
    use sha2::{Digest, Sha256};

    fn sha256_hex(bytes: &[u8]) -> String {
        hex_encode(&Sha256::digest(bytes))
    }

    fn set_ctx(deposit_yocto: u128) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("quay-bb.testnet".parse().unwrap())
            .signer_account_id("quay-bb.testnet".parse().unwrap())
            .predecessor_account_id("buyer.testnet".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
            .prepaid_gas(Gas::from_tgas(300));
        testing_env!(builder.build());
    }

    fn file_in(bytes: &[u8]) -> (String, FileIn) {
        let hash = sha256_hex(bytes);
        (
            hash.clone(),
            FileIn {
                path: INDEX_PATH.to_string(),
                chunks: vec![hash],
                content_type: "text/html; charset=utf-8".to_string(),
            },
        )
    }

    fn seal_html(contract: &mut Contract, id: &str, html: &[u8]) {
        let (hash, file) = file_in(html);
        contract.put_chunk(hash, html.to_vec().into());
        contract.seal(id.to_string(), vec![file]);
    }

    #[test]
    fn sealed_release_bytes_stick() {
        set_ctx(0);
        let mut contract = Contract::new();
        let html = b"<p>release 1</p>";
        seal_html(&mut contract, "1", html);

        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let (_hash, file) = file_in(b"<p>rewritten</p>");
            // The rewrite is a different id's file list on the same id.
            contract.seal("1".to_string(), vec![file]);
        }));
        assert!(again.is_err());

        let release = contract.get_release("1".to_string()).expect("sealed");
        assert_eq!(release.sha256, sha256_hex(html));
        let response = contract.web4_get(Web4Request {
            account_id: None,
            path: "/r/1".to_string(),
            query: Default::default(),
        });
        assert_eq!(response.status, Some(200));
        assert_eq!(response.body.expect("body").0, html);
        assert_eq!(
            response.cache_control.as_deref(),
            Some("public, max-age=31536000, immutable")
        );
    }

    #[test]
    #[should_panic(expected = "yoctoNEAR")]
    fn publish_key_cannot_promote() {
        set_ctx(0);
        let mut contract = Contract::new();
        seal_html(&mut contract, "1", b"<p>release 1</p>");
        contract.promote("1".to_string());
    }

    #[test]
    fn promote_serves_production_and_keeps_the_old_release() {
        set_ctx(1);
        let mut contract = Contract::new();
        seal_html(&mut contract, "1", b"<p>release 1</p>");
        seal_html(&mut contract, "2", b"<p>production: release 2</p>");
        contract.promote("2".to_string());
        assert_eq!(contract.get_production().as_deref(), Some("2"));

        let production = contract.web4_get(Web4Request {
            account_id: None,
            path: "/".to_string(),
            query: Default::default(),
        });
        assert_eq!(
            production.body.expect("body").0,
            b"<p>production: release 2</p>"
        );
        assert_eq!(
            production.cache_control.as_deref(),
            Some("public, max-age=0, must-revalidate")
        );

        let first = contract.web4_get(Web4Request {
            account_id: None,
            path: "/r/1".to_string(),
            query: Default::default(),
        });
        assert_eq!(first.body.expect("body").0, b"<p>release 1</p>");

        contract.promote("1".to_string());
        let rolled = contract.web4_get(Web4Request {
            account_id: None,
            path: "/".to_string(),
            query: Default::default(),
        });
        assert_eq!(rolled.body.expect("body").0, b"<p>release 1</p>");
        assert_eq!(contract.get_production().as_deref(), Some("1"));
    }

    #[test]
    fn reuses_an_unchanged_chunk() {
        set_ctx(0);
        let mut contract = Contract::new();
        let html = b"<p>same</p>";
        let hash = sha256_hex(html);
        contract.put_chunk(hash.clone(), html.to_vec().into());
        let used = contract.get_budget().stored_bytes;
        contract.put_chunk(hash, html.to_vec().into());
        assert_eq!(contract.get_budget().stored_bytes, used);
    }

    #[test]
    #[should_panic(expected = "chunk hash mismatch")]
    fn rejects_a_lying_hash() {
        set_ctx(0);
        let mut contract = Contract::new();
        contract.put_chunk("ab".repeat(32), b"nope".to_vec().into());
    }

    #[test]
    fn buy_records_the_predecessor() {
        set_ctx(MIN_BUY_YOCTO);
        let mut contract = Contract::new();
        contract.buy(Some("hello".to_string()));
        let sales = contract.get_sales();
        assert_eq!(sales.len(), 1);
        assert_eq!(sales[0].buyer, "buyer.testnet".parse::<AccountId>().unwrap());
        assert_eq!(sales[0].yocto, MIN_BUY_YOCTO.to_string());
        assert_eq!(sales[0].memo.as_deref(), Some("hello"));
    }
}
