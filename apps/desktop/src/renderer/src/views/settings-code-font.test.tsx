import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCodeFont } from "../lib/code-font";
import { CodeFontSettings } from "./settings-code-font";

beforeEach(() => {
  localStorage.clear();
  useCodeFont.getState().setFont("jetbrains-mono");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("applies a selected code font beside a readable preview", () => {
  const report = vi.fn();
  render(<CodeFontSettings report={report} />);
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["JetBrains Mono", "Geist Mono", "System monospace"]);
  fireEvent.change(screen.getByRole("combobox", { name: "Code font" }), { target: { value: "geist-mono" } });
  expect(document.documentElement.dataset.codeFont).toBe("geist-mono");
  expect(localStorage.getItem("openorc.code-font")).toBe("geist-mono");
  expect(report).toHaveBeenLastCalledWith(true);
  expect(screen.getByLabelText("Code font preview").textContent).toContain("0O 1Il {} [] =>");
});

it("lets the user retry the current choice when saving fails", () => {
  const report = vi.fn();
  render(<CodeFontSettings report={report} />);
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Code font" }), { target: { value: "system" } });
  expect(document.documentElement.dataset.codeFont).toBe("system");
  expect(report).toHaveBeenLastCalledWith(false);
  save.mockRestore();
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  expect(localStorage.getItem("openorc.code-font")).toBe("system");
  expect(report).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
});
