import { QuayError, usage } from "./errors.mjs";

export const CLI_VERSION = "2.0.0";

const BOOLEAN = new Set([
  "json",
  "help",
  "yes",
  "dry-run",
  "spa",
  "ci",
  "version",
  "replace",
]);

const KNOWN = new Set([...BOOLEAN, "account", "rpc", "message", "id"]);

export const COMMANDS = [
  {
    name: "init",
    summary:
      "Create or adopt a testnet account, deploy the contract, and write quay.json.",
    usage: "quay init [account]",
    options: [
      [
        "--replace",
        "Deploy the bundled wasm over an existing contract. Asks first.",
      ],
      ["--yes", "Skip the confirmation."],
    ],
  },
  {
    name: "deploy",
    summary:
      "Upload a folder as an immutable release and print its preview URL.",
    usage: "quay deploy [dir] [-m message]",
    options: [
      ["-m, --message <text>", "Release note, at most 200 characters."],
      ["--id <id>", "Release id. The default is the next number."],
      ["--spa", "Serve index.html for unknown paths inside this release."],
      ["--dry-run", "Print the storage estimate and do not send anything."],
      ["--yes", "Skip the confirmation. A non-interactive shell does not ask."],
      ["--ci", "Sign with the publish-only key."],
    ],
  },
  {
    name: "promote",
    summary: "Make a release the production site.",
    usage: "quay promote <id>",
    options: [["--yes", "Skip the confirmation."]],
  },
  {
    name: "rollback",
    summary: "Swap production with the previous release.",
    usage: "quay rollback",
    options: [["--yes", "Skip the confirmation."]],
  },
  {
    name: "releases",
    summary:
      "List releases: id, date, files, size, message, and which is production.",
    usage: "quay releases",
    options: [],
  },
  {
    name: "status",
    summary: "Show the account, production pointer, storage, and gateway.",
    usage: "quay status",
    options: [],
  },
  {
    name: "open",
    summary: "Print a preview URL. On macOS, also open it.",
    usage: "quay open [id]",
    options: [],
  },
  {
    name: "delete",
    summary: "Delete a release that is not production and unlock its storage.",
    usage: "quay delete <id>",
    options: [["--yes", "Skip the confirmation."]],
  },
  {
    name: "keys",
    summary: "Create, list, or revoke a publish-only key.",
    usage: "quay keys <create|list|revoke|prove>",
    options: [
      [
        "create --ci",
        "Add a key that can only call put_chunk and seal. The secret is printed once.",
      ],
      ["list", "Show access keys. Secrets stay in the credentials folder."],
      [
        "revoke <public-key>",
        "Remove an access key. Refuses the key that is signing.",
      ],
      [
        "prove",
        "Relay a promote signed by the publish-only key and expect the refusal.",
      ],
    ],
  },
];

const GLOBAL = [
  ["--json", "Print one JSON object on stdout."],
  ["--account <id>", "Contract account. Overrides quay.json and QUAY_ACCOUNT."],
  [
    "--rpc <url>",
    "JSON-RPC URL. The default is https://test.rpc.fastnear.com.",
  ],
  ["--help", "Show this help."],
];

export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === "-h") {
      flags.help = true;
      continue;
    }
    if (token === "-m") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-"))
        throw usage("quay: -m needs a message");
      flags.message = value;
      index += 1;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    if (!KNOWN.has(name)) throw usage(`quay: unknown flag ${token}`);
    if (eq !== -1) {
      flags[name] = body.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (BOOLEAN.has(name) || next === undefined || next.startsWith("-")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return {
    command: positionals[0] ?? "help",
    rest: positionals.slice(1),
    flags,
  };
}

export function helpText(command) {
  if (!command || command === "help") {
    const lines = [
      "quay — publish a site to NEAR testnet",
      "",
      "Usage",
      "  quay <command> [options]",
      "",
      "Commands",
    ];
    for (const item of COMMANDS) {
      lines.push(`  ${item.name.padEnd(10)} ${item.summary}`);
    }
    lines.push("", "Global options");
    for (const [flag, text] of GLOBAL)
      lines.push(`  ${flag.padEnd(18)} ${text}`);
    lines.push(
      "",
      "Storage is about 0.01 NEAR per 1000 bytes on the contract account.",
    );
    lines.push("Run `quay <command> --help` for one command.");
    return lines.join("\n");
  }
  const item = COMMANDS.find((entry) => entry.name === command);
  if (!item) throw usage(`quay: unknown command ${command}`);
  const lines = [item.summary, "", "Usage", `  ${item.usage}`];
  if (item.options.length) {
    lines.push("", "Options");
    for (const [flag, text] of item.options)
      lines.push(`  ${flag.padEnd(24)} ${text}`);
  }
  lines.push("", "Global options");
  for (const [flag, text] of GLOBAL) lines.push(`  ${flag.padEnd(18)} ${text}`);
  return lines.join("\n");
}

export function paint(enabled, code, text) {
  if (!enabled) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return String(bytes);
  if (value < 1000) return `${value} B`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} KB`;
}

export function formatNear(yocto) {
  const negative = yocto < 0n;
  const value = negative ? -yocto : yocto;
  const whole = value / 10n ** 24n;
  const frac = (value % 10n ** 24n).toString().padStart(24, "0").slice(0, 4);
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

export function formatTime(nanoseconds) {
  if (nanoseconds === undefined || nanoseconds === null) return "unknown";
  const raw = BigInt(nanoseconds);
  if (raw === 0n) return "unknown";
  const date = new Date(Number(raw / 1_000_000n));
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function table(rows, columns) {
  const widths = columns.map((column) =>
    Math.max(
      column.label.length,
      ...rows.map((row) => String(row[column.key] ?? "").length),
    ),
  );
  const line = (row) =>
    columns
      .map((column, index) =>
        String(row[column.key] ?? "").padEnd(widths[index]),
      )
      .join("  ");
  return [
    line(
      Object.fromEntries(columns.map((column) => [column.key, column.label])),
    ),
    ...rows.map(line),
  ].join("\n");
}

export function redact(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && secret.length > 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function writeOut(ctx, text) {
  ctx.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function writeErr(ctx, text) {
  ctx.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function emit(ctx, payload, plain) {
  if (ctx.json) writeOut(ctx, JSON.stringify(payload));
  else if (plain) writeOut(ctx, plain);
}

export function classifyChainError(error) {
  const panic = error?.panicMessage ? String(error.panicMessage) : "";
  const message = `${panic}\n${error?.name ?? ""}\n${error?.message ?? error}`;
  if (
    /MethodNameMismatch|method is not allowed|does not allow method|DepositWithFunctionCall/i.test(
      message,
    )
  ) {
    return new QuayError("the signing key cannot call that method", 3);
  }
  if (
    /yoctoNEAR|only this account|cannot delete production|nothing to roll back/i.test(
      message,
    )
  ) {
    return new QuayError(panic || firstLine(message), 3);
  }
  const hash = error?.transactionResult?.transaction?.hash ?? error?.txHash;
  const suffix = hash ? ` (${hash})` : "";
  return new QuayError(`${firstLine(panic || message)}${suffix}`, 2);
}

function firstLine(text) {
  return (
    String(text)
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "the network rejected the transaction"
  );
}

export function assertTestnet(network) {
  if (network && network !== "testnet") {
    throw new QuayError("quay only runs on testnet", 1);
  }
}
