# Harbour Board live on testnet

Status on 2026-11-10: site, functions, collection, payments, members, routes, cron job and OutLayer relay are live. Seeding is partial (3 of 14 notices), pins and the arming of cron are not done. See "Not done".

- Site: https://harbour-board.testnet.page/ (public gateway) or `quay gateway --account harbour-board.testnet`
- Account: `harbour-board.testnet` (v3 contract 3.0.0), relayer `relay.harbour-board.testnet`, buyer `buyer.harbour-board.testnet`
- Members that exist: maren, dunstan, priya, tobias, halvard, promo-bot (all `<name>.harbour-board.testnet`, created through the OutLayer relay, no NEAR)

## Transactions

| Step | Link |
| --- | --- |
| `quay init` (adopt account, deploy wasm) | https://explorer.testnet.near.org/transactions/9He5iL5Ne5b5XBhWDAj34PmW3hg26tYYuGx6xoNuGBaz |
| moderate: FastFS upload / project / fn_set | https://explorer.testnet.near.org/transactions/71Gew9MrNqtgZMLqqpgj8TtZ2jXDUUAWJae3Hr5BME5K / https://explorer.testnet.near.org/transactions/AyEpD8LfocJDMovR6LZDa8pcsHdNji86TiYpSCWARHBh / https://explorer.testnet.near.org/transactions/7kf4cmMSnovQoJBjSQX1GL84aNZXekR6j2BcmLu71zzv |
| MOD_API_KEY secret (throwaway, never printed) | https://explorer.testnet.near.org/transactions/3cZfXHtLAbCVGmFJxkGLF75v56B4tAwvjWVqq24Zwkud |
| `quay db fund 0.8` | https://explorer.testnet.near.org/transactions/DPnpKqji4wcLbgeHD9PukEu3trVKPZyE2HYn56hqAmqp |
| `quay relay create --near 0.25` | https://explorer.testnet.near.org/transactions/CmoixGMs3HEDPgb6MUrETueHPn8ZmHEjhwhCimFfs8kR |
| `quay relay deploy`: upload / project / secrets | https://explorer.testnet.near.org/transactions/B3Hx7bFamonJNR24PNFqzWE25jTqixe3v5778M7SSLW3 / https://explorer.testnet.near.org/transactions/9PeBuKMKu1YdPE71UN4rr4QHjH6yTBEPEF2Am9Wmjjoo / (secrets tx not recorded) |
| payment key 1 and top-up (top-up timed out at OutLayer and was refunded: key stayed at 0) | https://explorer.testnet.near.org/transactions/8skADbkCzzYi5um9ttiQprjT6P4XQbqJedWwE2PyNezX / https://explorer.testnet.near.org/transactions/CPWLoXgi1a8tphSJDEpisXVibnKK5w8NZfuGBrEXr5o2 |
| payment key 2 and top-up ($0.05 test USDC, used by the board) | https://explorer.testnet.near.org/transactions/HNzmmL44SyQNSRpw8hwUD5RBzL4C4UTd2DgHYZi4DAre / https://explorer.testnet.near.org/transactions/7HuV9gf46xGpCJu9CU6SeiLU3dpVisjeYdQsy3XY329y |
| `quay up`: digest upload / project / fn_set | https://explorer.testnet.near.org/transactions/H7NW8wshxtsnEEgVUoNAkzsi7RAGM7SwGJWLWwxQDWhx / https://explorer.testnet.near.org/transactions/5K3BHPxSgF1A6PTxD9MZQAJSP3cNzrcaqQQzDojsMpME / https://explorer.testnet.near.org/transactions/6tH7FkfZUhorMS6CY55QZvVsCJoPsfmkcH5kPRhfsJaE |
| collection `posts` | https://explorer.testnet.near.org/transactions/AEg7rzCvAYnvr3R9gUdukQDZ2jsZSMkiRwFTS6r2dyp9 |
| token usdc.fakes.testnet | https://explorer.testnet.near.org/transactions/3Gt1S2QFj4zB2WxcPpiE5nTXfzwSuo5Y5Hxydb3sS5yK |
| product `pin` | https://explorer.testnet.near.org/transactions/BzpjbDMxaUdoYm8kiXiqG7sjbv3QHSEVVo5XthMkTkLj |
| release 1 sealed | https://explorer.testnet.near.org/transactions/6jF9sBjJwRYupHSjmTMEYB9yBxt5bjaS8xCKrgRsX7oU |
| production 1 | https://explorer.testnet.near.org/transactions/8pFfe6DQazJZZcfH8yYQhxk5nY2gVSyG5AqngDxwvUk6 |
| cron_set `digest` (60 min, not armed) | https://explorer.testnet.near.org/transactions/27D5zLACRqV5PKMEwroVqc2JwKYoAp7bq2ZN9GfnRPao |
| replaced the code with the audited 295,153-byte wasm (state kept; 3 posts still read) | https://explorer.testnet.near.org/transactions/Ga4ufTfXqZNQGmud9tEcXnZQBZm2qv59SjXozJUsxkd7 |
| release 2 (key 2 in config.json, home copy) / production 2 | https://explorer.testnet.near.org/transactions/5EouQrNVgTKChY9hmJkLuAsuB3VZmeFKXcChMmXq93G2 / https://explorer.testnet.near.org/transactions/2JpjgNNyEPa4m34eWxsrrb27x4sYb8FjH64LVfUxosdr |
| buyer account (0.18 NEAR) | https://explorer.testnet.near.org/transactions/5JL8HAeKEnsbTVJnfR4Y2iJQ42wG6VrRFXVLriytUnau |
| removed a duplicate seed post (posts/2) | https://explorer.testnet.near.org/transactions/H7Nt6iku8gmJLJtunL1e77rR7CLUYUQmjDNHv7YGEMyS |
| `quay functions invoke digest` (call id in attestation) | https://explorer.testnet.near.org/transactions/9vX1o2oDv4cKdE1Qf95LGW6xQoJ6J5KXBYjqRND3RWAD , https://testnet-api.outlayer.ai/attestations/by-tx/9vX1o2oDv4cKdE1Qf95LGW6xQoJ6J5KXBYjqRND3RWAD |

The 0.2 NEAR top-up of the relayer (it needs about 0.3 NEAR free to send a 300 Tgas relay) was a near-cli transfer from the site account.

## Facts worth knowing

- The relay payment key in `site/assets/config.json` is public by design: key 2, scoped to the `relay` project, about $0.05 of test USDC at most $0.01 per call. Anyone who reads the page can spend it. Release 2 carries key 2, so the live `/new/` page can join and post.
- The hero is an SVG on chain. The 493 KB PNG went to NEARFS (two upload batches), but NEARFS did not serve it (`ipfs.web4.testnet.page` answered 404 and `quay up` waited without end on the read-back), so release 1 has no external file. The PNG is kept in `art/harbour.png`.
- On chain: 19 files, 62.7 KB, locks about 0.64 NEAR.
- The moderation function ran with `auth: "ok"` (the throwaway MOD_API_KEY round-tripped through the echo API; only a sha256 prefix is stored) and attached a link preview to the Met Office post.
- OutLayer relay and trigger calls stalled intermittently: a client call to the relay can hang for a long time, and its $0.01 reservation stays on the key.

## Content and how it got there

- Posts 1, 3 and 4 (Tide notes, Lost oar, Fish market) came through the **OutLayer relay** (payment key 2).
- Posts 5 to 15 (Dredging, Volunteers, Ferry, Jumble sale, the spam post, Slipway, Ice machine, Thank you, Junior sailing, Lamp, Bike racks) came through the **Node relay** (`quay relay serve --account harbour-board.testnet`, then `node seed.mjs --relay http://127.0.0.1:8788 --wait`). It was stopped afterwards. Members joined through the OutLayer relay.
- Post 9 (the spam notice) was hidden by `moderate` (`hide: true`, blocked words). It is absent from `/`, `/api/posts` and 404 at `/posts/9`.
- Posts 5 (Dredging) paid in NEAR and 6 (Volunteers) paid in test USDC are pinned. `node pin.mjs posts/5` and `node pin.mjs posts/6 --token` ran as `buyer.harbour-board.testnet` with its explicit key. Both appear first on `/`. Token setup: `storage_deposit` for the buyer and the site, and an open `mint` of 0.2 test USDC to the buyer (txs 3raYtJDb..., EvqiAp5L..., 3oBAvyxB... on testnet).
- Duplicates caused by client timeouts (posts 2, 16, 17) were removed by the site owner with `quay db rm`.
- Post 3 has no `fn` result: its moderation run never came back, so it shows no preview and no moderation verdict. It is visible.
- Checked on the public host and on `quay gateway --account harbour-board.testnet` (local, stopped): `/` shows 10 posts with the two pins first and the digest, `/posts/5` shows "Pinned until", `/api/posts` lists 13 visible posts.

## Balances after (NEAR, account balance; storage is locked from it)

site 4.181 (about 0.23 liquid), relayer 0.376, buyer 0.157, pool 0.514 free and 0.196 reserved.

## Not done

- Cron is not armed (needs about 1.1 NEAR liquid; the site has about 0.23).

## Later fixes (2026-11-10)

| Step | Link |
| --- | --- |
| removed a relay test post (`posts/relaycheck-a1`) written during relay diagnosis | https://explorer.testnet.near.org/transactions/J4KvLHDEzbrfGWNwQoSHojg1XpvHgwAG1ynkbQVhwBxN |
| 0.6 NEAR moved to the site for gas headroom (from a throwaway account) | https://explorer.testnet.near.org/transactions/GPZqz41xt69zqdP5U99G5cMpbHPdCJR9vrJtvm69xTcu |
| release 3: the digest line says it ran by hand until the schedule is armed | https://explorer.testnet.near.org/transactions/9fijEJAWMPHGbSQxuqpjwoBe9jjUMqaECVUXRGqCsyTT |
| production 3 | https://explorer.testnet.near.org/transactions/6ghSuc2NFGqWjPtXfXk7DDydavZTZtvifPf2rrRuKQ4T |
| replaced the code with the wasm that accepts `https` URL externals (295,899 bytes; state kept, production stayed 3) | https://explorer.testnet.near.org/transactions/D69FwTdwk1PXeEdVV56uz2ni7kVfBndzXgp3Ci8NsGyS |
| hero photo (493,183 bytes) uploaded to FastFS, gas only; served about 5 minutes later with a matching sha256 | https://test.fastfs.io/harbour-board.testnet/outlayer.testnet/16cca45160bd57f293b580dc754cf8313cdc41cbcb7d982c4696bbf5c9f38ccf.png |
| release 4: hero sealed as an external `url` file, client with the relay fix | https://explorer.testnet.near.org/transactions/44t7hUBpfqKGR5FYgsMU7ak5FuAjv2jB6M1vvH1RpVm3 |
| production 4 | https://explorer.testnet.near.org/transactions/9kjjYt6NYbrs6xPnsxQZbmx4BtAjzPgbMNwYgqjeR3pv |
| mistake: `quay functions rm relay` (meant to drop a stray contract entry) also deleted the relay's OutLayer secrets and project | https://explorer.testnet.near.org/transactions/4RRb9RbC9wN6krLyLaDRa2P5rDvtSCCRZkSD8Y6EGzXk / https://explorer.testnet.near.org/transactions/3d3XPTPrxYqSZuGRg9aSq8NjDcQW9U5Nf2L16QyDKoZL |
| fixed minutes later: `quay relay deploy` re-created the project and re-stored RELAY_KEY; health answered with the existing payment key | https://explorer.testnet.near.org/transactions/9rnqpKHJYq2JB9Yc9pDNFJH1xRUWbZKX8gcLwwuWwVwT / https://explorer.testnet.near.org/transactions/AJe1CeRKu6s1ZSQgw7iaEhm3RKh7xhwyJbCrgZUorVYh |
