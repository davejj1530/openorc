import { describe, expect, it } from "vitest";
import { linkReason, threadLinkReason } from "./link-reason";

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

describe("threadLinkReason", () => {
  it("needs no Mac for a cloud thread the phone reaches itself, and the Mac for every other thread", () => {
    const asleep = { kind: "waiting", mac, why: "silent", retryAt: null } as const;
    const cloud = { owner: { brain: "hosted" } };
    expect(threadLinkReason(asleep, cloud, true)).toBeNull();
    expect(threadLinkReason(asleep, cloud, false)).toBe("Not connected to Studio");
    expect(threadLinkReason(asleep, { owner: null }, true)).toBe("Not connected to Studio");
    expect(threadLinkReason(asleep, null, true)).toBe("Not connected to Studio");
  });
});
