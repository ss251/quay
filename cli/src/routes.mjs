import { QuayError } from "./errors.mjs";

export const MAX_ROUTES = 16;
const KINDS = ["doc", "list", "json"];
const ORDERS = ["asc", "desc"];
const KEYS = new Set([
  "pattern",
  "kind",
  "collection",
  "template",
  "limit",
  "order",
  "pinned_first",
  "content_type",
  "prefix",
]);
const COLLECTION = /^[a-z0-9-][a-z0-9_-]{0,31}$/;
const SEGMENT_NAME = /^[a-z0-9_]{1,32}$/;
const LITERAL = /^[A-Za-z0-9._-]+$/;
const PREFIX = /^[A-Za-z0-9_-]{1,64}$/;
const INCLUDE = /\{\{>\s*([^\s}]+)\s*\}\}/g;

function bad(index, message) {
  return new QuayError(`routes[${index}]: ${message}`, 1);
}

export function checkPattern(pattern, index = 0) {
  if (typeof pattern !== "string" || !pattern.startsWith("/")) {
    throw bad(index, "pattern must start with /");
  }
  if (pattern.length > 128) throw bad(index, "pattern is at most 128 bytes");
  const body = pattern.slice(1).replace(/\/$/, "");
  if (body === "") return [];
  const segments = body.split("/");
  const names = new Set();
  segments.forEach((segment, position) => {
    if (segment === "") throw bad(index, "pattern has an empty segment");
    if (segment.startsWith(":") || segment.startsWith("*")) {
      const name = segment.slice(1);
      if (!SEGMENT_NAME.test(name))
        throw bad(
          index,
          `bad parameter name in ${segment} (1 to 32 of a-z, 0-9, _)`,
        );
      if (names.has(name)) throw bad(index, `parameter ${name} is repeated`);
      names.add(name);
      if (segment.startsWith("*") && position !== segments.length - 1)
        throw bad(index, "a *rest segment must be last");
    } else {
      if (!LITERAL.test(segment) || segment === "." || segment === "..")
        throw bad(index, `bad literal segment ${segment}`);
      if (position === 0 && segment === "r")
        throw bad(index, "/r/ is reserved for previews");
    }
  });
  return [...names];
}

/**
 * Check routes from quay.json against the rules in section 4 and the folder's
 * files, then return them in the shape `seal` takes (only the fields set).
 * `files` is the list of release paths that are stored on chain, with `bytes`
 * so templates can be scanned for includes.
 */
export function validateRoutes(routes, files) {
  if (routes == null) return [];
  if (!Array.isArray(routes)) throw new QuayError("routes must be a list", 1);
  if (routes.length > MAX_ROUTES)
    throw new QuayError(`a release holds at most ${MAX_ROUTES} routes`, 1);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const out = [];
  routes.forEach((route, index) => {
    if (route === null || typeof route !== "object" || Array.isArray(route))
      throw bad(index, "must be an object");
    for (const key of Object.keys(route)) {
      if (!KEYS.has(key)) throw bad(index, `unknown key ${key}`);
    }
    const params = checkPattern(route.pattern, index);
    if (!KINDS.includes(route.kind))
      throw bad(index, `kind must be ${KINDS.join(", ")}`);
    const collection = route.collection;
    if (
      typeof collection !== "string" ||
      !(
        COLLECTION.test(collection) ||
        (collection === "*" && route.kind === "json")
      )
    ) {
      throw bad(
        index,
        route.kind === "json"
          ? 'collection must be a collection name or "*"'
          : "collection must be a collection name",
      );
    }
    const item = { pattern: route.pattern, kind: route.kind, collection };
    if (route.kind === "doc" && !params.includes("id"))
      throw bad(index, "a doc route needs an :id segment");
    if (route.kind === "json" && route.template !== undefined)
      throw bad(index, "a json route takes no template");
    if (
      route.kind === "json" &&
      !params.includes("collection") &&
      collection === "*"
    )
      throw bad(
        index,
        'collection "*" needs a :collection segment in the pattern',
      );
    if (route.kind !== "json") {
      if (typeof route.template !== "string" || route.template === "")
        throw bad(index, `a ${route.kind} route needs a template`);
      const template = byPath.get(route.template);
      if (!template)
        throw bad(
          index,
          `template ${route.template} is not in the site folder`,
        );
      if (template.external)
        throw bad(
          index,
          `template ${route.template} is stored off chain. Templates must be on chain.`,
        );
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(template.bytes);
      } catch {
        throw bad(index, `template ${route.template} is not UTF-8 text`);
      }
      item.template = route.template;
      checkIncludes(template, byPath, index, new Set([route.template]));
    }
    if (route.kind === "list") {
      if (route.limit !== undefined) {
        if (
          !Number.isInteger(route.limit) ||
          route.limit < 1 ||
          route.limit > 50
        )
          throw bad(index, "limit must be 1 to 50");
        item.limit = route.limit;
      }
      if (route.order !== undefined) {
        if (!ORDERS.includes(route.order))
          throw bad(index, "order must be asc or desc");
        item.order = route.order;
      }
      if (route.pinned_first !== undefined) {
        if (typeof route.pinned_first !== "boolean")
          throw bad(index, "pinned_first must be true or false");
        item.pinned_first = route.pinned_first;
      }
      if (route.prefix !== undefined) {
        if (typeof route.prefix !== "string" || !PREFIX.test(route.prefix))
          throw bad(index, "prefix must be 1 to 64 of A-Z, a-z, 0-9, _ -");
        item.prefix = route.prefix;
      }
    } else {
      for (const key of ["limit", "order", "pinned_first", "prefix"]) {
        if (route[key] !== undefined)
          throw bad(index, `${key} is for list routes`);
      }
    }
    if (route.content_type !== undefined) {
      if (typeof route.content_type !== "string" || route.content_type === "")
        throw bad(index, "content_type must be a string");
      item.content_type = route.content_type;
    }
    out.push(item);
  });
  return out;
}

function checkIncludes(file, byPath, index, seen, depth = 1) {
  if (!file.bytes) return;
  const text = Buffer.from(file.bytes).toString("utf8");
  for (const match of text.matchAll(INCLUDE)) {
    const path = match[1];
    const target = byPath.get(path);
    if (!target)
      throw bad(
        index,
        `${file.path} includes ${path}, which is not in the site folder`,
      );
    if (target.external)
      throw bad(index, `${path} is included but stored off chain`);
    if (depth >= 4)
      throw bad(index, `includes under ${file.path} nest deeper than 4`);
    if (seen.has(path)) throw bad(index, `${path} includes itself`);
    checkIncludes(target, byPath, index, new Set([...seen, path]), depth + 1);
  }
}
