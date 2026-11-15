import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Block } from "@openorc/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { core } from "../../lib/rpc";
import { queryClient } from "../../lib/client";
import { onlineReference, onlineTask } from "../../lib/test-fixtures/online-task";
import { taskAccess } from "../../lib/test-fixtures/task-access";
import { organizationContentGate } from "../../lib/organization-content-gate";
import { TaskToolCard } from "./TaskToolCard";

const observed = vi.hoisted(() => ({ local: [] as string[], fail: false }));
vi.mock("../../lib/rpc", () => ({ core: { call: vi.fn(), onPush: () => () => {}, onReady: vi.fn() } }));
vi.mock("../../lib/space-navigation", () => ({ useSpaceNavigation: () => null, spaceNavigation: { getState: () => ({ inventory: [] }) } }));
vi.mock("../../lib/hosted-file-scope", () => ({ useHostedFileScope: () => null }));
vi.mock("../TaskCard", () => ({
  TaskCard: ({ taskId }: { taskId: string }) => {
    observed.local.push(taskId);
    return <div>Mac task</div>;
  },
  taskActivityIcon: ({ working }: { working: boolean }) => <span data-testid="activity" data-working={working} />,
  taskCardClass: () => "surface-card",
}));
vi.mock("../ThreadImages", () => ({ ThreadRichText: ({ children }: { children: string }) => <div>{children}</div> }));
const id = onlineReference.id;
let task = onlineTask();
const tool = (taskRef?: unknown): Extract<Block, { kind: "tool" }> => ({
  id: "tool-call",
  kind: "tool",
  name: "task_create",
  input: {},
  done: true,
  output: JSON.stringify({ id, ...(taskRef !== undefined && { taskRef }) }),
});
const ref = { place: "server", spaceId: onlineReference.spaceId, projectId: onlineReference.projectId, id };
const show = (block = tool(ref)) =>
  render(
    <QueryClientProvider client={queryClient}>
      <TaskToolCard block={block} taskId={id} />
    </QueryClientProvider>,
  );

beforeEach(async () => {
  observed.local.length = 0;
  observed.fail = false;
  task = onlineTask({
    viewer: { ...onlineTask().viewer, unseenAssignment: true },
    assignmentRevision: 3,
    activity: { runId: "run-one", state: "working", latestMessage: "Checking the saved column order. ".repeat(9), lastAction: "Running the export checks", waitingFor: null, updatedAt: 1 },
  });
  vi.mocked(core.call).mockImplementation(async (method) => {
    if (method === "spaces.status" || method === "spaces.refresh") return taskAccess();
    if (method === "tasks.online.state") return { state: "ready", accountId: onlineReference.accountId, spaceId: ref.spaceId, execution: true, personal: false };
    if (method === "tasks.online.get") {
      if (observed.fail) throw new Error("Not found");
      return { accessRevision: 1, task };
    }
    if (method === "tasks.online.seen") return { accessRevision: 1, task };
    throw new Error(`Unexpected task-card RPC: ${method}`);
  });
  await organizationContentGate.refresh();
});
afterEach(() => {
  cleanup();
  organizationContentGate.reset();
  queryClient.clear();
  vi.clearAllMocks();
});

it("keeps the ordinary Mac card unchanged when a tool has no server reference", () => {
  show(tool());
  expect(screen.getByText("Mac task")).toBeTruthy();
  expect(observed.local).toEqual([id]);
});
it("does not fall through to the Mac when a server task read is refused", async () => {
  observed.fail = true;
  show();
  await screen.findByText("This task isn’t available here.");
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("tasks.online.get", { spaceId: ref.spaceId, id }));
  expect(observed.local).toEqual([]);
});
it("reads an organization task while opening its thread is still off, never asking the Mac", async () => {
  const answer = vi.mocked(core.call).getMockImplementation()!;
  vi.mocked(core.call).mockImplementation(async (method, params) =>
    method === "tasks.online.state" ? { state: "ready", accountId: onlineReference.accountId, spaceId: ref.spaceId, execution: false, personal: false } : answer(method, params),
  );
  show();
  await screen.findByText(task.title);
  expect(observed.local).toEqual([]);
});
it("says a task in a space whose tasks are not delivered isn't available here, and reads nothing more", async () => {
  const answer = vi.mocked(core.call).getMockImplementation()!;
  vi.mocked(core.call).mockImplementation(async (method, params) => (method === "tasks.online.state" ? { state: "unavailable" } : answer(method, params)));
  show();
  await screen.findByText("This task isn’t available here.");
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "tasks.online.get")).toBe(false);
  expect(observed.local).toEqual([]);
});
it("acknowledges its assignment only when the person expands the card", async () => {
  show();
  await screen.findByText(task.title);
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "tasks.online.seen")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Read full update" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("tasks.online.seen", expect.objectContaining({ id, assignmentRevision: 3 })));
  expect(observed.local).toEqual([]);
});
it("keeps Done independent from active work and shows the real waiting words after refresh", async () => {
  task = { ...task, status: "done" };
  show();
  await screen.findByText("Done");
  expect(screen.getByTestId("activity").getAttribute("data-working")).toBe("true");
  task = { ...task, activity: { ...task.activity!, state: "waiting", waitingFor: "Choose whether the archive includes hidden columns." } };
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["online-tasks"] });
  });
  await screen.findByText("Choose whether the archive includes hidden columns.");
  expect(screen.getByText("Waiting").classList.contains("text-warn")).toBe(false);
});
