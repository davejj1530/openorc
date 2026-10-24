import { beforeEach, expect, it, vi } from "vitest";
import { themes } from "./test-fixtures/uniwind";
import { chooseAppearance, restoreAppearance, savedAppearance } from "./appearance";

const saved = vi.hoisted(() => new Map<string, string>());
vi.mock("./client", () => ({
  storage: { getString: (key: string) => saved.get(key), set: (key: string, value: string) => void saved.set(key, value), remove: (key: string) => void saved.delete(key) },
}));

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
