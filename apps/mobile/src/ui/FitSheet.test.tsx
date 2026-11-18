// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { flatStyle, nativeProps } from "../test-fixtures/react-native";
import { Text } from "./Text";
import { FitSheet, fitSheetHeight } from "./FitSheet";

vi.mock("./sheet-bottom", () => ({ useSheetBottom: () => 50 }));

afterEach(cleanup);

it("leaves a sheet as tall as what it holds while that fits under the status bar", () => {
  expect(fitSheetHeight(0, 956, 62)).toBeUndefined();
  expect(fitSheetHeight(420, 956, 62)).toBeUndefined();
  expect(fitSheetHeight(884, 956, 62)).toBeUndefined();
});

it("holds a sheet taller than the screen to the room under the status bar", () => {
  expect(fitSheetHeight(1459, 956, 62)).toBe(884);
  expect(fitSheetHeight(885, 956, 62)).toBe(884);
});

it("scrolls only what is taller than the screen, its end clear of the home indicator", () => {
  render(
    <FitSheet className="px-5" onAccessibilityEscape={() => undefined}>
      <Text>sma</Text>
    </FitSheet>,
  );
  const body = screen.getByText("sma").parentElement!;
  const props = () => nativeProps.get(body)!;
  const size = (height: number) => act(() => (props().onContentSizeChange as (width: number, height: number) => void)(390, height));
  size(600);
  expect(props().scrollEnabled).toBe(false);
  expect(flatStyle(props().style).height).toBeUndefined();
  size(1500);
  expect(props().scrollEnabled).toBe(true);
  expect(flatStyle(props().style).height).toBe(834);
  expect(flatStyle(props().contentContainerStyle).paddingBottom).toBe(50);
});
