export { classifyChainError } from "./text.mjs";

export function transactionHashOf(outcome) {
  return outcome?.transaction?.hash ?? null;
}

export function transactionValueOf(outcome) {
  const status = outcome?.status;
  if (!status || typeof status !== "object") return null;
  const raw = status.SuccessValue ?? status.success_value ?? null;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const text = Buffer.from(raw, "base64").toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
