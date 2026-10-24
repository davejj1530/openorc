import { concat, utf8 } from "./bytes.js";
import { KEY_BYTES, TAG_BYTES, type KeyPair, type LinkCrypto } from "./crypto.js";

/*
 * Noise_IK_25519_AESGCM_SHA256, per the Noise Protocol Framework (revision 34). The phone is the initiator: it
 * knows the Mac's static key from the pairing code.
 *
 *   <- s
 *   ...
 *   -> e, es, s, ss
 *   <- e, ee, se
 */

// AES-GCM rather than ChaChaPoly: Electron's BoringSSL has no chacha20-poly1305 cipher, and both ends have AES hardware.
const PROTOCOL_NAME = "Noise_IK_25519_AESGCM_SHA256";
const HASH_BYTES = 32;
const EMPTY = new Uint8Array(0);
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

export class NoiseError extends Error {}

/** 4 zero bytes, then the counter as 8 big-endian bytes (the AESGCM encoding). */
function nonceBytes(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, Math.floor(n / 2 ** 32));
  view.setUint32(8, n >>> 0);
  return nonce;
}

/** One direction of a session: its key and how many messages it has sealed or opened. */
export class CipherState {
  private n = 0;

  constructor(
    private readonly crypto: LinkCrypto,
    private readonly key: Uint8Array,
  ) {}

  seal(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.n >= MAX_NONCE) throw new NoiseError("nonce space exhausted");
    return this.crypto.seal(this.key, nonceBytes(this.n++), ad, plaintext);
  }

  /** The next message in order, or null when it does not authenticate (tampered, replayed or reordered). */
  open(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array | null {
    if (this.n >= MAX_NONCE) return null;
    const plaintext = this.crypto.open(this.key, nonceBytes(this.n), ad, ciphertext);
    if (plaintext) this.n++;
    return plaintext;
  }
}

/** HKDF with two outputs, as Noise defines it over HMAC-SHA256. */
function hkdf(crypto: LinkCrypto, chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = crypto.hmacSha256(chainingKey, input);
  const first = crypto.hmacSha256(temp, Uint8Array.of(1));
  return [first, crypto.hmacSha256(temp, concat(first, Uint8Array.of(2)))];
}

class SymmetricState {
  private ck: Uint8Array;
  h: Uint8Array;
  private cipher: CipherState | null = null;

  constructor(private readonly crypto: LinkCrypto) {
    // A name shorter than HASHLEN is padded with zeros.
    this.h = new Uint8Array(HASH_BYTES);
    this.h.set(utf8(PROTOCOL_NAME));
    this.ck = this.h;
  }

  mixHash(data: Uint8Array): void {
    this.h = this.crypto.sha256(concat(this.h, data));
  }

  mixKey(input: Uint8Array): void {
    const [ck, key] = hkdf(this.crypto, this.ck, input);
    this.ck = ck;
    this.cipher = new CipherState(this.crypto, key);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher ? this.cipher.seal(this.h, plaintext) : plaintext;
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher ? this.cipher.open(this.h, ciphertext) : ciphertext;
    if (!plaintext) throw new NoiseError("handshake message did not authenticate");
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.crypto, this.ck, EMPTY);
    return [new CipherState(this.crypto, first), new CipherState(this.crypto, second)];
  }
}

export interface NoiseTransport {
  send: CipherState;
  receive: CipherState;
  /** Identifies this session to both ends; never secret-bearing. */
  handshakeHash: Uint8Array;
}

interface HandshakeOptions {
  crypto: LinkCrypto;
  prologue: Uint8Array;
  /** This end's static key pair. */
  local: KeyPair;
  /** Fixed only by the test vectors; a fresh pair otherwise. */
  ephemeral?: KeyPair;
}

function start(crypto: LinkCrypto, prologue: Uint8Array, responderStatic: Uint8Array): SymmetricState {
  const state = new SymmetricState(crypto);
  state.mixHash(prologue);
  state.mixHash(responderStatic);
  return state;
}

/** The phone's side: message 1 now, and `finish` for the Mac's reply. Throws NoiseError on a reply that does not authenticate. */
export function initiate(options: HandshakeOptions & { remoteStatic: Uint8Array; payload: Uint8Array }): {
  message: Uint8Array;
  finish(reply: Uint8Array): { transport: NoiseTransport; payload: Uint8Array };
} {
  const { crypto, local, remoteStatic } = options;
  if (remoteStatic.length !== KEY_BYTES) throw new NoiseError("the Mac's key is not an X25519 key");
  const state = start(crypto, options.prologue, remoteStatic);
  const e = options.ephemeral ?? crypto.generateKeyPair();
  state.mixHash(e.publicKey);
  state.mixKey(crypto.dh(e.privateKey, remoteStatic));
  const sealedStatic = state.encryptAndHash(local.publicKey);
  state.mixKey(crypto.dh(local.privateKey, remoteStatic));
  const message = concat(e.publicKey, sealedStatic, state.encryptAndHash(options.payload));
  let finished = false;
  return {
    message,
    finish(reply) {
      if (finished) throw new NoiseError("handshake already finished");
      finished = true;
      if (reply.length < KEY_BYTES + TAG_BYTES) throw new NoiseError("handshake reply is too short");
      const re = reply.subarray(0, KEY_BYTES);
      state.mixHash(re);
      state.mixKey(crypto.dh(e.privateKey, re));
      state.mixKey(crypto.dh(local.privateKey, re));
      const payload = state.decryptAndHash(reply.subarray(KEY_BYTES));
      const [send, receive] = state.split();
      return { transport: { send, receive, handshakeHash: state.h }, payload };
    },
  };
}

/**
 * The Mac's side: reads message 1, which proves the phone holds the static key it names, and leaves the answer to
 * the caller. Throws NoiseError on a message that does not authenticate.
 */
export function respond(options: HandshakeOptions & { message: Uint8Array }): {
  remoteStatic: Uint8Array;
  payload: Uint8Array;
  reply(payload: Uint8Array): { message: Uint8Array; transport: NoiseTransport };
} {
  const { crypto, local, message } = options;
  if (message.length < KEY_BYTES + KEY_BYTES + TAG_BYTES + TAG_BYTES) throw new NoiseError("handshake message is too short");
  const state = start(crypto, options.prologue, local.publicKey);
  const re = message.subarray(0, KEY_BYTES);
  state.mixHash(re);
  state.mixKey(crypto.dh(local.privateKey, re));
  const remoteStatic = state.decryptAndHash(message.subarray(KEY_BYTES, KEY_BYTES * 2 + TAG_BYTES));
  state.mixKey(crypto.dh(local.privateKey, remoteStatic));
  const payload = state.decryptAndHash(message.subarray(KEY_BYTES * 2 + TAG_BYTES));
  let replied = false;
  return {
    remoteStatic,
    payload,
    reply(replyPayload) {
      if (replied) throw new NoiseError("handshake already answered");
      replied = true;
      const e = options.ephemeral ?? crypto.generateKeyPair();
      state.mixHash(e.publicKey);
      state.mixKey(crypto.dh(e.privateKey, re));
      state.mixKey(crypto.dh(e.privateKey, remoteStatic));
      const out = concat(e.publicKey, state.encryptAndHash(replyPayload));
      const [receive, send] = state.split();
      return { message: out, transport: { send, receive, handshakeHash: state.h } };
    },
  };
}
