# Harbour Board

A community notice board for a small working harbour, hosted on one NEAR testnet account with Quay. Visitors read it without JavaScript. Members post without owning NEAR. It uses every Quay layer, and each one is visible on the page.

| Layer | Where it shows up |
| --- | --- |
| Sealed release | `site/` is the release: files, templates and routes are versioned together, and `quay rollback` restores all three. |
| Document db | Each notice is a doc in the `posts` collection (`write: anyone`, `payer: site`, moderated, 2000 bytes, 50 per member). |
| Routes | `/` lists posts (pinned first, newest first, `?from=` paging, `?owner=`). `/posts/:id` renders one. `/api/posts` and `/api/posts/:id` are JSON. The contract fills `site/templates/*.html` in `web4_get`. |
| Members | `/new/` creates `<name>.<site>` through the relayer with no NEAR. `/members/` lists them from `list_members`. |
| Functions | `moderate` runs on every add (`on_add`) and writes `fn.preview` (link title, description, image) and an optional `hide`. The post page shows that preview. |
| Cron | `digest` runs every 60 minutes. The home page shows the latest result of the `_fn` collection under "Harbour digest". |
| Payments | A wallet can pay 0.1 NEAR on a post page to pin it for 24 hours. `/receipts/` lists the receipts. The product also has a test USDC price. |
| Large files | `site/assets/img/harbour.png` (about 480 KB) is over `files.external_over`, so `quay up` stores it off chain and the contract serves `ipfs://<cid>` with a sha256 you can check. |

## Files

- `quay.json`: the whole project, applied by `quay up`.
- `site/`: `index.html` (static shell, replaced by the `/` route when routes are live), `404.html`, `templates/` (`home`, `post`), `partials/`, `new/`, `members/`, `receipts/`, `assets/` (`board.css`, `board.js`, `quay.js` from `client/dist`, `config.json`, images).
- `art/harbour.svg`: source of the hero picture, drawn for this example. Render with `rsvg-convert -w 1000 -h 400 art/harbour.svg -o site/assets/img/harbour.png`.
- `seed/posts.json` and `seed.mjs`: 13 notices by 6 harbour members, posted through `@quay/client`.
- `build.mjs`: copies the client bundle into `site/assets/` and writes `config.json` from `quay.json` and `board.json`.
- `test/`: `node --test` from this folder.

On chain: 19 files, about 55 KB (one KB locks 0.01 NEAR, so about 0.55 NEAR for storage). The 20 KB client bundle is the largest part.

## Run it

You need a funded testnet account that holds the contract (the account in `quay.json`, keys in `~/.near-credentials`) and the relayer, functions and cron streams from the full-stack release.

```sh
cd examples/board
# 1. set "account" in quay.json (and relay.account) to your funded account
# 2. relay: quay relay deploy   (or quay relay serve for the Node host); copy board.example.json to board.json and put the relay URL in it, or the OutLayer form `{"relay":{"outlayer":{"owner":"...","project":"relay","paymentKey":"..."}}}` once the client supports it (a payment key in a public page can be spent by anyone)
node build.mjs                         # client bundle + assets/config.json
quay products token usdc.fakes.testnet # test USDC for the token price (quay.json has no token key yet)
quay db fund 2                         # the pool pays for every post, so it must have NEAR
quay up -m "Harbour Board"             # functions, collections, products, members, cron, release with routes and the large image, promote
quay cron arm                          # starts the hourly chain
node seed.mjs                          # joins six members through the relay and posts 13 notices
```

`quay up --dry-run` prints the plan first. `node seed.mjs --dry-run` prints the seed plan with no network. `node seed.mjs --wait` waits for each moderation result (about 13 s per post). Seeding is safe to repeat: a title already on the board is skipped. Member keys for the seed accounts are kept in `.seed-sessions.json` (gitignored, never printed).

Then open `https://<account>.page/`. If the public gateway is down, run `quay gateway --account <account>` and open the local URL.

## What each page does without JavaScript

`/`, `/posts/:id`, `/api/posts` are complete HTML or JSON from the contract. The digest box, the member list, the receipts list, posting and pinning need JavaScript, because they read the chain or hold a key in the browser.

## Honest limits

- **Relayer host.** `relay.host` is `outlayer` with the Node host as fallback. Either way a relayer is a service: it can refuse requests and it spends from the NEAR balance of `relay.<account>`, which is its hard limit. A member key lives only in the visitor's `localStorage`; clearing it loses the account.
- **OutLayer is one operator.** The moderation, digest and (when used) relay functions run on OutLayer's TEE workers. If OutLayer is down, posts still land, but `fn.preview` stays empty and cron results stop.
- **Link previews fetch a third party.** A preview image is loaded by the visitor's browser from the linked site. Links in a post are shown as text until the function has checked them and written an `https` URL.
- **Gateway.** The page is served by the `testnet.page` gateway. `quay gateway` serves the same release on your machine from RPC.
- **Cron re-arms by hand.** The yield chain lives about 14 hours per arming. After that run `quay cron arm` again, or any transaction that calls `cron_arm`. The digest page says "No digest yet" until the first run.
- **Posting and pinning.** Members (`<name>.<account>`) post gasless through the relayer. Any wallet account can also post and pays its own gas; storage is paid by the site pool either way. Pinning needs a wallet with at least 0.1 NEAR; a relayed member holds no NEAR and cannot pay.
- **Test USDC.** The token price is test USDC (`usdc.fakes.testnet`), not Circle USDC. Anyone can mint it. This page does not offer a token checkout button; use `ft_transfer_call` with `{"product":"pin","ref":"posts/<id>"}`.
- **Images.** The seeded picture is stored through the CLI's file store (`nearfs` by default). User image uploads are out of scope: NEARFS was not serving on 2026-11-10, so the post form takes text and a link only.
- **Data is live state.** `quay rollback` restores files, templates and routes. It does not restore posts, members, receipts or rules. A moderator can hide a post, but the data stays on chain.
- **Previews.** Routes render at `/…` on production. A `/r/<id>/…` preview shows the routed text, but `/assets/…` links are root-relative, so a preview page loses its styles.
