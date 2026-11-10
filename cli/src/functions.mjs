// `quay functions deploy|list|invoke|logs|rm|key`: server functions on OutLayer.
// A function is a Rust crate built for wasm32-wasip2 (see functions/quay-fn).
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { gatewayFor, requireAccount } from "./config.mjs";
import { QuayError, usage } from "./errors.mjs";
import { parsePaymentKey, resourceLimits } from "./outlayer.mjs";
import { readProject } from "./projectfile.mjs";
import {
  declaredFunctions,
  outlayerFor,
  readLedger,
  recordNames,
} from "./secrets.mjs";
import { confirm, explorerUrl, owner, stopped } from "./shared.mjs";
import {
  emit,
  formatBytes,
  helpText,
  table,
  writeErr,
  writeOut,
} from "./text.mjs";

export const DEFAULT_RUN_DEPOSIT = "5000000000000000000000"; // 0.005 NEAR
const FN_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SPEC_KEYS = new Set([
  "dir",
  "call",
  "payer",
  "secrets",
  "deposit",
  "max_instructions",
  "max_seconds",
  "store",
]);
const GAS_FN_CALL = 300_000_000_000_000n;

export function checkFunctionName(name) {
  if (!FN_NAME.test(String(name ?? "")))
    throw usage(
      `quay: ${name} is not a function name (1 to 32 of a-z, 0-9, _ and -)`,
    );
  return name;
}

/** Validate one quay.json functions entry and fill the defaults. */
export function normalizeSpec(name, raw = {}) {
  checkFunctionName(name);
  for (const key of Object.keys(raw))
    if (!SPEC_KEYS.has(key))
      throw new QuayError(`functions.${name} has an unknown key ${key}`, 1);
  const call = raw.call ?? "anyone";
  const payer = raw.payer ?? "caller";
  if (!["owner", "anyone", "members"].includes(call))
    throw new QuayError(
      `functions.${name}.call must be owner, anyone or members`,
      1,
    );
  if (!["caller", "site"].includes(payer))
    throw new QuayError(`functions.${name}.payer must be caller or site`, 1);
  const secrets = raw.secrets ?? [];
  if (!Array.isArray(secrets) || secrets.some((s) => typeof s !== "string"))
    throw new QuayError(`functions.${name}.secrets must be a list of names`, 1);
  const store = raw.store ?? "fastfs";
  if (!["fastfs", "release"].includes(store))
    throw new QuayError(`functions.${name}.store must be fastfs or release`, 1);
  return {
    dir: raw.dir ?? `functions/${name}`,
    call,
    payer,
    secrets,
    store,
    deposit: String(raw.deposit ?? DEFAULT_RUN_DEPOSIT),
    max_instructions: String(raw.max_instructions ?? "2000000000"),
    max_seconds: Number(raw.max_seconds ?? 30),
  };
}

/** The contract registry entry (FunctionSpec, section 3). */
export function contractSpec(project, spec) {
  return {
    project,
    call: spec.call,
    payer: spec.payer,
    deposit: spec.deposit,
    max_instructions: spec.max_instructions,
    max_seconds: spec.max_seconds,
    secrets: spec.secrets.length > 0,
  };
}

/** Does the site contract have the function registry (v3 fn_set)? */
export async function contractHasFunctions(ctx) {
  if (ctx.fnSupport !== undefined) return ctx.fnSupport;
  try {
    const list = await ctx.chain.view("fn_list", {});
    ctx.fnSupport = Array.isArray(list) || (list && typeof list === "object");
  } catch {
    ctx.fnSupport = false;
  }
  return ctx.fnSupport;
}

/** `cargo build --release --target wasm32-wasip2` in `dir`; returns the wasm bytes and path. */
export async function buildFunction(ctx, dir) {
  if (ctx.buildFunction) return ctx.buildFunction(dir);
  if (!existsSync(join(dir, "Cargo.toml")))
    throw new QuayError(`${dir} has no Cargo.toml`, 1);
  const cargo = (ctx.env?.QUAY_CARGO ?? process.env.QUAY_CARGO ?? "cargo")
    .split(/\s+/)
    .filter(Boolean);
  const args = [
    ...cargo.slice(1),
    "build",
    "--release",
    "--target",
    "wasm32-wasip2",
    "--message-format=json-render-diagnostics",
  ];
  const manifest = resolve(dir, "Cargo.toml");
  const lines = await new Promise((done, fail) => {
    const child = spawn(cargo[0], args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", (error) =>
      fail(new QuayError(`could not run ${cargo[0]}: ${error.message}`, 1)),
    );
    child.on("close", (code) =>
      code === 0
        ? done(out.split("\n"))
        : fail(
            new QuayError(
              `the build failed in ${dir}. Is the target installed? rustup target add wasm32-wasip2`,
              1,
            ),
          ),
    );
  });
  const wasm = [];
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.reason !== "compiler-artifact") continue;
    if (!msg.target?.kind?.includes("bin")) continue;
    for (const file of msg.filenames ?? [])
      if (file.endsWith(".wasm"))
        wasm.push({ file, own: msg.manifest_path === manifest });
  }
  const pick = wasm.find((w) => w.own) ?? wasm.at(-1);
  if (!pick) throw new QuayError(`the build in ${dir} made no .wasm binary`, 1);
  return { path: pick.file, bytes: new Uint8Array(readFileSync(pick.file)) };
}

function projectRoot(ctx) {
  return ctx.config.path ? dirname(ctx.config.path) : ctx.cwd;
}

/** One function: build, upload, register on OutLayer, fn_set when the contract can. */
export async function deployOne(ctx, name, spec, { secretsCheck = true } = {}) {
  owner(ctx);
  const dir = resolve(projectRoot(ctx), spec.dir);
  const built = await buildFunction(ctx, dir);
  const outlayer = outlayerFor(ctx);
  let upload;
  if (spec.store === "release") {
    const project = ctx.config.path ? readProject(ctx.config.path) : null;
    const siteDir = resolve(projectRoot(ctx), project?.site?.dir ?? ".");
    const target = join(siteDir, "fn", `${name}.wasm`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(built.path, target);
    const { sha256Hex } = await import("./outlayer.mjs");
    upload = {
      sha256: sha256Hex(built.bytes),
      url: `${gatewayFor(ctx.config.account)}/fn/${name}.wasm`,
      size: built.bytes.length,
      hash: null,
      pending_release: target,
    };
  } else {
    upload = await outlayer.upload(built.bytes);
  }
  const project = await outlayer.deployProject(name, upload);
  let registered = "pending";
  let fnHash = null;
  if (await contractHasFunctions(ctx)) {
    const sent = await ctx.chain.send(
      "fn_set",
      { name, spec: contractSpec(project.project, spec) },
      { deposit: 1n },
    );
    registered = true;
    fnHash = sent.hash;
  }
  let missing = [];
  if (secretsCheck && spec.secrets.length > 0) {
    const have = readLedger(ctx)[name]?.names ?? [];
    let row = null;
    try {
      row = await outlayer.secretsRow(name);
    } catch {
      row = null;
    }
    missing = row
      ? spec.secrets.filter((n) => !have.includes(n))
      : spec.secrets;
  }
  return {
    name,
    project: project.project,
    wasm_url: upload.url,
    sha256: upload.sha256,
    size: upload.size,
    hash: project.hash ?? upload.hash ?? null,
    upload_transaction: upload.hash ?? null,
    project_transaction: project.hash ?? null,
    unchanged: Boolean(project.unchanged),
    registered,
    fn_set_transaction: fnHash,
    missing_secrets: missing,
    pending_release: upload.pending_release ?? null,
  };
}

function reportLines(r) {
  const lines = [
    `${r.name}  ${r.project}  ${formatBytes(r.size)}  sha256 ${r.sha256.slice(0, 12)}`,
    `  wasm ${r.wasm_url}`,
  ];
  if (r.upload_transaction)
    lines.push(`  upload ${explorerUrl(r.upload_transaction)}`);
  if (r.project_transaction)
    lines.push(`  project ${explorerUrl(r.project_transaction)}`);
  if (r.unchanged) lines.push("  project already runs this build");
  if (r.registered === true)
    lines.push(`  fn_set ${explorerUrl(r.fn_set_transaction)}`);
  else
    lines.push(
      "  contract registry: pending (this site contract has no fn_set yet); HTTPS calls work now",
    );
  if (r.pending_release)
    lines.push(
      `  wrote ${r.pending_release}: run quay deploy and promote before the first call`,
    );
  if (r.missing_secrets.length)
    lines.push(
      `  missing secrets: ${r.missing_secrets.join(", ")}. Run quay secrets set ${r.missing_secrets.join(" ")} --fn ${r.name}`,
    );
  return lines;
}

/** Called by `quay up` with quay.json → functions. */
export async function deployFunctions(ctx, functions) {
  const results = [];
  for (const [name, raw] of Object.entries(functions ?? {})) {
    if (name === "https_key") continue;
    const result = await deployOne(ctx, name, normalizeSpec(name, raw));
    if (!ctx.json) for (const line of reportLines(result)) writeErr(ctx, line);
    results.push(result);
  }
  return results;
}

async function deploy(ctx, parsed) {
  const target = parsed.rest[1];
  if (!target) throw usage("quay: quay functions deploy <dir|name>");
  const declared = declaredFunctions(ctx);
  let name;
  let raw;
  if (declared[target]) {
    name = target;
    raw = { ...declared[target] };
  } else {
    const dir = resolve(ctx.cwd, target);
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      throw usage(
        `quay: ${target} is neither a function in quay.json nor a folder`,
      );
    name =
      typeof parsed.flags.name === "string" ? parsed.flags.name : basename(dir);
    raw = { ...(declared[name] ?? {}), dir };
  }
  if (typeof parsed.flags.store === "string") raw.store = parsed.flags.store;
  const spec = normalizeSpec(name, raw);
  if (ctx.dryRun) {
    emit(
      ctx,
      { dry_run: true, name, spec },
      `dry run: build ${spec.dir}, upload to ${spec.store}, register ${ctx.config.account}/${name}`,
    );
    return;
  }
  const result = await deployOne(ctx, name, spec);
  emit(ctx, result, reportLines(result).join("\n"));
}

// ---------- payment keys ----------

export function paymentKeyFiles(ctx) {
  const prefix = `${ctx.config.account}.paykey-`;
  if (!existsSync(ctx.credentialsDir)) return [];
  return readdirSync(ctx.credentialsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(ctx.credentialsDir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((k) => k && typeof k.key === "string")
    .sort((a, b) => b.nonce - a.nonce);
}

/** A payment key that may pay for `projectId`: QUAY_PAYMENT_KEY, else the newest saved key in scope. */
export function paymentKeyFor(ctx, projectId) {
  const fromEnv = ctx.env?.QUAY_PAYMENT_KEY ?? process.env.QUAY_PAYMENT_KEY;
  const text =
    fromEnv ??
    paymentKeyFiles(ctx).find(
      (k) => !k.projects?.length || k.projects.includes(projectId),
    )?.key;
  if (!text)
    throw new QuayError(
      `no payment key for ${projectId}. Run quay functions key, or set QUAY_PAYMENT_KEY.`,
      1,
    );
  ctx.secrets?.push(text);
  return parsePaymentKey(text).text;
}

function usdToMinimal(text, label) {
  const raw = String(text ?? "").trim();
  if (!/^\d+(\.\d{1,6})?$/.test(raw))
    throw usage(`quay: ${label} must be a dollar amount such as 0.05`);
  const [whole, frac = ""] = raw.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

async function key(ctx, parsed) {
  owner(ctx);
  const outlayer = outlayerFor(ctx);
  const flags = parsed.flags;
  let projects;
  if (typeof flags.projects === "string") {
    projects = flags.projects
      .split(",")
      .filter(Boolean)
      .map((p) => (p.includes("/") ? p : outlayer.projectId(p)));
  } else {
    projects = (await outlayer.listProjects()).map((p) => p.project_id);
    if (projects.length === 0)
      throw new QuayError(
        "no functions yet. Deploy one, or pass --projects",
        1,
      );
  }
  const usd = usdToMinimal(
    flags.usd === undefined ? "0.05" : flags.usd,
    "--usd",
  );
  const perCall = usdToMinimal(
    flags["max-per-call"] === undefined ? "0.01" : flags["max-per-call"],
    "--max-per-call",
  );
  if (usd <= 0n) throw usage("quay: --usd must be more than 0");
  if (ctx.dryRun) {
    emit(
      ctx,
      { dry_run: true, projects, usd: usd.toString() },
      `dry run: payment key for ${projects.join(", ")} with $${flags.usd ?? "0.05"}`,
    );
    return;
  }
  if (
    !(await confirm(
      ctx,
      `Create a payment key for ${projects.join(", ")} and fund it with $${flags.usd ?? "0.05"} of test USDC?`,
    ))
  )
    return stopped(ctx);
  let file = null;
  const made = await outlayer.createPaymentKey({
    projects,
    maxPerCall: perCall.toString(),
    save: async (keyText, nonce) => {
      ctx.secrets?.push(keyText);
      mkdirSync(ctx.credentialsDir, { recursive: true });
      file = join(
        ctx.credentialsDir,
        `${ctx.config.account}.paykey-${nonce}.json`,
      );
      writeFileSync(
        file,
        `${JSON.stringify({ owner: ctx.config.account, nonce, key: keyText, projects, created: new Date().toISOString() }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
    },
  });
  const top = await outlayer.topUp(made.nonce, usd);
  emit(
    ctx,
    {
      owner: ctx.config.account,
      nonce: made.nonce,
      projects,
      max_per_call: perCall.toString(),
      usd: usd.toString(),
      key_file: file,
      transaction: made.hash,
      top_up_transaction: top.hash,
    },
    [
      `payment key ${ctx.config.account}:${made.nonce} for ${projects.join(", ")}`,
      `saved to ${file} (owner-only); the key is not printed`,
      `funded with $${flags.usd ?? "0.05"} test USDC, at most $${flags["max-per-call"] ?? "0.01"} per call`,
      `transaction ${explorerUrl(made.hash)}`,
      `top-up ${explorerUrl(top.hash)}`,
      "Anyone who reads a payment key can spend it. Publish only a key scoped to these functions with a small balance.",
    ].join("\n"),
  );
}

// ---------- list, invoke, logs, rm ----------

async function list(ctx) {
  const outlayer = outlayerFor(ctx);
  const [projects, hasFns] = await Promise.all([
    outlayer.listProjects(),
    contractHasFunctions(ctx),
  ]);
  const registry = hasFns ? ((await ctx.chain.view("fn_list", {})) ?? []) : [];
  const declared = declaredFunctions(ctx);
  const names = [
    ...new Set([...projects.map((p) => p.name), ...Object.keys(declared)]),
  ].sort();
  const regName = (r) => (Array.isArray(r) ? r[0] : (r?.name ?? null));
  const rows = names.map((name) => {
    const p = projects.find((x) => x.name === name);
    return {
      name,
      project: p?.project_id ?? null,
      version: p?.active_version ?? null,
      declared: Boolean(declared[name]),
      registered: hasFns
        ? registry.some((r) => regName(r) === name)
        : "pending",
    };
  });
  emit(
    ctx,
    { functions: rows, contract_registry: hasFns },
    rows.length === 0
      ? "no functions"
      : [
          table(
            rows.map((r) => ({
              ...r,
              project: r.project ?? "not deployed",
              version: r.version ? r.version.slice(0, 12) : "-",
              registered:
                r.registered === "pending"
                  ? "pending"
                  : r.registered
                    ? "yes"
                    : "no",
            })),
            [
              { key: "name", label: "NAME" },
              { key: "project", label: "OUTLAYER PROJECT" },
              { key: "version", label: "SHA256" },
              { key: "registered", label: "CONTRACT" },
            ],
          ),
          hasFns
            ? null
            : "The site contract has no fn_set yet: functions run over HTTPS with a payment key.",
        ]
          .filter(Boolean)
          .join("\n"),
  );
}

function parseInput(text, cwd) {
  if (text === undefined) return {};
  let raw = String(text);
  if (raw.startsWith("@"))
    raw = readFileSync(resolve(cwd, raw.slice(1)), "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw usage("quay: the input must be JSON, or @file.json");
  }
}

async function invoke(ctx, parsed) {
  const name = checkFunctionName(parsed.rest[1]);
  const input = parseInput(parsed.rest[2], ctx.cwd);
  const outlayer = outlayerFor(ctx);
  const text = JSON.stringify(input);
  const viaContract = !parsed.flags.https && (await contractHasFunctions(ctx));
  if (viaContract) {
    if (text.length > 4096)
      throw usage("quay: fn_call input is at most 4096 bytes");
    const spec = await ctx.chain.view("fn_get", { name });
    if (!spec)
      throw new QuayError(`${name} is not registered on the contract`, 1);
    const deposit =
      spec.payer === "caller"
        ? BigInt(spec.deposit ?? DEFAULT_RUN_DEPOSIT)
        : 0n;
    const sent = await ctx.chain.send(
      "fn_call",
      { name, input: text },
      { deposit, gas: GAS_FN_CALL },
    );
    let output = sent.value;
    if (typeof output === "string") {
      try {
        output = JSON.parse(output);
      } catch {}
    }
    const attestation = `${outlayer.api}/attestations/by-tx/${sent.hash}`;
    emit(
      ctx,
      {
        mode: "contract",
        name,
        output,
        transaction: sent.hash,
        transaction_url: explorerUrl(sent.hash),
        attestation_url: attestation,
      },
      [
        JSON.stringify(output, null, 2),
        `transaction ${explorerUrl(sent.hash)}`,
        `attestation ${attestation}`,
      ].join("\n"),
    );
    return;
  }
  const project = outlayer.projectId(name);
  const paymentKey = paymentKeyFor(ctx, project);
  // Name the secret row only when one exists.
  let secrets = false;
  try {
    secrets = Boolean(await outlayer.secretsRow(name));
  } catch {
    secrets = false;
  }
  const res = await outlayer.callHttps(name, input, { paymentKey, secrets });
  const attestation = res?.attestation_url
    ? `${outlayer.api}${res.attestation_url}`
    : null;
  emit(
    ctx,
    {
      mode: "https",
      name,
      call_id: res?.call_id ?? null,
      status: res?.status ?? null,
      output: res?.output ?? null,
      compute_cost: res?.compute_cost ?? null,
      time_ms: res?.time_ms ?? null,
      attestation_url: attestation,
    },
    [
      JSON.stringify(res?.output ?? null, null, 2),
      `call ${res?.call_id ?? "?"} over HTTPS, ${res?.time_ms ?? "?"} ms, cost ${res?.compute_cost ?? "?"} (USDC 6-decimal units)`,
      attestation ? `attestation ${attestation}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function logs(ctx, parsed) {
  const name = checkFunctionName(parsed.rest[1]);
  const outlayer = outlayerFor(ctx);
  const project = outlayer.projectId(name);
  let results = null;
  if (await contractHasFunctions(ctx)) {
    const page = await ctx.chain.view("fn_results", {
      query: { prefix: `${name}-`, limit: 10, order: "desc" },
    });
    results = page?.docs ?? [];
  }
  const usage = [];
  for (const k of paymentKeyFiles(ctx)) {
    if (k.projects?.length && !k.projects.includes(project)) continue;
    try {
      usage.push({
        nonce: k.nonce,
        usage: await outlayer.usage(k.owner, k.nonce),
      });
    } catch (error) {
      usage.push({ nonce: k.nonce, error: error.message });
    }
  }
  const lines = [];
  if (results === null)
    lines.push(
      "contract results: pending (this site contract has no fn_results yet)",
    );
  else if (results.length === 0) lines.push("no contract results yet");
  else
    for (const doc of results)
      lines.push(
        `${doc.id}  ${doc.data?.ok === false ? "failed" : "ok"}  ${JSON.stringify(doc.data?.output ?? doc.data).slice(0, 160)}`,
      );
  for (const u of usage)
    lines.push(
      u.error
        ? `payment key ${u.nonce}: ${u.error}`
        : `payment key ${u.nonce} usage: ${JSON.stringify(u.usage).slice(0, 600)}`,
    );
  if (usage.length === 0)
    lines.push("no saved payment key in scope (quay functions key)");
  emit(ctx, { name, project, results, usage }, lines.join("\n"));
}

async function rm(ctx, parsed) {
  owner(ctx);
  const name = checkFunctionName(parsed.rest[1]);
  const outlayer = outlayerFor(ctx);
  if (
    !(await confirm(
      ctx,
      `Remove ${name}: its contract entry, OutLayer project and secrets?`,
    ))
  )
    return stopped(ctx);
  const done = [];
  if (await contractHasFunctions(ctx)) {
    const sent = await ctx.chain.send("fn_remove", { name }, { deposit: 1n });
    done.push(["fn_remove", sent.hash]);
  }
  let row = null;
  try {
    row = await outlayer.secretsRow(name);
  } catch {
    row = null;
  }
  if (row) done.push(["secrets", (await outlayer.deleteSecrets(name)).hash]);
  recordNames(ctx, name, null);
  if (await outlayer.getProject(name))
    done.push(["project", (await outlayer.deleteProject(name)).hash]);
  emit(
    ctx,
    { removed: name, transactions: Object.fromEntries(done) },
    [
      `removed ${name}`,
      ...done.map(([what, hash]) => `${what} ${explorerUrl(hash)}`),
    ].join("\n"),
  );
}

export async function functionsCmd(ctx, parsed) {
  const sub = parsed.rest[0];
  if (!sub || parsed.flags.help) {
    writeOut(ctx, helpText("functions"));
    if (!sub) throw new QuayError("quay functions needs a subcommand", 1);
    return;
  }
  requireAccount(ctx.config);
  if (sub === "deploy") return deploy(ctx, parsed);
  if (sub === "list") return list(ctx, parsed);
  if (sub === "invoke") return invoke(ctx, parsed);
  if (sub === "logs") return logs(ctx, parsed);
  if (sub === "rm") return rm(ctx, parsed);
  if (sub === "key") return key(ctx, parsed);
  throw new QuayError(`unknown functions command ${sub}`, 1);
}

export { resourceLimits };
