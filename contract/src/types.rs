use std::collections::BTreeMap;

use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::serde_json::Value;
use near_sdk::{near, AccountId};

use crate::routes::RouteIn;

pub const VERSION: &str = "3.0.0";
pub const STATE_VERSION: u32 = 3;
pub const STANDARD: &str = "quay";
pub const INDEX_PATH: &str = "index.html";
pub const NOT_FOUND_PATH: &str = "404.html";

pub const MAX_CHUNK_BYTES: u64 = 200_000;
pub const MAX_STORED_BYTES: u64 = 2_000_000;
pub const MAX_FILE_BYTES: usize = 800_000;
pub const MAX_CHUNKS_PER_FILE: usize = 4;
pub const MAX_FILES: usize = 64;
pub const MAX_RELEASES: u32 = 32;
pub const MAX_HISTORY: u32 = 128;
pub const MAX_SALES: u32 = 128;
pub const MAX_MESSAGE_CHARS: usize = 200;
pub const MAX_MEMO_CHARS: usize = 140;
pub const MAX_PATH_BYTES: usize = 180;
pub const MAX_ID_BYTES: usize = 64;
pub const MAX_CONTENT_TYPE_BYTES: usize = 128;
pub const PAGE_LIMIT: u32 = 20;
/// 0.01 NEAR.
pub const MIN_BUY_YOCTO: u128 = 10_000_000_000_000_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct StoredFile {
    pub path: String,
    pub chunks: Vec<String>,
    pub sha256: String,
    pub content_type: String,
}

/// Borsh state. JSON callers receive [`ReleaseDetail`], whose integers are strings.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Release {
    pub sha256: String,
    pub files: Vec<StoredFile>,
    pub timestamp_ns: u64,
    pub message: String,
    pub bytes: u64,
    pub spa: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Promotion {
    pub release_id: String,
    pub previous_id: Option<String>,
    pub timestamp_ns: u64,
    pub kind: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Sale {
    pub buyer: AccountId,
    pub yocto: String,
    pub memo: Option<String>,
}

#[near(serializers = [json])]
#[derive(Debug)]
pub struct FileIn {
    pub path: String,
    #[serde(default)]
    pub chunks: Vec<String>,
    pub content_type: String,
    /// A file whose bytes live off chain (section 7). It has no chunks.
    #[serde(default)]
    pub external: Option<ExternalIn>,
}

/// JSON form of an off-chain file reference.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ExternalIn {
    pub cid: String,
    pub size: U64,
    pub sha256: String,
}

/// Borsh form of an off-chain file, stored per release next to the v2 file list.
/// The digest stays in the release's `StoredFile.sha256`.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct ExternalFile {
    pub path: String,
    pub cid: String,
    pub size: u64,
}

#[near(serializers = [json])]
pub struct FileOut {
    pub path: String,
    pub sha256: String,
    pub content_type: String,
    pub chunks: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external: Option<ExternalIn>,
}

#[near(serializers = [json])]
pub struct ReleaseDetail {
    pub id: String,
    pub timestamp: U64,
    pub message: String,
    pub file_count: u32,
    pub bytes: U64,
    pub sha256: String,
    pub spa: bool,
    pub files: Vec<FileOut>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub routes: Vec<RouteIn>,
}

#[near(serializers = [json])]
pub struct ReleaseSummary {
    pub id: String,
    pub timestamp: U64,
    pub message: String,
    pub file_count: u32,
    pub bytes: U64,
    pub sha256: String,
    pub spa: bool,
}

#[near(serializers = [json])]
pub struct ReleasePage {
    pub releases: Vec<ReleaseSummary>,
    pub next: Option<u32>,
}

#[near(serializers = [json])]
pub struct HistoryEntry {
    pub release_id: String,
    pub previous_id: Option<String>,
    pub timestamp: U64,
    pub kind: String,
}

#[near(serializers = [json])]
pub struct HistoryPage {
    pub entries: Vec<HistoryEntry>,
    pub next: Option<u32>,
}

#[near(serializers = [json])]
pub struct Budget {
    pub stored_bytes: U64,
    pub max_bytes: U64,
    pub chunk_bytes: U64,
}

#[near(serializers = [json])]
pub struct Status {
    pub version: String,
    pub production: Option<String>,
    pub previous: Option<String>,
    pub release_count: u32,
    pub stored_bytes: U64,
    pub max_bytes: U64,
    pub chunk_bytes: U64,
}

#[near(serializers = [json])]
pub struct VersionInfo {
    pub version: String,
    pub standard: String,
}

/// The gateway request. Unknown fields are ignored.
#[near(serializers = [json])]
#[derive(Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Web4Request {
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub path: String,
    /// Every value is an array of strings. A bare string is accepted too.
    #[serde(default)]
    pub query: BTreeMap<String, Value>,
    #[serde(default)]
    pub preloads: Option<Value>,
}

#[near(serializers = [json])]
#[serde(rename_all = "camelCase")]
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

impl Release {
    pub fn summary(&self, id: String) -> ReleaseSummary {
        ReleaseSummary {
            id,
            timestamp: U64(self.timestamp_ns),
            message: self.message.clone(),
            file_count: self.files.len() as u32,
            bytes: U64(self.bytes),
            sha256: self.sha256.clone(),
            spa: self.spa,
        }
    }

    pub fn detail(&self, id: String, externals: &[ExternalFile], routes: Vec<RouteIn>) -> ReleaseDetail {
        ReleaseDetail {
            id,
            timestamp: U64(self.timestamp_ns),
            message: self.message.clone(),
            file_count: self.files.len() as u32,
            bytes: U64(self.bytes),
            sha256: self.sha256.clone(),
            spa: self.spa,
            files: self
                .files
                .iter()
                .map(|file| FileOut {
                    path: file.path.clone(),
                    sha256: file.sha256.clone(),
                    content_type: file.content_type.clone(),
                    chunks: file.chunks.clone(),
                    external: externals
                        .iter()
                        .find(|ext| ext.path == file.path)
                        .map(|ext| ExternalIn {
                            cid: ext.cid.clone(),
                            size: U64(ext.size),
                            sha256: file.sha256.clone(),
                        }),
                })
                .collect(),
            routes,
        }
    }
}
