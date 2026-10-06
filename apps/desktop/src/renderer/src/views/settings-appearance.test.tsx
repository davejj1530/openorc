import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppearanceSettings } from "./settings-appearance";

vi.mock("../lib/color", () => ({ toHex: (color: string) => color }));
afterEach(cleanup);

it("sets each font choice in its own face and applies the one picked", () => {
  render(<AppearanceSettings />);
  const choices = within(screen.getByRole("group", { name: "Font" })).getAllByRole("button");
  expect(choices.map((choice) => [choice.textContent, choice.dataset.font, choice.getAttribute("aria-pressed")])).toEqual([
    ["Immaculate Gothic", "immaculate-gothic", "true"],
    ["Inter", "inter", "false"],
    ["Geist", "geist", "false"],
    ["System", "system", "false"],
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Inter" }));
  expect(document.documentElement.dataset.font).toBe("inter");
  expect(screen.getByRole("button", { name: "Inter" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("status").textContent).toBe("Appearance saved");
});
