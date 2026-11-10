# Changelog

## Unreleased

- The site, docs, dashboard, 404 page, and the harbour sample have a new design: Geist and Geist Mono subset to 20 KB, light and dark from one token set, one green for what is live. The home page shows the dashboard and a deploy session built from the sample's real data.
- The dashboard has tabs (overview, releases, history, storage), a live preview of production, the account's access keys and balance read from chain, a confirm dialog, a pending state while the wallet signs, toasts with the transaction link, and an Undo after a rollback.
- The harbour sample is release 5 on `quay-65nqd3rn.testnet`. The site is release 9 on `quay-esc0v902.testnet`; the old design stays at `/r/4/`.

## 2.0.0

- The contract stores release metadata, a promotion history, rollback, and delete with a storage unlock. `migrate` reads a v1 state. `quay-bb.testnet` stays on v1.
- `quay` is an npm package, `quay-near`, and talks to testnet with near-api-js. It does not shell out to `near`. `quay init` and the first deploy wait for the gateway certificate. Deploy prints the next command and the explorer link.
- A landing page, docs, and a dashboard are deployed with Quay. The dashboard opens from `?account=`, marks production and the previous release, and can promote, roll back, or delete after a testnet wallet signs.
- A publish-only key gets unlimited gas and a method list of `put_chunk` and `seal`. It still cannot attach the deposit those other methods require.
- `examples/harbour` is a small multi-page site. `examples/agent` calls the CLI as a library. `action/` is the preview action, and `scripts/ci-local.sh` runs it without GitHub.

## 1.0.0

- The original testnet demo on `quay-bb.testnet`: chunked publishes, one production pointer, and a publish key that cannot promote.
