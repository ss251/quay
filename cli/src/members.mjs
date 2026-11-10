import { requireAccount } from "./config.mjs";
import { QuayError } from "./errors.mjs";
import { sendCall } from "./db.mjs";
import { explorerUrl, owner } from "./shared.mjs";
import { emit, helpText, writeOut } from "./text.mjs";

export async function allMembers(chain) {
  const members = [];
  let from = 0;
  for (;;) {
    const page = await chain.view("list_members", {
      from_index: from,
      limit: 50,
    });
    members.push(...(page?.members ?? []));
    if (page?.next == null) return members;
    from = page.next;
  }
}

export async function membersCmd(ctx, parsed) {
  const sub = parsed.rest[0];
  if (!sub || parsed.flags.help) {
    writeOut(ctx, helpText("members"));
    if (!sub) throw new QuayError("quay members needs list, open, or close", 1);
    return;
  }
  requireAccount(ctx.config);
  if (sub === "list") {
    const [members, open] = await Promise.all([
      allMembers(ctx.chain),
      ctx.chain.view("get_members_open", {}),
    ]);
    emit(
      ctx,
      { open: Boolean(open), members },
      [
        `joining is ${open ? "open" : "closed"}`,
        members.length === 0 ? "no members" : members.join("\n"),
      ].join("\n"),
    );
    return;
  }
  if (sub === "open" || sub === "close") {
    owner(ctx);
    const open = sub === "open";
    const sent = await sendCall(
      ctx,
      "set_members_open",
      { open },
      { deposit: 1n },
    );
    if (!sent) return;
    emit(
      ctx,
      { open, transaction: sent.hash, transaction_url: explorerUrl(sent.hash) },
      `joining is ${open ? "open" : "closed"}\ntransaction ${explorerUrl(sent.hash)}`,
    );
    return;
  }
  throw new QuayError(`unknown members command ${sub}`, 1);
}
