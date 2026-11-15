import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useSettingsSections } from "./settings-sections";

const account = vi.hoisted(() => ({ status: undefined as unknown }));
vi.mock("./client", () => ({ useRpc: () => ({ data: account.status }) }));

beforeEach(() => {
  account.status = undefined;
});

const read = (section?: "cloud" | "account") => {
  const { sections, current } = renderHook(() => useSettingsSections({ view: "settings", ...(section ? { section } : {}) })).result.current;
  return { listed: sections.map(({ id }) => id), current: current.id };
};

it("lists Cloud for a Pro person only, and Account only where there is an account server", () => {
  account.status = { state: "signed-in", plan: { pro: true } };
  expect(read().listed).toEqual(expect.arrayContaining(["account", "cloud"]));
  account.status = { state: "signed-in", plan: { pro: false } };
  expect(read().listed).toContain("account");
  expect(read().listed).not.toContain("cloud");
  account.status = { state: "signed-out" };
  expect(read().listed).not.toContain("cloud");
  account.status = { state: "unavailable" };
  expect(read().listed).not.toContain("account");
  expect(read().listed).not.toContain("cloud");
});

it("opens Account from a route to Cloud for a person without Pro, and Usage where there is no account server", () => {
  account.status = { state: "signed-in", plan: { pro: true } };
  expect(read("cloud").current).toBe("cloud");
  account.status = { state: "signed-in", plan: { pro: false } };
  expect(read("cloud").current).toBe("account");
  account.status = { state: "signed-out" };
  expect(read("cloud").current).toBe("account");
  account.status = { state: "unavailable" };
  expect(read("cloud").current).toBe("usage");
  expect(read().current).toBe("usage");
});

it("keeps a route to Cloud until the account is known, so a Pro person's page never opens elsewhere first", () => {
  expect(read("cloud").current).toBe("cloud");
  expect(read().listed).not.toContain("cloud");
});
