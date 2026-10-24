import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url, utf8 } from "./bytes.js";
import { nodeCrypto } from "./node.js";
import { decodePairingUrl, encodePairingUrl, type PairingOffer } from "./pairing.js";

const offer: PairingOffer = {
  macName: "Studio Mac",
  macKey: nodeCrypto.generateKeyPair().publicKey,
  offerId: "offer-1",
  secret: nodeCrypto.randomBytes(32),
  routes: [
    { kind: "lan", host: "studio.local", port: 47820 },
    { kind: "tailnet", host: "studio.tailnet.ts.net", port: 47820 },
  ],
  expiresAt: 1_700_000_300_000,
};
const body = {
  name: offer.macName,
  key: toBase64Url(offer.macKey),
  offer: offer.offerId,
  secret: toBase64Url(offer.secret),
  routes: offer.routes,
  expires: offer.expiresAt,
};
const code = (value: unknown) => `openorc://pair#v1.${toBase64Url(utf8(JSON.stringify(value)))}`;

describe("base64url", () => {
  it("matches Node's encoding for every length and refuses non-canonical text", () => {
    for (let length = 0; length < 70; length++) {
      const bytes = nodeCrypto.randomBytes(length);
      const text = Buffer.from(bytes).toString("base64url");
      expect(toBase64Url(bytes)).toBe(text);
      expect(fromBase64Url(text)).toEqual(bytes);
    }
    expect(() => fromBase64Url("A")).toThrow();
    expect(() => fromBase64Url("AB")).toThrow();
    expect(() => fromBase64Url("AA==")).toThrow();
    expect(() => fromBase64Url("A+")).toThrow();
  });
});

describe("pairing codes", () => {
  it("round-trip an offer through the QR text", () => {
    const url = encodePairingUrl(offer);
    expect(url).toMatch(/^openorc:\/\/pair#v1\.[A-Za-z0-9_-]+$/);
    expect(decodePairingUrl(url)).toEqual(offer);
    expect(decodePairingUrl(code(body))).toEqual(offer);
  });

  it.each<[string, string]>([
    ["another scheme", "https://example.com/#v1.abc"],
    ["another version", code(body).replace("#v1.", "#v2.")],
    ["text that is not base64url", "openorc://pair#v1.not base64!"],
    ["base64url that is not JSON", `openorc://pair#v1.${toBase64Url(utf8("hello"))}`],
    ["an array", code([body])],
    ["a missing field", code({ ...body, expires: undefined })],
    ["an extra field", code({ ...body, token: "x" })],
    ["a short key", code({ ...body, key: toBase64Url(new Uint8Array(31)) })],
    ["a short secret", code({ ...body, secret: toBase64Url(new Uint8Array(16)) })],
    ["no routes", code({ ...body, routes: [] })],
    ["a route of another kind", code({ ...body, routes: [{ kind: "relay", host: "x", port: 1 }] })],
    ["a route without a port", code({ ...body, routes: [{ kind: "lan", host: "x", port: 0 }] })],
    ["a route with extra fields", code({ ...body, routes: [{ kind: "lan", host: "x", port: 1, path: "/" }] })],
    ["an expiry that is not a number", code({ ...body, expires: "soon" })],
  ])("refuse %s", (_case, text) => {
    expect(() => decodePairingUrl(text)).toThrow("not an OpenOrc pairing code");
  });
});
