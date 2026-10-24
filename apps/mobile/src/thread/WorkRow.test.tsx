// @vitest-environment jsdom
import { workEntries } from "@openorc/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { keyboard, nativeProps } from "../test-fixtures/react-native";
import { createDisclosure, DisclosureContext } from "./disclosure";
import { emptyRowMemo, transcriptRows, type Row } from "./rows";
import { activity, finishedTurn, type Draft, type runStore } from "./test-fixtures/run-store";
import { WorkRow } from "./WorkRow";

const work = vi.hoisted(() => ({ store: null as ReturnType<typeof runStore> | null, pushed: [] as { href: unknown; keyboardUp: boolean }[] }));

vi.mock("expo-router", async () => {
  const { keyboard } = await import("../test-fixtures/react-native");
  return { router: { push: (href: unknown) => void work.pushed.push({ href, keyboardUp: keyboard.up }) } };
});
vi.mock("./Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("../client", async () => {
  const { runStore } = await import("./test-fixtures/run-store");
  work.store = runStore();
  return { client: work.store.client };
});

afterEach(() => {
  cleanup();
  work.store!.client.runs.reset();
  work.pushed.length = 0;
});

type WorkRowProps = Extract<Row, { kind: "work" }>;
const memo = emptyRowMemo();
/** The newest turn's work row, as the list has it after `drafts`. */
function workRow(...drafts: Draft[]): WorkRowProps {
  const run = work.store!.frame(...drafts);
  return transcriptRows(run.blocks, activity(run), "r", memo).findLast((row): row is WorkRowProps => row.kind === "work")!;
}

it("streams a live step's words as they arrive, while the list holds its row", () => {
  workRow(...finishedTurn);
  const row = workRow(
    { type: "turn.started", turnId: "t2" },
    { type: "message.completed", messageId: "ask-2", role: "user", text: "Build it" },
    { type: "thinking.delta", messageId: "why", text: "**Building the package**\n\nRunning" },
  );
  render(<WorkRow row={row} />);
  expect(screen.getByText("Running")).toBeTruthy();

  let next: WorkRowProps | undefined;
  act(() => void (next = workRow({ type: "thinking.delta", messageId: "why", text: " the build first." })));
  expect(next).toBe(row);
  expect(screen.getByText("Running the build first.")).toBeTruthy();
});

it("leaves a finished step alone while the live one changes", () => {
  workRow(...finishedTurn);
  const row = workRow(
    { type: "turn.started", turnId: "t2" },
    { type: "message.completed", messageId: "ask-2", role: "user", text: "Check the store" },
    { type: "thinking.delta", messageId: "read", text: "**Reading the store**\n\nLooking at it." },
    { type: "tool.started", toolCallId: "cat", name: "commandExecution", input: { command: "cat store.ts" }, parentToolCallId: null },
    { type: "tool.completed", toolCallId: "cat", name: "commandExecution", output: "ok", isError: false },
    { type: "thinking.delta", messageId: "list", text: "**Checking the list**\n\nIt" },
  );
  const [finished] = workEntries(row.work).flatMap((entry) => (entry.kind === "phase" ? [entry.phase.id] : []));
  // A step reads whether the reader opened it each time it draws.
  const disclosure = createDisclosure();
  const read = vi.spyOn(disclosure, "get");
  const view = render(
    <DisclosureContext.Provider value={disclosure}>
      <WorkRow row={row} />
    </DisclosureContext.Provider>,
  );
  expect(read).toHaveBeenCalledWith(`phase:${finished}`);

  read.mockClear();
  const next = workRow({ type: "thinking.delta", messageId: "list", text: " keeps rows.\n\n**Reading the rows**\n\nThey" });
  expect(next).not.toBe(row);
  view.rerender(
    <DisclosureContext.Provider value={disclosure}>
      <WorkRow row={next} />
    </DisclosureContext.Provider>,
  );
  expect(read).toHaveBeenCalled();
  expect(read).not.toHaveBeenCalledWith(`phase:${finished}`);
});

it("stays open when the turn ends once the reader has pressed inside the live work, and folds otherwise", () => {
  workRow(...finishedTurn);
  const live = workRow(
    { type: "turn.started", turnId: "t3" },
    { type: "message.completed", messageId: "ask-3", role: "user", text: "Run the tests" },
    { type: "thinking.delta", messageId: "plan", text: "**Running the tests**\n\nFirst the unit tests." },
    { type: "tool.started", toolCallId: "test", name: "commandExecution", input: { command: "pnpm test" }, parentToolCallId: null },
  );
  const disclosure = createDisclosure();
  const view = render(
    <DisclosureContext.Provider value={disclosure}>
      <WorkRow row={live} />
    </DisclosureContext.Provider>,
  );
  const chip = () => screen.queryByRole("button", { name: "pnpm test" });
  act(() => chip()!.click());
  const done = workRow(
    { type: "tool.completed", toolCallId: "test", name: "commandExecution", output: "ok", isError: false },
    { type: "message.completed", messageId: "reply-3", role: "assistant", text: "Green." },
    { type: "turn.completed", turnId: "t3", status: "success", durationMs: 2_000 },
  );
  view.rerender(
    <DisclosureContext.Provider value={disclosure}>
      <WorkRow row={done} />
    </DisclosureContext.Provider>,
  );
  const work = () => screen.getByRole("button", { name: /step/ }).getAttribute("aria-expanded");
  expect(work()).toBe("true");

  view.rerender(
    <DisclosureContext.Provider value={createDisclosure()}>
      <WorkRow row={done} />
    </DisclosureContext.Provider>,
  );
  expect(work()).toBe("false");
  expect(chip()).toBeNull();
});

it("puts the keyboard away before a call's sheet opens, as it would cover the sheet's lower part", () => {
  workRow(...finishedTurn);
  const row = workRow(
    { type: "turn.started", turnId: "t4" },
    { type: "message.completed", messageId: "ask-4", role: "user", text: "Lint it" },
    { type: "thinking.delta", messageId: "lint", text: "**Linting**\n\nRunning the linter." },
    { type: "tool.started", toolCallId: "lint", name: "commandExecution", input: { command: "pnpm lint" }, parentToolCallId: null },
  );
  render(<WorkRow row={row} />);
  keyboard.up = true;
  act(() => screen.getByRole("button", { name: "pnpm lint" }).click());
  expect(work.pushed).toEqual([{ href: { pathname: "/tool", params: { runId: "r", id: expect.any(String) } }, keyboardUp: false }]);
});

it("gives the work's receipt a 44 pt row of its own, the space around its line inside it, reaching into no other row", () => {
  const row = workRow(...finishedTurn);
  const view = render(<WorkRow row={row} />);
  const classes = () => String(nativeProps.get(screen.getByRole("button", { name: /step/ }))!.className).split(" ");
  expect(classes()).toEqual(expect.arrayContaining(["min-h-touch", "py-3.5"]));
  expect(classes().filter((name) => /^-m[tby]?-/.test(name))).toEqual([]);
  // What shows under the receipt keeps the space to the next row, which the list leaves to the work.
  act(() => screen.getByRole("button", { name: /step/ }).click());
  const below = view.container.firstElementChild!.lastElementChild!;
  expect(String(nativeProps.get(below)!.className).split(" ")).toContain("pb-3.5");
});
