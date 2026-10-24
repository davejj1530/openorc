// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen as shown } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FakeLink } from "../test-fixtures/fake-link";
import { flatStyle, nativeProps, placed, screen } from "../test-fixtures/react-native";
import type { Draft, runStore } from "./test-fixtures/run-store";
import { ToolSheet } from "./ToolSheet";

/** The sheet's route, the run store its call comes from, the link, and the Mac's answers to reading an output. */
const sheet = vi.hoisted(() => ({ store: null as ReturnType<typeof runStore> | null, link: null as FakeLink | null, read: vi.fn() }));

vi.mock("expo-router", () => ({ useLocalSearchParams: () => ({ runId: "r", id: "seq" }), router: { push: () => undefined } }));
vi.mock("../client", async () => {
  const { runStore } = await import("./test-fixtures/run-store");
  const { fakeLink } = await import("../test-fixtures/fake-link");
  sheet.store = runStore();
  sheet.link = fakeLink();
  return { useRun: sheet.store.client.useRun, useLinkRead: sheet.link.useLinkRead, link: { connection: { call: sheet.read } }, assetUri: () => new Promise(() => undefined) };
});

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

/** A call that printed `output`, or one whose output the page left out. */
function call(output: { output: string } | { output: null; outputOmitted: true }): Draft[] {
  return [
    { type: "session.started", agent: "codex", externalSessionId: "s", model: "gpt", tools: [] },
    { type: "turn.started", turnId: "t1" },
    { type: "tool.started", toolCallId: "seq", name: "commandExecution", input: { command: "seq 2000" }, parentToolCallId: null },
    { type: "tool.completed", toolCallId: "seq", name: "commandExecution", isError: false, ...output },
  ];
}

/** The output's column as drawn: each block of lines as its text, or as the space it leaves while off screen. */
function column(): ({ lines: string[] } | { space: number })[] {
  const first = Array.from(document.querySelectorAll("span")).find((span) => span.textContent?.startsWith("line "));
  return Array.from(first!.parentElement!.children).map((part) =>
    part.tagName === "SPAN" ? { lines: part.textContent!.split("\n") } : { space: Number(flatStyle(nativeProps.get(part)!.style).height) },
  );
}
const drawnLines = () => column().flatMap((part) => ("lines" in part ? part.lines : []));

/** The reader scrolls the sheet to `y`. */
function scrollTo(y: number) {
  const scroller = Array.from(document.querySelectorAll("div")).find((element) => nativeProps.get(element)?.onScroll)!;
  const onScroll = nativeProps.get(scroller)!.onScroll as (event: unknown) => void;
  act(() => onScroll({ nativeEvent: { contentOffset: { y }, layoutMeasurement: { height: screen.height } } }));
}

beforeEach(() => {
  // The output's lines start 100 pt down the sheet, under the command.
  placed.y = () => 100;
});
afterEach(() => {
  cleanup();
  screen.fontScale = 1;
  sheet.store!.client.runs.reset();
});

it("draws only the lines near the screen once all of a long output shows, and follows the reader down", () => {
  sheet.store!.frame(...call({ output: numbered(2000) }));
  render(<ToolSheet />);
  expect(drawnLines()).toEqual(numbered(100).split("\n"));
  fireEvent.click(shown.getByText("Show all 2000 lines"));
  const parts = column();
  expect(parts).toHaveLength(40);
  expect(drawnLines()).toEqual(numbered(100).split("\n"));
  expect(parts.slice(2)).toEqual(Array.from({ length: 38 }, () => ({ space: 1000 })));

  scrollTo(20_000);
  expect(drawnLines()[0]).toBe("line 951");
  expect(drawnLines().at(-1)).toBe("line 1100");
});

it("draws at the reader's text size: each block holds fewer lines, and leaves the space they would take", () => {
  screen.fontScale = 3.571;
  sheet.store!.frame(...call({ output: numbered(2000) }));
  render(<ToolSheet />);
  fireEvent.click(shown.getByText("Show all 2000 lines"));
  const parts = column();
  expect(parts.slice(0, 2)).toEqual([{ lines: numbered(14).split("\n") }, { lines: numbered(28).split("\n").slice(14) }]);
  expect(parts[2]).toEqual({ space: 14 * 20 * 3.571 });
});

it("reads an output the page left out again once the link is back, loading meanwhile", async () => {
  const answers: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  sheet.read.mockImplementation(() => new Promise((resolve, reject) => answers.push({ resolve, reject })));
  sheet.store!.frame(...call({ output: null, outputOmitted: true }));
  render(<ToolSheet />);
  await act(async () => answers[0]!.reject(new Error("The connection to your Mac dropped before it answered.")));
  expect(shown.getByText("Could not load the output")).toBeTruthy();

  act(() => sheet.link!.to(null));
  expect(sheet.read).toHaveBeenCalledTimes(1);
  act(() => sheet.link!.to(2));
  expect(sheet.read).toHaveBeenCalledTimes(2);
  expect(shown.queryByText("Could not load the output")).toBeNull();
  await act(async () => answers[1]!.resolve({ output: numbered(3) }));
  expect(drawnLines()).toEqual(["line 1", "line 2", "line 3"]);
});

it("copies the whole output as written, not the lines one piece of it draws", async () => {
  const { copied } = await import("../test-fixtures/clipboard");
  const output = `${numbered(300)}\n${"x".repeat(900)}`;
  sheet.store!.frame(...call({ output }));
  render(<ToolSheet />);
  const copies = shown.getAllByRole("button", { name: "Copy" });
  await act(async () => fireEvent.click(copies.at(-1)!));
  expect(copied.at(-1)).toBe(output);
  expect(shown.getByRole("button", { name: "Copied" })).toBeTruthy();
});
