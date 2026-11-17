import { beforeEach, expect, it, vi } from "vitest";
import { CLOUD_RELEASE, readWhatsNewSeen, writeWhatsNewSeen } from "./whats-new";

beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
});

it("remembers the version the steps were settled for", () => {
  expect(readWhatsNewSeen()).toBeNull();
  writeWhatsNewSeen(CLOUD_RELEASE);
  expect(readWhatsNewSeen()).toBe(CLOUD_RELEASE);
  localStorage.setItem("openorc.whatsNew", "{broken");
  expect(readWhatsNewSeen()).toBeNull();
});
