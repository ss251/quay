# Quay full-stack interface (v3)

Status: **frozen for implementation** on 2026-11-10 unless a section says *pending*. Streams build against this file. A change here is announced to every stream.

Contract version string `3.0.0`, standard `quay`, state version `3`. v3 keeps every v2 method and view with the same JSON. New features live in new storage maps next to the v2 data, so v2 types (`Release`, `StoredFile`) keep their borsh layout. `migrate(ids)` accepts v1, v2 or v3 state and returns v3.

JSON rules from v2 still hold: snake_case args, `U64`/`U128` as decimal strings, timestamps in nanoseconds, NEP-297 events with `"standard":"quay","version":"3.0.0"`.

Roles:

- **site owner**: the contract account itself (`predecessor == current_account_id`). Config changes need exactly 1 yoctoNEAR, so a publish-only function-call key cannot change rules, prices or functions.
- **writer**: any account that calls a db write. Its rights come from the collection rules.
- **member**: an account named `<name>.<site>`. `join` creates one.

## 1. Data (`quay db`)

### Collections

A collection name is 1 to 32 bytes of `[a-z0-9_-]`, not starting with `_` (reserved for system collections such as `_receipts`).

```jsonc
// CollectionRules
{
  "write": "owner" | "anyone" | "members",  // who may add
  "max_doc_bytes": 4096,                       // 1..=16384, size of the data JSON text
  "moderated": true,                           // site owner may hide or remove any doc
  "payer": "writer" | "site",                  // who pays storage for a new doc
  "max_docs_per_account": 50,                  // optional cap per writer, null = none
  "on_add": "moderate"                         // optional function name run on every add (section 3), null = none
}
```

| Method | Who | Deposit | Effect |
| --- | --- | --- | --- |
| `set_collection(name, rules)` | site owner | 1 yocto | create or update rules. Existing docs stay. Emits `collection_set`. |
| `drop_collection(name)` | site owner | 1 yocto | only when the collection has no docs. |
| `get_collection(name) -> Option<CollectionView>` | view | | rules plus `count`, `bytes`, `next_seq`. |
| `list_collections() -> Vec<CollectionView>` | view | | at most 32 collections per site. |

### Documents

A doc id is 1 to 64 bytes of `[A-Za-z0-9_-]`. When the writer passes no id, the id is the doc's sequence number in decimal (`"1"`, `"2"`, …). The data is a JSON **object**, sent as its JSON text (`data: "{\"title\":\"…\"}"`) and validated by the contract. Its text length counts against `max_doc_bytes`.

```jsonc
// DocView
{
  "collection": "posts",
  "id": "12",
  "seq": "12",                 // U64, creation order
  "owner": "alice.board.testnet",
  "created": "1731283200000000000",
  "updated": "1731283200000000000",
  "data": { "title": "…" },    // parsed object
  "hidden": false,
  "pinned_until": null,        // U64 ns or null (section 9)
  "fn": null,                  // last function result merged by an on_add trigger (section 3), object or null
  "deposit": "1230000000000000000000"  // U128 yocto held for this doc's storage
}
```

| Method | Who | Deposit | Effect |
| --- | --- | --- | --- |
| `db_add(collection, id?, data) -> String` | per `write` rule | storage (writer pays) or 0 (site pays) | returns the id. Fails on an existing id. Emits `doc_added`. |
| `db_update(collection, id, data)` | doc owner | storage growth, else 0 | replaces data, refunds shrinkage to whoever paid. Emits `doc_updated`. |
| `db_remove(collection, id)` | doc owner, or site owner when `moderated` | 0 | deletes, refunds the doc's deposit to whoever paid it. Emits `doc_removed`. |
| `db_hide(collection, id, hidden)` | site owner when `moderated` | 1 yocto | hidden docs are left out of lists and routes unless asked for. Emits `doc_hidden`. |
| `db_get(collection, id) -> Option<DocView>` | view | | |
| `db_list(collection, query) -> DocPage` | view | | see below |
| `db_fund()` | anyone | ≥ 0.01 NEAR | adds to the site storage pool. Emits `pool_funded`. |
| `db_withdraw(amount)` | site owner | 1 yocto | takes unused pool NEAR back. |
| `get_pool() -> { balance, reserved }` | view | | `reserved` is what site-paid docs hold. |

```jsonc
// db_list query, every field optional
{ "from": "40", "limit": 20, "order": "desc", "owner": "alice.board.testnet", "prefix": "harbour-", "include_hidden": false, "pinned_first": false }
// DocPage
{ "docs": [DocView], "next": "21" }   // next = cursor (a seq) for the following page, or null
```

`limit` is 1 to 50 (default 20). Listing walks sequence numbers from `from` in `order` and skips deleted, hidden and non-matching docs. One call probes at most 200 sequence numbers; when it stops early it still returns `next`, so a page can hold fewer docs than `limit` without being the end. `prefix` matches the doc id.

**Storage accounting.** The contract measures `env::storage_usage()` before and after each write and prices the difference at `env::storage_byte_cost()`.

- `payer: "writer"`: the attached deposit must cover the cost. The excess is refunded to the writer in the same call. The cost is recorded as the doc's `deposit`. Growth on update is charged the same way; shrinkage and removal refund the writer.
- `payer: "site"`: the attached deposit must be 0. The cost is taken from the pool (`db_fund`), and the call fails with `storage pool is empty` when the pool cannot cover it. Removal returns the deposit to the pool. Because the writer pays nothing, this is the mode that works for a relayed visitor with zero NEAR.
- A refund is a transfer to the account that paid. Removal by a moderator still refunds the writer, not the moderator.

**Events** (`data` items): `collection_set {name}`, `doc_added {collection, id, owner, bytes}`, `doc_updated {collection, id, bytes}`, `doc_removed {collection, id, by, refund}`, `doc_hidden {collection, id, hidden}`, `pool_funded {by, yocto}`.

## 2. Members and sign-in

| Method | Who | Deposit | Effect |
| --- | --- | --- | --- |
| `join(name, public_key)` | anyone while `members_open`, else site owner | 0 | creates `<name>.<site>` with one full-access key and **no NEAR** (a zero-balance account under 770 bytes). On success records the member and emits `member_joined {account}`. |
| `set_members_open(open)` | site owner | 1 yocto | default `true`. |
| `list_members(from_index, limit) -> { members, next }` | view | | oldest first. |
| `is_member(account) -> bool` | view | | true for any `<name>.<site>` account the contract created. |

`name` is 2 to 32 bytes of `[a-z0-9_-]`, not `relay`, `admin`, `www`, `api` or `quay`.

Sign-in is off chain (NEP-413, section 5). It needs no contract method.

## 3. Functions (`quay functions`)

Functions run on OutLayer (`outlayer.testnet`): WASI wasm in TEE workers, paid in NEAR from a contract, or over HTTPS with a payment key. Spike (a) proved both on testnet on 2026-11-10.

**Code.** A function is a Rust crate built for `wasm32-wasip2` (outbound HTTP needs WASI P2 `wasi:http`). It reads its input JSON on stdin and writes its output JSON on stdout. Secrets arrive as environment variables. The guest helper crate is `functions/quay-fn` (input/output, secrets, HTTP GET/POST, NEP-413 sign-in verification). OutLayer has no JavaScript guest runtime, so JS/TS functions are not offered.

**Where the wasm lives.** OutLayer fetches code from any public HTTPS URL and checks its sha256. `quay functions deploy` uploads the wasm to FastFS (`https://test.fastfs.io/<account>/<receiver>/<sha256>.wasm`, gas only, no signup) and registers an OutLayer project `<site>/<name>` whose source is that URL. `--store release` instead seals the wasm into the next site release and uses `https://<site>.testnet.page/fn/<name>.wasm` (costs storage: 0.01 NEAR per KB).

**Secrets.** `quay secrets set <name> [--fn <fn>]` reads the value from stdin or a prompt, never from argv, encrypts it on the client (X25519 + HKDF-SHA256 `outlayer-keystore-v1` + ChaCha20-Poly1305, key from `POST /secrets/pubkey`), and stores it with `store_secrets` on `outlayer.testnet` under the project accessor and profile `default`. The `/secrets/pubkey` request carries placeholder values with the real key names, never the real values. Access condition: the site contract as predecessor (contract calls) or the site account as owner (HTTPS calls). `quay secrets list` shows names only. `quay secrets rm` removes the profile.

**Contract registry** (site owner, 1 yocto, like other config):

```jsonc
// FunctionSpec
{ "project": "board-x1.testnet/preview",      // OutLayer project id
  "call": "owner" | "anyone" | "members",     // who may call fn_call
  "payer": "caller" | "site",                  // who attaches the run deposit
  "deposit": "5000000000000000000000",          // U128 yocto per run, default 0.005 NEAR; OutLayer refunds the unused part to the payer
  "max_instructions": "2000000000", "max_seconds": 30,
  "secrets": true }                             // pass secrets_ref {profile: "default", account_id: <site>}
```

| Method | Who | Deposit | Effect |
| --- | --- | --- | --- |
| `fn_set(name, spec)` / `fn_remove(name)` | site owner | 1 yocto | at most 16 functions. Emits `fn_set`. |
| `fn_get(name)`, `fn_list()` | view | | |
| `fn_call(name, input) -> Promise` | per `call` | ≥ `deposit` when `payer: caller`, else 0 | calls `request_execution` on OutLayer with `input` (JSON text, ≤ 4096 bytes), then `fn_on_result`. With `payer: site` the deposit comes from the pool (section 1). Returns the function output JSON as the transaction result. |
| `fn_on_result(...)` | `#[private]` callback | | stores `{name, caller, ok, output, at}` as doc `<request>` in system collection `_fn` (output capped at 16 KB), emits `fn_result {name, request, ok}` |
| `fn_results(query)` | view | | `db_list` over `_fn` |

**Triggers.** A collection with `on_add: "<fn>"` runs that function after every `db_add`, input `{collection, id, owner, data}`, deposit from the pool. The callback stores the output in the doc's `fn` field. If the output contains `"hide": true` and the collection is `moderated`, the doc is hidden. A `db_add` that triggers a function needs about 150 Tgas of prepaid gas.

**The 1024-byte cap.** OutLayer's one-call resume carries at most 1024 bytes; larger outputs switch to a two-call path by themselves (20 KB was returned on testnet). Quay stores at most 16 KB per result. Larger data belongs in a db doc the function writes with its own key, or in the HTTPS answer.

**HTTPS.** `POST https://testnet-api.outlayer.ai/call/<site>/<fn>` with `X-Payment-Key: <owner>:<nonce>:<secret>` and `{"input": {...}, "secrets_ref": {"profile": "default", "account_id": "<site>"}}`. CORS is open. A payment key in a public page can be spent by anyone who reads it, so `quay functions key` makes one scoped to named projects with a small balance, and the docs say so. On testnet it is topped up with `usdc.fakes.testnet` (anyone can mint). `quay.functions.call(name, input)` uses HTTPS when the site publishes a key in `quay.json` → `functions.https_key`, else `fn_call` through the relayer or the wallet.

`quay functions logs <fn>` reads `_fn` results and the payment-key usage history (`GET /public/payment-keys/<owner>/<nonce>/usage`, public). `quay functions invoke <fn> <json>` calls `fn_call` and prints the output and the attestation URL.


## 4. Routes (server-rendered pages and JSON)

A release may declare routes. They are sealed with the release, so `quay rollback` restores files and routes together. Collections, docs and rules are live state and are **not** versioned.

`seal(id, files, message, spa, routes?)`: `routes` is optional (a v2 call still works).

```jsonc
// RouteIn
{
  "pattern": "/posts/:id",      // segments: literal, ":name" (one segment), "*rest" (last, any)
  "kind": "doc" | "list" | "json",
  "collection": "posts",
  "template": "templates/post.html", // a file path in this release; required for doc and list
  "limit": 20,                  // list only
  "order": "desc",              // list only
  "pinned_first": true,         // list only
  "content_type": "text/html; charset=utf-8" // optional override
}
```

`"prefix": "digest-"` (list routes only) keeps docs whose id starts with it. Routes may read the system collections `_receipts` and `_fn` like any collection; writes to them stay contract-only. `_fn` doc ids are `<fn-name>-<n>`, so a `prefix` picks one function's results.

`"also": [{"name": "digest", "collection": "_fn", "prefix": "digest-", "limit": 1, "order": "desc"}]` (doc and list routes, at most 3 entries, `limit` 1 to 10, default 5, `order` default `desc`) loads extra lists next to the route's own data. The template reads them as `lists.<name>`, each an array of `DocView`, hidden docs left out. Each extra list reads at most 50 sequence numbers. That lets `/` show the latest cron digest without client JavaScript.

At most 16 routes per release. `web4_get` checks routes before static files, in declaration order, for both production (`/…`) and previews (`/r/<id>/…`).

- `doc` loads `db_get(collection, params.id)`. Missing or hidden is 404 with the release `404.html` when there is one.
- `list` loads `db_list(collection, {from: query.from, owner: query.owner, limit, order, pinned_first})`.
- `json` with pattern `/api/:collection` serves `DocPage`; with `/api/:collection/:id` serves a `DocView`. A json route answers only for the collection it names, or for any collection when `collection` is `"*"`.

### Templates

A template is a release file. The renderer is small and HTML-escapes by default.

| Syntax | Meaning |
| --- | --- |
| `{{a.b.c}}` | value at that path, HTML-escaped. Missing is empty. |
| `{{a.b \| filter}}` | filters: `date` (ns → `YYYY-MM-DD HH:MM UTC`), `json`, `url` (percent-encode), `lines` (escape, then newlines → `<br>`), `near` (yocto → NEAR, 4 places), `count`. |
| `{{#each list}}…{{/each}}` | inside, names resolve against the item first, then the outer context. `{{@index}}`. |
| `{{#if path}}…{{else}}…{{/if}}`, `{{#unless path}}…{{/unless}}` | truthy: non-empty string, non-zero number, true, non-empty list or object. |
| `{{> path/in/release.html}}` | include another release file, depth at most 4. |

There is no raw (unescaped) output. Context:

```jsonc
{
  "site": { "account": "board.testnet", "release": "7", "host": "https://board.testnet.page" },
  "params": { "id": "12" },
  "query": { "from": "40" },
  "viewer": "alice.testnet",   // accountId the gateway sends, or null
  "doc": DocView,              // doc routes
  "docs": [DocView], "next": "21", // list routes
  "now": "1731283200000000000"
}
```

Routed responses use `Cache-Control: public, max-age=0, must-revalidate` because data changes.

## 5. Client library (`@quay/client`)

Lives in `client/`. ESM, works in a browser and in Node 20+. Reads need no key.

```js
import { connect } from "@quay/client";
const quay = connect({ site: "board.testnet" });          // rpc defaults to https://test.rpc.fastnear.com

await quay.db.collection("posts").list({ limit: 20 });      // DocPage
await quay.db.collection("posts").get("12");                // DocView | null
await quay.db.collection("posts").add({ title: "…" }, { id?, deposit? });   // -> id
await quay.db.collection("posts").update("12", { title: "…" });
await quay.db.collection("posts").remove("12");

await quay.auth.signIn();        // wallet (near-connect) + NEP-413, or a member session key
quay.auth.account;               // "alice.board.testnet" | null
await quay.auth.signOut();
// verifySignIn is exported for Node and functions:
import { verifySignIn } from "@quay/client/verify";

await quay.functions.call("preview", { url: "…" });   // section 3
await quay.pay("pin", { ref: "posts/12" });             // section 9
```

Writes go through, in order: a member session key through the relayer (section 6), or the signed-in wallet.

`add` sends a client-made id (a letter, then 9 base36 characters) unless the caller passes one, so a retry after a timeout cannot add a second doc. The contract still assigns sequence ids (`"1"`, `"2"`, …) to writes that send no id, such as `quay db add` without `--id`.

## 6. Relay

Two hosts serve the same protocol. (1) `quay relay serve` is a small Node process, the one off-chain piece, labelled as such. (2) The relayer as an OutLayer function (`quay relay deploy`): the relayer key is an OutLayer secret, the page calls `POST https://testnet-api.outlayer.ai/call/<site>/relay` with `{"input": {"op": "relay" | "join" | "health", ...}}` and a scoped payment key, and the function signs and sends the transaction over RPC. No server, at the cost of a public payment key (see section 3).

The relayer is its own account (`relay.<site>` by default) with a full-access key and a small NEAR balance. That balance is the hard spend limit. It never holds the site's key.

| Request | Body | Answer |
| --- | --- | --- |
| `POST /relay` | `{"signed_delegate": "<base64 borsh SignedDelegateAction>"}` | `200 {"hash": "<tx hash>"}`, or `4xx {"error": "<reason>"}` |
| `POST /join` | `{"name": "alice", "public_key": "ed25519:…"}` | relayer calls `join` on the site. `200 {"account": "alice.<site>", "hash": "…"}` |
| `GET /health` | | `{"site", "relayer", "balance", "policy"}` |

Policy, checked on the decoded delegate before anything is sent:

- `receiver_id` is the site contract, or the sender itself for `fs_store` (large-file upload, section 7) when `allow_uploads` is on.
- Every action is a `FunctionCall` with deposit `0`, gas ≤ `max_gas` (default 300 Tgas, enough for a `db_add` with a trigger), and a method in `methods` (default: `db_add`, `db_update`, `db_remove`).
- `max_block_height` is in the future and at most 200 blocks ahead.
- With `member_only` (default), the sender is `<name>.<site>` with exactly one label before the site.
- The delegate's public key is an access key of the sender (`unknown_key`) and its nonce is above that key's nonce at final (`nonce_used`). The signature alone proves nothing: anyone can sign a delegate for any sender with a key of their own, or resend one seen on chain, and the chain refuses those only after the relayer paid for the try.
- Per sender: at most `per_account_per_hour` relays (default 30). Overall: at most `daily_tgas` (default 30,000 Tgas) per UTC day. Both are charged before sending, atomically (add, compare, roll back), and a relay that fails on chain stays charged; `relayer_busy` (nothing sent) gives the charge back.
- `join` is rate-limited per client address and per day. The Node host takes the client address from the socket, or with `--trust-proxy` from the last `X-Forwarded-For` entry. The OutLayer host cannot see the client, so it has only the daily cap, and anyone holding the public payment key can use it up.

A refusal names the rule that failed. The relayer logs hashes and senders, never keys.

Client side: a member session is an ed25519 key made in the browser and stored in `localStorage` under `quay:<site>:session`. `join` puts it on `<name>.<site>` as a full-access key. Writes are NEP-366 delegates signed with it and sent to `/relay`. The same key signs NEP-413 sign-in messages, so `verifySignIn` treats a member exactly like a wallet user.

**OutLayer host timing (measured 2026-11-11).** The relay function returns `{hash, status}` once the transaction is in a block (`send_tx` with `wait_until: "INCLUDED"`); it never waits for execution, because a `db_add` with `on_add` keeps its transaction open for another OutLayer run (the trigger), which outlasted the synchronous HTTPS window and the guest's own HTTP read timeout. `status` is `included` or `executed` (the node already had the outcome), or `pending` when the node timed out: the hash is computed locally, so a pending relay is looked up, never resent. The client follows the transaction itself: a relayed `db_add` uses a client-made id (a letter and 9 base36 characters) and is done when `db_get` finds the doc; any other relayed write waits for `EXPERIMENTAL_tx_status`; failures surface as `call_failed`, a write not seen within 90 s as `relay_timeout` ("sent, outcome unknown"). An OutLayer call that outruns the synchronous window answers `408 {reason: "timeout", call_id, poll_url}`: it is still running and is charged once, so the client polls `GET /calls/{call_id}` and never resends; its payment-key reservation (`reserved` in `/public/payment-keys/<owner>/<nonce>/balance`) is released when that run settles. The relayer holds each relay's prepaid gas (about 0.001 NEAR per Tgas, 0.3 NEAR for a 300 Tgas trigger add) until every receipt, the trigger included, has run; when its free balance is short the function answers `relayer_busy` without sending, and the client resends the same signed delegate. `health` reports `relays_in_flight`, the number of maximum-gas relays the balance can hold at once.

## 7. Large files

Contract part (frozen). The store and upload path are *pending spike (b)*.

`FileIn` gains an optional `external`. A file with `external` has `chunks: []`:

```jsonc
{ "path": "media/harbour.jpg", "content_type": "image/jpeg", "chunks": [],
  "external": { "cid": "bafy…", "size": "512000", "sha256": "<hex of the file bytes>" } }
// or, for a store that serves HTTPS (FastFS; NEARFS does not serve new testnet uploads):
{ "path": "media/tour.mp4", "content_type": "video/mp4", "chunks": [],
  "external": { "url": "https://test.fastfs.io/<account>/<receiver>/<sha256>.mp4", "size": "9000000", "sha256": "<hex>" } }
```

`external` has exactly one of `cid` or `url` (`external needs exactly one of cid or url`). `cid` is 1 to 128 bytes of `[A-Za-z0-9]` (a CIDv1 in base32 or base58). `url` starts with `https://`, is at most 256 bytes, and has no whitespace, control or non-ASCII characters and no `"`, `<` or `>` (`bad url`). `size` is a `U64`. `sha256` is 64 hex characters; the contract cannot fetch the bytes, so the CLI checks the hash before sealing and the contract stores it for anyone to re-check. External files do not count against `stored_bytes` or the 800,000-byte file limit. They do count against the 64-file limit. A release must still store `index.html` on chain.

`web4_get` answers an external file with `bodyUrl: "ipfs://<cid>"` or `bodyUrl: "<url>"`, its `content_type`, and the same cache rule as other files. `get_release` returns `external` on such files, with whichever of `cid` or `url` was sealed.

## Gateway request (observed in `vgrichina/web4` source)

`web4_get` receives `{"request": {"accountId": "alice.testnet" | null, "path": "/posts/12", "query": {"from": ["40"]}, "preloads": {…}?}}`. `path` has no query string. Every query value is an array. `Web4Request` must accept all four fields and ignore unknown ones. POST requests never reach `web4_get`.

## 8. Scheduled jobs (`quay cron`)

Spike (e): OutLayer has no scheduler. A contract can keep a yield chain alive by itself: each yield times out after about 200 blocks (~2 minutes), its callback runs, and it yields again with the gas it has left. Each hop costs about 2.25 Tgas, so 1 PGas of prepaid gas lasts about 440 hops (~14.5 hours) and less when jobs run. After that the chain stops until any transaction re-arms it. That is the mechanism, with that limit stated everywhere it is offered.

| Method | Who | Deposit | Effect |
| --- | --- | --- | --- |
| `cron_set(name, job)` / `cron_remove(name)` | site owner | 1 yocto | `job = {"every_minutes": 30, "fn": "digest", "input": "{}"}`, `every_minutes` ≥ 5, at most 8 jobs |
| `cron_list()` | view | | jobs with `last_run`, `next_due` |
| `cron_status()` | view | | `{armed, hops, last_tick, started}` |
| `cron_arm()` | anyone | 0 | starts the chain when it is not running. The caller's prepaid gas becomes the chain's budget. Emits `cron_armed`. |
| `cron_kick()` | anyone | 0 | resumes the pending yield now (runs due jobs early). |
| `cron_tick(...)` | `#[private]` callback | | runs each due job as a function call paid from the pool (about 60 Tgas each), then yields again when at least 20 Tgas would remain, else emits `cron_stopped`. |

`quay cron add "<every 30m>" <fn>`, `quay cron list`, `quay cron rm`, `quay cron arm` (sends 1 PGas; about 1 NEAR must be liquid while it runs and the unused gas is refunded).

## 9. Payments

| Method | Who | Deposit | Effect |
| --- | --- | --- | --- |
| `set_product(id, product)` | site owner | 1 yocto | create or replace. Emits `product_set`. |
| `remove_product(id)` | site owner | 1 yocto | |
| `get_product(id)`, `list_products()` | view | | at most 32 products |
| `pay(product, ref?)` | anyone | ≥ `price_yocto` | records a receipt, refunds the excess, applies the grant. Emits `paid`. |
| `ft_on_transfer(sender_id, amount, msg)` | the configured token contract | | `msg` is `{"product":"pin","ref":"posts/12"}`. Returns `"0"` when accepted, the full amount when refused. |
| `set_token(account?)` | site owner | 1 yocto | the NEP-141 token accepted for `price_token`. |
| `has_paid(account, product, ref?) -> bool` | view | | |
| `list_receipts(query) -> { receipts, next }` | view | | same paging as `db_list`, filter by `owner` (buyer) |

```jsonc
// Product
{ "name": "Pin a post for 24 hours", "price_yocto": "100000000000000000000000", "price_token": "100000", "grant": "pin" | "receipt", "pin_seconds": 86400 }
// Receipt (system collection _receipts, payer site, storage taken from the payment)
{ "buyer": "alice.testnet", "product": "pin", "ref": "posts/12", "amount": "…", "token": "near" | "<token account>", "at": "…" }
```

Grant `pin` needs `ref` = `<collection>/<id>` of an existing doc and sets its `pinned_until = max(now, pinned_until) + pin_seconds`. Grant `receipt` only records the receipt; a route or function checks `has_paid`.

`buy(memo)` from v2 is unchanged.

## 10. Project file and `quay up`

`quay.json` (written by `quay init`) gains optional sections. Unknown keys are an error, so a typo does not silently do nothing.

```jsonc
{
  "account": "board-x1.testnet",
  "network": "testnet",
  "site": { "dir": "site", "spa": false },
  "files": { "external_over": 65536, "store": "nearfs" },          // or "pinata" / "filebase" (API key from env)
  "collections": {
    "posts": { "write": "members", "payer": "site", "max_doc_bytes": 2000, "moderated": true, "max_docs_per_account": 50, "on_add": null }
  },
  "routes": [
    { "pattern": "/posts/:id", "kind": "doc", "collection": "posts", "template": "templates/post.html" },
    { "pattern": "/api/:collection", "kind": "json", "collection": "*" }
  ],
  "products": { "pin": { "name": "Pin a post for 24 hours", "price_yocto": "100000000000000000000000", "grant": "pin", "pin_seconds": 86400 } },
  "members": { "open": true },
  "functions": { "preview": { "dir": "functions/preview", "call": "anyone", "payer": "site", "secrets": ["PREVIEW_TOKEN"] } },
  "relay": { "host": "outlayer" | "node", "account": "relay.board-x1.testnet", "methods": ["db_add", "db_update", "db_remove", "fn_call"] },
  "cron": [ { "name": "digest", "every_minutes": 60, "fn": "digest", "input": {} } ]
}
```

`quay up [-m message]` applies, in order: functions (build, upload, register; secrets are only checked for presence by name), collection rules, products, members setting, cron jobs, then deploys `site.dir` as a new release with `routes` (large files per `files`), then promotes it. `--dry-run` prints the plan and changes nothing. Each step prints its transaction link.

What is versioned: files, routes and templates, together, per release. `quay rollback` restores all three. What is live state and is **not** versioned: documents, collection rules, products, members, function code and secrets, the relay and cron settings. `quay up` and `quay rollback` print this so nobody expects a data rollback.


## Contract deviations and clarifications (v3 implementation)

Each line is a choice the contract makes where this spec was silent or could not be followed exactly.

- **Doc ids.** An explicit id may not be all digits. Digit ids are the automatic ids, so a writer cannot block the next sequence number by taking it first.
- **Pool.** `get_pool().balance` is pool NEAR not held by any doc. `db_withdraw` transfers nothing, because the site owner is the contract account and the NEAR is already there. It only releases the amount from the pool and emits `pool_withdrawn {yocto}`.
- **`CollectionView`** flattens the rules: `{name, write, max_doc_bytes, moderated, payer, max_docs_per_account, on_add, count, bytes, next_seq}`. `list_collections` leaves out system collections; `get_collection("_receipts")` still answers.
- **Pins.** `pinned_until` in a `DocView` is `null` once it is at or before now, and `pinned_first` lifts only docs whose pin is still active.
- **`db_list`** clamps `limit` to 1..=50 instead of refusing. `pinned_first` puts live pins first on the first page (no `from`); every page then skips live pins, so a pinned doc appears once. At most 16 docs per collection are pinned at once (`pin list is full`).
- **Storage accounting.** Every charge is recorded on the doc (`deposit`) and every refund comes out of that record, so a doc never returns more than was paid for it. A shrink refunds at most the recorded deposit. The first doc a writer adds in a collection also pays for that writer's count record; it is freed with the writer's last doc.
- **Payments.** `price_yocto` and `price_token` are each optional; one is required. `pin_seconds` is 1..=31,536,000 for grant `pin` and ignored for `receipt`. `ref` is 1 to 128 bytes of `[A-Za-z0-9._/:-]`. A NEAR receipt's storage must fit inside the price (`price does not cover receipt storage`). A token receipt's storage comes from the pool, so `ft_on_transfer` refuses (returns the full amount) unless the pool holds at least 1,000 bytes of storage (0.01 NEAR). `ft_on_transfer` returns the unused amount: the excess over `price_token` when accepted, the full amount when refused. `pay` returns nothing.
- **Members.** `name` must also make a valid account id (no leading, trailing or doubled `-`/`_`). `join` returns the creation promise; the transaction result is `true` once `on_join` records the member, `false` when the account could not be created (it already exists, for example). A member record is permanent storage, so a visitor's `join` is paid from the pool: it holds 300 bytes of storage (0.003 NEAR) and fails with `storage pool is empty` when the pool cannot; `on_join` keeps what the record used (counted in `reserved`) and returns the rest, or all of it when the account was not created. The site account's own `join` needs no pool. Extra view: `get_members_open()`.
- **External files.** A `url` and a `cid` share one stored field (a CID is alphanumeric, a URL starts with `https://`), so external entries sealed before URLs existed read unchanged. `url` also refuses non-ASCII bytes; percent-encode them.
- **Routes.** A pattern may not start with `/r/`. `*rest` matches zero or more segments. Json list routes read `from`, `limit`, `order`, `owner` and `prefix` from the query, with the route's values as defaults. Template, include, filter and route errors are refused at `seal`, which names the route pattern. `get_release` returns `routes` only when a release has them, and `external` only on external files, so v2 releases keep their v2 JSON.
- **Functions.** `fn_call` forwards the spec `deposit` to OutLayer and refunds any excess to the caller at once, so the refund in `fn_on_result` never exceeds `deposit`; OutLayer refunds the unused part to `payer_account_id`. `fn_call` and a `db_add` with a trigger need at least 120 Tgas prepaid (`attach about 150 Tgas`), checked before anything is written. OutLayer gets the call's unused gas by weight, and `fn_on_result` has 15 Tgas. `input` must be valid JSON. `FunctionSpec` defaults: `deposit` 0.005 NEAR, `max_instructions` `"2000000000"`, `max_seconds` 30 (1 to 600), `secrets` false. `project` is `<account>/<name>`, at most 128 bytes. `call` takes `owner`, `anyone` or `members`, like collection writes. Extra methods: `set_outlayer(account)` (site owner, 1 yocto, default `outlayer.testnet`) and `get_outlayer()`.
- **Results.** `_fn` doc ids are `<fn>-<n>`, where `n` is one counter for the whole site. A result doc's data is `{name, request, caller, ok, output, at}` plus `error` when there is one: `function failed` (OutLayer answered `null`), `request failed` (the `request_execution` receipt failed), `output is not JSON`, or `output over 16 KB`. Result storage comes from the pool. When the pool cannot hold the output, the doc is stored without it (`error: "output not stored: the pool is low"`). When the pool cannot hold even that, nothing is stored. The caller still gets the output as the transaction result. The site owner may `db_remove` a `_fn` doc to prune it, and its storage goes back to the pool.
- **Refunds.** When the `request_execution` receipt itself fails, the runtime returns the deposit to the contract, and `fn_on_result` passes it on: to the caller for `payer: caller`, back to the pool for site-paid runs. A site-paid run (`payer: site`, triggers, cron) takes `deposit` out of the pool for good. OutLayer refunds the unused part to the site account, not to the pool.
- **Triggers.** A trigger is skipped, with a log line, when its function is missing or the pool cannot pay its deposit. The doc is still added. The output is stored in the doc's `fn` field whatever its shape. The pool pays for that storage, recorded apart from the writer's deposit and returned to the pool when the doc is removed. The doc is hidden when the output has a top-level `"hide": true` and the collection is moderated. A result applies only to the doc that ran the trigger: a doc removed and added again under the same id does not take the earlier doc's result.
- **Cron.** `job.input` is JSON text, default `"{}"`; `every_minutes` is 5 to 40,320; `fn` must be registered when the job is set. A job that has never run is due at the next tick. `cron_list` items are `{name, every_minutes, fn, input, last_run, next_due}`. `cron_status` also returns `pending` (a yield is waiting). Times are `U64` strings, or `null` before the first event. `cron_arm` needs at least 50 Tgas. It refuses while a chain is alive, except for the site account, which may replace a live chain (one armed with too little gas to run a job, say); the old chain's ticks then do nothing. A chain that has not ticked for 10 minutes counts as dead and can be armed again. `cron_kick` refuses within 60 seconds of the last tick, so kicks cannot burn the chain's gas faster than once a minute. Each job gets 45 Tgas for `request_execution` plus 15 Tgas for its result. A tick launches a job only when 85 Tgas would remain, and yields again when at least 25 Tgas remain (20 plus a 5 Tgas reserve for the tick itself). A tick from an older chain does nothing. Extra events: `cron_set`, `cron_removed`, `cron_ran`, `fn_called`, `fn_removed`, `outlayer_set`.
- **Extra views and events.** Views `get_members_open`, `get_token`. Events `collection_dropped`, `pool_withdrawn`, `members_open_set`, `product_removed`, `token_set`. `release_sealed` gains `routes` and `external` counts. `on_add` names are 1 to 32 bytes of `[a-z0-9_-]`.

## 11. Layer status API (for the dashboard and the node canvas)

One small read-only function reports every layer's live state, so the dashboard today and the planned canvas of nodes (Site, Gateway, Data, Functions, Routes, Relay, Cron, Keys) read the same data. It lives in the client as `@quay/client/status` and is also exposed on dashboard pages as `window.quay.status(account, options)`.

```js
import { layerStatus } from "@quay/client/status";
const s = await layerStatus({ site: "board-x1.testnet", rpc?, gateway?, relay?, fetch?, timeoutMs: 6000 });
// s = { site: "board-x1.testnet", measured_at: "2026-11-11T09:00:00Z", layers: { site, gateway, data, functions, routes, relay, cron, keys } }
// each layer:
{ "state": "ok" | "warn" | "down" | "off",   // off = not configured on this site
  "summary": "Production is release 7",        // one plain sentence
  "metrics": { "releases": 7, "stored_bytes": 52000 },   // small flat numbers/strings, layer-specific
  "links": [{ "label": "Open production", "href": "https://board-x1.testnet.page/" }],
  "error": null }                               // short reason when state is down/warn
```

| Layer | Reads | `down`/`warn` when |
| --- | --- | --- |
| site | `get_status`, `get_version` | RPC fails, no production release |
| gateway | one timed `GET` of the public host, `GET /_quay/health` of a configured self-hosted gateway | non-2xx, the deprecated-RPC JSON body, timeout |
| data | `list_collections`, `get_pool` | pool below one doc's storage |
| functions | `fn_list`, newest `_fn` results | last result failed |
| routes | production release `routes` | template file missing |
| relay | relay `/health` (URL or OutLayer adapter), relayer balance | unreachable, balance < 0.05 NEAR |
| cron | `cron_status`, `cron_list` | jobs set but chain not armed, last tick older than 2 × interval |
| keys | `view_access_key_list` | a full-access key count other than 1 (warn) |

Every layer is measured independently with its own timeout; one failure never hides the others. Pre-v3 contracts report `off` for layers they do not have.
