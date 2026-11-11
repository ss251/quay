# Quay

Testnet contract, CLI, client and gateway that host a full-stack app on one NEAR account: sealed releases with server-rendered routes, a document db, members, a relayer, functions on OutLayer, payments and cron. Live URLs and judge steps are in `README.md`; every live transaction is in `LIVE.md` and `examples/board/LIVE.md`. The v2 method list is `docs/contract-interface.md`; v3 (everything full-stack, plus deviations at the end) is `docs/fullstack-interface.md`. `quay init` writes `quay.json` in the project you run it from.

- Layout: `contract/` (Rust), `cli/`, `client/` (`@quay/client`, browser + Node, relay host), `gateway/` (web4 gateway: local, single-file, Cloudflare Worker in `gateway/worker/`), `functions/` (OutLayer WASI guests, `wasm32-wasip2`), `web/`, `examples/board/` (the full-stack sample), `docs/`. Build with `sh scripts/build.sh`. Test with `sh scripts/test.sh` (`QUAY_SKIP_SANDBOX=1` skips the sandbox suites; the JS ones need `npm install` in `client/`).
- The wasm the CLI deploys is `cli/vendor/quay.wasm`. Rebuild with one cargo job: `cd contract && CARGO_BUILD_JOBS=1 cargo near build non-reproducible-wasm`, then copy `contract/target/near/quay.wasm` there. The exports and collections are hand-written to keep it under 300 KB (~3 NEAR locked per site); do not reintroduce `#[near]` method macros or `near_sdk::store` collections without checking the size.
- The `unit-testing` feature is a dev-dependency only. Do not enable it for `cargo near build`.
- The machine is short of memory: run one heavy cargo build or sandbox node at a time, kill near-sandbox nodes and headless browsers you start, never touch a browser you did not start. Put `$HOME/.cargo/bin` first on `PATH`; the Homebrew cargo has no wasm targets.
- `near` and `cargo-near` live in `~/.cargo/bin`. Keys stay in `~/.near-credentials`. Never commit or print a key, a secret or a payment key. The faucet rate-limits per IP for hours; one failed request can restart the wait.
- Network is testnet. Do not use mainnet, NEAR Intents, or real funds. Do not migrate `quay-bb.testnet` in place. It stays on the v1 wasm.
- Official NEAR skills live in `.grok/skills/` and are gitignored. The docs MCP is `.grok/config.toml`.
- A full-access key can replace the wasm. Releases are not owner-proof.
- The site in `web/` is plain HTML, CSS and JS: tokens and components in `web/assets/quay.css` (v6: Archivo + Quay Mono, subset fonts; rebuild them with `web/fonts/README.md` and keep the Quay Mono name, since "Plex" is a Reserved Font Name), icons inlined by `web/build.mjs`, pages in `web/pages/`, demo hosts in `web/hosts.json`. Layer facts, commands and proof links live once in `web/layers.mjs` (home table and `/docs/layers/<id>/`); the build fails on a `quay` command or flag the CLI's help does not list. Third-party marks: only NEAR's own logo and Built on NEAR badge files; every other tool (OutLayer, FastNEAR, Cloudflare Workers) is its name in type. Every byte is stored on chain, so check the size of `web/dist` against the product account's free balance before a deploy. Headless dashboard tests can supply a wallet stub as `globalThis.QUAY_TEST_WALLET`; never sign in a visible browser.
- Hosts: Workers mirrors in `web/hosts.json` first, then `https://<name>.testnet.page` (one operator, has had outages), then `quay gateway --account <id>`. An extra host label on testnet.page fails TLS.
- OutLayer calls take 5–20 s. A relayed delegate's deposit is paid by the relayer, so the relay policy refuses any deposit. Large files go to FastFS by default (served a few minutes after upload); NEARFS does not serve new testnet uploads.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
