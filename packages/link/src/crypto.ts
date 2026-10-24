/** An X25519 key pair, both halves 32 raw bytes. */
export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * The primitives the session needs, injected so each end uses its fastest implementation: node:crypto on the Mac,
 * react-native-quick-crypto on the phone. Keys, nonces and tags are raw bytes.
 */
export interface LinkCrypto {
  generateKeyPair(): KeyPair;
  /** The pair a private key belongs to, for a key read back from storage. */
  keyPairFromPrivate(privateKey: Uint8Array): KeyPair;
  dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /** AES-256-GCM with a 12-byte nonce; returns the ciphertext followed by the 16-byte tag. */
  seal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** The plaintext, or null when the ciphertext does not authenticate. */
  open(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array | null;
  sha256(data: Uint8Array): Uint8Array;
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  randomBytes(length: number): Uint8Array;
}

export const KEY_BYTES = 32;
export const TAG_BYTES = 16;
