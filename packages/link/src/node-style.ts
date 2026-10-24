import { concat } from "./bytes.js";
import { TAG_BYTES, type KeyPair, type LinkCrypto } from "./crypto.js";

type DerKey<T extends "pkcs8" | "spki"> = { key: Uint8Array; format: "der"; type: T };

interface KeyHandle {
  export(options: { format: "der"; type: "pkcs8" | "spki" }): Uint8Array;
}

interface Digest {
  update(data: Uint8Array): Digest;
  digest(): Uint8Array;
}

interface Cipher {
  setAAD(ad: Uint8Array, options: { plaintextLength: number }): unknown;
  update(data: Uint8Array): Uint8Array;
  final(): Uint8Array;
  getAuthTag(): Uint8Array;
}

interface Decipher {
  setAAD(ad: Uint8Array, options: { plaintextLength: number }): unknown;
  setAuthTag(tag: Uint8Array): unknown;
  update(data: Uint8Array): Uint8Array;
  final(): Uint8Array;
}

/**
 * The part of Node's crypto module the link uses. node:crypto has it, and so does react-native-quick-crypto, so the
 * Mac and the phone share one port.
 */
export interface NodeStyleCrypto<Key extends KeyHandle> {
  generateKeyPairSync(type: "x25519"): { publicKey: Key; privateKey: Key };
  createPrivateKey(options: DerKey<"pkcs8">): Key;
  createPublicKey(input: DerKey<"spki"> | Key): Key;
  diffieHellman(options: { privateKey: Key; publicKey: Key }): Uint8Array;
  createCipheriv(algorithm: "aes-256-gcm", key: Uint8Array, iv: Uint8Array, options: { authTagLength: number }): Cipher;
  createDecipheriv(algorithm: "aes-256-gcm", key: Uint8Array, iv: Uint8Array, options: { authTagLength: number }): Decipher;
  createHash(algorithm: "sha256"): Digest;
  createHmac(algorithm: "sha256", key: Uint8Array): Digest;
  randomBytes(size: number): Uint8Array;
}

// DER wrappers for raw X25519 keys (RFC 8410).
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);
const SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]);

// A copy, so callers never hold a view into a pooled buffer.
const bytes = (view: Uint8Array) => Uint8Array.from(view);

/** The link's crypto port over a Node-style crypto module. */
export function createNodeStyleCrypto<Key extends KeyHandle>(crypto: NodeStyleCrypto<Key>): LinkCrypto {
  const privateKeyObject = (key: Uint8Array) => crypto.createPrivateKey({ key: concat(PKCS8_PREFIX, key), format: "der", type: "pkcs8" });
  const publicKeyObject = (key: Uint8Array) => crypto.createPublicKey({ key: concat(SPKI_PREFIX, key), format: "der", type: "spki" });
  const rawPublic = (key: KeyHandle) => bytes(key.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length));
  const rawPrivate = (key: KeyHandle) => bytes(key.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length));
  return {
    generateKeyPair(): KeyPair {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
      return { publicKey: rawPublic(publicKey), privateKey: rawPrivate(privateKey) };
    },
    keyPairFromPrivate(privateKey) {
      return { publicKey: rawPublic(crypto.createPublicKey(privateKeyObject(privateKey))), privateKey: Uint8Array.from(privateKey) };
    },
    dh(privateKey, publicKey) {
      return bytes(crypto.diffieHellman({ privateKey: privateKeyObject(privateKey), publicKey: publicKeyObject(publicKey) }));
    },
    seal(key, nonce, ad, plaintext) {
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(ad, { plaintextLength: plaintext.length });
      return concat(cipher.update(plaintext), cipher.final(), cipher.getAuthTag());
    },
    open(key, nonce, ad, ciphertext) {
      if (ciphertext.length < TAG_BYTES) return null;
      const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(ad, { plaintextLength: body.length });
      decipher.setAuthTag(ciphertext.subarray(body.length));
      try {
        return concat(decipher.update(body), decipher.final());
      } catch {
        return null;
      }
    },
    sha256: (data) => bytes(crypto.createHash("sha256").update(data).digest()),
    hmacSha256: (key, data) => bytes(crypto.createHmac("sha256", key).update(data).digest()),
    randomBytes: (length) => bytes(crypto.randomBytes(length)),
  };
}
