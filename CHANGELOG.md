# Changelog

## 2.0.0

- The contract stores release metadata, a promotion history, rollback, and delete with a storage unlock. `migrate` reads a v1 state. `quay-bb.testnet` is still on v1.
- `quay` is an npm package, `quay-near`, and talks to testnet with near-api-js. It does not shell out to `near`.
- A landing page, docs, and a dashboard are deployed with Quay. The dashboard can promote, roll back, and delete after a testnet wallet signs.
- `examples/harbour` is a small Vite site with three releases and one rollback. `examples/agent` calls the CLI as a library. `action/` is the preview action.

## 1.0.0

- The original testnet demo on `quay-bb.testnet`: chunked publishes, one production pointer, and a publish key that cannot promote.
