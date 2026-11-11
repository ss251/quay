// Every layer of a Quay site, in one place. The home page's layer table and the
// docs pages under /docs/layers/ are both built from this list, so a fact, a
// command or a proof link is written once. Facts are Harbour Board's
// (harbour-board.testnet, contract 3.0.1), read from chain on 2026-11-11, with
// every transaction recorded in examples/board/LIVE.md. Commands are checked
// against `quay <command> --help` by web/build.mjs.

export const BOARD = "harbour-board.testnet";
const TX = "https://explorer.testnet.near.org/transactions/";
export const tx = (hash) => `${TX}${hash}`;
// The Board's Workers mirror comes from web/hosts.json at build time.
export const BOARD_HOST = "{{BOARD}}";

// A link to a transaction, shortened to its first eight characters.
const t = (hash, label) =>
  `<a href="${tx(hash)}">${label ?? `${hash.slice(0, 8)}…`}</a>`;

export const LAYERS = [
  {
    id: "site",
    name: "Site",
    state: "Live on testnet",
    runs: ["near"],
    what: "A folder becomes a sealed release with its own URL. Production is a pointer you move.",
    cmd: "quay deploy ./dist",
    proof: [
      [tx("DrGVTiLyDNC1Mer9nkks55NCcuf9XvfLwsWL2pUZXSVz"), "release 7 sealed"],
      [tx("G82qz1qKMiTaeMwAiEgefutWtvCFCMs73B9JLx9Ybmfx"), "production 7"],
    ],
    lede: "Each deploy uploads a folder and seals it as a release with its own preview URL. Production is a pointer on the contract. You move it with <code>quay promote</code> and move it back with <code>quay rollback</code>.",
    cmds: `quay init
quay deploy ./dist -m "harbour office"
quay promote 1
quay rollback`,
    how: [
      "Harbour Board has seven releases. Production is 7 and the previous release is 6.",
      "Every release still answers at <code>/r/&lt;id&gt;/</code>, so the home page can load any of them.",
      "Bytes shared by two releases are stored once, so all seven hold 137,411 B.",
    ],
    proofRows: [
      [
        "The account and contract",
        t("9He5iL5Ne5b5XBhWDAj34PmW3hg26tYYuGx6xoNuGBaz"),
      ],
      [
        "Release 7 sealed and promoted",
        `${t("DrGVTiLyDNC1Mer9nkks55NCcuf9XvfLwsWL2pUZXSVz")} and ${t("G82qz1qKMiTaeMwAiEgefutWtvCFCMs73B9JLx9Ybmfx")}`,
      ],
      [
        "A publish-only key refused promote",
        `${t("58YRcXZZZMPrmNgNCpEm4ssTWC6sCM73we6wKKD9smTT")}, on <code>quay-i7qkbbp3.testnet</code>`,
      ],
    ],
    check:
      "<code>view get_status '{}'</code> shows production, previous and the stored bytes.",
    trust:
      "Nothing to replace. The releases are on your account, and any RPC node reads them. A full-access key can replace the contract wasm, so a release is not owner-proof against that key. Keep it off CI and use <code>quay keys create --ci</code> there.",
    limits: [
      ["Files", "64 per release, 800,000 B each"],
      ["Releases", "32 live at once"],
      ["Payload", "2,000,000 B per account"],
      [
        "Cost",
        "0.01&nbsp;NEAR locked per 1,000 B, unlocked when you delete a release",
      ],
    ],
    help: ["deploy", "promote", "rollback"],
  },
  {
    id: "gateway",
    name: "Gateway",
    state: "Live on testnet",
    runs: ["web4", "cloudflare"],
    what: "Turns a browser request into a <code>web4_get</code> call. Run it on your machine, any server or Cloudflare Workers.",
    cmd: `quay gateway --account ${BOARD}`,
    proof: [
      [`${BOARD_HOST}/_quay/health`, "Workers host health"],
      ["https://harbour-board.testnet.page/", "testnet.page"],
    ],
    lede: "A browser cannot call a contract, so a gateway does. It turns <code>GET /posts/5</code> into a <code>web4_get</code> view call and returns the page. Quay ships its own gateway, and the public <code>testnet.page</code> gateway serves every web4 account too.",
    cmds: `quay gateway --account ${BOARD}
# serving ${BOARD} at http://127.0.0.1:8787/
cd gateway/worker && npx wrangler deploy`,
    how: [
      `The Board answers on its Cloudflare Workers host, on <code>harbour-board.testnet.page</code>, and on <code>quay gateway</code> on your machine.`,
      "On 2026-11-10 <code>testnet.page</code> answered every account with HTTP 400 for several hours. The Workers hosts exist because of that.",
    ],
    proofRows: [
      [
        "The Workers host answers",
        `<a href="${BOARD_HOST}/_quay/health">/_quay/health</a>`,
      ],
      [
        "The public gateway",
        '<a href="https://harbour-board.testnet.page/">harbour-board.testnet.page</a>',
      ],
    ],
    check:
      "<code>sh scripts/judge.sh</code> tries the Workers host, then <code>testnet.page</code>, then a local gateway, and prints which one answered.",
    trust:
      "<code>testnet.page</code> is one operator, and the Workers hosts are one Cloudflare account. Neither can change your pages, only stop serving them. <code>quay gateway</code> serves the same site from your machine, and the single-file build runs on Node, Deno or Bun.",
    limits: [
      [
        "Hosts",
        "The account host only. An extra label such as <code>www.</code> fails TLS on testnet.page.",
      ],
      [
        "Certificate",
        "A new testnet.page host gets its certificate on the first request, usually in under 2 minutes",
      ],
    ],
    help: ["gateway"],
  },
  {
    id: "routes",
    name: "Routes",
    state: "Live on testnet",
    runs: ["near", "std:web4_get"],
    what: "The contract fills a template from data, so a post page is complete HTML without JavaScript.",
    cmd: "quay up",
    proof: [
      [`${BOARD_HOST}/posts/5`, "/posts/5"],
      [`${BOARD_HOST}/api/posts`, "/api/posts"],
    ],
    lede: "A release can declare routes: a pattern, a collection and a template sealed in the same release. The contract fills the template inside <code>web4_get</code>, so a page is complete HTML without JavaScript. Templates escape every value.",
    cmds: `"routes": [
  { "pattern": "/", "kind": "list", "collection": "posts", "template": "templates/home.html", "limit": 10, "order": "desc" },
  { "pattern": "/posts/:id", "kind": "doc", "collection": "posts", "template": "templates/post.html" },
  { "pattern": "/api/posts", "kind": "json", "collection": "posts" }
]`,
    cmdsLabel: "quay.json",
    how: [
      "<code>/</code> lists the posts with pinned posts first and the latest digest.",
      "<code>/posts/:id</code> renders one post, and <code>/api/posts</code> returns JSON.",
      "A hidden post is absent from both, and <code>/posts/9</code> answers 404.",
    ],
    proofRows: [
      [
        "A server-rendered post",
        `<a href="${BOARD_HOST}/posts/5">/posts/5</a>`,
      ],
      ["The JSON route", `<a href="${BOARD_HOST}/api/posts">/api/posts</a>`],
      [
        "The hidden spam post",
        `<a href="${BOARD_HOST}/posts/9">/posts/9</a> answers 404`,
      ],
    ],
    check:
      "<code>quay up --dry-run</code> checks every route and template before anything is sent.",
    trust:
      "Routes run inside your contract. Rolling back a release rolls back its routes and templates with it, and never your data.",
    limits: [["Output", "Escaped values only. There is no raw HTML output."]],
    help: ["up"],
  },
  {
    id: "data",
    name: "Data",
    state: "Live on testnet",
    runs: ["near", "fastnear:FastData KV"],
    what: "Collections of JSON docs with rules. The site pays for storage, so a visitor needs no NEAR.",
    cmd: "quay db collection set posts --write anyone --payer site",
    proof: [
      [tx("AEg7rzCvAYnvr3R9gUdukQDZ2jsZSMkiRwFTS6r2dyp9"), "posts collection"],
      [tx("9jBJbchzA5kqwuZvJygdoSVNTokS7vjdZ5xRiiUKayE"), "a FastData write"],
    ],
    lede: "A collection holds JSON docs. Its rules say who may add, who pays for storage, and whether the owner may hide a doc. With <code>--payer site</code> the site's storage pool pays, so a visitor needs no NEAR. FastData KV is a second, gas-only backend for public data with no rules.",
    cmds: `quay db fund 2
quay db collection set posts --write anyone --payer site --moderated
quay db add posts '{"title":"Tide table is up"}'
quay db list posts --limit 10`,
    how: [
      "<code>posts</code> is <code>write: anyone</code>, <code>payer: site</code>, moderated, with <code>on_add: moderate</code>.",
      "It holds 14 docs in 4,692 B. A member at 0 NEAR wrote a guestbook entry to FastData KV through the relay.",
    ],
    proofRows: [
      ["The collection", t("AEg7rzCvAYnvr3R9gUdukQDZ2jsZSMkiRwFTS6r2dyp9")],
      [
        "The storage pool funded",
        t("DPnpKqji4wcLbgeHD9PukEu3trVKPZyE2HYn56hqAmqp"),
      ],
      [
        "A FastData KV write by a member",
        t("9jBJbchzA5kqwuZvJygdoSVNTokS7vjdZ5xRiiUKayE"),
      ],
    ],
    check: `<code>view list_collections '{}'</code> and <code>view db_list '{"collection":"posts","query":{"limit":5}}'</code>.`,
    trust:
      "Docs live in your contract. FastData KV entries are read from FastNEAR's indexer, have no rules, and only know the writer's account.",
    limits: [
      ["Doc", "1 to 16,384 B of JSON (2,000 on the Board)"],
      ["Collections", "32 per site"],
    ],
    help: ["db"],
  },
  {
    id: "functions",
    name: "Functions",
    state: "Live on testnet",
    runs: ["outlayer"],
    what: "Rust compiled to WASI, with a secret and outbound HTTPS. <code>moderate</code> checks every new post.",
    cmd: "quay functions deploy moderate",
    proof: [
      [tx("AyEpD8LfocJDMovR6LZDa8pcsHdNji86TiYpSCWARHBh"), "moderate deployed"],
      [
        "https://testnet-api.outlayer.ai/attestations/by-tx/9vX1o2oDv4cKdE1Qf95LGW6xQoJ6J5KXBYjqRND3RWAD",
        "a digest run, attested",
      ],
    ],
    lede: "A function is Rust compiled to WASI. OutLayer runs it in a TEE worker, and the contract keeps a registry of your functions and a record of every result. A function can hold a secret and make outbound HTTPS calls. There is no JavaScript runtime.",
    cmds: `quay functions deploy moderate
quay secrets set MOD_API_KEY --fn moderate
quay functions invoke digest '{}'
quay functions logs moderate`,
    how: [
      "A member adds a post. The <code>posts</code> collection has <code>on_add: moderate</code>, so the contract asks OutLayer to run it.",
      "<code>moderate</code> gets the post and the <code>MOD_API_KEY</code> secret. It checks blocked words and fetches a preview for any link.",
      "The result lands in the <code>_fn</code> collection. A post marked <code>hide: true</code> leaves <code>/</code> and <code>/api/posts</code>.",
    ],
    sample: {
      intro:
        "The result <code>moderate</code> wrote for run 24, read from the <code>_fn</code> collection:",
      json: `{
  "name": "moderate",
  "caller": "e2e-4eb351a1.harbour-board.testnet",
  "ok": true,
  "output": {
    "auth": "ok",
    "hide": false,
    "key_sha256_prefix": "f48adad6c4c4",
    "preview": { "title": "Example Domain", "url": "https://example.com/" },
    "reason": "ok"
  }
}`,
    },
    proofRows: [
      [
        "The function deployed",
        t("AyEpD8LfocJDMovR6LZDa8pcsHdNji86TiYpSCWARHBh"),
      ],
      [
        "The secret stored",
        `${t("3cZfXHtLAbCVGmFJxkGLF75v56B4tAwvjWVqq24Zwkud")}; the value was never printed, and only a sha256 prefix is kept`,
      ],
      [
        "<code>digest</code> run by hand",
        `${t("9vX1o2oDv4cKdE1Qf95LGW6xQoJ6J5KXBYjqRND3RWAD")} and its <a href="https://testnet-api.outlayer.ai/attestations/by-tx/9vX1o2oDv4cKdE1Qf95LGW6xQoJ6J5KXBYjqRND3RWAD">attestation</a>`,
      ],
      [
        "A post hidden",
        `Run 17, from <code>promo-bot</code>: <code>hide: true</code>, blocked words. <a href="${BOARD_HOST}/posts/9">/posts/9</a> answers 404.`,
      ],
    ],
    check: `<code>view fn_list '{}'</code> and <code>view db_list '{"collection":"_fn","query":{"limit":3,"order":"desc"}}'</code>.`,
    trust:
      "OutLayer is one operator's TEE network. Secrets are decrypted inside its enclave, so you trust that enclave and that operator. There is no drop-in replacement. Run the same logic on your own server, or leave functions out. Without them, posts still land, previews stay empty and scheduled results stop.",
    limits: [
      ["Language", "Rust compiled to WASI. No JavaScript runtime."],
      ["Time", "30 seconds per call on the Board. Runs took 5 to 17 seconds."],
      ["Cost", "0.005&nbsp;NEAR attached per call, paid by the site"],
    ],
    help: ["functions", "secrets"],
  },
  {
    id: "members",
    name: "Sign-in",
    title: "Members and sign-in",
    state: "Live, one wallet",
    stateKind: "warn",
    runs: ["connect", "std:NEP-413"],
    what: "Members are accounts named <code>&lt;name&gt;.harbour-board.testnet</code>, made with no NEAR. A wallet signs a NEP-413 message.",
    cmd: "quay members open",
    proof: [
      [tx("BVSDQt281ZxdMrTTRbtwuuvB4onhos75wCFhq7n8RK7H"), "a member joined"],
      [
        tx("CBR7uEa5Kqt8fYwTh8WYhqrdhM9KVRMQEVU74Yq5jLGr"),
        "a Telegram test join",
      ],
    ],
    lede: "A member is an account named <code>&lt;name&gt;.&lt;site&gt;</code>, created through the relayer with no NEAR. The page makes the member's key in the browser and never sends it anywhere. A NEAR wallet can sign in instead, by signing a NEP-413 message that the page checks.",
    cmds: `quay members list
quay members open
quay members close`,
    how: [
      "On 2026-11-11 there were nine members. Six were seeded, one joined from the live <code>/new/</code> page in a headless browser, and two came from Telegram tests.",
      "Wallet sign-in worked with one connector, NEAR CLI. It signed a NEP-413 message for <code>walletchk-he8kli.harbour-board.testnet</code>, the Board accepted it, and a changed message or a wrong site was refused.",
      "Intear's testnet index was empty and Meteor blocks headless browsers, so neither is proven. Ledger and Nightly were not tried.",
      "For Telegram, a <code>telegram-auth</code> function on OutLayer checked test init data signed with a made-up bot token, then joined two members. No real bot has run yet.",
    ],
    proofRows: [
      [
        "A member joined from the live page",
        t("BVSDQt281ZxdMrTTRbtwuuvB4onhos75wCFhq7n8RK7H"),
      ],
      [
        "A Telegram test sign-in joined a member",
        t("CBR7uEa5Kqt8fYwTh8WYhqrdhM9KVRMQEVU74Yq5jLGr"),
      ],
      [
        "Wallet sign-in",
        "Off chain by design. A NEP-413 signature is checked, not sent. The run is written up in <code>examples/board/LIVE.md</code>.",
      ],
    ],
    check: `<code>view list_members '{"from_index":0,"limit":50}'</code>.`,
    trust:
      "The page loads <code>@hot-labs/near-connect</code> from esm.sh and the wallets it lists. A member key lives in that browser only. Pass your own connector, or sign with an explicit key in Node.",
    limits: [
      [
        "Wallets",
        "NEAR CLI proven. Intear, Meteor, Ledger and Nightly not proven on testnet.",
      ],
      ["Telegram", "Test init data only. No real bot, chat or widget yet."],
    ],
    help: ["members"],
  },
  {
    id: "relay",
    name: "Relay",
    state: "Live on testnet",
    runs: ["outlayer", "std:NEP-366"],
    what: "A relayer pays the gas for a member's signed delegate action. One host runs as an OutLayer function, with no server.",
    cmd: "quay relay deploy",
    proof: [
      [tx("99NtZvYBfG1B3FFT3faaxmLjxUtUvFxD33smjYAYTKfX"), "a gasless post"],
      [tx("9rnqpKHJYq2JB9Yc9pDNFJH1xRUWbZKX8gcLwwuWwVwT"), "relay deployed"],
    ],
    lede: "A relayer sends a delegate action the member signed, and pays the gas. Its policy refuses any deposit, so only site-paid writes go through. Two hosts speak one protocol: <code>quay relay serve</code>, a Node process, and an OutLayer function with no server.",
    cmds: `quay relay create --near 0.5
quay relay serve --port 8788
quay relay deploy
quay relay status`,
    how: [
      "The relayer is its own account, <code>relay.harbour-board.testnet</code>. Its balance is the spend limit, and it cannot move the site.",
      "Members joined and posted through both hosts. The live-page post took 6.0 seconds through the OutLayer relay.",
      "The OutLayer host needs a payment key in the page, so anyone who reads the page can spend it. The Board's holds about $0.05 of test USDC, at most $0.01 per call.",
    ],
    proofRows: [
      [
        "The relayer account",
        t("CmoixGMs3HEDPgb6MUrETueHPn8ZmHEjhwhCimFfs8kR"),
      ],
      [
        "The relay deployed on OutLayer",
        t("9rnqpKHJYq2JB9Yc9pDNFJH1xRUWbZKX8gcLwwuWwVwT"),
      ],
      [
        "A gasless post from the live page",
        t("99NtZvYBfG1B3FFT3faaxmLjxUtUvFxD33smjYAYTKfX"),
      ],
    ],
    check:
      "Open the member's post on the explorer. The signer is the member, and the relayer paid.",
    trust:
      "The relayer holds a key and spends from its own account. It can refuse requests; it cannot move the site. Run <code>quay relay serve</code> yourself and fund it with <code>quay relay create</code>.",
    limits: [
      ["Deposits", "Refused. A relayed write must be site-paid."],
      ["Time", "OutLayer relay calls took 5 to 20 seconds"],
    ],
    help: ["relay"],
  },
  {
    id: "files",
    name: "Large files",
    state: "Live on FastFS",
    runs: ["fastnear:FastFS"],
    what: "A file over the size you set goes to FastFS for gas only. The release keeps its URL and sha256.",
    cmd: "quay up --store fastfs",
    proof: [
      [
        "https://test.fastfs.io/harbour-board.testnet/outlayer.testnet/16cca45160bd57f293b580dc754cf8313cdc41cbcb7d982c4696bbf5c9f38ccf.png",
        "the 493,183 B photo",
      ],
      [
        tx("44t7hUBpfqKGR5FYgsMU7ak5FuAjv2jB6M1vvH1RpVm3"),
        "sealed in release 4",
      ],
    ],
    lede: "A file over <code>files.external_over</code> bytes goes to FastFS, which stores it for gas only. The release holds its https URL and sha256, and the gateway serves it under the release's own path.",
    cmds: `"files": { "external_over": 32768, "store": "fastfs" }`,
    cmdsLabel: "quay.json",
    how: [
      "The Board's hero photo is 493,183 B. It was uploaded to FastFS and first sealed as an external file in release 4.",
      "The gateway serves it at <code>/assets/img/harbour.png</code>, and its sha256 is <code>16cca451…8ccf</code>.",
    ],
    proofRows: [
      [
        "The file on FastFS",
        '<a href="https://test.fastfs.io/harbour-board.testnet/outlayer.testnet/16cca45160bd57f293b580dc754cf8313cdc41cbcb7d982c4696bbf5c9f38ccf.png">test.fastfs.io</a>',
      ],
      [
        "Sealed in release 4",
        t("44t7hUBpfqKGR5FYgsMU7ak5FuAjv2jB6M1vvH1RpVm3"),
      ],
      [
        "Served through the gateway",
        `<a href="${BOARD_HOST}/assets/img/harbour.png">/assets/img/harbour.png</a>`,
      ],
    ],
    check: `<code>curl -fsS ${BOARD_HOST}/assets/img/harbour.png | shasum -a 256</code>`,
    trust:
      "FastFS is one operator. If it drops a file, the release still points at it and the sha256 still says what it should be. Pinata and Filebase stores exist in the CLI and were never run against the live services. NEARFS accepted uploads on testnet and never served them, so it is not the default.",
    limits: [
      ["Serving", "A FastFS upload was served about 5 minutes after upload"],
    ],
    help: ["up"],
  },
  {
    id: "payments",
    name: "Payments",
    state: "Live, test USDC only",
    runs: ["near"],
    what: "A product priced in NEAR or one NEP-141 token. The Board sells a 24-hour pin for 0.1 NEAR or 0.1 test USDC.",
    cmd: 'quay products set pin --name "Pin for a day" --price 0.1 --grant pin --pin-seconds 86400',
    proof: [
      [tx("BzpjbDMxaUdoYm8kiXiqG7sjbv3QHSEVVo5XthMkTkLj"), "pin product"],
      [
        tx("3Gt1S2QFj4zB2WxcPpiE5nTXfzwSuo5Y5Hxydb3sS5yK"),
        "test USDC accepted",
      ],
    ],
    lede: "A product has a price in NEAR or in one NEP-141 token, and a grant: pin a doc for a time, or record a receipt. Receipts are a system collection that routes can read.",
    cmds: `quay products set pin --name "Pin for a day" --price 0.1 --grant pin --pin-seconds 86400
quay products token usdc.fakes.testnet
quay products list
quay receipts`,
    how: [
      "Post 5 was pinned with 0.1 NEAR and post 6 with 0.1 test USDC, <code>usdc.fakes.testnet</code>, which anyone can mint. Circle USDC is not used.",
      "A pin lasts 24 hours, so the order on <code>/</code> changes when it ends. The two receipts stay.",
    ],
    proofRows: [
      ["The pin product", t("BzpjbDMxaUdoYm8kiXiqG7sjbv3QHSEVVo5XthMkTkLj")],
      [
        "Test USDC as the token",
        t("3Gt1S2QFj4zB2WxcPpiE5nTXfzwSuo5Y5Hxydb3sS5yK"),
      ],
    ],
    check: `<code>view list_receipts '{"limit":10}'</code> shows one NEAR receipt and one test-USDC receipt.`,
    trust:
      "Payments settle on your contract. The token contract is whichever NEP-141 you name.",
    limits: [
      [
        "Token",
        "One accepted token per site, set with <code>quay products token</code>",
      ],
    ],
    help: ["products"],
  },
  {
    id: "cron",
    name: "Cron",
    state: "Live, armed by hand",
    stateKind: "warn",
    runs: ["near"],
    what: "An hourly <code>digest</code> job. The contract keeps itself awake; one arm lasts about 6 hours, then someone must arm it again.",
    cmd: "quay cron arm",
    proof: [
      [
        tx("GJSg1cdT9cpVw1Qugp6nProfWK5ynLViNfdQ3wKeweGG"),
        "armed, every run a receipt",
      ],
      [BOARD_HOST, "the digest on /"],
    ],
    lede: "OutLayer has no scheduler, so the contract keeps a chain of yielded promises alive. A hop runs about every 2 minutes for about 2.25 Tgas, and each job run takes 95 Tgas from the chain. One arm of 1 PGas lasts about 15 hours with no jobs and about 6 with one hourly job. Then the chain stops until a transaction arms it again, and nobody does that for you.",
    cmds: `quay cron add "every 60m" digest
quay cron arm
quay cron status`,
    how: [
      "The Board's <code>digest</code> job runs every 60 minutes. Its first scheduled run failed because the contract gave OutLayer 45 Tgas. Contract 3.0.1 gives it 80.",
      "The next run, at 23:22 UTC on 2026-11-10, wrote a digest, and the Board's home page says it came from the hourly job.",
    ],
    proofRows: [
      [
        "The schedule armed; every tick and run is a receipt of it",
        t("GJSg1cdT9cpVw1Qugp6nProfWK5ynLViNfdQ3wKeweGG"),
      ],
      [
        "Contract 3.0.1 with the gas fix",
        t("G5EUhktorfvAATvr21R8sZ57Q88N5XVEuFyN5JoUtxpw"),
      ],
      [
        "The latest digest",
        `<a href="${BOARD_HOST}/">the Board's home page</a>`,
      ],
    ],
    check:
      "<code>view cron_status '{}'</code> says whether the chain is armed now, its hops and its last tick.",
    trust:
      "No operator runs the schedule. The contract does, and OutLayer runs each job. When an arm runs out, the page keeps the last digest with its time. Run <code>quay cron arm</code> on a timer you control.",
    limits: [
      ["Jobs", "At most 8, every 5 minutes or slower"],
      [
        "Cost",
        "Each arm reserves about 1 NEAR while it runs and refunds the unused gas",
      ],
    ],
    help: ["cron"],
  },
];

// `quay up` has no layer of its own; the docs list it after the layers.
export const UP = {
  id: "up",
  name: "quay up",
  lede: "One command applies <code>quay.json</code>: functions, collection rules, products, the members setting and cron jobs, then it deploys the site folder with its routes and promotes it. It never arms cron. <code>--dry-run</code> prints the plan and changes nothing. The Board was deployed with it.",
  cmds: `quay up --dry-run
quay up -m "harbour board"`,
  versioned:
    "A release seals files, routes and templates, so <code>quay rollback</code> swaps those three. Docs, collection rules, products, members, function code and secrets, relay settings and cron jobs are live state, and a rollback leaves them alone.",
  help: ["up"],
};

// Harbour Board's releases, read with list_releases and get_status on
// 2026-11-11. The home page bakes them in and refreshes them from the chain.
export const BOARD_RELEASES = {
  production: 7,
  previous: 6,
  releases: [
    { id: 1, message: "Harbour Board", files: 19, bytes: 62675 },
    {
      id: 2,
      message: "Harbour Board: relay key, copy",
      files: 19,
      bytes: 62691,
    },
    {
      id: 3,
      message: "digest wording: say it ran by hand",
      files: 19,
      bytes: 62767,
    },
    {
      id: 4,
      message: "hero photo off chain (FastFS) and the relay fix in the client",
      files: 19,
      bytes: 60429,
    },
    { id: 5, message: "fix the test-USDC pin button", files: 19, bytes: 60382 },
    {
      id: 6,
      message: "digest says which run wrote it",
      files: 22,
      bytes: 64543,
    },
    {
      id: 7,
      message: "digest box: a failed run is not a digest",
      files: 22,
      bytes: 64726,
    },
  ],
};
