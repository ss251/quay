// `quay secrets set|list|rm`: function secrets on OutLayer, encrypted on this machine.
// A value comes from stdin or a hidden prompt, never from argv, and is never
// printed, logged, or put in an error. OutLayer stores a function's secrets as
// one encrypted profile, so `set` writes every name it is given at once.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { requireAccount } from "./config.mjs";
import { QuayError, usage } from "./errors.mjs";
import { createOutlayer } from "./outlayer.mjs";
import { readProject } from "./projectfile.mjs";
import { confirm, explorerUrl, owner, stopped } from "./shared.mjs";
import { emit, helpText, table, writeOut } from "./text.mjs";

export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** The OutLayer client for this site, or the one a test injected. */
export function outlayerFor(ctx) {
  if (ctx.outlayer) return ctx.outlayer;
  return createOutlayer({
    account: ctx.config.account,
    rpc: ctx.config.rpcUrls ?? ctx.config.rpc,
    secret: ctx.signer?.limited ? undefined : ctx.signer?.secret,
    fetch: ctx.fetch,
    sleep: ctx.sleep,
  });
}

/** quay.json → functions, without the published HTTPS key entry. */
export function declaredFunctions(ctx) {
  if (!ctx.config.path) return {};
  const fns = readProject(ctx.config.path)?.functions ?? {};
  return Object.fromEntries(
    Object.entries(fns).filter(
      ([name, spec]) =>
        name !== "https_key" && spec && typeof spec === "object",
    ),
  );
}

// ---------- names ledger (names only, never values) ----------

export function ledgerPath(ctx) {
  return join(ctx.credentialsDir, `${ctx.config.account}.quay-secrets.json`);
}

export function readLedger(ctx) {
  const path = ledgerPath(ctx);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) ?? {};
  } catch {
    return {};
  }
}

export function recordNames(ctx, fn, names, hash) {
  const ledger = readLedger(ctx);
  if (names === null) delete ledger[fn];
  else
    ledger[fn] = {
      names: [...names].sort(),
      updated: new Date().toISOString(),
      transaction: hash ?? null,
    };
  mkdirSync(ctx.credentialsDir, { recursive: true });
  writeFileSync(ledgerPath(ctx), `${JSON.stringify(ledger, null, 2)}\n`, {
    mode: 0o600,
  });
}

// ---------- reading values ----------

function promptHidden(ctx, label) {
  const input = ctx.stdin;
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      ctx.stderr.write("\n");
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === "\u0003" || ch === "\u0004") {
          cleanup();
          reject(new QuayError("stopped", 1));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    ctx.stderr.write(`${label} (hidden): `);
    input.setRawMode?.(true);
    input.setEncoding?.("utf8");
    input.on("data", onData);
    input.resume();
  });
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read one value per name: a hidden prompt on a terminal, else stdin (the whole
 * input for one name, one line per name for several). Every value is added to
 * ctx.secrets so error output redacts it.
 */
export async function readSecretValues(ctx, names) {
  const values = {};
  if (ctx.readSecret) {
    for (const name of names) values[name] = await ctx.readSecret(name);
  } else if (ctx.stdin?.isTTY) {
    for (const name of names) values[name] = await promptHidden(ctx, name);
  } else {
    const text = await readAll(ctx.stdin);
    if (names.length === 1) {
      values[names[0]] = text.replace(/\r?\n$/, "");
    } else {
      const lines = text.split(/\r?\n/);
      if (lines.at(-1) === "") lines.pop();
      if (lines.length !== names.length)
        throw new QuayError(
          `stdin has ${lines.length} lines for ${names.length} names: pass one value per line, in the order of the names`,
          1,
        );
      names.forEach((name, i) => {
        values[name] = lines[i];
      });
    }
  }
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string" || value === "")
      throw new QuayError(`the value for ${name} is empty`, 1);
    ctx.secrets?.push(value);
  }
  return values;
}

// ---------- commands ----------

function targetsFor(ctx, names, flags) {
  if (typeof flags.fn === "string") return flags.fn.split(",").filter(Boolean);
  if (flags.fn === true) throw usage("quay: --fn needs a function name");
  const declared = declaredFunctions(ctx);
  const wanting = Object.entries(declared)
    .filter(([, spec]) =>
      (spec.secrets ?? []).some((name) => names.includes(name)),
    )
    .map(([name]) => name);
  if (wanting.length > 0) return wanting;
  const all = Object.keys(declared);
  if (all.length === 1) return all;
  throw usage(
    "quay: pass --fn <function>: no function in quay.json lists that secret",
  );
}

async function set(ctx, parsed) {
  owner(ctx);
  const names = parsed.rest.slice(1);
  if (names.length === 0)
    throw usage("quay: quay secrets set <NAME> [NAME...] [--fn <fn>]");
  for (const name of names) {
    if (name.includes("="))
      throw usage(
        "quay: secret values never go on the command line. Pass the name only; the value is read from stdin or a hidden prompt.",
      );
    if (!SECRET_NAME.test(name))
      throw usage(
        `quay: ${name} is not a secret name (A-Z, 0-9 and _, starting with a letter or _)`,
      );
  }
  if (new Set(names).size !== names.length)
    throw usage("quay: a name is given twice");
  const targets = targetsFor(ctx, names, parsed.flags);
  const ledger = readLedger(ctx);
  for (const fn of targets) {
    const dropped = (ledger[fn]?.names ?? []).filter((n) => !names.includes(n));
    if (dropped.length > 0 && !parsed.flags.replace)
      throw new QuayError(
        `${fn} also holds ${dropped.join(", ")}. OutLayer stores a function's secrets as one encrypted profile, so setting ${names.join(", ")} alone would drop them. Pass them together (quay secrets set ${[...dropped, ...names].join(" ")} --fn ${fn}) or add --replace.`,
        1,
      );
  }
  if (ctx.dryRun) {
    emit(
      ctx,
      { dry_run: true, functions: targets, names },
      `dry run: store ${names.join(", ")} for ${targets.join(", ")}`,
    );
    return;
  }
  const values = await readSecretValues(ctx, names);
  const outlayer = outlayerFor(ctx);
  const results = [];
  for (const fn of targets) {
    const sent = await outlayer.storeSecrets(fn, values, {
      site: ctx.config.account,
    });
    recordNames(ctx, fn, names, sent.hash);
    results.push({
      fn,
      project: outlayer.projectId(fn),
      names,
      transaction: sent.hash,
      transaction_url: sent.hash ? explorerUrl(sent.hash) : null,
    });
  }
  emit(
    ctx,
    { stored: results },
    results
      .map(
        (r) =>
          `stored ${r.names.join(", ")} for ${r.project}, encrypted on this machine\ntransaction ${r.transaction_url}`,
      )
      .join("\n"),
  );
}

async function list(ctx) {
  const outlayer = outlayerFor(ctx);
  const ledger = readLedger(ctx);
  const declared = declaredFunctions(ctx);
  let projects = [];
  try {
    projects = (await outlayer.listProjects()).map((p) => p.name);
  } catch {
    projects = [];
  }
  const fns = [
    ...new Set([...Object.keys(declared), ...Object.keys(ledger), ...projects]),
  ].sort();
  const rows = [];
  for (const fn of fns) {
    let row = null;
    try {
      row = await outlayer.secretsRow(fn);
    } catch {
      row = null;
    }
    const names = ledger[fn]?.names ?? [];
    const wanted = declared[fn]?.secrets ?? [];
    rows.push({
      fn,
      stored: Boolean(row),
      names,
      declared: wanted,
      missing: row ? wanted.filter((n) => !names.includes(n)) : wanted,
      updated: row?.updated_at
        ? new Date(Number(BigInt(row.updated_at) / 1_000_000n)).toISOString()
        : null,
    });
  }
  emit(
    ctx,
    { secrets: rows },
    rows.length === 0
      ? "no functions"
      : [
          table(
            rows.map((r) => ({
              ...r,
              stored: r.stored ? "yes" : "no",
              names: r.names.join(", ") || "-",
              missing: r.missing.join(", ") || "-",
            })),
            [
              { key: "fn", label: "FUNCTION" },
              { key: "stored", label: "STORED" },
              { key: "names", label: "NAMES" },
              { key: "missing", label: "MISSING" },
            ],
          ),
          "Names come from this machine's record and quay.json; values cannot be read back.",
        ].join("\n"),
  );
}

async function rm(ctx, parsed) {
  owner(ctx);
  const fns =
    typeof parsed.flags.fn === "string"
      ? parsed.flags.fn.split(",").filter(Boolean)
      : parsed.rest.slice(1);
  if (fns.length === 0) throw usage("quay: quay secrets rm --fn <function>");
  if (
    !(await confirm(
      ctx,
      `Remove every secret of ${fns.join(", ")}? Functions that need them will fail.`,
    ))
  )
    return stopped(ctx);
  const outlayer = outlayerFor(ctx);
  const removed = [];
  for (const fn of fns) {
    const sent = await outlayer.deleteSecrets(fn);
    recordNames(ctx, fn, null);
    removed.push({ fn, transaction: sent.hash });
  }
  emit(
    ctx,
    { removed },
    removed
      .map(
        (r) =>
          `removed the secrets of ${r.fn}\ntransaction ${explorerUrl(r.transaction)}`,
      )
      .join("\n"),
  );
}

export async function secretsCmd(ctx, parsed) {
  const sub = parsed.rest[0];
  if (!sub || parsed.flags.help) {
    writeOut(ctx, helpText("secrets"));
    if (!sub) throw new QuayError("quay secrets needs set, list, or rm", 1);
    return;
  }
  requireAccount(ctx.config);
  if (sub === "set") return set(ctx, parsed);
  if (sub === "list") return list(ctx, parsed);
  if (sub === "rm") return rm(ctx, parsed);
  throw new QuayError(`unknown secrets command ${sub}`, 1);
}
