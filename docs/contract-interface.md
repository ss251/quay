# Quay contract interface (v2)

Account state version `2`. Standard name `quay`. Event version `2.0.0`.

**Version 3** (`3.0.0`, state version 3) keeps every method and view below with the same JSON and adds data, members, routes and templates, external files, payments, functions and cron. Its methods are in `docs/fullstack-interface.md`, with the contract's deviations at the end of that file. In v3, `get_version` and events report `3.0.0`, `seal` takes an optional `routes`, a `FileIn` may carry `external`, `migrate` also accepts v2 state, and `web4_get` checks a release's routes before its files.

The account that holds the contract is the only account that can write. A function-call key is limited a second time: `promote`, `rollback`, and `delete` each require exactly 1 yoctoNEAR, which that key cannot attach. `publish_methods` is the allow-list for a publish-only key.

`quay-bb.testnet` stays on v1 until an owner deploys this wasm and calls `migrate`. A new account calls `new`. Both paths are covered by unit tests. The product deploy is a new account so the live v1 site keeps serving.

## Storage

Chunks are keyed by the hex sha256 of their bytes. A chunk is stored once. Each release holds a reference count per chunk. `delete` drops the chunk, and subtracts its length from `stored_bytes`, when the count hits zero. The NEAR locked by those bytes unlocks on the contract account. It is not transferred to the signer. The signer is the contract account.

| Limit | Value |
| --- | ---: |
| Chunk | 1 to 200,000 bytes |
| File | 800,000 bytes, at most 4 chunks |
| Files in one release | 64 |
| Path | 1 to 180 bytes, `[A-Za-z0-9._/-]`, no empty, `.`, or `..` segment |
| Release id | 1 to 64 bytes, `[A-Za-z0-9._-]`, not `.` or `..` |
| Message | at most 200 characters, no control characters |
| Releases alive at once | 32 |
| Promotion history | 128 entries |
| Payload cap (`stored_bytes`) | 2,000,000 bytes |
| Sale log | 128 |

`stored_bytes` counts chunk payloads only. Trie records cost extra. The CLI estimates both before it sends a transaction.

Protocol price, used by the CLI: 0.01 NEAR per 1,000 bytes (`10^19` yoctoNEAR per byte).

## Methods

Quay method arguments and views use snake_case JSON. Amounts and timestamps that can exceed 2^53 are `U64` decimal strings. Timestamps are nanoseconds since the Unix epoch. `web4_get` is the exception: the gateway sends camelCase.

### `new()`

`#[init]`. Empty chunks, no production, version 2.

### `migrate(ids: Vec<String>)`

`#[init(ignore_state)]`. The predecessor must be this account (`assert_self`, panic `only this account`). Reads v1 state, rewrites each listed release into v2, and rebuilds chunk reference counts. Pass `[]` to scan ids `"1"` through `"128"`. A second call on v2 state returns that state unchanged. Migrated releases get timestamp `0`, an empty message, and `spa: false`. The previous production pointer starts empty. One history row is recorded when v1 had a production release.

### `publish_methods() -> Vec<String>`

`["put_chunk", "seal"]`.

### `put_chunk(sha256, data)`

Predecessor must be this account. Attached deposit must be 0. `data` is base64. The hash must match. An existing hash is left as it is and does not increase `stored_bytes`.

### `seal(id, files, message, spa)`

Predecessor must be this account. Attached deposit must be 0. `files` is `{ path, chunks, content_type }`. One file must be `index.html`. The id cannot already exist. `spa` selects the single-page fallback described under routing.

Emits `release_sealed`.

### `promote(id)`

`#[payable]`. Predecessor must be this account. Deposit must be exactly 1 yoctoNEAR. The release must exist. Production becomes `id`. The previous production id is kept for `rollback`.

Emits `promoted`. Returns the id.

### `rollback()`

Same caller and deposit rules as `promote`. Swaps production with the previous id. Fails when there is no previous id, or when that release was deleted.

Emits `rolled_back`. Returns the id that is production after the call.

### `delete(id) -> U64`

Same caller and deposit rules as `promote`. Refuses the current production id. If `id` is the rollback target, the previous pointer is cleared. Returns the payload bytes freed.

Emits `release_deleted`.

### `drop_chunk(sha256)`

`#[payable]`. Predecessor must be this account, and the attached deposit must be exactly 1 yoctoNEAR. Removes a chunk that no release references and subtracts its length from `stored_bytes`. A chunk that was uploaded and never sealed stays until this call. A publish-only key cannot attach the deposit, so it cannot drop chunks. Refuses a chunk that a release still uses, and a hash that is not stored.

Emits `chunk_dropped`.

### `buy(memo)`

`#[payable]`. Public. Minimum `0.01` NEAR. Records the predecessor, the yocto amount as a decimal string, and an optional memo up to 140 characters. Does not move production.

Emits `purchased`.

## Views

### `get_version()`

`{ "version": "2.0.0", "standard": "quay" }`.

### `get_status()`

`version`, `production`, `previous`, `release_count`, `stored_bytes`, `max_bytes`, `chunk_bytes`.

### `get_production() -> Option<String>`

### `get_previous() -> Option<String>`

### `get_release(id) -> Option<ReleaseDetail>`

`id`, `timestamp`, `message`, `file_count`, `bytes`, `sha256` (the `index.html` digest), `spa`, `files`. Each file is `path`, `sha256`, `content_type`, `chunks`. Chunk bytes are not returned.

### `list_releases(from_index, limit) -> { releases, next }`

Oldest first. `limit` above 20 is treated as 20. `limit` of 0 is treated as 1. `next` is the next index, or `null` at the end. Indexes move when a release is deleted.

### `list_history(from_index, limit) -> { entries, next }`

Oldest first. Each entry is `release_id`, `previous_id`, `timestamp`, `kind` (`promote` or `rollback`). A migrated production pointer is one `promote` row with timestamp 0.

### `get_budget()`

`stored_bytes`, `max_bytes`, `chunk_bytes`.

### `has_chunk(sha256) -> bool`

### `get_sales() -> Vec<Sale>`

## Events

One log line, NEP-297:

```text
EVENT_JSON:{"standard":"quay","version":"2.0.0","event":"<name>","data":[{ ... }]}
```

| Event | Data |
| --- | --- |
| `release_sealed` | `id`, `sha256`, `bytes`, `files` (file count), `message`, `spa` |
| `promoted` | `id`, `previous` |
| `rolled_back` | `id`, `previous` |
| `release_deleted` | `id`, `bytes_freed` |
| `chunk_dropped` | `sha256`, `bytes_freed` |
| `purchased` | `buyer`, `yocto` |

## `web4_get`

Request JSON uses camelCase. The field that is read is `path`. Query strings are ignored.

| Path | Body |
| --- | --- |
| `/`, `/index.html` | Production `index.html` |
| `/<path>` | That file in the production release |
| `/r/<id>`, `/r/<id>/`, `/r/<id>/index.html` | That release's `index.html` |
| `/r/<id>/<path>` | That file in that release |

A path that names a directory serves `<dir>/index.html` when that file was sealed. A `..` segment, a `.` segment, a backslash, and an empty segment are not found. A file name may contain `..` in the middle, such as `a..b.txt`.

When no file matches:

1. If the release was sealed with `spa: true`, respond `200` with the release `index.html`.
2. Else if `404.html` was sealed, respond `404` with that file.
3. Else respond `404` with a short HTML note.

`/r/<id>` is reserved. A sealed file does not win over a release preview.

Cache-Control:

- A release response, including its `404.html`, is `public, max-age=31536000, immutable`.
- Production is `public, max-age=0, must-revalidate`.

## What a full-access key can still do

It can replace the wasm. There is no upgrade method in the contract. Releases are immutable for the publish key. They are not owner-proof.
