import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ResizeHandle } from "./ResizeHandle";

afterEach(cleanup);

it("explains resizing to screen readers without a visible tooltip", () => {
  render(<ResizeHandle edge="sidebar" />);
  const handle = screen.getByRole("separator", { name: "Resize sidebar" });
  expect(handle.getAttribute("aria-description")).toBe("Drag or use arrow keys to resize. Double-click or press Enter to reset.");
  expect(handle.hasAttribute("title")).toBe(false);
});
