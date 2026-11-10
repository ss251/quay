# @quay/client

Reads, writes, sign-in and member sessions for a Quay v3 site. ESM, browsers and Node 20+. Spec: `docs/fullstack-interface.md` sections 5 and 6.

- `@quay/client`: `connect({ site, rpc?, relay?, relayer?, key?, wallet?, storage?, fetch? })` gives `db`, `auth`, `members`, `functions`, `pay`, `view`.
- `@quay/client/verify`: `verifySignIn(proof, { site, rpc, maxAgeMs })` for Node, functions and browsers.
- `client/src/relay-server.mjs`: the Node relayer host (`POST /relay`, `POST /join`, `GET /health`, CORS, join rate limits). Run it with `quay relay serve`; `node build.mjs` vendors it into `cli/vendor/relay/server.mjs` for the packed CLI (`node build.mjs --check` fails when stale).
- `@quay/client/relay-core`: `checkDelegate`, `relay`, `memoryStore` for the relayer host (Node, needs `near-api-js` and `borsh` for `relay`).

`node build.mjs` writes the minified browser bundle `dist/quay.js` (near-api-js is not bundled; only the Node explicit-key path imports it).

Tests: `npm test`. The sandbox test is opt-in: `QUAY_SANDBOX=1 node --test test/sandbox.test.mjs` with the `near-sandbox` devDependency (it downloads a neard binary on first start; set `NEAR_SANDBOX_BIN_PATH` to reuse one). `QUAY_WASM=<path>` tests a v3 wasm; the default `cli/vendor/quay.wasm` runs the v2-compatible subset.

## Gas-only public data (FastData KV)

`quay.db.collection("guestbook", { backend: "fastdata" })` has `add`, `get`, `list`, `update` and `remove` like an on-chain collection, but stores entries in FastNEAR's FastData indexer: a gas-only call `__fastdata_kv` on the site account with keys `quay/<collection>/<id>` and value `{data, at}`. No deposit, so a relayed member with zero NEAR can write. Read this before using it:

- No rules, no moderation, no quota. The site owner cannot hide or remove anything.
- `owner` (the predecessor account) is the only identity. Anyone can write any key under their own name, so never trust a doc id or its content, and show or filter by `owner`.
- Reads depend on FastNEAR's indexer (`https://kv.test.fastnear.com`, override with `connect({ fastdata: { kv } })`).
- The write fails on chain by design (the site has no `__fastdata_kv` method); the indexer records it anyway. The client and `relay()` tolerate exactly those failures for these calls.
- The relay does not relay it unless the site opts in: `quay relay serve --fastdata` (policy `fastdata: true`). A fixed-allowlist host must add `__fastdata_kv`.

The code is a separate file (`dist/fastdata.mjs`, 3 KB) that `dist/quay.js` loads on first use; deploy it next to `quay.js`. Site functions and checkout also load lazily from `dist/extras.mjs`.
