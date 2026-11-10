//! Sandbox coverage for every contract method and the refusals a caller can hit.
//! The official NEAR skill uses near-sandbox and near-api. This file deploys the
//! wasm already vendored for the CLI, so the test does not start a second wasm build.
//! Run it with `cargo test --manifest-path contract/sandbox/Cargo.toml -- --test-threads=1`.

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use testresult::TestResult;

#[derive(Deserialize)]
struct Status {
    version: String,
    release_count: u32,
    stored_bytes: String,
}

#[derive(Deserialize)]
struct ReleasePage {
    releases: Vec<ReleaseRow>,
    next: Option<u32>,
}

#[derive(Deserialize)]
struct ReleaseRow {
    id: String,
    message: String,
    file_count: u32,
}

#[derive(Deserialize)]
struct HistoryPage {
    entries: Vec<HistoryRow>,
}

#[derive(Deserialize)]
struct HistoryRow {
    kind: String,
    release_id: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Web4 {
    status: Option<u32>,
    body: Option<String>,
    cache_control: Option<String>,
}

struct World {
    network: NetworkConfig,
    signer: Arc<Signer>,
    contract_id: AccountId,
    outsider_id: AccountId,
    _sandbox: &'static near_sandbox::Sandbox,
}

fn wasm_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../cli/vendor/quay.wasm")
}

fn hex_sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn chunk_of(html: &str) -> (String, String) {
    let bytes = html.as_bytes();
    (hex_sha(bytes), b64(bytes))
}

async fn world() -> TestResult<World> {
    let sandbox = Box::leak(Box::new(near_sandbox::Sandbox::start_sandbox().await?));
    let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
            .parse()
            .expect("genesis key"),
    )?;
    let contract_id: AccountId = "quay.sandbox".parse()?;
    let outsider_id: AccountId = "outsider.sandbox".parse()?;
    sandbox
        .create_account(contract_id.as_str().parse().expect("contract id"))
        .initial_balance(NearToken::from_near(20))
        .send()
        .await?;
    sandbox
        .create_account(outsider_id.as_str().parse().expect("outsider id"))
        .initial_balance(NearToken::from_near(10))
        .send()
        .await?;
    let wasm = std::fs::read(wasm_path())?;
    Contract::deploy(contract_id.clone())
        .use_code(wasm)
        .with_init_call("new", json!({}))?
        .with_signer(signer.clone())
        .send_to(&network)
        .await?
        .assert_success();
    Ok(World {
        network,
        signer,
        contract_id,
        outsider_id,
        _sandbox: sandbox,
    })
}

fn contract(world: &World) -> Contract {
    Contract(world.contract_id.clone())
}

async fn view<T: for<'de> Deserialize<'de> + Send + Sync>(
    world: &World,
    method: &str,
    args: Value,
) -> TestResult<T> {
    let data = contract(world)
        .call_function(method, args)
        .read_only()
        .fetch_from(&world.network)
        .await?;
    Ok(data.data)
}

async fn send(world: &World, signer_id: &AccountId, method: &str, args: Value, deposit: NearToken, gas: NearGas) -> Result<String, String> {
    let result = contract(world)
        .call_function(method, args)
        .transaction()
        .gas(gas)
        .deposit(deposit)
        .with_signer(signer_id.clone(), world.signer.clone())
        .send_to(&world.network)
        .await
        .map_err(|error| format!("{error:?}"))?;
    if result.is_failure() {
        Err(format!("{:?}", result.assert_failure()))
    } else if result.is_success() {
        Ok(format!("{result:?}"))
    } else {
        Err(format!("transaction pending: {result:?}"))
    }
}

fn expect_panic(result: Result<String, String>, needle: &str) {
    let text = match &result {
        Ok(text) | Err(text) => text.clone(),
    };
    assert!(result.is_err(), "expected a refusal, got {text}");
    assert!(text.contains(needle), "{text}");
}

async fn seal_page(world: &World, id: &str, html: &str, message: &str, spa: bool) {
    let (hash, data) = chunk_of(html);
    send(
        world,
        &world.contract_id,
        "put_chunk",
        json!({ "sha256": hash, "data": data }),
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(200),
    )
    .await
    .unwrap_or_else(|text| panic!("put_chunk {id}: {text}"));
    send(
        world,
        &world.contract_id,
        "seal",
        json!({
            "id": id,
            "message": message,
            "spa": spa,
            "files": [{ "path": "index.html", "chunks": [hash], "content_type": "text/html" }]
        }),
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(80),
    )
    .await
    .unwrap_or_else(|text| panic!("seal {id}: {text}"));
}

#[tokio::test]
async fn methods_and_refusals() -> TestResult {
    let world = world().await?;
    let yocto = NearToken::from_yoctonear(1);
    let gas = NearGas::from_tgas(80);

    let version: Value = view(&world, "get_version", json!({})).await?;
    assert_eq!(version["version"], "2.0.0");
    assert_eq!(version["standard"], "quay");
    let methods: Vec<String> = view(&world, "publish_methods", json!({})).await?;
    assert_eq!(methods, vec!["put_chunk", "seal"]);

    let outsider = send(
        &world,
        &world.outsider_id,
        "put_chunk",
        json!({ "sha256": "aa", "data": "YQ==" }),
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(100),
    )
    .await;
    expect_panic(outsider, "only this account");

    let deposited = send(
        &world,
        &world.contract_id,
        "put_chunk",
        json!({ "sha256": hex_sha(b"x"), "data": b64(b"x") }),
        yocto,
        NearGas::from_tgas(100),
    )
    .await;
    expect_panic(deposited, "doesn't accept deposit");

    let mismatch = send(
        &world,
        &world.contract_id,
        "put_chunk",
        json!({ "sha256": hex_sha(b"nope"), "data": b64(b"x") }),
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(100),
    )
    .await;
    expect_panic(mismatch, "chunk hash mismatch");

    seal_page(&world, "1", "<p>one</p>", "first", false).await;
    let again = send(
        &world,
        &world.contract_id,
        "seal",
        json!({
            "id": "1",
            "message": "again",
            "spa": false,
            "files": [{ "path": "index.html", "chunks": [hex_sha(b"<p>one</p>")], "content_type": "text/html" }]
        }),
        NearToken::from_yoctonear(0),
        gas,
    )
    .await;
    expect_panic(again, "release already sealed");

    let status: Status = view(&world, "get_status", json!({})).await?;
    assert_eq!(status.version, "2.0.0");
    assert_eq!(status.release_count, 1);
    assert!(status.stored_bytes.parse::<u64>().unwrap() > 0);
    let before = status.stored_bytes;

    seal_page(&world, "2", "<p>one</p>", "same bytes", false).await;
    let status: Status = view(&world, "get_status", json!({})).await?;
    assert_eq!(status.stored_bytes, before, "a repeated chunk is stored once");
    assert!(view::<bool>(&world, "has_chunk", json!({ "sha256": hex_sha(b"<p>one</p>") })).await?);

    let missing_promote = send(
        &world,
        &world.contract_id,
        "promote",
        json!({ "id": "9" }),
        yocto,
        gas,
    )
    .await;
    expect_panic(missing_promote, "release missing");

    let no_deposit_promote = send(
        &world,
        &world.contract_id,
        "promote",
        json!({ "id": "1" }),
        NearToken::from_yoctonear(0),
        gas,
    )
    .await;
    expect_panic(no_deposit_promote, "yoctoNEAR");

    let outsider_promote = send(
        &world,
        &world.outsider_id,
        "promote",
        json!({ "id": "1" }),
        yocto,
        gas,
    )
    .await;
    expect_panic(outsider_promote, "only this account");

    send(&world, &world.contract_id, "promote", json!({ "id": "1" }), yocto, gas)
        .await
        .expect("promote 1");
    let already = send(&world, &world.contract_id, "promote", json!({ "id": "1" }), yocto, gas).await;
    expect_panic(already, "already production");
    send(&world, &world.contract_id, "promote", json!({ "id": "2" }), yocto, gas)
        .await
        .expect("promote 2");

    let production: Option<String> = view(&world, "get_production", json!({})).await?;
    assert_eq!(production.as_deref(), Some("2"));
    let previous: Option<String> = view(&world, "get_previous", json!({})).await?;
    assert_eq!(previous.as_deref(), Some("1"));

    send(&world, &world.contract_id, "rollback", json!({}), yocto, gas)
        .await
        .expect("rollback");
    let production: Option<String> = view(&world, "get_production", json!({})).await?;
    assert_eq!(production.as_deref(), Some("1"));

    let keep: Status = view(&world, "get_status", json!({})).await?;
    let delete_prod = send(&world, &world.contract_id, "delete", json!({ "id": "1" }), yocto, gas).await;
    expect_panic(delete_prod, "cannot delete production");
    send(&world, &world.contract_id, "delete", json!({ "id": "2" }), yocto, gas)
        .await
        .expect("delete previous");
    let after: Status = view(&world, "get_status", json!({})).await?;
    assert!(after.stored_bytes.parse::<u64>().unwrap() <= keep.stored_bytes.parse::<u64>().unwrap());
    let nothing = send(&world, &world.contract_id, "rollback", json!({}), yocto, gas).await;
    expect_panic(nothing, "nothing to roll back");
    let missing_delete = send(&world, &world.contract_id, "delete", json!({ "id": "2" }), yocto, gas).await;
    expect_panic(missing_delete, "release missing");

    seal_page(&world, "3", "<p>three</p><p>spa</p>", "third", true).await;
    let page: ReleasePage = view(&world, "list_releases", json!({ "from_index": 0, "limit": 1 })).await?;
    assert_eq!(page.releases.len(), 1);
    assert_eq!(page.releases[0].id, "1");
    assert_eq!(page.releases[0].file_count, 1);
    assert_eq!(page.releases[0].message, "first");
    assert_eq!(page.next, Some(1));
    let history: HistoryPage = view(&world, "list_history", json!({ "from_index": 0, "limit": 20 })).await?;
    assert!(history.entries.iter().any(|entry| entry.kind == "promote" && entry.release_id == "1"));
    assert!(history.entries.iter().any(|entry| entry.kind == "rollback"));

    let home: Web4 = view(&world, "web4_get", json!({ "request": { "path": "/" } })).await?;
    assert_eq!(home.status, Some(200));
    assert_eq!(home.cache_control.as_deref(), Some("public, max-age=0, must-revalidate"));
    let body = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(home.body.unwrap())?)?;
    assert!(body.contains("<p>one</p>"));
    let preview: Web4 = view(&world, "web4_get", json!({ "request": { "path": "/r/3/" } })).await?;
    assert_eq!(preview.cache_control.as_deref(), Some("public, max-age=31536000, immutable"));
    let spa: Web4 = view(&world, "web4_get", json!({ "request": { "path": "/r/3/missing" } })).await?;
    assert_eq!(spa.status, Some(200));
    let missing: Web4 = view(&world, "web4_get", json!({ "request": { "path": "/nope" } })).await?;
    assert_eq!(missing.status, Some(404));

    let cheap = send(
        &world,
        &world.outsider_id,
        "buy",
        json!({ "memo": "short" }),
        NearToken::from_yoctonear(1),
        gas,
    )
    .await;
    expect_panic(cheap, "buy needs at least 0.01 NEAR");
    send(
        &world,
        &world.outsider_id,
        "buy",
        json!({ "memo": "storage" }),
        NearToken::from_millinear(10),
        gas,
    )
    .await
    .expect("buy");
    let sales: Vec<Value> = view(&world, "get_sales", json!({})).await?;
    assert_eq!(sales.len(), 1);
    assert_eq!(sales[0]["buyer"], "outsider.sandbox");

    let (orphan_hash, orphan_data) = chunk_of("<p>orphan</p>");
    send(
        &world,
        &world.contract_id,
        "put_chunk",
        json!({ "sha256": orphan_hash, "data": orphan_data }),
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(100),
    )
    .await
    .expect("orphan chunk");
    send(
        &world,
        &world.contract_id,
        "drop_chunk",
        json!({ "sha256": orphan_hash }),
        yocto,
        gas,
    )
    .await
    .expect("drop orphan");
    assert!(!view::<bool>(&world, "has_chunk", json!({ "sha256": orphan_hash })).await?);

    let budget: Value = view(&world, "get_budget", json!({})).await?;
    assert_eq!(budget["max_bytes"], "2000000");
    let detail: Value = view(&world, "get_release", json!({ "id": "3" })).await?;
    assert_eq!(detail["message"], "third");
    assert_eq!(detail["file_count"], 1);
    assert_eq!(detail["spa"], true);
    Ok(())
}
