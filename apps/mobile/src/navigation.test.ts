import { expect, it } from "vitest";
import type { LinkState } from "./connection/manager";
import { leaveOnMacChange } from "./navigation";
import { redirectSystemPath } from "./app/+native-intent";

function link(first: LinkState) {
  let state = first;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener)),
    getState: () => state,
    to(next: LinkState) {
      state = next;
      listeners.forEach((listener) => listener());
    },
  };
}

const studio = { id: "studio", name: "Studio" };
const laptop = { id: "laptop", name: "Laptop" };

it("goes Home when the shown Mac changes or goes, not when its connection does", () => {
  const phone = link({ kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 });
  let home = 0;
  leaveOnMacChange(phone, () => home++);
  phone.to({ kind: "waiting", mac: studio, why: "unreachable", retryAt: null });
  phone.to({ kind: "connecting", mac: studio, why: null });
  expect(home).toBe(0);
  phone.to({ kind: "connecting", mac: laptop, why: null });
  expect(home).toBe(1);
  phone.to({ kind: "unpaired", lost: { why: "removed", macName: "Laptop" } });
  expect(home).toBe(2);
  phone.to({ kind: "connecting", mac: studio, why: null });
  expect(home).toBe(2);
});

it("lets only pairing links in from outside, and sends any other path Home", () => {
  expect(redirectSystemPath({ path: "openorc://pair#v1.abc", initial: true })).toBe("openorc://pair#v1.abc");
  expect(redirectSystemPath({ path: "/pair", initial: false })).toBe("/pair");
  expect(redirectSystemPath({ path: "openorc://tool?runId=r&id=1", initial: true })).toBe("/");
  expect(redirectSystemPath({ path: "/model", initial: false })).toBe("/");
  expect(redirectSystemPath({ path: "openorc://pairing", initial: false })).toBe("/");
});
