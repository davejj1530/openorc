import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppearanceSettings } from "./settings-appearance";

vi.mock("../lib/color", () => ({ toHex: (color: string) => color }));
afterEach(cleanup);

it("picks the interface font from a list and applies it", () => {
  render(<AppearanceSettings />);
  const font = screen.getByRole<HTMLSelectElement>("combobox", { name: "Font" });
  expect([...font.options].map((option) => option.textContent)).toEqual(["Immaculate Gothic", "Inter", "Inter Display", "Geist", "PP Neue Montreal", "System"]);
  expect(font.value).toBe("system");
  fireEvent.change(font, { target: { value: "inter-display" } });
  expect(document.documentElement.dataset.font).toBe("inter-display");
  expect(font.value).toBe("inter-display");
  expect(screen.getByRole("status").textContent).toBe("Appearance saved");
});

it("sets the text size, Default unless Small is picked", () => {
  render(<AppearanceSettings />);
  const size = screen.getByRole<HTMLSelectElement>("combobox", { name: "Text size" });
  expect([...size.options].map((option) => option.textContent)).toEqual(["Small", "Default"]);
  expect(size.value).toBe("default");
  expect(document.documentElement.dataset.textSize).toBe("default");
  fireEvent.change(size, { target: { value: "small" } });
  expect(document.documentElement.dataset.textSize).toBe("small");
  expect(localStorage.getItem("openorc.text-size")).toBe("small");
});
