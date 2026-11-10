// Content addressing for the nearfs store. A file of at most one chunk is one
// raw leaf (bafkrei...). A larger file is raw leaves of 256 KiB under a dag-pb
// UnixFS file root (bafybei...), the layout `ipfs add --cid-version 1 --raw-leaves`
// makes with the default chunker.
import * as dagPb from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

export const LEAF_BYTES = 262_144;

async function rawBlock(bytes) {
  const digest = await sha256.digest(bytes);
  return { cid: CID.createV1(raw.code, digest), bytes };
}

/**
 * Blocks of a file. `root` is the file's CID string. `blocks` lists leaves
 * first and the root last, each `{ cid, bytes }`.
 */
export async function buildFile(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length <= LEAF_BYTES) {
    const leaf = await rawBlock(data);
    return { root: leaf.cid.toString(), blocks: [leaf] };
  }
  const leaves = [];
  for (let offset = 0; offset < data.length; offset += LEAF_BYTES) {
    leaves.push(await rawBlock(data.subarray(offset, offset + LEAF_BYTES)));
  }
  const file = new UnixFS({
    type: "file",
    blockSizes: leaves.map((leaf) => BigInt(leaf.bytes.length)),
  });
  const rootBytes = dagPb.encode(
    dagPb.prepare({
      Data: file.marshal(),
      Links: leaves.map((leaf) => ({
        Name: "",
        Tsize: leaf.bytes.length,
        Hash: leaf.cid,
      })),
    }),
  );
  const digest = await sha256.digest(rootBytes);
  const root = { cid: CID.createV1(dagPb.code, digest), bytes: rootBytes };
  return { root: root.cid.toString(), blocks: [...leaves, root] };
}
