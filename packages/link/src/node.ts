import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { TAG_BYTES, type KeyPair, type LinkCrypto } from "./crypto.js";

// DER wrappers for raw X25519 keys (RFC 8410). Written against the Node API subset react-native-quick-crypto also
// implements, so the phone can hand this module quick-crypto in place of node:crypto.
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);
const SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]);

function withPrefix(prefix: Uint8Array, key: Uint8Array): Uint8Array {
  const der = new Uint8Array(prefix.length + key.length);
  der.set(prefix);
  der.set(key, prefix.length);
  return der;
}

const privateKeyObject = (key: Uint8Array) => createPrivateKey({ key: Buffer.from(withPrefix(PKCS8_PREFIX, key)), format: "der", type: "pkcs8" });
const publicKeyObject = (key: Uint8Array) => createPublicKey({ key: Buffer.from(withPrefix(SPKI_PREFIX, key)), format: "der", type: "spki" });
const rawPublic = (key: KeyObject) => new Uint8Array(key.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length));
const rawPrivate = (key: KeyObject) => new Uint8Array(key.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length));
const bytes = (buffer: Buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

export const nodeCrypto: LinkCrypto = {
  generateKeyPair(): KeyPair {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    return { publicKey: rawPublic(publicKey), privateKey: rawPrivate(privateKey) };
  },
  keyPairFromPrivate(privateKey) {
    return { publicKey: rawPublic(createPublicKey(privateKeyObject(privateKey))), privateKey: Uint8Array.from(privateKey) };
  },
  dh(privateKey, publicKey) {
    return bytes(diffieHellman({ privateKey: privateKeyObject(privateKey), publicKey: publicKeyObject(publicKey) }));
  },
  seal(key, nonce, ad, plaintext) {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(ad, { plaintextLength: plaintext.length });
    return bytes(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
  },
  open(key, nonce, ad, ciphertext) {
    if (ciphertext.length < TAG_BYTES) return null;
    const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(ad, { plaintextLength: body.length });
    decipher.setAuthTag(ciphertext.subarray(body.length));
    try {
      return bytes(Buffer.concat([decipher.update(body), decipher.final()]));
    } catch {
      return null;
    }
  },
  sha256: (data) => bytes(createHash("sha256").update(data).digest()),
  hmacSha256: (key, data) => bytes(createHmac("sha256", key).update(data).digest()),
  randomBytes: (length) => bytes(randomBytes(length)),
};
