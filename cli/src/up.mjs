import { dirname, resolve } from "node:path";

import { requireAccount } from "./config.mjs";
import { QuayError } from "./errors.mjs";
import { allReleases, deployRelease, splitFiles } from "./release.mjs";
import { parseProject, readProject } from "./projectfile.mjs";
import { validateRoutes } from "./routes.mjs";
import {
  confirm,
  explorerUrl,
  owner,
  previewUrl,
  stopped,
  VERSIONED_NOTE,
  waitForGateway,
} from "./shared.mjs";
import { collectSite } from "./site.mjs";
import { emit, writeErr, writeOut } from "./text.mjs";
import { parseCount } from "./units.mjs";

const PAST = { create: "created", update: "updated" };

function sameRules(wanted, have) {
  return (
    have &&
    have.write === wanted.write &&
    have.payer === wanted.payer &&
    have.max_doc_bytes === wanted.max_doc_bytes &&
    Boolean(have.moderated) === wanted.moderated &&
    (have.max_docs_per_account ?? null) === wanted.max_docs_per_account &&
    (have.on_add ?? null) === wanted.on_add
  );
}

function sameProduct(wanted, have) {
  return (
    have &&
    have.name === wanted.name &&
    String(have.price_yocto ?? "") === String(wanted.price_yocto ?? "") &&
    String(have.price_token ?? "") === String(wanted.price_token ?? "") &&
    have.grant === wanted.grant &&
    (have.pin_seconds ?? null) === (wanted.pin_seconds ?? null)
  );
}

function ruleChanges(wanted, have) {
  return Object.keys(wanted)
    .filter((key) => (have?.[key] ?? null) !== wanted[key])
    .map((key) => `${key} ${have?.[key] ?? "unset"} -> ${wanted[key]}`)
    .join(", ");
}

/** Work out the steps without sending anything. Validates the folder and routes. */
export async function planUp(ctx, project, options) {
  const steps = [];
  const [existingCollections, existingProducts, open] = await Promise.all([
    ctx.chain.view("list_collections", {}),
    ctx.chain.view("list_products", {}),
    ctx.chain.view("get_members_open", {}),
  ]);
  const haveCollections = new Map(
    (existingCollections ?? []).map((view) => [view.name, view]),
  );
  const haveProducts = new Map(
    (existingProducts ?? []).map((view) => [view.id, view]),
  );
  for (const [name, rules] of Object.entries(project.collections)) {
    const have = haveCollections.get(name);
    if (!have)
      steps.push({ step: "collection", name, action: "create", rules });
    else if (!sameRules(rules, have))
      steps.push({
        step: "collection",
        name,
        action: "update",
        detail: ruleChanges(rules, have),
        rules,
      });
    else steps.push({ step: "collection", name, action: "unchanged" });
  }
  for (const [id, product] of Object.entries(project.products)) {
    const have = haveProducts.get(id);
    if (!have)
      steps.push({ step: "product", name: id, action: "create", product });
    else if (!sameProduct(product, have))
      steps.push({ step: "product", name: id, action: "update", product });
    else steps.push({ step: "product", name: id, action: "unchanged" });
  }
  if (project.members) {
    steps.push({
      step: "members",
      name: project.members.open ? "open" : "closed",
      action: Boolean(open) === project.members.open ? "unchanged" : "update",
      open: project.members.open,
    });
  }
  const files = collectSite(options.dir);
  const { onChain, external } = splitFiles(files, options.externalOver);
  const routes = validateRoutes(
    project.routes,
    files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      external: external.includes(file),
    })),
  );
  steps.push({
    step: "deploy",
    name: options.label,
    action: "create release",
    files: files.length,
    on_chain: onChain.length,
    external: external.length,
    store: external.length > 0 ? options.store : null,
    routes: routes.length,
  });
  steps.push({ step: "promote", name: "the new release", action: "promote" });
  return steps;
}

function describe(step) {
  if (step.step === "deploy") {
    const parts = [`${step.files} files`];
    if (step.external) parts.push(`${step.external} large to ${step.store}`);
    if (step.routes) parts.push(`${step.routes} routes`);
    return `deploy ${step.name}  ${parts.join(", ")}`;
  }
  if (step.step === "promote") return "promote  the new release to production";
  const label = `${step.step} ${step.name}`;
  if (step.action === "unchanged") return `${label}  unchanged`;
  return `${label}  ${step.action}${step.detail ? `  (${step.detail})` : ""}`;
}

export async function up(ctx, parsed) {
  const account = requireAccount(ctx.config);
  if (!ctx.config.path)
    throw new QuayError("quay up reads quay.json. Run quay init first.", 1);
  const project = readProject(ctx.config.path);
  if (!project.site)
    throw new QuayError("quay.json needs site.dir for quay up to deploy", 1);
  const flags = parsed.flags;
  const options = {
    dir: resolve(dirname(ctx.config.path), project.site.dir),
    label: project.site.dir,
    spa: project.site.spa || Boolean(ctx.spa),
    message: flags.message ? String(flags.message) : "",
    id: flags.id,
    routes: project.routes,
    externalOver:
      flags["external-over"] !== undefined
        ? parseCount(flags["external-over"], "--external-over", { min: 1 })
        : project.files.external_over,
    store: flags.store ? String(flags.store) : project.files.store,
    verify: !flags["no-verify"],
    verifyTimeoutMs:
      flags["verify-wait"] !== undefined
        ? parseCount(flags["verify-wait"], "--verify-wait", { min: 0 }) * 1000
        : undefined,
  };
  if (!ctx.dryRun) owner(ctx);
  const steps = await planUp(ctx, project, options);
  const changes = steps.filter((step) => step.action !== "unchanged");
  if (project.pending.length > 0)
    writeErr(
      ctx,
      `note: ${project.pending.join(", ")} in quay.json is not applied yet. Those sections are pending.`,
    );
  const plain = [
    `plan for ${account}`,
    ...steps.map((step) => `  ${describe(step)}`),
  ];
  if (ctx.dryRun) {
    emit(
      ctx,
      {
        account,
        dry_run: true,
        steps: steps.map(publicStep),
        versioned: VERSIONED_NOTE.split("\n"),
      },
      [...plain, "dry run, nothing was sent", VERSIONED_NOTE].join("\n"),
    );
    return;
  }
  if (!ctx.json) writeErr(ctx, plain.join("\n"));
  const ok = await confirm(ctx, `Apply ${changes.length} steps to ${account}?`);
  if (!ok) return stopped(ctx);

  const done = [];
  const log = (record, line) => {
    done.push(record);
    if (!ctx.json) writeOut(ctx, line);
  };
  for (const step of steps) {
    if (
      step.action === "unchanged" ||
      step.step === "deploy" ||
      step.step === "promote"
    )
      continue;
    const [method, args] =
      step.step === "collection"
        ? ["set_collection", { name: step.name, rules: step.rules }]
        : step.step === "product"
          ? ["set_product", { id: step.name, product: step.product }]
          : ["set_members_open", { open: step.open }];
    const sent = await ctx.chain.send(method, args, { deposit: 1n });
    log(
      {
        step: step.step,
        name: step.name,
        action: step.action,
        transaction: sent.hash,
        transaction_url: explorerUrl(sent.hash),
      },
      `${step.step} ${step.name}  ${PAST[step.action] ?? step.action}  ${explorerUrl(sent.hash)}`,
    );
  }
  const deployCtx = { ...ctx, yes: true, isTTY: false };
  const released = await deployRelease(deployCtx, options);
  if (released.stopped) return;
  const previewLine = `release ${released.id}  ${released.summary.url}  ${explorerUrl(released.sealed.hash)}`;
  log(
    {
      step: "deploy",
      release: released.id,
      url: released.summary.url,
      transaction: released.sealed.hash,
      transaction_url: explorerUrl(released.sealed.hash),
      external: released.sealedExternals.map((item) => ({
        path: item.file.path,
        cid: item.cid,
        sha256: item.sha256,
      })),
      routes: released.routes.length,
    },
    previewLine,
  );
  const releaseCount = (await allReleases(ctx.chain)).length;
  const promoted = await ctx.chain.promote(released.id);
  const url = previewUrl(ctx.config.gateway);
  log(
    {
      step: "promote",
      release: released.id,
      url,
      transaction: promoted.hash,
      transaction_url: explorerUrl(promoted.hash),
    },
    `production ${released.id}  ${url}  ${explorerUrl(promoted.hash)}`,
  );
  if (ctx.json) {
    writeOut(
      ctx,
      JSON.stringify({
        account,
        release: released.id,
        url,
        steps: done,
        versioned: VERSIONED_NOTE.split("\n"),
      }),
    );
  } else {
    writeOut(ctx, VERSIONED_NOTE);
  }
  if (releaseCount <= 1) await waitForGateway(ctx, url);
}

function publicStep(step) {
  const copy = { ...step };
  delete copy.rules;
  delete copy.product;
  return copy;
}

export { parseProject };
