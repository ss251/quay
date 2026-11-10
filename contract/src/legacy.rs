//! Older state layouts that `migrate` can read.
//!
//! V1, as deployed on `quay-bb.testnet` before version 2. Collection prefixes
//! match that deploy: chunks `c`, releases `r`, sales `s`. `migrate` reads this
//! layout, then writes the current version over the same keys.
//!
//! V2 is the v3 contract without the v3 fields at the end. Its collections keep
//! their prefixes, so v2 to v3 only appends empty v3 structures.

use near_sdk::store::{LookupMap, Vector};
use near_sdk::near;

use crate::types::{Promotion, Release, Sale};

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

/// Version 2 contract state, field for field.
#[near(serializers = [borsh])]
pub struct StateV2 {
    pub chunks: LookupMap<String, Vec<u8>>,
    pub releases: LookupMap<String, Release>,
    pub production: Option<String>,
    pub stored_bytes: u64,
    pub sales: Vector<Sale>,
    pub release_ids: Vector<String>,
    pub history: Vector<Promotion>,
    pub previous: Option<String>,
    pub chunk_refs: LookupMap<String, u32>,
    pub version: u32,
}
