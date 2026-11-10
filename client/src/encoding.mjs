// Minimal borsh, base58 and base64 for exactly what Quay needs:
// NEP-413 messages, NEP-366 delegate actions (FunctionCall only) and their signatures.
import { ed25519 } from "./ed.mjs";

export const NEP413_TAG = 2 ** 31 + 413; // 2147484061
export const NEP461_TAG = 2 ** 30 + 366; // 1073742190, delegate actions

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

// ---------- base58 (bitcoin alphabet) ----------
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = new Map([...ALPHA].map((c, i) => [c, i]));

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHA[digits[i]];
  return out;
}

export function base58Decode(str) {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const bytes = [];
  for (let i = zeros; i < str.length; i++) {
    const v = MAP.get(str[i]);
    if (v === undefined) throw new Error("invalid base58 character");
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

// ---------- base64 ----------
export function base64Encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64Decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- keys ----------
export function parsePublicKey(str) {
  const m = /^ed25519:(.+)$/.exec(str);
  if (!m) throw new Error("only ed25519 keys are supported");
  const bytes = base58Decode(m[1]);
  if (bytes.length !== 32) throw new Error("bad public key length");
  return bytes;
}
export const formatPublicKey = (bytes) => `ed25519:${base58Encode(bytes)}`;

/** Secret keys use the NEAR text form `ed25519:<base58 of seed||public>` (64 bytes). */
export async function generateKey() {
  const seed = ed25519.randomSeed();
  const pub = await ed25519.getPublicKey(seed);
  return { seed, publicKey: pub, secretKey: formatSecretKey(seed, pub) };
}
export function formatSecretKey(seed, pub) {
  const full = new Uint8Array(64);
  full.set(seed);
  full.set(pub, 32);
  return `ed25519:${base58Encode(full)}`;
}
export function parseSecretKey(str) {
  const m = /^ed25519:(.+)$/.exec(str);
  if (!m) throw new Error("only ed25519 keys are supported");
  const bytes = base58Decode(m[1]);
  if (bytes.length !== 64) throw new Error("secret key must be the 64-byte NEAR form");
  return { seed: bytes.slice(0, 32), publicKey: bytes.slice(32) };
}

// ---------- borsh writer ----------
export class Writer {
  constructor() {
    this.parts = [];
  }
  u8(n) {
    this.parts.push(Uint8Array.of(n));
    return this;
  }
  u32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    this.parts.push(b);
    return this;
  }
  uint(value, bytes) {
    let v = BigInt(value);
    if (v < 0n || v >= 1n << BigInt(8 * bytes)) throw new Error("integer out of range");
    const b = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    this.parts.push(b);
    return this;
  }
  u64(v) {
    return this.uint(v, 8);
  }
  u128(v) {
    return this.uint(v, 16);
  }
  raw(bytes) {
    this.parts.push(bytes);
    return this;
  }
  bytes(bytes) {
    return this.u32(bytes.length).raw(bytes);
  }
  str(s) {
    return this.bytes(enc.encode(s));
  }
  optStr(s) {
    return s == null ? this.u8(0) : this.u8(1).str(s);
  }
  finish() {
    let n = 0;
    for (const p of this.parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.o = 0;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(n) {
    if (this.o + n > this.b.length) throw new Error("unexpected end of data");
  }
  u8() {
    this.need(1);
    return this.b[this.o++];
  }
  u32() {
    this.need(4);
    const n = this.v.getUint32(this.o, true);
    this.o += 4;
    return n;
  }
  uint(bytes) {
    this.need(bytes);
    let v = 0n;
    for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.b[this.o + i]);
    this.o += bytes;
    return v;
  }
  u64() {
    return this.uint(8);
  }
  u128() {
    return this.uint(16);
  }
  raw(n) {
    this.need(n);
    const out = this.b.slice(this.o, this.o + n);
    this.o += n;
    return out;
  }
  bytes() {
    const n = this.u32();
    return this.raw(n);
  }
  str() {
    return dec.decode(this.bytes());
  }
  done() {
    return this.o === this.b.length;
  }
}

// ---------- NEP-413 ----------
export function nep413Payload({ message, nonce, recipient, callbackUrl }) {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  return new Writer().u32(NEP413_TAG).str(message).raw(nonce).str(recipient).optStr(callbackUrl).finish();
}
export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
export const nep413Hash = async (p) => sha256(nep413Payload(p));

export async function nep413Sign(secretKey, payload) {
  const { seed } = parseSecretKey(secretKey);
  return ed25519.sign(await nep413Hash(payload), seed);
}
export async function nep413Verify(publicKey, signature, payload) {
  try {
    return await ed25519.verify(signature, await nep413Hash(payload), parsePublicKey(publicKey));
  } catch {
    return false;
  }
}

// ---------- NEP-366 delegates ----------
const ACTION_FUNCTION_CALL = 2;

function writePublicKey(w, pk) {
  return w.u8(0).raw(typeof pk === "string" ? parsePublicKey(pk) : pk);
}

/** action: { methodName, args (Uint8Array | object), gas, deposit } */
export function encodeDelegateAction(d) {
  const w = new Writer().str(d.senderId).str(d.receiverId);
  w.u32(d.actions.length);
  for (const a of d.actions) {
    const args = a.args instanceof Uint8Array ? a.args : enc.encode(JSON.stringify(a.args ?? {}));
    w.u8(ACTION_FUNCTION_CALL).str(a.methodName).bytes(args).u64(a.gas).u128(a.deposit ?? 0n);
  }
  w.u64(d.nonce).u64(d.maxBlockHeight);
  return writePublicKey(w, d.publicKey).finish();
}

export const delegateHash = async (d) =>
  sha256(new Writer().u32(NEP461_TAG).raw(encodeDelegateAction(d)).finish());

export async function signDelegate(delegate, secretKey) {
  const { seed } = parseSecretKey(secretKey);
  return { delegateAction: delegate, signature: await ed25519.sign(await delegateHash(delegate), seed) };
}

export function encodeSignedDelegate({ delegateAction, signature }) {
  return new Writer().raw(encodeDelegateAction(delegateAction)).u8(0).raw(signature).finish();
}

/**
 * Decode a SignedDelegateAction. Actions other than FunctionCall are reported as
 * `{ kind: <tag> }` and stop action parsing (their layout is not needed to reject them).
 * Returns { delegate, signature, hash, raw }.
 */
export function decodeSignedDelegate(bytes) {
  const r = new Reader(bytes);
  const senderId = r.str();
  const receiverId = r.str();
  const count = r.u32();
  if (count > 64) throw new Error("too many actions");
  const actions = [];
  let opaque = false;
  for (let i = 0; i < count; i++) {
    const tag = r.u8();
    if (tag !== ACTION_FUNCTION_CALL) {
      actions.push({ kind: tag });
      opaque = true;
      break;
    }
    actions.push({ kind: tag, methodName: r.str(), args: r.bytes(), gas: r.u64(), deposit: r.u128() });
  }
  if (opaque) return { delegate: { senderId, receiverId, actions }, opaque: true };
  const nonce = r.u64();
  const maxBlockHeight = r.u64();
  if (r.u8() !== 0) throw new Error("only ed25519 keys are supported");
  const publicKey = formatPublicKey(r.raw(32));
  if (r.u8() !== 0) throw new Error("only ed25519 signatures are supported");
  const signature = r.raw(64);
  if (!r.done()) throw new Error("trailing bytes");
  const delegate = { senderId, receiverId, actions, nonce, maxBlockHeight, publicKey };
  return { delegate, signature, opaque: false };
}

export async function verifySignedDelegate(delegate, signature) {
  try {
    return await ed25519.verify(signature, await delegateHash(delegate), parsePublicKey(delegate.publicKey));
  } catch {
    return false;
  }
}

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
