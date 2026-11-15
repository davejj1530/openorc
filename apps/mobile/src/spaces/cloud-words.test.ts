import type { Space } from "@openorc/protocol";
import { expect, it, vi } from "vitest";
import { cloudRow, spaceNotice } from "./cloud-words";
import type { PhoneSpaces } from "./use-spaces";

vi.mock("../client", () => ({}));
vi.mock("../connection/use-shares", () => ({}));
vi.mock("./space-choice", () => ({}));

const personal: Space = { id: "personal-me", kind: "personal" };
const birch: Space = { id: "org-birch", kind: "organization", name: "Birch Studio", logo: null, memberId: "member", role: "member", memberCount: 2 };
const ready = (facts: Partial<Extract<PhoneSpaces, { state: "ready" }>>): PhoneSpaces => ({ state: "ready", spaces: [personal, birch], current: birch, access: null, offline: false, ...facts });
const frozen = { state: "frozen", reason: "seat_removed", until: null, message: "Your seat was taken back. Open Account or ask an admin for a seat." } as const;

it("says in the phone's own words why an organization is closed to the person, and never the server's words about buying", () => {
  expect(spaceNotice(ready({ access: frozen }), "Studio", 0)).toBe("Pro is needed for Birch Studio.");
  expect(spaceNotice(ready({ access: { state: "grace", reason: "seat_removed", until: 1_000, message: "One day left." } }), "Studio", 999)).toBeNull();
  expect(spaceNotice(ready({ access: { state: "grace", reason: "seat_removed", until: 1_000, message: "One day left." } }), "Studio", 1_000)).toBe("Pro is needed for Birch Studio.");
  // Personal stays open to a frozen person.
  expect(spaceNotice(ready({ access: frozen, current: personal }), "Studio", 0)).toBeNull();
  expect(spaceNotice(ready({}), "Studio", 0)).toBeNull();
  expect(spaceNotice({ state: "signed-out" }, "Studio", 0)).toBeNull();
});

it("says when the Mac cannot reach OpenOrc Cloud, since what shows is then what it last heard", () => {
  expect(spaceNotice(ready({ offline: true }), "Studio", 0)).toBe("Studio can't reach OpenOrc Cloud. This is what it last heard.");
  expect(cloudRow(ready({ offline: true }), "Mara Okafor", "Studio")).toEqual({ label: "Mara Okafor", detail: "Via Studio, which can't reach OpenOrc Cloud now" });
});

it("names the person and the Mac the phone reads OpenOrc Cloud through, or says nobody is signed in there", () => {
  expect(cloudRow(ready({}), "Mara Okafor", "Studio")).toEqual({ label: "Mara Okafor", detail: "Via Studio" });
  expect(cloudRow(ready({}), null, "Studio")).toEqual({ label: "Signed in", detail: "Via Studio" });
  expect(cloudRow({ state: "signed-out" }, undefined, "Studio")).toEqual({ label: "Signed out on Studio", detail: null });
  expect(cloudRow({ state: "none" }, undefined, "Studio")).toBeNull();
});
