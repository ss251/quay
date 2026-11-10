# @quay/client

Reads, writes, sign-in and member sessions for a Quay v3 site. ESM, browsers and Node 20+. Spec: `docs/fullstack-interface.md` sections 5 and 6.

- `@quay/client`: `connect({ site, rpc?, relay?, relayer?, key?, wallet?, storage?, fetch? })` gives `db`, `auth`, `members`, `functions`, `pay`, `view`.
- `@quay/client/verify`: `verifySignIn(proof, { site, rpc, maxAgeMs })` for Node, functions and browsers.
- `client/src/relay-server.mjs`: the Node relayer host (`POST /relay`, `POST /join`, `GET /health`, CORS, join rate limits). Run it with `quay relay serve`; `node build.mjs` vendors it into `cli/vendor/relay/server.mjs` for the packed CLI (`node build.mjs --check` fails when stale).
- `@quay/client/relay-core`: `checkDelegate`, `relay`, `memoryStore` for the relayer host (Node, needs `near-api-js` and `borsh` for `relay`).

`node build.mjs` writes the minified browser bundle `dist/quay.js` (near-api-js is not bundled; only the Node explicit-key path imports it).

Tests: `npm test`. The sandbox test is opt-in: `QUAY_SANDBOX=1 node --test test/sandbox.test.mjs` with the `near-sandbox` devDependency (it downloads a neard binary on first start; set `NEAR_SANDBOX_BIN_PATH` to reuse one). `QUAY_WASM=<path>` tests a v3 wasm; the default `cli/vendor/quay.wasm` runs the v2-compatible subset.
