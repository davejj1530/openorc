import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Block } from "../lib/transcript";
import { TranscriptContents, WorkTranscript } from "./Transcript";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onFrame: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
vi.mock("./AgentOrb", () => ({ AgentOrb: () => null }));
vi.mock("./TaskCard", () => ({ TaskCard: ({ taskId }: { taskId: string }) => <div>Task {taskId}</div> }));
afterEach(cleanup);

const taskId = "2ee7156d-b32d-465b-bb85-271ba9812402";
const created: Block = {
  id: "create",
  kind: "tool",
  name: "mcp__openorc__task_create",
  input: { title: "Harden team recovery", execution: "backlog" },
  output: { content: [{ type: "text", text: JSON.stringify({ id: taskId, status: "backlog" }) }] },
  done: true,
};
const started: Block = {
  ...created,
  id: "start",
  name: "mcp__openorc__task_start",
  input: { id: taskId },
  output: { content: [{ type: "text", text: JSON.stringify({ id: taskId, status: "in_progress" }) }] },
};

it.each([TranscriptContents, WorkTranscript])("shows one card when a task is created and started in the same turn (%#)", (Component) => {
  render(<Component runId="run" blocks={[created, started]} />);
  expect(screen.getAllByText(`Task ${taskId}`)).toHaveLength(1);
});

it.each([created, started])("shows a card for a standalone $name result", (block) => {
  render(<WorkTranscript runId="run" blocks={[block]} />);
  expect(screen.getAllByText(`Task ${taskId}`)).toHaveLength(1);
});

it("keeps the same card mounted as a start result arrives", () => {
  const { rerender } = render(<WorkTranscript runId="run" blocks={[created]} live />);
  const card = screen.getByText(`Task ${taskId}`);
  rerender(<WorkTranscript runId="run" blocks={[created, { ...started, done: false }]} live />);
  expect(screen.getAllByText(`Task ${taskId}`)).toEqual([card]);
  rerender(<WorkTranscript runId="run" blocks={[created, started]} live />);
  expect(screen.getAllByText(`Task ${taskId}`)).toEqual([card]);
});

it("keeps different task IDs with the same title visible", () => {
  const otherId = "a9b0c758-cba7-4984-bf06-3b26342ccb6d";
  const other: Block = { ...created, id: "other", output: JSON.stringify({ id: otherId }) };
  render(<WorkTranscript runId="run" blocks={[created, other, started]} />);
  expect(screen.getAllByText(`Task ${taskId}`)).toHaveLength(1);
  expect(screen.getByText(`Task ${otherId}`)).toBeTruthy();
});

it("keeps failed task actions available in the work history", () => {
  render(<WorkTranscript runId="run" blocks={[created, { ...started, isError: true, status: "error", output: "Could not start task" }]} live />);
  expect(screen.getAllByText(`Task ${taskId}`)).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Started task" }));
  fireEvent.click(screen.getByRole("button", { name: /Started task.*Failed/ }));
  expect(screen.getByText("Could not start task")).toBeTruthy();
});

it("coalesces cards even when tool grouping is disabled", () => {
  render(<TranscriptContents runId="run" blocks={[created, started]} groupTools={false} />);
  expect(screen.getAllByText(`Task ${taskId}`)).toHaveLength(1);
});

it("retains both tool results when task cards are disabled", () => {
  const { container } = render(<TranscriptContents runId="run" blocks={[created, started]} taskCards={false} groupTools={false} />);
  expect(screen.queryByText(`Task ${taskId}`)).toBeNull();
  expect(container.querySelectorAll(".transcript-block")).toHaveLength(2);
});

it("keeps a later turn's task reference visible", () => {
  const boundary: Block = { id: "end", kind: "status", boundary: "turn", text: "turn finished", tone: "ok" };
  const { container } = render(<WorkTranscript runId="run" blocks={[created, boundary, started]} />);
  const cards = screen.getAllByText(`Task ${taskId}`);
  expect(container.querySelectorAll(".work-turn")).toHaveLength(2);
  expect(cards).toHaveLength(2);
  expect(cards[0]!.closest(".work-turn")).not.toBe(cards[1]!.closest(".work-turn"));
});
