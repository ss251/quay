// A fake NEAR testnet for gateway tests: answers JSON-RPC `query` calls from a
// table of accounts, and plain GETs from a table of URLs.
import { createServer } from "node:http";

export const RPC_A = "https://rpc-a.test";
export const RPC_B = "https://rpc-b.test";
export const DEPRECATED_BODY = JSON.stringify({
  jsonrpc: "2.0",
  error: {
    code: -429,
    message:
      "WARNING! THIS ENDPOINT IS DEPRECATED! STOP USING IT NOW! Switch to https://fastnear.com",
  },
  id: "1",
});

const encoder = new TextEncoder();

export function b64(text) {
  return Buffer.from(text).toString("base64");
}

export function json(body, status = 200, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function rpcValue(value) {
  return {
    jsonrpc: "2.0",
    id: "quay",
    result: {
      result: [...encoder.encode(JSON.stringify(value))],
      logs: [],
      block_height: 1,
    },
  };
}

export function rpcExecError(text) {
  return {
    jsonrpc: "2.0",
    id: "quay",
    result: { error: text, logs: [], block_height: 1 },
  };
}

export function rpcHandlerError(cause, data) {
  return {
    jsonrpc: "2.0",
    id: "quay",
    error: {
      name: "HANDLER_ERROR",
      cause: { name: cause, info: {} },
      code: -32000,
      message: "Server error",
      data,
    },
  };
}

// accounts: { "demo.testnet": { web4_get(args) -> value | Response-ish, get_x(args) } }
// A method may return { rpc: <raw JSON-RPC body> } to answer with that body.
export function fakeNet({ accounts = {}, urls = {}, rpc = {} } = {}) {
  const calls = [];
  async function fetch(input, init = {}) {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const origin = new URL(url).origin;
    if (rpc[origin]) {
      const override = await rpc[origin](init);
      if (override) return override;
    }
    if (origin === RPC_A || origin === RPC_B || rpc[origin]) {
      const body = JSON.parse(init.body);
      const params = body.params;
      if (params.request_type === "view_account") {
        if (!accounts[params.account_id])
          return json(
            rpcHandlerError(
              "UNKNOWN_ACCOUNT",
              `account ${params.account_id} does not exist while viewing`,
            ),
          );
        return json({ jsonrpc: "2.0", id: "quay", result: { amount: "1" } });
      }
      const account = accounts[params.account_id];
      if (!account)
        return json(
          rpcHandlerError(
            "UNKNOWN_ACCOUNT",
            `account ${params.account_id} does not exist while viewing`,
          ),
        );
      if (account === "no-code")
        return json(
          rpcExecError(
            `wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: "${params.account_id}" })`,
          ),
        );
      const method = account[params.method_name];
      if (!method)
        return json(
          rpcExecError(
            "wasm execution failed with error: MethodResolveError(MethodNotFound)",
          ),
        );
      const args = JSON.parse(
        Buffer.from(params.args_base64, "base64").toString("utf8"),
      );
      const value = await method(args);
      if (value && typeof value === "object" && "rpc" in value)
        return json(value.rpc);
      return json(rpcValue(value));
    }
    const handler = urls[url];
    if (!handler) return new Response("not found", { status: 404 });
    return handler(init);
  }
  fetch.calls = calls;
  fetch.rpcCalls = () =>
    calls
      .filter((call) => call.init?.method === "POST")
      .map((call) => ({
        rpc: new URL(call.url).origin,
        ...JSON.parse(call.init.body).params,
      }));
  return fetch;
}

export function page(text, extra = {}) {
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: b64(text),
    ...extra,
  };
}

// A real HTTP JSON-RPC stub on 127.0.0.1, for runtimes started as processes.
export async function rpcServer(accounts) {
  const fetch = fakeNet({ accounts });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await fetch(RPC_A, {
      method: "POST",
      body: Buffer.concat(chunks).toString("utf8"),
    });
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(await response.text());
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
