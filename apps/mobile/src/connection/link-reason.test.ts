import { describe, expect, it } from "vitest";
import { linkReason } from "./link-reason";

const mac = { id: "studio", name: "Studio" };

describe("linkReason", () => {
  it("says nothing while connected, unpaired or on a first quick connect, and names the Mac otherwise", () => {
    expect(linkReason({ kind: "connected", mac, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 })).toBeNull();
    expect(linkReason({ kind: "unpaired", lost: null })).toBeNull();
    expect(linkReason({ kind: "connecting", mac, why: null })).toBeNull();
    expect(linkReason({ kind: "connecting", mac, why: "unreachable" })).toBe("Not connected to Studio");
    expect(linkReason({ kind: "waiting", mac, why: "disabled", retryAt: null })).toBe("Not connected to Studio");
  });
});
