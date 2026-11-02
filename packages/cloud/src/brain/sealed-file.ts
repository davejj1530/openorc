import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { BrainKey } from "./wire.js";

/**
 * Secrets sealed under the brain key, as bytes: `OOB1 | nonce(12) | AES-256-GCM(plaintext) | tag(16)`. Each channel
 * has its own key (HKDF-SHA256 of the brain key, the channel as info) and is the AAD, so a sealed value opens only
 * under the channel it was sealed for. The brain's secret store writes these to files; the waker seals handovers.
 */
const MAGIC = Buffer.from("OOB1", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SALT = "openorc-brain secrets/1";
const CHECK_LABEL = "openorc-brain key check/1";

/** Sealed bytes that do not open under this key and channel: another key, another channel, or changed bytes. */
export class SealedUnreadable extends Error {
  constructor(readonly channel: string) {
    super(`The sealed ${channel} secret does not open with this brain key.`);
  }
}

function channelKey(key: BrainKey, channel: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, SALT, channel, 32));
}

export function sealSecret(key: BrainKey, channel: string, plaintext: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", channelKey(key, channel), nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(channel, "utf8"));
  return Buffer.concat([MAGIC, nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function openSecret(key: BrainKey, channel: string, sealed: Uint8Array): Buffer {
  const bytes = Buffer.from(sealed);
  const head = MAGIC.length + NONCE_BYTES;
  if (bytes.length < head + TAG_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new SealedUnreadable(channel);
  const decipher = createDecipheriv("aes-256-gcm", channelKey(key, channel), bytes.subarray(MAGIC.length, head), { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(channel, "utf8"));
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(head, bytes.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new SealedUnreadable(channel);
  }
}

/** What a brain keeps beside its sealed files to tell a wrong key before it opens any of them. */
export function brainKeyCheck(key: BrainKey): Buffer {
  return createHmac("sha256", key).update(CHECK_LABEL).digest();
}

export function keyCheckMatches(key: BrainKey, check: Uint8Array): boolean {
  const expected = brainKeyCheck(key);
  return check.length === expected.length && timingSafeEqual(expected, check);
}
