// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flatStyle, nativeProps } from "../test-fixtures/react-native";
import { arrive } from "../ui/motion";
import { FIXED_HEIGHT, type Row } from "./rows";
import { TurnEnd } from "./TurnEnd";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type EndRow = Extract<Row, { kind: "end" }>;
const done = (turn: string, text: string | null, outcome = "success"): EndRow => ({
  kind: "end",
  key: `end:${turn}`,
  gap: 10,
  live: false,
  writing: false,
  startedAt: 1_000,
  durationMs: 41_000,
  outcome,
  text,
});
const running = (turn: string): EndRow => ({ ...done(turn, null), live: true, durationMs: undefined, outcome: undefined });
const actions = (turn: string, text: string) => done(turn, text);
const copy = () => act(async () => fireEvent.click(screen.getByRole("button")));
const label = () => screen.getByRole("button").getAttribute("aria-label");

it("says Copied only on the reply it copied, in a view the list recycles for another reply and back", async () => {
  const a = actions("a", "Done.");
  const view = render(<TurnEnd row={a} />);
  await copy();
  expect(label()).toBe("Message copied");

  // Within the two seconds, the reader scrolls and the list hands this view to another reply.
  view.rerender(<TurnEnd row={actions("b", "Working.")} />);
  expect(label()).toBe("Copy message");
  act(() => void vi.advanceTimersByTime(60_000));
  view.rerender(<TurnEnd row={a} />);
  expect(label()).toBe("Copy message");
});

it("gives Copied back after two seconds", async () => {
  render(<TurnEnd row={actions("a", "Done.")} />);
  await copy();
  expect(label()).toBe("Message copied");
  act(() => void vi.advanceTimersByTime(2_000));
  expect(label()).toBe("Copy message");
});

it("is exactly as tall as the list places it without measuring", () => {
  const view = render(<TurnEnd row={actions("a", "Done.")} />);
  expect(flatStyle(nativeProps.get(view.container.firstElementChild!)!.style).height).toBe(FIXED_HEIGHT.end);
});

/** Whether the end's words are rising in. */
const rising = () => Array.from(document.querySelectorAll("div")).some((element) => nativeProps.get(element)?.style === arrive);
const height = (view: ReturnType<typeof render>) => flatStyle(nativeProps.get(view.container.firstElementChild!)!.style).height;

it("says where a running turn stands at the same height it keeps once done, where the words swap in place for the time it took and Copy", () => {
  vi.setSystemTime(13_000);
  const view = render(<TurnEnd row={running("a")} />);
  expect(screen.getByText("Working 12s")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  expect(height(view)).toBe(FIXED_HEIGHT.end);
  view.rerender(<TurnEnd row={{ ...running("a"), writing: true }} />);
  expect(screen.getByText("Writing")).toBeTruthy();
  view.rerender(<TurnEnd row={done("a", "Done.")} />);
  expect(screen.getByText("Worked for 41s")).toBeTruthy();
  expect(label()).toBe("Copy message");
  expect(height(view)).toBe(FIXED_HEIGHT.end);
  expect(rising()).toBe(true);
});

it("swaps nothing in a view the list hands from a running turn to a finished one", () => {
  const view = render(<TurnEnd row={running("live")} />);
  view.rerender(<TurnEnd row={done("history", "Done.")} />);
  expect(rising()).toBe(false);
});

it("keeps saying a turn failed, in the bad tone, or stopped, with Copy for what it said", () => {
  const view = render(<TurnEnd row={done("a", null, "error")} />);
  expect(nativeProps.get(screen.getByText("Failed after 41s"))?.className).toContain("text-bad");
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(<TurnEnd row={done("b", "Half done.", "cancelled")} />);
  expect(nativeProps.get(screen.getByText("Stopped after 41s"))?.className).toContain("text-ink-4");
  expect(label()).toBe("Copy message");
});
