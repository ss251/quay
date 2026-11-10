# Harbour Board live on testnet

Status on 2026-11-10: site, functions, collection, payments, members, routes, cron job and OutLayer relay are live. Seeding is partial (3 of 14 notices), pins and the arming of cron are not done. See "Not done".

- Site: https://harbour-board.ss251.workers.dev/ (Workers mirror, primary), https://harbour-board.testnet.page/ (public gateway) or `quay gateway --account harbour-board.testnet`
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

## Browser check (2026-11-11)

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
