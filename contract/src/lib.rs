//! Quay stores sealed site releases and serves them with `web4_get`.
//!
//! `put_chunk` and `seal` accept only this account, and only with no deposit.
//! `promote`, `rollback`, and `delete` accept only this account and require
//! exactly 1 yoctoNEAR. A function-call key cannot attach NEAR, so a key whose
//! method list is `publish_methods` cannot move or remove production.
//! A full-access key can still replace this Wasm. Releases are not owner-proof.
//!
//! Version 3 adds live data (`db.rs`), members (`members.rs`), routes and
//! templates (`routes.rs`, `template.rs`), off-chain file references, and
//! payments (`pay.rs`). Each lives in its own storage next to the v2 data.
//!
//! The JSON method list is `docs/contract-interface.md` (v2) and
//! `docs/fullstack-interface.md` (v3).

mod coll;
mod cron;
mod db;
pub mod exports;
mod functions;
mod json_in;
mod legacy;
mod members;
mod pay;
mod routes;
mod template;
#[cfg(test)]
mod tests_fn;
#[cfg(test)]
mod tests_v3;
mod types;

use legacy::{scan_ids, LegacyState, StateV2};
use near_sdk::borsh::BorshDeserialize;
use near_sdk::json_types::{Base64VecU8, U64};
use crate::coll::{Map, Seq};
use near_sdk::{env, near, require, NearToken, PanicOnDefault};
use routes::{check_routes, FileLoader, RouteIn};
use types::*;

const CACHE_IMMUTABLE: &str = "public, max-age=31536000, immutable";
pub(crate) const CACHE_FRESH: &str = "public, max-age=0, must-revalidate";
const MAX_CID_BYTES: usize = 128;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    chunks: Map<String, Vec<u8>>,
    releases: Map<String, Release>,
    production: Option<String>,
    stored_bytes: u64,
    sales: Seq<Sale>,
    release_ids: Seq<String>,
    history: Seq<Promotion>,
    previous: Option<String>,
    chunk_refs: Map<String, u32>,
    version: u32,
    // v3 below. v2 state is the fields above, so `migrate` appends these.
    routes: Map<String, Vec<RouteIn>>,
    externals: Map<String, Vec<ExternalFile>>,
    db: db::DbState,
    members: members::MemberState,
    pay: pay::PayState,
    fns: functions::FnState,
    cron: cron::CronState,
}

impl Contract {
    pub fn new() -> Self {
        Self {
            chunks: Map::new(b"c"),
            releases: Map::new(b"r"),
            production: None,
            stored_bytes: 0,
            sales: Seq::new(b"s"),
            release_ids: Seq::new(b"i"),
            history: Seq::new(b"h"),
            previous: None,
            chunk_refs: Map::new(b"n"),
            version: STATE_VERSION,
            routes: Map::new(b"t"),
            externals: Map::new(b"x"),
            db: db::DbState::new(),
            members: members::MemberState::new(),
            pay: pay::PayState::new(),
            fns: functions::FnState::new(),
            cron: cron::CronState::new(),
        }
    }

    /// Read v1, v2 or v3 state and return v3. Only this account can call it.
    /// `ids` is used for v1 state only.
    pub fn migrate(ids: Vec<String>) -> Self {
        assert_self();
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("state missing"));
        if let Ok(current) = Contract::try_from_slice(&raw) {
            if current.version != STATE_VERSION {
                env::panic_str("unknown contract version");
            }
            return current;
        }
        if let Ok(v2) = StateV2::try_from_slice(&raw) {
            if v2.version != 2 {
                env::panic_str("unknown contract version");
            }
            return Self::from_v2(v2);
        }
        let legacy = LegacyState::try_from_slice(&raw)
            .unwrap_or_else(|_| env::panic_str("state is not v1, v2 or v3"));
        Self::from_legacy(legacy, ids)
    }

    pub fn publish_methods(&self) -> Vec<String> {
        vec!["put_chunk".to_string(), "seal".to_string()]
    }

    pub fn put_chunk(&mut self, sha256: String, data: Base64VecU8) {
        assert_self();
        assert_no_deposit();
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

    pub fn seal(
        &mut self,
        id: String,
        files: Vec<FileIn>,
        message: String,
        spa: bool,
        routes: Option<Vec<RouteIn>>,
    ) {
        assert_self();
        assert_no_deposit();
        let id = check_id(&id);
        if self.releases.contains_key(&id) {
            env::panic_str("release already sealed");
        }
        if self.release_ids.len() >= MAX_RELEASES {
            env::panic_str("release list is full");
        }
        if files.is_empty() || files.len() > MAX_FILES {
            env::panic_str("release needs 1 to 64 files");
        }
        let message = check_message(&message);
        let mut stored = Vec::with_capacity(files.len());
        let mut seen_paths = Vec::with_capacity(files.len());
        let mut index_sha = None;
        let mut total_bytes = 0u64;
        let mut ref_hashes = Vec::new();
        let mut externals = Vec::new();
        for file in files {
            let path = check_path(&file.path);
            if seen_paths.iter().any(|seen| seen == &path) {
                env::panic_str("duplicate path");
            }
            seen_paths.push(path.clone());
            let content_type = check_content_type(&file.content_type);
            if let Some(external) = file.external {
                if !file.chunks.is_empty() {
                    env::panic_str("an external file has no chunks");
                }
                if path == INDEX_PATH {
                    env::panic_str("index.html must be stored on chain");
                }
                let cid = external.cid;
                if cid.is_empty()
                    || cid.len() > MAX_CID_BYTES
                    || !cid.bytes().all(|byte| byte.is_ascii_alphanumeric())
                {
                    env::panic_str("bad cid");
                }
                if external.size.0 == 0 {
                    env::panic_str("external size must be above 0");
                }
                externals.push(ExternalFile {
                    path: path.clone(),
                    cid,
                    size: external.size.0,
                });
                stored.push(StoredFile {
                    path,
                    chunks: Vec::new(),
                    sha256: normalize_sha256(&external.sha256),
                    content_type,
                });
                continue;
            }
            if file.chunks.is_empty() {
                env::panic_str("file needs a chunk");
            }
            if file.chunks.len() > MAX_CHUNKS_PER_FILE {
                env::panic_str("too many chunks");
            }
            let mut hashes = Vec::with_capacity(file.chunks.len());
            for hash in file.chunks {
                let hash = normalize_sha256(&hash);
                if !self.chunks.contains_key(&hash) {
                    env::panic_str("chunk missing");
                }
                hashes.push(hash);
            }
            let assembled = assemble(&self.chunks, &hashes);
            total_bytes = total_bytes.saturating_add(assembled.len() as u64);
            let sha256 = hex_encode(&env::sha256(&assembled));
            if path == INDEX_PATH {
                index_sha = Some(sha256.clone());
            }
            ref_hashes.extend(hashes.iter().cloned());
            stored.push(StoredFile {
                path,
                chunks: hashes,
                sha256,
                content_type,
            });
        }
        let sha256 = index_sha.unwrap_or_else(|| env::panic_str("index.html required"));
        let routes = match routes {
            Some(routes) if !routes.is_empty() => check_routes(
                routes,
                &FileLoader {
                    chunks: &self.chunks,
                    files: &stored,
                },
            ),
            _ => Vec::new(),
        };
        for hash in &ref_hashes {
            self.add_ref(hash);
        }
        let release = Release {
            sha256: sha256.clone(),
            files: stored,
            timestamp_ns: env::block_timestamp(),
            message: message.clone(),
            bytes: total_bytes,
            spa,
        };
        self.releases.insert(id.clone(), release);
        self.release_ids.push(id.clone());
        let route_count = routes.len();
        let external_count = externals.len();
        if !routes.is_empty() {
            self.routes.insert(id.clone(), routes);
        }
        if !externals.is_empty() {
            self.externals.insert(id.clone(), externals);
        }
        emit(
            "release_sealed",
            &near_sdk::serde_json::json!({
                "id": id,
                "sha256": sha256,
                "bytes": total_bytes,
                "files": seen_paths.len(),
                "message": message,
                "spa": spa,
                "routes": route_count,
                "external": external_count,
            }),
        );
    }
    pub fn promote(&mut self, id: String) -> String {
        assert_self();
        near_sdk::assert_one_yocto();
        let id = check_id(&id);
        if !self.releases.contains_key(&id) {
            env::panic_str("release missing");
        }
        if self.production.as_deref() == Some(id.as_str()) {
            env::panic_str("already production");
        }
        let previous = self.production.clone();
        self.previous = previous.clone();
        self.production = Some(id.clone());
        self.push_history(id.clone(), previous.clone(), "promote");
        emit(
            "promoted",
            &near_sdk::serde_json::json!({ "id": id, "previous": previous }),
        );
        id
    }
    pub fn rollback(&mut self) -> String {
        assert_self();
        near_sdk::assert_one_yocto();
        let current = self
            .production
            .clone()
            .unwrap_or_else(|| env::panic_str("no production"));
        let previous = self
            .previous
            .clone()
            .unwrap_or_else(|| env::panic_str("nothing to roll back"));
        if !self.releases.contains_key(&previous) {
            env::panic_str("previous release missing");
        }
        self.production = Some(previous.clone());
        self.previous = Some(current.clone());
        self.push_history(previous.clone(), Some(current), "rollback");
        emit(
            "rolled_back",
            &near_sdk::serde_json::json!({
                "id": self.production.clone(),
                "previous": self.previous.clone(),
            }),
        );
        previous
    }
    pub fn delete(&mut self, id: String) -> U64 {
        assert_self();
        near_sdk::assert_one_yocto();
        let id = check_id(&id);
        if self.production.as_deref() == Some(id.as_str()) {
            env::panic_str("cannot delete production");
        }
        if !self.releases.contains_key(&id) {
            env::panic_str("release missing");
        }
        let index = self
            .release_index(&id)
            .unwrap_or_else(|| env::panic_str("release missing"));
        let release = self
            .releases
            .remove(&id)
            .unwrap_or_else(|| env::panic_str("release missing"));
        self.release_ids.remove_shift(index);
        self.routes.remove(&id);
        self.externals.remove(&id);
        if self.previous.as_deref() == Some(id.as_str()) {
            self.previous = None;
        }
        let mut freed = 0u64;
        for file in &release.files {
            for hash in &file.chunks {
                freed = freed.saturating_add(self.release_ref(hash));
            }
        }
        emit(
            "release_deleted",
            &near_sdk::serde_json::json!({ "id": id, "bytes_freed": freed }),
        );
        U64(freed)
    }

    /// Removes a chunk that no release references. A publish-only key cannot call
    /// this: it requires 1 yoctoNEAR. Bytes uploaded and then never sealed stay
    /// until the account owner drops them.
    pub fn drop_chunk(&mut self, sha256: String) {
        assert_self();
        near_sdk::assert_one_yocto();
        let sha256 = normalize_sha256(&sha256);
        if self.chunk_refs.contains_key(&sha256) {
            env::panic_str("chunk is in use");
        }
        let chunk = self
            .chunks
            .remove(&sha256)
            .unwrap_or_else(|| env::panic_str("chunk missing"));
        self.stored_bytes = self.stored_bytes.saturating_sub(chunk.len() as u64);
        emit(
            "chunk_dropped",
            &near_sdk::serde_json::json!({
                "sha256": sha256,
                "bytes_freed": chunk.len(),
            }),
        );
    }
    pub fn buy(&mut self, memo: Option<String>) {
        let deposit = env::attached_deposit();
        if deposit.as_yoctonear() < MIN_BUY_YOCTO {
            env::panic_str("buy needs at least 0.01 NEAR");
        }
        if self.sales.len() >= MAX_SALES {
            env::panic_str("sale log is full");
        }
        let memo = match memo {
            Some(memo) if memo.chars().count() > MAX_MEMO_CHARS => env::panic_str("memo too long"),
            Some(memo) if memo.is_empty() => None,
            other => other,
        };
        let buyer = env::predecessor_account_id();
        let yocto = deposit.as_yoctonear().to_string();
        self.sales.push(Sale {
            buyer: buyer.clone(),
            yocto: yocto.clone(),
            memo,
        });
        emit(
            "purchased",
            &near_sdk::serde_json::json!({ "buyer": buyer, "yocto": yocto }),
        );
    }

    pub fn web4_get(&self, request: Web4Request) -> Web4Response {
        if let Some(response) = self.serve_routes(&request) {
            return response;
        }
        match route(&request.path) {
            Routed::Production { path } => match &self.production {
                Some(id) => self.serve(id, &path, false),
                None => text_response(404, "no production release"),
            },
            Routed::Release { id, path } => self.serve(&id, &path, true),
            Routed::Missing => text_response(404, "not found"),
        }
    }

    pub fn get_version(&self) -> VersionInfo {
        VersionInfo {
            version: VERSION.to_string(),
            standard: STANDARD.to_string(),
        }
    }

    pub fn get_status(&self) -> Status {
        Status {
            version: VERSION.to_string(),
            production: self.production.clone(),
            previous: self.previous.clone(),
            release_count: self.release_ids.len(),
            stored_bytes: U64(self.stored_bytes),
            max_bytes: U64(MAX_STORED_BYTES),
            chunk_bytes: U64(MAX_CHUNK_BYTES),
        }
    }

    pub fn get_production(&self) -> Option<String> {
        self.production.clone()
    }

    pub fn get_previous(&self) -> Option<String> {
        self.previous.clone()
    }

    pub fn get_release(&self, id: String) -> Option<ReleaseDetail> {
        let id = check_id_ok(&id)?;
        let release = self.releases.get(&id)?;
        let externals = self.externals.get(&id).unwrap_or_default();
        let routes = self.routes.get(&id).unwrap_or_default();
        Some(release.detail(id, &externals, routes))
    }

    pub fn list_releases(&self, from_index: u32, limit: u32) -> ReleasePage {
        let (start, end, next) = page_bounds(self.release_ids.len(), from_index, limit);
        let mut releases = Vec::new();
        for index in start..end {
            if let Some(id) = self.release_ids.get(index) {
                if let Some(release) = self.releases.get(&id) {
                    releases.push(release.summary(id));
                }
            }
        }
        ReleasePage { releases, next }
    }

    pub fn list_history(&self, from_index: u32, limit: u32) -> HistoryPage {
        let (start, end, next) = page_bounds(self.history.len(), from_index, limit);
        let mut entries = Vec::new();
        for index in start..end {
            if let Some(entry) = self.history.get(index) {
                entries.push(HistoryEntry {
                    release_id: entry.release_id.clone(),
                    previous_id: entry.previous_id.clone(),
                    timestamp: U64(entry.timestamp_ns),
                    kind: entry.kind.clone(),
                });
            }
        }
        HistoryPage { entries, next }
    }

    pub fn get_budget(&self) -> Budget {
        Budget {
            stored_bytes: U64(self.stored_bytes),
            max_bytes: U64(MAX_STORED_BYTES),
            chunk_bytes: U64(MAX_CHUNK_BYTES),
        }
    }

    pub fn has_chunk(&self, sha256: String) -> bool {
        let sha256 = normalize_sha256(&sha256);
        self.chunks.contains_key(&sha256)
    }

    pub fn get_sales(&self) -> Vec<Sale> {
        let mut out = Vec::with_capacity(self.sales.len() as usize);
        for index in 0..self.sales.len() {
            if let Some(sale) = self.sales.get(index) {
                out.push(sale.clone());
            }
        }
        out
    }
}

impl Contract {
    /// v2 to v3: keep every v2 collection, add empty v3 structures.
    fn from_v2(v2: StateV2) -> Self {
        Self {
            chunks: v2.chunks,
            releases: v2.releases,
            production: v2.production,
            stored_bytes: v2.stored_bytes,
            sales: v2.sales,
            release_ids: v2.release_ids,
            history: v2.history,
            previous: v2.previous,
            chunk_refs: v2.chunk_refs,
            version: STATE_VERSION,
            routes: Map::new(b"t"),
            externals: Map::new(b"x"),
            db: db::DbState::new(),
            members: members::MemberState::new(),
            pay: pay::PayState::new(),
            fns: functions::FnState::new(),
            cron: cron::CronState::new(),
        }
    }

    fn from_legacy(legacy: LegacyState, ids: Vec<String>) -> Self {
        let ids = if ids.is_empty() { scan_ids() } else { ids };
        let LegacyState {
            chunks,
            mut releases,
            production,
            stored_bytes,
            sales,
        } = legacy;
        let mut loaded = Vec::new();
        let mut refs: Vec<(String, u32)> = Vec::new();
        for id in ids {
            if loaded.iter().any(|(seen, _): &(String, Release)| seen == &id) {
                continue;
            }
            let Some(old) = releases.get(&id) else {
                continue;
            };
            let mut files = Vec::with_capacity(old.files.len());
            let mut bytes = 0u64;
            for file in &old.files {
                for hash in &file.chunks {
                    let chunk = chunks
                        .get(hash)
                        .unwrap_or_else(|| env::panic_str("chunk missing"));
                    bytes = bytes.saturating_add(chunk.len() as u64);
                    if let Some((_, count)) = refs.iter_mut().find(|(seen, _)| seen == hash) {
                        *count = count.saturating_add(1);
                    } else {
                        refs.push((hash.clone(), 1));
                    }
                }
                files.push(StoredFile {
                    path: file.path.clone(),
                    chunks: file.chunks.clone(),
                    sha256: file.sha256.clone(),
                    content_type: file.content_type.clone(),
                });
            }
            loaded.push((
                id,
                Release {
                    sha256: old.sha256,
                    files,
                    timestamp_ns: 0,
                    message: String::new(),
                    bytes,
                    spa: false,
                },
            ));
        }
        // `LookupMap::insert` reads the current value. The old bytes are a v1
        // release, so remove them with the v1 map before writing v2 values.
        for (id, _) in &loaded {
            releases.remove(id);
        }
        drop(releases);
        drop(chunks);

        let production_id = production.clone();
        let mut contract = Self {
            chunks: Map::new(b"c"),
            releases: Map::new(b"r"),
            production,
            stored_bytes,
            sales,
            release_ids: Seq::new(b"i"),
            history: Seq::new(b"h"),
            previous: None,
            chunk_refs: Map::new(b"n"),
            version: STATE_VERSION,
            routes: Map::new(b"t"),
            externals: Map::new(b"x"),
            db: db::DbState::new(),
            members: members::MemberState::new(),
            pay: pay::PayState::new(),
            fns: functions::FnState::new(),
            cron: cron::CronState::new(),
        };
        for (hash, count) in refs {
            contract.chunk_refs.insert(hash, count);
        }
        for (id, release) in loaded {
            contract.releases.insert(id.clone(), release);
            contract.release_ids.push(id);
        }
        if let Some(id) = production_id {
            contract.history.push(Promotion {
                release_id: id,
                previous_id: None,
                timestamp_ns: 0,
                kind: "promote".to_string(),
            });
        }
        contract
    }

    fn add_ref(&mut self, hash: &str) {
        let next = self
            .chunk_refs
            .get(hash)
            .unwrap_or(0)
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("chunk refs exceeded"));
        self.chunk_refs.insert(hash.to_string(), next);
    }

    fn release_ref(&mut self, hash: &str) -> u64 {
        let current = self.chunk_refs.get(hash).unwrap_or(0);
        if current == 0 {
            env::panic_str("chunk ref missing");
        }
        let next = current - 1;
        if next == 0 {
            self.chunk_refs.remove(hash);
            let len = self
                .chunks
                .get(hash)
                .map(|chunk| chunk.len() as u64)
                .unwrap_or_else(|| env::panic_str("chunk missing"));
            self.chunks.remove(hash);
            self.stored_bytes = self.stored_bytes.saturating_sub(len);
            len
        } else {
            self.chunk_refs.insert(hash.to_string(), next);
            0
        }
    }

    fn push_history(&mut self, release_id: String, previous_id: Option<String>, kind: &str) {
        if self.history.len() >= MAX_HISTORY {
            env::panic_str("history is full");
        }
        self.history.push(Promotion {
            release_id,
            previous_id,
            timestamp_ns: env::block_timestamp(),
            kind: kind.to_string(),
        });
    }

    fn release_index(&self, id: &str) -> Option<u32> {
        self.release_ids
            .iter()
            .position(|item| item == id)
            .map(|index| index as u32)
    }

    fn serve(&self, id: &str, path: &str, immutable: bool) -> Web4Response {
        let Some(release) = self.releases.get(id) else {
            return text_response(404, "release missing");
        };
        let cache = if immutable { CACHE_IMMUTABLE } else { CACHE_FRESH };
        match resolve(&release, path) {
            Resolved::File(file) | Resolved::Spa(file) => self.file_response(id, file, 200, cache),
            Resolved::MissingPage(file) => self.file_response(id, file, 404, cache),
            Resolved::Missing => text_response(404, "not found"),
        }
    }

    pub(crate) fn file_response(
        &self,
        release_id: &str,
        file: &StoredFile,
        status: u32,
        cache: &str,
    ) -> Web4Response {
        if file.chunks.is_empty() {
            let external = self
                .externals
                .get(release_id)
                .and_then(|list| list.into_iter().find(|ext| ext.path == file.path));
            return match external {
                Some(ext) => Web4Response {
                    content_type: Some(file.content_type.clone()),
                    status: Some(status),
                    body: None,
                    body_url: Some(format!("ipfs://{}", ext.cid)),
                    preload_urls: None,
                    cache_control: Some(cache.to_string()),
                },
                None => text_response(500, "file missing"),
            };
        }
        let mut body = Vec::new();
        for hash in &file.chunks {
            let Some(chunk) = self.chunks.get(hash) else {
                return text_response(500, "chunk missing");
            };
            body.extend_from_slice(&chunk);
        }
        Web4Response {
            content_type: Some(file.content_type.clone()),
            status: Some(status),
            body: Some(body.into()),
            body_url: None,
            preload_urls: None,
            cache_control: Some(cache.to_string()),
        }
    }
}

enum Routed {
    Production { path: String },
    Release { id: String, path: String },
    Missing,
}

enum Resolved<'a> {
    File(&'a StoredFile),
    Spa(&'a StoredFile),
    MissingPage(&'a StoredFile),
    Missing,
}

fn resolve<'a>(release: &'a Release, path: &str) -> Resolved<'a> {
    if let Some(file) = find_file(release, path) {
        return Resolved::File(file);
    }
    let index = format!("{path}/index.html");
    if !path.is_empty() && path != INDEX_PATH {
        if let Some(file) = find_file(release, &index) {
            return Resolved::File(file);
        }
    }
    if release.spa {
        if let Some(file) = find_file(release, INDEX_PATH) {
            return Resolved::Spa(file);
        }
    }
    if let Some(file) = find_file(release, NOT_FOUND_PATH) {
        return Resolved::MissingPage(file);
    }
    Resolved::Missing
}

fn find_file<'a>(release: &'a Release, path: &str) -> Option<&'a StoredFile> {
    release.files.iter().find(|file| file.path == path)
}

pub(crate) fn bad_part(part: &str) -> bool {
    part.is_empty() || part == "." || part == ".."
}

fn route(raw: &str) -> Routed {
    let path = raw.split('?').next().unwrap_or("");
    if path.contains('\\') || path.contains("//") {
        return Routed::Missing;
    }
    let path = if path.is_empty() { "/" } else { path };
    let trimmed = path.trim_start_matches('/').trim_end_matches('/');
    if trimmed.is_empty() || trimmed == INDEX_PATH {
        return Routed::Production {
            path: INDEX_PATH.to_string(),
        };
    }
    if let Some(rest) = trimmed.strip_prefix("r/") {
        let mut parts = rest.splitn(2, '/');
        let Some(id) = parts.next() else {
            return Routed::Missing;
        };
        if check_id_ok(id).is_none() {
            return Routed::Missing;
        }
        let file = match parts.next() {
            None | Some("") | Some(INDEX_PATH) => INDEX_PATH.to_string(),
            Some(file) => {
                let file = file.trim_end_matches('/');
                if file.is_empty() || file == INDEX_PATH {
                    INDEX_PATH.to_string()
                } else if file.split('/').any(bad_part) {
                    return Routed::Missing;
                } else {
                    file.to_string()
                }
            }
        };
        return Routed::Release {
            id: id.to_string(),
            path: file,
        };
    }
    if trimmed.split('/').any(bad_part) {
        return Routed::Missing;
    }
    Routed::Production {
        path: trimmed.to_string(),
    }
}

fn assemble(chunks: &Map<String, Vec<u8>>, hashes: &[String]) -> Vec<u8> {
    let mut body = Vec::new();
    for hash in hashes {
        let chunk = chunks
            .get(hash)
            .unwrap_or_else(|| env::panic_str("chunk missing"));
        if body.len() + chunk.len() > MAX_FILE_BYTES {
            env::panic_str("file too large");
        }
        body.extend_from_slice(&chunk);
    }
    if body.is_empty() {
        env::panic_str("empty file");
    }
    body
}

fn page_bounds(len: u32, from: u32, limit: u32) -> (u32, u32, Option<u32>) {
    page_bounds_max(len, from, limit, PAGE_LIMIT)
}

pub(crate) fn page_bounds_max(len: u32, from: u32, limit: u32, max: u32) -> (u32, u32, Option<u32>) {
    if from > len {
        env::panic_str("bad page");
    }
    let limit = if limit == 0 { 1 } else { limit.min(max) };
    if from == len {
        return (from, from, None);
    }
    let end = from.saturating_add(limit).min(len);
    let next = if end < len { Some(end) } else { None };
    (from, end, next)
}

pub(crate) fn assert_self() {
    require!(
        env::predecessor_account_id() == env::current_account_id(),
        "only this account"
    );
}

fn assert_no_deposit() {
    require!(
        env::attached_deposit() == NearToken::from_yoctonear(0),
        "no deposit"
    );
}

pub(crate) fn emit(event: &str, data: &near_sdk::serde_json::Value) {
    let line = near_sdk::serde_json::json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{line}"));
}

pub(crate) fn text_response(status: u32, message: &str) -> Web4Response {
    let html = format!("<!doctype html><title>quay</title><p>{message}</p>");
    Web4Response {
        content_type: Some("text/html; charset=utf-8".to_string()),
        status: Some(status),
        body: Some(html.into_bytes().into()),
        body_url: None,
        preload_urls: None,
        cache_control: Some(CACHE_FRESH.to_string()),
    }
}

fn check_id(id: &str) -> String {
    check_id_ok(id).unwrap_or_else(|| env::panic_str("bad release id"))
}

pub(crate) fn check_id_ok(id: &str) -> Option<String> {
    if id.is_empty() || id.len() > MAX_ID_BYTES || id == "." || id == ".." {
        return None;
    }
    if id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' || byte == b'-')
    {
        Some(id.to_string())
    } else {
        None
    }
}

fn check_path(path: &str) -> String {
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains("//")
    {
        env::panic_str("bad path");
    }
    if path
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        env::panic_str("bad path");
    }
    if path
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
    {
        path.to_string()
    } else {
        env::panic_str("bad path")
    }
}

pub(crate) fn check_content_type(value: &str) -> String {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_CONTENT_TYPE_BYTES
        || value.bytes().any(|byte| byte < 0x20 || byte > 0x7e)
    {
        env::panic_str("bad content type");
    }
    value.to_string()
}

fn check_message(value: &str) -> String {
    let value = value.trim();
    if value.chars().count() > MAX_MESSAGE_CHARS || value.chars().any(|ch| ch.is_control()) {
        env::panic_str("bad message");
    }
    value.to_string()
}

fn normalize_sha256(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
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
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, AccountId, Gas, NearToken};
    use sha2::{Digest, Sha256};

    fn sha256_hex(bytes: &[u8]) -> String {
        hex_encode(Sha256::digest(bytes).as_slice())
    }

    fn set_ctx(deposit_yocto: u128) {
        set_ctx_as("quay-bb.testnet", deposit_yocto);
    }

    fn set_ctx_as(predecessor: &str, deposit_yocto: u128) {
        let predecessor: AccountId = predecessor.parse().unwrap();
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("quay-bb.testnet".parse().unwrap())
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
            .prepaid_gas(Gas::from_tgas(300))
            .block_timestamp(1_700_000_000_000_000_000);
        testing_env!(
            builder.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            Default::default(),
        );
    }

    fn file_in(bytes: &[u8]) -> (String, FileIn) {
        let hash = sha256_hex(bytes);
        (
            hash.clone(),
            FileIn {
                path: INDEX_PATH.to_string(),
                chunks: vec![hash],
                content_type: "text/html; charset=utf-8".to_string(),
                external: None,
            },
        )
    }

    fn req(path: impl Into<String>) -> Web4Request {
        Web4Request {
            path: path.into(),
            ..Default::default()
        }
    }

    fn body_of(response: &Web4Response) -> &[u8] {
        &response.body.as_ref().expect("body").0
    }

    fn seal_html(contract: &mut Contract, id: &str, html: &[u8]) {
        set_ctx(0);
        let (hash, file) = file_in(html);
        contract.put_chunk(hash, html.to_vec().into());
        contract.seal(id.to_string(), vec![file], format!("note {id}"), false, None);
    }

    #[test]
    fn sealed_release_bytes_stick() {
        set_ctx(0);
        let mut contract = Contract::new();
        let html = b"<p>release 1</p>";
        seal_html(&mut contract, "1", html);

        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let (_hash, file) = file_in(b"<p>rewritten</p>");
            contract.seal("1".to_string(), vec![file], String::new(), false, None);
        }));
        assert!(again.is_err());

        let release = contract.get_release("1".to_string()).expect("sealed");
        assert_eq!(release.sha256, sha256_hex(html));
        assert_eq!(release.message, "note 1");
        assert_eq!(release.bytes.0, html.len() as u64);
        assert_eq!(release.file_count, 1);
        let response = contract.web4_get(req("/r/1".to_string()));
        assert_eq!(response.status, Some(200));
        assert_eq!(body_of(&response), html);
        assert_eq!(
            contract
                .web4_get(req("/r/1".to_string()))
                .cache_control
                .as_deref(),
            Some(CACHE_IMMUTABLE)
        );
        let logs = get_logs();
        assert!(logs.iter().any(|line| line.contains("release_sealed")));
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
        set_ctx(1);
        assert_eq!(contract.promote("1".to_string()), "1");
        assert_eq!(contract.promote("2".to_string()), "2");
        assert_eq!(contract.get_production().as_deref(), Some("2"));
        assert_eq!(contract.get_previous().as_deref(), Some("1"));

        let production = contract.web4_get(req("/".to_string()));
        assert_eq!(body_of(&production), b"<p>production: release 2</p>");
        assert_eq!(
            production.cache_control.as_deref(),
            Some(CACHE_FRESH)
        );
        let asset = contract.web4_get(req("/index.html".to_string()));
        assert_eq!(body_of(&asset), b"<p>production: release 2</p>");

        let first = contract.web4_get(req("/r/1".to_string()));
        assert_eq!(body_of(&first), b"<p>release 1</p>");

        assert_eq!(contract.rollback(), "1");
        let rolled = contract.web4_get(req("/".to_string()));
        assert_eq!(body_of(&rolled), b"<p>release 1</p>");
        assert_eq!(contract.get_production().as_deref(), Some("1"));
        assert_eq!(contract.get_previous().as_deref(), Some("2"));
        let history = contract.list_history(0, 10);
        assert_eq!(history.entries.len(), 3);
        assert_eq!(history.entries[2].kind, "rollback");
    }

    #[test]
    fn reuses_an_unchanged_chunk() {
        set_ctx(0);
        let mut contract = Contract::new();
        let html = b"<p>same</p>";
        let hash = sha256_hex(html);
        contract.put_chunk(hash.clone(), html.to_vec().into());
        let used = contract.get_budget().stored_bytes.0;
        contract.put_chunk(hash, html.to_vec().into());
        assert_eq!(contract.get_budget().stored_bytes.0, used);
    }

    #[test]
    #[should_panic(expected = "chunk hash mismatch")]
    fn rejects_a_lying_hash() {
        set_ctx(0);
        let mut contract = Contract::new();
        contract.put_chunk("ab".repeat(32), b"nope".to_vec().into());
    }

    #[test]
    #[should_panic(expected = "only this account")]
    fn outsider_cannot_promote() {
        set_ctx(0);
        let mut contract = Contract::new();
        seal_html(&mut contract, "1", b"<p>release 1</p>");
        set_ctx_as("buyer.testnet", 1);
        contract.promote("1".to_string());
    }

    #[test]
    #[should_panic(expected = "only this account")]
    fn outsider_cannot_write() {
        set_ctx_as("buyer.testnet", 0);
        let mut contract = Contract::new();
        contract.put_chunk("ab".repeat(32), b"nope".to_vec().into());
    }

    #[test]
    #[should_panic(expected = "too many chunks")]
    fn rejects_too_many_chunks() {
        set_ctx(0);
        let mut contract = Contract::new();
        let html = b"<p>x</p>";
        let (hash, mut file) = file_in(html);
        contract.put_chunk(hash, html.to_vec().into());
        file.chunks = vec![file.chunks[0].clone(); MAX_CHUNKS_PER_FILE + 1];
        contract.seal("1".to_string(), vec![file], String::new(), false, None);
    }

    #[test]
    fn buy_records_the_predecessor() {
        set_ctx_as("buyer.testnet", MIN_BUY_YOCTO);
        let mut contract = Contract::new();
        contract.buy(Some("hello".to_string()));
        let sales = contract.get_sales();
        assert_eq!(sales.len(), 1);
        assert_eq!(sales[0].buyer, "buyer.testnet".parse::<AccountId>().unwrap());
        assert_eq!(sales[0].yocto, MIN_BUY_YOCTO.to_string());
        assert_eq!(sales[0].memo.as_deref(), Some("hello"));
        assert!(get_logs().iter().any(|line| line.contains("purchased")));
    }

    #[test]
    fn lists_releases_and_reports_version() {
        set_ctx(0);
        let mut contract = Contract::new();
        seal_html(&mut contract, "1", b"<p>one</p>");
        seal_html(&mut contract, "2", b"<p>two</p>");
        let page = contract.list_releases(0, 1);
        assert_eq!(page.releases.len(), 1);
        assert_eq!(page.releases[0].id, "1");
        assert_eq!(page.next, Some(1));
        let rest = contract.list_releases(1, 20);
        assert_eq!(rest.releases[0].id, "2");
        assert_eq!(rest.next, None);
        assert_eq!(contract.get_version().version, "3.0.0");
        assert_eq!(
            contract.publish_methods(),
            vec!["put_chunk".to_string(), "seal".to_string()]
        );
        let status = contract.get_status();
        assert_eq!(status.release_count, 2);
        assert_eq!(status.production, None);
    }

    #[test]
    fn delete_frees_bytes_and_refuses_production() {
        set_ctx(1);
        let mut contract = Contract::new();
        let first = b"<p>release 1</p>";
        let second = b"<p>release 2</p>";
        seal_html(&mut contract, "1", first);
        seal_html(&mut contract, "2", second);
        set_ctx(1);
        contract.promote("2".to_string());
        let before = contract.get_budget().stored_bytes.0;
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.delete("2".to_string());
        }));
        assert!(panic.is_err());
        let freed = contract.delete("1".to_string());
        assert_eq!(freed.0, first.len() as u64);
        assert!(contract.get_release("1".to_string()).is_none());
        assert_eq!(
            contract.get_budget().stored_bytes.0,
            before - first.len() as u64
        );
        assert_eq!(contract.list_releases(0, 20).releases.len(), 1);
        let still = contract.web4_get(req("/r/2".to_string()));
        assert_eq!(body_of(&still), second);
    }

    #[test]
    fn shared_chunk_survives_until_the_last_release() {
        set_ctx(1);
        let mut contract = Contract::new();
        let html = b"<p>shared</p>";
        seal_html(&mut contract, "1", html);
        let (hash, file) = file_in(html);
        contract.put_chunk(hash, html.to_vec().into());
        contract.seal("2".to_string(), vec![file], String::new(), false, None);
        set_ctx(1);
        let used = contract.get_budget().stored_bytes.0;
        assert_eq!(contract.delete("1".to_string()).0, 0);
        assert_eq!(contract.get_budget().stored_bytes.0, used);
        assert_eq!(contract.delete("2".to_string()).0, html.len() as u64);
        assert_eq!(contract.get_budget().stored_bytes.0, 0);
    }

    #[test]
    fn drop_chunk_returns_unreferenced_bytes() {
        set_ctx(0);
        let mut contract = Contract::new();
        let html = b"<p>orphan</p>";
        let hash = sha256_hex(html);
        contract.put_chunk(hash.clone(), html.to_vec().into());
        assert_eq!(contract.get_budget().stored_bytes.0, html.len() as u64);
        set_ctx(1);
        contract.drop_chunk(hash.clone());
        assert!(!contract.has_chunk(hash));
        assert_eq!(contract.get_budget().stored_bytes.0, 0);
        let logs = get_logs();
        assert!(logs.iter().any(|line| line.contains("chunk_dropped")));
    }

    #[test]
    #[should_panic(expected = "chunk is in use")]
    fn cannot_drop_a_sealed_chunk() {
        set_ctx(0);
        let mut contract = Contract::new();
        seal_html(&mut contract, "1", b"<p>kept</p>");
        set_ctx(1);
        contract.drop_chunk(sha256_hex(b"<p>kept</p>"));
    }

    #[test]
    fn a_dotted_file_name_is_served_and_a_parent_segment_is_not() {
        set_ctx(0);
        let mut contract = Contract::new();
        let bytes = b"ok";
        let hash = sha256_hex(bytes);
        contract.put_chunk(hash.clone(), bytes.to_vec().into());
        contract.seal(
            "1".to_string(),
            vec![
                FileIn {
                    path: "index.html".to_string(),
                    chunks: vec![hash.clone()],
                    content_type: "text/html".to_string(),
                    external: None,
                },
                FileIn {
                    path: "a..b.txt".to_string(),
                    chunks: vec![hash],
                    content_type: "text/plain".to_string(),
                    external: None,
                },
            ],
            "dots".to_string(),
            false,
            None,
        );
        set_ctx(1);
        contract.promote("1".to_string());
        let file = contract.web4_get(req("/a..b.txt".to_string()));
        assert_eq!(file.status, Some(200));
        assert_eq!(body_of(&file), bytes);
        let escape = contract.web4_get(req("/r/1/../2".to_string()));
        assert_eq!(escape.status, Some(404));
    }

    #[test]
    #[should_panic(expected = "nothing to roll back")]
    fn cannot_roll_back_to_a_deleted_release() {
        set_ctx(1);
        let mut contract = Contract::new();
        seal_html(&mut contract, "1", b"<p>one</p>");
        seal_html(&mut contract, "2", b"<p>two</p>");
        set_ctx(1);
        contract.promote("1".to_string());
        contract.promote("2".to_string());
        contract.delete("1".to_string());
        contract.rollback();
    }

    #[test]
    fn serves_nested_files_directory_index_spa_and_custom_404() {
        set_ctx(0);
        let mut contract = Contract::new();
        let index = b"<p>app</p>";
        let nested = b"body{color:black}";
        let missing = b"<p>missing</p>";
        let index_hash = sha256_hex(index);
        let nested_hash = sha256_hex(nested);
        let missing_hash = sha256_hex(missing);
        contract.put_chunk(index_hash.clone(), index.to_vec().into());
        contract.put_chunk(nested_hash.clone(), nested.to_vec().into());
        contract.put_chunk(missing_hash.clone(), missing.to_vec().into());
        contract.seal(
            "1".to_string(),
            vec![
                FileIn {
                    path: "index.html".to_string(),
                    chunks: vec![index_hash.clone()],
                    content_type: "text/html; charset=utf-8".to_string(),
                    external: None,
                },
                FileIn {
                    path: "docs/index.html".to_string(),
                    chunks: vec![index_hash],
                    content_type: "text/html; charset=utf-8".to_string(),
                    external: None,
                },
                FileIn {
                    path: "assets/app.css".to_string(),
                    chunks: vec![nested_hash],
                    content_type: "text/css; charset=utf-8".to_string(),
                    external: None,
                },
                FileIn {
                    path: "404.html".to_string(),
                    chunks: vec![missing_hash],
                    content_type: "text/html; charset=utf-8".to_string(),
                    external: None,
                },
            ],
            String::new(),
            false,
            None,
        );
        set_ctx(1);
        contract.promote("1".to_string());
        let css = contract.web4_get(req("/assets/app.css".to_string()));
        assert_eq!(body_of(&css), nested);
        assert_eq!(css.content_type.as_deref(), Some("text/css; charset=utf-8"));
        let docs = contract.web4_get(req("/docs/".to_string()));
        assert_eq!(body_of(&docs), index);
        let preview = contract.web4_get(req("/r/1/docs".to_string()));
        assert_eq!(body_of(&preview), index);
        let not_found = contract.web4_get(req("/missing".to_string()));
        assert_eq!(not_found.status, Some(404));
        assert_eq!(body_of(&not_found), missing);

        set_ctx(0);
        contract.seal(
            "spa".to_string(),
            vec![FileIn {
                path: "index.html".to_string(),
                chunks: vec![sha256_hex(index)],
                content_type: "text/html; charset=utf-8".to_string(),
                external: None,
            }],
            String::new(),
            true,
            None,
        );
        let fallback = contract.web4_get(req("/r/spa/anywhere".to_string()));
        assert_eq!(fallback.status, Some(200));
        assert_eq!(body_of(&fallback), index);
        let dot = contract.web4_get(req("/r/1/../2".to_string()));
        assert_eq!(dot.status, Some(404));
    }

    #[test]
    #[should_panic(expected = "only this account")]
    fn outsider_cannot_delete_or_roll_back() {
        set_ctx(1);
        let mut contract = Contract::new();
        seal_html(&mut contract, "1", b"<p>one</p>");
        set_ctx(1);
        contract.promote("1".to_string());
        set_ctx_as("buyer.testnet", 1);
        contract.rollback();
    }

    #[test]
    #[should_panic(expected = "no deposit")]
    fn seal_rejects_a_deposit() {
        set_ctx(0);
        let mut contract = Contract::new();
        let (hash, file) = file_in(b"<p>x</p>");
        contract.put_chunk(hash, b"<p>x</p>".to_vec().into());
        set_ctx(1);
        contract.seal("1".to_string(), vec![file], String::new(), false, None);
    }

    #[test]
    fn migrates_v1_state_and_is_idempotent() {
        set_ctx(0);
        let html = b"<p>release 1</p>";
        let hash = sha256_hex(html);
        {
            let mut chunks: Map<String, Vec<u8>> = Map::new(b"c");
            chunks.insert(hash.clone(), html.to_vec());
            let mut releases: Map<String, legacy::LegacyRelease> = Map::new(b"r");
            releases.insert(
                "1".to_string(),
                legacy::LegacyRelease {
                    sha256: hash.clone(),
                    files: vec![legacy::LegacyFile {
                        path: INDEX_PATH.to_string(),
                        chunks: vec![hash],
                        sha256: sha256_hex(html),
                        content_type: "text/html; charset=utf-8".to_string(),
                    }],
                },
            );
            let legacy = LegacyState {
                chunks,
                releases,
                production: Some("1".to_string()),
                stored_bytes: html.len() as u64,
                sales: Seq::new(b"s"),
            };
            env::state_write(&legacy);
        }
        let migrated = Contract::migrate(vec![]);
        assert_eq!(migrated.get_production().as_deref(), Some("1"));
        assert_eq!(migrated.get_version().version, "3.0.0");
        let detail = migrated.get_release("1".to_string()).expect("migrated");
        assert_eq!(detail.bytes.0, html.len() as u64);
        assert_eq!(detail.timestamp.0, 0);
        assert_eq!(migrated.list_history(0, 10).entries.len(), 1);
        let response = migrated.web4_get(req("/r/1".to_string()));
        assert_eq!(body_of(&response), html);
        env::state_write(&migrated);
        drop(migrated);
        let again = Contract::migrate(vec!["1".to_string()]);
        assert_eq!(again.get_release("1".to_string()).unwrap().sha256, sha256_hex(html));
        assert_eq!(again.get_status().release_count, 1);
    }

    #[test]
    #[should_panic(expected = "bad message")]
    fn rejects_a_control_character_in_the_message() {
        set_ctx(0);
        let mut contract = Contract::new();
        let (hash, file) = file_in(b"<p>x</p>");
        contract.put_chunk(hash, b"<p>x</p>".to_vec().into());
        contract.seal("1".to_string(), vec![file], "bad\nmessage".to_string(), false, None);
    }
}
