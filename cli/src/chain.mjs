import { readFileSync } from "node:fs";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  actions,
  teraToGas,
} from "near-api-js";

import { chainError, QuayError } from "./errors.mjs";
import {
  classifyChainError,
  transactionHashOf,
  transactionValueOf,
} from "./outcome.mjs";

const GAS_CHUNK = teraToGas("200");
const GAS_CALL = teraToGas("80");
const GAS_DEPLOY = teraToGas("200");

export function generateKey() {
  const key = KeyPair.fromRandom("ed25519");
  return { secret: key.toString(), publicKey: key.getPublicKey().toString() };
}

export function publicKeyOf(secret) {
  return KeyPair.fromString(secret).getPublicKey().toString();
}

export function createProvider(rpc) {
  return new JsonRpcProvider({ url: rpc });
}

export function accountFromSecret(accountId, provider, secret) {
  return new Account(accountId, provider, secret);
}

export function createChain({ accountId, rpc, secret }) {
  const provider = createProvider(rpc);
  const account = secret
    ? accountFromSecret(accountId, provider, secret)
    : new Account(accountId, provider);

  async function view(method, args = {}) {
    try {
      return await provider.callFunction({
        contractId: accountId,
        method,
        args,
      });
    } catch (error) {
      throw chainError(error?.message ?? "view call failed");
    }
  }

  async function send(method, args, { deposit = 0n, gas = GAS_CALL } = {}) {
    try {
      const outcome = await account.signAndSendTransaction({
        receiverId: accountId,
        waitUntil: "EXECUTED",
        actions: [actions.functionCall(method, args, gas, deposit)],
      });
      return {
        hash: transactionHashOf(outcome),
        value: transactionValueOf(outcome),
        outcome,
      };
    } catch (error) {
      throw classifyChainError(error);
    }
  }

  return {
    provider,
    account,
    view,
    send,
    async hasChunk(sha256) {
      return Boolean(await view("has_chunk", { sha256 }));
    },
    /**
     * One transaction of raw function calls to `receiverId` (default: this
     * account). Used for NEARFS blocks, where the call is meant to fail and the
     * indexer keeps the args, so a failed receipt is not an error here.
     */
    async sendBatch(calls, { receiverId = accountId } = {}) {
      try {
        const outcome = await account.signAndSendTransaction({
          receiverId,
          waitUntil: "INCLUDED",
          throwOnFailure: false,
          actions: calls.map((call) =>
            actions.functionCall(
              call.method,
              call.args,
              call.gas ?? GAS_CALL,
              call.deposit ?? 0n,
            ),
          ),
        });
        return { hash: transactionHashOf(outcome), outcome };
      } catch (error) {
        throw classifyChainError(error);
      }
    },
    async putChunk(sha256, bytes) {
      return send(
        "put_chunk",
        { sha256, data: Buffer.from(bytes).toString("base64") },
        { deposit: 0n, gas: GAS_CHUNK },
      );
    },
    async seal(id, files, message, spa, routes) {
      return send(
        "seal",
        routes?.length
          ? { id, files, message, spa, routes }
          : { id, files, message, spa },
        { deposit: 0n, gas: GAS_CALL },
      );
    },
    async promote(id) {
      return send("promote", { id }, { deposit: 1n });
    },
    async rollback() {
      return send("rollback", {}, { deposit: 1n });
    },
    async deleteRelease(id) {
      return send("delete", { id }, { deposit: 1n });
    },
    async dropChunk(sha256) {
      return send("drop_chunk", { sha256 }, { deposit: 1n });
    },
    async deployAndInit(wasm) {
      try {
        const outcome = await account.signAndSendTransaction({
          receiverId: accountId,
          waitUntil: "EXECUTED",
          actions: [
            actions.deployContract(wasm),
            actions.functionCall("new", {}, GAS_DEPLOY, 0n),
          ],
        });
        return { hash: transactionHashOf(outcome) };
      } catch (error) {
        throw classifyChainError(error);
      }
    },
    async replaceWasm(wasm) {
      try {
        const outcome = await account.signAndSendTransaction({
          receiverId: accountId,
          waitUntil: "EXECUTED",
          actions: [actions.deployContract(wasm)],
        });
        return { hash: transactionHashOf(outcome) };
      } catch (error) {
        throw classifyChainError(error);
      }
    },
    async accountView() {
      try {
        return await provider.viewAccount({ accountId });
      } catch (error) {
        if (/does not exist/i.test(error?.message ?? "")) return null;
        throw chainError(error?.message ?? "account view failed");
      }
    },
    async accessKeys() {
      try {
        return await provider.viewAccessKeyList({ accountId });
      } catch (error) {
        throw chainError(error?.message ?? "could not list keys");
      }
    },
    async addPublishKey(publicKey, methodNames) {
      try {
        // Omit allowance. The default is unlimited gas. A zero allowance cannot
        // pay for put_chunk. A function-call key still cannot attach a deposit.
        const outcome = await account.addFunctionCallAccessKey({
          publicKey,
          contractId: accountId,
          methodNames,
        });
        return { hash: transactionHashOf(outcome) };
      } catch (error) {
        throw classifyChainError(error);
      }
    },
    async deleteKey(publicKey) {
      try {
        const outcome = await account.deleteKey(publicKey);
        return { hash: transactionHashOf(outcome) };
      } catch (error) {
        throw classifyChainError(error);
      }
    },
    async relayRefusal(ciSecret) {
      const publisher = accountFromSecret(accountId, provider, ciSecret);
      try {
        const meta = await publisher.createSignedMetaTransaction({
          receiverId: accountId,
          actions: [
            actions.functionCall("promote", { id: "ci-prove" }, GAS_CALL, 0n),
          ],
        });
        const outcome = await account.relayMetaTransaction(meta.signedDelegate);
        return {
          refused: false,
          hash: transactionHashOf(outcome),
          message: "promote was accepted",
        };
      } catch (error) {
        const wrapped = classifyChainError(error);
        const hash =
          error?.transactionResult?.transaction?.hash ?? error?.txHash ?? null;
        if (wrapped.code === 3) {
          return { refused: true, hash, message: wrapped.message };
        }
        throw wrapped;
      }
    },
  };
}

export function readWasm(path) {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    throw new QuayError(`bundled contract wasm is missing at ${path}`, 1);
  }
}

export function emptyCodeHash(hash) {
  return hash === "11111111111111111111111111111111";
}

export async function fundContract({
  payerId,
  secret,
  rpc,
  contractId,
  yocto,
  memo,
}) {
  const provider = createProvider(rpc);
  const account = accountFromSecret(payerId, provider, secret);
  try {
    const outcome = await account.signAndSendTransaction({
      receiverId: contractId,
      waitUntil: "EXECUTED",
      actions: [
        actions.functionCall("buy", memo ? { memo } : {}, GAS_CALL, yocto),
      ],
    });
    return { hash: transactionHashOf(outcome) };
  } catch (error) {
    throw classifyChainError(error);
  }
}
