import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ResizeHandle } from "./ResizeHandle";
import { useLayout } from "../lib/layout";

afterEach(cleanup);

it("explains resizing to screen readers without a visible tooltip", () => {
  render(<ResizeHandle edge="sidebar" />);
  const handle = screen.getByRole("separator", { name: "Resize sidebar" });
  expect(handle.getAttribute("aria-description")).toBe("Drag or use arrow keys to resize. Double-click or press Enter to reset.");
  expect(handle.hasAttribute("title")).toBe(false);
});

it.each([
  { side: "right" as const, width: 632 },
  { side: "left" as const, width: 648 },
])("moves the panel's grip right to resize a panel docked on the $side", ({ side, width }) => {
  useLayout.setState({ panelSide: side, panelWidth: 640 });
  render(<ResizeHandle edge="panel" />);
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize panel" }), { key: "ArrowRight" });
  expect(useLayout.getState().panelWidth).toBe(width);
});
