// Filebase over its S3 API (SigV4, bucket on the IPFS network). Needs an
// account: FILEBASE_KEY, FILEBASE_SECRET and FILEBASE_BUCKET. A PUT answers
// with the object's CID in the x-amz-meta-cid header.
// Not exercised against the live service: no key was available.
import { createHash, createHmac } from "node:crypto";

import { QuayError } from "../errors.mjs";

export const HOST = "s3.filebase.com";
export const REGION = "us-east-1";
export const DEFAULT_GATEWAY = "https://ipfs.filebase.io/ipfs/";

const hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hmac = (key, text) => createHmac("sha256", key).update(text).digest();

function encodePath(path) {
  return path
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

/**
 * AWS Signature Version 4 for one request. `headers` are the extra headers to
 * sign (lowercase names); host and x-amz-date are added. Returns the headers to
 * send, including authorization.
 */
export function signV4({
  method,
  host,
  path,
  query = "",
  headers = {},
  payloadHash,
  region,
  service = "s3",
  key,
  secret,
  date,
}) {
  const amzDate = date.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host, "x-amz-date": amzDate };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${String(all[name]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signed = names.join(";");
  const canonical = [
    method,
    encodePath(path),
    query,
    canonicalHeaders,
    signed,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join(
    "\n",
  );
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secret}`, day), region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(toSign)
    .digest("hex");
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
}

export function filebaseStore(ctx) {
  const env = ctx.env ?? process.env;
  const fetcher = ctx.fetch ?? globalThis.fetch;
  const key = env.FILEBASE_KEY;
  const secret = env.FILEBASE_SECRET;
  const bucket = env.FILEBASE_BUCKET;
  if (!key || !secret || !bucket) {
    throw new QuayError(
      "the filebase store needs an account. Set FILEBASE_KEY, FILEBASE_SECRET and FILEBASE_BUCKET (an IPFS bucket).",
      1,
    );
  }
  const gateway = (env.FILEBASE_GATEWAY || DEFAULT_GATEWAY).replace(
    /\/?$/,
    "/",
  );
  return {
    name: "filebase",
    needsAccount: true,
    gatewayUrl: (cid) => `${gateway}${cid}`,
    async upload(file, { progress = () => {} } = {}) {
      progress(`${file.path}  uploading to filebase`);
      const name = `${file.sha256.slice(0, 16)}-${file.path.split("/").pop()}`;
      const path = `/${bucket}/${name}`;
      const headers = signV4({
        method: "PUT",
        host: HOST,
        path,
        headers: {
          "content-type": file.contentType,
          "x-amz-content-sha256": file.sha256,
        },
        payloadHash: file.sha256,
        region: REGION,
        key,
        secret,
        date: ctx.now ? ctx.now() : new Date(),
      });
      const { host: _host, ...send } = headers;
      const response = await fetcher(`https://${HOST}${encodePath(path)}`, {
        method: "PUT",
        headers: send,
        body: file.bytes,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new QuayError(
          `filebase returned ${response.status}: ${text.slice(0, 180)}`,
          2,
        );
      }
      const cid = response.headers.get("x-amz-meta-cid");
      if (!cid || !/^[A-Za-z0-9]{1,128}$/.test(cid)) {
        throw new QuayError(
          "filebase did not return a CID. Is the bucket on the IPFS network?",
          2,
        );
      }
      return { cid, transactions: [] };
    },
  };
}
