// NEARFS: no signup, pays only gas. Each IPFS block is the raw args of an
// `fs_store` call sent to the signer's own account. The call fails by design
// (the contract has no such method); the NEARFS indexer keeps the args.
import { teraToGas } from "near-api-js";

import { buildFile } from "./cid.mjs";

export const MAX_ACTIONS = 7;
export const MAX_BATCH_BYTES = 262_144;
export const ACTION_GAS = teraToGas("30");
export const GATEWAY = "https://ipfs.web4.testnet.page/ipfs/";

/** Greedy batches: at most 7 blocks and 256 KiB of args per transaction. */
export function batchBlocks(blocks) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const block of blocks) {
    const length = block.bytes.length;
    if (
      current.length > 0 &&
      (current.length >= MAX_ACTIONS || size + length > MAX_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(block);
    size += length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function nearfsStore(ctx) {
  return {
    name: "nearfs",
    needsAccount: false,
    gatewayUrl: (cid) => `${GATEWAY}${cid}`,
    /** The CID is known before anything is sent. */
    async cidOf(bytes) {
      return (await buildFile(bytes)).root;
    },
    async upload(file, { progress = () => {} } = {}) {
      const built = await buildFile(file.bytes);
      const batches = batchBlocks(built.blocks);
      const transactions = [];
      for (let index = 0; index < batches.length; index += 1) {
        progress(`${file.path}  block batch ${index + 1}/${batches.length}`);
        const sent = await ctx.chain.sendBatch(
          batches[index].map((block) => ({
            method: "fs_store",
            args: block.bytes,
            gas: ACTION_GAS,
          })),
        );
        transactions.push(sent.hash);
      }
      return { cid: built.root, transactions };
    },
  };
}
