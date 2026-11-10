import { createInterface } from "node:readline";

import { QuayError, refused } from "./errors.mjs";
import { emit, writeErr } from "./text.mjs";

export function previewUrl(gateway, id) {
  const base = String(gateway).replace(/\/$/, "");
  return id ? `${base}/r/${id}/` : `${base}/`;
}

export function explorerUrl(hash) {
  return `https://explorer.testnet.near.org/transactions/${hash}`;
}

/** The signer must be the full-access owner key. */
export function owner(ctx) {
  if (ctx.signer?.limited) throw refused("a publish-only key cannot do that");
  if (!ctx.signer?.secret)
    throw new QuayError("no signing key for this account", 1);
}

export async function confirm(ctx, question) {
  if (ctx.dryRun) return false;
  if (ctx.yes || !ctx.isTTY) return true;
  writeErr(ctx, `${question} [y/N]`);
  const lines = createInterface({ input: ctx.stdin, output: ctx.stderr });
  const answer = await new Promise((done) => {
    lines.once("line", (line) => {
      lines.close();
      done(line);
    });
  });
  return /^y(es)?$/i.test(String(answer).trim());
}

export function stopped(ctx) {
  emit(ctx, { stopped: true }, "stopped before spending");
}

export async function waitForGateway(ctx, url) {
  const probe = ctx.probe ?? probeGateway;
  const timeoutMs = ctx.gatewayTimeoutMs ?? 120_000;
  const intervalMs = ctx.gatewayIntervalMs ?? 3_000;
  const started = Date.now();
  let announced = false;
  let last = "no response";
  for (;;) {
    try {
      const status = await probe(url);
      if (typeof status === "number" && status >= 100 && status < 600) {
        return status;
      }
      last = `HTTP ${status}`;
    } catch (error) {
      const cause = error?.cause;
      last = cause?.code || cause?.message || error?.message || String(error);
    }
    if (Date.now() - started >= timeoutMs) {
      throw new QuayError(
        `the gateway at ${url} did not answer within 2 minutes (${last}). The certificate is issued on the first request. Open the URL again in a minute.`,
        2,
      );
    }
    if (!announced) {
      writeErr(
        ctx,
        "waiting for the gateway certificate, usually under 2 minutes",
      );
      announced = true;
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}

async function probeGateway(url) {
  const response = await fetch(url, { redirect: "manual" });
  return response.status;
}

/** Printed by quay up and quay rollback: what a rollback does not restore. */
export const VERSIONED_NOTE = [
  "versioned per release: files, routes and templates (rollback restores all three)",
  "live state, not versioned: docs, collection rules, products, members, function code and secrets, relay and cron settings",
].join("\n");
