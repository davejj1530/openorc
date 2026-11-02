import { describe, expect, it } from "vitest";
import { SealedUnreadable, brainKeyCheck, keyCheckMatches, openSecret, sealSecret } from "./sealed-file.js";
import { brainKeyFrom, newBrainKey, type BrainKey } from "./wire.js";

const counting = brainKeyFrom(Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64url"));
const flip = (bytes: Buffer, at: number) => {
  const copy = Buffer.from(bytes);
  copy[at] = copy[at]! ^ 1;
  return copy;
};

describe("sealed secrets", () => {
  it("opens what it sealed, under the same key and channel only", () => {
    const key = newBrainKey();
    const sealed = sealSecret(key, "remote", Buffer.from("phone keys"));
    expect(sealed.subarray(0, 4).toString("ascii")).toBe("OOB1");
    expect(sealed).toHaveLength(4 + 12 + "phone keys".length + 16);
    expect(sealed.includes(Buffer.from("phone keys"))).toBe(false);
    expect(openSecret(key, "remote", sealed).toString()).toBe("phone keys");
    expect(sealSecret(key, "remote", Buffer.from("phone keys")).equals(sealed)).toBe(false);
  });

  it("refuses another key, another channel, and any changed byte", () => {
    const key = newBrainKey();
    const sealed = sealSecret(key, "claude-cloud", Buffer.from("sk-ant-oat01-token"));
    const refusals: [BrainKey, string, Buffer][] = [
      [newBrainKey(), "claude-cloud", sealed],
      [key, "codex-cloud", sealed],
      [key, "claude-cloud", flip(sealed, 0)],
      [key, "claude-cloud", flip(sealed, 6)],
      [key, "claude-cloud", flip(sealed, 20)],
      [key, "claude-cloud", flip(sealed, sealed.length - 1)],
      [key, "claude-cloud", sealed.subarray(0, 20)],
    ];
    for (const [tryKey, channel, bytes] of refusals) {
      expect(() => openSecret(tryKey, channel, bytes)).toThrow(SealedUnreadable);
    }
  });

  it("still opens a value sealed by this version, so brains in the field keep their secrets", () => {
    const sealed = Buffer.from("T09CMYEMjUKa+AdkxxiziqLxwDNQ7u/FuxI/wncEUiAkGWnMaMYNPcWf", "base64");
    expect(openSecret(counting, "remote", sealed).toString()).toBe("phone keys");
  });

  it("tells the brain's own key from any other by its key check, which stays the same across versions", () => {
    const key = newBrainKey();
    const check = brainKeyCheck(key);
    expect(keyCheckMatches(key, check)).toBe(true);
    expect(keyCheckMatches(newBrainKey(), check)).toBe(false);
    expect(keyCheckMatches(key, check.subarray(1))).toBe(false);
    expect(brainKeyCheck(counting).toString("hex")).toBe("fc7307fe9ebb3fd7ea7cb9745dbe7f06129eeaa8998728b7d7f884a318950a45");
  });
});
