# Changelog

## Unreleased — full-stack

- Contract 3.0.1, live on `harbour-board.testnet` (3.0.0 gave a cron job too little gas for OutLayer): a document database with collection rules and a storage pool, members with no NEAR, a function registry for OutLayer, routes with templates sealed in a release, large files by CID or https URL, products and receipts, and yield-chain cron. v2 methods keep their JSON. The spec is `docs/fullstack-interface.md`.
- CLI: `quay db`, `members`, `products`, `receipts`, `relay`, `functions`, `secrets`, `cron`, `gateway` and `quay up`, which applies `quay.json`. Large files go to FastFS by default; NEARFS is cut because testnet never served its uploads.
- `@quay/gateway` serves a site over RPC on Node, Deno, Bun, a container or Cloudflare Workers, with an RPC fallback list. `@quay/client` has the db API, NEP-413 sign-in, member sessions and the relayer host. `examples/board` uses every layer.
- Docs site: a layers page with command help generated from the CLI, an architecture page with a trust table, and relative links, so the pages work on any host. The home page is served from Cloudflare Workers (`quay.ss251.workers.dev`) because `testnet.page` answered HTTP 400 for several hours on 2026-11-10.
- `scripts/judge.sh` tries the Workers host, then `testnet.page`, then a local gateway, and prints which one answered. It checks the gateway, the contract versions, and every live layer of Harbour Board with keyless page fetches and RPC views. It also checks that a scheduled run wrote a digest. Wallet sign-in needs a wallet, so it is not checked; Pinata, Filebase and Circle USDC are not proven.
- Harbour Board (https://harbour-board.ss251.workers.dev/, or https://harbour-board.testnet.page/) shows data, routes, members through two relayers, functions on OutLayer, payments in NEAR and test USDC, a large file on FastFS and an hourly digest from cron (re-armed by hand about every 6 hours). Wallet sign-in was shown with one near-connect connector, NEAR CLI.
- Site redesign (round 5): the home page leads with "Pages, data, functions and sign-in on one NEAR account." and the live Harbour Board, with a layer table, request flow, tools, trust, costs and FAQ. Every layer has its own docs page built from `web/layers.mjs`. The dashboard opens on a canvas read from chain, with Site and Functions panels. NEAR's logo and Built on NEAR badge are NEAR's own files; other tools are named in type.
- README: a Full-stack layers section that marks what each layer proved live and where it is weak, with transaction links and a keyless check for each.

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
