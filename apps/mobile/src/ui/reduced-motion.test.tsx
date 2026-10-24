// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { flatStyle, nativeProps, reduceMotion } from "../test-fixtures/react-native";
import { LinkDot } from "./LinkDot";

afterEach(() => {
  cleanup();
  act(() => reduceMotion.set(false));
});

const breathing = () => "animationName" in flatStyle(nativeProps.get(screen.getByTestId("link-dot"))?.style);

it("holds the Connecting dot still as soon as Reduce Motion turns on while the app runs, and breathes again once off", async () => {
  render(<LinkDot tone="busy" />);
  await act(async () => undefined);
  expect(breathing()).toBe(true);
  act(() => reduceMotion.set(true));
  expect(breathing()).toBe(false);
  act(() => reduceMotion.set(false));
  expect(breathing()).toBe(true);
});
