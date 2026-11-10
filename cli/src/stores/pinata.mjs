// Pinata. Needs an account: set PINATA_JWT to an API key JWT with file write
// scope. Uses the documented upload endpoint, POST https://uploads.pinata.cloud/v3/files.
// Not exercised against the live service: no key was available.
import { QuayError } from "../errors.mjs";

export const UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
export const DEFAULT_GATEWAY = "https://gateway.pinata.cloud/ipfs/";

export function pinataStore(ctx) {
  const env = ctx.env ?? process.env;
  const fetcher = ctx.fetch ?? globalThis.fetch;
  const jwt = env.PINATA_JWT;
  if (!jwt) {
    throw new QuayError(
      "the pinata store needs an account. Set PINATA_JWT to a Pinata API key JWT.",
      1,
    );
  }
  const gateway = (env.PINATA_GATEWAY || DEFAULT_GATEWAY).replace(/\/?$/, "/");
  const base = gateway.endsWith("/ipfs/") ? gateway : `${gateway}ipfs/`;
  return {
    name: "pinata",
    needsAccount: true,
    gatewayUrl: (cid) => `${base}${cid}`,
    async upload(file, { progress = () => {} } = {}) {
      progress(`${file.path}  uploading to pinata`);
      const form = new FormData();
      form.set("network", "public");
      form.set("name", file.path.split("/").pop());
      form.set(
        "file",
        new Blob([file.bytes], { type: file.contentType }),
        file.path.split("/").pop(),
      );
      const response = await fetcher(UPLOAD_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
        body: form,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new QuayError(
          `pinata returned ${response.status}: ${text.slice(0, 180)}`,
          2,
        );
      }
      let cid;
      try {
        cid = JSON.parse(text)?.data?.cid;
      } catch {
        cid = undefined;
      }
      if (typeof cid !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(cid)) {
        throw new QuayError("pinata did not return a CID", 2);
      }
      return { cid, transactions: [] };
    },
  };
}
