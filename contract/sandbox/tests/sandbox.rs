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
    /// Owned, so the node is killed when the test ends (pass or panic).
    sandbox: near_sandbox::Sandbox,
}

/// `QUAY_WASM` overrides the vendored wasm, so a fresh build can be tested
/// before it is copied to `cli/vendor/quay.wasm`.
fn wasm_path() -> PathBuf {
    match std::env::var("QUAY_WASM") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../cli/vendor/quay.wasm"),
    }
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
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
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
        sandbox,
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
    assert_eq!(version["version"], "3.0.0");
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
    assert_eq!(status.version, "3.0.0");
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

// ------------------------------------------------------------------ v3

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = NEAR / 1000;

async fn balance(world: &World, account: &AccountId) -> TestResult<u128> {
    let view = near_api::Account(account.clone()).view().fetch_from(&world.network).await?;
    Ok(view.data.amount.as_yoctonear())
}

async fn make_account(world: &World, name: &str, near: u128) -> TestResult<AccountId> {
    let id: AccountId = name.parse()?;
    world
        .sandbox
        .create_account(id.as_str().parse().expect("account id"))
        .initial_balance(NearToken::from_yoctonear(near * NEAR))
        .send()
        .await?;
    Ok(id)
}

async fn call(world: &World, who: &AccountId, method: &str, args: Value, deposit: u128) -> Result<String, String> {
    send(world, who, method, args, NearToken::from_yoctonear(deposit), NearGas::from_tgas(100)).await
}

async fn put_files(world: &World, files: &[(&str, &str)]) -> Vec<Value> {
    let mut out = Vec::new();
    for (path, body) in files {
        let (hash, data) = chunk_of(body);
        send(world, &world.contract_id, "put_chunk", json!({ "sha256": hash, "data": data }), NearToken::from_yoctonear(0), NearGas::from_tgas(100))
            .await
            .unwrap_or_else(|text| panic!("put_chunk {path}: {text}"));
        out.push(json!({ "path": path, "chunks": [hash], "content_type": "text/html; charset=utf-8" }));
    }
    out
}

fn full(result: near_api::types::transaction::result::TransactionResult) -> Box<near_api::types::transaction::result::ExecutionFinalResult> {
    match result {
        near_api::types::transaction::result::TransactionResult::Full(full) => full,
        other => panic!("transaction pending: {other:?}"),
    }
}

fn decode(web4: &Web4) -> String {
    String::from_utf8(base64::engine::general_purpose::STANDARD.decode(web4.body.clone().unwrap()).unwrap()).unwrap()
}

#[tokio::test]
async fn db_writes_refund_real_balances_and_failures_leave_no_state() -> TestResult {
    let world = world().await?;
    let site = world.contract_id.clone();
    let alice = make_account(&world, "alice.sandbox", 10).await?;
    let rules = json!({ "write": "anyone", "max_doc_bytes": 4096, "moderated": true, "payer": "writer" });
    call(&world, &site, "set_collection", json!({ "name": "posts", "rules": rules }), 1).await.expect("set_collection");
    let no_yocto = call(&world, &site, "set_collection", json!({ "name": "posts", "rules": rules }), 0).await;
    expect_panic(no_yocto, "yoctoNEAR");

    // A short deposit fails and leaves nothing behind.
    let short = call(&world, &alice, "db_add", json!({ "collection": "posts", "data": "{\"t\":\"x\"}" }), 1).await;
    expect_panic(short, "attach at least");
    let coll: Value = view(&world, "get_collection", json!({ "name": "posts" })).await?;
    assert_eq!(coll["count"], "0");
    assert_eq!(coll["next_seq"], "1");
    let none: Option<Value> = view(&world, "db_get", json!({ "collection": "posts", "id": "1" })).await?;
    assert!(none.is_none());

    let before = balance(&world, &alice).await?;
    let attached = 100 * MILLI;
    call(&world, &alice, "db_add", json!({ "collection": "posts", "data": "{\"title\":\"hello from the sandbox\"}" }), attached)
        .await
        .expect("db_add");
    let doc: Value = view(&world, "db_get", json!({ "collection": "posts", "id": "1" })).await?;
    let deposit: u128 = doc["deposit"].as_str().unwrap().parse()?;
    assert!(deposit > 0 && deposit < 5 * MILLI, "deposit {deposit}");
    let after_add = balance(&world, &alice).await?;
    let spent = before - after_add;
    // The excess came back: alice paid the deposit plus gas, not the 0.1 NEAR attached.
    assert!(spent >= deposit && spent < deposit + 3 * MILLI, "spent {spent}, deposit {deposit}");

    // A moderator removal refunds alice, not the site.
    call(&world, &site, "db_remove", json!({ "collection": "posts", "id": "1" }), 0).await.expect("db_remove");
    let after_remove = balance(&world, &alice).await?;
    assert_eq!(after_remove - after_add, deposit, "alice gets exactly her deposit back");
    let gone: Option<Value> = view(&world, "db_get", json!({ "collection": "posts", "id": "1" })).await?;
    assert!(gone.is_none());

    // Site-paid: an empty pool refuses with no partial state; a funded pool pays.
    let site_rules = json!({ "write": "anyone", "max_doc_bytes": 512, "moderated": true, "payer": "site", "max_docs_per_account": 1 });
    call(&world, &site, "set_collection", json!({ "name": "guestbook", "rules": site_rules }), 1).await.expect("guestbook");
    let empty = call(&world, &alice, "db_add", json!({ "collection": "guestbook", "data": "{}" }), 0).await;
    expect_panic(empty, "storage pool is empty");
    let gb: Value = view(&world, "get_collection", json!({ "name": "guestbook" })).await?;
    assert_eq!(gb["count"], "0");
    call(&world, &alice, "db_fund", json!({}), 50 * MILLI).await.expect("db_fund");
    let before = balance(&world, &alice).await?;
    call(&world, &alice, "db_add", json!({ "collection": "guestbook", "data": "{\"m\":\"hi\"}" }), 0).await.expect("site-paid add");
    let after = balance(&world, &alice).await?;
    assert!(before - after < 2 * MILLI, "the writer paid only gas");
    let pool: Value = view(&world, "get_pool", json!({})).await?;
    let reserved: u128 = pool["reserved"].as_str().unwrap().parse()?;
    assert!(reserved > 0);
    let capped = call(&world, &alice, "db_add", json!({ "collection": "guestbook", "data": "{}" }), 0).await;
    expect_panic(capped, "doc limit reached");
    let page: Value = view(&world, "db_list", json!({ "collection": "guestbook" })).await?;
    assert_eq!(page["docs"].as_array().unwrap().len(), 1);
    Ok(())
}

#[tokio::test]
async fn join_creates_a_zero_balance_member_account() -> TestResult {
    let world = world().await?;
    let bob = make_account(&world, "bob.sandbox", 10).await?;
    let key = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
    let paid = call(&world, &bob, "join", json!({ "name": "alice", "public_key": key }), 1).await;
    expect_panic(paid, "doesn't accept deposit");
    let reserved = call(&world, &bob, "join", json!({ "name": "relay", "public_key": key }), 0).await;
    expect_panic(reserved, "reserved");
    // A visitor's member record is paid from the pool.
    let unfunded = call(&world, &bob, "join", json!({ "name": "alice", "public_key": key }), 0).await;
    expect_panic(unfunded, "storage pool is empty");
    call(&world, &bob, "db_fund", json!({}), 50 * MILLI).await.expect("db_fund");
    call(&world, &bob, "join", json!({ "name": "alice", "public_key": key }), 0).await.expect("join");
    let pool: Value = view(&world, "get_pool", json!({})).await?;
    let reserved_yocto: u128 = pool["reserved"].as_str().unwrap().parse()?;
    let balance_yocto: u128 = pool["balance"].as_str().unwrap().parse()?;
    assert!(reserved_yocto > 0 && reserved_yocto <= 3 * MILLI, "the record holds {reserved_yocto}");
    assert_eq!(reserved_yocto + balance_yocto, 50 * MILLI, "the rest went back to the pool");
    let member: AccountId = "alice.quay.sandbox".parse()?;
    assert_eq!(balance(&world, &member).await?, 0, "a zero-balance account");
    assert!(view::<bool>(&world, "is_member", json!({ "account": member })).await?);
    let page: Value = view(&world, "list_members", json!({ "from_index": 0, "limit": 10 })).await?;
    assert_eq!(page["members"], json!(["alice.quay.sandbox"]));
    // The account exists now, so a second join for the name is refused.
    let again = call(&world, &bob, "join", json!({ "name": "alice", "public_key": key }), 0).await;
    expect_panic(again, "already a member");
    // The callback is private.
    let forged = call(&world, &bob, "on_join", json!({ "account": "evil.quay.sandbox" }), 0).await;
    expect_panic(forged, "private");
    call(&world, &world.contract_id, "set_members_open", json!({ "open": false }), 1).await.expect("close");
    let closed = call(&world, &bob, "join", json!({ "name": "carol", "public_key": key }), 0).await;
    expect_panic(closed, "members are closed");
    Ok(())
}

#[tokio::test]
async fn routed_pages_render_within_gas_and_payments_work() -> TestResult {
    let world = world().await?;
    let site = world.contract_id.clone();
    let alice = make_account(&world, "alice.sandbox", 20).await?;
    let token = make_account(&world, "token.sandbox", 5).await?;
    call(&world, &site, "set_collection", json!({ "name": "posts", "rules": { "write": "anyone", "max_doc_bytes": 4096, "moderated": true, "payer": "writer" } }), 1)
        .await
        .expect("posts");
    let files = put_files(
        &world,
        &[
            ("index.html", "<p>home</p>"),
            ("post.html", "<h1>{{doc.data.title}}</h1>{{> foot.html}}"),
            ("list.html", "<ul>{{#each docs}}<li>{{data.title}} {{created | date}}</li>{{/each}}</ul>{{#if next}}<a href=\"?from={{next}}\">more</a>{{/if}}"),
            ("foot.html", "<footer>{{site.account}}</footer>"),
        ],
    )
    .await;
    send(
        &world,
        &site,
        "seal",
        json!({
            "id": "1", "message": "routed", "spa": false, "files": files,
            "routes": [
                { "pattern": "/posts/:id", "kind": "doc", "collection": "posts", "template": "post.html" },
                { "pattern": "/posts", "kind": "list", "collection": "posts", "template": "list.html" },
                { "pattern": "/api/:collection", "kind": "json", "collection": "posts" }
            ]
        }),
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(150),
    )
    .await
    .expect("seal with routes");
    call(&world, &site, "promote", json!({ "id": "1" }), 1).await.expect("promote");
    for n in 1..=20 {
        let data = json!({ "title": format!("<post {n}> {}", "x".repeat(300)) }).to_string();
        call(&world, &alice, "db_add", json!({ "collection": "posts", "data": data }), 50 * MILLI).await.expect("add");
    }

    let doc: Web4 = view(&world, "web4_get", json!({ "request": { "accountId": null, "path": "/posts/3", "query": {}, "preloads": {} } })).await?;
    assert_eq!(doc.status, Some(200));
    let html = decode(&doc);
    assert!(html.starts_with("<h1>&lt;post 3&gt;"), "{html}");
    assert!(html.ends_with("<footer>quay.sandbox</footer>"));
    let list: Web4 = view(&world, "web4_get", json!({ "request": { "path": "/posts", "query": { "from": ["20"] } } })).await?;
    let html = decode(&list);
    assert_eq!(html.matches("<li>").count(), 20);
    assert_eq!(list.cache_control.as_deref(), Some("public, max-age=0, must-revalidate"));
    let api: Web4 = view(&world, "web4_get", json!({ "request": { "path": "/api/posts" } })).await?;
    let page: Value = serde_json::from_str(&decode(&api))?;
    assert_eq!(page["docs"].as_array().unwrap().len(), 20);

    // The same 20-doc page as a transaction, to read the gas it burns.
    let outcome = contract(&world)
        .call_function("web4_get", json!({ "request": { "path": "/posts" } }))
        .transaction()
        .gas(NearGas::from_tgas(300))
        .with_signer(alice.clone(), world.signer.clone())
        .send_to(&world.network)
        .await?;
    let outcome = full(outcome);
    assert!(outcome.is_success());
    let burnt = outcome.total_gas_burnt.as_gas();
    println!("web4_get /posts (20 docs) burnt {} Tgas", burnt as f64 / 1e12);
    assert!(burnt < NearGas::from_tgas(50).as_gas(), "burnt {burnt}");

    // Payments: NEAR with an excess refund, then a token transfer callback.
    call(&world, &site, "set_product", json!({ "id": "pin", "product": { "name": "Pin for a day", "price_yocto": (100 * MILLI).to_string(), "price_token": "1000", "grant": "pin", "pin_seconds": 86400 } }), 1)
        .await
        .expect("set_product");
    let before = balance(&world, &alice).await?;
    call(&world, &alice, "pay", json!({ "product": "pin", "ref": "posts/3" }), NEAR).await.expect("pay");
    let after = balance(&world, &alice).await?;
    assert!(before - after >= 100 * MILLI && before - after < 103 * MILLI, "paid {}", before - after);
    assert!(view::<bool>(&world, "has_paid", json!({ "account": alice, "product": "pin", "ref": "posts/3" })).await?);
    let pinned: Value = view(&world, "db_get", json!({ "collection": "posts", "id": "3" })).await?;
    assert!(pinned["pinned_until"].is_string());
    let receipts: Value = view(&world, "list_receipts", json!({})).await?;
    assert_eq!(receipts["receipts"][0]["token"], "near");

    // `ft_on_transfer` called by the configured token account. A full NEP-141
    // mock lives with the functions mock; this checks the JSON shape and refusals.
    call(&world, &site, "set_token", json!({ "account": token }), 1).await.expect("set_token");
    call(&world, &alice, "db_fund", json!({}), 100 * MILLI).await.expect("fund");
    let msg = json!({ "product": "pin", "ref": "posts/4" }).to_string();
    let wrong = contract(&world)
        .call_function("ft_on_transfer", json!({ "sender_id": alice, "amount": "1500", "msg": msg }))
        .transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(alice.clone(), world.signer.clone())
        .send_to(&world.network)
        .await?;
    assert_eq!(full(wrong).json::<String>()?, "1500", "a wrong token gets everything back");
    let right = contract(&world)
        .call_function("ft_on_transfer", json!({ "sender_id": alice, "amount": "1500", "msg": msg }))
        .transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(token.clone(), world.signer.clone())
        .send_to(&world.network)
        .await?;
    assert_eq!(full(right).json::<String>()?, "500", "the excess over the price is unused");
    assert!(view::<bool>(&world, "has_paid", json!({ "account": alice, "product": "pin", "ref": "posts/4" })).await?);
    Ok(())
}

// ------------------------------------------------------------------ functions, cron, NEP-141

/// `contract/sandbox/mock` built with `cargo near build non-reproducible-wasm`
/// and copied to `mock/res/quay_mock.wasm`.
fn mock_wasm() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("mock/res/quay_mock.wasm")
}

async fn deploy_mock(world: &World, name: &str) -> TestResult<AccountId> {
    let id = make_account(world, name, 10).await?;
    Contract::deploy(id.clone())
        .use_code(std::fs::read(mock_wasm())?)
        .with_init_call("new", json!({}))?
        .with_signer(world.signer.clone())
        .send_to(&world.network)
        .await?
        .assert_success();
    Ok(id)
}

async fn call_gas(world: &World, who: &AccountId, receiver: &AccountId, method: &str, args: Value, deposit: u128, tgas: u64) -> TestResult<Box<near_api::types::transaction::result::ExecutionFinalResult>> {
    let result = Contract(receiver.clone())
        .call_function(method, args)
        .transaction()
        .gas(NearGas::from_tgas(tgas))
        .deposit(NearToken::from_yoctonear(deposit))
        .with_signer(who.clone(), world.signer.clone())
        .send_to(&world.network)
        .await
        .map_err(|error| format!("{method}: {error:?}"))?;
    Ok(full(result))
}

#[tokio::test]
async fn functions_triggers_and_tokens_with_mock_contracts() -> TestResult {
    let world = world().await?;
    let site = world.contract_id.clone();
    let alice = make_account(&world, "alice.sandbox", 20).await?;
    let mock = deploy_mock(&world, "mock.sandbox").await?;
    call(&world, &site, "set_outlayer", json!({ "account": mock }), 1).await.expect("set_outlayer");
    call(&world, &site, "fn_set", json!({ "name": "echo", "spec": { "project": "quay.sandbox/echo", "call": "anyone", "payer": "caller", "deposit": (MILLI).to_string(), "secrets": true } }), 1)
        .await
        .expect("fn_set");

    // fn_call: the output is the transaction result and lands in `_fn`.
    let out = call_gas(&world, &alice, &site, "fn_call", json!({ "name": "echo", "input": "{\"hello\":\"world\"}" }), 10 * MILLI, 300).await?;
    assert!(out.is_success(), "{out:?}");
    let value: Value = out.json()?;
    assert_eq!(value["echo"]["hello"], "world");
    assert_eq!(value["project"], "quay.sandbox/echo");
    assert_eq!(value["deposit"], MILLI.to_string(), "OutLayer gets the spec deposit; the excess was refunded");
    let requests: Vec<String> = Contract(mock.clone()).call_function("get_requests", json!({})).read_only().fetch_from(&world.network).await?.data;
    let request: Value = serde_json::from_str(&requests[0])?;
    assert_eq!(request["resource_limits"]["max_memory_mb"], 128);
    assert_eq!(request["payer_account_id"], "alice.sandbox");
    assert_eq!(request["secrets_ref"]["account_id"], "quay.sandbox");
    // The result needs pool storage; the pool was empty, so nothing was stored yet.
    call(&world, &alice, "db_fund", json!({}), 200 * MILLI).await.expect("fund");
    let out = call_gas(&world, &alice, &site, "fn_call", json!({ "name": "echo", "input": "{\"n\":2}" }), 10 * MILLI, 300).await?;
    assert_eq!(out.json::<Value>()?["echo"]["n"], 2);
    let results: Value = view(&world, "fn_results", json!({ "query": { "prefix": "echo-" } })).await?;
    assert_eq!(results["docs"][0]["id"], "echo-2");
    assert_eq!(results["docs"][0]["data"]["ok"], true);

    // A refused request: the deposit comes back to the caller.
    let before = balance(&world, &alice).await?;
    let out = call_gas(&world, &alice, &site, "fn_call", json!({ "name": "echo", "input": "{\"panic\":true}" }), 50 * MILLI, 300).await?;
    assert_eq!(out.json::<Value>()?, Value::Null);
    let after = balance(&world, &alice).await?;
    assert!(before - after < 10 * MILLI, "the 0.05 NEAR deposit was refunded, spent {}", before - after);
    let failed: Value = view(&world, "db_get", json!({ "collection": "_fn", "id": "echo-3" })).await?;
    assert_eq!(failed["data"]["error"], "request failed");
    // A forged callback is refused.
    let forged = call(&world, &alice, "fn_on_result", json!({ "name": "echo", "request": "x", "caller": alice, "deposit": "0" }), 0).await;
    expect_panic(forged, "private");

    // on_add trigger: runs from the pool, stores the output on the doc, hides it.
    call(&world, &site, "fn_set", json!({ "name": "moderate", "spec": { "project": "quay.sandbox/moderate", "call": "owner", "payer": "site" } }), 1)
        .await
        .expect("fn_set moderate");
    call(&world, &site, "set_collection", json!({ "name": "posts", "rules": { "write": "anyone", "max_doc_bytes": 2000, "moderated": true, "payer": "site", "on_add": "moderate" } }), 1)
        .await
        .expect("posts");
    let low = call(&world, &alice, "db_add", json!({ "collection": "posts", "data": "{\"t\":\"x\"}" }), 0).await;
    expect_panic(low, "150 Tgas");
    let ok = call_gas(&world, &alice, &site, "db_add", json!({ "collection": "posts", "data": "{\"t\":\"fine\"}" }), 0, 300).await?;
    assert_eq!(ok.json::<String>()?, "1");
    assert!(call_gas(&world, &alice, &site, "db_add", json!({ "collection": "posts", "data": "{\"t\":\"spam\",\"hide\":true}" }), 0, 300).await?.is_success());
    let fine: Value = view(&world, "db_get", json!({ "collection": "posts", "id": "1" })).await?;
    assert_eq!(fine["fn"]["echo"]["data"]["t"], "fine");
    assert_eq!(fine["hidden"], false);
    let spam: Value = view(&world, "db_get", json!({ "collection": "posts", "id": "2" })).await?;
    assert_eq!(spam["hidden"], true);
    assert_eq!(spam["fn"]["hide"], true);

    // NEP-141: ft_transfer_call through the mock token, with the unused part returned.
    call(&world, &site, "set_product", json!({ "id": "pin", "product": { "name": "Pin", "price_token": "1000", "grant": "pin", "pin_seconds": 3600 } }), 1)
        .await
        .expect("product");
    call(&world, &site, "set_token", json!({ "account": mock }), 1).await.expect("token");
    assert!(call_gas(&world, &alice, &mock, "mint", json!({ "account": alice, "amount": "10000" }), 0, 30).await?.is_success());
    let used = call_gas(&world, &alice, &mock, "ft_transfer_call", json!({ "receiver_id": site, "amount": "1500", "msg": "{\"product\":\"pin\",\"ref\":\"posts/1\"}" }), 1, 200).await?;
    assert_eq!(used.json::<String>()?, "1000");
    let tokens: String = Contract(mock.clone()).call_function("ft_balance_of", json!({ "account_id": alice })).read_only().fetch_from(&world.network).await?.data;
    assert_eq!(tokens, "9000");
    assert!(view::<bool>(&world, "has_paid", json!({ "account": alice, "product": "pin", "ref": "posts/1" })).await?);
    let refused = call_gas(&world, &alice, &mock, "ft_transfer_call", json!({ "receiver_id": site, "amount": "1500", "msg": "{\"product\":\"nope\"}" }), 1, 200).await?;
    assert_eq!(refused.json::<String>()?, "0");
    let tokens: String = Contract(mock.clone()).call_function("ft_balance_of", json!({ "account_id": alice })).read_only().fetch_from(&world.network).await?.data;
    assert_eq!(tokens, "9000", "a refused payment returns every token");
    Ok(())
}

#[tokio::test]
async fn cron_chain_ticks_runs_a_job_and_kicks() -> TestResult {
    let world = world().await?;
    let site = world.contract_id.clone();
    let alice = make_account(&world, "alice.sandbox", 20).await?;
    let mock = deploy_mock(&world, "mock.sandbox").await?;
    call(&world, &site, "set_outlayer", json!({ "account": mock }), 1).await.expect("set_outlayer");
    call(&world, &site, "fn_set", json!({ "name": "digest", "spec": { "project": "quay.sandbox/digest", "call": "owner", "payer": "site", "deposit": MILLI.to_string() } }), 1)
        .await
        .expect("fn_set");
    call(&world, &site, "cron_set", json!({ "name": "hourly", "job": { "every_minutes": 60, "fn": "digest", "input": "{\"kind\":\"digest\"}" } }), 1)
        .await
        .expect("cron_set");
    call(&world, &alice, "db_fund", json!({}), 200 * MILLI).await.expect("fund");
    // The arm transaction never reaches final status: its yield chain keeps
    // going. Send it without waiting for finality, then read the status.
    let _included = Contract(site.clone())
        .call_function("cron_arm", json!({}))
        .transaction()
        .gas(NearGas::from_tgas(300))
        .with_signer(alice.clone(), world.signer.clone())
        .wait_until(near_api::types::TxExecutionStatus::Included)
        .send_to(&world.network)
        .await?;
    let mut status = Value::Null;
    for _ in 0..40 {
        status = view(&world, "cron_status", json!({})).await?;
        if status["armed"] == true {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert_eq!(status["armed"], true, "{status}");
    assert_eq!(status["pending"], true);
    let again = call(&world, &alice, "cron_arm", json!({}), 0).await;
    expect_panic(again, "already armed");
    let early = call(&world, &alice, "cron_kick", json!({}), 0).await;
    expect_panic(early, "kicked too soon");

    // Let the yield time out: the tick runs the due job and yields again.
    world.sandbox.fast_forward(250).await?;
    let mut ticked = Value::Null;
    for _ in 0..60 {
        ticked = view(&world, "cron_status", json!({})).await?;
        let results: Value = view(&world, "fn_results", json!({ "query": { "prefix": "digest-" } })).await?;
        if ticked["hops"] != "0" && !results["docs"].as_array().unwrap().is_empty() {
            assert_eq!(results["docs"][0]["data"]["output"]["echo"]["kind"], "digest");
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    assert_ne!(ticked["hops"], "0", "{ticked}");
    let jobs: Value = view(&world, "cron_list", json!({})).await?;
    assert!(jobs[0]["last_run"].is_string());
    println!("cron after one hop: {ticked}");

    // A kick resumes the pending yield once the cooldown has passed.
    world.sandbox.fast_forward(100).await?;
    let status: Value = view(&world, "cron_status", json!({})).await?;
    if status["pending"] == true {
        let kick = call(&world, &alice, "cron_kick", json!({}), 0).await;
        match kick {
            Ok(_) => {}
            Err(text) => assert!(text.contains("kicked too soon") || text.contains("already run"), "{text}"),
        }
    }
    Ok(())
}
