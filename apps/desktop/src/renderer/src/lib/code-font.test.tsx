import { beforeEach, expect, it, vi } from "vitest";
import { useAppFont } from "./app-font";
import { parseCodeFont, useCodeFont } from "./code-font";

const root = document.documentElement;
const initial = { font: useCodeFont.getState().font, attribute: root.dataset.codeFont };

beforeEach(() => {
  localStorage.clear();
  useCodeFont.getState().setFont("jetbrains-mono");
});

it("starts in JetBrains Mono and falls back to it for unknown saved values", () => {
  expect(initial).toEqual({ font: "jetbrains-mono", attribute: "jetbrains-mono" });
  expect(parseCodeFont(null)).toBe("jetbrains-mono");
  expect(parseCodeFont("unknown-font")).toBe("jetbrains-mono");
});

it("persists the code face without changing the interface font", () => {
  useAppFont.getState().setFont("inter");
  expect(useCodeFont.getState().setFont("geist-mono")).toBe(true);
  expect(localStorage.getItem("openorc.code-font")).toBe("geist-mono");
  expect(root.dataset.codeFont).toBe("geist-mono");
  expect(root.dataset.font).toBe("inter");
  expect(localStorage.getItem("openorc.font")).toBe("inter");
});

it("follows another window's choice and resets when saved preferences are cleared", () => {
  localStorage.setItem("openorc.code-font", "system");
  window.dispatchEvent(new StorageEvent("storage", { key: "openorc.code-font" }));
  expect(useCodeFont.getState().font).toBe("system");
  expect(root.dataset.codeFont).toBe("system");
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(root.dataset.codeFont).toBe("jetbrains-mono");
});

it("keeps an unsaved choice for this session and ignores unrelated storage events", () => {
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  try {
    expect(useCodeFont.getState().setFont("geist-mono")).toBe(false);
    window.dispatchEvent(new StorageEvent("storage", { key: "openorc.font" }));
    expect(useCodeFont.getState().font).toBe("geist-mono");
    expect(root.dataset.codeFont).toBe("geist-mono");
  } finally {
    save.mockRestore();
  }
});
