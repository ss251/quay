// Seed the Harbour Board: join each harbour member through the relayer, then post
// their notices through @quay/client. This exercises the gasless path end to end.
//
//   node seed.mjs [--dry-run] [--wait] [--relay <url>] [--site <account>] [--rpc <url>]
//
// Member keys are kept in .seed-sessions.json (gitignored) so a re-run reuses the
// same accounts. Keys are never printed. Notices already on the board (same title)
// are skipped, so the script can be re-run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "../../client/src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SESSIONS = join(here, ".seed-sessions.json");

export function loadSeed() {
  const seed = JSON.parse(
    readFileSync(join(here, "seed", "posts.json"), "utf8"),
  );
  const names = Object.keys(seed.members);
  for (const post of seed.posts) {
    if (!names.includes(post.by))
      throw new Error(
        `post "${post.title}" is by ${post.by}, who is not a seed member`,
      );
  }
  return seed;
}

/** The doc a post becomes: everything except who posts it. */
export function docOf(post) {
  const { by: _by, ...data } = post;
  return data;
}

function fileStorage(name) {
  const read = () =>
    existsSync(SESSIONS) ? JSON.parse(readFileSync(SESSIONS, "utf8")) : {};
  return {
    getItem: (key) => read()[name]?.[key] ?? null,
    setItem: (key, value) => {
      const all = read();
      all[name] = { ...all[name], [key]: String(value) };
      writeFileSync(SESSIONS, `${JSON.stringify(all, null, 2)}\n`, {
        mode: 0o600,
      });
    },
    removeItem: (key) => {
      const all = read();
      if (all[name]) delete all[name][key];
      writeFileSync(SESSIONS, `${JSON.stringify(all, null, 2)}\n`, {
        mode: 0o600,
      });
    },
  };
}

// OutLayer relay calls can stall; give up after 120 s and look before retrying
const timedFetch = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function retry(label, task, tries = 6) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (
        attempt >= tries ||
        !(
          ["member_key_missing", "relay_refused"].includes(error.code) ||
          error.name === "TimeoutError" ||
          error.name === "AbortError"
        ) ||
        /rate|limit/i.test(error.message)
      )
        throw error;
      console.log(`  ${label}: ${error.message}; retrying in 3 s`);
      await sleep(3000);
    }
  }
}

export async function seed({
  site,
  relay,
  rpc,
  wait = false,
  dryRun = false,
  log = console.log,
} = {}) {
  const data = loadSeed();
  if (dryRun) {
    log(`dry run for ${site}`);
    log(
      `join ${Object.keys(data.members).length} members: ${Object.keys(data.members).join(", ")}`,
    );
    for (const post of data.posts)
      log(`post by ${post.by}.${site}: ${post.title}`);
    return { members: Object.keys(data.members), posts: data.posts.length };
  }
  if (!relay)
    throw new Error("no relay URL: pass --relay <url> or set it in board.json");
  const reader = connect({ site, rpc, relay });
  const existing = new Set();
  for (let from; ; ) {
    const page = await reader.db
      .collection("posts")
      .list({ limit: 50, order: "asc", ...(from ? { from } : {}) });
    for (const doc of page.docs) existing.add(doc.data?.title);
    if (!page.next) break;
    from = page.next;
  }

  const clients = {};
  for (const name of Object.keys(data.members)) {
    const quay = connect({
      site,
      rpc,
      relay,
      storage: fileStorage(name),
      fetch: timedFetch,
    });
    await retry(`join ${name}`, () =>
      quay.auth.signIn({ mode: "member", name }),
    );
    log(`member ${quay.auth.account} ready`);
    clients[name] = quay;
  }

  const posted = [];
  for (const post of data.posts) {
    if (existing.has(post.title)) {
      log(`skip   "${post.title}" is already on the board`);
      continue;
    }
    const quay = clients[post.by];
    const id = await retry(post.title, () =>
      quay.db.collection("posts").add(docOf(post)),
    );
    log(`posted ${id}  ${quay.auth.account}  ${post.title}`);
    posted.push(String(id));
    if (wait) {
      for (let waited = 0; waited < 60_000; waited += 2000) {
        await sleep(2000);
        const doc = await reader.db.collection("posts").get(id);
        if (doc?.fn || doc?.hidden) {
          log(
            `       function result ${doc.hidden ? "hid the post" : "stored"} after about ${Math.round((waited + 2000) / 1000)} s`,
          );
          break;
        }
      }
    } else {
      await sleep(1500);
    }
  }
  log(`done: ${posted.length} posted. Open https://${site}.page/`);
  return { members: Object.keys(clients), posts: posted };
}

function flag(args, name) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const project = JSON.parse(readFileSync(join(here, "quay.json"), "utf8"));
  const local = existsSync(join(here, "board.json"))
    ? JSON.parse(readFileSync(join(here, "board.json"), "utf8"))
    : {};
  seed({
    site: flag(args, "site") ?? project.account,
    relay: flag(args, "relay") ?? local.relay ?? process.env.QUAY_RELAY,
    rpc: flag(args, "rpc") ?? local.rpc ?? undefined,
    wait: args.includes("--wait"),
    dryRun: args.includes("--dry-run"),
  }).catch((error) => {
    console.error(`seed failed: ${error.message}`);
    process.exit(1);
  });
}
