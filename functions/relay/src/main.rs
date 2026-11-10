//! Entry point: read the request, load the relayer from secrets, answer JSON.
use relay::{handle, Config, Store};

/// Counters in OutLayer persistent storage (available when run through a project).
struct OutlayerStore;

#[cfg(target_os = "wasi")]
impl Store for OutlayerStore {
    fn get(&self, key: &str) -> Result<i64, String> {
        outlayer::storage::increment(key, 0).map_err(|e| format!("{e:?}"))
    }
    fn add(&self, key: &str, delta: i64) -> Result<i64, String> {
        outlayer::storage::increment(key, delta).map_err(|e| format!("{e:?}"))
    }
}

#[cfg(not(target_os = "wasi"))]
impl Store for OutlayerStore {
    fn get(&self, _key: &str) -> Result<i64, String> {
        Err("OutLayer storage exists only inside the guest".into())
    }
    fn add(&self, _key: &str, _delta: i64) -> Result<i64, String> {
        Err("OutLayer storage exists only inside the guest".into())
    }
}

fn main() {
    quay_fn::run(|input| {
        let cfg = Config::from_env(&quay_fn::env)?;
        let rpc_url = quay_fn::env("RELAY_RPC").unwrap_or_else(|| quay_fn::rpc::DEFAULT_RPC.to_string());
        let rpc = quay_fn::rpc::Rpc::new(&rpc_url);
        Ok(handle(&input, &cfg, &rpc, &OutlayerStore, quay_fn::now_ms()))
    });
}
