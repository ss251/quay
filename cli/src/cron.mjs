import { teraToGas } from "near-api-js";

import { requireAccount } from "./config.mjs";
import { sendCall } from "./db.mjs";
import { QuayError } from "./errors.mjs";
import { confirm, explorerUrl, owner, stopped } from "./shared.mjs";
import {
  emit,
  formatNear,
  formatTime,
  helpText,
  table,
  writeOut,
} from "./text.mjs";

export const ARM_GAS = teraToGas("1000");
export const MIN_LIQUID_YOCTO = 11n * 10n ** 23n;
const BYTE_COST = 10n ** 19n;
export const MIN_MINUTES = 5;
export const MAX_JOBS = 8;
export const MAX_INPUT_BYTES = 4096;
const NAME = /^[a-z0-9_-]{1,32}$/;

/** "every 30m", "30m", "every 2h" -> minutes. */
export function parseEvery(text) {
  const match = /^(?:every\s+)?(\d+)\s*([mh])$/i.exec(
    String(text ?? "").trim(),
  );
  if (!match)
    throw new QuayError('the schedule is like "every 30m" or "every 2h"', 1);
  const minutes = Number(match[1]) * (match[2].toLowerCase() === "h" ? 60 : 1);
  if (minutes < MIN_MINUTES)
    throw new QuayError(`a job runs at most every ${MIN_MINUTES} minutes`, 1);
  return minutes;
}

/** The job the contract takes. `input` is JSON text. */
export function buildJob({ every_minutes, fn, input }) {
  if (!Number.isInteger(every_minutes) || every_minutes < MIN_MINUTES)
    throw new QuayError(`every_minutes must be ${MIN_MINUTES} or more`, 1);
  if (typeof fn !== "string" || !/^[a-z0-9_-]{1,32}$/.test(fn))
    throw new QuayError("fn must be a function name", 1);
  const text = typeof input === "string" ? input : JSON.stringify(input ?? {});
  try {
    JSON.parse(text);
  } catch {
    throw new QuayError("--input is not valid JSON", 1);
  }
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES)
    throw new QuayError(`the input is longer than ${MAX_INPUT_BYTES} bytes`, 1);
  return { every_minutes, fn, input: text };
}

export function jobName(fn, existing = []) {
  let name = fn;
  for (let n = 2; existing.includes(name); n += 1) name = `${fn}-${n}`;
  return name;
}

async function jobs(ctx) {
  const list = await ctx.chain.view("cron_list", {});
  return Array.isArray(list) ? list : [];
}

export async function cronCmd(ctx, parsed) {
  const sub = parsed.rest[0];
  if (!sub || parsed.flags.help) {
    writeOut(ctx, helpText("cron"));
    if (!sub)
      throw new QuayError(
        "quay cron needs add, list, rm, status, arm, or kick",
        1,
      );
    return;
  }
  requireAccount(ctx.config);
  const rest = parsed.rest.slice(1);
  if (sub === "list") {
    const list = await jobs(ctx);
    if (ctx.json) return writeOut(ctx, JSON.stringify({ jobs: list }));
    if (list.length === 0) return writeOut(ctx, "no jobs");
    return writeOut(
      ctx,
      table(
        list.map((job) => ({
          name: job.name ?? "",
          every: `${job.every_minutes}m`,
          fn: job.fn,
          input: job.input ?? "",
          last: job.last_run ? formatTime(job.last_run) : "never",
          next: job.next_due ? formatTime(job.next_due) : "",
        })),
        [
          { key: "name", label: "name" },
          { key: "every", label: "every" },
          { key: "fn", label: "fn" },
          { key: "input", label: "input" },
          { key: "last", label: "last run" },
          { key: "next", label: "next due" },
        ],
      ),
    );
  }
  if (sub === "status") {
    const status = await ctx.chain.view("cron_status", {});
    return emit(
      ctx,
      status ?? {},
      [
        `armed       ${status?.armed ? "yes" : "no"}`,
        `hops        ${status?.hops ?? 0}`,
        `last tick   ${status?.last_tick ? formatTime(status.last_tick) : "never"}`,
        `started     ${status?.started ? formatTime(status.started) : "never"}`,
        status?.armed ? "" : "not running. quay cron arm starts it.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (sub === "add") {
    owner(ctx);
    const every = parseEvery(rest[0]);
    if (!rest[1]) throw new QuayError('quay cron add "<every 30m>" <fn>', 1);
    const input =
      parsed.flags.input === undefined ? "{}" : String(parsed.flags.input);
    const job = buildJob({ every_minutes: every, fn: rest[1], input });
    const existing = (await jobs(ctx)).map((item) => item.name);
    if (existing.length >= MAX_JOBS)
      throw new QuayError(`a site holds at most ${MAX_JOBS} jobs`, 1);
    const name = parsed.flags.name
      ? String(parsed.flags.name)
      : jobName(rest[1], existing);
    if (!NAME.test(name))
      throw new QuayError("a job name is 1 to 32 of a-z, 0-9, _ -", 1);
    const sent = await sendCall(
      ctx,
      "cron_set",
      { name, job },
      { deposit: 1n },
    );
    if (!sent) return;
    return emit(
      ctx,
      {
        name,
        job,
        transaction: sent.hash,
        transaction_url: explorerUrl(sent.hash),
      },
      `job ${name}: ${rest[1]} every ${every} minutes\ntransaction ${explorerUrl(sent.hash)}\nnext  quay cron arm  (the schedule does not run until it is armed)`,
    );
  }
  if (sub === "rm") {
    owner(ctx);
    if (!rest[0]) throw new QuayError("quay cron rm needs a job name", 1);
    const sent = await sendCall(
      ctx,
      "cron_remove",
      { name: rest[0] },
      { deposit: 1n },
    );
    if (!sent) return;
    return emit(
      ctx,
      {
        name: rest[0],
        removed: true,
        transaction: sent.hash,
        transaction_url: explorerUrl(sent.hash),
      },
      `removed job ${rest[0]}\ntransaction ${explorerUrl(sent.hash)}`,
    );
  }
  if (sub === "kick") {
    const sent = await sendCall(ctx, "cron_kick", {});
    if (!sent) return;
    return emit(
      ctx,
      {
        kicked: true,
        transaction: sent.hash,
        transaction_url: explorerUrl(sent.hash),
      },
      `kicked\ntransaction ${explorerUrl(sent.hash)}`,
    );
  }
  if (sub === "arm") return arm(ctx);
  throw new QuayError(`unknown cron command ${sub}`, 1);
}

/** NEAR the account can spend: balance minus what its storage locks. */
export function liquidYocto(view) {
  const locked = BigInt(view?.storage_usage ?? 0) * BYTE_COST;
  const liquid = BigInt(view?.amount ?? 0) - locked;
  return liquid < 0n ? 0n : liquid;
}

async function arm(ctx) {
  const view = await ctx.chain.accountView();
  const liquid = liquidYocto(view);
  if (liquid < MIN_LIQUID_YOCTO)
    throw new QuayError(
      `arming needs about 1 NEAR liquid while it runs and this account has ${formatNear(liquid)} NEAR liquid. Fund it first. Unused gas is refunded.`,
      1,
    );
  const status = await ctx.chain.view("cron_status", {}).catch(() => null);
  if (status?.armed)
    throw new QuayError(
      "the schedule is already running. quay cron status shows it.",
      1,
    );
  if (!ctx.dryRun) {
    const ok = await confirm(
      ctx,
      `Arm the schedule? It sends 1 PGas (about 1 NEAR liquid while it runs, unused gas refunded) and lasts about 14 hours.`,
    );
    if (!ok) return stopped(ctx);
  }
  if (ctx.dryRun)
    return emit(
      ctx,
      { dry_run: true, method: "cron_arm", gas: ARM_GAS.toString() },
      "dry run: cron_arm with 1 PGas",
    );
  const sent = await ctx.chain.send(
    "cron_arm",
    {},
    { deposit: 0n, gas: ARM_GAS },
  );
  emit(
    ctx,
    {
      armed: true,
      transaction: sent.hash,
      transaction_url: explorerUrl(sent.hash),
    },
    `armed. It runs for about 14 hours, then quay cron arm again.\ntransaction ${explorerUrl(sent.hash)}`,
  );
}
