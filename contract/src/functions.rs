//! Functions (section 3). This stage only reserves the `on_add` hook: the
//! trigger is logged and skipped until the OutLayer call is wired in.

use near_sdk::{env, AccountId};

use crate::Contract;

/// A `db_add` that triggers a function will need this much prepaid gas.
pub(crate) fn require_trigger_gas() {}

impl Contract {
    pub(crate) fn run_trigger(&mut self, func: &str, collection: &str, id: &str, _owner: &AccountId, _data: &str) {
        env::log_str(&format!("on_add {func} skipped for {collection}/{id}: functions are not wired yet"));
    }
}
