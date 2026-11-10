// Cloudflare Workers entry. Env: ACCOUNT (one site on every host) or DOMAIN
// (<name>.<DOMAIN> serves <name>.testnet), RPC_URLS, NEARFS_URLS, IPFS_URLS.
import { createGateway, parseList } from "./core.mjs";

let key = null;
let gateway = null;

function gatewayFor(env = {}) {
  const next = JSON.stringify([
    env.ACCOUNT,
    env.DOMAIN,
    env.RPC_URLS,
    env.NEARFS_URLS,
    env.IPFS_URLS,
  ]);
  if (next !== key) {
    gateway = createGateway({
      account: env.ACCOUNT || undefined,
      domain: env.DOMAIN || undefined,
      rpcUrls: parseList(env.RPC_URLS ?? ""),
      nearfsGateways: env.NEARFS_URLS ? parseList(env.NEARFS_URLS) : undefined,
      ipfsGateways: env.IPFS_URLS ? parseList(env.IPFS_URLS) : undefined,
    });
    key = next;
  }
  return gateway;
}

export default {
  async fetch(request, env) {
    try {
      return await gatewayFor(env)(request);
    } catch (error) {
      return new Response(`quay gateway is misconfigured: ${error.message}\n`, {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-quay-gateway": "quay",
        },
      });
    }
  },
};
