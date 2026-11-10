import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { requireAccount } from "./config.mjs";
import { QuayError } from "./errors.mjs";
import { confirm, explorerUrl, owner, stopped } from "./shared.mjs";
import {
  emit,
  formatNear,
  formatTime,
  helpText,
  table,
  writeErr,
  writeOut,
} from "./text.mjs";
import {
  addDocCost,
  growthCost,
  parseCount,
  parseNear,
  TRIGGER_GAS,
} from "./units.mjs";

const WRITE_RULES = ["owner", "anyone", "members"];
const PAYERS = ["writer", "site"];
const ORDERS = ["asc", "desc"];

export const COLLECTION_NAME = /^[a-z0-9-][a-z0-9_-]{0,31}$/;
export const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function checkCollection(name) {
  if (typeof name !== "string" || !COLLECTION_NAME.test(name)) {
    throw new QuayError(
      "a collection name is 1 to 32 of a-z, 0-9, _ -, and does not start with _",
      1,
    );
  }
  return name;
}

export function checkDocId(id) {
  if (typeof id !== "string" || !DOC_ID.test(id)) {
    throw new QuayError("a doc id is 1 to 64 of A-Z, a-z, 0-9, _ -", 1);
  }
  return id;
}

function need(value, message) {
  if (value === undefined || value === true || value === "")
    throw new QuayError(message, 1);
  return String(value);
}

function oneOf(value, allowed, label) {
  const text = String(value);
  if (!allowed.includes(text)) {
    throw new QuayError(`${label} must be ${allowed.join(", ")}`, 1);
  }
  return text;
}

/** `--moderated` is true; `--moderated=false` turns it off. */
function boolFlag(value) {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new QuayError("a true/false flag takes true or false", 1);
}

function needKey(ctx) {
  if (!ctx.signer?.secret)
    throw new QuayError("no signing key for this account", 1);
}

/**
 * Send one function call, or print it on --dry-run. Returns null when nothing
 * was sent.
 */
export async function sendCall(
  ctx,
  method,
  args,
  { deposit = 0n, note, gas } = {},
) {
  if (ctx.dryRun) {
    emit(
      ctx,
      { dry_run: true, method, args, deposit: deposit.toString() },
      `dry run: ${method}${deposit > 1n ? ` with ${formatNear(deposit)} NEAR` : ""}${note ? `\n${note}` : ""}`,
    );
    return null;
  }
  return ctx.chain.send(method, args, gas ? { deposit, gas } : { deposit });
}

export function textOfData(input, cwd) {
  let raw = String(input ?? "");
  if (raw === "") throw new QuayError("pass the doc as JSON or @file.json", 1);
  if (raw.startsWith("@")) {
    const path = resolve(cwd, raw.slice(1));
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      throw new QuayError(`could not read ${path}`, 1);
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new QuayError("the doc is not valid JSON", 1);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new QuayError("a doc must be a JSON object", 1);
  }
  return JSON.stringify(parsed);
}

export async function db(ctx, parsed) {
  const sub = parsed.rest[0];
  if (!sub || parsed.flags.help) {
    writeOut(ctx, helpText("db"));
    if (!sub) throw new QuayError("quay db needs a subcommand", 1);
    return;
  }
  requireAccount(ctx.config);
  const args = parsed.rest.slice(1);
  const handlers = {
    collections: () => collections(ctx),
    collection: () => collectionCmd(ctx, parsed, args),
    list: () => list(ctx, parsed, args),
    get: () => get(ctx, args),
    add: () => add(ctx, parsed, args),
    update: () => update(ctx, parsed, args),
    rm: () => remove(ctx, args),
    hide: () => hide(ctx, args, true),
    unhide: () => hide(ctx, args, false),
    fund: () => fund(ctx, args),
    withdraw: () => withdraw(ctx, args),
    pool: () => pool(ctx),
  };
  const handler = handlers[sub];
  if (!handler) throw new QuayError(`unknown db command ${sub}`, 1);
  await handler();
}

function rulesRow(view) {
  return {
    name: view.name,
    write: view.write,
    payer: view.payer,
    max_bytes: view.max_doc_bytes,
    moderated: view.moderated ? "yes" : "no",
    per_account: view.max_docs_per_account ?? "",
    docs: view.count,
    bytes: view.bytes,
  };
}

async function collections(ctx) {
  const list = (await ctx.chain.view("list_collections", {})) ?? [];
  if (ctx.json) return writeOut(ctx, JSON.stringify({ collections: list }));
  if (list.length === 0) return writeOut(ctx, "no collections");
  writeOut(
    ctx,
    table(list.map(rulesRow), [
      { key: "name", label: "name" },
      { key: "write", label: "write" },
      { key: "payer", label: "payer" },
      { key: "max_bytes", label: "max bytes" },
      { key: "moderated", label: "moderated" },
      { key: "per_account", label: "per account" },
      { key: "docs", label: "docs" },
      { key: "bytes", label: "bytes" },
    ]),
  );
}

/** Rules the contract accepts, from the flags laid over any existing rules. */
export function rulesFromFlags(flags, existing) {
  const rules = {
    write: existing?.write ?? "owner",
    max_doc_bytes: existing?.max_doc_bytes ?? 4096,
    moderated: existing?.moderated ?? false,
    payer: existing?.payer ?? "writer",
    max_docs_per_account: existing?.max_docs_per_account ?? null,
    on_add: existing?.on_add ?? null,
  };
  if (flags.write !== undefined)
    rules.write = oneOf(
      need(flags.write, "--write needs a value"),
      WRITE_RULES,
      "--write",
    );
  if (flags.payer !== undefined)
    rules.payer = oneOf(
      need(flags.payer, "--payer needs a value"),
      PAYERS,
      "--payer",
    );
  if (flags["max-bytes"] !== undefined)
    rules.max_doc_bytes = parseCount(flags["max-bytes"], "--max-bytes", {
      min: 1,
      max: 16384,
    });
  const moderated = boolFlag(flags.moderated);
  if (moderated !== undefined) rules.moderated = moderated;
  if (flags["max-per-account"] !== undefined) {
    const raw = String(flags["max-per-account"]);
    rules.max_docs_per_account =
      raw === "none" || raw === "0"
        ? null
        : parseCount(raw, "--max-per-account", { min: 1 });
  }
  if (flags["on-add"] !== undefined) {
    const raw = String(flags["on-add"]);
    rules.on_add = raw === "none" || raw === "true" ? null : raw;
  }
  return rules;
}

async function collectionCmd(ctx, parsed, args) {
  const action = args[0];
  const name = checkCollection(args[1]);
  if (action === "set") {
    owner(ctx);
    const existing = await ctx.chain.view("get_collection", { name });
    const rules = rulesFromFlags(parsed.flags, existing);
    const sent = await sendCall(
      ctx,
      "set_collection",
      { name, rules },
      { deposit: 1n },
    );
    if (!sent) return;
    emit(
      ctx,
      {
        name,
        rules,
        created: !existing,
        transaction: sent.hash,
        transaction_url: explorerUrl(sent.hash),
      },
      `${existing ? "updated" : "created"} collection ${name}\ntransaction ${explorerUrl(sent.hash)}`,
    );
    return;
  }
  if (action === "drop") {
    owner(ctx);
    const existing = await ctx.chain.view("get_collection", { name });
    if (!existing) throw new QuayError(`collection ${name} is missing`, 1);
    if (Number(existing.count) > 0)
      throw new QuayError(
        `collection ${name} still has ${existing.count} docs. Remove them first.`,
        1,
      );
    if (!ctx.dryRun) {
      const ok = await confirm(ctx, `Drop collection ${name}?`);
      if (!ok) return stopped(ctx);
    }
    const sent = await sendCall(
      ctx,
      "drop_collection",
      { name },
      { deposit: 1n },
    );
    if (!sent) return;
    emit(
      ctx,
      {
        name,
        dropped: true,
        transaction: sent.hash,
        transaction_url: explorerUrl(sent.hash),
      },
      `dropped collection ${name}\ntransaction ${explorerUrl(sent.hash)}`,
    );
    return;
  }
  throw new QuayError("quay db collection needs set <name> or drop <name>", 1);
}

function preview(data) {
  const text = JSON.stringify(data ?? {});
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

export function docRows(docs) {
  return docs.map((doc) => ({
    id: doc.id,
    owner: doc.owner,
    created: formatTime(doc.created),
    state: [doc.hidden ? "hidden" : "", doc.pinned_until ? "pinned" : ""]
      .filter(Boolean)
      .join(","),
    data: preview(doc.data),
  }));
}

export function listQuery(flags) {
  const query = {};
  if (flags.owner !== undefined)
    query.owner = need(flags.owner, "--owner needs an account");
  if (flags.prefix !== undefined)
    query.prefix = need(flags.prefix, "--prefix needs a value");
  if (flags.from !== undefined) {
    query.from = String(
      parseCount(need(flags.from, "--from needs a number"), "--from"),
    );
  }
  if (flags.limit !== undefined)
    query.limit = parseCount(flags.limit, "--limit", { min: 1, max: 50 });
  if (flags.order !== undefined)
    query.order = oneOf(
      need(flags.order, "--order needs asc or desc"),
      ORDERS,
      "--order",
    );
  if (flags.hidden) query.include_hidden = true;
  return query;
}

async function list(ctx, parsed, args) {
  const collection = checkCollection(args[0]);
  const page = await ctx.chain.view("db_list", {
    collection,
    query: listQuery(parsed.flags),
  });
  if (ctx.json) return writeOut(ctx, JSON.stringify(page));
  const docs = page?.docs ?? [];
  const lines = [];
  if (docs.length === 0) lines.push("no docs");
  else
    lines.push(
      table(docRows(docs), [
        { key: "id", label: "id" },
        { key: "owner", label: "owner" },
        { key: "created", label: "created" },
        { key: "state", label: "state" },
        { key: "data", label: "data" },
      ]),
    );
  if (page?.next != null)
    lines.push(`more  quay db list ${collection} --from ${page.next}`);
  writeOut(ctx, lines.join("\n"));
}

async function get(ctx, args) {
  const collection = checkCollection(args[0]);
  const id = checkDocId(args[1]);
  const doc = await ctx.chain.view("db_get", { collection, id });
  if (!doc) throw new QuayError(`no doc ${id} in ${collection}`, 1);
  writeOut(ctx, ctx.json ? JSON.stringify(doc) : JSON.stringify(doc, null, 2));
}

async function rulesOf(ctx, collection) {
  const view = await ctx.chain.view("get_collection", { name: collection });
  if (!view) throw new QuayError(`collection ${collection} is missing`, 1);
  return view;
}

function checkSize(data, rules) {
  const bytes = Buffer.byteLength(data);
  if (bytes > rules.max_doc_bytes) {
    throw new QuayError(
      `the doc is ${bytes} bytes and the collection allows ${rules.max_doc_bytes}`,
      1,
    );
  }
  return bytes;
}

async function add(ctx, parsed, args) {
  needKey(ctx);
  const collection = checkCollection(args[0]);
  const data = textOfData(args[1], ctx.cwd);
  const id =
    parsed.flags.id !== undefined ? checkDocId(String(parsed.flags.id)) : null;
  if (id && /^\d+$/.test(id))
    throw new QuayError("all-digit doc ids are reserved for automatic ids", 1);
  const rules = await rulesOf(ctx, collection);
  const bytes = checkSize(data, rules);
  let deposit = 0n;
  let note;
  if (parsed.flags.deposit !== undefined) {
    deposit = parseNear(
      need(parsed.flags.deposit, "--deposit needs a NEAR amount"),
      "--deposit",
    );
    if (rules.payer === "site" && deposit > 0n)
      throw new QuayError(
        "this collection is paid by the site pool and takes no deposit",
        1,
      );
  } else if (rules.payer === "writer") {
    deposit = addDocCost((id ?? "0000000000").length, bytes);
    note = `storage deposit ${formatNear(deposit)} NEAR attached. The contract refunds the excess.`;
  }
  if (rules.on_add)
    writeErr(
      ctx,
      `this collection runs ${rules.on_add} on every add. Sending 300 Tgas, the call needs at least 120.`,
    );
  if (note) writeErr(ctx, note);
  const sent = await sendCall(
    ctx,
    "db_add",
    { collection, id, data },
    { deposit, note, gas: rules.on_add ? TRIGGER_GAS : undefined },
  );
  if (!sent) return;
  const docId = typeof sent.value === "string" ? sent.value : id;
  emit(
    ctx,
    {
      collection,
      id: docId,
      deposit: deposit.toString(),
      transaction: sent.hash,
      transaction_url: explorerUrl(sent.hash),
    },
    `added ${collection}/${docId}\ntransaction ${explorerUrl(sent.hash)}`,
  );
}

async function update(ctx, parsed, args) {
  needKey(ctx);
  const collection = checkCollection(args[0]);
  const id = checkDocId(args[1]);
  const data = textOfData(args[2], ctx.cwd);
  const rules = await rulesOf(ctx, collection);
  const bytes = checkSize(data, rules);
  const current = await ctx.chain.view("db_get", { collection, id });
  if (!current) throw new QuayError(`no doc ${id} in ${collection}`, 1);
  let deposit = 0n;
  if (parsed.flags.deposit !== undefined) {
    deposit = parseNear(
      need(parsed.flags.deposit, "--deposit needs a NEAR amount"),
      "--deposit",
    );
  } else if (rules.payer === "writer") {
    deposit = growthCost(
      Buffer.byteLength(JSON.stringify(current.data)),
      bytes,
    );
  }
  const sent = await sendCall(
    ctx,
    "db_update",
    { collection, id, data },
    { deposit },
  );
  if (!sent) return;
  emit(
    ctx,
    {
      collection,
      id,
      deposit: deposit.toString(),
      transaction: sent.hash,
      transaction_url: explorerUrl(sent.hash),
    },
    `updated ${collection}/${id}\ntransaction ${explorerUrl(sent.hash)}`,
  );
}

async function remove(ctx, args) {
  needKey(ctx);
  const collection = checkCollection(args[0]);
  const id = checkDocId(args[1]);
  if (!ctx.dryRun) {
    const ok = await confirm(ctx, `Remove ${collection}/${id}?`);
    if (!ok) return stopped(ctx);
  }
  const sent = await sendCall(ctx, "db_remove", { collection, id });
  if (!sent) return;
  emit(
    ctx,
    {
      collection,
      id,
      removed: true,
      transaction: sent.hash,
      transaction_url: explorerUrl(sent.hash),
    },
    `removed ${collection}/${id}\ntransaction ${explorerUrl(sent.hash)}`,
  );
}

async function hide(ctx, args, hidden) {
  owner(ctx);
  const collection = checkCollection(args[0]);
  const id = checkDocId(args[1]);
  const sent = await sendCall(
    ctx,
    "db_hide",
    { collection, id, hidden },
    { deposit: 1n },
  );
  if (!sent) return;
  emit(
    ctx,
    {
      collection,
      id,
      hidden,
      transaction: sent.hash,
      transaction_url: explorerUrl(sent.hash),
    },
    `${hidden ? "hid" : "unhid"} ${collection}/${id}\ntransaction ${explorerUrl(sent.hash)}`,
  );
}

async function fund(ctx, args) {
  needKey(ctx);
  const amount = parseNear(need(args[0], "quay db fund needs a NEAR amount"));
  if (amount < 10n ** 22n)
    throw new QuayError("the pool takes at least 0.01 NEAR", 1);
  const sent = await sendCall(ctx, "db_fund", {}, { deposit: amount });
  if (!sent) return;
  emit(
    ctx,
    {
      funded: amount.toString(),
      transaction: sent.hash,
      transaction_url: explorerUrl(sent.hash),
    },
    `added ${formatNear(amount)} NEAR to the storage pool\ntransaction ${explorerUrl(sent.hash)}`,
  );
}

async function withdraw(ctx, args) {
  owner(ctx);
  const amount = parseNear(
    need(args[0], "quay db withdraw needs a NEAR amount"),
  );
  const sent = await sendCall(
    ctx,
    "db_withdraw",
    { amount: amount.toString() },
    { deposit: 1n },
  );
  if (!sent) return;
  emit(
    ctx,
    {
      withdrawn: amount.toString(),
      transaction: sent.hash,
      transaction_url: explorerUrl(sent.hash),
    },
    `released ${formatNear(amount)} NEAR from the storage pool\ntransaction ${explorerUrl(sent.hash)}`,
  );
}

async function pool(ctx) {
  const view = await ctx.chain.view("get_pool", {});
  const balance = BigInt(view?.balance ?? 0);
  const reserved = BigInt(view?.reserved ?? 0);
  emit(
    ctx,
    { balance: balance.toString(), reserved: reserved.toString() },
    [
      `pool       ${formatNear(balance)} NEAR`,
      `reserved   ${formatNear(reserved)} NEAR (held by site-paid docs)`,
    ].join("\n"),
  );
}
