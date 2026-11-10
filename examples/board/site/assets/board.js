// Harbour Board client. Pages work without this file; it adds posting, pinning,
// the member list, the receipts list and the digest. Uses the built @quay/client bundle.
import { connect } from "./quay.js";

const $ = (selector, root = document) => root.querySelector(selector);
const page = document.body.dataset.page;
const config = await fetch("/assets/config.json")
  .then((res) => (res.ok ? res.json() : {}))
  .catch(() => ({}));
const site = config.site || location.hostname.replace(/\.page$/, "");
const quay = connect({
  site,
  relay: config.relay || undefined,
  rpc: config.rpc || undefined,
});

const YOCTO = 10n ** 24n;
const nearText = (yocto) => {
  const value = BigInt(yocto);
  const frac = ((value % YOCTO) * 10_000n) / YOCTO;
  return `${value / YOCTO}.${String(frac).padStart(4, "0")}`.replace(
    /\.?0+$/,
    "",
  );
};
const dateText = (ns) =>
  `${new Date(Number(BigInt(ns) / 1_000_000n))
    .toISOString()
    .slice(0, 16)
    .replace("T", " ")} UTC`;
const show = (el, on) => {
  if (el) el.hidden = !on;
};
const say = (el, text) => {
  if (el) el.textContent = text;
};
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of kids) node.append(kid);
  return node;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const reason = (error) => String(error?.message ?? error).slice(0, 240);

for (const node of document.querySelectorAll(".site-suffix-bare"))
  node.textContent = site;

async function allMembers() {
  const out = [];
  for (let from = 0; ; ) {
    const res = await quay.members.list({ from, limit: 50 });
    out.push(...(res.members ?? []));
    if (res.next == null) return out;
    from = res.next;
  }
}

const pages = {
  async members() {
    const status = $("#members-status");
    try {
      const members = await allMembers();
      const list = $("#members");
      for (const account of members) {
        list.append(
          el(
            "li",
            {},
            el("a", {
              href: `/?owner=${encodeURIComponent(account)}`,
              textContent: account,
            }),
          ),
        );
      }
      say(
        status,
        members.length
          ? `${members.length} member${members.length === 1 ? "" : "s"}, oldest first.`
          : "No members yet.",
      );
    } catch (error) {
      say(status, `Could not read members: ${reason(error)}`);
    }
  },

  async receipts() {
    const status = $("#receipts-status");
    try {
      const { docs } = await quay.db
        .collection("_receipts")
        .list({ limit: 50, order: "desc" });
      const pins = docs.filter((doc) => doc.data?.product === "pin");
      const rows = $("#receipts");
      for (const { data } of pins) {
        const ref = /^posts\/[A-Za-z0-9_-]+$/.test(data.ref ?? "")
          ? data.ref
          : null;
        const amount =
          data.token === "near"
            ? `${nearText(data.amount)} NEAR`
            : `${data.amount} ${data.token}`;
        rows.append(
          el(
            "tr",
            {},
            el("td", { textContent: data.buyer }),
            el(
              "td",
              {},
              ref ? el("a", { href: `/${ref}`, textContent: ref }) : "-",
            ),
            el("td", { textContent: amount }),
            el("td", { textContent: dateText(data.at) }),
          ),
        );
      }
      show($("#receipts-table"), pins.length > 0);
      say(
        status,
        pins.length
          ? `${pins.length} pin${pins.length === 1 ? "" : "s"}, newest first.`
          : "No pins yet.",
      );
    } catch (error) {
      say(status, `Could not read receipts: ${reason(error)}`);
    }
  },

  async post() {
    const button = $("[data-pin]");
    const status = $("[data-pin-status]");
    const id = document.body.dataset.post;
    const ref = document.body.dataset.ref;
    if (!button) return;
    quay
      .view("get_product", { id: "pin" })
      .then((product) => {
        if (product?.price_yocto) {
          const hours = Math.round(Number(product.pin_seconds ?? 86400) / 3600);
          button.textContent = `Pin this post for ${hours} h, ${nearText(product.price_yocto)} NEAR`;
        }
      })
      .catch(() => {});
    const tokenButton = $("[data-pin-token]");
    quay
      .view("get_token", {})
      .then((token) => {
        if (!token && tokenButton) tokenButton.remove();
      })
      .catch(() => {});
    const pin = async (options, label) => {
      for (const b of [button, tokenButton]) if (b) b.disabled = true;
      try {
        if (quay.auth.mode !== "wallet") {
          say(status, "Opening your wallet to sign in.");
          await quay.auth.signIn({ mode: "wallet" });
        }
        say(status, `Approve the ${label} payment in your wallet.`);
        await quay.pay("pin", { ref, ...options });
        say(status, "Paid. Reading the pin from the contract.");
        const doc = await quay.db.collection("posts").get(id);
        say(
          status,
          doc?.pinned_until
            ? `Pinned until ${dateText(doc.pinned_until)}. Reload to see it at the top of the board.`
            : "Paid. The pin shows after the next block.",
        );
      } catch (error) {
        say(status, `Not pinned: ${reason(error)}`);
      } finally {
        for (const b of [button, tokenButton]) if (b) b.disabled = false;
      }
    };
    button.addEventListener("click", () => pin({}, "NEAR"));
    tokenButton?.addEventListener("click", () =>
      pin({ token: true }, "test USDC (usdc.fakes.testnet, not Circle USDC)"),
    );
  },

  async new() {
    const $who = $("#who");
    const $msg = $("#auth-msg");
    const $name = $("#join-name");
    const fail = (text) => {
      say($msg, text);
      show($msg, true);
    };
    const suffix = () => {
      for (const node of document.querySelectorAll(".site-suffix"))
        node.textContent = `${$name.value || "name"}.${site}`;
    };
    $name.addEventListener("input", suffix);
    suffix();

    function refresh() {
      const account = quay.auth.account;
      say(
        $who,
        account
          ? `Signed in as ${account}${quay.auth.mode === "wallet" ? " with a wallet" : " with a member key"}.`
          : "Not signed in.",
      );
      show($("#auth-forms"), !account);
      show($("#signout"), Boolean(account));
    }

    async function enter() {
      const account = quay.auth.account;
      refresh();
      show($msg, false);
      show($("#post-card"), Boolean(account));
    }

    if (quay.auth.account) enter();
    else refresh();

    $("#join-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      show($msg, false);
      const name = $name.value.trim();
      if (!/^[a-z0-9_-]{2,32}$/.test(name))
        return fail("A name is 2 to 32 characters from a-z, 0-9, - and _.");
      if (["relay", "admin", "www", "api", "quay"].includes(name))
        return fail("That name is reserved. Pick another.");
      const submit = event.submitter ?? $("button", event.target);
      submit.disabled = true;
      say(
        $who,
        `Creating ${name}.${site}. The relayer pays; you hold the only key, in this browser.`,
      );
      try {
        await quay.auth.signIn({ mode: "member", name });
        await enter();
      } catch (error) {
        refresh();
        fail(`Could not join: ${reason(error)}`);
      } finally {
        submit.disabled = false;
      }
    });

    $("#wallet-btn").addEventListener("click", async () => {
      show($msg, false);
      try {
        await quay.auth.signIn({ mode: "wallet" });
        await enter();
      } catch (error) {
        fail(`Wallet sign-in failed: ${reason(error)}`);
      }
    });

    $("#signout").addEventListener("click", async () => {
      await quay.auth.signOut();
      show($("#post-card"), false);
      show($msg, false);
      refresh();
    });

    const body = $("#f-body");
    const count = $("#count");
    body.addEventListener("input", () =>
      say(count, `${body.value.length} of ${body.maxLength} characters`),
    );

    const stepList = $("#steps");
    const mark = (name, state) => {
      const order = ["sign", "relay", "trigger", "done"];
      for (const item of stepList.children) {
        const index = order.indexOf(item.dataset.step);
        item.className =
          index < order.indexOf(name)
            ? "done"
            : item.dataset.step === name
              ? state
              : "";
      }
    };

    $("#post-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const result = $("#result");
      show(result, false);
      result.className = "notice";
      const data = {
        title: $("#f-title").value.trim(),
        body: body.value.trim(),
        topic: $("#f-topic").value,
      };
      const link = $("#f-link").value.trim();
      if (!data.title || !data.body)
        return fail("A notice needs a title and some text.");
      if (link) {
        let url;
        try {
          url = new URL(link);
        } catch {}
        if (url?.protocol !== "https:")
          return fail("A link must start with https://");
        data.link = link;
      }
      const size = new TextEncoder().encode(JSON.stringify(data)).length;
      if (size > 2000)
        return fail(
          `That notice is ${size} bytes and the board takes at most 2000. Shorten the text.`,
        );
      show($msg, false);
      const submit = $("#post-btn");
      submit.disabled = true;
      show(stepList, true);
      stepList.children[0].textContent =
        quay.auth.mode === "wallet"
          ? "Approve in your wallet"
          : "Sign with your member key";
      try {
        mark("sign", "now");
        await sleep(300);
        mark("relay", "now");
        const id = String(await quay.db.collection("posts").add(data));
        mark("trigger", "now");
        let doc = null;
        const until = Date.now() + 60_000;
        while (Date.now() < until) {
          await sleep(2000);
          doc = await quay.db
            .collection("posts")
            .get(id)
            .catch(() => null);
          if (doc?.fn || doc?.hidden) break;
        }
        const href = `/posts/${encodeURIComponent(id)}`;
        if (doc?.hidden) {
          mark("trigger", "fail");
          result.className = "notice err";
          result.replaceChildren(
            `The moderation function held this notice back${doc.fn?.reason ? `: ${doc.fn.reason}` : "."}`,
          );
        } else {
          mark("done", "done");
          result.replaceChildren(
            doc?.fn
              ? "Published and checked. "
              : "Published. The moderation function is still running, so the link preview may appear a little later. ",
            el("a", { href, textContent: "Open your notice" }),
          );
        }
        show(result, true);
        $("#post-form").reset();
        say(count, `0 of ${body.maxLength} characters`);
      } catch (error) {
        for (const item of stepList.children)
          if (item.className === "now") item.className = "fail";
        fail(`The post did not go through: ${reason(error)}`);
      } finally {
        submit.disabled = false;
      }
    });
  },
};

pages[page]?.();
