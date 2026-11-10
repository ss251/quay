# Quay

Testnet contract and CLI that publish sealed site releases and move a production pointer. Live URLs and judge steps are in `README.md`. The method list is `docs/contract-interface.md`. `quay init` writes `quay.json` in the project you run it from.

- Layout is `contract/`, `cli/`, `web/`, `examples/`, `docs/`. Build with `sh scripts/build.sh`. Test with `sh scripts/test.sh`. The wasm the CLI deploys is `cli/vendor/quay.wasm`.
- Rebuild that wasm with one cargo job: `cd contract && CARGO_BUILD_JOBS=1 cargo near build non-reproducible-wasm`, then copy `contract/target/near/quay.wasm` onto the vendor path. `sh scripts/build.sh` does that only when `QUAY_REBUILD_WASM=1`.
- Contract unit tests: `cargo test --manifest-path contract/Cargo.toml -- --test-threads=8`. Sandbox tests: `cargo test --manifest-path contract/sandbox/Cargo.toml -- --test-threads=1`. The `unit-testing` feature is a dev-dependency only. Do not enable it for `cargo near build`.
- Run one heavy cargo or wasm build at a time. Put `$HOME/.cargo/bin` first on `PATH`. The Homebrew cargo on this machine has no wasm target.
- `near` and `cargo-near` live in `~/.cargo/bin`. Keys stay in `~/.near-credentials`. Never commit or print a key. The faucet is the helper POST the CLI uses. If it rate-limits, wait.
- Network is testnet. Do not use mainnet, NEAR Intents, or real funds. Do not migrate `quay-bb.testnet` in place. It stays on the v1 wasm.
- Official NEAR skills live in `.grok/skills/` and are gitignored. The docs MCP is `.grok/config.toml`.
- A full-access key can replace the wasm. Releases are not owner-proof.
- The public host is `https://<name>.testnet.page` for account `<name>.testnet`. An extra host label fails TLS.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
