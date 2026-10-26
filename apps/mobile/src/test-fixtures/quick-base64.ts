/** Base64 in tests, from the JS runtime's own encoder, where the phone uses its native one. */
export const fromByteArray = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
