# Quay

Testnet contract and CLI that publish sealed site releases and move a production pointer. Account, gateway, and RPC defaults are in `quay.json`. Judge steps are in `README.md`.

- Build the wasm with one cargo job: `cd contract && CARGO_BUILD_JOBS=1 cargo near build non-reproducible-wasm`. Output is `contract/target/near/quay.wasm` and is gitignored.
- Tests: `cargo test --manifest-path contract/Cargo.toml -- --test-threads=8`. The `unit-testing` feature is a dev-dependency only. Do not enable it for `cargo near build`.
- Run one heavy cargo or wasm build at a time.
- `near` and `cargo-near` live in `~/.cargo/bin`. Keys stay in `~/.near-credentials`. Never commit or print a key.
- Network is testnet. Do not use mainnet, NEAR Intents, or real funds.
- Official NEAR skills live in `.grok/skills/` and are gitignored. The docs MCP is `.grok/config.toml`.
- A full-access key can replace the wasm. Releases are not owner-proof.
- The public gateway serves paths on `<account>.testnet.page`. An extra host label fails TLS.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
