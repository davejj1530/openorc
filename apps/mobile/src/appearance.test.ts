import { beforeEach, expect, it, vi } from "vitest";
import { themes } from "./test-fixtures/uniwind";
import { chooseAppearance, restoreAppearance, savedAppearance } from "./appearance";

const saved = vi.hoisted(() => new Map<string, string>());
vi.mock("./client", async () => {
  const { ScratchStore } = await import("./scratch-store");
  return { storage: new ScratchStore({ getString: (key) => saved.get(key), set: (key, value) => void saved.set(key, value), remove: (key) => void saved.delete(key) }) };
});
const { storage } = (await import("./client")) as unknown as { storage: import("./scratch-store").ScratchStore };

beforeEach(() => {
  saved.clear();
  themes.length = 0;
});

it("follows the system until a theme is chosen, and keeps the choice on the phone", () => {
  expect(savedAppearance()).toBe("system");
  chooseAppearance("dark");
  expect(themes).toEqual(["dark"]);
  expect(savedAppearance()).toBe("dark");
  chooseAppearance("system");
  expect(themes).toEqual(["dark", "system"]);
  expect(saved.has("appearance")).toBe(false);
});

it("applies the kept theme at launch, and leaves the system's alone", () => {
  restoreAppearance();
  expect(themes).toEqual([]);
  saved.set("appearance", "light");
  restoreAppearance();
  expect(themes).toEqual(["light"]);
});

it("puts back the kept appearance when the demo ends, the system's included", () => {
  storage.scratch(true);
  chooseAppearance("dark");
  expect(savedAppearance()).toBe("dark");
  storage.scratch(false);
  expect(savedAppearance()).toBe("system");
  expect(themes).toEqual(["dark", "system"]);
  expect(saved.size).toBe(0);
});
