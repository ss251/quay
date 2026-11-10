import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import { QuayError } from "./errors.mjs";

export const CHUNK_BYTES = 200_000;
export const MAX_FILE_BYTES = 800_000;
export const MAX_FILES = 64;
export const MAX_STORED_BYTES = 2_000_000;
export const YOCTO_PER_BYTE = 10n ** 19n;
export const TRIE_OVERHEAD_PER_CHUNK = 80n;
export const TRIE_OVERHEAD_PER_RELEASE = 200n;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".webmanifest": "application/manifest+json",
};

const SKIP_DIRS = new Set(["node_modules", "target", ".git"]);

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function contentType(path) {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function checkPath(path) {
  if (path.length < 1 || path.length > 180) {
    throw new QuayError(`path length is not allowed: ${path}`, 1);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) {
    throw new QuayError(`path has a character the contract rejects: ${path}`, 1);
  }
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new QuayError(`path has an empty or dotted segment: ${path}`, 1);
  }
  return path;
}

export function checkId(id) {
  if (typeof id !== "string" || id.length < 1 || id.length > 64 || id === "." || id === "..") {
    throw new QuayError("release id must be 1 to 64 of A-Z, a-z, 0-9, . _ -", 1);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new QuayError("release id must be 1 to 64 of A-Z, a-z, 0-9, . _ -", 1);
  }
  return id;
}

export function checkMessage(message) {
  const text = message ?? "";
  if ([...text].length > 200) throw new QuayError("message is longer than 200 characters", 1);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new QuayError("message has a control character", 1);
  return text;
}

export function chunkFile(bytes) {
  if (bytes.length === 0) throw new QuayError("a release file is empty", 1);
  if (bytes.length > MAX_FILE_BYTES) {
    throw new QuayError(`a file is larger than ${MAX_FILE_BYTES} bytes`, 1);
  }
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const data = Buffer.from(bytes.subarray(offset, offset + CHUNK_BYTES));
    chunks.push({ sha256: sha256(data), data });
  }
  if (chunks.length > 4) throw new QuayError("a file needs more than 4 chunks", 1);
  return chunks;
}

export function collectSite(target) {
  const stat = statSync(target);
  if (stat.isFile()) {
    const bytes = readFileSync(target);
    return [{ path: "index.html", bytes, contentType: contentType(target) }];
  }
  if (!stat.isDirectory()) throw new QuayError(`not a file or directory: ${target}`, 1);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const child = statSync(full);
      if (child.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(full);
        continue;
      }
      const path = checkPath(relative(target, full).split(sep).join("/"));
      files.push({ path, bytes: readFileSync(full), contentType: contentType(full) });
    }
  };
  walk(target);
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0 || files.length > MAX_FILES) {
    throw new QuayError("a release needs 1 to 64 files", 1);
  }
  if (!files.some((file) => file.path === "index.html")) {
    throw new QuayError("the folder needs index.html", 1);
  }
  return files;
}

export function planRelease(files, knownHashes) {
  const known = new Set(knownHashes);
  let newBytes = 0n;
  let reusedBytes = 0n;
  let newChunks = 0n;
  const planned = [];
  const uploads = [];
  for (const file of files) {
    const chunks = chunkFile(file.bytes);
    for (const chunk of chunks) {
      const size = BigInt(chunk.data.length);
      if (known.has(chunk.sha256)) reusedBytes += size;
      else {
        newBytes += size;
        newChunks += 1n;
        known.add(chunk.sha256);
        uploads.push({ ...chunk, path: file.path });
      }
    }
    planned.push({
      path: file.path,
      contentType: file.contentType,
      chunks: chunks.map((chunk) => chunk.sha256),
    });
  }
  const overhead = newChunks * TRIE_OVERHEAD_PER_CHUNK + TRIE_OVERHEAD_PER_RELEASE;
  const yocto = (newBytes + overhead) * YOCTO_PER_BYTE;
  return { planned, uploads, newBytes, reusedBytes, newChunks, overhead, yocto };
}

export function nextReleaseId(releases) {
  let highest = 0;
  for (const release of releases) {
    if (/^\d+$/.test(release.id)) highest = Math.max(highest, Number(release.id));
  }
  const id = String(highest + 1);
  checkId(id);
  if (releases.some((release) => release.id === id)) {
    throw new QuayError("could not choose a free release id", 1);
  }
  return id;
}

export function yoctoUnlocked(bytes) {
  return BigInt(bytes) * YOCTO_PER_BYTE;
}
