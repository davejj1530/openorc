import { pushGroups, type NotifyKind } from "@openorc/protocol";
import { concat, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./bytes.js";
import { anyText, shape, type Check } from "./checks.js";
import { TAG_BYTES, type KeyPair, type LinkCrypto } from "./crypto.js";

/*
 * An alert the Mac seals for one paired phone, from the two static link keys alone:
 *
 *   ss       = X25519(mac, phone)
 *   seal     = HKDF-SHA256(ss, salt "openorc push v1", info "seal" ‖ mac.public ‖ phone.public)
 *   collapse = HKDF-SHA256(ss, salt "openorc push v1", info "collapse" ‖ mac.public ‖ phone.public)
 *
 * The extension on the phone opens it with CryptoKit (apps/mobile/targets/notification-service/PushOpener.swift);
 * test-fixtures/push-vectors.json pins every byte for both.
 */

export const PUSH_VERSION = 1;
const LABEL = "openorc push v1";
const NONCE_BYTES = 12;
const COLLAPSE_BYTES = 16;

/** What the phone reads once the extension opens an alert. Clipped before sealing. */
export interface PushNotice {
  id: string;
  kind: NotifyKind | "test";
  /** Null only for the desktop's test notice. */
  threadId: string | null;
  title: string;
  body: string;
  /** Present when Allow and Deny can answer it. */
  approval?: { runId: string; approvalId: string };
}

/** `o` in the APNs JSON: the only part of an alert that carries content. Base64url without padding. */
export interface PushEnvelope {
  /** PUSH_VERSION when sealed here; an opener refuses any version it does not know. */
  v: number;
  /** The Mac's static public key: the phone's macId, so the extension knows which key to read. */
  m: string;
  /** 12 random bytes. */
  n: string;
  /** AES-256-GCM ciphertext followed by its 16-byte tag. */
  c: string;
}

/** RFC 5869 with one expand block, which is all a 32-byte key takes. */
function hkdf(crypto: LinkCrypto, secret: Uint8Array, info: Uint8Array): Uint8Array {
  const prk = crypto.hmacSha256(utf8(LABEL), secret);
  return crypto.hmacSha256(prk, concat(info, Uint8Array.of(1)));
}

/** Both ends derive the same keys from their static pairs alone. The phone only ever needs `seal`. */
export function pushKeys(crypto: LinkCrypto, own: KeyPair, peerPublic: Uint8Array, side: "mac" | "phone"): { seal: Uint8Array; collapse: Uint8Array } {
  const secret = crypto.dh(own.privateKey, peerPublic);
  if (secret.every((byte) => byte === 0)) throw new Error("The peer key gives an all-zero shared secret.");
  const [mac, phone] = side === "mac" ? [own.publicKey, peerPublic] : [peerPublic, own.publicKey];
  const derive = (purpose: string) => hkdf(crypto, secret, concat(utf8(purpose), mac, phone));
  return { seal: derive("seal"), collapse: derive("collapse") };
}

const associatedData = (macId: string) => utf8(`${LABEL}.${macId}`);

/** A surrogate pair, or half of one alone. */
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;
const wellFormed = (text: string) => text.replace(SURROGATES, (found) => (found.length === 2 ? found : "\uFFFD"));

/**
 * The notice as UTF-8 JSON that every reader takes. JSON.stringify writes half an emoji (a lone surrogate, as a cut
 * through one leaves) as an escape that Foundation's JSONDecoder refuses, so each one becomes U+FFFD first.
 */
const plaintextOf = (notice: PushNotice) => utf8(JSON.stringify(notice, (_key, value: unknown) => (typeof value === "string" ? wellFormed(value) : value)));

export function sealPush(crypto: LinkCrypto, seal: Uint8Array, macPublic: Uint8Array, notice: PushNotice, nonce = crypto.randomBytes(NONCE_BYTES)): PushEnvelope {
  const m = toBase64Url(macPublic);
  return { v: PUSH_VERSION, m, n: toBase64Url(nonce), c: toBase64Url(crypto.seal(seal, nonce, associatedData(m), plaintextOf(notice))) };
}

const kind: Check = (value) => value === "test" || (typeof value === "string" && Object.hasOwn(pushGroups, value));
const threadId: Check = (value) => value === null || typeof value === "string";
const notice = shape({ id: anyText, kind, threadId, title: anyText, body: anyText }, { approval: shape({ runId: anyText, approvalId: anyText }) });
const isNotice = (value: unknown): value is PushNotice => notice(value);

/** Null when anything fails to authenticate or parse, or the version is unknown. */
export function openPush(crypto: LinkCrypto, seal: Uint8Array, envelope: PushEnvelope): PushNotice | null {
  if (envelope.v !== PUSH_VERSION) return null;
  try {
    const nonce = fromBase64Url(envelope.n);
    const sealed = fromBase64Url(envelope.c);
    if (nonce.length !== NONCE_BYTES || sealed.length <= TAG_BYTES) return null;
    const plaintext = crypto.open(seal, nonce, associatedData(envelope.m), sealed);
    if (!plaintext) return null;
    const parsed: unknown = JSON.parse(fromUtf8(plaintext));
    return isNotice(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Opaque to Apple, the same for every alert from one thread to one phone. 22 characters. */
export function collapseId(crypto: LinkCrypto, collapse: Uint8Array, threadId: string | null): string {
  const subject = threadId === null ? "test" : `t:${threadId}`;
  return toBase64Url(crypto.hmacSha256(collapse, utf8(subject)).subarray(0, COLLAPSE_BYTES));
}
