import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import type { LinkCrypto } from "../crypto.js";

/** The pure-JS reference implementations, as a second crypto port the node port must interoperate with. */
export const nobleCrypto: LinkCrypto = {
  generateKeyPair() {
    const privateKey = x25519.utils.randomSecretKey();
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
  },
  keyPairFromPrivate: (privateKey) => ({ privateKey: Uint8Array.from(privateKey), publicKey: x25519.getPublicKey(privateKey) }),
  dh: (privateKey, publicKey) => x25519.getSharedSecret(privateKey, publicKey),
  seal: (key, nonce, ad, plaintext) => gcm(key, nonce, ad).encrypt(plaintext),
  open(key, nonce, ad, ciphertext) {
    try {
      return gcm(key, nonce, ad).decrypt(ciphertext);
    } catch {
      return null;
    }
  },
  sha256: (data) => sha256(data),
  hmacSha256: (key, data) => hmac(sha256, key, data),
  randomBytes: (length) => randomBytes(length),
};
