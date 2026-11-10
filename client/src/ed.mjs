// ed25519 via @noble/ed25519 with WebCrypto SHA-512 (browsers and Node 20+), async API.
import * as ed from "@noble/ed25519";

export const ed25519 = {
  getPublicKey: ed.getPublicKeyAsync,
  sign: ed.signAsync,
  verify: ed.verifyAsync,
  randomSeed: () => ed.utils.randomSecretKey(),
};
