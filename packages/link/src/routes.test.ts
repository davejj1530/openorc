import type { Route } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { nodeCrypto } from "./node.js";
import { LINK_PATH, linkPath, linkUrl } from "./routes.js";
import { nobleCrypto } from "./test-fixtures/noble-crypto.js";

// The tag is part of the wire: a phone and a cloud host built months apart must derive the same path from the same key.
const key = Uint8Array.from({ length: 32 }, (_, i) => i);
const KEY_TAG = "2SK-agpw6jVjs1843LXLjQ";

describe("where a phone dials", () => {
  it.each<[Route, string]>([
    [{ kind: "lan", host: "studio.local", port: 47820 }, "ws://studio.local:47820/link/1"],
    [{ kind: "lan", host: "192.168.1.20", port: 47820 }, "ws://192.168.1.20:47820/link/1"],
    [{ kind: "tailnet", host: "studio.tail1234.ts.net", port: 47820 }, "ws://studio.tail1234.ts.net:47820/link/1"],
    [{ kind: "tailnet", host: "fd7a:115c:a1e0::1", port: 47820 }, "ws://[fd7a:115c:a1e0::1]:47820/link/1"],
    [{ kind: "public", host: "sb-abc.vercel.run", port: 443 }, `wss://sb-abc.vercel.run/link/1/${KEY_TAG}`],
    [{ kind: "public", host: "brain.example.com", port: 8443 }, `wss://brain.example.com:8443/link/1/${KEY_TAG}`],
  ])("%j at %s", (route, url) => {
    expect(linkUrl(route, key, nodeCrypto)).toBe(url);
  });

  it("serves lan and tailnet on the path phones in the field speak, whatever the key", () => {
    expect(LINK_PATH).toBe("/link/1");
    expect(linkPath("lan", key, nodeCrypto)).toBe("/link/1");
    expect(linkPath("tailnet", nodeCrypto.generateKeyPair().publicKey, nodeCrypto)).toBe("/link/1");
  });

  it("tags the public path with the host's key, the same on the phone's crypto as on the host's", () => {
    expect(linkPath("public", key, nodeCrypto)).toBe(`/link/1/${KEY_TAG}`);
    expect(linkPath("public", key, nobleCrypto)).toBe(`/link/1/${KEY_TAG}`);
    const other = nodeCrypto.generateKeyPair().publicKey;
    expect(linkPath("public", other, nobleCrypto)).toBe(linkPath("public", other, nodeCrypto));
    expect(linkPath("public", other, nodeCrypto)).not.toBe(linkPath("public", key, nodeCrypto));
    const lastBitFlipped = Uint8Array.from(key, (byte, i) => (i === 31 ? byte ^ 1 : byte));
    expect(linkPath("public", lastBitFlipped, nodeCrypto)).not.toBe(`/link/1/${KEY_TAG}`);
  });
});
