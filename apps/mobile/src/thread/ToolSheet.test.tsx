// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen as shown } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FakeLink } from "../test-fixtures/fake-link";
import { flatStyle, nativeProps, placed, screen } from "../test-fixtures/react-native";
import type { Draft, runStore } from "./test-fixtures/run-store";
import { ToolSheet } from "./ToolSheet";

/** The sheet's route and where it was asked to go, the run store its calls come from, the link, and the Mac's answers to reading an output. */
const sheet = vi.hoisted(() => ({
  params: { runId: "r", id: "seq" } as { runId: string; id: string; calls?: string },
  replaced: [] as unknown[],
  store: null as ReturnType<typeof runStore> | null,
  link: null as FakeLink | null,
  read: vi.fn(),
}));

vi.mock("expo-router", () => ({ useLocalSearchParams: () => sheet.params, router: { push: () => undefined, replace: (href: unknown) => void sheet.replaced.push(href) } }));
vi.mock("./Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("../client", async () => {
  const { runStore } = await import("./test-fixtures/run-store");
  const { fakeLink } = await import("../test-fixtures/fake-link");
  sheet.store = runStore();
  sheet.link = fakeLink();
  return { useRun: sheet.store.client.useRun, useLinkRead: sheet.link.useLinkRead, call: sheet.read, assetUri: () => new Promise(() => undefined) };
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
  sheet.read.mockReset();
  sheet.params = { runId: "r", id: "seq" };
  sheet.replaced.length = 0;
});

/** The sheet opened from a line whose one call ran `name` with `input` and came back with `output`. */
function line(name: string, input: unknown, output: string, isError = false) {
  sheet.params = { runId: "r", id: "c", calls: "c" };
  sheet.store!.frame(
    { type: "session.started", agent: "claude", externalSessionId: "s", model: "m", tools: [] },
    { type: "turn.started", turnId: "t1" },
    { type: "tool.started", toolCallId: "c", name, input, parentToolCallId: null },
    { type: "tool.completed", toolCallId: "c", name, output, isError },
  );
  render(<ToolSheet />);
}

const failing = [
  " RUN  v4.1.11 /repo",
  " ✓ src/cart.test.ts (3 tests) 10ms",
  " ❯ src/auth.test.ts (2 tests | 1 failed) 60ms",
  " FAIL  src/auth.test.ts > auth > locks the account after five attempts",
  "AssertionError: expected 423, got 401",
  "",
  " ❯ src/auth.test.ts:58:31",
  " ❯ node_modules/vitest/dist/chunk.js:12:3",
  " ❯ node_modules/vitest/dist/runner.js:40:9",
  "⎯⎯⎯⎯[1/1]⎯",
  " Test Files  1 failed | 1 passed (2)",
  "      Tests  1 failed | 4 passed (5)",
  "   Duration  70ms (transform 10ms)",
].join("\n");

it("draws a test run as its files, a failed case with what went wrong and where, the whole output a press away", () => {
  line("Bash", { command: "npx vitest run", description: "Run the tests" }, failing, true);
  expect(shown.getByText("Run the tests")).toBeTruthy();
  expect(shown.getByText("auth.test.ts")).toBeTruthy();
  expect(shown.getByText("cart.test.ts")).toBeTruthy();
  expect(shown.getByText("locks the account after five attempts")).toBeTruthy();
  expect(shown.getByText("AssertionError: expected 423, got 401")).toBeTruthy();
  expect(shown.getByText("src/auth.test.ts:58")).toBeTruthy();
  // Code the project did not write is a count, not lines.
  expect(shown.getByText("2 library frames")).toBeTruthy();
  expect(document.body.textContent).not.toContain("chunk.js");
  fireEvent.click(shown.getByRole("button", { name: "Whole output" }));
  expect(document.body.textContent).toContain("chunk.js");
});

it("draws a command as a screen of its last lines, the earlier ones a press away", () => {
  line("Bash", { command: "seq 40" }, numbered(40));
  expect(shown.getByText("line 40")).toBeTruthy();
  expect(shown.queryByText("line 1")).toBeNull();
  fireEvent.click(shown.getByRole("button", { name: "28 earlier lines" }));
  expect(drawnLines()).toEqual(numbered(40).split("\n"));
});

it("draws an edit as the lines it took out and put in, the whole change a press away", () => {
  line("Edit", { file_path: "/repo/src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }, "The file has been updated");
  expect(shown.getByText("− const a = 1;")).toBeTruthy();
  expect(shown.getByText("+ const a = 2;")).toBeTruthy();
  expect(shown.getByRole("button", { name: "Whole change" })).toBeTruthy();
});

it("draws a list of threads as threads, each a way to its thread but the one already open", () => {
  const threads = [
    { id: "here", title: "Agent activity interface", activity: "running", branch: "cloud", current: true, lastReply: "Building the sheet.", lastActivityAt: Date.now() },
    { id: "other", title: "Worktree file previews", activity: "idle", branch: "cloud", current: false, lastReply: "**Done.** Replayed the command.", lastActivityAt: Date.now() - 240_000 },
  ];
  line("mcp__openorc_0123456789abcdef0123456789abcdef__thread_list", {}, JSON.stringify(threads));
  expect(shown.getByText("this thread")).toBeTruthy();
  // A reply reads as one plain line.
  expect(shown.getByText("Done. Replayed the command.")).toBeTruthy();
  expect(shown.queryByRole("button", { name: "Open thread Agent activity interface" })).toBeNull();
  fireEvent.click(shown.getByRole("button", { name: "Open thread Worktree file previews" }));
  expect(sheet.replaced).toEqual([{ pathname: "/thread/[id]", params: { id: "other" } }]);
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
