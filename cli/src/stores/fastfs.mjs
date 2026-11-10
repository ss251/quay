// FastFS (FastNEAR): no signup, pays only gas. A file goes up as the args of a
// `__fastdata_fastfs` call to outlayer.testnet; the call is meant to fail (gas
// 1) and the FastFS indexer keeps the args. The file is then served at
// https://test.fastfs.io/<uploader>/<receiver>/<path>. The path is
// <sha256>.<ext>, so the URL names the content. Sealed as external { url }.
//
// Size: one upload is one transaction, which Near caps at 1.5 MiB in all, so a
// file is refused above MAX_BYTES. FastFS's own per-file cap was not measured,
// and this store does not split a file. A 406 KB wasm was served live.
import { extname } from "node:path";

import { QuayError } from "../errors.mjs";
import { fastfsPayload, FASTFS_HOST, OUTLAYER_CONTRACT } from "../outlayer.mjs";

export const MAX_BYTES = 1_400_000;

export function fastfsPath(path, sha256) {
  const ext = extname(path).slice(1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? `${sha256}.${ext}` : `${sha256}.bin`;
}

export function fastfsStore(ctx) {
  const account = ctx.config?.account;
  if (!account) throw new QuayError("the fastfs store needs an account", 1);
  return {
    name: "fastfs",
    needsAccount: false,
    maxBytes: MAX_BYTES,
    /** The URL is known before anything is sent. */
    urlOf: ({ path, sha256 }) =>
      `${FASTFS_HOST}/${account}/${OUTLAYER_CONTRACT}/${fastfsPath(path, sha256)}`,
    gatewayUrl: (ref) => ref,
    async upload(file, { progress = () => {} } = {}) {
      if (file.bytes.length > MAX_BYTES)
        throw new QuayError(
          `${file.path} is ${file.bytes.length} bytes. One FastFS upload is one transaction (1.5 MiB at most), so the fastfs store takes files up to ${MAX_BYTES} bytes. Use --store nearfs, pinata or filebase for this one.`,
          1,
        );
      const rel = fastfsPath(file.path, file.sha256);
      const url = this.urlOf(file);
      progress(`${file.path}  uploading to fastfs`);
      const sent = await ctx.chain.sendBatch(
        [
          {
            method: "__fastdata_fastfs",
            args: fastfsPayload(file.bytes, rel, file.contentType),
            gas: 1n,
          },
        ],
        { receiverId: OUTLAYER_CONTRACT },
      );
      return { url, transactions: [sent.hash] };
    },
  };
}
