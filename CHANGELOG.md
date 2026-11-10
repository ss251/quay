# Changelog

## 2.0.0

- The contract stores release metadata, a promotion history, rollback, and delete with a storage unlock. `migrate` reads a v1 state. `quay-bb.testnet` stays on v1.
- `quay` is an npm package, `quay-near`, and talks to testnet with near-api-js. It does not shell out to `near`. `quay init` and the first deploy wait for the gateway certificate. Deploy prints the next command and the explorer link.
- A landing page, docs, and a dashboard are deployed with Quay. The dashboard opens from `?account=`, marks production and the previous release, and can promote, roll back, or delete after a testnet wallet signs.
- A publish-only key gets unlimited gas and a method list of `put_chunk` and `seal`. It still cannot attach the deposit those other methods require.
- `examples/harbour` is a small multi-page site. `examples/agent` calls the CLI as a library. `action/` is the preview action, and `scripts/ci-local.sh` runs it without GitHub.

## 1.0.0

- The original testnet demo on `quay-bb.testnet`: chunked publishes, one production pointer, and a publish key that cannot promote.
