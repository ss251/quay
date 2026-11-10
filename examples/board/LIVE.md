# Harbour Board live on testnet

Status on 2026-11-10 23:30 UTC: site, routes, data, members, sign-in, both relays, functions, payments, the large file and cron are live. The schedule was armed at 23:14 UTC and its first successful digest ran at 23:22 UTC (see "Cron armed"). One arm of 1 PGas lasts about 6 hours with the hourly job, then `quay cron arm` must be sent again. The sections below are in the order the work happened, so earlier ones describe states that later ones fixed.

- Site: https://harbour-board.ss251.workers.dev/ (Workers mirror, primary), https://harbour-board.testnet.page/ (public gateway) or `quay gateway --account harbour-board.testnet`
- Account: `harbour-board.testnet` (v3 contract, 3.0.1 since 2026-11-10), relayer `relay.harbour-board.testnet`, buyer `buyer.harbour-board.testnet`
- Members: maren, dunstan, priya, tobias, halvard and promo-bot were seeded; e2e-4eb351a1 came from the browser check of `/new/`; the two `tg-…` members were made by the separate Telegram sign-in work (its own `telegram-auth` OutLayer project), not by this branch. Nine on 2026-11-10, all `<name>.harbour-board.testnet`, created through the relays with no NEAR. Joining is open, so `list_members` may show more.

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

- Cron was not armed at this point (it needed about 1.1 NEAR liquid; the site had about 0.23). Done later, see "Cron armed".

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

## Browser check (2026-11-10)

A new isolated headless Chrome (`chrome-devtools-axi`, its own profile, closed afterwards) drove the live page https://harbour-board.testnet.page/new/. Testnet only, no wallet, no NEAR on the member side.

### Member flow: passed

| Step | Result |
| --- | --- |
| Join as `e2e-4eb351a1` (page -> OutLayer relay `POST /call/harbour-board.testnet/relay`) | Account `e2e-4eb351a1.harbour-board.testnet` created, balance 0. The relay call took 9.1 s and the page said "Signed in ... with a member key" about 10 s after the click. Tx https://explorer.testnet.near.org/transactions/BVSDQt281ZxdMrTTRbtwuuvB4onhos75wCFhq7n8RK7H (`relay.harbour-board.testnet` -> `join`, event `member_joined`). |
| Post "[TEST] Live page check, will be removed" (signed delegate through the relay) | Relay call 6.0 s. Tx https://explorer.testnet.near.org/transactions/99NtZvYBfG1B3FFT3faaxmLjxUtUvFxD33smjYAYTKfX (`Delegate` on the member account, events `doc_added` for `posts/v12j7o3omj` and `fn_called` `moderate`). |
| Moderation trigger | The page showed "Published and checked. Open your notice" 17.2 s after submit (it polls every 2 s). `fn` came back `auth: "ok"`, `hide: false`, preview title "Example Domain" for the https link. |
| `/posts/v12j7o3omj` (server-rendered) | Title, body, member, topic and the link preview rendered. `/api/posts/v12j7o3omj` returned the same doc. |
| Removal as site owner, `quay db rm posts v12j7o3omj --yes` | https://explorer.testnet.near.org/transactions/EQySECJ2QJAVgvNSGaZwH3LYyqHeMDhY7MmQ1BzVYFJf ; the post URL then answered 404. The member account stays. |

### Wallet NEP-413 sign-in with near-connect: not completed (two attempts, both blocked outside the board)

The "Sign in with a wallet" button opened the real near-connect picker on testnet (Meteor Wallet, Intear Wallet, Ledger, Nightly Wallet, NEAR CLI, NEAR Connector; `docs/screenshots/board-new-wallet-picker-desktop.png`). A throwaway zero-balance account `walletchk-he8kli.harbour-board.testnet` was made from the site account for this (tx https://explorer.testnet.near.org/transactions/9mDqWA6RByk556f3ZrtCRUxbX3WvxDL4tUf3Kxq8YNx7 ). It is left in place, because a zero-balance account cannot pay to delete itself. Its key is mode 600 in `~/.near-credentials/testnet/` and was only typed into the wallet's import box.

1. Intear Wallet: "Web" opened the wallet popup (`wallet.intear.tech/connect`, `board-wallet-intear-connect.png`). "I already have a NEAR wallet" -> "Private Key" with the throwaway key -> "No accounts found for this private key" and Import stayed disabled. The wallet looks keys up at `api-testnet.intea.rs/public_key/<pk>` and `test.api.fastnear.com`. FastNEAR returned the account at once. `api-testnet.intea.rs` returned `account_ids: []` for this key, still empty after about 10 minutes, and also for older testnet accounts here (`quay-i7qkbbp3.testnet` and others), which means Intear's testnet key index is currently empty and is not specific to a new account. The earlier session's Intear sign-in (README "Dashboard signing") therefore does not repeat today. The popup's "Create New Account" offers only a `.near` (mainnet) name, so it was not used.
2. Meteor Wallet: "Meteor Web" opened `wallet.meteorwallet.app/connect/testnet/login` and Cloudflare answered "Sorry, you have been blocked" (`board-wallet-meteor-blocked.png`, Ray ID a587eb5c9c3dba32) to the headless browser. Not worked around.

So no NEP-413 proof was produced and `verifySignIn` was not run on a wallet proof. The test wallet stub was not used for this claim. The wallet half stays open until an Intear testnet index or a headed wallet is available.

### Bug found (not patched, live page unchanged)

`site/assets/board.js`, post page, the test USDC pin button handler:

```js
tokenButton?.addEventListener("click", () =>
  pin(event.target, { token: true }, "test USDC (usdc.fakes.testnet, not Circle USDC)"),
);
```

`pin(options, label)` takes two arguments, and this passes three, the first being the global `event.target`. `options` becomes a DOM node, so `{ token: true }` never reaches `quay.pay` and `label` becomes the object ("Approve the [object Object] payment"). Found by reading the code, not by a live click (that needs a funded wallet). Fix:

```js
tokenButton?.addEventListener("click", () =>
  pin({ token: true }, "test USDC (usdc.fakes.testnet, not Circle USDC)"),
);
```

Also seen: near-connect stores `selected-wallet` in localStorage, so after one wallet attempt the button reopens that wallet and skips the picker until site data is cleared.

### Screenshots (real data, `docs/screenshots/`)

`board-home-desktop.png`, `board-home-phone.png`, `board-post-desktop.png`, `board-post-phone.png` (the test post with its preview), `board-new-1-join-desktop.png`, `board-new-2-done-desktop.png`, `board-new-2-done-phone.png`, `board-new-wallet-picker-desktop.png`, `board-wallet-intear-connect.png`, `board-wallet-meteor-blocked.png`. Phone shots use a 360 px emulated viewport (headless Chrome's window will not go below 500 px). No horizontal overflow at 360 px on `/`, `/posts/<id>` or `/new/`.

### Wallet NEP-413 sign-in through the "NEAR CLI" connector: passed (third attempt)

The near-connect manifest (`hot-dao/near-selector` `repository/manifest.json`) lists `near-cli`, a sandboxed executor (`near/near-cli-connect` `dist/near-cli.js`, read as data) that needs no socket. It asks for an account ID, a signing method, and then shows a `near message sign-nep413 ... sign-with-keychain network-config testnet` command and a box for the JSON output. Run in a new isolated headless Chrome on the live `/new/` page (cleared profile, so the picker showed):

1. "Sign in with a wallet" -> NEAR CLI -> account `walletchk-he8kli.harbour-board.testnet` -> Keychain -> Continue. The page showed the command with `utf8 'Sign in to harbour-board.testnet\nSite: harbour-board.testnet\nIssued: 2026-11-10T20:52:36.144Z'`, `nonce 'Y/N82jNJ...'`, `recipient 'harbour-board.testnet'`.
2. I ran that command with `near` 0.31.1 (near-cli-rs), changing only `sign-with-keychain` to `sign-with-legacy-keychain` (the key is in `~/.near-credentials`). It printed `{accountId, publicKey, signature}`; I pasted the JSON into the box and pressed Submit. No key was printed or shown.
3. The board then said "Signed in as walletchk-he8kli.harbour-board.testnet with a wallet." (`board-new-wallet-signed-in-desktop.png`; the sign step is `board-wallet-nearcli-sign-desktop.png`).
4. The proof the page holds lives inside the client closure, so I rebuilt it from what crossed the page: the executor's `signMessage` postMessage result (accountId, publicKey, base64 signature), and the message, nonce and recipient from the command. `verifySignIn(proof, { site: "harbour-board.testnet" })` in Node (`client/src/verify.mjs`, 36 s after issue):
   `{"ok":true,"accountId":"walletchk-he8kli.harbour-board.testnet","publicKey":"ed25519:82z8mfwm...","issuedAt":1794343956144}`.
   The same proof with one byte appended to the message gave `bad signature`, and a different `site` gave `wrong recipient`.

Limits of this claim: the signing ran in my terminal (the NEAR CLI connector is a copy-and-paste flow, so that is how it works), and the proof was reassembled from the wallet response, not read out of the page's closure. The board's page logic accepted it and switched to wallet mode. Posting with the wallet was not tried.

## After the second security review (2026-11-10)

| Step | Link |
| --- | --- |
| release 5: fix the test-USDC pin button (arguments were in the wrong order) | https://explorer.testnet.near.org/transactions/5Ft57j3MBfmup7M2sfNuxgJ1boqoJdJN6KxbRiqGoHBL |
| production 5 | https://explorer.testnet.near.org/transactions/BuSshpmhzccho2agS96H54EFEJvUwbdyW6s4WKhD7QRY |
| relay function redeployed with the review fixes (sender key and nonce checked before spending, atomic budgets, one-label members): project / secrets | https://explorer.testnet.near.org/transactions/8KHUMSKvMJ7Yb5wD3x13zTT5zsUgYkKNjpGcBBjdTc2P / https://explorer.testnet.near.org/transactions/Dv4umJt17VSUrmRto2p9orJevnCqGtmAViaKRMb2owFw |
| check: throwaway collection `relaycheck` created; maren added a doc through the OutLayer relay (20 s) and removed it (14 s); collection dropped | https://explorer.testnet.near.org/transactions/5RhXKgZQRgC7FWGxTpoxoPqHaX9vLLpBHSTok6ksJS8G / https://explorer.testnet.near.org/transactions/7hM4N4FPhLKK3gr2QfGLtEmr9Fkr7uUjLcEtYfYpfeMC |

## FastData KV (gas-only public data, 2026-11-10)

`quay.db.collection("guestbook", { backend: "fastdata" })` writes `__fastdata_kv` on the site account; the FastNEAR indexer records it under the caller. See docs/fullstack-interface.md section 1b for the trust notes (no rules, `owner` is the only identity, reads depend on FastNEAR).

| Step | Link |
| --- | --- |
| direct write from `harbour-board.testnet` to receiver `harbour-board.testnet`, 5 Tgas: the receipt failed with `MethodNotFound` and the indexer recorded it | https://explorer.testnet.near.org/transactions/CqQpsM53zyHaxA9hNs7JNWp84TPnduvg2YQTJ15JVJ48 |
| the same with 1 gas: the receipt failed with `Exceeded the prepaid gas`, and the indexer recorded it too | https://explorer.testnet.near.org/transactions/6m3f8qo4giHmGVhPwBzN7DwUdz3HVwRxHzPRcVScYtew |
| member `maren.harbour-board.testnet` (zero NEAR) wrote guestbook entry `zd3ot1u1o233l2w`, a delegate paid by `relay.harbour-board.testnet` through the **Node relay** | https://explorer.testnet.near.org/transactions/9jBJbchzA5kqwuZvJygdoSVNTokS7vjdZ5xRiiUKayE |

- Which relay: the board's **OutLayer relay refused it** (`relay_refused: method __fastdata_kv is not relayed`): its method allowlist is fixed in its config. The write went through `quay relay serve --account harbour-board.testnet --fastdata --port 8788` (loopback, relayer key from `~/.near-credentials`), which was stopped afterwards. Adding `__fastdata_kv` to the OutLayer relay needs a redeploy with that method in its list.
- Read back through the client: `col.get("zd3ot1u1o233l2w", { owner: "maren.harbour-board.testnet" })` and `col.list({ limit: 5 })` returned the entry with `owner` = `maren.harbour-board.testnet`, block height 277121561. The raw read is `GET https://kv.test.fastnear.com/v0/latest/harbour-board.testnet/maren.harbour-board.testnet/quay/guestbook/zd3ot1u1o233l2w`.
- Two probe keys, `quay/probe/1794345088610` and `quay/probe5t/1794345108481`, were written by the owner during the check; they are harmless leftovers under `quay/probe*`.
- Cost: the relayer's 0.3564 NEAR balance before, one 5 Tgas relay after (gas only).

## Cron armed (2026-11-10)

The faucet reopened at 23:12 UTC. A new faucet account, `qfund-1ktajy8t.testnet`, funded the site, the relayer and the product site.

| Step | Link |
| --- | --- |
| 4 NEAR to the site | https://explorer.testnet.near.org/transactions/8pRU5Joa3AtwQHtPZuEKgoFbHvAeahTH9jgvDJNo1Z2M |
| 1.5 NEAR to the relayer | https://explorer.testnet.near.org/transactions/7FM7xHaJQrMjSjq2ddrhyhCaYu542CkbdnCdHox6Ud5K |
| `quay up`: digest function with the `scheduled` flag (upload / project / fn_set) | https://explorer.testnet.near.org/transactions/65pidNrv6Eb9NvkdH2nRG9nQnpA8SH5sPtA1n7VNLPmg / https://explorer.testnet.near.org/transactions/9NzBWwZhJe1GjLanjkHyoh5Vx84EzYCg3CSTfx6agcHS / https://explorer.testnet.near.org/transactions/3kVtxhBNufKnrnSDanmpYqvVrmuVSg6Dymvu5ffsCX5P |
| release 6 (client bundle with extras, `quay-site.json`) / production 6 / cron_set with input `{"run":"schedule"}` | https://explorer.testnet.near.org/transactions/AGAxoZcfQqtwTFMQga1o9SKWqYuinqq64NX6PJFqm3WT / https://explorer.testnet.near.org/transactions/BfGJVhmvkUGuVQE1dpLqbWPJMZTSi8GvgTnrh2YbxSZP / https://explorer.testnet.near.org/transactions/642PuD8Tz6gjQUKZpQTNNfbfiwiAFTctXffVykovmsS8 |
| `quay cron arm` (1 PGas). Every tick and job run of this chain is a receipt of this transaction | https://explorer.testnet.near.org/transactions/GJSg1cdT9cpVw1Qugp6nProfWK5ynLViNfdQ3wKeweGG |

**First scheduled run failed (bug, fixed).** The first tick (23:16 UTC) ran the job, but the contract gave OutLayer's `request_execution` only 45 Tgas and it failed with `Exceeded the prepaid gas`; `fn_on_result` stored `digest-27` as `ok: false, error: "request failed"` and returned the deposit to the pool. The home page then showed that failed run under "Written … by the digest function, run by hand", with no digest text. That was wrong twice over: it was a scheduled run, and it was not a digest.

Measured from `qfund-1ktajy8t.testnet` calling `outlayer.testnet` directly: 50 Tgas fails, 60 Tgas runs ([ETgNLQTm](https://explorer.testnet.near.org/transactions/ETgNLQTm8BAaJgVi17uea1qnd6iJe8E7vzYFwyW9sp4K)). OutLayer keeps about 50 Tgas for its own callback.

| Fix | Link |
| --- | --- |
| contract 3.0.1: a cron job gives OutLayer 80 Tgas (state kept, the armed chain carried on) | https://explorer.testnet.near.org/transactions/G5EUhktorfvAATvr21R8sZ57Q88N5XVEuFyN5JoUtxpw |
| job removed and set again so it was due at the next tick (its `last_run` reset) | https://explorer.testnet.near.org/transactions/8TvobsiY7XDxBtcmP8vezVMfaq4T577eGGMguyHqy1VM / https://explorer.testnet.near.org/transactions/8pmQ3ZLit7entxTpVVoPye1kXUSaMhngfqy4wvz2RRE6 |
| release 7: a failed run shows as "The last digest run … failed: …", never as a digest / production 7 | https://explorer.testnet.near.org/transactions/DrGVTiLyDNC1Mer9nkks55NCcuf9XvfLwsWL2pUZXSVz / https://explorer.testnet.near.org/transactions/G82qz1qKMiTaeMwAiEgefutWtvCFCMs73B9JLx9Ybmfx |

**Scheduled run proven.** At 23:22 UTC the fourth tick ran `digest` with 80 Tgas; OutLayer's callback got 75 Tgas and returned the digest, and `fn_on_result` stored `_fn/digest-28` with `ok: true` and `output.scheduled: true`. The home page reads "Written 2026-11-10 23:22 UTC by the hourly digest job." All of it is in the receipts of the arm transaction above. Check without a key: `view cron_status '{}'` (armed, hops, last tick) and `view db_list '{"collection":"_fn","query":{"limit":1,"order":"desc"}}'`.

**How long it lasts.** The chain started with 997 Tgas. A hop takes about 2.25 Tgas every 2 minutes, and each job run takes 95 Tgas from the chain (80 for OutLayer, 15 for the result) whether it uses it or not. With one hourly job that is about 6 hours per arm, so the schedule needs `quay cron arm` again after that. Each arm reserves about 1 NEAR while it runs and refunds the unused gas.
