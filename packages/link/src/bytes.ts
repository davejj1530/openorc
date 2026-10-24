const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
/** Throws on bytes that are not UTF-8. */
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Compares in time that depends only on the lengths. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const INDEX = new Map([...ALPHABET].map((char, i) => [char, i]));

/** Unpadded base64url, written out so the phone needs no Node API for it. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += ALPHABET[(chunk >> (18 - c * 6)) & 63];
  }
  return out;
}

/** Throws on anything but canonical unpadded base64url. */
export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error("not base64url");
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of text) {
    const digit = INDEX.get(char);
    if (digit === undefined) throw new Error("not base64url");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 255;
    }
  }
  if (value & ((1 << bits) - 1)) throw new Error("not base64url");
  return out;
}
