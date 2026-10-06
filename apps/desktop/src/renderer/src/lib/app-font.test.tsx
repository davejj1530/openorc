import { beforeEach, expect, it, vi } from "vitest";
import { parseFont, useAppFont } from "./app-font";

const root = document.documentElement;
// The store applies its font while the module loads, before any hook runs.
const initial = { font: useAppFont.getState().font, attribute: root.dataset.font };

beforeEach(() => localStorage.clear());

it("starts in Immaculate Gothic when nothing is saved", () => {
  expect(initial).toEqual({ font: "immaculate-gothic", attribute: "immaculate-gothic" });
});

it("saves and applies a choice", () => {
  expect(useAppFont.getState().setFont("inter")).toBe(true);
  expect(localStorage.getItem("openorc.font")).toBe("inter");
  expect(root.dataset.font).toBe("inter");
});

it("falls back to Immaculate Gothic for a missing or unknown value", () => {
  expect(parseFont(null)).toBe("immaculate-gothic");
  expect(parseFont("comic-sans")).toBe("immaculate-gothic");
  expect(parseFont("geist")).toBe("geist");
});

it("follows a choice saved in another window", () => {
  localStorage.setItem("openorc.font", "system");
  window.dispatchEvent(new StorageEvent("storage", { key: "openorc.font" }));
  expect(useAppFont.getState().font).toBe("system");
  expect(root.dataset.font).toBe("system");
});

it("keeps the choice for this session when storage is unavailable", () => {
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  expect(useAppFont.getState().setFont("geist")).toBe(false);
  expect(useAppFont.getState().font).toBe("geist");
  expect(root.dataset.font).toBe("geist");
  save.mockRestore();
});
