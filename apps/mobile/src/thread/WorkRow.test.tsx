// @vitest-environment jsdom
import { workEntries } from "@openorc/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createDisclosure, DisclosureContext } from "./disclosure";
import { emptyRowMemo, transcriptRows, type Row } from "./rows";
import { activity, finishedTurn, type Draft, type runStore } from "./test-fixtures/run-store";
import { WorkRow } from "./WorkRow";

const work = vi.hoisted(() => ({ store: null as ReturnType<typeof runStore> | null }));

vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("./Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("../client", async () => {
  const { runStore } = await import("./test-fixtures/run-store");
  work.store = runStore();
  return { client: work.store.client };
});

afterEach(() => {
  cleanup();
  work.store!.client.runs.reset();
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
