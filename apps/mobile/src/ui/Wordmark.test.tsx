// @vitest-environment jsdom
import { cleanup, render, screen as view } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { flatStyle, nativeProps, screen } from "../test-fixtures/react-native";
import { Wordmark } from "./Wordmark";

afterEach(() => {
  cleanup();
  screen.fontScale = 1;
});

/** The cube's box and the most the name may grow, as drawn at the reader's text size. */
function drawn(fontScale: number) {
  screen.fontScale = fontScale;
  render(<Wordmark />);
  const heading = view.getByRole("header", { name: "OpenOrc" });
  const cube = flatStyle(nativeProps.get(heading.firstElementChild!)?.style);
  const name = nativeProps.get(view.getByText("OpenOrc"))!;
  const gap = flatStyle(nativeProps.get(heading)?.style).gap as number;
  cleanup();
  return { cube: cube.width as number, gap, grows: name.maxFontSizeMultiplier as number };
}

it("grows with the reader's text size as one unit, cube, gap and name together, up to 1.2 times", () => {
  expect(drawn(1)).toEqual({ cube: 26, gap: 10, grows: 1.2 });
  expect(drawn(1.1)).toMatchObject({ cube: 26 * 1.1, gap: 10 * 1.1 });
  // The largest accessibility size (AX5) stops at 1.2, where the name's own cap stops it.
  expect(drawn(3.12)).toMatchObject({ cube: 26 * 1.2, gap: 10 * 1.2, grows: 1.2 });
  expect(drawn(0.82)).toMatchObject({ cube: 26 * 0.82, gap: 10 * 0.82 });
});
