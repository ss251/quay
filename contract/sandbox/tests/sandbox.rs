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
        ._sandbox
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
    call(&world, &bob, "join", json!({ "name": "alice", "public_key": key }), 0).await.expect("join");
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
