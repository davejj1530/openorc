import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it } from "vitest";
import { ThreadPaneDivider } from "./ThreadPaneDivider";

afterEach(cleanup);

it("explains resizing to screen readers without a visible tooltip", () => {
  render(<ThreadPaneDivider left="a" right="b" group={createRef<HTMLDivElement>()} weights={{ a: 1, b: 1 }} onResize={() => {}} />);
  const divider = screen.getByRole("separator");
  expect(divider.getAttribute("aria-description")).toBe("Drag or use arrow keys to resize. Double-click or press Enter to reset.");
  expect(divider.hasAttribute("title")).toBe(false);
});
