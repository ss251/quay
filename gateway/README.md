# @quay/gateway

Serves Quay sites, and any other web4 contract, straight from NEAR testnet over JSON-RPC. Use it when the public `https://<name>.testnet.page` gateway is down, or to put a site on your own domain.

It turns each GET into a `web4_get` view call (`query` / `call_function`, finality `optimistic`) and answers with the contract's status, content type, body, and cache rule. It follows `bodyUrl` (relative, `ipfs://`, `http(s)://`) and `preloadUrls`, exactly as the public gateway does, and serves `GET /web4/contract/<account>/<method>?<args>` view calls. Query keys ending in `.json` are parsed as JSON. Login and POST are not supported.

The core is `src/core.mjs`. It exports `createGateway(options)`, which returns `async (Request) => Response`. It uses only fetch, Request, Response, URL, `crypto.subtle`, and TextEncoder, so it runs unchanged on Node 20+, Deno, Bun, and Cloudflare Workers.

## Three ways to run it

### 1. `quay gateway` (from the CLI)

```sh
quay gateway --account quay-65nqd3rn.testnet
# serving quay-65nqd3rn.testnet at http://127.0.0.1:8787/
```

From a checkout without installing: `node cli/bin/quay.js gateway --account <id>`. Options: `--port 8787`, `--host 127.0.0.1`, and `--rpc <url>` (repeat it for a fallback list). Without `--account` it uses the account in `quay.json`. Ctrl-C stops it. The CLI package carries a copy of the core in `cli/vendor/gateway`, so it needs no network install.

### 2. A single file for Node, Deno, Bun, or a container

```sh
node gateway/build.mjs                       # writes gateway/dist/ and gateway/worker/worker.mjs
node gateway/dist/quay-gateway.mjs --account quay-65nqd3rn.testnet --port 8787
deno run -A gateway/dist/quay-gateway.mjs --account quay-65nqd3rn.testnet --port 8787
bun gateway/dist/quay-gateway.mjs --account quay-65nqd3rn.testnet --port 8787
```

To serve every account under a domain you own, pass `--domain` and listen on all interfaces:

```sh
node gateway/dist/quay-gateway.mjs --domain example.com --host 0.0.0.0 --port 8787
```

Container, from `gateway/`:

```sh
docker build -t quay-gateway .
docker run --rm -p 8787:8787 -e ACCOUNT=quay-65nqd3rn.testnet quay-gateway
# or: -e DOMAIN=example.com
```

`--help` lists every flag. Each flag has an environment fallback: `ACCOUNT`, `DOMAIN`, `PORT`, `HOST`, `RPC_URLS` (comma-separated), `NEARFS_URLS`, `IPFS_URLS`.

### 3. Cloudflare Workers

`gateway/worker/` is ready to deploy as is:

```sh
cd gateway/worker && npx wrangler deploy
```

Wrangler asks you to log in and pick an account; no account id, zone id, or secret is committed. Before the first deploy, edit `[vars]` in `gateway/worker/wrangler.toml`: set `ACCOUNT` for one site on every host (a custom domain, or the `*.workers.dev` URL), or set `DOMAIN` (and empty `ACCOUNT`) for host routing. `RPC_URLS`, `NEARFS_URLS`, and `IPFS_URLS` are optional comma-separated lists. The custom-domain and wildcard routes are commented out at the bottom; host routing needs a wildcard DNS record and the `*.<domain>/*` route.

`worker/worker.mjs` is a prebuilt module worker (`export default { fetch(request, env) }`), generated from `src/` by `node gateway/build.mjs` and committed. `node gateway/build.mjs --check`, which `npm test` runs, fails when it is stale. `npx wrangler deploy --dry-run --outdir <dir>` (wrangler 4.45.0) bundles it without logging in: 30.09 KiB, 9.36 KiB gzipped.

Nothing here has been deployed. Options 2 and 3 need your own server or Cloudflare account.

Running the gateway as an OutLayer function was evaluated and is not possible today: OutLayer calls are POST requests with a payment key that return a JSON envelope, not a browsable HTTP server.

## Routing

- **Single site**: `account` (`--account`, `ACCOUNT`) serves that account on every host.
- **Host routing**: `domain` (`--domain`, `DOMAIN`) maps `<name>.<domain>` to `<name>.testnet`. The whole prefix is used, so `a.b.example.com` serves the sub-account `a.b.testnet`. The bare domain and other hosts get a 404 page. With `DOMAIN=testnet.page` this is the public gateway's own rule.

## Behaviour

- **RPC fallback.** The default list is `https://test.rpc.fastnear.com`, `https://testnet-rpc.intea.rs`, `https://near-testnet.drpc.org`. A network error, timeout (8 s per call), HTTP 429 or 5xx, a non-JSON answer, or a JSON-RPC error that is not a definitive handler error moves on to the next one. An endpoint that failed is tried last for 30 seconds. `rpc.testnet.near.org` is deprecated and always dropped.
- **Bodies.** `body` is base64. A `bodyUrl` that starts with `ipfs://` is tried at `https://ipfs.web4.testnet.page/ipfs/<cid>/<path>`, then `https://ipfs.io`, then `https://dweb.link`. A relative `bodyUrl` and same-origin preloads are answered in-process. `bodyUrl` bodies are streamed, not buffered.
- **Caching.** Every buffered body gets a strong `ETag` (sha256). An `ipfs://` body uses its CID, so `If-None-Match` answers 304 without fetching. `/r/<id>/…` responses are `public, max-age=31536000, immutable` and kept in an in-memory LRU (32 MB). Other paths use the contract's `cacheControl`, or `public, max-age=0, must-revalidate`. `HEAD` returns headers only.
- **Headers.** `x-quay-gateway: quay`, and `x-quay-rpc` names the RPC that answered.
- **Errors.** A failure is an HTML page with no external requests, in light or dark: all RPCs failed (502, with each endpoint and why), account does not exist (404), no contract (404), no `web4_get` (404), contract panicked (500), body URL failed (502). It names the account and path, and links back to the release for `/r/<id>/` paths. Requests with `Accept: application/json`, `/api/` paths, and `/web4/contract/` get `{"error": {kind, status, title, message, account, path}}` instead. The RPC's own response body is never shown.
- **Health.** `GET /_quay/health` returns `{ok, account, rpc, latency_ms}`, with 200 or 503.

## Tests

```sh
cd gateway && node --test                 # stubbed RPC; runs dist under deno and bun when installed
QUAY_LIVE=1 node --test test/runtimes.test.mjs   # also serves quay-65nqd3rn.testnet from the live testnet
node build.mjs --check                    # fails when dist/, worker/worker.mjs, or cli/vendor/gateway is stale
```

`npm test` at the repo root includes these. After editing `src/`, run `node gateway/build.mjs` and commit `dist/`, `worker/worker.mjs`, and `cli/vendor/gateway/` with it.
