// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flatStyle, nativeProps } from "../test-fixtures/react-native";
import { FIXED_HEIGHT, type Row } from "./rows";
import { TurnActions } from "./TurnActions";

vi.mock("expo-clipboard", () => ({ setStringAsync: () => Promise.resolve(true) }));
vi.mock("expo-haptics", () => ({ impactAsync: () => Promise.resolve(), ImpactFeedbackStyle: { Light: "light" } }));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const actions = (turn: string, text: string): Extract<Row, { kind: "actions" }> => ({ kind: "actions", key: `actions:${turn}`, gap: 10, text });
const copy = () => act(async () => fireEvent.click(screen.getByRole("button")));
const label = () => screen.getByRole("button").getAttribute("aria-label");

it("says Copied only on the reply it copied, in a view the list recycles for another reply and back", async () => {
  const a = actions("a", "Done.");
  const view = render(<TurnActions row={a} />);
  await copy();
  expect(label()).toBe("Message copied");

  // Within the two seconds, the reader scrolls and the list hands this view to another reply.
  view.rerender(<TurnActions row={actions("b", "Working.")} />);
  expect(label()).toBe("Copy message");
  act(() => void vi.advanceTimersByTime(60_000));
  view.rerender(<TurnActions row={a} />);
  expect(label()).toBe("Copy message");
});

it("gives Copied back after two seconds", async () => {
  render(<TurnActions row={actions("a", "Done.")} />);
  await copy();
  expect(label()).toBe("Message copied");
  act(() => void vi.advanceTimersByTime(2_000));
  expect(label()).toBe("Copy message");
});

it("is exactly as tall as the list places it without measuring", () => {
  const view = render(<TurnActions row={actions("a", "Done.")} />);
  expect(flatStyle(nativeProps.get(view.container.firstElementChild!)!.style).height).toBe(FIXED_HEIGHT.actions);
});
