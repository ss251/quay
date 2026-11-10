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

## 3. Functions (`quay functions`) — *pending spike (a)*

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

## 6. Relay

Where the relayer runs (an OutLayer function or a small Node process) is *pending spikes (a) and (d)*. The HTTP protocol is frozen; both hosts serve the same one.

The relayer is its own account (`relay.<site>` by default) with a full-access key and a small NEAR balance. That balance is the hard spend limit. It never holds the site's key.

| Request | Body | Answer |
| --- | --- | --- |
| `POST /relay` | `{"signed_delegate": "<base64 borsh SignedDelegateAction>"}` | `200 {"hash": "<tx hash>"}`, or `4xx {"error": "<reason>"}` |
| `POST /join` | `{"name": "alice", "public_key": "ed25519:…"}` | relayer calls `join` on the site. `200 {"account": "alice.<site>", "hash": "…"}` |
| `GET /health` | | `{"site", "relayer", "balance", "policy"}` |

Policy, checked on the decoded delegate before anything is sent:

- `receiver_id` is the site contract, or the sender itself for `fs_store` (large-file upload, section 7) when `allow_uploads` is on.
- Every action is a `FunctionCall` with deposit `0`, gas ≤ `max_gas` (default 100 Tgas), and a method in `methods` (default: `db_add`, `db_update`, `db_remove`).
- `max_block_height` is in the future and at most 200 blocks ahead.
- Per sender: at most `per_account_per_hour` relays (default 30). Overall: at most `daily_tgas` (default 30,000 Tgas) per UTC day.
- `join` is rate-limited per client address and per day.

A refusal names the rule that failed. The relayer logs hashes and senders, never keys.

Client side: a member session is an ed25519 key made in the browser and stored in `localStorage` under `quay:<site>:session`. `join` puts it on `<name>.<site>` as a full-access key. Writes are NEP-366 delegates signed with it and sent to `/relay`. The same key signs NEP-413 sign-in messages, so `verifySignIn` treats a member exactly like a wallet user.

## 7. Large files

Contract part (frozen). The store and upload path are *pending spike (b)*.

`FileIn` gains an optional `external`. A file with `external` has `chunks: []`:

```jsonc
{ "path": "media/harbour.jpg", "content_type": "image/jpeg", "chunks": [],
  "external": { "cid": "bafy…", "size": "512000", "sha256": "<hex of the file bytes>" } }
```

`cid` is 1 to 128 bytes of `[A-Za-z0-9]` (a CIDv1 in base32 or base58). `size` is a `U64`. `sha256` is 64 hex characters; the contract cannot fetch the bytes, so the CLI checks the hash before sealing and the contract stores it for anyone to re-check. External files do not count against `stored_bytes` or the 800,000-byte file limit. They do count against the 64-file limit. A release must still store `index.html` on chain.

`web4_get` answers an external file with `bodyUrl: "ipfs://<cid>"`, its `content_type`, and the same cache rule as other files. `get_release` returns `external` on such files.

## Gateway request (observed in `vgrichina/web4` source)

`web4_get` receives `{"request": {"accountId": "alice.testnet" | null, "path": "/posts/12", "query": {"from": ["40"]}, "preloads": {…}?}}`. `path` has no query string. Every query value is an array. `Web4Request` must accept all four fields and ignore unknown ones. POST requests never reach `web4_get`.

## 8. Scheduled jobs — *pending spike (e)*

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

## 10. Project file and `quay up` — *pending*
