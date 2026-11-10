import { resolve } from "node:path";

import { QuayError } from "./errors.mjs";
import { validateRoutes } from "./routes.mjs";
import { confirm, explorerUrl, previewUrl, stopped } from "./shared.mjs";
import {
  checkId,
  checkMessage,
  chunkFile,
  collectSite,
  MAX_FILE_BYTES,
  MAX_STORED_BYTES,
  nextReleaseId,
  planRelease,
  sha256,
} from "./site.mjs";
import {
  alreadyStored,
  DEFAULT_STORE,
  makeStore,
  verifyExternal,
} from "./stores/index.mjs";
import { emit, formatBytes, formatNear, paint, writeErr } from "./text.mjs";

/** The contract takes exactly one of cid or url. */
export function refOf(item) {
  return item.url ? { url: item.url } : { cid: item.cid };
}

export async function allReleases(chain) {
  const releases = [];
  let from = 0;
  for (;;) {
    const page = await chain.view("list_releases", {
      from_index: from,
      limit: 20,
    });
    releases.push(...(page?.releases ?? []));
    if (page?.next == null) return releases;
    from = page.next;
  }
}

/**
 * Split a folder's files into those stored on chain and those over
 * `externalOver` bytes, which go to a content-addressed store.
 */
export function splitFiles(files, externalOver) {
  const onChain = [];
  const external = [];
  for (const file of files) {
    const large = externalOver != null && file.bytes.length > externalOver;
    if (large && file.bytes.length > 0 && file.path !== "index.html") {
      external.push(file);
      continue;
    }
    if (file.bytes.length > MAX_FILE_BYTES) {
      const why =
        file.path === "index.html"
          ? "index.html must be stored on chain"
          : "set files.external_over in quay.json or pass --external-over to store large files off chain";
      throw new QuayError(
        `${file.path} is ${file.bytes.length} bytes and the contract stores at most ${MAX_FILE_BYTES} per file: ${why}`,
        1,
      );
    }
    onChain.push(file);
  }
  return { onChain, external };
}

/**
 * Upload one release. `options`: dir, message, spa, id, routes, externalOver,
 * store, verify (default true), project note. Returns the summary and the
 * seal result, or `{ stopped: true }` / `{ dryRun: true }`.
 */
export async function deployRelease(ctx, options) {
  const dir = resolve(options.dir ?? ".");
  const message = checkMessage(options.message ?? "");
  const spa = Boolean(options.spa);
  const files = collectSite(dir);
  const listed = await allReleases(ctx.chain);
  if (listed.length >= 32)
    throw new QuayError("the contract already has 32 releases", 1);
  const id = options.id ? checkId(String(options.id)) : nextReleaseId(listed);
  if (listed.some((release) => release.id === id))
    throw new QuayError(`release ${id} already exists`, 1);
  const { onChain, external } = splitFiles(files, options.externalOver);
  const routes = validateRoutes(
    options.routes,
    files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      external: external.includes(file),
    })),
  );
  if (routes.length > 0) await warnMissingCollections(ctx, routes);
  const store =
    external.length > 0 ? makeStore(options.store ?? DEFAULT_STORE, ctx) : null;
  const externals = [];
  for (const file of external) {
    const digest = sha256(file.bytes);
    externals.push({
      file,
      sha256: digest,
      size: file.bytes.length,
      cid: store.cidOf ? await store.cidOf(file.bytes) : null,
      url: store.urlOf
        ? store.urlOf({ path: file.path, sha256: digest })
        : null,
    });
  }
  const status = await ctx.chain.view("get_status", {});
  const hashes = new Set();
  for (const file of onChain) {
    for (const chunk of chunkFile(file.bytes)) hashes.add(chunk.sha256);
  }
  const known = new Set();
  for (const hash of hashes) {
    if (await ctx.chain.hasChunk(hash)) known.add(hash);
  }
  const plan = planRelease(onChain, known);
  const stored = BigInt(status?.stored_bytes ?? 0);
  const max = BigInt(status?.max_bytes ?? MAX_STORED_BYTES);
  if (stored + plan.newBytes > max) {
    throw new QuayError(
      `this release needs ${plan.newBytes} new bytes and the contract has ${max - stored} left`,
      1,
    );
  }
  const summary = {
    id,
    files: files.length,
    new_bytes: Number(plan.newBytes),
    reused_bytes: Number(plan.reusedBytes),
    estimated_near: formatNear(plan.yocto),
    url: previewUrl(ctx.config.gateway, id),
  };
  if (routes.length > 0) summary.routes = routes.length;
  if (externals.length > 0) {
    summary.store = store.name;
    summary.external = externals.map((item) => ({
      path: item.file.path,
      size: item.size,
      sha256: item.sha256,
      ...refOf(item),
    }));
  }
  const lines = [
    `${summary.files} files, ${formatBytes(summary.new_bytes)} new, ${formatBytes(summary.reused_bytes)} reused`,
    `storage estimate ${summary.estimated_near} NEAR (0.01 NEAR / 1000 bytes, plus trie overhead)`,
  ];
  if (routes.length > 0)
    lines.push(`${routes.length} routes sealed with this release`);
  if (externals.length > 0) {
    const bytes = externals.reduce((total, item) => total + item.size, 0);
    lines.push(
      `${externals.length} large files (${formatBytes(bytes)}) go to ${store.name}${store.needsAccount ? "" : ", paid in gas only"}`,
    );
  }
  writeErr(ctx, lines.join("\n"));
  const next = `quay promote ${id} to make this production`;
  if (ctx.dryRun) {
    return { dryRun: true, id, summary, next, listed, plan };
  }
  const ok = await confirm(
    ctx,
    `Store release ${id} on ${ctx.config.account}?`,
  );
  if (!ok) {
    stopped(ctx);
    return { stopped: true };
  }

  const sealedExternals = [];
  const externalTransactions = [];
  for (const item of externals) {
    const outcome = await storeExternal(ctx, store, item, options);
    sealedExternals.push({ ...item, cid: outcome.cid, url: outcome.url });
    externalTransactions.push(...outcome.transactions);
  }
  const chunkHashes = [];
  const uploaded = [];
  let sealed;
  try {
    for (let index = 0; index < plan.uploads.length; index += 1) {
      const upload = plan.uploads[index];
      writeErr(
        ctx,
        `${index + 1}/${plan.uploads.length}  ${upload.path}  ${upload.data.length} bytes`,
      );
      const sent = await ctx.chain.putChunk(upload.sha256, upload.data);
      chunkHashes.push(sent.hash);
      uploaded.push(upload.sha256);
    }
    const sealFiles = [];
    const byPath = new Map(plan.planned.map((file) => [file.path, file]));
    const externalByPath = new Map(
      sealedExternals.map((item) => [item.file.path, item]),
    );
    for (const file of files) {
      const placed = externalByPath.get(file.path);
      if (placed) {
        sealFiles.push({
          path: file.path,
          chunks: [],
          content_type: file.contentType,
          external: {
            ...refOf(placed),
            size: String(placed.size),
            sha256: placed.sha256,
          },
        });
      } else {
        const planned = byPath.get(file.path);
        sealFiles.push({
          path: planned.path,
          chunks: planned.chunks,
          content_type: planned.contentType,
        });
      }
    }
    sealed = await ctx.chain.seal(id, sealFiles, message, spa, routes);
  } catch (error) {
    await dropAbandoned(ctx, uploaded);
    throw error;
  }
  return {
    id,
    summary,
    message,
    spa,
    sealed,
    next,
    listed,
    chunkHashes,
    externalTransactions,
    sealedExternals,
    routes,
  };
}

async function storeExternal(ctx, store, item, options) {
  const progress = (text) => writeErr(ctx, text);
  const verifyOptions = {
    fetch: ctx.fetch,
    sleep: ctx.sleep,
    verifyTimeoutMs: options.verifyTimeoutMs ?? ctx.verifyTimeoutMs,
    verifyIntervalMs: ctx.verifyIntervalMs,
  };
  const file = {
    path: item.file.path,
    bytes: item.file.bytes,
    contentType: item.file.contentType,
    sha256: item.sha256,
  };
  const known = item.url ?? item.cid;
  if (
    known &&
    (await alreadyStored(store, known, item.sha256, verifyOptions))
  ) {
    progress(
      `${file.path}  already served by ${store.name}, not uploading again`,
    );
    return { cid: item.cid, url: item.url, transactions: [] };
  }
  const uploaded = await store.upload(file, { progress });
  if (options.verify === false) {
    writeErr(
      ctx,
      `warning: ${file.path} was not read back (--no-verify). If ${store.name} never serves ${uploaded.url ?? uploaded.cid}, the site will have a broken file.`,
    );
  } else {
    progress(
      `${file.path}  reading ${uploaded.url ?? uploaded.cid} back to check its hash`,
    );
    await verifyExternal(
      store,
      uploaded.url ?? uploaded.cid,
      item.sha256,
      verifyOptions,
    );
  }
  return uploaded;
}

async function warnMissingCollections(ctx, routes) {
  let known;
  try {
    known = new Set(
      ((await ctx.chain.view("list_collections", {})) ?? []).map(
        (view) => view.name,
      ),
    );
  } catch {
    return;
  }
  const missing = [
    ...new Set(
      routes
        .map((route) => route.collection)
        .filter((name) => name !== "*" && !known.has(name)),
    ),
  ];
  if (missing.length > 0) {
    writeErr(
      ctx,
      `warning: no collection named ${missing.join(", ")} on this site yet. Routes to it answer 404 until you run quay db collection set <name>.`,
    );
  }
}

export async function dropAbandoned(ctx, hashes) {
  if (hashes.length === 0) return;
  if (ctx.signer?.limited) {
    writeErr(
      ctx,
      "Those new chunks stay stored. A publish-only key cannot drop them.",
    );
    return;
  }
  for (const hash of hashes) {
    try {
      await ctx.chain.dropChunk(hash);
      writeErr(ctx, `dropped unused chunk ${hash.slice(0, 12)}`);
    } catch (error) {
      writeErr(
        ctx,
        `could not drop ${hash.slice(0, 12)}: ${error.message ?? error}`,
      );
    }
  }
}

/** The plain and JSON output of a finished deploy. */
export function reportDeploy(ctx, result) {
  const { summary, sealed, message, spa, next } = result;
  const transactionUrl = explorerUrl(sealed.hash);
  const payload = {
    ...summary,
    message,
    spa,
    transaction: sealed.hash,
    transaction_url: transactionUrl,
    chunk_transactions: result.chunkHashes,
    next,
  };
  if (result.sealedExternals.length > 0) {
    payload.external = result.sealedExternals.map((item) => ({
      path: item.file.path,
      size: item.size,
      sha256: item.sha256,
      ...refOf(item),
    }));
    payload.external_transactions = result.externalTransactions;
  }
  const plain = [
    `${paint(ctx.color, "36", summary.id)}  ${summary.url}`,
    `reused ${formatBytes(summary.reused_bytes)}`,
  ];
  if (result.sealedExternals.length > 0)
    plain.push(
      `stored off chain ${result.sealedExternals.map((item) => `${item.file.path} ${item.url ?? item.cid}`).join(", ")}`,
    );
  plain.push(`transaction ${transactionUrl}`, `next  ${next}`);
  emit(ctx, payload, plain.join("\n"));
}
