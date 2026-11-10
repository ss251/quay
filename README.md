# Quay

Quay publishes a folder of files to a NEAR testnet account. Each publish is a sealed release with its own URL. Production is a pointer you move with `quay promote` or `quay rollback`. A publish-only key can upload a preview. It cannot move production.

The product site is https://quay-esc0v902.testnet.page/. The dashboard is https://quay-esc0v902.testnet.page/dashboard/. A sample with three releases and one rollback is https://quay-65nqd3rn.testnet.page/. The earlier demo on https://quay-bb.testnet.page/ is still serving.

## Install

You need Node 20 or newer, and a checkout of this repo. The package is not on the npm registry.

```sh
npm install -g ./cli
quay init
quay deploy ./dist -m "first landing"
quay promote 1
quay open
```

`quay init` asks the testnet faucet for an account, deploys the contract, and writes `quay.json`. Keys stay in `~/.near-credentials/testnet/`. From a checkout you can skip the install and run `node cli/bin/quay.js`.

`quay --help` lists every command. The same text is on the docs page, generated from that help.

## Sixty seconds

1. `quay init` creates the account and the contract.
2. `quay deploy ./dist -m "first landing"` uploads the folder, skips bytes already stored, and prints a preview URL such as `https://<name>.testnet.page/r/1/`.
3. `quay promote 1` points the host root at that release. The preview URL does not change.
4. `quay rollback` swaps production with the previous release.

A directory needs `index.html`. Put `404.html` in the folder for unknown paths. `--spa` serves `index.html` for those paths instead. The CLI prints a storage estimate before it spends. On a terminal it asks you to continue. `--yes` skips the question. `--dry-run` stops after the estimate.

## What a release costs

NEAR locks 0.01 NEAR per 1,000 bytes of stored state, about 1 NEAR per 100 KB, plus a little for each trie record. Deleting a release that is not production unlocks those bytes on the contract account. The lock is not transferred to you. The contract wasm is 216,419 bytes and locks a little over 2 NEAR by itself.

The two accounts funded for this repo came from the faucet at about 10 NEAR each. Gas burned about 0.01 NEAR in total. Storage still locked is about 2.56 NEAR on `quay-esc0v902.testnet` (contract plus the product site) and about 2.27 NEAR on `quay-65nqd3rn.testnet` (contract plus the sample).

## CI

```sh
quay keys create --ci
```

The secret is printed once. Store it as the GitHub Actions secret `QUAY_CI_KEY`, and the account id as `QUAY_ACCOUNT`. The composite action is `action/action.yml`. The example workflow is `examples/harbour/.github/workflows/preview.yml`. A job that uses that key can deploy. `quay promote` exits 3 before it sends. On chain, a relayed promote is refused: https://explorer.testnet.near.org/transactions/8efXfntramSDtXuWpA87kAWpsMwYQPo7QUzwPo6AuM4G

## Layout

| Path | What it is |
| --- | --- |
| `contract/` | The Rust contract. Interface in `docs/contract-interface.md`. |
| `cli/` | The `quay-near` package. Vendored wasm in `cli/vendor/quay.wasm`. |
| `web/` | Landing page, docs, and dashboard. `node web/build.mjs` writes `web/dist`. |
| `examples/harbour/` | The Vite sample. |
| `examples/agent/` | A script that calls the CLI as a library. |
| `examples/original-demo/` | The pages sealed on `quay-bb.testnet`. |
| `action/` | The GitHub Actions preview action. |

`sh scripts/build.sh` builds the site and the sample. `sh scripts/test.sh` runs the contract tests, the CLI tests, and the sandbox suite. `sh scripts/judge.sh` checks the live sites and does not need a key.

## Judge steps

No key. You need `cargo`, `curl`, `node`, `shasum`, and `near` (near-cli-rs) on `PATH`. The same checks are `sh scripts/judge.sh`.

The v1 site stays up. Do these and see the old demo, then the product.

1. Run the contract tests.

   ```sh
   cargo test --manifest-path contract/Cargo.toml -- --test-threads=8
   ```

   See `sealed_release_bytes_stick` and `publish_key_cannot_promote` pass.

2. Open the v1 production page.

   ```sh
   curl -fsS https://quay-bb.testnet.page/
   ```

   See `production: release`. The response `cache-control` is `public, max-age=0, must-revalidate`.

3. Open v1 release 1 and hash the body.

   ```sh
   curl -fsS https://quay-bb.testnet.page/r/1 | shasum -a 256
   ```

   See `release 1`. See `041da882874158377a29812cbb3da2a77e689ec650af7a20313021ef13b6f297`, the same digest as `examples/original-demo/releases/1.sha256`. That response is cached `public, max-age=31536000, immutable`.

4. Read the v1 production pointer.

   ```sh
   near contract call-function as-read-only quay-bb.testnet get_production json-args '{}' network-config testnet now
   ```

   See `"2"`.

5. Open the v1 rejected promote.

   https://explorer.testnet.near.org/transactions/9HNfzPWK5GMzfQQ7J5U9fTJGv4wtmieqkZMGE3sQ5esG

   See a delegate action signed by `ed25519:5ibCru26UTkfcfhxQe4EKk4b5Mhpwh78zjKNGaEXzgxT` calling `promote`. The receipt fails with `MethodNameMismatch`.

6. Open the product site.

   ```sh
   curl -fsS https://quay-esc0v902.testnet.page/
   curl -fsS https://quay-esc0v902.testnet.page/docs/
   curl -fsS https://quay-esc0v902.testnet.page/dashboard/
   ```

   See "Move production when you mean to" on the home page, `quay deploy` in the docs, and the dashboard. The site was sealed in [8cw5GJDwYGPkfXVDPV2D5pv1i3EwcfKAzjMGgkh7g4YW](https://explorer.testnet.near.org/transactions/8cw5GJDwYGPkfXVDPV2D5pv1i3EwcfKAzjMGgkh7g4YW) and promoted in [7yA3L73W6HVbjKUR1BuZdU1TVRG7GKxsNUE83NKRJGsR](https://explorer.testnet.near.org/transactions/7yA3L73W6HVbjKUR1BuZdU1TVRG7GKxsNUE83NKRJGsR).

7. Open the sample. Production is release 2 after a rollback. Releases 1 and 3 are still at their URLs.

   ```sh
   curl -fsS https://quay-65nqd3rn.testnet.page/
   curl -fsS https://quay-65nqd3rn.testnet.page/r/1/
   curl -fsS https://quay-65nqd3rn.testnet.page/r/3/
   ```

   See `id="release">2` on production, `1` on `/r/1/`, and `3` on `/r/3/`. The rollback transaction is [ED8gqjTUsZSsB31TbV2sHAz4wfX1LvUPYQnpSsfH1ixz](https://explorer.testnet.near.org/transactions/ED8gqjTUsZSsB31TbV2sHAz4wfX1LvUPYQnpSsfH1ixz).

8. Read the sample status. No key.

   ```sh
   curl -fsS https://test.rpc.fastnear.com -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","account_id":"quay-65nqd3rn.testnet","method_name":"get_status","args_base64":"e30=","finality":"final"}}'
   ```

   The result bytes decode to JSON with `"version":"2.0.0"`, `"production":"2"`, and `"previous":"3"`.

9. Open the v2 publish-only refusal.

   https://explorer.testnet.near.org/transactions/8efXfntramSDtXuWpA87kAWpsMwYQPo7QUzwPo6AuM4G

   The signer is the publish-only key `ed25519:DaAfMdDQ8hdVNvCu75Z7su3uZpoapwFDJjMrL4B3TMvx` on `quay-65nqd3rn.testnet`. The call is `promote` with id `ci-prove`. The receipt fails because that key's method list is `put_chunk` and `seal`.

The v1 contract was deployed in [3PJ5vXuwsrMebY9bgSxuSVUnc5hYFqohHxMqiygESiUu](https://explorer.testnet.near.org/transactions/3PJ5vXuwsrMebY9bgSxuSVUnc5hYFqohHxMqiygESiUu) and kept across a later code deploy in [FJEpxzffwhyFcHHTfxezs5PUobXqhPJUuZfMTMjvfZaD](https://explorer.testnet.near.org/transactions/FJEpxzffwhyFcHHTfxezs5PUobXqhPJUuZfMTMjvfZaD). An outsider promote panicked `only this account` in [GgWVBft3oR9jDUj8UWtrCFLLEh3XB9qa5z7ExgL7VoW3](https://explorer.testnet.near.org/transactions/GgWVBft3oR9jDUj8UWtrCFLLEh3XB9qa5z7ExgL7VoW3). Production on that account was moved to release 2 in [5zZvwp45vB3Rq4BLFTpqxQyvWrhAwS8qv8UFtrDcZmPJ](https://explorer.testnet.near.org/transactions/5zZvwp45vB3Rq4BLFTpqxQyvWrhAwS8qv8UFtrDcZmPJ). It is still `"2"`.

## Limits

Testnet only. The CLI refuses any other network. The public pages depend on the `testnet.page` gateway. An extra host label, such as `www.<account>.testnet.page`, fails TLS. A full-access key can replace the wasm. Releases are not owner-proof against that key. The payload cap is 2,000,000 bytes. Details, including the chunk and file limits, are on the docs page.

`migrate` can read the v1 state shape. It was not run on `quay-bb.testnet`. That account keeps the v1 wasm so the old URLs stay stable.

The dashboard signs promote, rollback, and delete with the wallet's `signAndSendTransaction`. This pass checked lookup, empty, and error states in a browser. It did not complete a wallet popup.

## Built with NEAR's official tooling

The contract is near-sdk 5.30.1. The CLI uses near-api-js 7.4.0. Sandbox tests use near-sandbox 0.4.0 and near-api 0.8.7, which is what the current `near-smart-contracts` skill uses for a local node. The dashboard loads `@hot-labs/near-connect` 0.12.0 from esm.sh and does not put a key in the page. Skills installed in this worktree: `near-smart-contracts`, `near-contract-audit`, `near-cli-rs`, `near-dapp`, `near-api-js`, and `near-kit`. Contract questions were checked against NEAR Docs at `https://docs.near.org/mcp`. The v1 judge step still uses near-cli-rs. The product CLI does not.

## Disclosure

This code was written with AI coding agents: xAI Grok 4.7, through the Grok Build client.
