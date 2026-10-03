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
  expect(screen.getByLabelText<HTMLInputElement>("Navigation hex value").value).toBe("#2768a5");
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
