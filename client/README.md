# @quay/client

Reads, writes, sign-in and member sessions for a Quay v3 site. ESM, browsers and Node 20+. Spec: `docs/fullstack-interface.md` sections 5 and 6.

- `@quay/client`: `connect({ site, rpc?, relay?, relayer?, key?, wallet?, storage?, fetch? })` gives `db`, `auth`, `members`, `functions`, `pay`, `view`.
- `@quay/client/verify`: `verifySignIn(proof, { site, rpc, maxAgeMs })` for Node, functions and browsers.
- `@quay/client/relay-core`: `checkDelegate`, `relay`, `memoryStore` for the relayer host (Node, needs `near-api-js` and `borsh` for `relay`).

`node build.mjs` writes the minified browser bundle `dist/quay.js` (near-api-js is not bundled; only the Node explicit-key path imports it).

Tests: `npm test`. The sandbox test is opt-in: `QUAY_SANDBOX=1 node --test test/sandbox.test.mjs` with the `near-sandbox` package installed (`npm i --no-save near-sandbox`) or `QUAY_SANDBOX_MODULE=<path to near-sandbox/dist/esm/index.mjs>`.
