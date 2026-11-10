// Standalone runner: `node|deno run -A|bun quay-gateway.mjs --account <id>`.
// Flags win over environment variables (ACCOUNT, DOMAIN, RPC_URLS, PORT, HOST,
// NEARFS_URLS, IPFS_URLS).
import { cleanRpcUrls, createGateway, parseList } from "./core.mjs";
import { localUrl, serve } from "./node.mjs";

export const HELP = `quay-gateway: serve Quay (web4) sites from NEAR testnet over JSON-RPC

Usage
  quay-gateway --account <id> [--port 8787] [--host 127.0.0.1] [--rpc <url>...]
  quay-gateway --domain <domain> [--port 8787] [--host 0.0.0.0]

Options
  --account <id>     Serve one account on every host (single site, custom domain).
  --domain <domain>  Host routing: <name>.<domain> serves <name>.testnet.
  --port <n>         Port. Default 8787, or PORT.
  --host <addr>      Interface. Default 127.0.0.1, or HOST.
  --rpc <url>        RPC endpoint; repeat or comma-separate for a fallback list.
  --nearfs <url>     NEARFS gateway for ipfs:// bodies; repeatable.
  --ipfs <url>       Public IPFS gateway, tried after NEARFS; repeatable.
  --quiet            Do not log requests.
  --help             Show this help.`;

const VALUED = new Set([
  "account",
  "domain",
  "port",
  "host",
  "rpc",
  "nearfs",
  "ipfs",
]);
const LISTS = new Set(["rpc", "nearfs", "ipfs"]);

export function parseOptions(argv, env = {}) {
  const flags = { rpc: [], nearfs: [], ipfs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--"))
      throw new Error(`unexpected argument ${token}`);
    const eq = token.indexOf("=");
    const name = token.slice(2, eq === -1 ? undefined : eq);
    if (name === "help" || name === "quiet") {
      flags[name] = true;
      continue;
    }
    if (!VALUED.has(name)) throw new Error(`unknown flag ${token}`);
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (value === undefined || value === "")
      throw new Error(`${token} needs a value`);
    if (LISTS.has(name)) flags[name].push(value);
    else flags[name] = value;
  }
  const port = Number(flags.port ?? env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`--port must be 0 to 65535`);
  const rpc = cleanRpcUrls(
    flags.rpc.length ? flags.rpc : parseList(env.RPC_URLS ?? ""),
  );
  return {
    help: Boolean(flags.help),
    quiet: Boolean(flags.quiet),
    account: flags.account ?? env.ACCOUNT ?? null,
    domain: flags.domain ?? env.DOMAIN ?? null,
    port,
    host: flags.host ?? env.HOST ?? "127.0.0.1",
    rpcUrls: rpc.urls,
    droppedRpc: rpc.dropped,
    nearfsGateways: flags.nearfs.length
      ? flags.nearfs
      : env.NEARFS_URLS
        ? parseList(env.NEARFS_URLS)
        : undefined,
    ipfsGateways: flags.ipfs.length
      ? flags.ipfs
      : env.IPFS_URLS
        ? parseList(env.IPFS_URLS)
        : undefined,
  };
}

export async function main(argv, env, io = {}) {
  const out = io.stdout ?? ((line) => console.log(line));
  const err = io.stderr ?? ((line) => console.error(line));
  let options;
  try {
    options = parseOptions(argv, env);
  } catch (error) {
    err(`quay-gateway: ${error.message}\n\n${HELP}`);
    return { code: 1 };
  }
  if (options.help) {
    out(HELP);
    return { code: 0 };
  }
  for (const url of options.droppedRpc)
    err(`quay-gateway: skipping ${url} (deprecated or not a URL)`);
  let handler;
  try {
    handler = createGateway(options);
  } catch (error) {
    err(`quay-gateway: ${error.message}\n\n${HELP}`);
    return { code: 1 };
  }
  const server = await serve(handler, {
    port: options.port,
    host: options.host,
    log: options.quiet ? undefined : (line) => err(line),
  });
  const target =
    options.account ?? `<name>.${handler.domain} -> <name>.testnet`;
  out(`quay-gateway ${localUrl(server.host, server.port)} serving ${target}`);
  out(`rpc ${handler.rpcUrls.join(", ")}`);
  return { code: null, server };
}
