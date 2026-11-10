# Quay

Quay publishes a folder of files to a NEAR testnet account. Each publish is a sealed release with its own URL. Production is a pointer you move with `quay promote` or `quay rollback`. A publish-only key can upload a preview. It cannot move production.

Hosts, in the order to try them:

| Site | Account | Workers (primary) | testnet.page | Local |
| --- | --- | --- | --- | --- |
| Product site and dashboard | `quay-esc0v902.testnet` | https://quay.ss251.workers.dev/ and `/dashboard/` | https://quay-esc0v902.testnet.page/ | `quay gateway --account quay-esc0v902.testnet`, then http://127.0.0.1:8787/ |
| Harbour sample, five releases, production on 5 | `quay-65nqd3rn.testnet` | https://quay-harbour.ss251.workers.dev/ | https://quay-65nqd3rn.testnet.page/ | `quay gateway --account quay-65nqd3rn.testnet`, then http://127.0.0.1:8787/ |
| Old demo, left on v1 | `quay-bb.testnet` | none | https://quay-bb.testnet.page/ | `quay gateway --account quay-bb.testnet` |

The Workers hosts are the owner's Cloudflare account running `gateway/worker` unchanged, one site per host. They exist because `testnet.page` answered every account with HTTP 400 for several hours on 2026-11-10 (deprecated default RPC). The mirrors are listed in `web/hosts.json`. The static pages use relative links, so they work on whichever host serves them.

Status on 2026-11-11: both live contracts report version 2.0.0. The full-stack layers below are written and tested in this repo. They are not deployed to a testnet account, so each is marked pending.

## Install

You need Node 20 or newer, and a checkout of this repo. The package is not on the npm registry.

```sh
npm install -g ./cli
quay init
quay deploy ./dist -m "harbour office"
quay promote 1
quay open
```

`quay init` asks the testnet faucet for an account, deploys the contract, and writes `quay.json`. It prints the funded balance, the contract version, the transaction link, and the next command. The first time it calls the gateway it waits until TLS answers, usually under two minutes. Keys stay in `~/.near-credentials/testnet/`. From a checkout you can skip the install and run `node cli/bin/quay.js`.

`quay --help` lists every command. The same text is on the docs page, generated from that help.

A packed tarball was installed outside this repo and used for a full init, deploy, promote, and rollback. That check is `cli/test/pack.test.mjs`. The live run created `quay-i7qkbbp3.testnet` in [8uJPJg5fNt6Sp8nuFzg5NgvyBqmyDfgshP9Q6UhcQFm](https://explorer.testnet.near.org/transactions/8uJPJg5fNt6Sp8nuFzg5NgvyBqmyDfgshP9Q6UhcQFm), sealed release 1 in [7Gcpxbytc7e38PQKmcEreEWbbUxhKLxJJqoPmtW4Zu6m](https://explorer.testnet.near.org/transactions/7Gcpxbytc7e38PQKmcEreEWbbUxhKLxJJqoPmtW4Zu6m), promoted it in [7mTJfzbzDndriv1yp19qwdMmLdLRV1Vn2kEegGkGD3L3](https://explorer.testnet.near.org/transactions/7mTJfzbzDndriv1yp19qwdMmLdLRV1Vn2kEegGkGD3L3), sealed release 2 in [981d7EKomzu74xVGLz1TMqMMyPACFoLhZSDN7y5g8wNZ](https://explorer.testnet.near.org/transactions/981d7EKomzu74xVGLz1TMqMMyPACFoLhZSDN7y5g8wNZ), promoted it in [jJmjCbiszXx55TixVBFoAnaBBoHnHnT3HPdzWPjzBix](https://explorer.testnet.near.org/transactions/jJmjCbiszXx55TixVBFoAnaBBoHnHnT3HPdzWPjzBix), and rolled back in [BVd5snJxXBwe2Hp26UB4NdKaPn4AB6C98vpsQLawpwHb](https://explorer.testnet.near.org/transactions/BVd5snJxXBwe2Hp26UB4NdKaPn4AB6C98vpsQLawpwHb).

## Sixty seconds

1. `quay init` creates the account and the contract.
2. `quay deploy ./dist -m "harbour office"` uploads the folder, skips bytes already stored, and prints a preview URL such as `https://<name>.testnet.page/r/1/`, the seal transaction, and `quay promote 1`.
3. `quay promote 1` points the host root at that release. The preview URL does not change.
4. `quay rollback` swaps production with the previous release.

A directory needs `index.html`. Put `404.html` in the folder for unknown paths. `--spa` serves `index.html` for those paths instead. The CLI prints a storage estimate before it spends. On a terminal it asks you to continue. `--yes` skips the question. `--dry-run` stops after the estimate.

## What a release costs

NEAR locks 0.01 NEAR per 1,000 bytes of stored state, about 1 NEAR per 100 KB, plus a little for each trie record. Deleting a release that is not production unlocks those bytes on the contract account. The lock is not transferred to you. The contract wasm is 216,419 bytes and locks a little over 2 NEAR by itself.

After the current product deploy, `quay-esc0v902.testnet` holds 9.9724 NEAR, of which 7.4776 is locked and 2.4948 is free. It keeps nine releases: the old design (4), four earlier builds of the new one (5 to 8), and production (9). Deleting 5 to 7 with `quay delete` would unlock most of what those previews hold. The harbour sample holds 9.9698 NEAR, of which 2.4704 is locked and 7.4994 is free. Its sealed files are 17,717 bytes. The packed-CLI account holds 10.0134 NEAR, of which 2.3151 is locked and 7.6983 is free, and the contract reports 7,674 stored bytes.

## CI

```sh
quay keys create --ci
```

The secret is printed once. Store it as the GitHub Actions secret `QUAY_CI_KEY`, and the account id as `QUAY_ACCOUNT`. The composite action is `action/action.yml`. The example workflow is `examples/harbour/.github/workflows/preview.yml`. `sh scripts/ci-local.sh` runs those steps without GitHub: it installs the CLI, deploys with the publish-only key, and requires `quay promote --ci` to exit 3.

The key's method list is `put_chunk` and `seal`. Allowance is omitted, so gas is unlimited. A function-call key still cannot attach the 1 yoctoNEAR deposit that promote, rollback, and delete require. On `quay-i7qkbbp3.testnet` the local script sealed a preview, refused promote before a transaction, and an on-chain promote with that key failed in [58YRcXZZZMPrmNgNCpEm4ssTWC6sCM73we6wKKD9smTT](https://explorer.testnet.near.org/transactions/58YRcXZZZMPrmNgNCpEm4ssTWC6sCM73we6wKKD9smTT). An earlier harbour key was created with a zero gas allowance, so it cannot pay for `put_chunk`. Its promote refusal is still [8efXfntramSDtXuWpA87kAWpsMwYQPo7QUzwPo6AuM4G](https://explorer.testnet.near.org/transactions/8efXfntramSDtXuWpA87kAWpsMwYQPo7QUzwPo6AuM4G).

## An agent

`examples/agent` calls the CLI as a library. A live run against `quay-i7qkbbp3.testnet` paid for storage from `quay-65nqd3rn.testnet` in [89XB1BDKEFzGn6y6RZGevttW9bQiugajskaYfBHfBXE1](https://explorer.testnet.near.org/transactions/89XB1BDKEFzGn6y6RZGevttW9bQiugajskaYfBHfBXE1) and sealed the page in [5e8XmDaueVSLJ6fcvC5mnpevzFFBewYFswwrWk74sEfQ](https://explorer.testnet.near.org/transactions/5e8XmDaueVSLJ6fcvC5mnpevzFFBewYFswwrWk74sEfQ). The preview is https://quay-i7qkbbp3.testnet.page/r/4/. Promote with the publish-only key was refused before a transaction.

## Dashboard signing

Open `https://quay.ss251.workers.dev/dashboard/?account=<account>` (or the same path on `https://quay-esc0v902.testnet.page`). The page reads without a key. Sign in with a testnet wallet that near-connect offers, then promote, roll back, or delete. The page never holds a key.

MyNearWallet's testnet app imported `quay-i7qkbbp3.testnet`, and then stopped short: the testnet wallet list does not offer MyNearWallet, and that wallet has switched off new app connections. Intear Wallet, in the same headless browser, signed in as that account and rolled production back to release 2 in [GdZ42tyCTj5AWGyUsFGZzbyTjAC7YiG9j3oDkoTYcAQw](https://explorer.testnet.near.org/transactions/GdZ42tyCTj5AWGyUsFGZzbyTjAC7YiG9j3oDkoTYcAQw).

## Layout

| Path | What it is |
| --- | --- |
| `contract/` | The Rust contract. Interface in `docs/contract-interface.md`. |
| `cli/` | The `quay-near` package. Vendored wasm in `cli/vendor/quay.wasm`. |
| `web/` | Landing page, docs, layers, architecture, and dashboard. `node web/build.mjs` writes `web/dist`. |
| `gateway/` | `@quay/gateway`: serves a site over RPC on Node, Deno, Bun, a container, or Cloudflare Workers. Read `gateway/README.md`. |
| `client/` | `@quay/client`: db, sign-in, member sessions and the relayer host. Read `client/README.md`. |
| `functions/` | Rust guests for OutLayer: `quay-fn` helper, `moderate`, `digest`, `preview`, `relay`. |
| `examples/board/` | The Harbour Board sample that uses every layer. Read `examples/board/README.md`. |
| `examples/harbour/` | The Vite sample. |
| `examples/agent/` | A script that calls the CLI as a library. |
| `examples/original-demo/` | The pages sealed on the old v1 demo. |
| `action/` | The GitHub Actions preview action. |

`sh scripts/build.sh` builds the site and the sample. `sh scripts/test.sh` runs the contract tests, the CLI tests, and the sandbox suite. `sh scripts/judge.sh` checks the live sites and does not need a key.

## Judge steps

No key. You need `cargo`, `curl`, `node`, and `shasum` on `PATH`. The same checks are `sh scripts/judge.sh`.

1. Run the contract tests.

   ```sh
   cargo test --manifest-path contract/Cargo.toml -- --test-threads=8
   ```

   See `sealed_release_bytes_stick` and `publish_key_cannot_promote` pass.

2. Open the product site.

   ```sh
   curl -fsS https://quay.ss251.workers.dev/
   curl -fsS https://quay.ss251.workers.dev/docs/
   curl -fsS 'https://quay.ss251.workers.dev/dashboard/?account=quay-65nqd3rn.testnet'
   ```

   Same paths on `https://quay-esc0v902.testnet.page` if the Workers host is down.

   See "Move production on purpose", `quay deploy`, and "Try the sample". The live release, 9, was sealed in [GegcmRL3wurnmnQGqZk7bAqK5mKizR5b5fP611CKRxTg](https://explorer.testnet.near.org/transactions/GegcmRL3wurnmnQGqZk7bAqK5mKizR5b5fP611CKRxTg) and promoted in [CvfPW9CGFDA1JdMk5nGgW9PmBJi1PpXxmZbJRW4cvnPw](https://explorer.testnet.near.org/transactions/CvfPW9CGFDA1JdMk5nGgW9PmBJi1PpXxmZbJRW4cvnPw). The previous design is still release 4, at https://quay.ss251.workers.dev/r/4/.

   If neither host answers, run `node cli/bin/quay.js gateway --account quay-esc0v902.testnet` (or `quay gateway --account quay-esc0v902.testnet`) and open http://127.0.0.1:8787/, http://127.0.0.1:8787/docs/, http://127.0.0.1:8787/dashboard/?account=quay-65nqd3rn.testnet, and http://127.0.0.1:8787/r/4/.

3. Open the sample. Production is release 5. The previous pointer is 4. Releases 1 to 4 stay at their URLs.

   ```sh
   curl -fsS https://quay-harbour.ss251.workers.dev/
   curl -fsS https://quay-harbour.ss251.workers.dev/berth/
   curl -fsS https://quay-harbour.ss251.workers.dev/chart.svg
   curl -fsS https://quay-harbour.ss251.workers.dev/r/1/
   curl -fsS https://quay-harbour.ss251.workers.dev/r/3/
   ```

   Same paths on `https://quay-65nqd3rn.testnet.page` if the Workers host is down.

   See `id="release">5` on production, the berth page, the chart, `1` on `/r/1/`, and `3` on `/r/3/`.

   If neither host answers, run `quay gateway --account quay-65nqd3rn.testnet` and open http://127.0.0.1:8787/, http://127.0.0.1:8787/berth/, http://127.0.0.1:8787/chart.svg, http://127.0.0.1:8787/r/1/, and http://127.0.0.1:8787/r/3/. Run one gateway per account, or pass `--port` for a second one. `sh scripts/judge.sh` tries the Workers host, then `testnet.page`, then a local gateway for each page, and prints which one answered.

   Seals and promotions: release 1 [vJzgAg1JYR4FFhMEVXnQCxC9RmLBmzr7Gef5WTBpSb1](https://explorer.testnet.near.org/transactions/vJzgAg1JYR4FFhMEVXnQCxC9RmLBmzr7Gef5WTBpSb1) and [CQL9fMZRyu2wQ3kYGHfoiuc1Fwpk57aA95fwL7i1nft5](https://explorer.testnet.near.org/transactions/CQL9fMZRyu2wQ3kYGHfoiuc1Fwpk57aA95fwL7i1nft5), release 2 [FZbrU9eYKc4D1zCoQUq9UawjCsWj2cVH5DPLKFKeyEno](https://explorer.testnet.near.org/transactions/FZbrU9eYKc4D1zCoQUq9UawjCsWj2cVH5DPLKFKeyEno) and [2koqS96kNYpFn7rarWzwEDHd9A48Ux18t5QEzHySnSkn](https://explorer.testnet.near.org/transactions/2koqS96kNYpFn7rarWzwEDHd9A48Ux18t5QEzHySnSkn), release 3 [u7An7nxhdYpuGL9r2vcsSGMDWbMGX4QRkkMYktaHTkv](https://explorer.testnet.near.org/transactions/u7An7nxhdYpuGL9r2vcsSGMDWbMGX4QRkkMYktaHTkv) and [bhdz1aR5f6HMSbTwCGE9PgxRMhpq8zV64YWcgb18bH4](https://explorer.testnet.near.org/transactions/bhdz1aR5f6HMSbTwCGE9PgxRMhpq8zV64YWcgb18bH4), the rollback [ED8gqjTUsZSsB31TbV2sHAz4wfX1LvUPYQnpSsfH1ixz](https://explorer.testnet.near.org/transactions/ED8gqjTUsZSsB31TbV2sHAz4wfX1LvUPYQnpSsfH1ixz), release 4 [5YMNMexGTbGeqQHQvrnNp2L6SEsMXVs3Q4dyfUnfHZjc](https://explorer.testnet.near.org/transactions/5YMNMexGTbGeqQHQvrnNp2L6SEsMXVs3Q4dyfUnfHZjc) and [F56bq5R6EKCnNHcY1MsEboJYB214kpGdkWu2shbyvNz1](https://explorer.testnet.near.org/transactions/F56bq5R6EKCnNHcY1MsEboJYB214kpGdkWu2shbyvNz1), release 5 [Ga6YgGiUtyPJEWUKdpt5tqeCGn3wk4W8b6KowkBe17eB](https://explorer.testnet.near.org/transactions/Ga6YgGiUtyPJEWUKdpt5tqeCGn3wk4W8b6KowkBe17eB) and [9hThf6KFAUPvpiacbMEBY79RpK1woQ9NqvRdLS9KPAUL](https://explorer.testnet.near.org/transactions/9hThf6KFAUPvpiacbMEBY79RpK1woQ9NqvRdLS9KPAUL). The account-creation transaction for this sample was not retained.

4. Read the sample status. No key.

   ```sh
   curl -fsS https://test.rpc.fastnear.com -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","account_id":"quay-65nqd3rn.testnet","method_name":"get_status","args_base64":"e30=","finality":"final"}}'
   ```

   The result bytes decode to JSON with `"version":"2.0.0"`, `"production":"5"`, and `"previous":"4"`.

5. Open the publish-only refusal.

   https://explorer.testnet.near.org/transactions/58YRcXZZZMPrmNgNCpEm4ssTWC6sCM73we6wKKD9smTT

   The receipt fails because that key cannot call `promote`.

## Full-stack layers

One account can hold a site's pages, data, sign-in, scheduled work and payments. The interface is frozen in `docs/fullstack-interface.md`. Command help for every layer is on the docs site at `/docs/layers/`. Who you trust for each layer, and how to replace it, is at `/architecture/`.

"Proven" below means a transaction or a request we made on testnet. The layer rows say which of those used Quay's own contract and which were spikes with plain accounts. Spikes ran on 2026-11-10. Nothing in this section is deployed to a Quay account yet except the site and the gateway.

**Site (live).** `quay init`, `quay deploy ./dist`, `quay promote`, `quay rollback`. Proven: the transactions in this README, contract 2.0.0 on two accounts.

**Gateway (live).** `quay gateway --account <id>` serves a site from your machine; `node gateway/build.mjs` writes a single file for Node, Deno or Bun, and `cd gateway/worker && npx wrangler deploy` ships the Workers build. Proven: `https://quay.ss251.workers.dev/` and `https://quay-harbour.ss251.workers.dev/` answer from RPC, and `scripts/judge.sh` fetches through them. Measured: the public `testnet.page` outage of 2026-11-10.

**Data (pending deploy).** `quay db collection set posts --write anyone --payer site --moderated`, `quay db fund 2`, `quay db add posts '{"title":"…"}'`, `quay db list posts`. Pending: the v3 contract is not on a testnet account.

**Members and sign-in (pending deploy).** `quay members list|open|close`; sign-in is NEP-413 through `@quay/client`. Spike proof: a zero-balance sub-account in [CEshJvn3…](https://explorer.testnet.near.org/transactions/CEshJvn3mucm4VhfuGhBkBdJD99Y6JWV2XHTNkyQucBi). Quay's `join` is pending.

**Relay (pending deploy).** `quay relay create --near 0.5`, `quay relay serve --port 8788`, `quay relay status`. Spike proof: a relayed delegate [HpNGtV3W…](https://explorer.testnet.near.org/transactions/HpNGtV3WQLtCNsmMU8gbidDhB1d7gB9wCpvPMs35cxkY), a function-call session key delegate [BkN8S7Zx…](https://explorer.testnet.near.org/transactions/BkN8S7Zx3xsvA9SppF9ghCLXnGdb86jYMtBuiudxUCie), and a delegate with a deposit, which the relayer paid, [4zVRVvNh…](https://explorer.testnet.near.org/transactions/4zVRVvNhL25VbXCkbAbjp6vvxNJxxtZVc5FzSD1Gvk8v). That is why Quay's relayer refuses any deposit. Quay's relay against a v3 site is pending.

**Functions (pending deploy).** Rust compiled to WASI and run on OutLayer. `quay functions` and `quay secrets` are not in this CLI build yet, so the docs page shows no help for them. Spike proof: a function with a secret and outbound HTTPS, called from a contract by yield and resume, [A2JT46x6…](https://explorer.testnet.near.org/transactions/A2JT46x6jHYfhQ55weJFcHwNMwn2eumy75LdQX4yRnpg), and over HTTPS, with the wasm fetched from a URL and no GitHub. Quay's registry is pending.

**Routes (pending deploy).** Declared in `quay.json` and applied by `quay up`. `quay up --dry-run` checks every route and template. Pending: the contract renderer is not deployed.

**Large files (blocked on testnet).** `files.external_over` and `quay up --store nearfs|pinata|filebase`. NEARFS accepted an `fs_store` upload in [9xj3bLha…](https://explorer.testnet.near.org/transactions/9xj3bLhaN7MFp7xwwteAhduq5GsXfqYT74LiXoB2fbV8) and did not serve it: 404 for hours. Pinata and Filebase were not run against the live services.

**Payments (pending deploy).** `quay products set pin --name "Pin for a day" --price 0.1 --grant pin --pin-seconds 86400`, `quay products token <account>`, `quay receipts`. Pending: not deployed.

**Cron (pending deploy).** `quay cron add "every 60m" digest`, `quay cron arm`, `quay cron status`. The mechanism is a yield chain: a hop about every 2 minutes at about 2.25 Tgas, about 14.5 hours per 1 PGas, then a transaction must re-arm it. Spike proof: [EaBzBzUg…](https://explorer.testnet.near.org/transactions/EaBzBzUgyV9g55njrZUFqFPLXizES3jY6JtD2tn94dLz) and [7Ff67z7N…](https://explorer.testnet.near.org/transactions/7Ff67z7N1eY6ZtnHg1wJmMrkFQbo1S8zw5XxAejDQCa1). Quay's cron is pending.

**`quay up` (pending deploy).** `quay up --dry-run`, then `quay up -m "harbour board"`. It applies `quay.json`, deploys the site with its routes and promotes it. Versioned per release: files, routes and templates. Not versioned: docs, rules, products, members, function code and secrets, relay and cron settings.

## Limits

Testnet only. The CLI refuses any other network. A public page is only as available as the gateway serving it: `testnet.page` is one operator and failed on 2026-11-10, and the Workers hosts are one Cloudflare account. `quay gateway` serves any site from your machine. On `testnet.page` a new host has no certificate until the first request. `quay init` and the first `quay deploy` poll until the gateway answers, and say so. An extra host label, such as `www.<account>.testnet.page`, fails TLS. A full-access key can replace the wasm. Releases are not owner-proof against that key. The payload cap is 2,000,000 bytes. Details, including the chunk and file limits, are on the docs page.

`quay-bb.testnet` was not migrated. The old demo stays on v1 at https://quay-bb.testnet.page/.

## Built with NEAR's official tooling

The contract is near-sdk 5.30.1. The CLI uses near-api-js 7.4.0. Sandbox tests use near-sandbox 0.4.0 and near-api 0.8.7, which is what the current `near-smart-contracts` skill uses for a local node. The dashboard loads `@hot-labs/near-connect` 0.12.0 from esm.sh and does not put a key in the page. Skills installed in this worktree: `near-smart-contracts`, `near-contract-audit`, `near-cli-rs`, `near-dapp`, `near-api-js`, and `near-kit`. Contract questions were checked against NEAR Docs at `https://docs.near.org/mcp`. The product CLI does not shell out to `near`.

## Disclosure

This code was written with AI coding agents: xAI Grok 4.7, through the Grok Build client.
