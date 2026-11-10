import { createInterface } from "node:readline";

import { QuayError, refused } from "./errors.mjs";
import { emit, writeErr } from "./text.mjs";

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
