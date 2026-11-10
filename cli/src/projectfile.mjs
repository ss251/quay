import { readFileSync } from "node:fs";

import { buildJob } from "./cron.mjs";
import { checkCollection } from "./db.mjs";
import { QuayError } from "./errors.mjs";
import { buildProduct, checkProductId } from "./products.mjs";
import { STORES } from "./stores/index.mjs";

const TOP = new Set([
  "account",
  "network",
  "rpc",
  "gateway",
  "site",
  "files",
  "collections",
  "routes",
  "products",
  "payments",
  "members",
  "functions",
  "relay",
  "cron",
]);
const RULE_KEYS = new Set([
  "write",
  "payer",
  "max_doc_bytes",
  "moderated",
  "max_docs_per_account",
  "on_add",
]);
const PRODUCT_KEYS = new Set([
  "name",
  "price_yocto",
  "price_token",
  "grant",
  "pin_seconds",
]);

function bad(message) {
  return new QuayError(`quay.json: ${message}`, 1);
}

function section(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw bad(`${name} must be an object`);
  return value;
}

function strictKeys(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw bad(`unknown key ${where}${key}`);
  }
}

/** Read quay.json strictly. An unknown key is an error, so a typo does nothing silently. */
export function readProject(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw bad(`could not read ${path} as JSON`);
  }
  return parseProject(raw);
}

export function parseProject(raw) {
  section(raw, "the file");
  strictKeys(raw, TOP, "");
  const project = {
    site: null,
    files: { external_over: null, store: "nearfs" },
    collections: {},
    routes: [],
    products: {},
    members: null,
    token: undefined,
    relay: null,
    functions: {},
    cron: [],
  };
  if (raw.site !== undefined) {
    const site = section(raw.site, "site");
    strictKeys(site, new Set(["dir", "spa"]), "site.");
    if (
      site.dir !== undefined &&
      (typeof site.dir !== "string" || site.dir === "")
    )
      throw bad("site.dir must be a folder name");
    if (site.spa !== undefined && typeof site.spa !== "boolean")
      throw bad("site.spa must be true or false");
    project.site = { dir: site.dir ?? ".", spa: site.spa ?? false };
  }
  if (raw.files !== undefined) {
    const files = section(raw.files, "files");
    strictKeys(files, new Set(["external_over", "store"]), "files.");
    if (files.external_over !== undefined) {
      if (!Number.isInteger(files.external_over) || files.external_over < 1)
        throw bad("files.external_over must be a whole number of bytes");
      project.files.external_over = files.external_over;
    }
    if (files.store !== undefined) {
      if (!STORES.includes(files.store))
        throw bad(`files.store must be ${STORES.join(", ")}`);
      project.files.store = files.store;
    }
  }
  if (raw.collections !== undefined) {
    const collections = section(raw.collections, "collections");
    for (const [name, rules] of Object.entries(collections)) {
      checkCollection(name);
      project.collections[name] = normalizeRules(name, rules);
    }
    if (Object.keys(project.collections).length > 32)
      throw bad("a site holds at most 32 collections");
  }
  if (raw.routes !== undefined) {
    if (!Array.isArray(raw.routes)) throw bad("routes must be a list");
    project.routes = raw.routes;
  }
  const addProducts = (products, where) => {
    section(products, where);
    for (const [id, item] of Object.entries(products)) {
      checkProductId(id);
      if (project.products[id]) throw bad(`product ${id} is defined twice`);
      project.products[id] = normalizeProduct(id, item);
    }
  };
  if (raw.products !== undefined) addProducts(raw.products, "products");
  if (raw.payments !== undefined) {
    const payments = section(raw.payments, "payments");
    strictKeys(payments, new Set(["token", "products"]), "payments.");
    if (payments.token !== undefined) {
      if (
        payments.token !== null &&
        (typeof payments.token !== "string" ||
          !/^[a-z0-9._-]{2,64}$/.test(payments.token))
      )
        throw bad("payments.token must be a token account id or null");
      project.token = payments.token;
    }
    if (payments.products !== undefined)
      addProducts(payments.products, "payments.products");
  }
  if (Object.keys(project.products).length > 32)
    throw bad("a site holds at most 32 products");
  if (raw.members !== undefined) {
    const members = section(raw.members, "members");
    strictKeys(members, new Set(["open"]), "members.");
    if (members.open !== undefined) {
      if (typeof members.open !== "boolean")
        throw bad("members.open must be true or false");
      project.members = { open: members.open };
    }
  }
  if (raw.functions !== undefined) {
    project.functions = section(raw.functions, "functions");
  }
  if (raw.relay !== undefined) {
    const relay = section(raw.relay, "relay");
    if (relay.host !== undefined && !["node", "outlayer"].includes(relay.host))
      throw bad("relay.host must be node or outlayer");
    if (Object.keys(relay).length > 0) project.relay = relay;
  }
  if (raw.cron !== undefined) {
    if (!Array.isArray(raw.cron)) throw bad("cron must be a list");
    const names = new Set();
    project.cron = raw.cron.map((job, index) => {
      const where = `cron[${index}]`;
      section(job, where);
      strictKeys(
        job,
        new Set(["name", "every_minutes", "fn", "input"]),
        `${where}.`,
      );
      if (typeof job.name !== "string" || !/^[a-z0-9_-]{1,32}$/.test(job.name))
        throw bad(`${where}.name must be 1 to 32 of a-z, 0-9, _ -`);
      if (names.has(job.name))
        throw bad(`${where}.name ${job.name} is repeated`);
      names.add(job.name);
      if (!Number.isInteger(job.every_minutes) || job.every_minutes < 5)
        throw bad(`${where}.every_minutes must be a whole number from 5`);
      if (typeof job.fn !== "string" || !/^[a-z0-9_-]{1,32}$/.test(job.fn))
        throw bad(`${where}.fn must be a function name`);
      try {
        return {
          name: job.name,
          ...buildJob({
            every_minutes: job.every_minutes,
            fn: job.fn,
            input: job.input ?? {},
          }),
        };
      } catch (error) {
        throw bad(`${where}: ${error.message}`);
      }
    });
    if (project.cron.length > 8) throw bad("a site holds at most 8 cron jobs");
  }
  return project;
}

function normalizeRules(name, rules) {
  const where = `collections.${name}.`;
  section(rules, `collections.${name}`);
  strictKeys(rules, RULE_KEYS, where);
  const out = {
    write: rules.write ?? "owner",
    max_doc_bytes: rules.max_doc_bytes ?? 4096,
    moderated: rules.moderated ?? false,
    payer: rules.payer ?? "writer",
    max_docs_per_account: rules.max_docs_per_account ?? null,
    on_add: rules.on_add ?? null,
  };
  if (!["owner", "anyone", "members"].includes(out.write))
    throw bad(`${where}write must be owner, anyone or members`);
  if (!["writer", "site"].includes(out.payer))
    throw bad(`${where}payer must be writer or site`);
  if (
    !Number.isInteger(out.max_doc_bytes) ||
    out.max_doc_bytes < 1 ||
    out.max_doc_bytes > 16384
  )
    throw bad(`${where}max_doc_bytes must be 1 to 16384`);
  if (typeof out.moderated !== "boolean")
    throw bad(`${where}moderated must be true or false`);
  if (
    out.max_docs_per_account !== null &&
    (!Number.isInteger(out.max_docs_per_account) ||
      out.max_docs_per_account < 1)
  )
    throw bad(
      `${where}max_docs_per_account must be a whole number from 1, or null`,
    );
  if (
    out.on_add !== null &&
    (typeof out.on_add !== "string" || !/^[a-z0-9_-]{1,32}$/.test(out.on_add))
  )
    throw bad(`${where}on_add must be a function name or null`);
  return out;
}

function normalizeProduct(id, item) {
  section(item, `products.${id}`);
  strictKeys(item, PRODUCT_KEYS, `products.${id}.`);
  for (const key of ["price_yocto", "price_token"]) {
    const value = item[key];
    if (value !== undefined && value !== null && !/^\d+$/.test(String(value)))
      throw bad(`products.${id}.${key} must be a whole number as a string`);
  }
  try {
    return buildProduct({
      name: item.name,
      priceYocto: item.price_yocto ?? null,
      priceToken: item.price_token ?? null,
      grant: item.grant,
      pinSeconds: item.pin_seconds ?? null,
    });
  } catch (error) {
    throw bad(`products.${id}: ${error.message}`);
  }
}
