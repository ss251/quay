# Quay

Quay publishes a folder of files to a NEAR testnet account. Each publish is a sealed release with its own URL. Production is a pointer you move with `quay promote` or `quay rollback`. A publish-only key can upload a preview. It cannot move production.

Hosts, in the order to try them:

| Site | Account | Workers (primary) | testnet.page | Local |
| --- | --- | --- | --- | --- |
| Product site and dashboard | `quay-esc0v902.testnet` | https://quay.ss251.workers.dev/ and `/dashboard/` | https://quay-esc0v902.testnet.page/ | `quay gateway --account quay-esc0v902.testnet`, then http://127.0.0.1:8787/ |
| Harbour sample, five releases, production on 5 | `quay-65nqd3rn.testnet` | https://quay-harbour.ss251.workers.dev/ | https://quay-65nqd3rn.testnet.page/ | `quay gateway --account quay-65nqd3rn.testnet`, then http://127.0.0.1:8787/ |
| Harbour Board, the full-stack sample (contract 3.0.1) | `harbour-board.testnet` | https://harbour-board.ss251.workers.dev/ | https://harbour-board.testnet.page/ | `quay gateway --account harbour-board.testnet`, then http://127.0.0.1:8787/ |
| Old demo, left on v1 | `quay-bb.testnet` | none | https://quay-bb.testnet.page/ | `quay gateway --account quay-bb.testnet` |

The Workers hosts are the owner's Cloudflare account running `gateway/worker` unchanged, one site per host. They exist because `testnet.page` answered every account with HTTP 400 for several hours on 2026-11-10 (deprecated default RPC). The mirrors are listed in `web/hosts.json`. The static pages use relative links, so they work on whichever host serves them.

Status on 2026-11-10 (UTC): the product site and the harbour sample run contract 2.0.0 (releases and the production pointer). Harbour Board runs contract 3.0.1 with data, routes, members, sign-in, a relayer, functions, payments, a large file and an hourly cron job, all on one account. Every layer below says what was proven live and what is weak.

## Install

You need Node 20 or newer, and a checkout of this repo. The package is not on the npm registry.

```sh
npm install -g ./cli
quay init
quay deploy ./dist -m "harbour office"
quay promote 1
quay open
```

`quay init` asks the testnet faucet for an account, deploys the contract, and writes `quay.json`. It prints the funded balance, the contract version, the transaction link, and the next command. The first time it calls the gateway it waits until TLS answers, usually under two minutes. Keys stay in `~/.near-credentials/testnet/`. From a checkout you can skip the global install: run `cd cli && npm install` once, then `node cli/bin/quay.js` from the repo root.

`quay --help` lists every command. The same text is on the docs page, generated from that help.

A packed tarball was installed outside this repo and used for a full init, deploy, promote, and rollback. That check is `cli/test/pack.test.mjs`. The live run created `quay-i7qkbbp3.testnet` in [8uJPJg5fNt6Sp8nuFzg5NgvyBqmyDfgshP9Q6UhcQFm](https://explorer.testnet.near.org/transactions/8uJPJg5fNt6Sp8nuFzg5NgvyBqmyDfgshP9Q6UhcQFm), sealed release 1 in [7Gcpxbytc7e38PQKmcEreEWbbUxhKLxJJqoPmtW4Zu6m](https://explorer.testnet.near.org/transactions/7Gcpxbytc7e38PQKmcEreEWbbUxhKLxJJqoPmtW4Zu6m), promoted it in [7mTJfzbzDndriv1yp19qwdMmLdLRV1Vn2kEegGkGD3L3](https://explorer.testnet.near.org/transactions/7mTJfzbzDndriv1yp19qwdMmLdLRV1Vn2kEegGkGD3L3), sealed release 2 in [981d7EKomzu74xVGLz1TMqMMyPACFoLhZSDN7y5g8wNZ](https://explorer.testnet.near.org/transactions/981d7EKomzu74xVGLz1TMqMMyPACFoLhZSDN7y5g8wNZ), promoted it in [jJmjCbiszXx55TixVBFoAnaBBoHnHnT3HPdzWPjzBix](https://explorer.testnet.near.org/transactions/jJmjCbiszXx55TixVBFoAnaBBoHnHnT3HPdzWPjzBix), and rolled back in [BVd5snJxXBwe2Hp26UB4NdKaPn4AB6C98vpsQLawpwHb](https://explorer.testnet.near.org/transactions/BVd5snJxXBwe2Hp26UB4NdKaPn4AB6C98vpsQLawpwHb).

## Sixty seconds

1. `quay init` creates the account and the contract.
2. `quay deploy ./dist -m "harbour office"` uploads the folder, skips bytes already stored, and prints a preview URL such as `https://<name>.testnet.page/r/1/`, the seal transaction, and `quay promote 1`.
3. `quay promote 1` points the host root at that release. The preview URL does not change.
4. `quay rollback` swaps production with the previous release.

A directory needs `index.html`. Put `404.html` in the folder for unknown paths. `--spa` serves `index.html` for those paths instead. The CLI prints a storage estimate before it spends. On a terminal it asks you to continue. `--yes` skips the question. `--dry-run` stops after the estimate.

## What a release costs

NEAR locks 0.01 NEAR per 1,000 bytes of stored state, about 1 NEAR per 100 KB, plus a little for each trie record. Deleting a release that is not production unlocks those bytes on the contract account. The lock is not transferred to you. The v2 wasm, which the product site and the harbour sample run, is 216,419 bytes and locks a little over 2 NEAR. The v3 wasm in `cli/vendor/quay.wasm`, which `quay init` deploys today, is 295,899 bytes and locks about 2.96 NEAR.

Balances change with every deploy, so they are not listed here. `quay status` prints the production and previous release, the release count and the stored bytes; the explorer shows the balance. The product site keeps its production release, the rollback target and a few older releases; `LIVE.md` lists which.

## CI

```sh
quay keys create --ci
```

The secret is printed once. Store it as the GitHub Actions secret `QUAY_CI_KEY`, and the account id as `QUAY_ACCOUNT`. The composite action is `action/action.yml`. The example workflow is `examples/harbour/.github/workflows/preview.yml`. `sh scripts/ci-local.sh` runs those steps without GitHub: it installs the CLI, deploys with the publish-only key, and requires `quay promote --ci` to exit 3.

The key may call only `put_chunk` and `seal`, and it has no gas allowance cap. Promote, rollback and delete each need a 1 yoctoNEAR deposit, and a function-call key can never attach a deposit, so this key cannot move production. On `quay-i7qkbbp3.testnet` the local script sealed a preview, refused promote before a transaction, and an on-chain promote with that key failed in [58YRcXZZZMPrmNgNCpEm4ssTWC6sCM73we6wKKD9smTT](https://explorer.testnet.near.org/transactions/58YRcXZZZMPrmNgNCpEm4ssTWC6sCM73we6wKKD9smTT). An earlier harbour key was made with a zero gas allowance by mistake, so it cannot even upload. Its refused promote is still [8efXfntramSDtXuWpA87kAWpsMwYQPo7QUzwPo6AuM4G](https://explorer.testnet.near.org/transactions/8efXfntramSDtXuWpA87kAWpsMwYQPo7QUzwPo6AuM4G).

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

   See "Move production on purpose" and `quay deploy` on `/`, and "Try the sample" on `/dashboard/`. The production release and its seal and promote transactions are in the table at the top of `LIVE.md` (release 12 on 2026-11-10, sealed in [EBb1X1jb…](https://explorer.testnet.near.org/transactions/EBb1X1jbSGbd7jCRxie1G6fEtX1XURmAXLQTQqPzhwGv) and promoted in [2zL7JdE7…](https://explorer.testnet.near.org/transactions/2zL7JdE7sLH4QS1QXAbdKr4DsoHqCXbLm8ySXzSuBmTn)). The previous design is still release 4, at https://quay.ss251.workers.dev/r/4/.

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

6. Open Harbour Board, the full-stack sample. Try the Workers host first, then `https://harbour-board.testnet.page`, then a local gateway.

   ```sh
   curl -fsS https://harbour-board.ss251.workers.dev/
   curl -fsS https://harbour-board.ss251.workers.dev/api/posts
   curl -sS -o /dev/null -w '%{http_code}\n' https://harbour-board.ss251.workers.dev/posts/9
   ```

   If both hosts are down, run `quay gateway --account harbour-board.testnet` and open http://127.0.0.1:8787/, http://127.0.0.1:8787/api/posts and http://127.0.0.1:8787/posts/9.

   See "Harbour digest" on `/` with a digest "Written … by the hourly digest job" (or "run by hand", or a failed run named as failed), the two pinned posts first while their 24 hour pins last, 13 or more posts in `/api/posts` without post 9, and `404` for `/posts/9`. The RPC views for members, functions, receipts and the large file are in "Full-stack layers". `sh scripts/judge.sh` step 9 runs all of them.

## Full-stack layers

One account holds a site's pages, data, sign-in, scheduled work and payments. The interface is in `docs/fullstack-interface.md`. Command help for every layer is on the docs site at `/docs/layers/`. Who you trust for each layer, and how to replace it, is at `/architecture/`. Every transaction is recorded in `examples/board/LIVE.md`.

"Live" means we made the transaction or request on testnet, and the link or command below lets you check it. The sample is Harbour Board, https://harbour-board.ss251.workers.dev/ (or https://harbour-board.testnet.page/), account `harbour-board.testnet`. All checks need no key. `sh scripts/judge.sh` runs them.

Define this once for the RPC checks:

```sh
view() {
  curl -fsS https://test.rpc.fastnear.com -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"account_id\":\"harbour-board.testnet\",\"method_name\":\"$1\",\"args_base64\":\"$(printf '%s' "$2" | base64)\",\"finality\":\"final\"}}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).result.result).toString()))'
}
```

**Site (live).** `quay init`, `quay deploy ./dist`, `quay promote`, `quay rollback`. Proven by the transactions in this README on contract 2.0.0, and on the Board: [init](https://explorer.testnet.near.org/transactions/9He5iL5Ne5b5XBhWDAj34PmW3hg26tYYuGx6xoNuGBaz), release 7 [sealed](https://explorer.testnet.near.org/transactions/DrGVTiLyDNC1Mer9nkks55NCcuf9XvfLwsWL2pUZXSVz) and [promoted](https://explorer.testnet.near.org/transactions/G82qz1qKMiTaeMwAiEgefutWtvCFCMs73B9JLx9Ybmfx). Check: `view get_status '{}'` shows the production release; later deploys move it.

**Gateway (live).** `quay gateway --account <id>` serves a site from your machine, `node gateway/build.mjs` writes a single file for Node, Deno or Bun, and `cd gateway/worker && npx wrangler deploy` ships the Workers build. Proven: the three Workers hosts answer from RPC, the Board is also served by `testnet.page` and by a local gateway, and `scripts/judge.sh` falls back through all three kinds. Measured: the `testnet.page` outage of 2026-11-10. Check: `curl -fsS https://quay.ss251.workers.dev/_quay/health`.

**Data (live).** `quay db collection set`, `quay db fund`, `quay db add|list|rm|hide`. The Board's `posts` collection is `write: anyone`, `payer: site`, moderated, with `on_add: moderate`. Proven: [collection](https://explorer.testnet.near.org/transactions/AEg7rzCvAYnvr3R9gUdukQDZ2jsZSMkiRwFTS6r2dyp9), [pool funded](https://explorer.testnet.near.org/transactions/DPnpKqji4wcLbgeHD9PukEu3trVKPZyE2HYn56hqAmqp). Check: `view list_collections '{}'`, `view db_list '{"collection":"posts","query":{"limit":5}}'`.

**Routes (live).** The contract fills templates sealed in the release, so a page is complete HTML without JavaScript. Proven: https://harbour-board.ss251.workers.dev/ lists posts with the digest, `/posts/5` renders one, `/api/posts` is JSON, and the hidden spam post is a 404 at `/posts/9`. Check: `curl -fsS https://harbour-board.ss251.workers.dev/api/posts`, then `view get_release` with the id from `get_status` to see the sealed routes.

**Members (live).** `quay members list|open|close`. A member is `<name>.harbour-board.testnet`, created with no NEAR. At least nine exist: six seeded, one from a browser check of the live `/new/` page, and two `tg-…` members from the separate Telegram sign-in work on the same account. Proven through both relays below. Check: `view list_members '{"from_index":0,"limit":50}'`.

**Sign-in (live, one wallet).** Members joined and posted from the live `/new/` page in a headless browser, signing with a key that stays in the browser. Wallet sign-in through near-connect worked with one connector, NEAR CLI: it signed a NEP-413 message for `walletchk-he8kli.harbour-board.testnet`, the Board accepted it, and `verifySignIn` returned `ok` while a changed message and a wrong site were refused. Intear's testnet index was empty and Meteor blocks headless browsers, so those wallets are not shown. Details in `examples/board/LIVE.md`.

**Relay (live).** Two hosts, one protocol. Members joined and posted gasless through the relayer running as an OutLayer function, with no server, and through `quay relay serve`, the Node host. The relayer is its own account, `relay.harbour-board.testnet`, and its NEAR balance is the spend limit. The OutLayer host needs a payment key, which is public in the page, so anyone who reads it can spend it: the Board's key holds about $0.05 of test USDC at most $0.01 per call. Weak spot: OutLayer calls took 5 to 17 seconds, and stalled before the relay fix. Proven: [relayer account](https://explorer.testnet.near.org/transactions/CmoixGMs3HEDPgb6MUrETueHPn8ZmHEjhwhCimFfs8kR), [relay deployed](https://explorer.testnet.near.org/transactions/9rnqpKHJYq2JB9Yc9pDNFJH1xRUWbZKX8gcLwwuWwVwT). Check: `view list_members '{"from_index":0,"limit":50}'` and the posts by `maren.harbour-board.testnet`. Earlier spikes with plain accounts: [relayed delegate](https://explorer.testnet.near.org/transactions/HpNGtV3WQLtCNsmMU8gbidDhB1d7gB9wCpvPMs35cxkY), [session key delegate](https://explorer.testnet.near.org/transactions/BkN8S7Zx3xsvA9SppF9ghCLXnGdb86jYMtBuiudxUCie), [a delegate whose deposit the relayer paid, which is why the relayer refuses any deposit](https://explorer.testnet.near.org/transactions/4zVRVvNhL25VbXCkbAbjp6vvxNJxxtZVc5FzSD1Gvk8v).

**Functions (live).** Rust compiled to WASI, run on OutLayer, registered on the contract. `quay functions deploy|list|invoke|logs|rm|key`, `quay secrets set|list|rm`. The Board's `moderate` runs on every post with a secret and an outbound HTTPS call: the secret round-tripped through an authenticated echo API (`auth: "ok"`), it attaches a link preview, and it hid a spam post. `digest` ran by hand through `fn_call` and now runs every hour from cron. Proven: [moderate project](https://explorer.testnet.near.org/transactions/AyEpD8LfocJDMovR6LZDa8pcsHdNji86TiYpSCWARHBh), [secret stored](https://explorer.testnet.near.org/transactions/3cZfXHtLAbCVGmFJxkGLF75v56B4tAwvjWVqq24Zwkud), [digest run](https://explorer.testnet.near.org/transactions/9vX1o2oDv4cKdE1Qf95LGW6xQoJ6J5KXBYjqRND3RWAD). Weak spot: OutLayer is one operator, and a run takes 5 to 17 seconds. Check: `view fn_list '{}'` and `view db_list '{"collection":"_fn","query":{"limit":3}}'`.

**Large files (live on FastFS, NEARFS cut).** A file over `files.external_over` goes to FastFS, which stores it for gas only, and the release holds its https URL and sha256. The Board's 493,183 byte hero photo was uploaded to FastFS, first sealed as an external URL in [release 4](https://explorer.testnet.near.org/transactions/44t7hUBpfqKGR5FYgsMU7ak5FuAjv2jB6M1vvH1RpVm3) and is served through the gateway. A NEARFS upload is a call that fails by design so the indexer can read it; the probe [9xj3bLha](https://explorer.testnet.near.org/transactions/9xj3bLhaN7MFp7xwwteAhduq5GsXfqYT74LiXoB2fbV8) failed that way (`CodeDoesNotExist`), and the NEARFS gateway never served it, so NEARFS is not the default. Pinata and Filebase are implemented and were never run against the live services. Check: `curl -fsS https://harbour-board.ss251.workers.dev/assets/img/harbour.png | shasum -a 256` prints `16cca45160bd57f293b580dc754cf8313cdc41cbcb7d982c4696bbf5c9f38ccf`.

**Payments (live, test USDC only).** `quay products set|list|rm|token`, `quay receipts`. Two posts are pinned: post 5 was paid in NEAR and post 6 in test USDC, `usdc.fakes.testnet`, which anyone can mint. Circle USDC is not used. A pin lasts 24 hours, so the order on `/` changes when it ends. Proven: [product](https://explorer.testnet.near.org/transactions/BzpjbDMxaUdoYm8kiXiqG7sjbv3QHSEVVo5XthMkTkLj), [token](https://explorer.testnet.near.org/transactions/3Gt1S2QFj4zB2WxcPpiE5nTXfzwSuo5Y5Hxydb3sS5yK). Check: `view list_receipts '{"limit":10}'`.

**Cron (live, re-armed by hand).** `quay cron add "every 60m" digest`, `quay cron arm`, `quay cron status`. OutLayer has no scheduler, so the contract keeps a chain of yielded promises alive: a hop about every 2 minutes at about 2.25 Tgas, and 95 Tgas from the chain for each job run. One arm of 1 PGas lasts about 15 hours with no jobs and about 6 with the Board's hourly job; then a transaction must arm it again, and nobody does that for you. The Board was armed in [GJSg1cdT](https://explorer.testnet.near.org/transactions/GJSg1cdT9cpVw1Qugp6nProfWK5ynLViNfdQ3wKeweGG); every tick and job run is a receipt of that transaction. The first scheduled run failed because the contract gave OutLayer 45 Tgas; contract 3.0.1 ([deploy](https://explorer.testnet.near.org/transactions/G5EUhktorfvAATvr21R8sZ57Q88N5XVEuFyN5JoUtxpw)) gives 80, and the next run at 23:22 UTC wrote a digest the page labels "by the hourly digest job". Check: `view cron_status '{}'` (armed, hops, last tick) and `view cron_list '{}'` (last run). If the chain has stopped, `armed` is false and the page keeps the last digest with its time.

**`quay up` (live).** `quay up --dry-run`, then `quay up -m "harbour board"`. It applies `quay.json`, deploys the site with its routes and promotes it. The Board's functions, collection, product and releases were deployed with it. Versioned per release: files, routes and templates. Not versioned: docs, rules, products, members, function code and secrets, relay and cron settings.

## Limits

Testnet only. The CLI refuses any other network. A public page is only as available as the gateway serving it: `testnet.page` is one operator and failed on 2026-11-10, and the Workers hosts are one Cloudflare account. `quay gateway` serves any site from your machine. On `testnet.page` a new host has no certificate until the first request. `quay init` and the first `quay deploy` poll until the gateway answers, and say so. An extra host label, such as `www.<account>.testnet.page`, fails TLS. A full-access key can replace the wasm. Releases are not owner-proof against that key. The payload cap is 2,000,000 bytes. Details, including the chunk and file limits, are on the docs page.

`quay-bb.testnet` was not migrated. The old demo stays on v1 at https://quay-bb.testnet.page/.

## Built with NEAR's official tooling

The contract is near-sdk 5.30.1. The CLI uses near-api-js 7.4.0. Sandbox tests use near-sandbox 0.4.0 and near-api 0.8.7, which is what the current `near-smart-contracts` skill uses for a local node. The dashboard loads `@hot-labs/near-connect` 0.12.0 from esm.sh and does not put a key in the page. Skills installed in this worktree: `near-smart-contracts`, `near-contract-audit`, `near-cli-rs`, `near-dapp`, `near-api-js`, and `near-kit`. Contract questions were checked against NEAR Docs at `https://docs.near.org/mcp`. The product CLI does not shell out to `near`.

## Disclosure

This code was written with AI coding agents: xAI Grok 4.7, through the Grok Build client.
