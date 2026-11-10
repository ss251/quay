//! V1 state, as deployed on `quay-bb.testnet` before version 2.
//!
//! Collection prefixes match that deploy: chunks `c`, releases `r`, sales `s`.
//! `migrate` reads this layout, then writes version 2 over the same keys.

use near_sdk::store::{LookupMap, Vector};
use near_sdk::near;

use crate::types::Sale;

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct LegacyFile {
    pub path: String,
    pub chunks: Vec<String>,
    pub sha256: String,
    pub content_type: String,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct LegacyRelease {
    pub sha256: String,
    pub files: Vec<LegacyFile>,
}

#[near(serializers = [borsh])]
pub struct LegacyState {
    pub chunks: LookupMap<String, Vec<u8>>,
    pub releases: LookupMap<String, LegacyRelease>,
    pub production: Option<String>,
    pub stored_bytes: u64,
    pub sales: Vector<Sale>,
}

/// Ids to try when `migrate` is called with an empty list.
pub fn scan_ids() -> Vec<String> {
    (1..=128).map(|n| n.to_string()).collect()
}
