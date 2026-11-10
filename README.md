# Quay

Quay is the managed place to host a NEAR app. A publish writes an immutable release, production is a pointer you can move or roll back in one call, and a CI key can publish but is rejected when it calls promote. This is the first NEAR deploy flow with immutable versioned releases, a production pointer, and a deploy-scoped CI key.

## The problem

A NEAR account can hold a contract and serve bytes, but it has one code blob and one state. Replacing the site replaces the public URL. There is no sealed history of what was published, and there is no key that can publish a release without also being able to move production.

## What it uses on NEAR

Testnet only. Account `quay-bb.testnet`.

- A Rust contract (`near-sdk` 5.30.1) with `put_chunk`, `seal`, `promote`, `web4_get`, `get_production`, `get_release`, `get_budget`, `has_chunk`, and `buy`.
- Chunks keyed by sha256, 200,000 bytes maximum. Sealing the same bytes again does not store them twice.
- `promote` attaches exactly 1 yoctoNEAR. A function-call key cannot attach NEAR, so it cannot promote even if its method list were wrong.
- The publish key may call only `put_chunk` and `seal`. Its public key is `ed25519:5ibCru26UTkfcfhxQe4EKk4b5Mhpwh78zjKNGaEXzgxT`. Added in [7vNr7FXmUMpbSuX2YATgYw3MrFSErrnfGqSqdFDwtxm6](https://explorer.testnet.near.org/transactions/7vNr7FXmUMpbSuX2YATgYw3MrFSErrnfGqSqdFDwtxm6).
- `web4_get` answers the public gateway. Production is `/` and `/index.html`. A release is `/r/<id>`, `/r/<id>/`, and `/r/<id>/index.html`.
- NEP-297 events `release_sealed`, `promoted`, and `purchased` (`standard` `quay`, `version` `1.0.0`).
- `buy` takes testnet NEAR into the site account and records the buyer. It does not move the production pointer.

The contract wasm was deployed and initialized with `new` in [3PJ5vXuwsrMebY9bgSxuSVUnc5hYFqohHxMqiygESiUu](https://explorer.testnet.near.org/transactions/3PJ5vXuwsrMebY9bgSxuSVUnc5hYFqohHxMqiygESiUu). The wasm file is 177,295 bytes. Account storage rose by 177,368 bytes, which locks 1.77368 NEAR at the protocol rate of 0.01 NEAR per 1,000 bytes.

A full-access key can still deploy different wasm over this contract. Releases are immutable for the publish key. They are not owner-proof.

## Network

| | |
| --- | --- |
| Network | testnet |
| Account | `quay-bb.testnet` |
| Gateway | https://quay-bb.testnet.page |
| Production | https://quay-bb.testnet.page/ |
| Release 1 | https://quay-bb.testnet.page/r/1 |
| Release 2 | https://quay-bb.testnet.page/r/2 |

`near view` uses near-cli-rs `network-config testnet`. Quay's chunk lookup uses `QUAY_RPC`. The default in `quay.json` is `https://rpc.testnet.fastnear.com`. `https://rpc.testnet.near.org` still answers and is severely rate-limited.

A host with an extra label, such as `https://r1.quay-bb.testnet.page/`, fails the TLS handshake. The certificate covers one label. Releases are paths.

## Judge steps

Needs `cargo`, `curl`, `shasum`, and `near` (near-cli-rs) on `PATH`. No secret, no key, and no wallet.

You can run the same checks with `sh scripts/judge.sh`.

1. Run the contract tests.

   ```sh
   cargo test --manifest-path contract/Cargo.toml -- --test-threads=8
   ```

   See `sealed_release_bytes_stick` and `publish_key_cannot_promote` pass.

2. Open production.

   ```sh
   curl -fsS https://quay-bb.testnet.page/
   ```

   See `production: release`. The response `cache-control` is `public, max-age=0, must-revalidate`.

3. Open release 1 and hash the body.

   ```sh
   curl -fsS https://quay-bb.testnet.page/r/1
   curl -fsS https://quay-bb.testnet.page/r/1 | shasum -a 256
   ```

   See `release 1`. See `041da882874158377a29812cbb3da2a77e689ec650af7a20313021ef13b6f297`, the same digest as `releases/1.sha256`. That response is cached `public, max-age=31536000, immutable`.

4. Read the production pointer.

   ```sh
   near view quay-bb.testnet get_production '{}' --network-id testnet
   ```

   See `"2"`. The page in step 2 says `production: release 2`.

5. Open the rejected promote.

   https://explorer.testnet.near.org/transactions/9HNfzPWK5GMzfQQ7J5U9fTJGv4wtmieqkZMGE3sQ5esG

   See a delegate action signed by `ed25519:5ibCru26UTkfcfhxQe4EKk4b5Mhpwh78zjKNGaEXzgxT` calling `promote` with `{"id":"1"}`. The receipt fails with `DelegateActionAccessKeyError` and `MethodNameMismatch` for method `promote`.

   A direct transaction from that key is dropped before it is included. `broadcast_tx_commit` returns `INVALID_TRANSACTION` / `MethodNameMismatch` and no explorer page. The transaction above is a relay of the same signed promote, which is why it has a page. The unit test is the second lock: `promote` panics unless the attached deposit is exactly 1 yoctoNEAR.

## What is live

Production was moved to release 2 in [5zZvwp45vB3Rq4BLFTpqxQyvWrhAwS8qv8UFtrDcZmPJ](https://explorer.testnet.near.org/transactions/5zZvwp45vB3Rq4BLFTpqxQyvWrhAwS8qv8UFtrDcZmPJ). Release 1 is still at `/r/1`.

`agent.quay-bb.testnet` called `buy` with 0.1 testnet NEAR in [CmH5fw2nXM8p3BQ1FwLzRbeMG1HRuKocFQMQ4P7qTDgD](https://explorer.testnet.near.org/transactions/CmH5fw2nXM8p3BQ1FwLzRbeMG1HRuKocFQMQ4P7qTDgD). The site balance moved from 8.990273 NEAR to 9.090273 NEAR. The event records buyer `agent.quay-bb.testnet` and `100000000000000000000000` yoctoNEAR.

```sh
near view quay-bb.testnet get_sales '{}' --network-id testnet
```

Release 1 is 1,762 bytes and raised account storage by 2,175 bytes. After releases 1, 2, and 3, `get_budget` reported `stored_bytes` 6461, the sum of those three payloads (1762 + 3758 + 941). Sealing the same 941 bytes again as release 4 left `stored_bytes` at 6461. `/r/3` and `/r/4` are the same bytes. Their digest is `releases/3.sha256`.

The page script reads `get_production` from `https://rpc.testnet.near.org`. The visible line is already `production: release 2`, so a rate limit on that endpoint does not change step 2.

## Owner commands

These need a key in the local credentials folder. They are not judge steps. The publish key file is `~/.near-credentials/testnet/quay-bb.testnet.publish.json`. Nothing in this repo is a key.

Environment names, all optional: `QUAY_ACCOUNT`, `QUAY_NETWORK`, `QUAY_RPC`, `QUAY_PUBLISH_KEY_FILE`, `NEAR_BIN`.

```sh
node cli/quay.mjs publish site/index.html
node cli/quay.mjs promote 2
```

`publish` takes a file or a directory. A file is stored as `index.html`. `promote` always uses the full-access key and attaches 1 yoctoNEAR. `--full-access` publishes with that key instead of the publish key.

`scripts/agent.mjs` is the agent path. `agent.quay-bb.testnet` sent 0.05 NEAR to the site in [5erHLtXCYfhoHerE5RBMVaX8p96qcbij2FUAJVY1rvdp](https://explorer.testnet.near.org/transactions/5erHLtXCYfhoHerE5RBMVaX8p96qcbij2FUAJVY1rvdp), then the publish key sealed https://quay-bb.testnet.page/r/3. The same key's direct `promote` was rejected before broadcast.

## Disclosure

This code was written with AI coding agents: xAI Grok 4.7, through the Grok Build client.
