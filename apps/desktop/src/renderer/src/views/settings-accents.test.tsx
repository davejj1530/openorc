import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccentSettings } from "./settings-accents";
import { useTheme } from "../lib/theme";

vi.mock("../lib/window-appearance", () => ({ syncWindowAppearance: vi.fn() }));
vi.mock("../lib/color", () => ({ toHex: (color: string) => color }));

beforeEach(() => {
  localStorage.clear();
  useTheme.setState({ custom: {} });
  useTheme.getState().setPreset("openorc");
  useTheme.getState().set("light");
});
afterEach(cleanup);

it("applies a combination, saves a custom role, and restores it when returning from dark mode", async () => {
  render(<AccentSettings report={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Ocean" }));
  fireEvent.change(screen.getByLabelText("Navigation hex value"), { target: { value: "#abcdef" } });
  fireEvent.keyDown(screen.getByLabelText("Navigation hex value"), { key: "Enter" });
  expect(screen.getByLabelText<HTMLInputElement>("Actions hex value").value).toBe("#2768a5");
  expect(screen.getByLabelText<HTMLInputElement>("Content hex value").value).toBe("#535caa");
  expect(JSON.parse(localStorage.getItem("openorc.colors")!).openorc.light["--navigation-accent"]).toBe("#abcdef");
  await act(() => useTheme.getState().set("dark"));
  expect(screen.getByLabelText<HTMLInputElement>("Navigation hex value").value).not.toBe("#abcdef");
  await act(() => useTheme.getState().set("light"));
  expect(screen.getByLabelText<HTMLInputElement>("Navigation hex value").value).toBe("#abcdef");
  fireEvent.click(screen.getByRole("button", { name: "Reset Navigation to the palette" }));
  expect(screen.getByLabelText<HTMLInputElement>("Navigation hex value").value).toBe("#333333");
});

it("syncs another window's saved choices and reports a failed save without discarding the preview", async () => {
  const report = vi.fn();
  render(<AccentSettings report={report} />);
  localStorage.setItem("openorc.colors", JSON.stringify({ openorc: { light: { "--content-accent": "#123456" } } }));
  await act(() => window.dispatchEvent(new StorageEvent("storage", { key: "openorc.colors" })));
  expect(screen.getByLabelText<HTMLInputElement>("Content hex value").value).toBe("#123456");
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  fireEvent.click(screen.getByRole("button", { name: "Rose & sage" }));
  expect(report).toHaveBeenLastCalledWith(false);
  expect(screen.getByLabelText<HTMLInputElement>("Navigation hex value").value).toBe("#497463");
  save.mockRestore();
});

it.each([
  ["openorc", "light", ["#171717", "#333333", "#333333"]],
  ["openorc", "dark", ["#e3e3e3", "#e5e5e5", "#e5e5e5"]],
  ["conductor", "light", ["#413030", "#413030", "#413030"]],
  ["conductor", "dark", ["#f3f2f1", "#eae8e6", "#eae8e6"]],
  ["claude", "light", ["#b95b3b", "#383835", "#184f95"]],
  ["claude", "dark", ["#d97757", "#f9f9f7", "#9ec5f4"]],
  ["github", "light", ["#1f883d", "#1f2328", "#0969da"]],
  ["github", "dark", ["#238636", "#f0f6fc", "#4493f8"]],
  ["eliron", "light", ["#191c20", "#ffc9ff", "#415ba0"]],
  ["eliron", "dark", ["#f5f7f8", "#ffc9ff", "#cbefff"]],
] as const)("restores %s's native accents in %s without removing surface edits", async (preset, mode, defaults) => {
  render(<AccentSettings report={vi.fn()} />);
  await act(() => {
    useTheme.getState().setPreset(preset);
    useTheme.getState().set(mode);
  });
  const fields = ["Actions", "Navigation", "Content"].map((label) => screen.getByLabelText<HTMLInputElement>(`${label} hex value`));
  expect(fields.map((field) => field.value)).toEqual(defaults);
  const button = screen.getByRole("button", { name: "Palette default" });
  const swatches = button.querySelectorAll<HTMLElement>("i");
  expect([...swatches].map((swatch) => swatch.style.background)).toEqual(
    defaults.map((color) => {
      const swatch = document.createElement("i");
      swatch.style.background = color;
      return swatch.style.background;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Ocean" }));
  const surface = mode === "light" ? "#fafafa" : "#171717";
  await act(() => useTheme.getState().setColor("--surface", surface));
  fireEvent.click(button);
  expect(fields.map((field) => field.value)).toEqual(defaults);
  expect(document.documentElement.style.getPropertyValue("--navigation-accent")).toBe(defaults[1]);
  expect(document.documentElement.style.getPropertyValue("--content-accent")).toBe(defaults[2]);
  expect(useTheme.getState().custom[preset]?.[mode]).toEqual({ "--surface": surface });
});
